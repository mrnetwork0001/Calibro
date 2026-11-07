import { buildTimeline } from "@/lib/timeline/build";
import { cacheInfo, settledGames } from "@/lib/server/read-models";
import { errorResponse, jsonResponse } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Settlement-by-settlement replay of the settled post-mortems recalled from Walrus. */
export async function GET(): Promise<Response> {
  try {
    const settled = await settledGames();
    return jsonResponse(200, { ...buildTimeline(settled.value), cache: cacheInfo(settled) });
  } catch (err) {
    return errorResponse(err);
  }
}
