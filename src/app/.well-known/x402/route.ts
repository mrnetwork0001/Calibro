import { SPECIALIST_PROFILES } from "@/lib/specialists/models";
import { SpecialistIdSchema } from "@/lib/types/calibro";
import { forecastPaymentConfig, jsonResponse, paymentConfig } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Machine-readable catalog of everything Calibro sells over HTTP 402, for agent discovery. */
export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  const signal = paymentConfig();
  const forecast = forecastPaymentConfig();
  const price = (coinType: string, amountRaw: string) => ({
    coinType,
    amountRaw,
    amount: coinType.endsWith("::sui::SUI") ? `${Number(amountRaw) / 1e9} SUI` : amountRaw,
  });
  return jsonResponse(200, {
    name: "Calibro",
    description:
      "Calibrated sports and prediction-market forecasts. Calibro buys specialist signals, scores every source against real Polymarket results, keeps the track record on Walrus Memory, and sells its own de-biased forecast.",
    network: "sui:mainnet",
    protocols: {
      x402: { version: 1, challengeHeader: "X-Payment-Required", paymentHeader: "X-Payment", responseHeader: "X-Payment-Response" },
      mpp: { protocol: "mpp-sui-v1", challengeHeader: "WWW-Authenticate: Payment", paymentHeader: "Authorization: Payment" },
    },
    howToPay: [
      "GET the product URL without payment headers → HTTP 402 with the challenge (recipient, coinType, amount, challengeId).",
      "Send `amount` of `coinType` to `recipient` on Sui Mainnet in one transaction, from your own address.",
      "Retry the same URL with `X-Payment: base64(JSON{ challengeId, txDigest, payer, network: \"sui:mainnet\", mode: \"LIVE_MAINNET\" })` (or `Authorization: Payment <same>`).",
      "The server verifies the digest through Tatum's Sui Mainnet gateway (success, recipient credited, sender = payer, after the challenge, never redeemed) and returns the product with an HMAC signature.",
    ],
    verification: "Tatum Sui Mainnet GraphQL gateway (transaction(digest): effects.status, balanceChanges, sender, timestamp)",
    markets: `${origin}/api/markets`,
    products: [
      {
        id: "calibro-forecast",
        method: "GET",
        url: `${origin}/api/forecast?marketId={marketId}`,
        description: "Calibro's calibrated P(YES) for an upcoming market, with the sources it paid for, their weights, the sources it vetoed and why, a recommended leg, and the Walrus blob of its sealed thesis.",
        price: price(forecast.coinType, forecast.amountRaw),
        payTo: forecast.recipient,
        coverage: "NBA · EPL · UFC · crypto (upcoming markets)",
      },
      ...SpecialistIdSchema.options.map((id) => ({
        id,
        method: "GET",
        url: `${origin}/api/signals/${id}?marketId={marketId}`,
        description: `${SPECIALIST_PROFILES[id].name}: ${SPECIALIST_PROFILES[id].thesis}. Data: ${SPECIALIST_PROFILES[id].dataSource}.`,
        price: price(signal.coinType, signal.amountRaw),
        payTo: id === "top-pickers" ? "split among qualified human pickers (challenge `splits`: pay every share in one transaction)" : signal.treasury,
        coverage: SPECIALIST_PROFILES[id].coverage,
        noData: "404 with code NO_SIGNAL before any challenge: never charged when the source has nothing for the market.",
      })),
    ],
    trackRecord: `${origin}/api/leaderboard`,
    docs: `${origin}/llms.txt`,
  });
}
