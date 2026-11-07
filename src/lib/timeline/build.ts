/**
 * Learning timeline: replays the settled post-mortems on Walrus settlement by settlement,
 * so the UI can show trust weights shifting and vetoes switching on, each change linked
 * to the Walrus record that caused it. Status and weights come from the same functions
 * the engine uses (shouldPayX402Gate, trustWeight).
 */
import { createColdStartCalibration, shouldPayX402Gate, trustWeight, updateCalibrationOnline } from "../calibration/brier";
import { DEFAULT_MANDATE, SPECIALIST_IDS } from "../orchestrator/syndicate-engine";
import type { EpisodicPredictionRecord, MarketDomain, SpecialistCalibrationRecord, SpecialistId } from "../types/calibro";

export type TrustStatus = "EXPLORING" | "TRUSTED" | "VETOED";

export interface TimelineSource {
  specialistId: SpecialistId;
  brier: number;
  samples: number;
  status: TrustStatus;
  /** Normalised among the sources Calibro would pay in this league */
  weight: number;
}

export interface TimelineStep {
  index: number;
  marketId: string;
  title: string;
  domain: MarketDomain;
  outcome: 0 | 1 | null;
  calibroProb: number | null;
  marketProb: number | null;
  settledAt: string;
  postMortemBlobId?: string;
  changes: Array<{
    specialistId: SpecialistId;
    kind: "SAMPLE" | "VETO_TALLY";
    prevBrier: number;
    nextBrier: number;
    samples: number;
    blobId: string;
  }>;
  flips: Array<{ specialistId: SpecialistId; from: TrustStatus; to: TrustStatus }>;
  /** State of the league this market belongs to, after the step */
  league: TimelineSource[];
}

export interface Timeline {
  steps: TimelineStep[];
  domains: MarketDomain[];
  /** Final state per league */
  final: Partial<Record<MarketDomain, TimelineSource[]>>;
  /** The replayed calibration ledger: newest record per (source, league), identical to the stored checkpoints */
  ledger: SpecialistCalibrationRecord[];
  checkpoints: number;
}

/** Nominal fee for the status replay: 0.002 SUI at ≈ $1 (status only depends on it when VoI ≤ fee). */
const NOMINAL_FEE_USD = 0.002;

export function statusOf(c: SpecialistCalibrationRecord): TrustStatus {
  if (c.sampleSize < 4) return "EXPLORING";
  return shouldPayX402Gate({ calibration: c, mandate: DEFAULT_MANDATE, feeUsd: NOMINAL_FEE_USD }).decision === "VETO_PAYMENT"
    ? "VETOED"
    : "TRUSTED";
}

function leagueState(domain: MarketDomain, state: Map<string, SpecialistCalibrationRecord>): TimelineSource[] {
  const rows = SPECIALIST_IDS.flatMap((id) => {
    const c = state.get(`${id}|${domain}`);
    return c ? [{ c, status: statusOf(c) }] : [];
  });
  const paid = rows.filter((r) => r.status !== "VETOED");
  const total = paid.reduce((a, r) => a + trustWeight(r.c), 0);
  return rows.map(({ c, status }) => ({
    specialistId: c.specialistId,
    brier: c.brierScore,
    samples: c.sampleSize,
    status,
    weight: status === "VETOED" || total === 0 ? 0 : Number((trustWeight(c) / total).toFixed(4)),
  }));
}

/**
 * Replays settled post-mortems in settlement order through the engine's own update
 * (updateCalibrationOnline for each bought signal, a veto tally for each vetoed source).
 * Deterministic: it reproduces the calibration checkpoints the engine wrote, and each
 * step links to the post-mortem blob that caused it.
 */
export function buildTimeline(settled: Array<{ blobId: string; record: EpisodicPredictionRecord }>): Timeline {
  const ordered = settled
    .filter((s) => s.record.outcome !== undefined)
    .sort(
      (a, b) =>
        Date.parse(a.record.settledAt ?? a.record.createdAt) - Date.parse(b.record.settledAt ?? b.record.createdAt) ||
        a.record.marketId.localeCompare(b.record.marketId)
    );
  const state = new Map<string, SpecialistCalibrationRecord>();
  const steps: TimelineStep[] = [];
  let checkpoints = 0;
  for (const { blobId, record: r } of ordered) {
    const outcome = r.outcome!;
    const domain = r.domain;
    const before = leagueState(domain, state);
    const changes: TimelineStep["changes"] = [];
    const used = new Map(r.signalsUsed.map((u) => [u.specialistId, u]));
    const vetoed = new Set(r.signalsVetoed.map((v) => v.specialistId));
    for (const id of SPECIALIST_IDS) {
      const signal = used.get(id);
      if (!signal && !vetoed.has(id)) continue;
      const key = `${id}|${domain}`;
      const prev = state.get(key) ?? createColdStartCalibration(id, domain);
      const next: SpecialistCalibrationRecord = signal
        ? { ...updateCalibrationOnline(prev, signal.rawProbability, outcome), x402PaidCount: prev.x402PaidCount + 1, lastSettledMarketId: r.marketId }
        : { ...prev, epoch: prev.epoch + 1, x402VetoedCount: prev.x402VetoedCount + 1, lastSettledMarketId: r.marketId };
      changes.push({
        specialistId: id,
        kind: signal ? "SAMPLE" : "VETO_TALLY",
        prevBrier: prev.sampleSize === 0 ? next.brierScore : prev.brierScore,
        nextBrier: next.brierScore,
        samples: next.sampleSize,
        blobId,
      });
      state.set(key, next);
      checkpoints++;
    }
    const league = leagueState(domain, state);
    const flips = league.flatMap((after) => {
      const was = before.find((b) => b.specialistId === after.specialistId)?.status ?? "EXPLORING";
      return was !== after.status ? [{ specialistId: after.specialistId, from: was, to: after.status }] : [];
    });
    steps.push({
      index: steps.length + 1,
      marketId: r.marketId,
      title: r.title,
      domain,
      outcome,
      calibroProb: r.calibroCalibratedProb,
      marketProb: r.onchainImpliedProb,
      settledAt: r.settledAt ?? r.createdAt,
      postMortemBlobId: blobId,
      changes,
      flips,
      league,
    });
  }

  const domains = [...new Set(steps.map((s) => s.domain))];
  const final: Timeline["final"] = {};
  for (const d of domains) final[d] = leagueState(d, state);
  return { steps, domains, final, ledger: [...state.values()], checkpoints };
}
