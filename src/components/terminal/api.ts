"use client";

import type { MarketFeed } from "@/lib/markets/odds-feed";
import type { MarketEvaluation, SettlementResult } from "@/lib/orchestrator/syndicate-engine";
import type { RuntimeMode } from "@/lib/server/runtime";
import type { MarketDomain, PickPayoutRecord, PickRecord, ScorecardRecord, SpecialistCalibrationRecord, SpecialistId } from "@/lib/types/calibro";
import type { TapeEvent } from "@/lib/x402/http-signal-provider";

export type { MarketEvaluation, SettlementResult, TapeEvent, RuntimeMode, SpecialistCalibrationRecord };

type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

export interface StatusResponse {
  mode: RuntimeMode;
  data: { polymarket: boolean; espn: boolean; oddsApi: boolean };
  replayLedger: { kind: "memory" | "file" | "redis" | null; error?: string };
  tatum: {
    hasApiKey: boolean;
    graphqlUrl: string;
    checkpoint: Settled<string>;
    suiRate: Settled<{ usdPrice: number; source: string }>;
  };
  walrus: {
    relayer: string;
    health: Settled<{ status?: string; mode?: string; write_ready?: boolean }>;
    inventory: Settled<{ total: number; namespaces: Array<{ name: string; count: number }> }>;
  };
  payments: {
    treasury: string | null;
    coinType: string;
    amountRaw: string;
    payerAddress: string | null;
    payerError?: string;
    payerBalances: Settled<Array<{ coinType: string; totalBalance: string }>> | null;
  };
  checkedAt: string;
}

export interface EvaluateResponse {
  mode: RuntimeMode;
  evaluation: MarketEvaluation;
  tape: TapeEvent[];
  coldStart: MarketEvaluation | null;
}

export interface SettleResponse {
  mode: RuntimeMode;
  result: SettlementResult;
}

export interface CalibrationResponse {
  mode: RuntimeMode;
  calibrations: SpecialistCalibrationRecord[];
  settled: Array<{
    marketId: string;
    domain: MarketDomain;
    title: string;
    calibroProb: number;
    naiveProb: number;
    outcome: 0 | 1;
    realizedBrier?: number;
    naiveRealizedBrier?: number;
    pnlUsd?: number;
    settledAt?: string;
  }>;
  points: Array<{ source: SpecialistId | "calibro"; domain: MarketDomain; p: number; y: 0 | 1 }>;
}

export interface AuditResponse {
  mode: RuntimeMode;
  totalMemories: number;
  namespaces: Array<{ name: string; memoryCount: number; updatedAt: string }>;
  memories: Array<{ blobId: string; namespace: string; createdAt: string; status: string; size: number }>;
  accountId: string | null;
}

export type { MarketFeed };
export type { Timeline, TimelineStep, TimelineSource, TrustStatus } from "@/lib/timeline/build";

export interface PicksResponse {
  owner: string;
  picks: Array<{ blobId: string; record: PickRecord }>;
  scorecard: ScorecardRecord | null;
  insights: string[];
  payouts: Array<{ blobId: string; record: PickPayoutRecord }>;
  earnedRaw: string;
  topPickers: { qualified: boolean; minGraded: number; maxBrier: number };
}

export interface CoachDataResponse {
  marketId: string;
  domain: MarketDomain;
  picks: import("@/lib/picks/coach").CoachPick[];
  league: { alphaSlope: number; betaIntercept: number; sampleSize: number } | null;
  scorecardBlobId: string | null;
  marketHistory: Array<{ domain: MarketDomain; p: number; y: 0 | 1 }>;
  settledMarkets: number;
}

export interface LeaderboardResponse {
  users: Array<{
    owner: string;
    graded: number;
    brier: number;
    marketBrier: number;
    edgeVsMarket: number;
    calibroBrier: number | null;
    calibroCompared: number;
    earnedRaw: string;
    topPicker: boolean;
    updatedAt: string;
  }>;
  reference: {
    settledMarkets: number;
    calibro: number;
    polymarket: number;
    specialists: Array<{ id: SpecialistId; samples: number; brier: number | null }>;
  } | null;
}

const ADMIN_KEY = "calibro-admin-token";

/** Operator token for evaluate/settle on a deployment with CALIBRO_ADMIN_TOKEN; kept in this browser only. */
export const adminToken = {
  get: () => (typeof window === "undefined" ? null : window.localStorage.getItem(ADMIN_KEY)),
  set: (t: string) => window.localStorage.setItem(ADMIN_KEY, t.trim()),
  clear: () => window.localStorage.removeItem(ADMIN_KEY),
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = adminToken.get();
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { "x-calibro-admin": token } : {}), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status} on ${path}`);
  return body;
}

export const api = {
  status: () => call<StatusResponse>("/api/status"),
  markets: () => call<MarketFeed>("/api/markets"),
  calibration: () => call<CalibrationResponse>("/api/calibration"),
  audit: () => call<AuditResponse>("/api/walrus/audit"),
  evaluate: (marketId: string) =>
    call<EvaluateResponse>("/api/evaluate", { method: "POST", body: JSON.stringify({ marketId, compare: true }) }),
  settle: (marketId: string) => call<SettleResponse>("/api/settle", { method: "POST", body: JSON.stringify({ marketId }) }),
  picks: (address: string) => call<PicksResponse>(`/api/picks?address=${encodeURIComponent(address)}`),
  submitPick: (message: string, signature: string, coach?: { suggestedPercent: number | null }) =>
    call<{ pick: PickRecord; blobId: string }>("/api/picks", { method: "POST", body: JSON.stringify({ message, signature, coach }) }),
  coach: (marketId: string, address?: string | null) =>
    call<CoachDataResponse>(`/api/picks/coach?marketId=${encodeURIComponent(marketId)}${address ? `&address=${encodeURIComponent(address)}` : ""}`),
  leaderboard: () => call<LeaderboardResponse>("/api/leaderboard"),
  timeline: () => call<import("@/lib/timeline/build").Timeline>("/api/timeline"),
};

export const SPECIALIST_LABEL: Record<SpecialistId, string> = {
  "sharp-steam": "SharpSteam",
  "power-rating": "PowerRating",
  "onchain-flow": "OnchainFlow",
  "hype-contrarian": "HypeContrarian",
  "kalshi-crowd": "KalshiCrowd",
  "manifold-crowd": "ManifoldCrowd",
  "top-pickers": "TopPickers",
};

export const DOMAIN_LABEL: Record<MarketDomain, string> = {
  NBA: "NBA",
  EPL: "EPL",
  UFC: "UFC",
  CRYPTO_MACRO: "Crypto/Macro",
};

export const pct = (p: number | null | undefined, dp = 1) =>
  p === null || p === undefined || !Number.isFinite(p) ? "—" : `${(p * 100).toFixed(dp)}%`;

export const usd = (n: number | null | undefined, dp = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `$${n.toFixed(dp)}`;

export const short = (s: string | null | undefined, head = 8, tail = 6) =>
  !s ? "—" : s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

export const suiscanTx = (digest: string) => `https://suiscan.xyz/mainnet/tx/${digest}`;
export const walruscanBlob = (blobId: string) => `https://walruscan.com/mainnet/blob/${blobId}`;
