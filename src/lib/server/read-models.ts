/**
 * The read models behind the terminal, the Record tab, the pick journal and the landing
 * page. Each heavy Walrus read is cached once in the shared read cache (read-cache.ts) and
 * every view is derived from it, so one 20 s recall serves all of them.
 */
import { buildTimeline } from "../timeline/build";
import type { EpisodicPredictionRecord, PickPayoutRecord, ScorecardRecord } from "../types/calibro";
import { readThrough, refreshReadModel, type Cached } from "./read-cache";
import { getMemory, getPayer, paymentConfig, requireLive } from "./runtime";

export type SettledHit = { blobId: string; record: EpisodicPredictionRecord };

export interface Inventory {
  totalMemories: number;
  namespaces: Array<{ name: string; memoryCount: number; updatedAt?: string }>;
  memories: Array<{ blobId: string; namespace: string; createdAt: string; status?: string; size?: number }>;
  accountId: string | null;
}

export interface PickBoard {
  scorecards: ScorecardRecord[];
  payouts: PickPayoutRecord[];
}

/** Cache freshness in the API responses, so the UI can say how old a number is. */
export interface CacheInfo {
  asOf: string;
  stale: boolean;
}

export const cacheInfo = (...parts: Array<Cached<unknown>>): CacheInfo => ({
  asOf: parts.map((p) => p.asOf).sort()[0] ?? new Date().toISOString(),
  stale: parts.some((p) => p.stale),
});

const LOADERS = {
  "settled-games": () => getMemory().recallSettledEpisodes({ fresh: true }),
  "namespace-counts": () => getMemory().namespaceCounts(),
  inventory: async (): Promise<Inventory> => {
    const audit = await getMemory().auditInventory();
    return {
      totalMemories: audit.totalMemories,
      namespaces: audit.namespaces.map((n) => ({ name: n.name, memoryCount: n.memory_count, updatedAt: n.updated_at })),
      memories: audit.memories
        .filter((m) => m.namespace_id.startsWith("calibro:"))
        .map((m) => ({ blobId: m.blob_id, namespace: m.namespace_id, createdAt: m.created_at, status: m.status, size: m.size })),
      accountId: process.env.MEMWAL_ACCOUNT_ID?.trim() || null,
    };
  },
  "pick-board": async (): Promise<PickBoard> => {
    const memory = getMemory();
    const [scorecards, payouts] = await Promise.all([memory.recallScorecards(), memory.recallPayouts()]);
    return { scorecards, payouts };
  },
} as const;

/** Every settled post-mortem on the account, oldest first. */
export function settledGames(): Promise<Cached<SettledHit[]>> {
  requireLive();
  return readThrough("settled-games", LOADERS["settled-games"]);
}

export function namespaceTotals(): Promise<Cached<{ total: number; namespaces: Array<{ name: string; count: number }> }>> {
  requireLive();
  return readThrough("namespace-counts", LOADERS["namespace-counts"], { freshMs: 60_000 });
}

export function inventory(): Promise<Cached<Inventory>> {
  requireLive();
  return readThrough("inventory", LOADERS.inventory, { freshMs: 2 * 60_000 });
}

export function pickBoard(): Promise<Cached<PickBoard>> {
  requireLive();
  return readThrough("pick-board", LOADERS["pick-board"], { freshMs: 2 * 60_000 });
}

/** Reloads every read model from Walrus (cron warm-up). Returns what refreshed and what failed. */
export async function warmReadModels(names: Array<keyof typeof LOADERS> = Object.keys(LOADERS) as Array<keyof typeof LOADERS>) {
  requireLive();
  const results = await Promise.allSettled(names.map((n) => refreshReadModel<unknown>(n, LOADERS[n] as () => Promise<unknown>)));
  return names.map((n, i) => {
    const r = results[i];
    return r.status === "fulfilled" ? { name: n, ok: true as const } : { name: n, ok: false as const, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
  });
}

/* ------------------------------------------------------------------ derived views */

/** Latest calibration per (source, league) and reliability points, from the settled games. */
export function calibrationView(hits: SettledHit[]) {
  const calibrations = buildTimeline(hits).ledger;
  const settled = hits.map((h) => h.record);
  // Each purchased signal on a settled market is one (predicted, observed) point.
  const points = settled.flatMap((r) => [
    ...r.signalsUsed.map((s) => ({ source: s.specialistId, domain: r.domain, p: s.rawProbability, y: r.outcome! })),
    { source: "calibro", domain: r.domain, p: r.calibroCalibratedProb, y: r.outcome! },
  ]);
  return {
    calibrations,
    settled: settled.map((r) => ({
      marketId: r.marketId,
      domain: r.domain,
      title: r.title,
      calibroProb: r.calibroCalibratedProb,
      naiveProb: r.naiveEqualWeightProb,
      outcome: r.outcome,
      realizedBrier: r.realizedBrier,
      naiveRealizedBrier: r.naiveRealizedBrier,
      pnlUsd: r.pnlUsd,
      settledAt: r.settledAt,
    })),
    points,
  };
}

export interface RecordGame {
  marketId: string;
  domain: EpisodicPredictionRecord["domain"];
  title: string;
  marketAsOf: string | null;
  settledAt: string | null;
  outcome: 0 | 1;
  calibroProb: number;
  marketProb: number;
  naiveProb: number;
  bookProb: number | null;
  calibroBrier: number;
  marketBrier: number;
  action: string;
  pnlUsd: number;
  paid: Array<{ specialistId: string; weight: number; probability: number; txDigest: string | null; payees: number }>;
  refused: Array<{ specialistId: string; reason: string; savedFeeSui: string }>;
  postMortemBlobId: string;
}

/** Every settled game with its payments, refusals and Walrus record, newest first. */
export function recordView(hits: SettledHit[]) {
  const sq = (p: number, y: number) => (p - y) ** 2;
  const games: RecordGame[] = hits
    .filter((h) => h.record.outcome !== undefined)
    .map(({ blobId, record: r }) => ({
      marketId: r.marketId,
      domain: r.domain,
      title: r.title,
      marketAsOf: r.marketAsOf ?? null,
      settledAt: r.settledAt ?? null,
      outcome: r.outcome!,
      calibroProb: r.calibroCalibratedProb,
      marketProb: r.onchainImpliedProb,
      naiveProb: r.naiveEqualWeightProb,
      bookProb: r.bookImpliedProb,
      calibroBrier: sq(r.calibroCalibratedProb, r.outcome!),
      marketBrier: sq(r.onchainImpliedProb, r.outcome!),
      action: r.recommendedAction === "TAKE_EDGE" && r.betSide ? `${r.betSide} ${r.betVenue === "ONCHAIN" ? "on Polymarket" : "at the book"}, $${r.recommendedStakeUsd}` : "Pass",
      pnlUsd: r.pnlUsd ?? 0,
      paid: r.signalsUsed.map((s) => ({
        specialistId: s.specialistId,
        weight: s.weight,
        probability: s.rawProbability,
        txDigest: s.x402TxDigest ?? null,
        payees: s.payees?.length ?? 0,
      })),
      refused: r.signalsVetoed.map((v) => ({ specialistId: v.specialistId, reason: v.reason, savedFeeSui: v.savedFeeSui })),
      postMortemBlobId: blobId,
    }))
    .reverse();
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return {
    games,
    totals: {
      games: games.length,
      calibroBrier: mean(games.map((g) => g.calibroBrier)),
      marketBrier: mean(games.map((g) => g.marketBrier)),
      paidSignals: games.reduce((a, g) => a + g.paid.filter((p) => p.txDigest).length, 0),
      refusals: games.reduce((a, g) => a + g.refused.length, 0),
      paperPnlUsd: games.reduce((a, g) => a + g.pnlUsd, 0),
    },
    identities: {
      accountId: process.env.MEMWAL_ACCOUNT_ID?.trim() || null,
      agentAddress: getPayer().payer?.address ?? null,
      treasury: paymentConfig().treasury,
    },
  };
}
