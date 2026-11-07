import { describe, expect, it } from "vitest";
import { REPLAY_FIXTURES, getReplayFixture, syntheticSignal } from "./fixtures/synthetic-slate";
import type { MarketSnapshot } from "../src/lib/markets/snapshot";
import { SyndicateEngine } from "../src/lib/orchestrator/syndicate-engine";
import { computeSpecialistSignal, specialistModel } from "../src/lib/specialists/models";
import type { SuiPaymentVerificationResult } from "../src/lib/tatum/sui-rpc";
import { HttpX402SignalProvider, type TapeEvent } from "../src/lib/x402/http-signal-provider";
import { digest, digestLabel } from "./fixtures/digest";
import {
  createX402Challenge,
  decodeX402Challenge,
  encodeX402PaymentProof,
  parseX402ChallengeHeaders,
  verifyServerPayload,
} from "../src/lib/x402/protocol";
import { InMemoryReplayLedger } from "../src/lib/x402/replay-ledger";
import { handleSignalRequest, type PaidSignalBody, type SignalGateDeps } from "../src/lib/x402/signal-gate";
import type { X402Payer } from "../src/lib/x402/sui-payer";
import { CalibroMemoryClient } from "../src/lib/walrus/memory-client";

const TREASURY = "0x" + "ab".repeat(32);
const PAYER = "0x" + "cd".repeat(32);
const MARKET = REPLAY_FIXTURES[16].market; // replay-nba-07

function deps(overrides: Partial<SignalGateDeps> = {}): SignalGateDeps & { verifyCalls: number } {
  const state = { verifyCalls: 0 };
  const d: SignalGateDeps & { verifyCalls: number } = {
    treasury: TREASURY,
    coinType: "0x2::sui::SUI",
    amountRaw: "2000000",
    ledger: new InMemoryReplayLedger(),
    verifier: {
      async verifyX402PaymentOnSui(p): Promise<SuiPaymentVerificationResult> {
        state.verifyCalls++;
        d.verifyCalls = state.verifyCalls;
        const ok = digestLabel(p.txDigest).startsWith("GOOD") && p.expectedSender === PAYER;
        return {
          verified: ok,
          txDigest: p.txDigest,
          checkpoint: "123456",
          sender: PAYER,
          recipientCreditedRaw: ok ? p.minAmountRaw : 0n,
          coinType: p.expectedCoinType,
          reason: ok ? "ok" : "Recipient credited 0 < required 2000000.",
        };
      },
    },
    loadSignal: async (sid, mid) => {
      const f = getReplayFixture(mid);
      return f ? { status: "OK", signal: syntheticSignal(sid, f.market, f.outcome) } : { status: "UNKNOWN_MARKET" };
    },
    verifyCalls: 0,
    ...overrides,
  };
  return d;
}

const url = (id = "sharp-steam", marketId = MARKET.marketId) =>
  `http://calibro.test/api/signals/${id}?marketId=${encodeURIComponent(marketId)}`;

async function challengeFor(d: SignalGateDeps, id = "sharp-steam") {
  const res = await handleSignalRequest(new Request(url(id)), id, d);
  expect(res.status).toBe(402);
  return parseX402ChallengeHeaders(res.headers)!;
}

describe("HTTP 402 signal gate (server)", () => {
  it("returns 402 with MPP WWW-Authenticate and x402 X-Payment-Required for unpaid requests", async () => {
    const res = await handleSignalRequest(new Request(url()), "sharp-steam", deps());
    expect(res.status).toBe(402);
    const www = res.headers.get("www-authenticate")!;
    expect(www).toMatch(/^Payment realm="calibro-signals", protocol="mpp-sui-v1", network="sui:mainnet"/);
    expect(www).toContain(`recipient="${TREASURY}"`);
    expect(www).toContain('coinType="0x2::sui::SUI"');
    expect(www).toContain('amount="2000000"');
    expect(www).toMatch(/challengeId="v1\./);

    const x402 = JSON.parse(Buffer.from(res.headers.get("x-payment-required")!, "base64").toString("utf8"));
    expect(x402.x402Version).toBe(1);
    expect(x402.accepts[0]).toMatchObject({ scheme: "exact", network: "sui:mainnet", payTo: TREASURY, maxAmountRequired: "2000000" });
  });

  it("serves a signed signal after Tatum verification, then rejects the same digest (anti-replay)", async () => {
    const d = deps();
    const challenge = await challengeFor(d);
    const headers = encodeX402PaymentProof({ challengeId: challenge.challengeId, txDigest: digest("GOOD1"), payer: PAYER, network: "sui:mainnet", mode: "LIVE_MAINNET" });

    const ok = await handleSignalRequest(new Request(url(), { headers }), "sharp-steam", d);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as PaidSignalBody;
    expect(body.receipt).toMatchObject({ receiptMode: "LIVE_MAINNET", txDigest: digest("GOOD1"), verifiedVia: "tatum-sui-mainnet-rpc", checkpoint: "123456" });
    expect(body.signal.specialistId).toBe("sharp-steam");
    expect(verifyServerPayload({ signal: body.signal, receipt: body.receipt }, body.signature)).toBe(true);
    expect(ok.headers.get("x-payment-response")).toBeTruthy();

    const replay = await handleSignalRequest(new Request(url(), { headers }), "sharp-steam", d);
    expect(replay.status).toBe(402);
    expect(((await replay.json()) as { error: string }).error).toMatch(/already redeemed/);
    expect(d.verifyCalls).toBe(1); // replay rejected before hitting the chain
  });

  it("releases the digest when on-chain verification fails, and reports why", async () => {
    const d = deps();
    const challenge = await challengeFor(d);
    const headers = encodeX402PaymentProof({ challengeId: challenge.challengeId, txDigest: digest("BAD1"), payer: PAYER, network: "sui:mainnet", mode: "LIVE_MAINNET" });
    const res = await handleSignalRequest(new Request(url(), { headers }), "sharp-steam", d);
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/Payment not verified: Recipient credited 0/);
    expect(await d.ledger.has(`sui:${digest("BAD1")}`)).toBe(false);
  });

  it("rejects a malformed txDigest with a clean 402, without calling Tatum or touching the ledger", async () => {
    const d = deps();
    const challenge = await challengeFor(d);
    for (const bad of ["1111111111111111111111111111111111111111111", "not-a-digest", "0xabc"]) {
      const headers = encodeX402PaymentProof({ challengeId: challenge.challengeId, txDigest: bad, payer: PAYER, network: "sui:mainnet", mode: "LIVE_MAINNET" });
      const res = await handleSignalRequest(new Request(url(), { headers }), "sharp-steam", d);
      expect(res.status).toBe(402);
      expect(((await res.json()) as { error: string }).error).toMatch(/Malformed txDigest/);
      expect(await d.ledger.has(`sui:${bad}`)).toBe(false);
    }
    expect(d.verifyCalls).toBe(0);
  });

  it("rejects tampered challenges and challenges for another specialist or market", async () => {
    const d = deps();
    const challenge = await challengeFor(d);
    const tampered = challenge.challengeId.replace(/\.[^.]+$/, ".AAAA");
    expect(decodeX402Challenge(tampered)).toBeNull();

    const send = (challengeId: string, id = "sharp-steam") =>
      handleSignalRequest(
        new Request(url(id), { headers: encodeX402PaymentProof({ challengeId, txDigest: digest("GOOD2"), payer: PAYER, network: "sui:mainnet", mode: "LIVE_MAINNET" }) }),
        id,
        d
      );
    expect(((await (await send(tampered)).json()) as { error: string }).error).toMatch(/tampered/);
    expect(((await (await send(challenge.challengeId, "power-rating")).json()) as { error: string }).error).toMatch(/different product/);
  });

  it("rejects expired challenges", async () => {
    const d = deps();
    const { challenge } = createX402Challenge({
      specialistId: "sharp-steam",
      marketId: MARKET.marketId,
      recipient: TREASURY,
      ttlSeconds: 1,
      now: new Date(Date.now() - 60 * 60_000),
    });
    const res = await handleSignalRequest(
      new Request(url(), { headers: encodeX402PaymentProof({ challengeId: challenge.challengeId, txDigest: digest("GOOD3"), payer: PAYER, network: "sui:mainnet", mode: "LIVE_MAINNET" }) }),
      "sharp-steam",
      d
    );
    expect(((await res.json()) as { error: string }).error).toMatch(/expired/);
  });

  it("refuses any receipt that is not a Sui Mainnet payment", async () => {
    const d = deps();
    const c1 = await challengeFor(d);
    const fake = encodeX402PaymentProof({ challengeId: c1.challengeId, txDigest: "NOT_A_CHAIN_TX", payer: PAYER, network: "sui:mainnet", mode: "MOCK_SANDBOX" });
    const refused = await handleSignalRequest(new Request(url(), { headers: fake }), "sharp-steam", d);
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: string }).error).toMatch(/Only Sui Mainnet receipts/);
    expect(d.verifyCalls).toBe(0);
  });

  it("404s without a challenge when the vendor has no data for the market (never charged)", async () => {
    const res = await handleSignalRequest(new Request(url()), "sharp-steam", deps({
      loadSignal: async () => ({ status: "NO_DATA", reason: "no sportsbook line" }),
    }));
    expect(res.status).toBe(404);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(((await res.json()) as { code: string }).code).toBe("NO_SIGNAL");
  });

  it("returns 503 instead of an unpayable challenge when no treasury is configured", async () => {
    const res = await handleSignalRequest(new Request(url()), "sharp-steam", deps({ treasury: null }));
    expect(res.status).toBe(503);
  });

  it("404s unknown specialists and markets", async () => {
    expect((await handleSignalRequest(new Request(url("nope")), "nope", deps())).status).toBe(404);
    expect((await handleSignalRequest(new Request(url("sharp-steam", "no-such-market")), "sharp-steam", deps())).status).toBe(404);
  });
});

/** Routes fetch() calls straight into the gate handler — real HTTP semantics, no server. */
function inProcessFetch(d: SignalGateDeps): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const id = new URL(req.url).pathname.split("/").pop()!;
    return handleSignalRequest(req, id, d);
  }) as typeof fetch;
}

describe("HttpX402SignalProvider (agent buyer) end to end", () => {
  it("pays the challenge with the Sui payer and records the full tape", async () => {
    const d = deps();
    const paid: string[] = [];
    const payer: X402Payer = {
      address: PAYER,
      async pay(challenge) {
        paid.push(challenge.challengeId);
        return { txDigest: digest(`GOOD-${paid.length}`), payer: PAYER, checkpoint: "999" };
      },
    };
    const tape: TapeEvent[] = [];
    const memory = new CalibroMemoryClient({ mode: "MOCK_SANDBOX" });
    const engine = new SyndicateEngine({
      memory,
      signals: new HttpX402SignalProvider({ baseUrl: "http://calibro.test", payer, fetchImpl: inProcessFetch(d), onEvent: (e) => tape.push(e) }),
      rates: { getUsdExchangeRate: async () => ({ usdPrice: 2, source: "TATUM_V4_RATES" as const }) },
    });

    const ev = await engine.evaluateMarket(MARKET, { persistThesis: false });
    expect(ev.acquisitionErrors).toEqual([]);
    expect(ev.acquired).toHaveLength(4);
    expect(paid).toHaveLength(4);
    expect(ev.thesis.signalsUsed.every((s) => s.x402Mode === "LIVE_MAINNET" && digestLabel(s.x402TxDigest ?? "").startsWith("GOOD-"))).toBe(true);
    const kinds = tape.map((t) => t.kind);
    expect(kinds.filter((k) => k === "CHALLENGE_402")).toHaveLength(4);
    expect(kinds.filter((k) => k === "VERIFIED")).toHaveLength(4);

    // Signals equal what the vendor model produces for this market.
    const sharp = ev.acquired.find((a) => a.acquired.signal.specialistId === "sharp-steam")!;
    expect(sharp.acquired.signal.rawProbability).toBe(syntheticSignal("sharp-steam", MARKET, 1).rawProbability);
  });

  it("refuses to pay a challenge that asks more than the VoI gate approved", async () => {
    const d = deps({ amountRaw: "9000000" }); // server asks 0.009 SUI
    let paidCount = 0;
    const payer: X402Payer = { address: PAYER, pay: async () => ({ txDigest: digest(`GOOD-${++paidCount}`), payer: PAYER }) };
    const engine = new SyndicateEngine({
      memory: new CalibroMemoryClient({ mode: "MOCK_SANDBOX" }),
      signals: new HttpX402SignalProvider({ baseUrl: "http://calibro.test", payer, fetchImpl: inProcessFetch(d) }),
      rates: { getUsdExchangeRate: async () => ({ usdPrice: 2, source: "TATUM_V4_RATES" as const }) },
    });
    const ev = await engine.evaluateMarket(MARKET, { persistThesis: false });
    expect(paidCount).toBe(0);
    expect(ev.acquisitionErrors).toHaveLength(4);
    expect(ev.acquisitionErrors[0].error).toMatch(/asks 9000000 > approved 2000000/);
  });

  it("serializes live payments from one wallet (no concurrent gas-coin use)", async () => {
    const d = deps();
    let inFlight = 0;
    let maxInFlight = 0;
    const payer: X402Payer = {
      address: PAYER,
      async pay() {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { txDigest: digest(`GOOD-${Math.random()}`), payer: PAYER };
      },
    };
    const engine = new SyndicateEngine({
      memory: new CalibroMemoryClient({ mode: "MOCK_SANDBOX" }),
      signals: new HttpX402SignalProvider({ baseUrl: "http://calibro.test", payer, fetchImpl: inProcessFetch(d) }),
      rates: { getUsdExchangeRate: async () => ({ usdPrice: 2, source: "TATUM_V4_RATES" as const }) },
    });
    await engine.evaluateMarket(MARKET, { persistThesis: false });
    expect(maxInFlight).toBe(1);
  });
});

function snapshot(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const market = { ...MARKET, marketId: "poly-nba-1", source: "HISTORICAL" as const };
  return {
    market,
    info: {} as MarketSnapshot["info"],
    kalshi: null,
    manifold: null,
    asOf: "2026-11-05T02:55:00.000Z",
    onchain: { p: 0.6, p6h: 0.56, p24h: 0.5 },
    book: { provider: "DraftKings", yesDecimal: 1.62, yesProb: 0.6, yesProbOpen: 0.55, reference: "CLOSE" },
    bpi: 0.64,
    espnGame: null,
    ...over,
  };
}

describe("Specialist vendor models (real-data formulas)", () => {
  it("SharpSteam = de-vigged line + half the open→close move, capped at ±10 pts", () => {
    expect(specialistModel("sharp-steam", snapshot())!.p).toBeCloseTo(0.6 + 0.5 * 0.05, 10);
    const bigMove = snapshot({ book: { provider: "DK", yesDecimal: 1.3, yesProb: 0.75, yesProbOpen: 0.4, reference: "CLOSE" } });
    expect(specialistModel("sharp-steam", bigMove)!.p).toBeCloseTo(0.75 + 0.5 * 0.1, 10);
    expect(specialistModel("sharp-steam", snapshot({ book: null }))).toBeNull();
  });

  it("PowerRating is ESPN BPI and absent without it", () => {
    expect(specialistModel("power-rating", snapshot())!.p).toBe(0.64);
    expect(specialistModel("power-rating", snapshot({ bpi: null }))).toBeNull();
  });

  it("OnchainFlow extrapolates half the 6h move; HypeContrarian fades price and 24h move", () => {
    expect(specialistModel("onchain-flow", snapshot())!.p).toBeCloseTo(0.6 + 0.5 * 0.04, 10);
    expect(specialistModel("onchain-flow", snapshot({ onchain: { p: 0.6, p6h: null, p24h: 0.5 } }))).toBeNull();
    expect(specialistModel("hype-contrarian", snapshot())!.p).toBeCloseTo(0.5 - 0.8 * 0.1 - 0.5 * 0.1, 10);
  });

  it("clamps to [0.03, 0.97], is deterministic, and names its inputs", () => {
    const s = snapshot({ onchain: { p: 0.96, p6h: 0.6, p24h: 0.5 } });
    const a = computeSpecialistSignal("onchain-flow", s, new Date(0))!;
    expect(a.rawProbability).toBe(0.97);
    expect(computeSpecialistSignal("onchain-flow", s, new Date(0))).toEqual(a);
    expect(computeSpecialistSignal("sharp-steam", snapshot())!.rationale).toMatch(/DraftKings close line 1\.62/);
  });
});
