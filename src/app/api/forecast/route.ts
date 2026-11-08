import { getForecast } from "@/lib/forecast/service";
import { signServerPayload } from "@/lib/x402/protocol";
import { json, paymentResponseHeader, requirePayment } from "@/lib/x402/paywall";
import { buildEngine, errorResponse, findMarket, forecastPaymentConfig, getLedger, getMemory, getTatum, requireLive } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Fluid compute allows up to 300 s on Hobby

/**
 * GET /api/forecast?marketId=…  — Calibro's calibrated forecast, sold over HTTP 402
 * (x402 + MPP on Sui Mainnet) to any agent. Upcoming markets only.
 */
export async function GET(request: Request): Promise<Response> {
  const marketId = new URL(request.url).searchParams.get("marketId");
  if (!marketId) return json(400, { error: "Query parameter `marketId` is required (see /api/markets)." });
  try {
    requireLive();
    const market = await findMarket(marketId);
    if (!market) return json(404, { error: `Unknown or unpriceable market "${marketId}".` });
    if (market.source !== "LIVE") return json(409, { error: "Forecasts are sold for upcoming markets only; this one has started or resolved." });

    const { ledger, error } = getLedger();
    if (!ledger) return json(503, { error });
    const { recipient, coinType, amountRaw } = forecastPaymentConfig();
    const paywall = await requirePayment(request, {
      product: "calibro-forecast",
      marketId,
      resource: `/api/forecast?marketId=${encodeURIComponent(marketId)}`,
      recipient,
      coinType,
      amountRaw,
      ledger,
      verifier: getTatum(),
    });
    if (!paywall.paid) return paywall.response;

    try {
      const origin = new URL(request.url).origin;
      const forecast = await getForecast(getMemory(), () => buildEngine(origin, []), market);
      const receipt = paywall.receipt;
      return json(200, { forecast, receipt, signature: signServerPayload({ forecast, receipt }) }, paymentResponseHeader(receipt));
    } catch (err) {
      // The buyer paid but got nothing: free the digest so the same receipt can be retried.
      await ledger.release(`sui:${paywall.receipt.txDigest}`);
      return json(503, { error: `Forecast unavailable, payment not consumed (retry with the same receipt): ${(err as Error).message}` });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
