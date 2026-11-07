import { buildTimeline } from "@/lib/timeline/build";
import { CALIBRO_NAMESPACES, type EpisodicPredictionRecord } from "@/lib/types/calibro";
import { errorResponse, getMemory, jsonResponse, resolveMode } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Latest calibration per (source, league) + reliability-diagram points, both from the
 * settled post-mortems in calibro:episodic (one recall per league). Replaying the
 * post-mortems reproduces the stored calibration checkpoints exactly (see timeline tests),
 * so the per-pair checkpoint recalls aren't needed here.
 */
export async function GET(): Promise<Response> {
  try {
    const memory = getMemory();
    const settledHits = await memory.recallSettledEpisodes();
    const calibrations = buildTimeline(settledHits).ledger;
    const settled: EpisodicPredictionRecord[] = settledHits.map((s) => s.record);

    // Each purchased signal on a settled market is one (predicted, observed) point.
    const points = settled.flatMap((r) => [
      ...r.signalsUsed.map((s) => ({ source: s.specialistId, domain: r.domain, p: s.rawProbability, y: r.outcome! })),
      { source: "calibro", domain: r.domain, p: r.calibroCalibratedProb, y: r.outcome! },
    ]);

    return jsonResponse(200, {
      mode: resolveMode(),
      namespace: CALIBRO_NAMESPACES.CALIBRATION,
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
    });
  } catch (err) {
    return errorResponse(err);
  }
}
