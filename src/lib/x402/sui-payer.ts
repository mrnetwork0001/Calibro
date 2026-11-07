/**
 * Autonomous x402 payer: signs and submits a real Sui Mainnet transfer that settles
 * an HTTP 402 challenge, executed through Tatum's Sui Mainnet GraphQL gateway.
 *
 * Only called after the deterministic VoI gate approved the payment, and only for the
 * exact (recipient, coinType, amount) inside a server-signed challenge.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { TATUM_SUI_GRAPHQL_URL, createTatumFetch, normalizeCoinType, normalizeSuiAddress } from "../tatum/sui-rpc";
import type { X402PaymentChallenge } from "../types/calibro";

const SUI_TYPE = normalizeCoinType("0x2::sui::SUI");

export interface SuiPaymentReceipt {
  txDigest: string;
  payer: string;
  checkpoint?: string;
  gasUsedMist?: string;
}

export interface X402Payer {
  readonly address: string;
  pay(challenge: X402PaymentChallenge): Promise<SuiPaymentReceipt>;
}

export interface SuiX402PayerOptions {
  /** `suiprivkey1...` Bech32 secret key */
  privateKey: string;
  graphqlUrl?: string;
  tatumApiKey?: string;
  /** Refuse any single payment above this many base units (defence in depth) */
  maxAmountRaw?: bigint;
}

export class SuiX402Payer implements X402Payer {
  readonly address: string;
  private readonly keypair: Ed25519Keypair;
  private readonly client: SuiGraphQLClient;
  private readonly maxAmountRaw: bigint;

  constructor(options: SuiX402PayerOptions) {
    this.keypair = Ed25519Keypair.fromSecretKey(options.privateKey.trim());
    this.address = this.keypair.getPublicKey().toSuiAddress();
    const apiKey = options.tatumApiKey ?? process.env.TATUM_API_KEY ?? "";
    this.client = new SuiGraphQLClient({
      network: "mainnet",
      url: options.graphqlUrl ?? process.env.TATUM_SUI_MAINNET_GRAPHQL ?? TATUM_SUI_GRAPHQL_URL,
      headers: apiKey ? { "x-api-key": apiKey } : {},
      fetch: createTatumFetch(),
    });
    // 0.05 SUI default ceiling per signal
    this.maxAmountRaw = options.maxAmountRaw ?? 50_000_000n;
  }

  /** The payment PTB for a challenge: one transfer, or one split transfer per share. */
  buildTransaction(challenge: X402PaymentChallenge): Transaction {
    const amount = BigInt(challenge.amountRaw);
    const tx = new Transaction();
    tx.setSender(this.address);
    // Split challenges (e.g. TopPickers) pay every share in this one transaction.
    const shares = challenge.splits?.length
      ? challenge.splits.map((s) => ({ recipient: s.recipient, amount: BigInt(s.amountRaw) }))
      : [{ recipient: challenge.recipient, amount }];
    if (shares.reduce((a, s) => a + s.amount, 0n) !== amount || shares.some((s) => s.amount <= 0n)) {
      throw new Error("Split shares must be positive and sum to the challenge amount.");
    }
    if (shares.some((s) => normalizeSuiAddress(s.recipient) === normalizeSuiAddress(this.address))) {
      throw new Error("Refusing a split that pays the agent's own wallet.");
    }
    if (normalizeCoinType(challenge.coinType) === SUI_TYPE) {
      const coins = tx.splitCoins(
        tx.gas,
        shares.map((s) => s.amount)
      );
      shares.forEach((s, i) => tx.transferObjects([coins[i]], s.recipient));
    } else {
      for (const s of shares) tx.transferObjects([coinWithBalance({ type: challenge.coinType, balance: s.amount })], s.recipient);
    }

    return tx;
  }

  async pay(challenge: X402PaymentChallenge): Promise<SuiPaymentReceipt> {
    if (challenge.network !== "sui:mainnet") {
      throw new Error(`Refusing to pay on network ${challenge.network}.`);
    }
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      throw new Error(`Challenge expired at ${challenge.expiresAt}.`);
    }
    const amount = BigInt(challenge.amountRaw);
    if (amount <= 0n || amount > this.maxAmountRaw) {
      throw new Error(`Refusing x402 amount ${amount} (ceiling ${this.maxAmountRaw}).`);
    }

    const tx = this.buildTransaction(challenge);

    const res = await this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
      include: { effects: true },
    });
    const executed = res.$kind === "Transaction" ? res.Transaction : res.FailedTransaction;
    if (res.$kind !== "Transaction" || !executed.status.success) {
      const err = executed.status.success ? "unknown error" : JSON.stringify(executed.status.error).slice(0, 200);
      throw new Error(`Sui payment ${executed.digest} failed: ${err}`);
    }

    // Wait until the gateway serves it, so the server's Tatum verification sees it. The SUI
    // has already moved at this point, so a slow lookup must not lose the receipt: after
    // retries, return the digest anyway and let the server's verification decide.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const final = await this.client.waitForTransaction({ digest: executed.digest, include: { effects: true }, timeout: 30_000 });
        const done = final.$kind === "Transaction" ? final.Transaction : final.FailedTransaction;
        const gas = done.effects?.gasUsed;
        return {
          txDigest: executed.digest,
          payer: this.address,
          checkpoint: done.checkpoint ?? undefined,
          gasUsedMist: gas
            ? (BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate)).toString()
            : undefined,
        };
      } catch {
        await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
      }
    }
    return { txDigest: executed.digest, payer: this.address };
  }
}
