import { createHash } from "node:crypto";
import {
  MemWal,
  MemWalMock,
  type MemoriesResult,
  type NamespacesResult,
  type RecallResult,
  type RememberBulkItem,
  type RememberBulkResult,
  type RememberResult,
  type RestoreResult,
} from "@mysten-incubation/memwal";
import {
  CALIBRO_NAMESPACES,
  MarketDomainSchema,
  SPECIALIST_DOMAINS,
  SpecialistIdSchema,
  type BankrollMandateRecord,
  type CalibroNamespace,
  type EpisodicPredictionRecord,
  type MarketDomain,
  type PickPayoutRecord,
  type PickRecord,
  type ScorecardRecord,
  type SpecialistCalibrationRecord,
  type SpecialistId,
} from "../types/calibro";

const JSON_DELIM_START = "---CALIBRO_JSON_START---";
const JSON_DELIM_END = "---CALIBRO_JSON_END---";

/**
 * Formats a structured Calibro memory so Walrus TEE embeddings index rich semantic text
 * while deterministic callers extract lossless JSON on recall().
 */
export function serializeStructuredMemory<T extends object>(
  semanticSummary: string,
  payload: T
): string {
  return `${semanticSummary.trim()}\n${JSON_DELIM_START}\n${JSON.stringify(payload)}\n${JSON_DELIM_END}`;
}

export function parseStructuredMemory<T>(rawText: string): T | null {
  const startIdx = rawText.indexOf(JSON_DELIM_START);
  const endIdx = rawText.indexOf(JSON_DELIM_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }
  const jsonSlice = rawText
    .slice(startIdx + JSON_DELIM_START.length, endIdx)
    .trim();
  try {
    return JSON.parse(jsonSlice) as T;
  } catch {
    return null;
  }
}

/**
 * Stable, rare token identifying one market across its thesis and post-mortem.
 * Semantic recall is not an exact lookup: market ids like "nba-game-11" share
 * almost every token with their neighbours, so an opaque hash tag is embedded in
 * the header and used in the lookup query to make the target the nearest hit.
 */
export function marketRecallTag(marketId: string): string {
  return `mk${createHash("sha256").update(marketId).digest("hex").slice(0, 16)}`;
}

/** Opaque per-user tag (addresses share too many hex tokens to be recalled precisely). */
export function ownerRecallTag(address: string): string {
  return `ow${createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 16)}`;
}

export function formatPickMemoryText(p: PickRecord): string {
  const status = p.outcome === undefined ? "OPEN" : "GRADED";
  const graded = p.outcome === undefined ? "" : ` Outcome=${p.outcome} Brier=${(p.brier ?? 0).toFixed(4)} MarketBrier=${(p.marketBrier ?? 0).toFixed(4)}`;
  const summary =
    `[Calibro Pick ${status}] Owner=${ownerRecallTag(p.owner)} Ref=${marketRecallTag(p.marketId)} Domain=${p.domain} ` +
    `Market="${p.title}" YES="${p.yesLabel}" Pick=${(p.probability * 100).toFixed(0)}% Polymarket=${(p.marketProbAtPick * 100).toFixed(1)}%${graded}`;
  return serializeStructuredMemory(summary, p);
}

export function formatPayoutMemoryText(p: PickPayoutRecord): string {
  const summary =
    `[Calibro Payout] Owner=${ownerRecallTag(p.owner)} Ref=${marketRecallTag(p.marketId)} Market="${p.title}" ` +
    `Amount=${p.amountRaw} Coin=${p.coinType.split("::").pop()} Tx=${p.txDigest}`;
  return serializeStructuredMemory(summary, p);
}

export function formatScorecardMemoryText(c: ScorecardRecord): string {
  const summary =
    `[Calibro Scorecard] Owner=${ownerRecallTag(c.owner)} Epoch=${c.epoch} Graded=${c.graded} Brier=${c.brier.toFixed(4)} ` +
    `MarketBrier=${c.marketBrier.toFixed(4)} Favourites=${c.favourites.n}@${(c.favourites.statedAvg * 100).toFixed(0)}%/${(c.favourites.hitRate * 100).toFixed(0)}%`;
  return serializeStructuredMemory(summary, c);
}

/** Semantic header + JSON payload for an episodic thesis / post-mortem. */
export function formatEpisodicMemoryText(record: EpisodicPredictionRecord): string {
  const statusLabel = episodicStatusLabel(record);
  const leg =
    record.recommendedAction === "TAKE_EDGE" && record.betSide && record.betVenue
      ? ` Leg=${record.betSide}@${record.betVenue}`
      : "";
  const settled =
    record.outcome === undefined
      ? ""
      : ` Outcome=${record.outcome} RealizedBrier=${(record.realizedBrier ?? 0).toFixed(4)}`;
  const summary =
    `[Calibro Episodic ${statusLabel}] Ref=${marketRecallTag(record.marketId)} Domain=${record.domain} Market="${record.title}" (${record.marketId}) ` +
    `BookImplied=${record.bookImpliedProb === null ? "n/a" : `${(record.bookImpliedProb * 100).toFixed(1)}%`} OnchainImplied=${(record.onchainImpliedProb * 100).toFixed(1)}% CalibroProb=${(record.calibroCalibratedProb * 100).toFixed(1)}% ` +
    `Action=${record.recommendedAction}${leg} Stake=$${record.recommendedStakeUsd.toFixed(2)}${settled}`;
  return serializeStructuredMemory(summary, record);
}

/** Semantic header + JSON payload for a specialist-domain calibration checkpoint. */
export function formatCalibrationMemoryText(
  record: SpecialistCalibrationRecord
): string {
  const summary =
    `[Calibro Calibration] Specialist=${record.specialistId} Domain=${record.domain} ` +
    `Epoch=${record.epoch} Samples=${record.sampleSize} Brier=${record.brierScore.toFixed(4)} ` +
    `AlphaSlope=${record.alphaSlope.toFixed(3)} BetaIntercept=${record.betaIntercept.toFixed(3)} ` +
    `x402Paid=${record.x402PaidCount} x402Vetoed=${record.x402VetoedCount}`;
  return serializeStructuredMemory(summary, record);
}

export function episodicStatusLabel(record: EpisodicPredictionRecord): string {
  return record.outcome === undefined
    ? "OPEN_THESIS"
    : `SETTLED_OUTCOME_${record.outcome}`;
}

/**
 * "Newest wins" for append-only calibration checkpoints. `epoch` is bumped on every
 * write for a (specialist, domain) pair, so it is the primary version; relayer
 * `created_at` breaks ties. Returns true when `candidate` should replace `current`.
 */
function isNewerCalibration(
  candidate: { record: SpecialistCalibrationRecord; createdAt?: string },
  current: { record: SpecialistCalibrationRecord; createdAt?: string }
): boolean {
  if (candidate.record.epoch !== current.record.epoch) {
    return candidate.record.epoch > current.record.epoch;
  }
  if (candidate.createdAt && current.createdAt) {
    return Date.parse(candidate.createdAt) > Date.parse(current.createdAt);
  }
  // `sort: "recent"` lists newest first, so the earlier hit already wins ties.
  return false;
}

export type CalibroMemoryMode = "LIVE_MAINNET" | "MOCK_SANDBOX";

/** Fresh for 60 s; after that the last good value is served at once while it refreshes. */
const CACHE_FRESH_MS = 60_000;
/** Older than this, a reader waits for fresh data instead of seeing a stale copy. */
const CACHE_MAX_STALE_MS = 30 * 60_000;

interface SwrSlot<T> {
  at: number;
  value: Promise<T>;
  last?: T;
  lastAt?: number;
  refreshing?: boolean;
}

/**
 * Stale-while-revalidate over a slow recall (each full read is many SEAL-decrypted
 * recalls). Writes reset the slot so a reader right after a settlement never sees
 * pre-settlement numbers.
 */
function swrRead<T>(slot: SwrSlot<T> | null, load: () => Promise<T>, set: (s: SwrSlot<T> | null) => void): Promise<T> {
  const now = Date.now();
  if (slot && now - slot.at < CACHE_FRESH_MS) return slot.value;
  if (slot?.last !== undefined && slot.lastAt !== undefined && now - slot.lastAt < CACHE_MAX_STALE_MS) {
    if (!slot.refreshing) {
      slot.refreshing = true;
      load()
        .then((v) => set({ at: Date.now(), value: Promise.resolve(v), last: v, lastAt: Date.now() }))
        .catch(() => {
          slot.refreshing = false;
        });
    }
    return Promise.resolve(slot.last);
  }
  const value = load();
  const fresh: SwrSlot<T> = { at: now, value };
  set(fresh);
  value.then(
    (v) => {
      fresh.last = v;
      fresh.lastAt = Date.now();
    },
    () => set(null)
  );
  return value;
}

/** (specialist, domain) pairs that can hold checkpoints, given each source's coverage. */
function coveredPairs(domains: readonly MarketDomain[]): Array<[SpecialistId, MarketDomain]> {
  return domains.flatMap((d) => SpecialistIdSchema.options.filter((id) => SPECIALIST_DOMAINS[id].includes(d)).map((id) => [id, d] as [SpecialistId, MarketDomain]));
}

/** Relayer cap for recall limit; see recallCalibrationLedger(). */
export const CALIBRATION_RECALL_LIMIT = 100;

export interface CalibroMemoryConfig {
  mode?: CalibroMemoryMode;
  key?: string;
  accountId?: string;
  serverUrl?: string;
  mockInstance?: MemWalMock;
}

/**
 * Unified Walrus Memory adapter for Calibro.
 * Uses `MemWal.create(...)` on Mainnet (`https://relayer.memory.walrus.xyz`)
 * and `MemWalMock.create(...)` ONLY when explicitly configured for tests/sandbox.
 */
export class CalibroMemoryClient {
  public readonly mode: CalibroMemoryMode;
  public readonly serverUrl: string;
  private readonly client: MemWal | MemWalMock;
  private readonly mockAuditLog: MemoriesResult["memories"] = [];

  constructor(config: CalibroMemoryConfig = {}) {
    const requestedMode =
      config.mode ??
      (process.env.CALIBRO_MEMORY_MODE === "mock"
        ? "MOCK_SANDBOX"
        : "LIVE_MAINNET");

    this.serverUrl =
      config.serverUrl ??
      process.env.MEMWAL_SERVER_URL ??
      "https://relayer.memory.walrus.xyz";

    if (requestedMode === "MOCK_SANDBOX") {
      this.mode = "MOCK_SANDBOX";
      this.client =
        config.mockInstance ??
        MemWalMock.create({
          namespace: CALIBRO_NAMESPACES.EPISODIC,
          owner: "0xcalibro0000000000000000000000000000000000000000000000000000mock",
        });
      return;
    }

    const key = config.key ?? process.env.MEMWAL_PRIVATE_KEY;
    const accountId = config.accountId ?? process.env.MEMWAL_ACCOUNT_ID;
    if (!key || !accountId) {
      throw new Error(
        "LIVE_MAINNET mode requires MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID. " +
          "Run `npm run memwal:provision` or set CALIBRO_MEMORY_MODE=mock for offline sandbox tests."
      );
    }

    this.mode = "LIVE_MAINNET";
    this.client = MemWal.create({
      key,
      accountId,
      serverUrl: this.serverUrl,
      namespace: CALIBRO_NAMESPACES.EPISODIC,
      // Recall decrypts every hit with SEAL; large recalls need more than the 15 s default.
      recallTimeoutMs: 40_000,
      // The relayer's unauthenticated GET /version sometimes takes longer than the SDK's 5 s
      // default; failing the whole read on that probe surfaced as 500s in the terminal.
      preflightTimeoutMs: 15_000,
    });
  }

  /** Store an episodic prediction or post-mortem record and wait for Walrus `blob_id`. */
  async rememberEpisodic(
    record: EpisodicPredictionRecord,
    idempotencyKey?: string
  ): Promise<RememberResult> {
    this.settledCache = null;
    const text = formatEpisodicMemoryText(record);
    const res = await this.client.rememberAndWait(text, CALIBRO_NAMESPACES.EPISODIC, {
      idempotencyKey:
        idempotencyKey ??
        `episodic:${record.marketId}:${episodicStatusLabel(record)}`,
      dedupe: true,
      timeoutMs: 45_000,
    });
    this.recordMockAuditEntry(res);
    return res;
  }

  /** Store a single specialist-domain calibration update on Walrus. */
  async rememberCalibration(
    record: SpecialistCalibrationRecord
  ): Promise<RememberResult> {
    this.ledgerCache = null;
    const text = formatCalibrationMemoryText(record);
    const res = await this.client.rememberAndWait(text, CALIBRO_NAMESPACES.CALIBRATION, {
      idempotencyKey: `cal:${record.specialistId}:${record.domain}:epoch:${record.epoch}`,
      dedupe: true,
      timeoutMs: 45_000,
    });
    this.recordMockAuditEntry(res);
    return res;
  }

  /**
   * Batch-write calibration checkpoints via `rememberBulkAndWait` (chunks of 20).
   * Results are returned in input order across all chunks.
   */
  async rememberCalibrationsBulk(
    records: SpecialistCalibrationRecord[]
  ): Promise<RememberBulkResult> {
    this.ledgerCache = null;
    const merged: RememberBulkResult = { results: [], total: 0, succeeded: 0, failed: 0 };
    for (let i = 0; i < records.length; i += 20) {
      const chunk = records.slice(i, i + 20).map((record) => ({
        text: formatCalibrationMemoryText(record),
        namespace: CALIBRO_NAMESPACES.CALIBRATION,
      }));
      const res = await this.rememberBulk(chunk);
      merged.results.push(...res.results);
      merged.total += res.total;
      merged.succeeded += res.succeeded;
      merged.failed += res.failed;
    }
    return merged;
  }

  /** Batch-write up to 20 calibration or episodic memories in parallel PTBs on Walrus. */
  async rememberBulk(items: RememberBulkItem[]): Promise<RememberBulkResult> {
    if (items.length === 0) {
      return { results: [], total: 0, succeeded: 0, failed: 0 };
    }
    if (items.length > 20) {
      throw new Error(
        `rememberBulk accepts at most 20 items per batch (received ${items.length}).`
      );
    }
    const bulkRes = await this.client.rememberBulkAndWait(items, {
      timeoutMs: 60_000,
    });
    for (const item of bulkRes.results) {
      if (item.status === "done" && item.blob_id) {
        this.recordMockAuditEntry({
          id: item.id,
          blob_id: item.blob_id,
          owner: "mock-owner",
          namespace: item.namespace,
        });
      }
    }
    return bulkRes;
  }

  /** Store user's active Kelly & x402 budget mandate on Walrus. */
  async rememberMandate(record: BankrollMandateRecord): Promise<RememberResult> {
    const summary =
      `[Calibro Active Bankroll Mandate] Bankroll=$${record.bankrollUsd} ` +
      `KellyMultiplier=${record.kellyMultiplier} MaxSingleStakePct=${record.maxSingleStakePct} ` +
      `MinEdge=${record.minEdgeThreshold} MaxSlateX402BudgetSui=${record.maxSlateX402BudgetSui}`;

    const text = serializeStructuredMemory(summary, record);
    const res = await this.client.rememberAndWait(text, CALIBRO_NAMESPACES.MANDATES, {
      dedupe: true,
      timeoutMs: 45_000,
    });
    this.recordMockAuditEntry(res);
    return res;
  }

  /**
   * Checkpoints of one (specialist, domain) pair. One recall per pair: the relayer's
   * `sort: "recent"` re-sorts a semantic window (50 hits for limit ≤ 10, else up to 100)
   * by write time, so a single namespace-wide recall silently drops pairs once the
   * namespace outgrows that window — which Calibro's did at 36 settled markets. Scoped
   * per pair, the pair's own checkpoints are the nearest hits, so the newest is exact up
   * to ~50 settlements per league with `limit` 20, and the full history up to 100.
   */
  private async recallPairHistory(
    specialistId: SpecialistId,
    domain: MarketDomain,
    limit = 20
  ): Promise<Array<{ blobId: string; createdAt?: string; record: SpecialistCalibrationRecord }>> {
    const query = `[Calibro Calibration] Specialist=${specialistId} Domain=${domain} Epoch Brier`;
    let res: RecallResult | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.client.recall({ query, namespace: CALIBRO_NAMESPACES.CALIBRATION, limit, sort: "recent" });
        break;
      } catch (err) {
        if (attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
      }
    }
    const out: Array<{ blobId: string; createdAt?: string; record: SpecialistCalibrationRecord }> = [];
    for (const hit of res.results) {
      const parsed = parseStructuredMemory<SpecialistCalibrationRecord>(hit.text);
      if (parsed?.kind === "calibration_v1" && parsed.specialistId === specialistId && parsed.domain === domain) {
        out.push({ blobId: hit.blob_id, createdAt: hit.created_at, record: parsed });
      }
    }
    return out;
  }

  private async recallPairs<T>(
    pairs: Array<[SpecialistId, MarketDomain]>,
    fn: (hits: Array<{ blobId: string; createdAt?: string; record: SpecialistCalibrationRecord }>) => T,
    limit = 20
  ): Promise<T[]> {
    const out: T[] = new Array(pairs.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, pairs.length) }, async () => {
        while (next < pairs.length) {
          const i = next++;
          out[i] = fn(await this.recallPairHistory(pairs[i][0], pairs[i][1], limit));
        }
      })
    );
    return out;
  }

  /** Short in-process cache of the full ledger (24 recalls) for read-only views. */
  private ledgerCache: SwrSlot<{ byKey: Map<string, SpecialistCalibrationRecord> }> | null = null;

  /** Ledger for dashboards: cached for 60 s and invalidated by any calibration write. */
  async recallCalibrationLedgerCached(): Promise<{ byKey: Map<string, SpecialistCalibrationRecord> }> {
    return swrRead(this.ledgerCache, () => this.recallCalibrationLedger(), (slot) => (this.ledgerCache = slot));
  }

  private static newest(hits: Array<{ createdAt?: string; record: SpecialistCalibrationRecord }>): SpecialistCalibrationRecord | null {
    let best: { createdAt?: string; record: SpecialistCalibrationRecord } | null = null;
    for (const h of hits) if (!best || isNewerCalibration(h, best)) best = h;
    return best?.record ?? null;
  }

  /** Newest checkpoint for every (specialist, domain) pair that has one. */
  async recallCalibrationLedger(domains: readonly MarketDomain[] = MarketDomainSchema.options): Promise<{
    byKey: Map<string, SpecialistCalibrationRecord>;
  }> {
    const pairs = coveredPairs(domains);
    const newest = await this.recallPairs(pairs, (hits) => CalibroMemoryClient.newest(hits));
    const byKey = new Map<string, SpecialistCalibrationRecord>();
    for (const rec of newest) if (rec) byKey.set(`${rec.specialistId}|${rec.domain}`, rec);
    return { byKey };
  }

  /** Newest calibration checkpoint for one (specialist, domain) pair, or null. */
  async recallSpecialistCalibration(
    specialistId: SpecialistId,
    domain: MarketDomain
  ): Promise<{ record: SpecialistCalibrationRecord | null }> {
    return { record: CalibroMemoryClient.newest(await this.recallPairHistory(specialistId, domain)) };
  }

  /** Newest calibration checkpoint for every specialist in a domain. */
  async recallDomainCalibrations(domain: MarketDomain): Promise<{
    bySpecialist: Partial<Record<SpecialistId, SpecialistCalibrationRecord>>;
  }> {
    const { byKey } = await this.recallCalibrationLedger([domain]);
    const bySpecialist: Partial<Record<SpecialistId, SpecialistCalibrationRecord>> = {};
    for (const id of SpecialistIdSchema.options) {
      const rec = byKey.get(`${id}|${domain}`);
      if (rec) bySpecialist[id] = rec;
    }
    return { bySpecialist };
  }

  /** Semantic cosine search across historical episodic market theses & post-mortems. */
  async recallAnalogousMarkets(
    query: string,
    options: { limit?: number; maxDistance?: number } = {}
  ): Promise<{
    records: Array<{ blobId: string; distance: number; record: EpisodicPredictionRecord }>;
    rawRecall: RecallResult;
  }> {
    const rawRecall = await this.client.recall({
      query,
      namespace: CALIBRO_NAMESPACES.EPISODIC,
      limit: options.limit ?? 8,
      maxDistance: options.maxDistance ?? 0.75,
      sort: "relevance",
    });

    const records: Array<{
      blobId: string;
      distance: number;
      record: EpisodicPredictionRecord;
    }> = [];

    for (const hit of rawRecall.results) {
      const parsed = parseStructuredMemory<EpisodicPredictionRecord>(hit.text);
      if (parsed && parsed.kind === "episodic_v1") {
        records.push({
          blobId: hit.blob_id,
          distance: hit.distance,
          record: parsed,
        });
      }
    }

    return { records, rawRecall };
  }

  /**
   * Finds the open thesis and (if any) settled post-mortem for an exact `marketId`.
   * Uses semantic recall scoped by the market id plus optional context (title/domain)
   * and then filters on the parsed JSON, so a near-miss hit can never be mistaken
   * for the target market.
   */
  async findMarketEpisodes(
    marketId: string,
    contextQuery = ""
  ): Promise<{
    thesis: { blobId: string; record: EpisodicPredictionRecord } | null;
    settled: { blobId: string; record: EpisodicPredictionRecord } | null;
  }> {
    const rawRecall = await this.client.recall({
      query: `[Calibro Episodic] Ref=${marketRecallTag(marketId)} ${contextQuery} (${marketId})`.replace(/\s+/g, " "),
      namespace: CALIBRO_NAMESPACES.EPISODIC,
      limit: 20,
      sort: "relevance",
    });

    let thesis: { blobId: string; record: EpisodicPredictionRecord } | null = null;
    let settled: { blobId: string; record: EpisodicPredictionRecord } | null = null;
    for (const hit of rawRecall.results) {
      const parsed = parseStructuredMemory<EpisodicPredictionRecord>(hit.text);
      if (!parsed || parsed.kind !== "episodic_v1" || parsed.marketId !== marketId) {
        continue;
      }
      if (parsed.outcome === undefined) {
        thesis ??= { blobId: hit.blob_id, record: parsed };
      } else {
        settled ??= { blobId: hit.blob_id, record: parsed };
      }
    }
    return { thesis, settled };
  }

  /** Newest-first episodic records matching `query` (relayer `sort: "recent"`, capped at 100). */
  async recallRecentEpisodes(
    query: string,
    limit = CALIBRATION_RECALL_LIMIT
  ): Promise<Array<{ blobId: string; createdAt?: string; record: EpisodicPredictionRecord }>> {
    const res = await this.client.recall({
      query,
      namespace: CALIBRO_NAMESPACES.EPISODIC,
      limit: Math.min(limit, CALIBRATION_RECALL_LIMIT),
      sort: "recent",
    });
    const out: Array<{ blobId: string; createdAt?: string; record: EpisodicPredictionRecord }> = [];
    for (const hit of res.results) {
      const parsed = parseStructuredMemory<EpisodicPredictionRecord>(hit.text);
      if (parsed?.kind === "episodic_v1") {
        out.push({ blobId: hit.blob_id, createdAt: (hit as { created_at?: string }).created_at, record: parsed });
      }
    }
    return out;
  }

  private settledCache: SwrSlot<Array<{ blobId: string; record: EpisodicPredictionRecord }>> | null = null;

  /**
   * Every settled post-mortem, one recall per league (a single namespace-wide recall would
   * be cut off by the relayer's 100-hit window once theses + post-mortems pass 100).
   * One entry per market. Cached for 60 s; invalidated by any episodic write.
   */
  async recallSettledEpisodes(opts: { fresh?: boolean } = {}): Promise<Array<{ blobId: string; record: EpisodicPredictionRecord }>> {
    if (opts.fresh) {
      // Bypass the stale-while-revalidate slot: the shared read cache must never store a
      // pre-settlement copy under a post-settlement generation.
      const value = await this.loadSettledEpisodes();
      this.settledCache = { at: Date.now(), value: Promise.resolve(value), last: value, lastAt: Date.now() };
      return value;
    }
    return swrRead(this.settledCache, () => this.loadSettledEpisodes(), (slot) => (this.settledCache = slot));
  }

  private async loadSettledEpisodes(): Promise<Array<{ blobId: string; record: EpisodicPredictionRecord }>> {
    const perDomain = await Promise.all(
      MarketDomainSchema.options.map((d) => this.recallRecentEpisodes(`[Calibro Episodic SETTLED_OUTCOME] Domain=${d} Outcome RealizedBrier`))
    );
    const byMarket = new Map<string, { blobId: string; record: EpisodicPredictionRecord }>();
    for (const hit of perDomain.flat()) {
      if (hit.record.outcome !== undefined && !byMarket.has(hit.record.marketId)) byMarket.set(hit.record.marketId, hit);
    }
    return [...byMarket.values()].sort((a, b) => Date.parse(a.record.settledAt ?? a.record.createdAt) - Date.parse(b.record.settledAt ?? b.record.createdAt));
  }


  /**
   * Open theses with no settled post-mortem among the newest episodic records, i.e.
   * the markets the settlement cron still has to resolve.
   */
  async recallUnsettledTheses(): Promise<EpisodicPredictionRecord[]> {
    const [open, settled] = await Promise.all([
      this.recallRecentEpisodes("[Calibro Episodic OPEN_THESIS] Action Stake"),
      this.recallRecentEpisodes("[Calibro Episodic SETTLED_OUTCOME] Outcome RealizedBrier"),
    ]);
    const done = new Set(settled.filter((x) => x.record.outcome !== undefined).map((x) => x.record.marketId));
    const seen = new Set<string>();
    const out: EpisodicPredictionRecord[] = [];
    for (const { record } of open) {
      if (record.outcome !== undefined || done.has(record.marketId) || seen.has(record.marketId)) continue;
      seen.add(record.marketId);
      out.push(record);
    }
    return out;
  }

  /** Every calibration checkpoint (not just the newest per pair), for the learning timeline. */
  async recallCalibrationHistory(): Promise<Array<{ blobId: string; createdAt?: string; record: SpecialistCalibrationRecord }>> {
    return (await this.recallPairs(coveredPairs(MarketDomainSchema.options), (hits) => hits, 60)).flat();
  }

  // ---- calibro:picks ------------------------------------------------------

  async rememberPick(pick: PickRecord): Promise<RememberResult> {
    const status = pick.outcome === undefined ? "open" : "graded";
    const res = await this.client.rememberAndWait(formatPickMemoryText(pick), CALIBRO_NAMESPACES.PICKS, {
      idempotencyKey: `pick:${pick.owner}:${pick.marketId}:${status}`,
      dedupe: true,
      timeoutMs: 45_000,
    });
    this.recordMockAuditEntry(res);
    return res;
  }

  async rememberScorecard(card: ScorecardRecord): Promise<RememberResult> {
    const res = await this.client.rememberAndWait(formatScorecardMemoryText(card), CALIBRO_NAMESPACES.PICKS, {
      idempotencyKey: `scorecard:${card.owner}:epoch:${card.epoch}`,
      dedupe: true,
      timeoutMs: 45_000,
    });
    this.recordMockAuditEntry(res);
    return res;
  }

  private async recallPicksNs(query: string, sort: "recent" | "relevance", limit = CALIBRATION_RECALL_LIMIT) {
    const res = await this.client.recall({ query, namespace: CALIBRO_NAMESPACES.PICKS, limit, sort });
    return res.results.map((hit) => ({
      blobId: hit.blob_id,
      createdAt: (hit as { created_at?: string }).created_at,
      parsed: parseStructuredMemory<PickRecord | ScorecardRecord | PickPayoutRecord>(hit.text),
    }));
  }

  /** Every user's pick on one market (one per owner; graded record preferred). */
  async findMarketPicks(marketId: string): Promise<Array<{ blobId: string; record: PickRecord }>> {
    const hits = await this.recallPicksNs(`[Calibro Pick] Ref=${marketRecallTag(marketId)}`, "relevance", 50);
    const byOwner = new Map<string, { blobId: string; record: PickRecord }>();
    for (const h of hits) {
      const r = h.parsed;
      if (r?.kind !== "pick_v1" || r.marketId !== marketId) continue;
      const cur = byOwner.get(r.owner);
      if (!cur || (cur.record.outcome === undefined && r.outcome !== undefined)) byOwner.set(r.owner, { blobId: h.blobId, record: r });
    }
    return [...byOwner.values()];
  }

  /** Records that Calibro paid a picker (one write per payee per transaction). */
  async rememberPayout(p: PickPayoutRecord): Promise<RememberResult> {
    const res = await this.client.rememberAndWait(formatPayoutMemoryText(p), CALIBRO_NAMESPACES.PICKS, {
      idempotencyKey: `payout:${p.owner}:${p.txDigest}`,
      dedupe: true,
      timeoutMs: 45_000,
    });
    this.recordMockAuditEntry(res);
    return res;
  }

  async findUserPayouts(owner: string): Promise<Array<{ blobId: string; record: PickPayoutRecord }>> {
    const hits = await this.recallPicksNs(`[Calibro Payout] Owner=${ownerRecallTag(owner)}`, "relevance", 50);
    const seen = new Set<string>();
    const out: Array<{ blobId: string; record: PickPayoutRecord }> = [];
    for (const h of hits) {
      const r = h.parsed;
      if (r?.kind !== "payout_v1" || r.owner !== owner || seen.has(r.txDigest)) continue;
      seen.add(r.txDigest);
      out.push({ blobId: h.blobId, record: r });
    }
    return out.sort((a, b) => Date.parse(b.record.paidAt) - Date.parse(a.record.paidAt));
  }

  /** Newest payouts across all pickers (leaderboard earnings). */
  async recallPayouts(): Promise<PickPayoutRecord[]> {
    const hits = await this.recallPicksNs("[Calibro Payout] Owner Amount Tx", "recent");
    const seen = new Set<string>();
    const out: PickPayoutRecord[] = [];
    for (const h of hits) {
      const r = h.parsed;
      if (r?.kind !== "payout_v1") continue;
      const key = `${r.owner}|${r.txDigest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  /** One entry per market for this owner: the graded record when it exists, else the open pick. */
  async findUserPicks(owner: string): Promise<Array<{ blobId: string; record: PickRecord }>> {
    const hits = await this.recallPicksNs(`[Calibro Pick] Owner=${ownerRecallTag(owner)}`, "relevance");
    const byMarket = new Map<string, { blobId: string; record: PickRecord }>();
    for (const h of hits) {
      const r = h.parsed;
      if (r?.kind !== "pick_v1" || r.owner !== owner) continue;
      const cur = byMarket.get(r.marketId);
      if (!cur || (cur.record.outcome === undefined && r.outcome !== undefined)) byMarket.set(r.marketId, { blobId: h.blobId, record: r });
    }
    return [...byMarket.values()].sort((a, b) => Date.parse(b.record.pickedAt) - Date.parse(a.record.pickedAt));
  }

  /** Open picks (any user) without a graded record among the newest picks. */
  async recallPicksToGrade(): Promise<PickRecord[]> {
    const [open, graded] = await Promise.all([
      this.recallPicksNs("[Calibro Pick OPEN] Owner Pick Polymarket", "recent"),
      this.recallPicksNs("[Calibro Pick GRADED] Outcome Brier MarketBrier", "recent"),
    ]);
    const done = new Set(
      graded.flatMap((h) => (h.parsed?.kind === "pick_v1" && h.parsed.outcome !== undefined ? [`${h.parsed.owner}|${h.parsed.marketId}`] : []))
    );
    const seen = new Set<string>();
    const out: PickRecord[] = [];
    for (const h of open) {
      const r = h.parsed;
      if (r?.kind !== "pick_v1" || r.outcome !== undefined) continue;
      const key = `${r.owner}|${r.marketId}`;
      if (done.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    return out;
  }

  async recallScorecard(owner: string): Promise<ScorecardRecord | null> {
    return (await this.recallScorecardWithBlob(owner))?.record ?? null;
  }

  /** Newest scorecard for an owner, with the Walrus blob it was read from. */
  async recallScorecardWithBlob(owner: string): Promise<{ blobId: string; record: ScorecardRecord } | null> {
    const hits = await this.recallPicksNs(`[Calibro Scorecard] Owner=${ownerRecallTag(owner)}`, "relevance", 50);
    let best: { blobId: string; record: ScorecardRecord } | null = null;
    for (const h of hits) {
      const r = h.parsed;
      if (r?.kind === "scorecard_v1" && r.owner === owner && (!best || r.epoch > best.record.epoch)) best = { blobId: h.blobId, record: r };
    }
    return best;
  }

  /** Newest scorecard per owner (leaderboard). */
  async recallScorecards(): Promise<ScorecardRecord[]> {
    const hits = await this.recallPicksNs("[Calibro Scorecard] Owner Epoch Graded Brier", "recent");
    const best = new Map<string, ScorecardRecord>();
    for (const h of hits) {
      const r = h.parsed;
      if (r?.kind !== "scorecard_v1") continue;
      const cur = best.get(r.owner);
      if (!cur || r.epoch > cur.epoch) best.set(r.owner, r);
    }
    return [...best.values()];
  }

  /** Recalls newest active user bankroll & x402 spending mandate. */
  async recallLatestMandate(): Promise<BankrollMandateRecord | null> {
    const res = await this.client.recall({
      query: "Calibro Active Bankroll Mandate KellyMultiplier MaxSlateX402BudgetSui",
      namespace: CALIBRO_NAMESPACES.MANDATES,
      limit: 5,
      sort: "recent",
    });

    for (const hit of res.results) {
      const parsed = parseStructuredMemory<BankrollMandateRecord>(hit.text);
      if (parsed && parsed.kind === "mandate_v1") {
        return parsed;
      }
    }
    return null;
  }

  /**
   * Walks full Walrus Memory inventory (`listNamespaces` + `listMemories`) to prove
   * >= 10 real Mainnet memories for hackathon verification.
   */
  /** Memory counts per namespace: one listNamespaces() call, no inventory walk. */
  async namespaceCounts(): Promise<{ total: number; namespaces: Array<{ name: string; count: number }> }> {
    const page = await this.client.listNamespaces();
    const namespaces = page.namespaces.map((n) => ({ name: n.name, count: n.memory_count }));
    return { total: namespaces.reduce((a, n) => a + n.count, 0), namespaces };
  }

  async auditInventory(): Promise<{
    mode: CalibroMemoryMode;
    totalMemories: number;
    namespaces: NamespacesResult["namespaces"];
    memories: MemoriesResult["memories"];
  }> {
    const namespacesPage = await this.client.listNamespaces();

    if (this.client instanceof MemWal) {
      const allMemories: MemoriesResult["memories"] = [];
      let cursor: string | undefined;
      let more = true;
      while (more) {
        const page = await this.client.listMemories({ cursor });
        allMemories.push(...page.memories);
        cursor = page.next_cursor ?? undefined;
        more = page.has_more;
      }

      return {
        mode: this.mode,
        totalMemories: allMemories.length,
        namespaces: namespacesPage.namespaces,
        memories: allMemories,
      };
    }

    const nsSum = namespacesPage.namespaces.reduce(
      (acc, ns) => acc + ns.memory_count,
      0
    );
    return {
      mode: this.mode,
      totalMemories: Math.max(nsSum, this.mockAuditLog.length),
      namespaces: namespacesPage.namespaces,
      memories: [...this.mockAuditLog],
    };
  }

  private recordMockAuditEntry(res: RememberResult): void {
    if (this.mode !== "MOCK_SANDBOX") return;
    if (this.mockAuditLog.some((m) => m.blob_id === res.blob_id)) return;
    const now = new Date().toISOString();
    this.mockAuditLog.push({
      memory_id: res.id,
      namespace_id: res.namespace,
      blob_id: res.blob_id,
      created_at: now,
      updated_at: now,
      size: 0,
      agent_id: "calibro-mock",
      package_id: null,
      status: "stored",
      end_epoch: null,
      expires_at: null,
      importance: null,
    });
  }

  /** Re-indexes missing local relayer vectors directly from on-chain Walrus blobs. */
  async restoreNamespace(
    namespace: CalibroNamespace,
    limit = 20
  ): Promise<RestoreResult> {
    return this.client.restore(namespace, limit);
  }
}
