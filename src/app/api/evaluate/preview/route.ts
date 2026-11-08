import { rateLimit } from "@/lib/server/rate-limit";
import { buildTimeline } from "@/lib/timeline/build";
import { recordView, settledGames } from "@/lib/server/read-models";
import { buildColdStartEngine, buildPreviewEngine, errorResponse, findMarket, jsonResponse, requireLive, resolveMode } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Fluid compute allows up to 300 s on Hobby

/**
 * POST { marketId } — public preview on a RESOLVED game: Calibro's real record from Walrus
 * decides over the same signals, computed in-process. Nothing is paid and nothing is
 * written. If Calibro already evaluated the game on Mainnet, the recorded decision (paid
 * digests, refusals, post-mortem blob) comes back alongside, read from Walrus.
 *
 * Upcoming games are refused here: their forecast is a paid product (GET /api/forecast),
 * and live evaluations spend real SUI, so they stay with the operator.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { marketId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: "Body must be JSON: { marketId }" });
  }
  if (!body.marketId) return jsonResponse(400, { error: "`marketId` is required." });

  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  const limit = await rateLimit(`preview:${ip}`, 20, 3600).catch(() => ({ ok: true, remaining: 0 }));
  if (!limit.ok) return jsonResponse(429, { error: "Preview limit reached (20 per hour). Try again later." });

  try {
    requireLive();
    const market = await findMarket(body.marketId);
    if (!market) return jsonResponse(404, { error: `Unknown market ${body.marketId}` });
    if (market.source !== "HISTORICAL") {
      return jsonResponse(409, {
        code: "LIVE_MARKET",
        error: "Previews run on resolved games. Upcoming games are evaluated with real payments by the operator, or bought over x402 at /api/forecast.",
      });
    }

    const settled = await settledGames().catch(() => null);
    const ledger = settled ? buildTimeline(settled.value).ledger : null;
    const [evaluation, coldStart] = await Promise.all([
      buildPreviewEngine(ledger).evaluateMarket(market, { persistThesis: false }),
      buildColdStartEngine()
        .evaluateMarket(market, { persistThesis: false })
        .catch(() => null),
    ]);
    const recorded = settled ? (recordView(settled.value).games.find((g) => g.marketId === market.marketId) ?? null) : null;

    return jsonResponse(200, { mode: resolveMode(), preview: true, evaluation, tape: [], coldStart, recorded });
  } catch (err) {
    return errorResponse(err);
  }
}
