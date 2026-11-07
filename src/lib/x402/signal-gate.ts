/**
 * Server side of the specialist paywall: `GET /api/signals/[specialistId]?marketId=...`
 *
 *  no data   → 404 before any challenge: a vendor without data for a market is never charged
 *  unpaid    → 402 + WWW-Authenticate: Payment (MPP) + X-Payment-Required (x402)
 *  paid      → verified by the shared paywall (src/lib/x402/paywall.ts) → 200 + signed signal
 * Only real Sui Mainnet receipts are accepted.
 */
import { SpecialistIdSchema, type SpecialistId, type SpecialistSignal } from "../types/calibro";
import { json, paymentResponseHeader, requirePayment, type PaidReceipt, type PaymentVerifier } from "./paywall";
import { signServerPayload } from "./protocol";
import type { ReplayLedger } from "./replay-ledger";

export type SignalLookup =
  | { status: "OK"; signal: SpecialistSignal; splits?: Array<{ recipient: string; amountRaw: string }> }
  | { status: "UNKNOWN_MARKET" }
  | { status: "NO_DATA"; reason: string };

export interface SignalGateDeps {
  treasury: string | null;
  coinType: string;
  amountRaw: string;
  ledger: ReplayLedger;
  verifier: PaymentVerifier;
  /** Computes the specialist's signal from point-in-time market data. */
  loadSignal(specialistId: SpecialistId, marketId: string, now: Date): Promise<SignalLookup>;
  /** Called once a payment is verified (e.g. to record payouts to human pickers). */
  onPaid?: (paid: { signal: SpecialistSignal; receipt: SignalReceipt }) => void;
  now?: () => Date;
}

export type SignalReceipt = PaidReceipt;

export interface PaidSignalBody {
  signal: SpecialistSignal;
  receipt: SignalReceipt;
  /** HMAC over `{ signal, receipt }` with the server secret */
  signature: string;
}

export async function handleSignalRequest(request: Request, specialistIdParam: string, deps: SignalGateDeps): Promise<Response> {
  const now = deps.now?.() ?? new Date();
  const parsedId = SpecialistIdSchema.safeParse(specialistIdParam);
  if (!parsedId.success) return json(404, { error: `Unknown specialist "${specialistIdParam}".` });
  const specialistId = parsedId.data;

  const marketId = new URL(request.url).searchParams.get("marketId");
  if (!marketId) return json(400, { error: "Query parameter `marketId` is required." });
  let lookup: SignalLookup;
  try {
    lookup = await deps.loadSignal(specialistId, marketId, now);
  } catch (err) {
    return json(503, { error: `Market data unavailable: ${(err as Error).message}` });
  }
  if (lookup.status === "UNKNOWN_MARKET") return json(404, { error: `Unknown or unpriceable market "${marketId}".` });
  if (lookup.status === "NO_DATA") {
    return json(404, { error: `${specialistId} has no signal for ${marketId}: ${lookup.reason}`, code: "NO_SIGNAL" });
  }
  if (!deps.treasury && !lookup.splits?.length) {
    return json(503, { error: "CALIBRO_SIGNAL_TREASURY_ADDRESS is not configured; cannot issue a payable challenge." });
  }

  const paywall = await requirePayment(request, {
    product: specialistId,
    marketId,
    resource: `/api/signals/${specialistId}?marketId=${encodeURIComponent(marketId)}`,
    recipient: deps.treasury,
    coinType: deps.coinType,
    amountRaw: deps.amountRaw,
    ledger: deps.ledger,
    verifier: deps.verifier,
    now,
    splits: lookup.splits,
  });
  if (!paywall.paid) return paywall.response;

  const receipt = paywall.receipt;
  // Report who was actually paid: the shares signed into the challenge, not a recomputation.
  const signal: SpecialistSignal = receipt.splits?.length
    ? { ...lookup.signal, payees: receipt.splits.map((s) => ({ address: s.recipient, amountRaw: s.amountRaw })) }
    : lookup.signal;
  deps.onPaid?.({ signal, receipt });
  const body: PaidSignalBody = { signal, receipt, signature: signServerPayload({ signal, receipt }) };
  return json(200, body, paymentResponseHeader(receipt));
}
