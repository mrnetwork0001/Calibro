import { after } from "next/server";
import { findMarket } from "@/lib/markets/odds-feed";
import { handleSignalRequest } from "@/lib/x402/signal-gate";
import { getLedger, getMemory, getTatum, jsonResponse, lookupSignal, paymentConfig } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ specialistId: string }> }
): Promise<Response> {
  const { specialistId } = await params;
  const { ledger, error } = getLedger();
  if (!ledger) return jsonResponse(503, { error });
  const { treasury, coinType, amountRaw } = paymentConfig();
  return handleSignalRequest(request, specialistId, {
    treasury,
    coinType,
    amountRaw,
    ledger,
    verifier: getTatum(),
    loadSignal: lookupSignal,
    // TopPickers: once the split payment is verified, write each payout into the picker's
    // Walrus history — after the response, so the paying agent isn't kept waiting.
    onPaid: ({ signal, receipt }) => {
      if (!signal.payees?.length) return;
      after(async () => {
        const market = await findMarket(signal.marketId).catch(() => undefined);
        const memory = getMemory();
        for (const p of signal.payees!) {
          await memory
            .rememberPayout({
              kind: "payout_v1",
              owner: p.address,
              marketId: signal.marketId,
              title: market?.title ?? signal.marketId,
              amountRaw: p.amountRaw,
              coinType: receipt.coinType,
              txDigest: receipt.txDigest,
              payer: receipt.payer,
              paidAt: new Date().toISOString(),
            })
            .catch((err) => console.error("[payout] could not record payout:", (err as Error).message));
        }
      });
    },
  });
}
