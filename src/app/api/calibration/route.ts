import { CALIBRO_NAMESPACES } from "@/lib/types/calibro";
import { cacheInfo, calibrationView, settledGames } from "@/lib/server/read-models";
import { errorResponse, jsonResponse, resolveMode } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Latest calibration per (source, league) + reliability-diagram points, both from the
 * settled post-mortems in calibro:episodic. Replaying the post-mortems reproduces the
 * stored calibration checkpoints exactly (see timeline tests), so the per-pair checkpoint
 * recalls aren't needed here. Served through the shared read cache.
 */
export async function GET(): Promise<Response> {
  try {
    const settled = await settledGames();
    return jsonResponse(200, {
      mode: resolveMode(),
      namespace: CALIBRO_NAMESPACES.CALIBRATION,
      ...calibrationView(settled.value),
      cache: cacheInfo(settled),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
