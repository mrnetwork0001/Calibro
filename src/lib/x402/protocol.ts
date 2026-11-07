import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  X402ProductSchema,
  type X402Product,
  type X402PaymentChallenge,
  type X402PaymentProof,
} from "../types/calibro";

/**
 * HTTP 402 Payment Required for Calibro specialist signals, speaking BOTH:
 *  - MPP:  `WWW-Authenticate: Payment realm=..., protocol="mpp-sui-v1", ...`
 *  - x402: `X-Payment-Required: <base64 JSON { x402Version, accepts: [...] }>`
 *
 * The challengeId is a self-describing HMAC-signed token, so a stateless server
 * (Vercel functions) can verify a paid retry without a challenge database:
 *   v1.<base64url(payload)>.<base64url(hmac-sha256(payload))>
 */

export const X402_REALM = "calibro-signals";
export const MPP_PROTOCOL = "mpp-sui-v1";
export const DEFAULT_CHALLENGE_TTL_SECONDS = 300;

interface ChallengeTokenPayload {
  v: 1;
  sid: X402Product;
  mid: string;
  rcp: string;
  coin: string;
  amt: string;
  iat: number; // ms
  exp: number; // ms
  n: string; // nonce
  /** Split payment shares: [recipient, amountRaw] */
  spl?: Array<[string, string]>;
}

const SECRET_GLOBAL_KEY = "__calibroX402ChallengeSecret";

function challengeSecret(): Buffer {
  const fromEnv = process.env.CALIBRO_X402_CHALLENGE_SECRET?.trim();
  if (fromEnv) return Buffer.from(fromEnv, "utf8");
  // Every instance of a deployment must sign and verify challenges with the same secret,
  // or a challenge issued by one serverless instance fails on the next (the buyer pays and
  // gets nothing). Without an explicit secret, derive one from the Walrus delegate key that
  // every live instance already holds: an HMAC under a fixed label, so the key can't be
  // recovered from it and nothing else signed with that key can be forged from it.
  const memwalKey = process.env.MEMWAL_PRIVATE_KEY?.trim();
  if (memwalKey) return createHmac("sha256", memwalKey).update("calibro/x402-challenge-secret/v1").digest();
  // No keys at all (tests, unconfigured dev): random per process, kept on globalThis to
  // survive Next.js HMR. Challenges then expire on restart, which is the safe failure.
  const g = globalThis as Record<string, unknown>;
  if (!g[SECRET_GLOBAL_KEY]) g[SECRET_GLOBAL_KEY] = randomBytes(32);
  return g[SECRET_GLOBAL_KEY] as Buffer;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadB64: string): string {
  return b64url(createHmac("sha256", challengeSecret()).update(payloadB64).digest());
}

/** HMAC attestation over a served payload (e.g. a specialist signal) with the server secret. */
export function signServerPayload(payload: unknown): string {
  return sign(b64url(JSON.stringify(payload)));
}

export function verifyServerPayload(payload: unknown, signature: string): boolean {
  const expected = Buffer.from(signServerPayload(payload));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function createX402Challenge(params: {
  specialistId: X402Product;
  marketId: string;
  recipient: string;
  coinType?: string;
  amountRaw?: string;
  ttlSeconds?: number;
  resource?: string;
  now?: Date;
  /** Pay these recipients their shares in one transaction (must sum to amountRaw) */
  splits?: Array<{ recipient: string; amountRaw: string }>;
}): {
  challenge: X402PaymentChallenge;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const nowMs = (params.now ?? new Date()).getTime();
  const coinType = params.coinType ?? process.env.CALIBRO_X402_COIN_TYPE ?? "0x2::sui::SUI";
  const amountRaw = params.amountRaw ?? process.env.CALIBRO_X402_DEFAULT_PRICE_RAW ?? "2000000";
  const ttl = params.ttlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;

  const payload: ChallengeTokenPayload = {
    v: 1,
    sid: params.specialistId,
    mid: params.marketId,
    rcp: params.recipient,
    coin: coinType,
    amt: amountRaw,
    iat: nowMs,
    exp: nowMs + ttl * 1000,
    n: randomBytes(9).toString("base64url"),
    ...(params.splits?.length ? { spl: params.splits.map((s) => [s.recipient, s.amountRaw] as [string, string]) } : {}),
  };
  if (payload.spl) {
    const total = payload.spl.reduce((a, [, amt]) => a + BigInt(amt), 0n);
    if (total !== BigInt(amountRaw) || payload.spl[0][0] !== params.recipient) {
      throw new Error("Split shares must sum to amountRaw and start with the recipient.");
    }
  }
  const payloadB64 = b64url(JSON.stringify(payload));
  const challengeId = `v1.${payloadB64}.${sign(payloadB64)}`;

  const challenge: X402PaymentChallenge = {
    protocol: "x402+mpp-sui-v1",
    challengeId,
    issuedAt: new Date(payload.iat).toISOString(),
    realm: X402_REALM,
    network: "sui:mainnet",
    specialistId: params.specialistId,
    marketId: params.marketId,
    recipient: params.recipient,
    coinType,
    amountRaw,
    expiresAt: new Date(payload.exp).toISOString(),
    ...(params.splits?.length ? { splits: params.splits } : {}),
  };

  const x402Payload = {
    x402Version: 1,
    error: params.specialistId === "calibro-forecast" ? "Payment required to unlock Calibro's calibrated forecast" : "Payment required to unlock this specialist signal",
    accepts: [
      {
        scheme: "exact",
        network: "sui:mainnet",
        maxAmountRequired: amountRaw,
        payTo: params.recipient,
        asset: coinType,
        resource: params.resource ?? `/api/signals/${params.specialistId}?marketId=${encodeURIComponent(params.marketId)}`,
        description:
          params.specialistId === "calibro-forecast"
            ? `Calibro calibrated forecast on ${params.marketId}`
            : `Calibro specialist signal: ${params.specialistId} on ${params.marketId}`,
        mimeType: "application/json",
        maxTimeoutSeconds: ttl,
        extra: { challenge },
      },
    ],
  };

  const wwwAuthenticate = [
    `Payment realm="${X402_REALM}"`,
    `protocol="${MPP_PROTOCOL}"`,
    `network="sui:mainnet"`,
    `recipient="${challenge.recipient}"`,
    `coinType="${challenge.coinType}"`,
    `amount="${challenge.amountRaw}"`,
    `challengeId="${challenge.challengeId}"`,
    `expiresAt="${challenge.expiresAt}"`,
    ...(challenge.splits ? [`splits="${challenge.splits.map((s) => `${s.recipient}:${s.amountRaw}`).join(",")}"`] : []),
  ].join(", ");

  return {
    challenge,
    headers: {
      "WWW-Authenticate": wwwAuthenticate,
      "X-Payment-Required": Buffer.from(JSON.stringify(x402Payload), "utf8").toString("base64"),
      "Cache-Control": "no-store",
    },
    body: x402Payload,
  };
}

/**
 * Verifies a challengeId's signature and decodes it. Returns null for tampered,
 * malformed, or foreign tokens. Does NOT check expiry (callers decide grace).
 */
export function decodeX402Challenge(challengeId: string): X402PaymentChallenge | null {
  const parts = challengeId.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payloadB64, sig] = parts;
  const expected = Buffer.from(sign(payloadB64));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  let payload: ChallengeTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as ChallengeTokenPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1 || !X402ProductSchema.safeParse(payload.sid).success) return null;

  return {
    protocol: "x402+mpp-sui-v1",
    challengeId,
    issuedAt: new Date(payload.iat).toISOString(),
    realm: X402_REALM,
    network: "sui:mainnet",
    specialistId: payload.sid,
    marketId: payload.mid,
    recipient: payload.rcp,
    coinType: payload.coin,
    amountRaw: payload.amt,
    expiresAt: new Date(payload.exp).toISOString(),
    ...(Array.isArray(payload.spl) && payload.spl.length
      ? { splits: payload.spl.map(([recipient, amountRaw]) => ({ recipient, amountRaw })) }
      : {}),
  };
}

/** Client side: extract the challenge from a 402 response's headers. */
export function parseX402ChallengeHeaders(headers: Headers): X402PaymentChallenge | null {
  const raw = headers.get("x-payment-required");
  if (raw) {
    try {
      const parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
        accepts?: Array<{ extra?: { challenge?: X402PaymentChallenge } }>;
      };
      const c = parsed.accepts?.[0]?.extra?.challenge;
      if (c?.challengeId) return c;
    } catch {
      // fall through to MPP header
    }
  }
  const www = headers.get("www-authenticate");
  const match = www?.match(/challengeId="([^"]+)"/);
  return match ? decodeX402Challenge(match[1]) : null;
}

export function encodeX402PaymentProof(proof: X402PaymentProof): {
  Authorization: string;
  "X-Payment": string;
} {
  const b64 = Buffer.from(JSON.stringify(proof), "utf8").toString("base64");
  return {
    Authorization: `Payment ${b64}`,
    "X-Payment": b64,
  };
}

export function parseX402PaymentHeader(headers: Headers): X402PaymentProof | null {
  const xPayment = headers.get("x-payment");
  const auth = headers.get("authorization");

  let b64: string | null = null;
  if (xPayment) {
    b64 = xPayment.trim();
  } else if (auth && /^payment\s+/i.test(auth)) {
    b64 = auth.replace(/^payment\s+/i, "").trim();
  }
  if (!b64) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(b64, "base64").toString("utf8")
    ) as Partial<X402PaymentProof>;
    if (!parsed.txDigest || !parsed.challengeId || !parsed.payer) {
      return null;
    }
    return {
      challengeId: parsed.challengeId,
      txDigest: parsed.txDigest,
      payer: parsed.payer,
      network: "sui:mainnet",
      mode: parsed.mode === "MOCK_SANDBOX" ? "MOCK_SANDBOX" : "LIVE_MAINNET",
    };
  } catch {
    return null;
  }
}

/** Sandbox receipts carry an obviously non-chain digest so nothing can mistake them for Mainnet. */
