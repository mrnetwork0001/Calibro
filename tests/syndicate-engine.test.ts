import { MemWalMock } from "@mysten-incubation/memwal";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_X402_FEE,
  SPECIALIST_IDS,
  SUI_MAINNET_USDC_COIN_TYPE,
  SyndicateEngine,
  computeSettledPnlUsd,
  evaluateBetLegs,
  rawToDecimal,
  type AcquiredSignal,
  type MarketEvaluation,
  type SettlementResult,
  type SignalAcquisitionRequest,
  type SpecialistSignalProvider,
  type UsdRateProvider,
} from "../src/lib/orchestrator/syndicate-engine";
import { TatumSuiClient } from "../src/lib/tatum/sui-rpc";
import { SPECIALIST_DOMAINS } from "../src/lib/types/calibro";
import type {
  BankrollMandateRecord,
  MarketDomain,
  MarketOpportunity,
  SpecialistId,
} from "../src/lib/types/calibro";
import { CalibroMemoryClient } from "../src/lib/walrus/memory-client";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MANDATE: BankrollMandateRecord = {
  kind: "mandate_v1",
  bankrollUsd: 2_500,
  kellyMultiplier: 0.25,
  maxSingleStakePct: 0.05,
  minEdgeThreshold: 0.02,
  maxSlateX402BudgetSui: 0.05,
  preferredDomains: ["NBA", "EPL", "CRYPTO_MACRO"],
  updatedAt: "2026-11-04T12:00:00.000Z",
};

/** Fixed SUI/USD so fee math is reproducible (0.002 SUI × $2.00 = $0.004). */
const FIXED_RATES: UsdRateProvider = {
  async getUsdExchangeRate(symbol) {
    return { usdPrice: symbol === "USDC" ? 1 : 2, source: "TATUM_V4_RATES" };
  },
};

/** The four specialists these synthetic-vendor tests were written for (third-party voices have no test data). */
const TEST_IDS = ["sharp-steam", "power-rating", "onchain-flow", "hype-contrarian"] as const satisfies readonly SpecialistId[];

/**
 * Sandbox specialists with fixed, known skill profiles (the "deliberate flaws" of
 * the spec, §3). Each specialist's raw probability depends on the hidden outcome,
 * which is how a skilled (or anti-skilled) source behaves on average.
 */
function sandboxProbability(id: SpecialistId, domain: MarketDomain, y: 0 | 1): number {
  const sports = domain !== "CRYPTO_MACRO";
  switch (id) {
    case "sharp-steam":
      return y ? 0.72 : 0.3;
    case "power-rating":
      return y ? 0.66 : 0.36;
    case "onchain-flow":
      return sports ? (y ? 0.48 : 0.55) : y ? 0.74 : 0.28;
    case "hype-contrarian":
      return y ? 0.18 : 0.86; // confidently wrong
    default:
      return 0.5;
  }
}

class SandboxSignalProvider implements SpecialistSignalProvider {
  readonly calls: SignalAcquisitionRequest[] = [];
  constructor(private readonly hiddenOutcomes: Map<string, 0 | 1>) {}

  async acquireSignal(req: SignalAcquisitionRequest): Promise<AcquiredSignal> {
    this.calls.push(req);
    const y = this.hiddenOutcomes.get(req.market.marketId);
    if (y === undefined) throw new Error(`no fixture outcome for ${req.market.marketId}`);
    return {
      signal: {
        specialistId: req.specialistId,
        specialistName: req.specialistId,
        marketId: req.market.marketId,
        domain: req.market.domain,
        rawProbability: sandboxProbability(req.specialistId, req.market.domain, y),
        confidenceTag: "MEDIUM",
        rationale: "sandbox fixture",
        generatedAt: "2026-11-04T12:00:00.000Z",
      },
      payment: { mode: "UNPAID" },
    };
  }
}

function makeMarket(i: number, domain: MarketDomain = "NBA"): MarketOpportunity {
  return {
    marketId: `${domain.toLowerCase()}-game-${String(i).padStart(2, "0")}`,
    domain,
    title: `${domain} Fixture Game ${i}`,
    subtitle: "Home team moneyline",
    closesAt: "2026-11-06T00:00:00.000Z",
    bookDecimalOdds: 1.75,
    bookImpliedProb: 0.55,
    onchainImpliedProb: 0.52,
    venueLabel: "fixture",
    source: "HISTORICAL", asOf: "2026-11-01T00:00:00.000Z", availableSignals: ["sharp-steam", "power-rating", "onchain-flow", "hype-contrarian"],
  };
}

/** 12 settled NBA games, then game 13 (YES) as the post-recall evaluation. */
const NBA_OUTCOMES: Array<0 | 1> = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 1];
const EPOCH_13_OUTCOME: 0 | 1 = 1;

interface Harness {
  mock: MemWalMock;
  memory: CalibroMemoryClient;
  signals: SandboxSignalProvider;
  engine: SyndicateEngine;
  outcomes: Map<string, 0 | 1>;
}

function makeHarness(opts: { mock?: MemWalMock; outcomes?: Map<string, 0 | 1> } = {}): Harness {
  const mock = opts.mock ?? MemWalMock.create({ namespace: "calibro:episodic", owner: "0xtest" });
  const memory = new CalibroMemoryClient({ mode: "MOCK_SANDBOX", mockInstance: mock });
  const outcomes = opts.outcomes ?? new Map<string, 0 | 1>();
  const signals = new SandboxSignalProvider(outcomes);
  const engine = new SyndicateEngine({ memory, signals, rates: FIXED_RATES });
  return { mock, memory, signals, engine, outcomes };
}

function gateOf(ev: MarketEvaluation, id: SpecialistId) {
  return ev.gates.find((g) => g.specialistId === id)!;
}

async function runNbaEpochs(h: Harness): Promise<{
  evaluations: MarketEvaluation[];
  settlements: SettlementResult[];
}> {
  const evaluations: MarketEvaluation[] = [];
  const settlements: SettlementResult[] = [];
  for (let i = 0; i < NBA_OUTCOMES.length; i++) {
    const market = makeMarket(i + 1);
    h.outcomes.set(market.marketId, NBA_OUTCOMES[i]);
    evaluations.push(await h.engine.evaluateMarket(market));
    settlements.push(
      await h.engine.settleMarketAndLearn({ marketId: market.marketId, outcome: NBA_OUTCOMES[i] })
    );
  }
  return { evaluations, settlements };
}

function meanBrier(settlements: SettlementResult[]): number {
  const vals = settlements.map((s) => {
    if (s.status !== "SETTLED") throw new Error("expected SETTLED");
    return s.settled.realizedBrier!;
  });
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SyndicateEngine — Epoch 1 cold start", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await h.memory.rememberMandate(MANDATE);
  });

  it("buys all 4 specialists at equal weight with zero calibration memories", async () => {
    const market = makeMarket(1);
    h.outcomes.set(market.marketId, 1);
    const ev = await h.engine.evaluateMarket(market);

    expect(ev.context.mandateSource).toBe("WALRUS_RECALL");
    expect(ev.context.memoryMode).toBe("MOCK_SANDBOX");
    for (const id of TEST_IDS) {
      expect(ev.context.calibrationSources[id]).toBe("COLD_START");
      expect(gateOf(ev, id).decision).toBe("APPROVE_PAYMENT");
      expect(gateOf(ev, id).fee.feeUsd).toBeCloseTo(0.004, 10);
    }
    expect(ev.consensus.breakdown.map((b) => b.normalizedWeight)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(ev.slate.spentSui).toBeCloseTo(0.008, 12);
    expect(ev.thesis.signalsVetoed).toHaveLength(0);
    expect(ev.thesisWrite?.blob_id).toBeTruthy();
  });

  it("never attaches a txDigest to unpaid test signals", async () => {
    const market = makeMarket(1);
    h.outcomes.set(market.marketId, 1);
    const ev = await h.engine.evaluateMarket(market);
    expect(ev.thesis.memoryMode).toBe("MOCK_SANDBOX");
    for (const s of ev.thesis.signalsUsed) {
      expect(s.x402Mode).toBe("UNPAID");
      expect(s.x402TxDigest).toBeUndefined();
    }
  });

  it("falls back to DEFAULT_MANDATE when calibro:mandates is empty", async () => {
    const fresh = makeHarness();
    const market = makeMarket(1);
    fresh.outcomes.set(market.marketId, 1);
    const ev = await fresh.engine.evaluateMarket(market, { persistThesis: false });
    expect(ev.context.mandateSource).toBe("DEFAULT_MANDATE");
    expect(ev.context.mandate.kellyMultiplier).toBeLessThanOrEqual(0.25);
  });
});

describe("SyndicateEngine — Epoch 1 → Epoch 12 closed-loop learning on MemWalMock", () => {
  let h: Harness;
  let evaluations: MarketEvaluation[];
  let settlements: SettlementResult[];

  beforeEach(async () => {
    h = makeHarness();
    await h.memory.rememberMandate(MANDATE);
    ({ evaluations, settlements } = await runNbaEpochs(h));
  });

  it("explores every specialist for 4 epochs, then autonomously vetoes the noisy ones", () => {
    for (let e = 0; e < 4; e++) {
      for (const id of TEST_IDS) {
        expect(gateOf(evaluations[e], id).decision).toBe("APPROVE_PAYMENT");
      }
    }
    for (let e = 4; e < 12; e++) {
      expect(gateOf(evaluations[e], "sharp-steam").decision).toBe("APPROVE_PAYMENT");
      expect(gateOf(evaluations[e], "power-rating").decision).toBe("APPROVE_PAYMENT");
      for (const id of ["hype-contrarian", "onchain-flow"] as const) {
        const g = gateOf(evaluations[e], id);
        expect(g.decision).toBe("VETO_PAYMENT");
        expect(g.vetoCause).toBe("CALIBRATION");
        expect(g.calibrationSource).toBe("WALRUS_RECALL");
        expect(g.reason).toMatch(/Brier/);
      }
    }
    // Only the 2 calibrated specialists were actually paid after exploration.
    const paidAfterExploration = h.signals.calls.slice(16).map((c) => c.specialistId);
    expect(new Set(paidAfterExploration)).toEqual(new Set(["sharp-steam", "power-rating"]));
  });

  it("writes Brier + Platt state that a fresh recall reads back exactly", async () => {
    const { bySpecialist } = await h.memory.recallDomainCalibrations("NBA");
    const sharp = bySpecialist["sharp-steam"]!;
    const injury = bySpecialist["power-rating"]!;
    const flow = bySpecialist["onchain-flow"]!;
    const hype = bySpecialist["hype-contrarian"]!;

    // Every specialist gets a checkpoint on every NBA settlement → epoch 12.
    for (const rec of [sharp, injury, flow, hype]) {
      expect(rec.epoch).toBe(12);
      expect(rec.lastSettledMarketId).toBe("nba-game-12");
    }

    expect(sharp.sampleSize).toBe(12);
    expect(sharp.x402PaidCount).toBe(12);
    expect(sharp.brierScore).toBeLessThan(0.1);
    expect(injury.brierScore).toBeLessThan(0.14);
    expect(sharp.brierScore).toBeLessThan(injury.brierScore);

    expect(hype.sampleSize).toBe(4);
    expect(hype.x402PaidCount).toBe(4);
    expect(hype.x402VetoedCount).toBe(8);
    expect(hype.brierScore).toBeGreaterThan(0.5);
    expect(hype.alphaSlope).toBeLessThan(1); // overconfidence shrunk toward base rate

    expect(flow.sampleSize).toBe(4);
    expect(flow.brierScore).toBeGreaterThan(0.265);
  });

  it("reports per-specialist Brier deltas and Platt moves on every settlement", () => {
    const first = settlements[0];
    expect(first.status).toBe("SETTLED");
    if (first.status !== "SETTLED") return;
    expect(first.thesisSource).toBe("WALRUS_RECALL");
    expect(first.updates.map((u) => u.kind)).toEqual(["SAMPLE", "SAMPLE", "SAMPLE", "SAMPLE"]);

    const hypeFirst = first.updates.find((u) => u.specialistId === "hype-contrarian")!;
    // Cold-start prior 0.22 → single observation (0.18 - 1)^2 = 0.6724
    expect(hypeFirst.nextBrier).toBeCloseTo(0.6724, 4);
    expect(hypeFirst.brierDelta).toBeCloseTo(0.6724 - 0.22, 4);
    expect(hypeFirst.nextAlphaSlope).toBeLessThan(hypeFirst.prevAlphaSlope);

    const late = settlements[11];
    if (late.status !== "SETTLED") throw new Error("expected SETTLED");
    const kinds = Object.fromEntries(late.updates.map((u) => [u.specialistId, u.kind]));
    expect(kinds).toEqual({
      "sharp-steam": "SAMPLE",
      "power-rating": "SAMPLE",
      "onchain-flow": "VETO_TALLY",
      "hype-contrarian": "VETO_TALLY",
    });
    const vetoTally = late.updates.find((u) => u.kind === "VETO_TALLY")!;
    expect(vetoTally.brierDelta).toBe(0); // no new evidence when the signal wasn't bought
  });

  it("Epoch 13: re-weights toward the sharpest source and beats its own Epoch 1 forecast", async () => {
    const market13 = makeMarket(13);
    h.outcomes.set(market13.marketId, EPOCH_13_OUTCOME);
    const ev13 = await h.engine.evaluateMarket(market13);

    const weights = Object.fromEntries(
      ev13.consensus.breakdown.map((b) => [b.specialistId, b.normalizedWeight])
    );
    expect(Object.keys(weights).sort()).toEqual(["power-rating", "sharp-steam"]);
    expect(weights["sharp-steam"]).toBeGreaterThan(weights["power-rating"]);
    expect(weights["sharp-steam"]! + weights["power-rating"]!).toBeCloseTo(1, 3);

    expect(ev13.thesis.signalsVetoed.map((v) => v.specialistId).sort()).toEqual([
      "hype-contrarian",
      "onchain-flow",
    ]);
    expect(ev13.thesis.signalsVetoed.every((v) => v.savedFeeSui === "0.002")).toBe(true);
    expect(ev13.slate.spentSui).toBeCloseTo(0.004, 12); // half the Epoch 1 spend

    // Epoch 1 faced the same YES outcome with all 4 specialists at equal weight.
    const ev1 = evaluations[0];
    const brier = (p: number) => (p - EPOCH_13_OUTCOME) ** 2;
    expect(brier(ev13.thesis.calibroCalibratedProb)).toBeLessThan(brier(ev1.thesis.calibroCalibratedProb));
    expect(ev13.thesis.calibroCalibratedProb).toBeGreaterThan(0.6);
    expect(ev1.thesis.calibroCalibratedProb).toBeLessThan(0.55);

    // Kelly gate: best price for YES is on-chain (1/0.52 ≈ 1.923 > 1.75 book).
    expect(ev13.thesis.recommendedAction).toBe("TAKE_EDGE");
    expect(ev13.thesis.betSide).toBe("YES");
    expect(ev13.thesis.betVenue).toBe("ONCHAIN");
    expect(ev13.thesis.kellyFraction).toBeLessThanOrEqual(0.05);
    expect(ev13.thesis.recommendedStakeUsd).toBeLessThanOrEqual(MANDATE.bankrollUsd * 0.05);
  });

  it("forecast accuracy improves: later epochs have lower realized Brier than exploration epochs", () => {
    expect(meanBrier(settlements.slice(8))).toBeLessThan(meanBrier(settlements.slice(0, 4)));
    for (const s of settlements) {
      if (s.status !== "SETTLED") continue;
      expect(s.settled.naiveRealizedBrier).toBeTypeOf("number");
      expect(s.settled.pnlUsd).toBe(computeSettledPnlUsd(s.settled, s.settled.outcome!));
    }
  });

  it("keeps the 3 namespaces separate with the expected memory counts", async () => {
    const audit = await h.memory.auditInventory();
    const counts = Object.fromEntries(audit.namespaces.map((n) => [n.name, n.memory_count]));
    expect(counts["calibro:mandates"]).toBe(1);
    expect(counts["calibro:episodic"]).toBe(24); // 12 open theses + 12 post-mortems
    expect(counts["calibro:calibration"]).toBe(48); // 4 checkpoints × 12 settlements
    expect(audit.totalMemories).toBe(73);
  });

  it("portable brain: a brand-new engine on the same memory account inherits every decision", async () => {
    const market13 = makeMarket(13);
    const outcomes = new Map([[market13.marketId, EPOCH_13_OUTCOME]]);
    const fresh = makeHarness({ mock: h.mock, outcomes });

    const evFresh = await fresh.engine.evaluateMarket(market13, { persistThesis: false });
    h.outcomes.set(market13.marketId, EPOCH_13_OUTCOME);
    const evOrig = await h.engine.evaluateMarket(market13, { persistThesis: false });

    expect(evFresh.gates.map((g) => g.decision)).toEqual(evOrig.gates.map((g) => g.decision));
    expect(evFresh.consensus).toEqual(evOrig.consensus);
    expect(evFresh.chosenLeg?.decision.stakeUsd).toBe(evOrig.chosenLeg?.decision.stakeUsd);
    expect(TEST_IDS.map((id) => evFresh.context.calibrationSources[id])).toEqual(Array(4).fill("WALRUS_RECALL"));
  });

  it("isolates domains: NBA learning does not leak into EPL calibration", async () => {
    const epl = makeMarket(1, "EPL");
    h.outcomes.set(epl.marketId, 1);
    const ev = await h.engine.evaluateMarket(epl, { persistThesis: false });
    for (const id of TEST_IDS) {
      expect(ev.context.calibrationSources[id]).toBe("COLD_START");
      expect(gateOf(ev, id).decision).toBe("APPROVE_PAYMENT");
    }
  });

  it("recalls analogous settled markets from calibro:episodic for context", async () => {
    const market13 = makeMarket(13);
    h.outcomes.set(market13.marketId, EPOCH_13_OUTCOME);
    const ev = await h.engine.evaluateMarket(market13, { persistThesis: false });
    expect(ev.context.analogousMarkets.length).toBeGreaterThan(0);
    expect(ev.context.analogousMarkets.length).toBeLessThanOrEqual(8);
    const ids = ev.context.analogousMarkets.map((a) => a.record.marketId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(market13.marketId);
  });
});

describe("SyndicateEngine — interleaved multi-domain recall (regression)", () => {
  it("recalls the newest checkpoint per (specialist, domain) when domains are interleaved", async () => {
    const h = makeHarness();
    await h.memory.rememberMandate(MANDATE);
    const domains: MarketDomain[] = ["NBA", "EPL", "CRYPTO_MACRO", "UFC"];
    const counts: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      const domain = domains[i % domains.length];
      const m = makeMarket(i + 1, domain);
      const y: 0 | 1 = i % 3 === 0 ? 0 : 1;
      h.outcomes.set(m.marketId, y);
      await h.engine.evaluateMarket(m);
      await h.engine.settleMarketAndLearn({ marketId: m.marketId, outcome: y });
      counts[domain] = (counts[domain] ?? 0) + 1;
    }
    for (const domain of domains) {
      const { bySpecialist } = await h.memory.recallDomainCalibrations(domain);
      // Only pairs a real source can cover are recalled (PowerRating = ESPN BPI is NBA-only).
      for (const id of TEST_IDS.filter((x) => SPECIALIST_DOMAINS[x].includes(domain))) {
        expect(bySpecialist[id]?.epoch, `${id}/${domain}`).toBe(counts[domain]);
      }
      // The source that stays paid in each league (sharp in sports, flow in crypto) has one sample per market.
      expect(bySpecialist[domain === "CRYPTO_MACRO" ? "onchain-flow" : "sharp-steam"]!.sampleSize).toBe(counts[domain]);
    }
  });
});

describe("SyndicateEngine — settlement safety", () => {
  let h: Harness;
  beforeEach(async () => {
    h = makeHarness();
    await h.memory.rememberMandate(MANDATE);
  });

  it("is idempotent: re-settling returns ALREADY_SETTLED and writes nothing", async () => {
    const m = makeMarket(1);
    h.outcomes.set(m.marketId, 1);
    await h.engine.evaluateMarket(m);
    await h.engine.settleMarketAndLearn({ marketId: m.marketId, outcome: 1 });
    const before = (await h.memory.auditInventory()).totalMemories;

    const again = await h.engine.settleMarketAndLearn({ marketId: m.marketId, outcome: 1 });
    expect(again.status).toBe("ALREADY_SETTLED");
    expect((await h.memory.auditInventory()).totalMemories).toBe(before);

    await expect(
      h.engine.settleMarketAndLearn({ marketId: m.marketId, outcome: 0 })
    ).rejects.toThrow(/already settled with outcome 1/);
  });

  it("does not double-count a specialist after a crash between the two writes", async () => {
    const m = makeMarket(1);
    h.outcomes.set(m.marketId, 1);
    await h.engine.evaluateMarket(m);

    // Simulate: calibration for sharp-steam was written, then the process died.
    const { bySpecialist } = await h.memory.recallDomainCalibrations("NBA");
    expect(bySpecialist["sharp-steam"]).toBeUndefined();
    await h.memory.rememberCalibrationsBulk([
      {
        kind: "calibration_v1",
        specialistId: "sharp-steam",
        domain: "NBA",
        epoch: 1,
        sampleSize: 1,
        brierScore: 0.0784,
        alphaSlope: 1,
        betaIntercept: 0,
        x402PaidCount: 1,
        x402VetoedCount: 0,
        lastSettledMarketId: m.marketId,
        updatedAt: "2026-11-04T12:00:00.000Z",
      },
    ]);

    const res = await h.engine.settleMarketAndLearn({ marketId: m.marketId, outcome: 1 });
    if (res.status !== "SETTLED") throw new Error("expected SETTLED");
    expect(res.updates.find((u) => u.specialistId === "sharp-steam")!.kind).toBe("ALREADY_APPLIED");
    expect(res.calibrationWrite.total).toBe(3);

    const after = await h.memory.recallDomainCalibrations("NBA");
    expect(after.bySpecialist["sharp-steam"]!.sampleSize).toBe(1);
    expect(after.bySpecialist["hype-contrarian"]!.sampleSize).toBe(1);
  });

  it("requires a thesis: recalled from Walrus, or an explicit local fallback", async () => {
    const m = makeMarket(1);
    h.outcomes.set(m.marketId, 1);
    const ev = await h.engine.evaluateMarket(m, { persistThesis: false });

    await expect(
      h.engine.settleMarketAndLearn({ marketId: m.marketId, outcome: 1 })
    ).rejects.toThrow(/No open thesis/);

    const res = await h.engine.settleMarketAndLearn({
      marketId: m.marketId,
      outcome: 1,
      thesisFallback: ev.thesis,
    });
    expect(res.status === "SETTLED" && res.thesisSource).toBe("LOCAL_FALLBACK");
  });

  it("computes PnL for the chosen leg", () => {
    const base = {
      kind: "episodic_v1" as const,
      marketId: "x",
      domain: "NBA" as const,
      title: "x",
      bookImpliedProb: 0.5,
      onchainImpliedProb: 0.5,
      calibroCalibratedProb: 0.6,
      naiveEqualWeightProb: 0.6,
      kellyFraction: 0.02,
      signalsUsed: [],
      signalsVetoed: [],
      createdAt: "2026-11-04T12:00:00.000Z",
    };
    const take = { ...base, recommendedAction: "TAKE_EDGE" as const, recommendedStakeUsd: 50, betSide: "YES" as const, betDecimalOdds: 2 };
    expect(computeSettledPnlUsd(take, 1)).toBe(50);
    expect(computeSettledPnlUsd(take, 0)).toBe(-50);
    expect(computeSettledPnlUsd({ ...take, betSide: "NO" }, 0)).toBe(50);
    expect(computeSettledPnlUsd({ ...base, recommendedAction: "PASS_NO_EDGE", recommendedStakeUsd: 0 }, 1)).toBe(0);
  });
});

describe("SyndicateEngine — x402 fee pricing & slate budget", () => {
  it("enforces the mandate's per-slate x402 budget, spending it on the best-calibrated first", async () => {
    const h = makeHarness();
    await h.memory.rememberMandate({ ...MANDATE, maxSlateX402BudgetSui: 0.005 });
    const m1 = makeMarket(1);
    const m2 = makeMarket(2);
    h.outcomes.set(m1.marketId, 1).set(m2.marketId, 0);

    const ev1 = await h.engine.evaluateMarket(m1);
    const approved = ev1.gates.filter((g) => g.decision === "APPROVE_PAYMENT");
    const budgetVetoes = ev1.gates.filter((g) => g.vetoCause === "SLATE_BUDGET");
    expect(approved).toHaveLength(2); // 2 × 0.002 ≤ 0.005 < 3 × 0.002
    expect(budgetVetoes).toHaveLength(2);
    expect(budgetVetoes[0].reason).toMatch(/slate budget/);

    // Same slate, budget exhausted: nothing is bought, nothing is sized.
    const ev2 = await h.engine.evaluateMarket(m2, { slate: ev1.slate });
    expect(ev2.gates.every((g) => g.vetoCause === "SLATE_BUDGET")).toBe(true);
    expect(ev2.acquired).toHaveLength(0);
    expect(ev2.chosenLeg).toBeNull();
    expect(ev2.thesis.recommendedAction).toBe("PASS_NO_EDGE");
    expect(ev2.thesis.recommendedStakeUsd).toBe(0);
  });

  it("prices USDC fees with 6 decimals and SUI fees with 9", async () => {
    const memory = new CalibroMemoryClient({ mode: "MOCK_SANDBOX" });
    const engine = new SyndicateEngine({
      memory,
      signals: new SandboxSignalProvider(new Map()),
      rates: FIXED_RATES,
      feeQuotes: { "sharp-steam": { coinType: SUI_MAINNET_USDC_COIN_TYPE, amountRaw: "10000" } },
    });
    const fees = await engine.priceFees();
    expect(fees["sharp-steam"]).toMatchObject({ symbol: "USDC", amountDecimal: 0.01, feeUsd: 0.01, feeSuiEquivalent: 0.005 });
    expect(fees["power-rating"]).toMatchObject({ symbol: "SUI", amountDecimal: 0.002, feeUsd: 0.004 });
    expect(rawToDecimal("1234567891", 9)).toBeCloseTo(1.234567891, 12);
    expect(() => rawToDecimal("1.5", 9)).toThrow();
  });

  it("refuses to price fees without a real Tatum rate (no static fallback)", async () => {
    const engine = new SyndicateEngine({
      memory: new CalibroMemoryClient({ mode: "MOCK_SANDBOX" }),
      signals: new SandboxSignalProvider(new Map()),
      rates: new TatumSuiClient({ apiKey: "" }),
    });
    await expect(engine.priceFees()).rejects.toThrow(/TATUM_API_KEY/);
    expect(DEFAULT_X402_FEE.amountRaw).toBe("2000000");
  });

  it("rejects unsupported coin types", async () => {
    const engine = new SyndicateEngine({
      memory: new CalibroMemoryClient({ mode: "MOCK_SANDBOX" }),
      signals: new SandboxSignalProvider(new Map()),
      rates: FIXED_RATES,
      defaultFee: { coinType: "0xabc::fake::FAKE", amountRaw: "1" },
    });
    await expect(engine.priceFees()).rejects.toThrow(/Unsupported x402 coin type/);
  });
});

describe("SyndicateEngine — honesty guards & leg selection", () => {
  it("rejects a LIVE_MAINNET payment without a digest and a MOCK payment with one", async () => {
    const memory = new CalibroMemoryClient({ mode: "MOCK_SANDBOX" });
    await memory.rememberMandate(MANDATE);
    const liar: SpecialistSignalProvider = {
      async acquireSignal(req) {
        const signal = {
          specialistId: req.specialistId,
          specialistName: req.specialistId,
          marketId: req.market.marketId,
          domain: req.market.domain,
          rawProbability: 0.7,
          confidenceTag: "HIGH" as const,
          rationale: "x",
          generatedAt: "2026-11-04T12:00:00.000Z",
        };
        return req.specialistId === "sharp-steam"
          ? { signal, payment: { mode: "LIVE_MAINNET" } }
          : { signal, payment: { mode: "UNPAID", txDigest: "FAKE" } };
      },
    };
    const engine = new SyndicateEngine({ memory, signals: liar, rates: FIXED_RATES });
    const ev = await engine.evaluateMarket(makeMarket(1), { persistThesis: false });
    expect(ev.acquired).toHaveLength(0);
    expect(ev.acquisitionErrors).toHaveLength(4);
    expect(ev.acquisitionErrors.find((e) => e.specialistId === "sharp-steam")!.error).toMatch(/without a txDigest/);
    expect(ev.thesis.recommendedAction).toBe("PASS_NO_EDGE");
  });

  it("records an acquisition failure without breaking the evaluation", async () => {
    const h = makeHarness();
    await h.memory.rememberMandate(MANDATE);
    // No fixture outcome → the sandbox provider throws for every specialist.
    const ev = await h.engine.evaluateMarket(makeMarket(99), { persistThesis: false });
    expect(ev.acquisitionErrors).toHaveLength(4);
    expect(ev.thesis.signalsUsed).toHaveLength(0);
  });

  it("chooses the NO leg on-chain when calibrated probability is well below the price", () => {
    const legs = evaluateBetLegs(0.3, { ...makeMarket(1), onchainImpliedProb: 0.5 }, MANDATE);
    expect(legs[0].side).toBe("NO");
    expect(legs[0].venue).toBe("ONCHAIN");
    expect(legs[0].decision.action).toBe("TAKE_EDGE");
    expect(legs[0].decision.cappedKellyFraction).toBeLessThanOrEqual(0.05);
  });

  it("skips the sportsbook leg when the market has no book price", () => {
    const legs = evaluateBetLegs(0.7, { ...makeMarket(1), bookDecimalOdds: null, bookImpliedProb: null }, MANDATE);
    expect(legs.map((l) => l.venue)).toEqual(["ONCHAIN", "ONCHAIN"]);
  });

  it("rejects malformed market odds", async () => {
    const h = makeHarness();
    await expect(
      h.engine.evaluateMarket({ ...makeMarket(1), onchainImpliedProb: 1.2 })
    ).rejects.toThrow(/implied probabilities/);
  });
});
