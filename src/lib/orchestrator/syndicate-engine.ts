/**
 * Calibro Syndicate Engine — the closed epistemic loop.
 *
 *   A. RECALL   mandate (calibro:mandates, recent) + per-specialist calibration
 *               (calibro:calibration, recent) + analogous markets (calibro:episodic, relevance)
 *   B. GATE     deterministic x402 Value-of-Information gate per specialist, with the
 *               SUI/USDC fee priced in USD via Tatum v4 rates (no static fallback)
 *               and the mandate's per-slate x402 budget enforced
 *   C. DECIDE   Platt log-odds de-biasing + inverse-Brier precision weighting, then the
 *               fractional Kelly gate across sportsbook / on-chain legs
 *   D. LEARN    settleMarketAndLearn(): recall the sealed thesis from Walrus, update
 *               Brier + Platt per specialist, write calibration checkpoints
 *               (rememberBulkAndWait) and the settled post-mortem (rememberAndWait)
 *
 * Every number here comes from src/lib/calibration/brier.ts. No LLM touches it.
 * How signals are bought (real HTTP 402 + Sui PTB in the app; an in-process stub in
 * unit tests) is injected via `SpecialistSignalProvider`, so this module never
 * fabricates a txDigest. Specialists without data for a market (`availableSignals`)
 * are not gated, bought or scored.
 */
import type { RememberBulkResult, RememberResult } from "@mysten-incubation/memwal";
import {
  aggregateCalibratedSignals,
  clampProb,
  computeBrierScore,
  computeFractionalKelly,
  createColdStartCalibration,
  shouldPayX402Gate,
  updateCalibrationOnline,
} from "../calibration/brier";
import { normalizeCoinType } from "../tatum/sui-rpc";
import {
  SpecialistIdSchema,
  type BankrollMandateRecord,
  type EpisodicPredictionRecord,
  type KellySizingDecision,
  type MarketDomain,
  type MarketOpportunity,
  type SpecialistCalibrationRecord,
  type SpecialistId,
  type SpecialistSignal,
  type X402GateDecision,
} from "../types/calibro";
import type { CalibroMemoryClient, CalibroMemoryMode } from "../walrus/memory-client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SPECIALIST_IDS: readonly SpecialistId[] = SpecialistIdSchema.options;

export const SPECIALIST_NAMES: Record<SpecialistId, string> = {
  "sharp-steam": "SharpSteam",
  "power-rating": "PowerRating",
  "onchain-flow": "OnchainFlow",
  "hype-contrarian": "HypeContrarian",
  "kalshi-crowd": "KalshiCrowd",
  "manifold-crowd": "ManifoldCrowd",
  "top-pickers": "TopPickers",
};

export const SUI_COIN_TYPE = "0x2::sui::SUI";
export const SUI_MAINNET_USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

/** 0.002 SUI — the spec's per-signal price. */
export const DEFAULT_X402_FEE: X402FeeQuote = {
  coinType: SUI_COIN_TYPE,
  amountRaw: "2000000",
};

/** Used only when `calibro:mandates` holds no record yet; surfaced as `DEFAULT_MANDATE`. */
export const DEFAULT_MANDATE: BankrollMandateRecord = {
  kind: "mandate_v1",
  bankrollUsd: 2_500,
  kellyMultiplier: 0.25,
  maxSingleStakePct: 0.05,
  minEdgeThreshold: 0.02,
  maxSlateX402BudgetSui: 0.05,
  preferredDomains: ["NBA", "EPL", "UFC", "CRYPTO_MACRO"],
  updatedAt: "1970-01-01T00:00:00.000Z",
};

const RATE_CACHE_TTL_MS = 60_000;
const FLOAT_EPS = 1e-12;

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

export interface X402FeeQuote {
  coinType: string;
  /** Integer base units (MIST for SUI, micro-units for USDC) */
  amountRaw: string;
}

export type RateSource = "TATUM_V4_RATES";

/** Satisfied by `TatumSuiClient`. */
export interface UsdRateProvider {
  getUsdExchangeRate(symbol: string): Promise<{ usdPrice: number; source: RateSource }>;
}

export interface PricedFee {
  coinType: string;
  symbol: "SUI" | "USDC";
  amountRaw: string;
  amountDecimal: number;
  feeUsd: number;
  /** Fee expressed in SUI (identity for SUI fees; via USD for USDC) — used for slate budget */
  feeSuiEquivalent: number;
  rateSource: RateSource;
}

export interface SignalAcquisitionRequest {
  specialistId: SpecialistId;
  market: MarketOpportunity;
  fee: PricedFee;
  gate: X402GateDecision;
}

export interface AcquiredSignal {
  signal: SpecialistSignal;
  payment: {
    /** UNPAID = computed in-process without an x402 payment (unit tests, cold-start counterfactual) */
    mode: "LIVE_MAINNET" | "UNPAID";
    /** Required for LIVE_MAINNET; must be absent for UNPAID */
    txDigest?: string;
    payer?: string;
  };
}

/**
 * Buys one specialist signal. Phase 2 implements this with the real HTTP 402 → Sui PTB →
 * paid-retry flow; tests implement it with a sandbox that never claims a Mainnet digest.
 */
export interface SpecialistSignalProvider {
  acquireSignal(request: SignalAcquisitionRequest): Promise<AcquiredSignal>;
}

export interface SyndicateEngineOptions {
  memory: CalibroMemoryClient;
  signals: SpecialistSignalProvider;
  rates: UsdRateProvider;
  /** Per-specialist price override; otherwise `defaultFee` */
  feeQuotes?: Partial<Record<SpecialistId, X402FeeQuote>>;
  defaultFee?: X402FeeQuote;
  defaultMandate?: BankrollMandateRecord;
  gate?: { minExplorationSamples?: number; maxAcceptableBrier?: number };
  clock?: () => Date;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type CalibrationSource = "WALRUS_RECALL" | "COLD_START";

export interface RecallContext {
  memoryMode: CalibroMemoryMode;
  domain: MarketDomain;
  mandate: BankrollMandateRecord;
  mandateSource: "WALRUS_RECALL" | "DEFAULT_MANDATE";
  calibrations: Record<SpecialistId, SpecialistCalibrationRecord>;
  calibrationSources: Record<SpecialistId, CalibrationSource>;
  analogousMarkets: Array<{
    blobId: string;
    distance: number;
    record: EpisodicPredictionRecord;
  }>;
}

export interface EngineGateDecision extends X402GateDecision {
  fee: PricedFee;
  calibrationSource: CalibrationSource;
  /** Why a veto happened — calibration evidence vs. mandate budget */
  vetoCause?: "CALIBRATION" | "SLATE_BUDGET";
}

export interface SlateBudget {
  readonly budgetSui: number;
  spentSui: number;
}

export type BetLeg = {
  side: "YES" | "NO";
  venue: "SPORTSBOOK" | "ONCHAIN";
  decision: KellySizingDecision;
};

export interface MarketEvaluation {
  market: MarketOpportunity;
  context: RecallContext;
  gates: EngineGateDecision[];
  acquired: Array<{ gate: EngineGateDecision; acquired: AcquiredSignal }>;
  acquisitionErrors: Array<{ specialistId: SpecialistId; error: string }>;
  consensus: ReturnType<typeof aggregateCalibratedSignals>;
  /** All priced legs, best first. Empty when no signal was acquired (nothing to size). */
  legs: BetLeg[];
  chosenLeg: BetLeg | null;
  thesis: EpisodicPredictionRecord;
  thesisWrite: RememberResult | null;
  slate: SlateBudget;
}

export interface SpecialistLearningUpdate {
  specialistId: SpecialistId;
  kind: "SAMPLE" | "VETO_TALLY" | "ALREADY_APPLIED";
  rawProbability?: number;
  singleBrier?: number;
  prevBrier: number;
  nextBrier: number;
  brierDelta: number;
  prevAlphaSlope: number;
  nextAlphaSlope: number;
  prevBetaIntercept: number;
  nextBetaIntercept: number;
  next: SpecialistCalibrationRecord;
}

export type SettlementResult =
  | {
      status: "SETTLED";
      thesisSource: "WALRUS_RECALL" | "LOCAL_FALLBACK";
      thesisBlobId?: string;
      settled: EpisodicPredictionRecord;
      updates: SpecialistLearningUpdate[];
      calibrationWrite: RememberBulkResult;
      episodicWrite: RememberResult;
    }
  | {
      status: "ALREADY_SETTLED";
      settled: EpisodicPredictionRecord;
      settledBlobId: string;
    };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function resolveCoinMeta(coinType: string): { symbol: "SUI" | "USDC"; decimals: number } {
  const norm = normalizeCoinType(coinType);
  if (norm === normalizeCoinType(SUI_COIN_TYPE)) return { symbol: "SUI", decimals: 9 };
  if (norm === normalizeCoinType(SUI_MAINNET_USDC_COIN_TYPE)) return { symbol: "USDC", decimals: 6 };
  throw new Error(`Unsupported x402 coin type "${coinType}" (expected SUI or Sui Mainnet USDC).`);
}

export function rawToDecimal(amountRaw: string, decimals: number): number {
  if (!/^\d+$/.test(amountRaw)) {
    throw new Error(`x402 amountRaw must be a non-negative integer string, got "${amountRaw}".`);
  }
  const raw = BigInt(amountRaw);
  const base = 10n ** BigInt(decimals);
  return Number(raw / base) + Number(raw % base) / Number(base);
}

function round(n: number, dp: number): number {
  return Number(n.toFixed(dp));
}

function assertValidMarket(market: MarketOpportunity): void {
  const probs = [market.onchainImpliedProb, ...(market.bookImpliedProb === null ? [] : [market.bookImpliedProb])];
  if (probs.some((p) => !Number.isFinite(p) || p <= 0 || p >= 1)) {
    throw new Error(`Market ${market.marketId}: implied probabilities must be in (0, 1).`);
  }
  if ((market.bookDecimalOdds === null) !== (market.bookImpliedProb === null)) {
    throw new Error(`Market ${market.marketId}: bookDecimalOdds and bookImpliedProb must both be set or both be null.`);
  }
  if (market.bookDecimalOdds !== null && (!Number.isFinite(market.bookDecimalOdds) || market.bookDecimalOdds <= 1)) {
    throw new Error(`Market ${market.marketId}: bookDecimalOdds must be > 1.`);
  }
}

/**
 * Sizes every leg we have a real price for and returns them all, best first.
 * Legs: YES @ sportsbook (bookDecimalOdds, when the market has one), YES @ on-chain
 * (1 / price), NO @ on-chain (1 / (1 - price)). The sportsbook NO price is not in
 * the feed, so it is not invented here.
 */
export function evaluateBetLegs(
  calibratedProb: number,
  market: MarketOpportunity,
  mandate: BankrollMandateRecord
): BetLeg[] {
  const p = clampProb(calibratedProb);
  const onchain = clampProb(market.onchainImpliedProb);
  const legs: BetLeg[] = [];
  if (market.bookDecimalOdds !== null) {
    legs.push({
      side: "YES",
      venue: "SPORTSBOOK",
      decision: computeFractionalKelly({ calibratedProb: p, decimalOdds: market.bookDecimalOdds, mandate }),
    });
  }
  legs.push(
    {
      side: "YES",
      venue: "ONCHAIN",
      decision: computeFractionalKelly({ calibratedProb: p, decimalOdds: 1 / onchain, mandate }),
    },
    {
      side: "NO",
      venue: "ONCHAIN",
      decision: computeFractionalKelly({ calibratedProb: 1 - p, decimalOdds: 1 / (1 - onchain), mandate }),
    }
  );
  return legs.sort((a, b) => {
    const takeA = a.decision.action === "TAKE_EDGE" ? 1 : 0;
    const takeB = b.decision.action === "TAKE_EDGE" ? 1 : 0;
    return (
      takeB - takeA ||
      b.decision.stakeUsd - a.decision.stakeUsd ||
      b.decision.netEdge - a.decision.netEdge
    );
  });
}

export function computeSettledPnlUsd(record: EpisodicPredictionRecord, outcome: 0 | 1): number {
  if (record.recommendedAction !== "TAKE_EDGE" || !record.betSide || !record.betDecimalOdds) {
    return 0;
  }
  const won = (record.betSide === "YES" && outcome === 1) || (record.betSide === "NO" && outcome === 0);
  const stake = record.recommendedStakeUsd;
  return round(won ? stake * (record.betDecimalOdds - 1) : -stake, 2);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class SyndicateEngine {
  private readonly memory: CalibroMemoryClient;
  private readonly signals: SpecialistSignalProvider;
  private readonly rates: UsdRateProvider;
  private readonly feeQuotes: Partial<Record<SpecialistId, X402FeeQuote>>;
  private readonly defaultFee: X402FeeQuote;
  private readonly defaultMandate: BankrollMandateRecord;
  private readonly gateOptions: { minExplorationSamples?: number; maxAcceptableBrier?: number };
  private readonly clock: () => Date;
  private readonly rateCache = new Map<string, { at: number; value: { usdPrice: number; source: RateSource } }>();

  constructor(options: SyndicateEngineOptions) {
    this.memory = options.memory;
    this.signals = options.signals;
    this.rates = options.rates;
    this.feeQuotes = options.feeQuotes ?? {};
    this.defaultFee = options.defaultFee ?? DEFAULT_X402_FEE;
    this.defaultMandate = options.defaultMandate ?? DEFAULT_MANDATE;
    this.gateOptions = options.gate ?? {};
    this.clock = options.clock ?? (() => new Date());
  }

  get memoryMode(): CalibroMemoryMode {
    return this.memory.mode;
  }

  /** Open a slate whose x402 spend is capped by the mandate's `maxSlateX402BudgetSui`. */
  createSlate(mandate: BankrollMandateRecord): SlateBudget {
    return { budgetSui: Math.max(0, mandate.maxSlateX402BudgetSui), spentSui: 0 };
  }

  // ---- Step A ------------------------------------------------------------

  async recallContext(market: MarketOpportunity): Promise<RecallContext> {
    const [mandateRecord, domainCal, analogs] = await Promise.all([
      this.memory.recallLatestMandate(),
      this.memory.recallDomainCalibrations(market.domain),
      this.memory.recallAnalogousMarkets(
        `[Calibro Episodic] Domain=${market.domain} Market="${market.title}" ${market.subtitle}`,
        { limit: 8, maxDistance: 0.75 }
      ),
    ]);

    const calibrations = {} as Record<SpecialistId, SpecialistCalibrationRecord>;
    const calibrationSources = {} as Record<SpecialistId, CalibrationSource>;
    for (const id of SPECIALIST_IDS) {
      const recalled = domainCal.bySpecialist[id];
      calibrations[id] = recalled ?? createColdStartCalibration(id, market.domain);
      calibrationSources[id] = recalled ? "WALRUS_RECALL" : "COLD_START";
    }

    // One entry per past market (prefer the settled post-mortem), excluding this market.
    const byMarket = new Map<string, RecallContext["analogousMarkets"][number]>();
    for (const hit of analogs.records) {
      if (hit.record.marketId === market.marketId) continue;
      const existing = byMarket.get(hit.record.marketId);
      if (!existing || (existing.record.outcome === undefined && hit.record.outcome !== undefined)) {
        byMarket.set(hit.record.marketId, hit);
      }
    }

    return {
      memoryMode: this.memory.mode,
      domain: market.domain,
      mandate: mandateRecord ?? this.defaultMandate,
      mandateSource: mandateRecord ? "WALRUS_RECALL" : "DEFAULT_MANDATE",
      calibrations,
      calibrationSources,
      analogousMarkets: [...byMarket.values()].sort((a, b) => a.distance - b.distance),
    };
  }

  // ---- Step B ------------------------------------------------------------

  async priceFees(): Promise<Record<SpecialistId, PricedFee>> {
    const sui = await this.getRate("SUI");
    const priced = {} as Record<SpecialistId, PricedFee>;
    for (const id of SPECIALIST_IDS) {
      const quote = this.feeQuotes[id] ?? this.defaultFee;
      const { symbol, decimals } = resolveCoinMeta(quote.coinType);
      const amountDecimal = rawToDecimal(quote.amountRaw, decimals);
      const rate = symbol === "SUI" ? sui : await this.getRate("USDC");
      const feeUsd = amountDecimal * rate.usdPrice;
      priced[id] = {
        coinType: quote.coinType,
        symbol,
        amountRaw: quote.amountRaw,
        amountDecimal,
        feeUsd: round(feeUsd, 8),
        feeSuiEquivalent: symbol === "SUI" ? amountDecimal : round(feeUsd / sui.usdPrice, 9),
        rateSource: rate.source,
      };
    }
    return priced;
  }

  /**
   * Runs the VoI gate for all 4 specialists. Best-calibrated specialists are evaluated
   * first so a tight slate budget is spent on the sharpest sources. Approved fees are
   * reserved against `slate` immediately. Output is in canonical specialist order.
   */
  evaluateGates(
    context: RecallContext,
    fees: Record<SpecialistId, PricedFee>,
    slate: SlateBudget,
    available: readonly SpecialistId[] = SPECIALIST_IDS
  ): EngineGateDecision[] {
    const priority = SPECIALIST_IDS.filter((id) => available.includes(id)).sort(
      (a, b) =>
        context.calibrations[a].brierScore - context.calibrations[b].brierScore ||
        SPECIALIST_IDS.indexOf(a) - SPECIALIST_IDS.indexOf(b)
    );

    const decisions = new Map<SpecialistId, EngineGateDecision>();
    for (const id of priority) {
      const fee = fees[id];
      const base = shouldPayX402Gate({
        calibration: context.calibrations[id],
        mandate: context.mandate,
        feeUsd: fee.feeUsd,
        ...this.gateOptions,
      });
      const decision: EngineGateDecision = {
        ...base,
        fee,
        calibrationSource: context.calibrationSources[id],
      };

      if (decision.decision === "VETO_PAYMENT") {
        decision.vetoCause = "CALIBRATION";
      } else if (slate.spentSui + fee.feeSuiEquivalent > slate.budgetSui + FLOAT_EPS) {
        decision.decision = "VETO_PAYMENT";
        decision.vetoCause = "SLATE_BUDGET";
        decision.reason =
          `Vetoed x402 payment: slate budget ${slate.budgetSui} SUI would be exceeded ` +
          `(spent ${round(slate.spentSui, 9)} + fee ${fee.feeSuiEquivalent} SUI).`;
      } else {
        slate.spentSui = round(slate.spentSui + fee.feeSuiEquivalent, 9);
      }
      decisions.set(id, decision);
    }
    return SPECIALIST_IDS.filter((id) => decisions.has(id)).map((id) => decisions.get(id)!);
  }

  // ---- Steps A → C (+ thesis write) ---------------------------------------

  async evaluateMarket(
    market: MarketOpportunity,
    options: { slate?: SlateBudget; persistThesis?: boolean } = {}
  ): Promise<MarketEvaluation> {
    assertValidMarket(market);
    const context = await this.recallContext(market);
    const fees = await this.priceFees();
    const slate = options.slate ?? this.createSlate(context.mandate);
    const gates = this.evaluateGates(context, fees, slate, market.availableSignals ?? SPECIALIST_IDS);

    const approved = gates.filter((g) => g.decision === "APPROVE_PAYMENT");
    const settledAcquisitions = await Promise.allSettled(
      approved.map((gate) =>
        this.signals.acquireSignal({ specialistId: gate.specialistId, market, fee: gate.fee, gate })
      )
    );

    const acquired: MarketEvaluation["acquired"] = [];
    const acquisitionErrors: MarketEvaluation["acquisitionErrors"] = [];
    settledAcquisitions.forEach((res, idx) => {
      const gate = approved[idx];
      if (res.status === "rejected") {
        acquisitionErrors.push({ specialistId: gate.specialistId, error: String(res.reason) });
        return;
      }
      const problem = validateAcquiredSignal(res.value, gate.specialistId, market);
      if (problem) {
        acquisitionErrors.push({ specialistId: gate.specialistId, error: problem });
        return;
      }
      acquired.push({ gate, acquired: res.value });
    });

    // Step C: de-bias + precision-weight the unlocked signals, then size.
    const consensus = aggregateCalibratedSignals(
      acquired.map(({ acquired: a }) => ({
        specialistId: a.signal.specialistId,
        rawProbability: a.signal.rawProbability,
        calibration: context.calibrations[a.signal.specialistId],
      }))
    );

    // No purchased signal ⇒ no independent probability ⇒ nothing to size.
    const legs =
      acquired.length > 0
        ? evaluateBetLegs(consensus.calibratedConsensusProb, market, context.mandate)
        : [];
    const chosenLeg = legs[0] ?? null;
    const take = chosenLeg?.decision.action === "TAKE_EDGE";

    const thesis: EpisodicPredictionRecord = {
      kind: "episodic_v1",
      marketId: market.marketId,
      domain: market.domain,
      title: market.title,
      bookImpliedProb: market.bookImpliedProb,
      onchainImpliedProb: market.onchainImpliedProb,
      calibroCalibratedProb: consensus.calibratedConsensusProb,
      naiveEqualWeightProb: consensus.naiveEqualWeightProb,
      recommendedAction: take ? "TAKE_EDGE" : "PASS_NO_EDGE",
      kellyFraction: take ? chosenLeg.decision.cappedKellyFraction : 0,
      recommendedStakeUsd: take ? chosenLeg.decision.stakeUsd : 0,
      ...(take && chosenLeg
        ? {
            betSide: chosenLeg.side,
            betVenue: chosenLeg.venue,
            betDecimalOdds: chosenLeg.decision.decimalOdds,
            netEdge: chosenLeg.decision.netEdge,
          }
        : {}),
      signalsUsed: acquired.map(({ acquired: a }) => {
        const row = consensus.breakdown.find((b) => b.specialistId === a.signal.specialistId)!;
        return {
          specialistId: a.signal.specialistId,
          rawProbability: row.rawProbability,
          calibratedProbability: row.calibratedProbability,
          weight: row.normalizedWeight,
          x402Mode: a.payment.mode,
          ...(a.payment.mode === "LIVE_MAINNET" ? { x402TxDigest: a.payment.txDigest } : {}),
          ...(a.signal.payees?.length ? { payees: a.signal.payees } : {}),
        };
      }),
      signalsVetoed: gates
        .filter((g) => g.decision === "VETO_PAYMENT")
        .map((g) => ({
          specialistId: g.specialistId,
          reason: g.reason,
          savedFeeSui: g.fee.feeSuiEquivalent.toFixed(9).replace(/0+$/, "").replace(/\.$/, ""),
        })),
      memoryMode: this.memory.mode,
      marketSource: market.source,
      marketAsOf: market.asOf,
      createdAt: this.clock().toISOString(),
    };

    const thesisWrite =
      options.persistThesis === false ? null : await this.memory.rememberEpisodic(thesis);

    return {
      market,
      context,
      gates,
      acquired,
      acquisitionErrors,
      consensus,
      legs,
      chosenLeg,
      thesis,
      thesisWrite,
      slate,
    };
  }

  // ---- Step D ------------------------------------------------------------

  /**
   * Post-mortem: recall the sealed thesis from `calibro:episodic`, score every purchased
   * signal, update Brier + Platt per specialist, and write the results back to Walrus.
   *
   * Idempotent: a market with a settled post-mortem is returned as ALREADY_SETTLED, and
   * any specialist whose latest checkpoint already carries `lastSettledMarketId` for this
   * market is not updated twice (covers a crash between the two writes).
   */
  async settleMarketAndLearn(params: {
    marketId: string;
    outcome: 0 | 1;
    /** Extra recall context, e.g. `Domain=NBA Market="BOS @ NYK"` — improves recall precision */
    contextQuery?: string;
    /** Used only if the thesis cannot be recalled from Walrus */
    thesisFallback?: EpisodicPredictionRecord;
  }): Promise<SettlementResult> {
    const { marketId, outcome } = params;
    if (outcome !== 0 && outcome !== 1) {
      throw new Error(`Outcome must be 0 or 1, got ${String(outcome)}.`);
    }

    const contextQuery =
      params.contextQuery ??
      (params.thesisFallback
        ? `Domain=${params.thesisFallback.domain} Market="${params.thesisFallback.title}"`
        : "");
    const episodes = await this.memory.findMarketEpisodes(marketId, contextQuery);

    if (episodes.settled) {
      if (episodes.settled.record.outcome !== outcome) {
        throw new Error(
          `Market ${marketId} was already settled with outcome ${episodes.settled.record.outcome}; refusing to re-settle as ${outcome}.`
        );
      }
      return {
        status: "ALREADY_SETTLED",
        settled: episodes.settled.record,
        settledBlobId: episodes.settled.blobId,
      };
    }

    let thesis: EpisodicPredictionRecord;
    let thesisSource: "WALRUS_RECALL" | "LOCAL_FALLBACK";
    if (episodes.thesis) {
      thesis = episodes.thesis.record;
      thesisSource = "WALRUS_RECALL";
    } else if (params.thesisFallback && params.thesisFallback.marketId === marketId) {
      thesis = params.thesisFallback;
      thesisSource = "LOCAL_FALLBACK";
    } else {
      throw new Error(`No open thesis for market ${marketId} found in calibro:episodic.`);
    }

    // Latest state (other markets may have settled since this thesis was written).
    const { bySpecialist } = await this.memory.recallDomainCalibrations(thesis.domain);
    const nowIso = this.clock().toISOString();

    const updates: SpecialistLearningUpdate[] = [];
    const used = new Map(thesis.signalsUsed.map((s) => [s.specialistId, s]));
    const vetoed = new Set(thesis.signalsVetoed.map((v) => v.specialistId));

    for (const id of SPECIALIST_IDS) {
      const signal = used.get(id);
      if (!signal && !vetoed.has(id)) continue; // neither bought nor vetoed (acquisition error)

      const prev = bySpecialist[id] ?? createColdStartCalibration(id, thesis.domain);
      if (prev.lastSettledMarketId === marketId) {
        updates.push(learningUpdate(id, "ALREADY_APPLIED", prev, prev));
        continue;
      }

      if (signal) {
        const learned = updateCalibrationOnline(prev, signal.rawProbability, outcome);
        const next: SpecialistCalibrationRecord = {
          ...learned,
          x402PaidCount: prev.x402PaidCount + 1,
          lastSettledMarketId: marketId,
          updatedAt: nowIso,
        };
        const u = learningUpdate(id, "SAMPLE", prev, next);
        u.rawProbability = signal.rawProbability;
        u.singleBrier = computeBrierScore([{ probability: signal.rawProbability, outcome }]);
        updates.push(u);
      } else {
        // Vetoed: no new evidence about accuracy, but the veto itself is part of the record.
        const next: SpecialistCalibrationRecord = {
          ...prev,
          epoch: prev.epoch + 1,
          x402VetoedCount: prev.x402VetoedCount + 1,
          lastSettledMarketId: marketId,
          updatedAt: nowIso,
        };
        updates.push(learningUpdate(id, "VETO_TALLY", prev, next));
      }
    }

    const toWrite = updates.filter((u) => u.kind !== "ALREADY_APPLIED").map((u) => u.next);
    const calibrationWrite = await this.memory.rememberCalibrationsBulk(toWrite);
    if (calibrationWrite.failed > 0) {
      const failures = calibrationWrite.results
        .map((r, i) => (r.status === "done" ? null : `${toWrite[i].specialistId}: ${r.status} ${r.error ?? ""}`.trim()))
        .filter(Boolean)
        .join("; ");
      throw new Error(
        `Calibration write failed for market ${marketId} (${calibrationWrite.failed}/${calibrationWrite.total}): ${failures}. ` +
          `Safe to retry — already-written specialists are skipped.`
      );
    }

    const settled: EpisodicPredictionRecord = {
      ...thesis,
      outcome,
      realizedBrier: computeBrierScore([{ probability: thesis.calibroCalibratedProb, outcome }]),
      naiveRealizedBrier: computeBrierScore([{ probability: thesis.naiveEqualWeightProb, outcome }]),
      pnlUsd: computeSettledPnlUsd(thesis, outcome),
      settledAt: nowIso,
      memoryMode: this.memory.mode,
    };
    const episodicWrite = await this.memory.rememberEpisodic(settled);

    return {
      status: "SETTLED",
      thesisSource,
      thesisBlobId: episodes.thesis?.blobId,
      settled,
      updates,
      calibrationWrite,
      episodicWrite,
    };
  }

  // ---- internals ---------------------------------------------------------

  private async getRate(symbol: "SUI" | "USDC"): Promise<{ usdPrice: number; source: RateSource }> {
    const cached = this.rateCache.get(symbol);
    const nowMs = this.clock().getTime();
    if (cached && nowMs - cached.at < RATE_CACHE_TTL_MS) return cached.value;
    const value = await this.rates.getUsdExchangeRate(symbol);
    if (!Number.isFinite(value.usdPrice) || value.usdPrice <= 0) {
      throw new Error(`Invalid ${symbol}/USD rate ${value.usdPrice} from ${value.source}.`);
    }
    this.rateCache.set(symbol, { at: nowMs, value });
    return value;
  }
}

function validateAcquiredSignal(
  acquired: AcquiredSignal,
  specialistId: SpecialistId,
  market: MarketOpportunity
): string | null {
  const { signal, payment } = acquired;
  if (signal.specialistId !== specialistId) return `Signal specialist mismatch (${signal.specialistId}).`;
  if (signal.marketId !== market.marketId) return `Signal market mismatch (${signal.marketId}).`;
  if (!Number.isFinite(signal.rawProbability) || signal.rawProbability < 0 || signal.rawProbability > 1) {
    return `Signal probability out of range (${signal.rawProbability}).`;
  }
  if (payment.mode === "LIVE_MAINNET" && !payment.txDigest) {
    return "LIVE_MAINNET payment reported without a txDigest.";
  }
  if (payment.mode === "UNPAID" && payment.txDigest) {
    return "UNPAID signal must not carry a txDigest.";
  }
  return null;
}

function learningUpdate(
  specialistId: SpecialistId,
  kind: SpecialistLearningUpdate["kind"],
  prev: SpecialistCalibrationRecord,
  next: SpecialistCalibrationRecord
): SpecialistLearningUpdate {
  return {
    specialistId,
    kind,
    prevBrier: prev.brierScore,
    nextBrier: next.brierScore,
    brierDelta: round(next.brierScore - prev.brierScore, 6),
    prevAlphaSlope: prev.alphaSlope,
    nextAlphaSlope: next.alphaSlope,
    prevBetaIntercept: prev.betaIntercept,
    nextBetaIntercept: next.betaIntercept,
    next,
  };
}
