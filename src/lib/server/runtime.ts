/**
 * Server runtime wiring shared by the API routes: configuration checks, singletons,
 * engine construction and the admin guard. Server-only.
 *
 * There is no sandbox: without Walrus Memory keys the app reports UNCONFIGURED and
 * refuses to evaluate or settle rather than falling back to an in-memory store.
 */
import { MemWalMock } from "@mysten-incubation/memwal";
import { getMarketFeed, findMarket } from "../markets/odds-feed";
import { loadSnapshot } from "../markets/snapshot";
import { SPECIALIST_IDS, SyndicateEngine, type AcquiredSignal, type SignalAcquisitionRequest, type SpecialistSignalProvider } from "../orchestrator/syndicate-engine";
import { computeSpecialistSignal } from "../specialists/models";
import { loadTopPickers, topPickersSignal } from "../picks/crowd";
import { TatumSuiClient } from "../tatum/sui-rpc";
import { HttpX402SignalProvider, type TapeEvent } from "../x402/http-signal-provider";
import { FileReplayLedger, RedisReplayLedger, type ReplayLedger } from "../x402/replay-ledger";
import type { SignalLookup } from "../x402/signal-gate";
import { SuiX402Payer, type X402Payer } from "../x402/sui-payer";
import { CalibroMemoryClient } from "../walrus/memory-client";
import type { MarketDomain, SpecialistCalibrationRecord, SpecialistId } from "../types/calibro";

export interface RuntimeMode {
  mode: "LIVE_MAINNET" | "UNCONFIGURED";
  /** What is missing when UNCONFIGURED */
  missing: string[];
}

const REQUIRED_ENV = ["MEMWAL_PRIVATE_KEY", "MEMWAL_ACCOUNT_ID", "TATUM_API_KEY"] as const;

const G = globalThis as typeof globalThis & {
  __calibro?: {
    memory?: CalibroMemoryClient;
    tatum?: TatumSuiClient;
    ledger?: ReplayLedger | null;
    ledgerError?: string;
    payer?: X402Payer | null;
    payerError?: string;
  };
};
const state = (G.__calibro ??= {});

export function resolveMode(): RuntimeMode {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]?.trim());
  return { mode: missing.length === 0 ? "LIVE_MAINNET" : "UNCONFIGURED", missing };
}

export class NotConfiguredError extends Error {}

export function requireLive(): void {
  const { mode, missing } = resolveMode();
  if (mode !== "LIVE_MAINNET") {
    throw new NotConfiguredError(`Calibro is not configured for Mainnet: set ${missing.join(", ")}.`);
  }
}

export function getMemory(): CalibroMemoryClient {
  requireLive();
  // instanceof also catches a stale instance kept on globalThis across dev hot reloads.
  if (!(state.memory instanceof CalibroMemoryClient)) state.memory = new CalibroMemoryClient({ mode: "LIVE_MAINNET" });
  return state.memory;
}

export function getTatum(): TatumSuiClient {
  return (state.tatum ??= new TatumSuiClient());
}

/**
 * Anti-replay ledger: Redis (Upstash / Vercel KV) when configured; otherwise a file on
 * a single machine. On Vercel the filesystem is per-instance, so Redis is required.
 */
export function getLedger(): { ledger: ReplayLedger | null; error?: string } {
  if (state.ledger !== undefined) return { ledger: state.ledger, error: state.ledgerError };
  const redis = RedisReplayLedger.fromEnv();
  if (redis) state.ledger = redis;
  else if (process.env.VERCEL) {
    state.ledger = null;
    state.ledgerError =
      "No shared replay ledger: connect Upstash Redis or Vercel KV (UPSTASH_REDIS_REST_URL + _TOKEN or KV_REST_API_URL + _TOKEN, a prefix is fine) and redeploy to sell signals on Vercel.";
  } else {
    state.ledger = new FileReplayLedger(`${process.cwd()}/.calibro/redeemed-receipts.json`);
  }
  return { ledger: state.ledger, error: state.ledgerError };
}

export function getPayer(): { payer: X402Payer | null; error?: string } {
  if (state.payer !== undefined) return { payer: state.payer, error: state.payerError };
  const key = process.env.CALIBRO_AGENT_SUI_PRIVATE_KEY?.trim();
  if (!key) {
    state.payer = null;
    state.payerError = "CALIBRO_AGENT_SUI_PRIVATE_KEY not set";
  } else {
    try {
      state.payer = new SuiX402Payer({ privateKey: key });
    } catch (err) {
      state.payer = null;
      state.payerError = `Invalid CALIBRO_AGENT_SUI_PRIVATE_KEY: ${(err as Error).message}`;
    }
  }
  return { payer: state.payer, error: state.payerError };
}

export function paymentConfig(): { treasury: string | null; coinType: string; amountRaw: string } {
  return {
    treasury: process.env.CALIBRO_SIGNAL_TREASURY_ADDRESS?.trim() || null,
    coinType: process.env.CALIBRO_X402_COIN_TYPE?.trim() || "0x2::sui::SUI",
    amountRaw: process.env.CALIBRO_X402_DEFAULT_PRICE_RAW?.trim() || "2000000",
  };
}

/**
 * Calibro's own forecast is sold for `CALIBRO_FORECAST_PRICE_RAW` (default 0.01 SUI) and
 * paid to the agent wallet, so forecast revenue funds the agent's own signal purchases.
 */
export function forecastPaymentConfig(): { recipient: string | null; coinType: string; amountRaw: string } {
  return {
    recipient: process.env.CALIBRO_FORECAST_RECIPIENT?.trim() || getPayer().payer?.address || null,
    coinType: paymentConfig().coinType,
    amountRaw: process.env.CALIBRO_FORECAST_PRICE_RAW?.trim() || "10000000",
  };
}

/** Signal lookup used by the paid endpoint: real point-in-time data, or a reason it has none. */
export async function lookupSignal(specialistId: SpecialistId, marketId: string, now: Date): Promise<SignalLookup> {
  const snapshot = await loadSnapshot(marketId);
  if (!snapshot) return { status: "UNKNOWN_MARKET" };
  if (specialistId === "top-pickers") {
    const m = snapshot.market;
    if (m.source !== "LIVE" || m.domain === "CRYPTO_MACRO") {
      return { status: "NO_DATA", reason: "TopPickers only covers upcoming NBA, EPL and UFC games" };
    }
    requireLive();
    const agent = getPayer().payer?.address;
    const result = await loadTopPickers(getMemory(), m, BigInt(paymentConfig().amountRaw), agent ? [agent] : [], now);
    if (!result) return { status: "NO_DATA", reason: "no picker with a record (≥ 3 graded picks, Brier ≤ 0.25) has picked this game yet" };
    return { status: "OK", signal: topPickersSignal(m, result, now), splits: result.payees.map((p) => ({ recipient: p.address, amountRaw: p.amountRaw })) };
  }
  const signal = computeSpecialistSignal(specialistId, snapshot, now);
  if (!signal) return { status: "NO_DATA", reason: "its data source has nothing for this market" };
  return { status: "OK", signal };
}

/** Engine whose signals are bought over real HTTP 402 + Sui Mainnet from `origin`. */
export function buildEngine(origin: string, tape: TapeEvent[]): SyndicateEngine {
  const { coinType, amountRaw } = paymentConfig();
  const signals = new HttpX402SignalProvider({
    baseUrl: origin,
    payer: getPayer().payer,
    onEvent: (e) => tape.push(e),
  });
  return new SyndicateEngine({ memory: getMemory(), signals, rates: getTatum(), defaultFee: { coinType, amountRaw } });
}

/**
 * Counterfactual "cold start" for the comparator: the same real signals computed
 * in-process (unpaid, never persisted) and combined by an engine with an empty memory.
 * It answers "what would Calibro do with no track record?" and is labelled as such.
 */
class CounterfactualSignalProvider implements SpecialistSignalProvider {
  async acquireSignal(req: SignalAcquisitionRequest): Promise<AcquiredSignal> {
    const lookup = await lookupSignal(req.specialistId, req.market.marketId, new Date());
    if (lookup.status !== "OK") throw new Error(`${req.specialistId}: no counterfactual signal`);
    return { signal: lookup.signal, payment: { mode: "UNPAID" } };
  }
}

/**
 * Visitor preview: Calibro's real recalled record from Walrus (calibration, mandate,
 * analogous games) deciding over the same signals computed in-process. Nothing is paid
 * (signals are UNPAID, never carry a digest) and nothing is written: callers must pass
 * `persistThesis: false`. Used only on resolved games, labelled as a preview in the UI.
 */
export function buildPreviewEngine(ledger?: SpecialistCalibrationRecord[] | null): SyndicateEngine {
  const { coinType, amountRaw } = paymentConfig();
  const base = getMemory();
  // With the replayed ledger (built from the cached post-mortems, identical to the stored
  // checkpoints), skip the per-source calibration recalls; mandate and analogous-game
  // recalls still go to Walrus.
  const memory = ledger
    ? Object.assign(Object.create(base) as CalibroMemoryClient, {
        recallDomainCalibrations: async (domain: MarketDomain) => ({
          bySpecialist: Object.fromEntries(ledger.filter((r) => r.domain === domain).map((r) => [r.specialistId, r])) as Partial<
            Record<SpecialistId, SpecialistCalibrationRecord>
          >,
        }),
      })
    : base;
  return new SyndicateEngine({ memory, signals: new CounterfactualSignalProvider(), rates: getTatum(), defaultFee: { coinType, amountRaw } });
}

/** Whether evaluate/settle need the operator token here (same rule as checkAdmin). */
export function operatorTokenRequired(): boolean {
  return Boolean(process.env.CALIBRO_ADMIN_TOKEN?.trim()) || process.env.NODE_ENV === "production";
}

export function buildColdStartEngine(): SyndicateEngine {
  const { coinType, amountRaw } = paymentConfig();
  return new SyndicateEngine({
    // Empty, process-local memory: zero records by construction, never written to.
    memory: new CalibroMemoryClient({ mode: "MOCK_SANDBOX", mockInstance: MemWalMock.create({ namespace: "calibro:episodic" }) }),
    signals: new CounterfactualSignalProvider(),
    rates: getTatum(),
    defaultFee: { coinType, amountRaw },
  });
}

/**
 * State-changing routes (evaluate = spends SUI, settle = writes Walrus) require
 * `x-calibro-admin` when CALIBRO_ADMIN_TOKEN is set, and are refused on a production
 * deployment without a token.
 */
export function checkAdmin(request: Request): string | null {
  const token = process.env.CALIBRO_ADMIN_TOKEN?.trim();
  if (!token) {
    return process.env.NODE_ENV === "production" ? "Writes are disabled on this deployment (set CALIBRO_ADMIN_TOKEN)." : null;
  }
  return request.headers.get("x-calibro-admin") === token ? null : "Missing or invalid x-calibro-admin header.";
}

/**
 * Scheduled jobs (/api/cron/*): `Authorization: Bearer $CRON_SECRET` (what Vercel Cron and
 * the GitHub workflow send) or the admin token. Open only in local dev with neither set.
 */
export function cronAuthorized(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  const adminToken = process.env.CALIBRO_ADMIN_TOKEN?.trim();
  return Boolean(
    (cronSecret && (request.headers.get("authorization") ?? "") === `Bearer ${cronSecret}`) ||
      (adminToken && request.headers.get("x-calibro-admin") === adminToken) ||
      (!cronSecret && !adminToken && process.env.NODE_ENV !== "production")
  );
}

export { findMarket, getMarketFeed, SPECIALIST_IDS };

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }
  );
}

export function errorResponse(err: unknown, status = 500): Response {
  if (err instanceof NotConfiguredError) return jsonResponse(503, { error: err.message, code: "UNCONFIGURED" });
  return jsonResponse(status, { error: err instanceof Error ? err.message : String(err) });
}
