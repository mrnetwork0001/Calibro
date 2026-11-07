import { z } from "zod";

export const MarketDomainSchema = z.enum([
  "NBA",
  "EPL",
  "UFC",
  "CRYPTO_MACRO",
]);
export type MarketDomain = z.infer<typeof MarketDomainSchema>;

export const SpecialistIdSchema = z.enum([
  "sharp-steam",
  "power-rating",
  "onchain-flow",
  "hype-contrarian",
  "kalshi-crowd",
  "manifold-crowd",
  "top-pickers",
]);
export type SpecialistId = z.infer<typeof SpecialistIdSchema>;

/** Leagues each source can ever produce a signal for (its data coverage). */
export const SPECIALIST_DOMAINS: Record<SpecialistId, readonly MarketDomain[]> = {
  "sharp-steam": ["NBA", "EPL", "UFC"],
  "power-rating": ["NBA"],
  "onchain-flow": ["NBA", "EPL", "UFC", "CRYPTO_MACRO"],
  "hype-contrarian": ["NBA", "EPL", "UFC", "CRYPTO_MACRO"],
  "kalshi-crowd": ["NBA", "EPL", "UFC"],
  "manifold-crowd": ["NBA"],
  "top-pickers": ["NBA", "EPL", "UFC"],
};

/** Everything sold behind HTTP 402: the specialists' signals and Calibro's own forecast. */
export const X402ProductSchema = z.union([SpecialistIdSchema, z.literal("calibro-forecast")]);
export type X402Product = z.infer<typeof X402ProductSchema>;

export const CALIBRO_NAMESPACES = {
  EPISODIC: "calibro:episodic",
  CALIBRATION: "calibro:calibration",
  MANDATES: "calibro:mandates",
  /** User picks (wallet-signed, sealed before the game) and per-user scorecards */
  PICKS: "calibro:picks",
} as const;

export type CalibroNamespace =
  (typeof CALIBRO_NAMESPACES)[keyof typeof CALIBRO_NAMESPACES];

/**
 * LIVE = an open Polymarket market priced now.
 * HISTORICAL = a resolved Polymarket market priced as of its scheduled start (point-in-time:
 * only data that existed before the start is used), for training and backtests.
 */
export type MarketSource = "LIVE" | "HISTORICAL";

export interface MarketOpportunity {
  marketId: string;
  domain: MarketDomain;
  title: string;
  subtitle: string;
  closesAt: string;
  /**
   * Sharp sportsbook decimal odds for the YES side (home / fighter A / event).
   * `null` when no sportsbook price exists for this market — never synthesised.
   */
  bookDecimalOdds: number | null;
  /** De-vigged sportsbook implied probability for YES [0, 1], or `null` */
  bookImpliedProb: number | null;
  /** On-chain prediction-market implied probability for YES [0, 1] */
  onchainImpliedProb: number;
  /** Human label for where the prices came from */
  venueLabel: string;
  source: MarketSource;
  /** Instant every price in this record refers to (now for LIVE, scheduled start for HISTORICAL) */
  asOf: string;
  /** Specialists that have the data to produce a signal for this market. Absent = all. */
  availableSignals?: SpecialistId[];
  /** Label of the YES outcome, e.g. "Hornets" */
  yesLabel?: string;
  /** Polymarket URL for transparency */
  sourceUrl?: string;
  /** Where the sportsbook price came from, e.g. "DraftKings via ESPN (close)" */
  bookSource?: string;
  /** Venues or sources disagreeing on this market */
  alerts?: MarketAlert[];
}

export interface MarketAlert {
  kind: "BOOK_VS_CHAIN" | "KALSHI_VS_CHAIN" | "SOURCES_SPLIT";
  severity: "warning" | "serious";
  /** Probability gap (venues) or spread of source forecasts */
  magnitude: number;
  detail: string;
}

export interface SpecialistSignal {
  specialistId: SpecialistId;
  specialistName: string;
  marketId: string;
  domain: MarketDomain;
  /** Raw uncalibrated probability reported by specialist [0, 1] */
  rawProbability: number;
  confidenceTag: "LOW" | "MEDIUM" | "HIGH";
  rationale: string;
  generatedAt: string;
  /** Who the x402 fee for this signal is paid to, when split among people (TopPickers) */
  payees?: Array<{ address: string; amountRaw: string }>;
}

export interface SpecialistCalibrationRecord {
  kind: "calibration_v1";
  specialistId: SpecialistId;
  domain: MarketDomain;
  epoch: number;
  sampleSize: number;
  /** Rolling / cumulative Brier score in [0, 1]; 0.25 = coin-flip baseline */
  brierScore: number;
  /** Log-odds slope (< 1 shrinks overconfidence; 1 = well-calibrated) */
  alphaSlope: number;
  /** Log-odds intercept (directional bias correction) */
  betaIntercept: number;
  x402PaidCount: number;
  x402VetoedCount: number;
  /**
   * Market whose settlement produced this checkpoint. Lets a retried settlement
   * detect that this specialist was already updated and skip double-counting.
   */
  lastSettledMarketId?: string;
  updatedAt: string;
}

export interface EpisodicPredictionRecord {
  kind: "episodic_v1";
  marketId: string;
  domain: MarketDomain;
  title: string;
  bookImpliedProb: number | null;
  onchainImpliedProb: number;
  calibroCalibratedProb: number;
  naiveEqualWeightProb: number;
  recommendedAction: "TAKE_EDGE" | "PASS_NO_EDGE";
  kellyFraction: number;
  recommendedStakeUsd: number;
  /** Chosen leg when recommendedAction === "TAKE_EDGE" */
  betSide?: "YES" | "NO";
  betVenue?: "SPORTSBOOK" | "ONCHAIN";
  betDecimalOdds?: number;
  netEdge?: number;
  signalsUsed: Array<{
    specialistId: SpecialistId;
    rawProbability: number;
    calibratedProbability: number;
    weight: number;
    /** Real Sui Mainnet digest only — never present for UNPAID signals */
    x402TxDigest?: string;
    x402Mode?: "LIVE_MAINNET" | "UNPAID";
    /** Human pickers this signal's fee was split to */
    payees?: Array<{ address: string; amountRaw: string }>;
  }>;
  signalsVetoed: Array<{
    specialistId: SpecialistId;
    reason: string;
    savedFeeSui: string;
  }>;
  /** Filled after settlement (1 = YES won, 0 = NO won) */
  outcome?: 0 | 1;
  realizedBrier?: number;
  /** Brier of the naive equal-weight average of the same purchased signals */
  naiveRealizedBrier?: number;
  pnlUsd?: number;
  settledAt?: string;
  memoryMode?: "LIVE_MAINNET" | "MOCK_SANDBOX";
  /** Market source and the instant its prices refer to */
  marketSource?: MarketSource;
  marketAsOf?: string;
  createdAt: string;
}

export interface BankrollMandateRecord {
  kind: "mandate_v1";
  bankrollUsd: number;
  /** Fractional Kelly scalar (hard-capped <= 0.25) */
  kellyMultiplier: number;
  /** Max % of bankroll on any single market (hard-capped <= 0.05) */
  maxSingleStakePct: number;
  /** Min calibrated probability edge over market to act (e.g. 0.02 = 2%) */
  minEdgeThreshold: number;
  /** Max SUI budget per evaluation slate for x402 signal calls */
  maxSlateX402BudgetSui: number;
  preferredDomains: MarketDomain[];
  updatedAt: string;
}

export interface X402PaymentChallenge {
  protocol: "x402+mpp-sui-v1";
  /** HMAC-signed, self-describing token (see src/lib/x402/protocol.ts) */
  challengeId: string;
  issuedAt: string;
  realm: string;
  network: "sui:mainnet";
  /** Product being bought (a specialist id, or "calibro-forecast") */
  specialistId: X402Product;
  marketId: string;
  recipient: string;
  coinType: string;
  amountRaw: string;
  expiresAt: string;
  /**
   * Split payment: pay each recipient its share in ONE Sui transaction (shares sum to
   * amountRaw; `recipient` is the first share). Used to pay human pickers directly.
   */
  splits?: Array<{ recipient: string; amountRaw: string }>;
}

export interface X402PaymentProof {
  challengeId: string;
  txDigest: string;
  payer: string;
  network: "sui:mainnet";
  mode: "LIVE_MAINNET" | "MOCK_SANDBOX";
}

export interface X402GateDecision {
  specialistId: SpecialistId;
  domain: MarketDomain;
  decision: "APPROVE_PAYMENT" | "VETO_PAYMENT";
  recalledBrierScore: number;
  sampleSize: number;
  expectedVoiUsd: number;
  feeUsd: number;
  reason: string;
}

export interface KellySizingDecision {
  action: "TAKE_EDGE" | "PASS_NO_EDGE";
  calibratedProb: number;
  targetMarketImpliedProb: number;
  decimalOdds: number;
  netEdge: number;
  rawKellyFraction: number;
  cappedKellyFraction: number;
  stakeUsd: number;
  reason: string;
}

/** A user's pick: P(YES) signed by their Sui wallet before the game, sealed on Walrus. */
export interface PickRecord {
  kind: "pick_v1";
  /** Normalised Sui address of the signer */
  owner: string;
  marketId: string;
  domain: MarketDomain;
  title: string;
  yesLabel: string;
  /** The user's probability that YES happens */
  probability: number;
  marketProbAtPick: number;
  bookProbAtPick: number | null;
  gameStart: string;
  pickedAt: string;
  /** Exact signed text and the wallet's signature over it */
  message: string;
  signature: string;
  /** The coach's suggestion on screen when the user signed (null = no suggestion offered) */
  coach?: { suggestedProbability: number | null };
  /** Filled when graded against Polymarket's resolution */
  outcome?: 0 | 1;
  brier?: number;
  marketBrier?: number;
  /** Calibro's own forecast for the same market, when Calibro evaluated it */
  calibroProb?: number | null;
  gradedAt?: string;
}

/** Calibro paid a picker for using their pick (TopPickers), recorded in their Walrus history. */
export interface PickPayoutRecord {
  kind: "payout_v1";
  owner: string;
  marketId: string;
  title: string;
  amountRaw: string;
  coinType: string;
  txDigest: string;
  payer: string;
  paidAt: string;
}

/** Same calibration state the specialists carry, kept per user and league. */
export interface UserLeagueCalibration {
  domain: MarketDomain;
  epoch: number;
  sampleSize: number;
  brierScore: number;
  alphaSlope: number;
  betaIntercept: number;
  /** Polymarket's Brier on the same picks, at pick time */
  marketBrier: number;
  updatedAt: string;
}

export interface ScorecardRecord {
  kind: "scorecard_v1";
  owner: string;
  /** Number of graded picks folded in (append-only version) */
  epoch: number;
  graded: number;
  brier: number;
  marketBrier: number;
  /** Calibro's Brier on the subset of picks where Calibro also forecast */
  calibroBrier: number | null;
  calibroCompared: number;
  byDomain: Partial<Record<MarketDomain, UserLeagueCalibration>>;
  /** Picks where the user backed a side at ≥ 60%: stated confidence vs how often it won */
  favourites: { n: number; statedSum: number; wins: number; statedAvg: number; hitRate: number; adjusted: number };
  /** Picks where the coach made a suggestion: Brier when the user followed it vs ignored it */
  coach?: { followed: { n: number; brierSum: number }; ignored: { n: number; brierSum: number } };
  gradedMarketIds: string[];
  updatedAt: string;
}
