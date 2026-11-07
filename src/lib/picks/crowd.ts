/**
 * TopPickers: Calibro's users as a paid source. Only pickers with a record count
 * (≥ 3 graded picks, Brier ≤ 0.25 — better than a coin flip), each weighted with the same
 * trust function the specialists get. The x402 fee is split among them in proportion to
 * that weight and paid straight into their wallets in one Sui transaction.
 *
 * Upcoming games only: a past game would be judged with scorecards that already include
 * later results.
 */
import { trustWeight } from "../calibration/brier";
import { normalizeSuiAddress } from "../tatum/sui-rpc";
import type { MarketOpportunity, PickRecord, ScorecardRecord, SpecialistSignal } from "../types/calibro";
import type { CalibroMemoryClient } from "../walrus/memory-client";

export const TOP_PICKERS_MIN_GRADED = Number(process.env.CALIBRO_TOP_PICKERS_MIN_GRADED ?? 3);
export const TOP_PICKERS_MAX_BRIER = 0.25;
const MAX_CONTRIBUTORS = 6;

export interface PickerEntry {
  pick: PickRecord;
  card: ScorecardRecord;
}

export interface TopPickersResult {
  probability: number;
  payees: Array<{ address: string; amountRaw: string }>;
  contributors: Array<{ owner: string; probability: number; brier: number; graded: number; weight: number }>;
}

export function qualifies(card: ScorecardRecord | null | undefined): card is ScorecardRecord {
  return Boolean(card && card.graded >= TOP_PICKERS_MIN_GRADED && card.brier <= TOP_PICKERS_MAX_BRIER);
}

/** Weighted pick + fee shares (integer base units summing exactly to `totalRaw`). Pure. */
export function combineTopPickers(entries: PickerEntry[], totalRaw: bigint, exclude: string[] = []): TopPickersResult | null {
  const excluded = new Set(exclude.map(normalizeSuiAddress));
  const eligible = entries
    .filter((e) => qualifies(e.card) && !excluded.has(normalizeSuiAddress(e.pick.owner)))
    .map((e) => ({ ...e, w: trustWeight({ brierScore: e.card.brier, sampleSize: e.card.graded }) }))
    .sort((a, b) => b.w - a.w || a.pick.owner.localeCompare(b.pick.owner))
    .slice(0, MAX_CONTRIBUTORS);
  if (eligible.length === 0 || totalRaw < BigInt(eligible.length)) return null;

  const W = eligible.reduce((a, e) => a + e.w, 0);
  const probability = eligible.reduce((a, e) => a + e.pick.probability * e.w, 0) / W;
  // Proportional shares, rounded down; the remainder goes to the most trusted picker.
  const shares = eligible.map((e) => (totalRaw * BigInt(Math.round((e.w / W) * 1e6))) / 1_000_000n);
  for (let i = 0; i < shares.length; i++) if (shares[i] < 1n) shares[i] = 1n;
  const sum = shares.reduce((a, b) => a + b, 0n);
  shares[0] += totalRaw - sum;
  if (shares[0] < 1n) return null;

  return {
    probability: Number(probability.toFixed(4)),
    payees: eligible.map((e, i) => ({ address: e.pick.owner, amountRaw: shares[i].toString() })),
    contributors: eligible.map((e) => ({
      owner: e.pick.owner,
      probability: e.pick.probability,
      brier: e.card.brier,
      graded: e.card.graded,
      weight: Number((e.w / W).toFixed(4)),
    })),
  };
}

const cache = new Map<string, { at: number; value: Promise<TopPickersResult | null> }>();

/** Reads this market's pre-game picks and their owners' scorecards from Walrus (cached 60 s). */
export function loadTopPickers(
  memory: CalibroMemoryClient,
  market: MarketOpportunity,
  totalRaw: bigint,
  exclude: string[],
  now: Date = new Date()
): Promise<TopPickersResult | null> {
  const key = `${market.marketId}|${totalRaw}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < 60_000) return hit.value;
  const value = (async () => {
    const picks = (await memory.findMarketPicks(market.marketId)).filter((p) => Date.parse(p.record.pickedAt) <= now.getTime());
    const entries = (
      await Promise.all(
        picks.slice(0, 20).map(async ({ record }) => {
          const card = await memory.recallScorecard(record.owner);
          return card ? { pick: record, card } : null;
        })
      )
    ).filter((e): e is PickerEntry => e !== null);
    return combineTopPickers(entries, totalRaw, exclude);
  })();
  cache.set(key, { at: now.getTime(), value });
  value.catch(() => cache.delete(key));
  return value;
}

export function topPickersSignal(market: MarketOpportunity, result: TopPickersResult, now: Date): SpecialistSignal {
  const d = Math.abs(result.probability - 0.5);
  const n = result.contributors.length;
  const best = Math.min(...result.contributors.map((c) => c.brier));
  return {
    specialistId: "top-pickers",
    specialistName: "TopPickers",
    marketId: market.marketId,
    domain: market.domain,
    rawProbability: Math.min(0.97, Math.max(0.03, result.probability)),
    confidenceTag: d >= 0.25 ? "HIGH" : d >= 0.12 ? "MEDIUM" : "LOW",
    rationale: `${n} picker${n === 1 ? "" : "s"} with a record (best Brier ${best.toFixed(3)}), weighted by trust; the fee is split to their wallets`,
    generatedAt: now.toISOString(),
    payees: result.payees,
  };
}
