/**
 * An outside agent buying Calibro's calibrated forecast over HTTP 402 on Sui Mainnet.
 *
 *   BUYER_SUI_PRIVATE_KEY=suiprivkey1… TATUM_API_KEY=… npx tsx scripts/buy-forecast.ts --server https://<host> [--market poly-nba-…]
 *
 * Flags: --server <url> (default http://localhost:3004) · --market <id> (default: first upcoming
 * NBA market) · --max-sui 0.02 (refuse pricier challenges) · --key-env NAME (env var holding the
 * buyer's key; default BUYER_SUI_PRIVATE_KEY). The buyer must be a different address from the
 * forecast's payTo, or the self-transfer nets to zero and fails verification.
 */
import { encodeX402PaymentProof, parseX402ChallengeHeaders } from "../src/lib/x402/protocol";
import { SuiX402Payer } from "../src/lib/x402/sui-payer";
import { flagValue, loadDotEnv } from "./lib/env";

async function main() {
  loadDotEnv();
  const server = (flagValue("--server") ?? "http://localhost:3004").replace(/\/$/, "");
  const keyEnv = flagValue("--key-env") ?? "BUYER_SUI_PRIVATE_KEY";
  const key = process.env[keyEnv]?.trim();
  if (!key) throw new Error(`Set ${keyEnv} to the buyer's suiprivkey (a wallet holding a little SUI).`);
  const maxRaw = BigInt(Math.round(Number(flagValue("--max-sui") ?? "0.02") * 1e9));
  const payer = new SuiX402Payer({ privateKey: key, maxAmountRaw: maxRaw });

  console.log(`=== outside agent ${payer.address} buying a Calibro forecast from ${server} ===\n`);
  const catalog = (await fetch(`${server}/.well-known/x402`).then((r) => r.json())) as {
    products: Array<{ id: string; price: { amount: string }; payTo: string }>;
  };
  const product = catalog.products.find((p) => p.id === "calibro-forecast");
  console.log(`catalog: calibro-forecast at ${product?.price.amount} → ${product?.payTo}`);

  let marketId = flagValue("--market");
  if (!marketId) {
    const feed = (await fetch(`${server}/api/markets`).then((r) => r.json())) as { markets: Array<{ marketId: string; source: string; domain: string; title: string }> };
    const m = feed.markets.find((x) => x.source === "LIVE" && x.domain === "NBA") ?? feed.markets.find((x) => x.source === "LIVE");
    if (!m) throw new Error("No upcoming market available.");
    marketId = m.marketId;
    console.log(`market:  ${m.title} (${marketId})`);
  }
  const url = `${server}/api/forecast?marketId=${encodeURIComponent(marketId)}`;

  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`Expected 402, got ${first.status}: ${(await first.text()).slice(0, 300)}`);
  const challenge = parseX402ChallengeHeaders(first.headers);
  if (!challenge) throw new Error("402 without a parseable challenge.");
  console.log(`402:     pay ${Number(challenge.amountRaw) / 1e9} SUI to ${challenge.recipient} (challenge ${challenge.challengeId.slice(0, 18)}…)`);

  const receipt = await payer.pay(challenge);
  console.log(`paid:    tx ${receipt.txDigest}  https://suiscan.xyz/mainnet/tx/${receipt.txDigest}`);
  const headers = encodeX402PaymentProof({
    challengeId: challenge.challengeId,
    txDigest: receipt.txDigest,
    payer: receipt.payer,
    network: "sui:mainnet",
    mode: "LIVE_MAINNET",
  });

  let res: Response | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, { headers });
    if (res.ok) break;
    const text = await res.text();
    const transient = res.status === 502 || res.status === 503 || /not found/i.test(text);
    console.log(`retry:   ${res.status} ${text.slice(0, 160)}`);
    if (!transient) throw new Error("Paid request rejected.");
    await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
  }
  if (!res?.ok) throw new Error("Could not redeem the payment.");
  const body = (await res.json()) as {
    forecast: {
      title: string;
      yesLabel: string | null;
      probability: number;
      naiveProbability: number;
      polymarket: number;
      recommendation: { action: string; side?: string; venue?: string; netEdge?: number };
      sources: Array<{ specialistId: string; weight: number }>;
      vetoed: Array<{ specialistId: string; reason: string }>;
      thesisBlobId: string | null;
      freshness: string;
    };
    receipt: { txDigest: string; checkpoint?: string };
  };
  const f = body.forecast;
  console.log(`\n200:     verified via Tatum (checkpoint ${body.receipt.checkpoint ?? "?"})`);
  console.log(`         ${f.title}: P(${f.yesLabel ?? "YES"}) = ${(f.probability * 100).toFixed(1)}%  (naive ${(f.naiveProbability * 100).toFixed(1)}%, Polymarket ${(f.polymarket * 100).toFixed(1)}%)`);
  console.log(`         ${f.recommendation.action}${f.recommendation.side ? ` ${f.recommendation.side} @ ${f.recommendation.venue}` : ""}`);
  console.log(`         paid sources: ${f.sources.map((s) => `${s.specialistId} ${(s.weight * 100).toFixed(0)}%`).join(", ")}`);
  for (const v of f.vetoed) console.log(`         vetoed ${v.specialistId}: ${v.reason}`);
  console.log(`         thesis on Walrus: ${f.thesisBlobId ?? "—"} (${f.freshness})`);
}

main().catch((err) => {
  console.error("Buyer failed:", err.message ?? err);
  process.exit(1);
});
