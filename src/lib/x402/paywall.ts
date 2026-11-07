/**
 * Generic HTTP 402 paywall (x402 + MPP on Sui Mainnet) for any Calibro product.
 *
 *  unpaid → 402 + WWW-Authenticate: Payment + X-Payment-Required
 *  paid   → HMAC challenge ✓, bound to product + market ✓, not expired ✓, digest unredeemed ✓,
 *           Tatum Sui GraphQL: success ✓, recipient credited ≥ amount ✓, sender = payer ✓,
 *           landed after the challenge ✓  → { paid: true, receipt }
 * Only real Sui Mainnet receipts are accepted.
 */
import type { SuiPaymentVerificationResult } from "../tatum/sui-rpc";
import type { X402Product } from "../types/calibro";
import { createX402Challenge, decodeX402Challenge, parseX402PaymentHeader } from "./protocol";
import type { ReplayLedger } from "./replay-ledger";

/** Redemption window after challenge expiry, for a tx that landed just before it. */
const REDEEM_GRACE_MS = 5 * 60_000;
/** Allowed clock skew between this server and Sui checkpoint timestamps. */
const CLOCK_SKEW_MS = 60_000;

export interface PaymentVerifier {
  verifyX402PaymentOnSui(params: {
    txDigest: string;
    expectedRecipient: string;
    expectedCoinType: string;
    minAmountRaw: bigint;
    expectedSender?: string;
    notBeforeMs?: number;
    additionalCredits?: Array<{ recipient: string; minAmountRaw: bigint }>;
  }): Promise<SuiPaymentVerificationResult>;
}

export interface PaywallConfig {
  product: X402Product;
  marketId: string;
  resource: string;
  recipient: string | null;
  coinType: string;
  amountRaw: string;
  ledger: ReplayLedger;
  verifier: PaymentVerifier;
  now?: Date;
  /**
   * Pay several people in one transaction (shares sum to amountRaw). The shares are fixed
   * when the challenge is issued and HMAC-signed into it; verification checks them all.
   */
  splits?: Array<{ recipient: string; amountRaw: string }>;
}

export interface PaidReceipt {
  receiptMode: "LIVE_MAINNET";
  challengeId: string;
  payer: string;
  txDigest: string;
  checkpoint?: string;
  verifiedVia: "tatum-sui-mainnet-rpc";
  amountRaw: string;
  coinType: string;
  /** Split shares that were verified as paid */
  splits?: Array<{ recipient: string; amountRaw: string }>;
}

export type PaywallResult = { paid: false; response: Response } | { paid: true; receipt: PaidReceipt };

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export function paymentResponseHeader(receipt: PaidReceipt): Record<string, string> {
  return {
    "X-Payment-Response": Buffer.from(
      JSON.stringify({ success: true, network: "sui:mainnet", transaction: receipt.txDigest, payer: receipt.payer, mode: receipt.receiptMode })
    ).toString("base64"),
  };
}

export async function requirePayment(request: Request, cfg: PaywallConfig): Promise<PaywallResult> {
  const now = cfg.now ?? new Date();
  const recipient = cfg.splits?.length ? cfg.splits[0].recipient : cfg.recipient;
  if (!recipient) {
    return { paid: false, response: json(503, { error: "No payment recipient configured; cannot issue a payable challenge." }) };
  }
  const challenge402 = (error?: string): PaywallResult => {
    const { headers, body } = createX402Challenge({
      specialistId: cfg.product,
      marketId: cfg.marketId,
      recipient,
      coinType: cfg.coinType,
      amountRaw: cfg.amountRaw,
      resource: cfg.resource,
      now,
      splits: cfg.splits,
    });
    return { paid: false, response: json(402, error ? { ...body, error } : body, headers) };
  };

  const proof = parseX402PaymentHeader(request.headers);
  if (!proof) return challenge402();

  const challenge = decodeX402Challenge(proof.challengeId);
  if (!challenge) return challenge402("Invalid or tampered challengeId.");
  if (challenge.specialistId !== cfg.product || challenge.marketId !== cfg.marketId) {
    return challenge402("Challenge was issued for a different product or market.");
  }
  // Split challenges pay whoever contributed when the challenge was issued (signed into it);
  // single-recipient challenges must still match this server's configuration.
  const termsOk = challenge.splits?.length
    ? challenge.coinType === cfg.coinType && challenge.splits[0].recipient === challenge.recipient
    : challenge.recipient === recipient && challenge.coinType === cfg.coinType;
  if (!termsOk) return challenge402("Challenge terms no longer match this server's payment configuration.");
  if (now.getTime() > Date.parse(challenge.expiresAt) + REDEEM_GRACE_MS) return challenge402("Challenge expired.");
  if (proof.mode !== "LIVE_MAINNET") return challenge402("Only Sui Mainnet receipts are accepted.");

  const key = `sui:${proof.txDigest}`;
  let reserved: boolean;
  try {
    reserved = await cfg.ledger.reserve(key);
  } catch (err) {
    return { paid: false, response: json(503, { error: `Replay ledger unavailable: ${(err as Error).message}` }) };
  }
  if (!reserved) return challenge402("Sui txDigest already redeemed (replay rejected).");

  let result: SuiPaymentVerificationResult;
  try {
    result = await cfg.verifier.verifyX402PaymentOnSui({
      txDigest: proof.txDigest,
      expectedRecipient: challenge.recipient,
      expectedCoinType: challenge.coinType,
      minAmountRaw: BigInt(challenge.amountRaw),
      expectedSender: proof.payer,
      notBeforeMs: Date.parse(challenge.issuedAt) - CLOCK_SKEW_MS,
      ...(challenge.splits?.length
        ? {
            minAmountRaw: BigInt(challenge.splits[0].amountRaw),
            additionalCredits: challenge.splits.slice(1).map((s) => ({ recipient: s.recipient, minAmountRaw: BigInt(s.amountRaw) })),
          }
        : {}),
    });
  } catch (err) {
    await cfg.ledger.release(key);
    return { paid: false, response: json(502, { error: `Could not verify payment via Tatum Sui RPC: ${(err as Error).message}` }) };
  }
  if (!result.verified) {
    await cfg.ledger.release(key);
    return challenge402(`Payment not verified: ${result.reason}`);
  }
  await cfg.ledger.commit(key, {
    product: cfg.product,
    marketId: cfg.marketId,
    challengeId: challenge.challengeId,
    payer: proof.payer,
    checkpoint: result.checkpoint,
    credited: result.recipientCreditedRaw.toString(),
  });
  return {
    paid: true,
    receipt: {
      receiptMode: "LIVE_MAINNET",
      challengeId: challenge.challengeId,
      payer: proof.payer,
      txDigest: proof.txDigest,
      checkpoint: result.checkpoint,
      verifiedVia: "tatum-sui-mainnet-rpc",
      amountRaw: challenge.amountRaw,
      coinType: challenge.coinType,
      ...(challenge.splits?.length ? { splits: challenge.splits } : {}),
    },
  };
}
