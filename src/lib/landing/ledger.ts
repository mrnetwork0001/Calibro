/**
 * Live track record for the landing page, read from Walrus Memory Mainnet. Every number
 * comes from settled records on the account; nothing is computed from fixtures. Returns
 * null when Walrus isn't configured or reachable, and the page then shows no numbers.
 */
import { getPayer, paymentConfig, resolveMode, getMemory } from "../server/runtime";
import { buildTimeline } from "../timeline/build";
import type { MarketDomain, SpecialistCalibrationRecord } from "../types/calibro";

export interface LedgerSummary {
  settledMarkets: number;
  calibroBrier: number;
  equalWeightBrier: number;
  marketBrier: number;
  paidSignals: number;
  paidWithDigest: number;
  vetoes: number;
  savedSui: number;
  paperPnlUsd: number;
  totalMemories: number;
  calibrations: SpecialistCalibrationRecord[];
  domains: MarketDomain[];
  latestSettledAt?: string;
  /** Public on-chain identities, for anyone to verify */
  accountId: string | null;
  agentAddress: string | null;
  treasury: string | null;
}

/** Last good summary, served if the relayer hiccups (it is real data, just minutes old). */
let lastGood: LedgerSummary | null = null;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/**
 * Track record for the landing page. Built from the settled post-mortems (one recall per
 * league, shared with the hero chart and the timeline): replaying them reproduces the
 * calibration ledger exactly, so the 16 per-pair ledger recalls aren't needed here.
 */
export async function getLedgerSummary(): Promise<LedgerSummary | null> {
  if (resolveMode().mode !== "LIVE_MAINNET") return null;
  try {
    const memory = getMemory();
    const [settledHits, counts] = await Promise.all([memory.recallSettledEpisodes(), memory.namespaceCounts()]);
    const settled = settledHits.map((h) => h.record).filter((r) => r.outcome !== undefined);
    const replay = buildTimeline(settledHits);
    const sq = (p: number, y: 0 | 1) => (p - y) ** 2;
    const summary: LedgerSummary = {
      settledMarkets: settled.length,
      calibroBrier: mean(settled.map((r) => sq(r.calibroCalibratedProb, r.outcome!))),
      equalWeightBrier: mean(settled.map((r) => sq(r.naiveEqualWeightProb, r.outcome!))),
      marketBrier: mean(settled.map((r) => sq(r.onchainImpliedProb, r.outcome!))),
      paidSignals: settled.reduce((a, r) => a + r.signalsUsed.length, 0),
      paidWithDigest: settled.reduce((a, r) => a + r.signalsUsed.filter((s) => s.x402TxDigest).length, 0),
      vetoes: settled.reduce((a, r) => a + r.signalsVetoed.length, 0),
      savedSui: settled.reduce((a, r) => a + r.signalsVetoed.reduce((b, v) => b + Number(v.savedFeeSui), 0), 0),
      paperPnlUsd: settled.reduce((a, r) => a + (r.pnlUsd ?? 0), 0),
      totalMemories: counts.total,
      calibrations: replay.ledger,
      domains: [...new Set(settled.map((r) => r.domain))],
      latestSettledAt: settled.map((r) => r.settledAt ?? "").sort().pop() || undefined,
      accountId: process.env.MEMWAL_ACCOUNT_ID?.trim() || null,
      agentAddress: getPayer().payer?.address ?? null,
      treasury: paymentConfig().treasury,
    };
    lastGood = summary;
    return summary;
  } catch (err) {
    console.warn("[landing] ledger summary unavailable:", err instanceof Error ? err.message : err);
    return lastGood;
  }
}

export interface HeroSeries {
  league: MarketDomain;
  settlements: number;
  series: Array<{ id: SpecialistCalibrationRecord["specialistId"]; points: Array<number | null>; final: number; samples: number; refused: boolean }>;
}

let lastHero: HeroSeries | null = null;

/**
 * Brier score of every source after each settlement in one league, replayed from the
 * settled post-mortems on Walrus (same replay as the terminal's learning timeline).
 */
export async function getHeroSeries(): Promise<HeroSeries | null> {
  if (resolveMode().mode !== "LIVE_MAINNET") return null;
  try {
    const timeline = buildTimeline(await getMemory().recallSettledEpisodes());
    const counts = new Map<MarketDomain, number>();
    for (const s of timeline.steps) counts.set(s.domain, (counts.get(s.domain) ?? 0) + 1);
    const league = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!league) return null;
    const steps = timeline.steps.filter((s) => s.domain === league);
    const ids = [...new Set(steps.flatMap((s) => s.league.map((r) => r.specialistId)))];
    const hero: HeroSeries = {
      league,
      settlements: steps.length,
      series: ids.map((id) => {
        const points = steps.map((s) => s.league.find((r) => r.specialistId === id)?.brier ?? null);
        const last = [...steps].reverse().find((s) => s.league.some((r) => r.specialistId === id))!.league.find((r) => r.specialistId === id)!;
        return { id, points, final: last.brier, samples: last.samples, refused: last.status === "VETOED" };
      }),
    };
    lastHero = hero;
    return hero;
  } catch (err) {
    console.warn("[landing] hero series unavailable:", err instanceof Error ? err.message : err);
    return lastHero;
  }
}
