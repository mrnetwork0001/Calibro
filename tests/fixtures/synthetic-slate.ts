/**
 * UNIT-TEST FIXTURES ONLY — synthetic markets and vendors of known, fixed quality, so the
 * engine's learning can be asserted deterministically. Never imported by the app: the
 * app trains on real resolved Polymarket markets (scripts/train-mainnet.ts).
 */
import { createHash } from "node:crypto";
import type { MarketDomain, MarketOpportunity, SpecialistId, SpecialistSignal } from "../../src/lib/types/calibro";

export interface ReplayFixture {
  market: MarketOpportunity;
  outcome: 0 | 1;
  /** 1-based global order in the replay */
  epoch: number;
  heldOut: boolean;
}

type Row = [
  id: string,
  domain: MarketDomain,
  title: string,
  yesLabel: string,
  bookDecimalOdds: number,
  bookImpliedProb: number,
  onchainImpliedProb: number,
  outcome: 0 | 1,
];

const ROWS: Row[] = [
  // ---- training epochs 1..16 ----
  ["replay-nba-01", "NBA", "Celtics vs Knicks", "Celtics", 1.72, 0.565, 0.53, 1],
  ["replay-epl-01", "EPL", "Arsenal vs Brentford", "Arsenal", 1.55, 0.62, 0.6, 1],
  ["replay-nba-02", "NBA", "Lakers vs Suns", "Lakers", 2.05, 0.47, 0.5, 0],
  ["replay-crypto-01", "CRYPTO_MACRO", "BTC above $90k at month end", "Yes", 2.3, 0.42, 0.38, 1],
  ["replay-epl-02", "EPL", "Chelsea vs Newcastle", "Chelsea", 2.1, 0.46, 0.49, 0],
  ["replay-nba-03", "NBA", "Nuggets vs Timberwolves", "Nuggets", 1.8, 0.54, 0.51, 1],
  ["replay-ufc-01", "UFC", "Main event: Pereira vs Ankalaev", "Pereira", 2.2, 0.44, 0.47, 0],
  ["replay-epl-03", "EPL", "Liverpool vs Aston Villa", "Liverpool", 1.6, 0.6, 0.58, 1],
  ["replay-nba-04", "NBA", "Bucks vs 76ers", "Bucks", 1.9, 0.51, 0.55, 0],
  ["replay-crypto-02", "CRYPTO_MACRO", "Fed cuts rates at next meeting", "Yes", 1.65, 0.58, 0.63, 0],
  ["replay-epl-04", "EPL", "Man City vs Tottenham", "Man City", 1.45, 0.66, 0.64, 1],
  ["replay-nba-05", "NBA", "Warriors vs Kings", "Warriors", 1.95, 0.5, 0.47, 1],
  ["replay-ufc-02", "UFC", "Co-main: Topuria vs Holloway", "Topuria", 1.5, 0.64, 0.61, 1],
  ["replay-epl-05", "EPL", "Man United vs West Ham", "Man United", 1.85, 0.52, 0.55, 0],
  ["replay-crypto-03", "CRYPTO_MACRO", "ETH/BTC ratio up this week", "Yes", 2.0, 0.48, 0.45, 1],
  ["replay-nba-06", "NBA", "Heat vs Cavaliers", "Heat", 2.4, 0.4, 0.43, 0],
  // ---- held-out "Epoch N" markets ----
  ["replay-nba-07", "NBA", "Thunder vs Mavericks", "Thunder", 1.7, 0.57, 0.52, 1],
  ["replay-epl-06", "EPL", "Arsenal vs Liverpool", "Arsenal", 2.25, 0.43, 0.47, 0],
  ["replay-crypto-04", "CRYPTO_MACRO", "SOL above $250 at month end", "Yes", 2.6, 0.37, 0.33, 1],
];

const TRAINING_COUNT = 16;

export const REPLAY_FIXTURES: ReplayFixture[] = ROWS.map(
  ([id, domain, title, yesLabel, odds, book, onchain, outcome], idx) => ({
    epoch: idx + 1,
    heldOut: idx >= TRAINING_COUNT,
    outcome,
    market: {
      marketId: id,
      domain,
      title,
      subtitle: `Test fixture · YES = ${yesLabel}`,
      closesAt: "2026-11-01T00:00:00.000Z",
      bookDecimalOdds: odds,
      bookImpliedProb: book,
      onchainImpliedProb: onchain,
      venueLabel: "Unit-test fixture",
      source: "HISTORICAL" as const,
      asOf: "2026-11-01T00:00:00.000Z",
      availableSignals: ["sharp-steam", "power-rating", "onchain-flow", "hype-contrarian"] as SpecialistId[],
      yesLabel,
    },
  })
);

const BY_ID = new Map(REPLAY_FIXTURES.map((f) => [f.market.marketId, f]));

export function getReplayFixture(marketId: string): ReplayFixture | undefined {
  return BY_ID.get(marketId);
}

export const TRAINING_FIXTURES = REPLAY_FIXTURES.filter((f) => !f.heldOut);
export const HELD_OUT_FIXTURES = REPLAY_FIXTURES.filter((f) => f.heldOut);

/** [p | outcome=0, p | outcome=1] centre of each test vendor's forecast. */
const SKILL: Record<SpecialistId, Record<"SPORTS" | "CRYPTO_MACRO", [number, number]>> = {
  "sharp-steam": { SPORTS: [0.3, 0.72], CRYPTO_MACRO: [0.4, 0.6] },
  "power-rating": { SPORTS: [0.36, 0.67], CRYPTO_MACRO: [0.47, 0.53] },
  "onchain-flow": { SPORTS: [0.55, 0.48], CRYPTO_MACRO: [0.27, 0.75] },
  "hype-contrarian": { SPORTS: [0.85, 0.2], CRYPTO_MACRO: [0.82, 0.24] },
  "kalshi-crowd": { SPORTS: [0.4, 0.6], CRYPTO_MACRO: [0.45, 0.55] },
  "manifold-crowd": { SPORTS: [0.42, 0.58], CRYPTO_MACRO: [0.45, 0.55] },
  "top-pickers": { SPORTS: [0.38, 0.64], CRYPTO_MACRO: [0.45, 0.55] },
};

function hashUnit(input: string): number {
  const h = createHash("sha256").update(input).digest();
  return (h.readUInt32BE(0) / 0xffffffff) * 2 - 1;
}

/** Deterministic test vendor signal of known skill for a fixture market. */
export function syntheticSignal(specialistId: SpecialistId, market: MarketOpportunity, outcome: 0 | 1): SpecialistSignal {
  const centre = SKILL[specialistId][market.domain === "CRYPTO_MACRO" ? "CRYPTO_MACRO" : "SPORTS"][outcome];
  const p = Math.min(0.97, Math.max(0.03, centre + hashUnit(`${specialistId}:${market.marketId}`) * 0.04));
  const rawProbability = Number(p.toFixed(4));
  const d = Math.abs(rawProbability - 0.5);
  return {
    specialistId,
    specialistName: specialistId,
    marketId: market.marketId,
    domain: market.domain,
    rawProbability,
    confidenceTag: d >= 0.25 ? "HIGH" : d >= 0.12 ? "MEDIUM" : "LOW",
    rationale: "[TEST FIXTURE]",
    generatedAt: "2026-11-01T00:00:00.000Z",
  };
}
