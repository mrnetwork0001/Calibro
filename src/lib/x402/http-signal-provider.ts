/**
 * Client side of the paywall — the agent's x402 / MPP buyer.
 *
 *   GET signal → 402 challenge → check terms against what the VoI gate approved →
 *   pay (real Sui Mainnet transfer) → retry with Authorization: Payment → signal
 *
 * Every step is emitted as a tape event for the UI's payment tape.
 */
import type {
  AcquiredSignal,
  SignalAcquisitionRequest,
  SpecialistSignalProvider,
} from "../orchestrator/syndicate-engine";
import { normalizeCoinType } from "../tatum/sui-rpc";
import type { SpecialistId } from "../types/calibro";
import { encodeX402PaymentProof, parseX402ChallengeHeaders } from "./protocol";
import type { PaidSignalBody } from "./signal-gate";
import type { X402Payer } from "./sui-payer";

export type TapeEventKind = "CHALLENGE_402" | "PAID" | "VERIFIED" | "VETOED" | "ERROR";

export interface TapeEvent {
  at: string;
  kind: TapeEventKind;
  specialistId: SpecialistId;
  marketId: string;
  mode: "LIVE_MAINNET";
  amountRaw?: string;
  coinType?: string;
  feeUsd?: number;
  txDigest?: string;
  checkpoint?: string;
  detail: string;
}

export interface HttpX402SignalProviderOptions {
  baseUrl: string;
  payer: X402Payer | null;
  fetchImpl?: typeof fetch;
  onEvent?: (event: TapeEvent) => void;
}

export class HttpX402SignalProvider implements SpecialistSignalProvider {
  private readonly fetchImpl: typeof fetch;
  /** Payments from one wallet are serialized: concurrent txs would contend for the gas coin. */
  private paymentQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: HttpX402SignalProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private emit(e: Omit<TapeEvent, "at" | "mode">): void {
    this.options.onEvent?.({ ...e, at: new Date().toISOString(), mode: "LIVE_MAINNET" });
  }

  async acquireSignal(req: SignalAcquisitionRequest): Promise<AcquiredSignal> {
    const { specialistId, market, fee } = req;
    const url = `${this.options.baseUrl}/api/signals/${specialistId}?marketId=${encodeURIComponent(market.marketId)}`;
    try {
      const first = await this.fetchImpl(url, { headers: { accept: "application/json" } });
      if (first.status === 404) {
        const body = (await first.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `${specialistId} has no signal for this market (404).`);
      }
      if (first.status !== 402) {
        throw new Error(`Expected HTTP 402 from ${specialistId}, got ${first.status}: ${(await first.text()).slice(0, 200)}`);
      }
      const challenge = parseX402ChallengeHeaders(first.headers);
      if (!challenge) throw new Error("402 response carried no parseable x402/MPP challenge.");

      this.emit({
        kind: "CHALLENGE_402",
        specialistId,
        marketId: market.marketId,
        amountRaw: challenge.amountRaw,
        coinType: challenge.coinType,
        feeUsd: fee.feeUsd,
        detail: `402 Payment Required · ${challenge.amountRaw} ${challenge.coinType.split("::").pop()} → ${challenge.recipient.slice(0, 10)}…`,
      });

      // Never pay more, or in a different coin, than the VoI gate approved.
      if (normalizeCoinType(challenge.coinType) !== normalizeCoinType(fee.coinType)) {
        throw new Error(`Challenge coin ${challenge.coinType} differs from approved ${fee.coinType}.`);
      }
      if (BigInt(challenge.amountRaw) > BigInt(fee.amountRaw)) {
        throw new Error(`Challenge asks ${challenge.amountRaw} > approved ${fee.amountRaw}.`);
      }

      const payer = this.options.payer;
        if (!payer) throw new Error("No agent wallet configured (CALIBRO_AGENT_SUI_PRIVATE_KEY).");
        const paid = this.paymentQueue.then(() => payer.pay(challenge));
        this.paymentQueue = paid.catch(() => undefined);
        const receipt = await paid;
        this.emit({
          kind: "PAID",
          specialistId,
          marketId: market.marketId,
          amountRaw: challenge.amountRaw,
          coinType: challenge.coinType,
          feeUsd: fee.feeUsd,
          txDigest: receipt.txDigest,
          checkpoint: receipt.checkpoint,
          detail: `Sui Mainnet transfer submitted by ${receipt.payer.slice(0, 10)}…`,
        });
        const proofHeaders = encodeX402PaymentProof({
          challengeId: challenge.challengeId,
          txDigest: receipt.txDigest,
          payer: receipt.payer,
          network: "sui:mainnet",
          mode: "LIVE_MAINNET",
        });

      // The SUI has moved: retry the redemption a few times if the gateway hasn't indexed
      // the transaction yet (verification says "not found") or the verifier was unreachable.
      let second: Response | null = null;
      let lastError = "";
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await this.fetchImpl(url, { headers: { accept: "application/json", ...proofHeaders } });
        if (res.ok) {
          second = res;
          break;
        }
        lastError = `Paid retry rejected (${res.status}): ${(await res.text()).slice(0, 240)}`;
        const transient = res.status === 502 || res.status === 503 || /not found|not indexed/i.test(lastError);
        if (!transient) break;
        await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
      }
      if (!second) throw new Error(`${lastError} [paid tx ${receipt.txDigest}]`);
      const body = (await second.json()) as PaidSignalBody;
      this.emit({
        kind: "VERIFIED",
        specialistId,
        marketId: market.marketId,
        amountRaw: body.receipt.amountRaw,
        coinType: body.receipt.coinType,
        feeUsd: fee.feeUsd,
        txDigest: body.receipt.txDigest,
        checkpoint: body.receipt.checkpoint,
        detail: `Verified via Tatum Sui GraphQL (checkpoint ${body.receipt.checkpoint ?? "?"}) · signal p=${body.signal.rawProbability}`,
      });
      if (body.receipt.receiptMode !== "LIVE_MAINNET" || body.receipt.txDigest !== receipt.txDigest) {
        throw new Error("Server receipt does not match the transaction this agent paid with.");
      }

      return {
        signal: body.signal,
        payment: { mode: "LIVE_MAINNET", txDigest: body.receipt.txDigest, payer: body.receipt.payer },
      };
    } catch (err) {
      this.emit({ kind: "ERROR", specialistId, marketId: market.marketId, detail: (err as Error).message });
      throw err;
    }
  }
}
