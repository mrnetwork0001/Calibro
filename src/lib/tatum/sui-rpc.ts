/**
 * Tatum Sui Mainnet gateway + Tatum v4 Data API client.
 *
 * Tatum's Sui Mainnet gateway serves the Sui GraphQL API at
 * `https://sui-mainnet.gateway.tatum.io/graphql` (the legacy JSON-RPC root returns 404),
 * authenticated with `x-api-key`. Payment receipts are verified with the GraphQL
 * `transaction(digest)` query: status, sender, timestamp and balance changes.
 *
 * Free Tatum plans allow 3 requests/second, so every call goes through a per-process
 * throttle with 429 backoff.
 */

export const TATUM_SUI_GRAPHQL_URL = "https://sui-mainnet.gateway.tatum.io/graphql";

export interface TatumSuiConfig {
  apiKey?: string;
  graphqlUrl?: string;
  apiBaseUrl?: string;
  /** Minimum spacing between Tatum requests (default 360 ms ≈ 2.8 req/s) */
  minIntervalMs?: number;
}

export interface SuiPaymentVerificationResult {
  verified: boolean;
  txDigest: string;
  checkpoint?: string;
  timestampMs?: string;
  sender?: string;
  recipientCreditedRaw: bigint;
  coinType: string;
  reason: string;
}

interface GqlTransaction {
  digest: string;
  sender: { address: string } | null;
  effects: {
    status: "SUCCESS" | "FAILURE" | null;
    timestamp: string | null;
    checkpoint: { sequenceNumber: number | string } | null;
    executionError?: { message?: string } | null;
    balanceChanges: {
      nodes: Array<{ owner: { address: string } | null; amount: string; coinType: { repr: string } | null }>;
      pageInfo?: { hasNextPage: boolean };
    } | null;
  } | null;
}

// ---- per-process throttle (shared by every TatumSuiClient instance) --------
let queue: Promise<unknown> = Promise.resolve();
let lastAt = 0;
function throttled<T>(minIntervalMs: number, fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * `fetch` that shares the per-process Tatum throttle and retries 429s with backoff.
 * Handed to `SuiGraphQLClient` so the agent's payments don't trip the plan's rate limit.
 */
export function createTatumFetch(minIntervalMs = 360, maxRetries = 5): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    for (let attempt = 0; ; attempt++) {
      const res = await throttled(minIntervalMs, () => fetch(input, init));
      if (res.status !== 429 || attempt >= maxRetries) return res;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }) as typeof fetch;
}

const rateCache = new Map<string, { at: number; value: { usdPrice: number; source: "TATUM_V4_RATES" } }>();
const RATE_TTL_MS = 60_000;
/** A real Tatum quote stays usable this long if a refresh fails; after that, pricing fails. */
const RATE_STALE_MAX_MS = 10 * 60_000;

export class TatumSuiClient {
  public readonly graphqlUrl: string;
  public readonly apiBaseUrl: string;
  private readonly apiKey: string;
  private readonly minIntervalMs: number;

  constructor(config: TatumSuiConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.TATUM_API_KEY ?? "";
    this.graphqlUrl = config.graphqlUrl ?? process.env.TATUM_SUI_MAINNET_GRAPHQL ?? TATUM_SUI_GRAPHQL_URL;
    this.apiBaseUrl = config.apiBaseUrl ?? process.env.TATUM_API_BASE_URL ?? "https://api.tatum.io";
    this.minIntervalMs = config.minIntervalMs ?? 360;
  }

  hasApiKey(): boolean {
    return this.apiKey.trim().length > 0;
  }

  /** Throttled fetch with up to 3 retries on HTTP 429. */
  private async tatumFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await throttled(this.minIntervalMs, () =>
        fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      );
      if (res.status !== 429 || attempt >= 3) return res;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }

  /** Execute a Sui GraphQL query against Tatum's gateway. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (!this.hasApiKey()) throw new Error("TATUM_API_KEY not set");
    const res = await this.tatumFetch(
      this.graphqlUrl,
      {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "x-api-key": this.apiKey },
        body: JSON.stringify({ query, variables }),
      },
      12_000
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Tatum Sui GraphQL HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) throw new Error(`Tatum Sui GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    if (!json.data) throw new Error("Tatum Sui GraphQL returned no data");
    return json.data;
  }

  /** Latest Sui Mainnet checkpoint sequence number via Tatum. */
  async getLatestCheckpoint(): Promise<string> {
    const data = await this.graphql<{ checkpoint: { sequenceNumber: number | string } | null }>(
      "{ checkpoint { sequenceNumber } }"
    );
    if (!data.checkpoint) throw new Error("No checkpoint returned");
    return String(data.checkpoint.sequenceNumber);
  }

  /** All coin balances for a Sui Mainnet address via Tatum. */
  async getAllBalances(ownerAddress: string): Promise<Array<{ coinType: string; totalBalance: string }>> {
    const data = await this.graphql<{
      address: { balances: { nodes: Array<{ coinType: { repr: string } | null; totalBalance: string | null }> } | null } | null;
    }>(
      "query($a: SuiAddress!) { address(address: $a) { balances(first: 50) { nodes { coinType { repr } totalBalance } } } }",
      { a: normalizeSuiAddress(ownerAddress) }
    );
    return (data.address?.balances?.nodes ?? []).map((n) => ({
      coinType: n.coinType?.repr ? normalizeCoinType(n.coinType.repr) : "unknown",
      totalBalance: n.totalBalance ?? "0",
    }));
  }

  /**
   * Live USD spot rate from Tatum v4 Data API (`GET /v4/data/rate/symbol`), cached 60 s.
   * There is no static fallback: if Tatum is unreachable, the last real quote is reused for
   * up to 10 minutes, then this throws and fees cannot be priced.
   */
  async getUsdExchangeRate(symbol = "SUI"): Promise<{ usdPrice: number; source: "TATUM_V4_RATES" }> {
    if (!this.apiKey) throw new Error("TATUM_API_KEY is not set: cannot price x402 fees in USD.");
    const cached = rateCache.get(symbol);
    if (cached && Date.now() - cached.at < RATE_TTL_MS) return cached.value;
    try {
      const url = `${this.apiBaseUrl}/v4/data/rate/symbol?symbol=${encodeURIComponent(symbol)}&basePair=USD`;
      const res = await this.tatumFetch(url, { headers: { accept: "application/json", "x-api-key": this.apiKey } }, 8_000);
      if (!res.ok) throw new Error(`Tatum rates HTTP ${res.status}`);
      const parsed = Number(((await res.json()) as { value?: string | number }).value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Tatum returned an invalid ${symbol}/USD rate`);
      const value = { usdPrice: parsed, source: "TATUM_V4_RATES" as const };
      rateCache.set(symbol, { at: Date.now(), value });
      return value;
    } catch (err) {
      if (cached && Date.now() - cached.at < RATE_STALE_MAX_MS) return cached.value;
      throw new Error(`${symbol}/USD rate unavailable from Tatum: ${(err as Error).message}`);
    }
  }

  /**
   * Deterministically verifies an x402 / MPP Sui Mainnet payment receipt via Tatum:
   * 1. the transaction exists and its effects status is SUCCESS
   * 2. balance changes credit `expectedRecipient` with >= `minAmountRaw` of `expectedCoinType`
   * 3. (optional) the sender is `expectedSender`
   * 4. (optional) it landed at or after `notBeforeMs`, so an older unrelated payment to
   *    the same treasury cannot be presented for a new challenge
   */
  async verifyX402PaymentOnSui(params: {
    txDigest: string;
    expectedRecipient: string;
    expectedCoinType: string;
    minAmountRaw: bigint;
    expectedSender?: string;
    notBeforeMs?: number;
    /** Split payments: every other recipient that must also be credited ≥ its share */
    additionalCredits?: Array<{ recipient: string; minAmountRaw: bigint }>;
  }): Promise<SuiPaymentVerificationResult> {
    const data = await this.graphql<{ transaction: GqlTransaction | null }>(
      `query($d: String!) { transaction(digest: $d) { digest sender { address }
         effects { status timestamp checkpoint { sequenceNumber } executionError { message }
           balanceChanges(first: 50) { nodes { owner { address } amount coinType { repr } } pageInfo { hasNextPage } } } } }`,
      { d: params.txDigest }
    );

    const tx = data.transaction;
    const fx = tx?.effects ?? null;
    const sender = tx?.sender?.address ?? undefined;
    const checkpoint = fx?.checkpoint ? String(fx.checkpoint.sequenceNumber) : undefined;
    const tsMs = fx?.timestamp ? Date.parse(fx.timestamp) : NaN;
    const timestampMs = Number.isFinite(tsMs) ? String(tsMs) : undefined;

    const fail = (reason: string, credited = 0n): SuiPaymentVerificationResult => ({
      verified: false,
      txDigest: params.txDigest,
      checkpoint,
      timestampMs,
      sender,
      recipientCreditedRaw: credited,
      coinType: params.expectedCoinType,
      reason,
    });

    if (!tx || !fx) return fail(`Transaction ${params.txDigest} not found on Sui Mainnet (yet).`);
    if (fx.status !== "SUCCESS") {
      return fail(`Transaction ${params.txDigest} status is "${fx.status ?? "unknown"}"${fx.executionError?.message ? `: ${fx.executionError.message}` : ""}.`);
    }
    if (params.expectedSender) {
      if (!sender || normalizeSuiAddress(sender) !== normalizeSuiAddress(params.expectedSender)) {
        return fail(`Transaction sender ${sender ?? "unknown"} does not match payer ${params.expectedSender}.`);
      }
    }
    if (params.notBeforeMs !== undefined && (!Number.isFinite(tsMs) || tsMs < params.notBeforeMs)) {
      return fail(`Transaction timestamp ${fx.timestamp ?? "unknown"} predates the challenge (${new Date(params.notBeforeMs).toISOString()}).`);
    }

    const normCoin = normalizeCoinType(params.expectedCoinType);
    const creditedTo = (recipient: string) => {
      const norm = normalizeSuiAddress(recipient);
      let sum = 0n;
      for (const change of fx.balanceChanges?.nodes ?? []) {
        if (!change.owner?.address || !change.coinType?.repr) continue;
        if (normalizeSuiAddress(change.owner.address) === norm && normalizeCoinType(change.coinType.repr) === normCoin) sum += BigInt(change.amount);
      }
      return sum;
    };
    const credited = creditedTo(params.expectedRecipient);
    if (credited < params.minAmountRaw) {
      return fail(`Recipient ${params.expectedRecipient} credited ${credited.toString()} < required ${params.minAmountRaw.toString()}.`, credited);
    }
    for (const extra of params.additionalCredits ?? []) {
      const got = creditedTo(extra.recipient);
      if (got < extra.minAmountRaw) {
        return fail(`Split recipient ${extra.recipient} credited ${got.toString()} < required ${extra.minAmountRaw.toString()}.`, credited);
      }
    }

    return {
      verified: true,
      txDigest: params.txDigest,
      checkpoint,
      timestampMs,
      sender,
      recipientCreditedRaw: credited,
      coinType: params.expectedCoinType,
      reason: `Verified Sui Mainnet settlement (+${credited.toString()} raw units) via Tatum Sui GraphQL, checkpoint ${checkpoint ?? "?"}.`,
    };
  }
}

export function normalizeSuiAddress(addr: string): string {
  const clean = addr.trim().toLowerCase().replace(/^0x/, "");
  return `0x${clean.padStart(64, "0")}`;
}

export function normalizeCoinType(coinType: string): string {
  const parts = coinType.trim().split("::");
  if (parts.length !== 3) return coinType.trim().toLowerCase();
  return `${normalizeSuiAddress(parts[0])}::${parts[1]}::${parts[2]}`;
}
