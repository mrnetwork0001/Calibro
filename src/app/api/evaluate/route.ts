import type { TapeEvent } from "@/lib/x402/http-signal-provider";
import {
  buildColdStartEngine,
  buildEngine,
  checkAdmin,
  errorResponse,
  findMarket,
  jsonResponse,
  requireLive,
  resolveMode,
} from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Fluid compute allows up to 300 s on Hobby

/**
 * POST { marketId, compare?: boolean }
 * Full loop: recall → x402 VoI gate → (Sui payment + Tatum verification) → consensus → Kelly.
 * With `compare`, also returns the zero-memory Cold-Start counterfactual for the same market.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = checkAdmin(request);
  if (denied) return jsonResponse(403, { error: denied });

  let body: { marketId?: string; compare?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: "Body must be JSON: { marketId }" });
  }
  if (!body.marketId) return jsonResponse(400, { error: "`marketId` is required." });

  try {
    requireLive();
    const market = await findMarket(body.marketId);
    if (!market) return jsonResponse(404, { error: `Unknown market ${body.marketId}` });

    const tape: TapeEvent[] = [];
    const origin = new URL(request.url).origin;
    const evaluation = await buildEngine(origin, tape).evaluateMarket(market);

    for (const g of evaluation.gates) {
      if (g.decision === "VETO_PAYMENT") {
        tape.push({
          at: new Date().toISOString(),
          kind: "VETOED",
          specialistId: g.specialistId,
          marketId: market.marketId,
          mode: "LIVE_MAINNET",
          amountRaw: g.fee.amountRaw,
          coinType: g.fee.coinType,
          feeUsd: g.fee.feeUsd,
          detail: g.reason,
        });
      }
    }

    const coldStart = body.compare
      ? await buildColdStartEngine()
          .evaluateMarket(market, { persistThesis: false })
          .catch(() => null)
      : null;

    return jsonResponse(200, { mode: resolveMode(), evaluation, tape, coldStart });
  } catch (err) {
    return errorResponse(err);
  }
}
