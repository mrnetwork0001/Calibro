import { after } from "next/server";
import { settleFromPolymarket } from "@/lib/markets/settlement";
import { invalidateReadModels } from "@/lib/server/read-cache";
import { warmReadModels } from "@/lib/server/read-models";
import { buildEngine, checkAdmin, errorResponse, jsonResponse, requireLive, resolveMode } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Fluid compute allows up to 300 s on Hobby

/**
 * POST { marketId }
 * Settles a market against Polymarket's resolution: recalls the sealed thesis from
 * calibro:episodic, updates Brier + Platt per specialist, and writes calibration
 * checkpoints + the post-mortem to Walrus Memory. 409 if the market hasn't resolved.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = checkAdmin(request);
  if (denied) return jsonResponse(403, { error: denied });

  let body: { marketId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: "Body must be JSON: { marketId }" });
  }
  if (!body.marketId) return jsonResponse(400, { error: "`marketId` is required." });

  try {
    requireLive();
    const attempt = await settleFromPolymarket(buildEngine(new URL(request.url).origin, []), body.marketId);
    switch (attempt.status) {
      case "UNKNOWN_MARKET":
        return jsonResponse(404, { error: attempt.detail });
      case "NOT_RESOLVED":
      case "VOID":
        return jsonResponse(409, { error: `${attempt.marketId}: ${attempt.detail}`, code: attempt.status });
      default:
        if (attempt.status === "SETTLED") {
          // The settled games changed: invalidate every cached view, then refill the shared
          // copy behind the response so the terminal's next read is fast and current.
          await invalidateReadModels();
          after(() => warmReadModels(["settled-games", "namespace-counts", "inventory"]).then(() => undefined));
        }
        return jsonResponse(200, { mode: resolveMode(), result: attempt.result });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
