import { buildTimeline } from "@/lib/timeline/build";
import { errorResponse, getMemory, jsonResponse, requireLive } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Settlement-by-settlement replay of the settled post-mortems recalled from Walrus. */
export async function GET(): Promise<Response> {
  try {
    requireLive();
    return jsonResponse(200, buildTimeline(await getMemory().recallSettledEpisodes()));
  } catch (err) {
    return errorResponse(err);
  }
}
