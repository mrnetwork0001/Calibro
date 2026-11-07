import { describe, expect, it } from "vitest";
import { forecastFromThesis, getForecast } from "../src/lib/forecast/service";
import { SyndicateEngine } from "../src/lib/orchestrator/syndicate-engine";
import { buildTimeline } from "../src/lib/timeline/build";
import { CalibroMemoryClient } from "../src/lib/walrus/memory-client";
import { decodeX402Challenge, encodeX402PaymentProof, parseX402ChallengeHeaders } from "../src/lib/x402/protocol";
import { requirePayment, type PaywallConfig } from "../src/lib/x402/paywall";
import { InMemoryReplayLedger } from "../src/lib/x402/replay-ledger";
import { REPLAY_FIXTURES, syntheticSignal } from "./fixtures/synthetic-slate";

const AGENT = "0x" + "aa".repeat(32);
const BUYER = "0x" + "bb".repeat(32);

function cfg(over: Partial<PaywallConfig> = {}): PaywallConfig {
  return {
    product: "calibro-forecast",
    marketId: "poly-nba-1",
    resource: "/api/forecast?marketId=poly-nba-1",
    recipient: AGENT,
    coinType: "0x2::sui::SUI",
    amountRaw: "10000000",
    ledger: new InMemoryReplayLedger(),
    verifier: {
      async verifyX402PaymentOnSui(p) {
        const ok = p.txDigest.startsWith("GOOD") && p.expectedSender === BUYER && p.expectedRecipient === AGENT;
        return {
          verified: ok,
          txDigest: p.txDigest,
          checkpoint: "1",
          sender: BUYER,
          recipientCreditedRaw: ok ? p.minAmountRaw : 0n,
          coinType: p.expectedCoinType,
          reason: ok ? "ok" : "not credited",
        };
      },
    },
    ...over,
  };
}

describe("Forecast paywall (x402 product)", () => {
  it("issues a calibro-forecast challenge, accepts one real-format receipt, rejects its replay", async () => {
    const c = cfg();
    const first = await requirePayment(new Request("http://x/api/forecast?marketId=poly-nba-1"), c);
    expect(first.paid).toBe(false);
    const res = (first as { response: Response }).response;
    expect(res.status).toBe(402);
    const challenge = parseX402ChallengeHeaders(res.headers)!;
    expect(challenge.specialistId).toBe("calibro-forecast");
    expect(decodeX402Challenge(challenge.challengeId)?.amountRaw).toBe("10000000");
    expect(res.headers.get("www-authenticate")).toContain(`recipient="${AGENT}"`);

    const headers = encodeX402PaymentProof({ challengeId: challenge.challengeId, txDigest: "GOOD1", payer: BUYER, network: "sui:mainnet", mode: "LIVE_MAINNET" });
    const paid = await requirePayment(new Request("http://x/api/forecast?marketId=poly-nba-1", { headers }), c);
    expect(paid).toMatchObject({ paid: true, receipt: { txDigest: "GOOD1", payer: BUYER } });
    const again = await requirePayment(new Request("http://x/api/forecast?marketId=poly-nba-1", { headers }), c);
    expect(again.paid).toBe(false);
  });

  it("won't let a specialist-signal challenge pay for a forecast", async () => {
    const c = cfg();
    const sig = await requirePayment(new Request("http://x/"), { ...cfg(), product: "sharp-steam" });
    const challenge = parseX402ChallengeHeaders((sig as { response: Response }).response.headers)!;
    const headers = encodeX402PaymentProof({ challengeId: challenge.challengeId, txDigest: "GOOD2", payer: BUYER, network: "sui:mainnet", mode: "LIVE_MAINNET" });
    const res = await requirePayment(new Request("http://x/", { headers }), c);
    expect(res.paid).toBe(false);
    expect(await (res as { response: Response }).response.json()).toMatchObject({ error: expect.stringMatching(/different product/) });
  });

  it("reuses a fresh thesis from Walrus and otherwise runs the engine once for concurrent buyers", async () => {
    const f = REPLAY_FIXTURES[0];
    const memory = new CalibroMemoryClient({ mode: "MOCK_SANDBOX" });
    let evaluations = 0;
    const engine = () => {
      evaluations++;
      return new SyndicateEngine({
        memory,
        rates: { getUsdExchangeRate: async () => ({ usdPrice: 1, source: "TATUM_V4_RATES" as const }) },
        signals: { acquireSignal: async (req) => ({ signal: syntheticSignal(req.specialistId, req.market, f.outcome), payment: { mode: "UNPAID" } }) },
      });
    };
    const [a, b] = await Promise.all([getForecast(memory, engine, f.market), getForecast(memory, engine, f.market)]);
    expect(evaluations).toBe(1);
    expect(a).toBe(b);
    expect(a.freshness).toBe("NEW");
    expect(a.sources.length).toBe(4);
    const c = await getForecast(memory, engine, f.market);
    expect(c.freshness).toBe("REUSED_FROM_WALRUS");
    expect(c.probability).toBe(a.probability);
    expect(evaluations).toBe(1);
    expect(forecastFromThesis({ ...(await memory.findMarketEpisodes(f.market.marketId)).thesis!.record }, f.market, "blob", "NEW").thesisBlobId).toBe("blob");
  });
});

describe("Learning timeline", () => {
  it("replays post-mortems into exactly the checkpoints the engine wrote, and reports the veto flip", async () => {
    const memory = new CalibroMemoryClient({ mode: "MOCK_SANDBOX" });
    const engine = new SyndicateEngine({
      memory,
      rates: { getUsdExchangeRate: async () => ({ usdPrice: 1, source: "TATUM_V4_RATES" as const }) },
      signals: {
        acquireSignal: async (req) => {
          const f = REPLAY_FIXTURES.find((x) => x.market.marketId === req.market.marketId)!;
          return { signal: syntheticSignal(req.specialistId, req.market, f.outcome), payment: { mode: "UNPAID" } };
        },
      },
    });
    const nba = REPLAY_FIXTURES.filter((f) => f.market.domain === "NBA");
    const settled: Array<{ blobId: string; record: import("../src/lib/types/calibro").EpisodicPredictionRecord }> = [];
    for (const [i, f] of nba.entries()) {
      await engine.evaluateMarket(f.market);
      const st = await engine.settleMarketAndLearn({ marketId: f.market.marketId, outcome: f.outcome });
      if (st.status !== "SETTLED") throw new Error("expected SETTLED");
      settled.push({ blobId: `pm-${i}`, record: { ...st.settled, settledAt: `2026-11-0${i + 1}T00:00:00.000Z` } });
    }
    const t = buildTimeline(settled);
    expect(t.steps.map((s) => s.marketId)).toEqual(nba.map((f) => f.market.marketId));

    // The replay must equal what the engine stored on (mock) Walrus.
    const { bySpecialist } = await memory.recallDomainCalibrations("NBA");
    for (const row of t.final.NBA!) {
      const stored = bySpecialist[row.specialistId]!;
      expect(row.brier).toBe(stored.brierScore);
      expect(row.samples).toBe(stored.sampleSize);
    }
    const flip = t.steps.find((s) => s.flips.some((f) => f.specialistId === "hype-contrarian" && f.to === "VETOED"));
    expect(flip?.index).toBe(4);
    expect(flip?.postMortemBlobId).toBe("pm-3");
    expect(t.final.NBA!.find((r) => r.specialistId === "hype-contrarian")).toMatchObject({ status: "VETOED", weight: 0 });
  });
});
