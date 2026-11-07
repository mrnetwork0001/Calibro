import { warmReadModels } from "@/lib/server/read-models";
import { cronAuthorized, errorResponse, jsonResponse } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Reloads the read models (settled games, inventory, counts, pick scorecards) from Walrus
 * into the shared cache, so visitors never wait on a cold recall. Called every 30 minutes
 * by .github/workflows/settle.yml right after /api/cron/settle.
 */
export async function GET(request: Request): Promise<Response> {
  if (!cronAuthorized(request)) return jsonResponse(401, { error: "Unauthorized" });
  try {
    const started = Date.now();
    const results = await warmReadModels();
    return jsonResponse(200, { results, ms: Date.now() - started, ranAt: new Date().toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
}
