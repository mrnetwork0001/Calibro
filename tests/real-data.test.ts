import { describe, expect, it, vi } from "vitest";
import { americanToDecimal, devig, nameMatches } from "../src/lib/data/espn";
import { parseMarketId, priceAt, resolutionOf, toMarketId, toPolyMarketInfo, type GammaMarket } from "../src/lib/data/polymarket";
import { SyndicateEngine } from "../src/lib/orchestrator/syndicate-engine";
import { CalibroMemoryClient } from "../src/lib/walrus/memory-client";
import { RedisReplayLedger } from "../src/lib/x402/replay-ledger";
import { REPLAY_FIXTURES, syntheticSignal } from "./fixtures/synthetic-slate";

const gamma = (over: Partial<GammaMarket> = {}): GammaMarket => ({
  id: "6409790",
  question: "Heat vs. Warriors",
  outcomes: '["Heat", "Warriors"]',
  outcomePrices: '["0", "1"]',
  clobTokenIds: '["111", "222"]',
  gameStartTime: "2026-11-06 03:00:00+00",
  endDate: "2026-11-13T03:00:00Z",
  sportsMarketType: "moneyline",
  closed: true,
  umaResolutionStatus: "resolved",
  volumeNum: 2_877_197,
  ...over,
});

describe("Polymarket normalisation", () => {
  it("round-trips market ids with the league", () => {
    expect(toMarketId("NBA", "6409790")).toBe("poly-nba-6409790");
    expect(parseMarketId("poly-epl-42")).toEqual({ domain: "EPL", polymarketId: "42" });
    expect(parseMarketId("replay-nba-07")).toBeNull();
  });

  it("only treats a clean 1/0 UMA payout as a resolution", () => {
    expect(resolutionOf(gamma())).toEqual({ status: "RESOLVED", outcome: 0 });
    expect(resolutionOf(gamma({ outcomePrices: '["1", "0"]' }))).toEqual({ status: "RESOLVED", outcome: 1 });
    expect(resolutionOf(gamma({ outcomePrices: '["0.5", "0.5"]' }))).toEqual({ status: "VOID" });
    expect(resolutionOf(gamma({ umaResolutionStatus: "proposed" }))).toEqual({ status: "VOID" });
    expect(resolutionOf(gamma({ closed: false }))).toEqual({ status: "OPEN" });
  });

  it("names the team for EPL Yes/No markets, skips draws and non-moneylines", () => {
    const epl = toPolyMarketInfo(
      gamma({ question: "Will Everton FC win on 2026-11-06?", outcomes: '["Yes", "No"]', groupItemTitle: "Everton FC" }),
      "EPL",
      "Everton FC vs. Coventry City FC"
    )!;
    expect(epl.yesLabel).toBe("Everton FC");
    expect(epl.startTime).toBe("2026-11-06T03:00:00.000Z");
    expect(toPolyMarketInfo(gamma({ groupItemTitle: "Draw (A vs. B)" }), "EPL")).toBeNull();
    expect(toPolyMarketInfo(gamma({ sportsMarketType: "spreads" }), "NBA")).toBeNull();
  });

  it("prices point-in-time: last observation at or before the instant, never after", () => {
    const h = [
      { t: 1000, p: 0.4 },
      { t: 2000, p: 0.45 },
      { t: 3000, p: 0.9 },
    ];
    expect(priceAt(h, 2_500_000, 3_600_000)).toBe(0.45);
    expect(priceAt(h, 500_000, 3_600_000)).toBeNull();
    expect(priceAt(h, 2_000_000 + 4 * 3_600_000, 3_600_000)).toBeNull(); // stale
  });
});

describe("Sportsbook maths", () => {
  it("converts American odds and removes the vig (2- and 3-way)", () => {
    expect(americanToDecimal(140)).toBeCloseTo(2.4, 10);
    expect(americanToDecimal(-167)).toBeCloseTo(1 + 100 / 167, 10);
    expect(americanToDecimal(50)).toBeNull();
    const two = devig([2.4, 1 + 100 / 167])!;
    expect(two).toBeGreaterThan(0.39);
    expect(two).toBeLessThan(0.41);
    const three = devig([1.66, 4.9, 4.1])!;
    expect(three).toBeCloseTo(1 / 1.66 / (1 / 1.66 + 1 / 4.9 + 1 / 4.1), 10);
  });

  it("matches team and fighter names across sources", () => {
    expect(nameMatches("Heat", ["Miami Heat"])).toBe(true);
    expect(nameMatches("Everton FC", ["Everton"])).toBe(true);
    expect(nameMatches("Lucia Szabová", ["Lucia Szabova"])).toBe(true);
    expect(nameMatches("Heat", ["Golden State Warriors"])).toBe(false);
  });
});

describe("Engine with real availability", () => {
  it("gates, buys and scores only the specialists that have data for the market", async () => {
    const fixture = REPLAY_FIXTURES[0];
    const market = { ...fixture.market, availableSignals: ["sharp-steam", "onchain-flow"] as const };
    const asked: string[] = [];
    const engine = new SyndicateEngine({
      memory: new CalibroMemoryClient({ mode: "MOCK_SANDBOX" }),
      rates: { getUsdExchangeRate: async () => ({ usdPrice: 1, source: "TATUM_V4_RATES" as const }) },
      signals: {
        async acquireSignal(req) {
          asked.push(req.specialistId);
          return { signal: syntheticSignal(req.specialistId, req.market, fixture.outcome), payment: { mode: "UNPAID" } };
        },
      },
    });
    const ev = await engine.evaluateMarket({ ...market, availableSignals: [...market.availableSignals] });
    expect(ev.gates.map((g) => g.specialistId)).toEqual(["sharp-steam", "onchain-flow"]);
    expect(asked.sort()).toEqual(["onchain-flow", "sharp-steam"]);
    const st = await engine.settleMarketAndLearn({ marketId: market.marketId, outcome: fixture.outcome });
    expect(st.status === "SETTLED" && st.updates.map((u) => u.specialistId).sort()).toEqual(["onchain-flow", "sharp-steam"]);
    expect(ev.thesis.marketSource).toBe("HISTORICAL");
  });
});

describe("Redis replay ledger (Upstash REST protocol)", () => {
  it("claims a digest atomically with SET NX and releases on failure", async () => {
    const store = new Map<string, string>();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const [cmd, key, val, ...rest] = JSON.parse(String(init.body)) as string[];
      let result: unknown = null;
      if (cmd === "SET") {
        if (rest.includes("NX") && store.has(key)) result = null;
        else {
          store.set(key, val);
          result = "OK";
        }
      } else if (cmd === "DEL") result = store.delete(key) ? 1 : 0;
      else if (cmd === "EXISTS") result = store.has(key) ? 1 : 0;
      return new Response(JSON.stringify({ result }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const ledger = RedisReplayLedger.fromEnv({ UPSTASH_REDIS_REST_URL: "https://redis.test/", UPSTASH_REDIS_REST_TOKEN: "t" })!;
      expect(await ledger.reserve("sui:A")).toBe(true);
      expect(await ledger.reserve("sui:A")).toBe(false);
      await ledger.release("sui:A");
      expect(await ledger.has("sui:A")).toBe(false);
      expect(await ledger.reserve("sui:A")).toBe(true);
      await ledger.commit("sui:A", { payer: "0x1" });
      expect(await ledger.reserve("sui:A")).toBe(false);
      expect(fetchMock.mock.calls[0][0]).toBe("https://redis.test");
      expect(RedisReplayLedger.fromEnv({})).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Third-party voices and disagreement alerts", () => {
  it("flags venue gaps ≥ 3 pts and a split on the favourite, without revealing source values", async () => {
    const { computeAlerts } = await import("../src/lib/markets/alerts");
    const alerts = computeAlerts({
      polymarket: 0.5,
      book: { probability: 0.57, provider: "Pinnacle" },
      kalshi: 0.52,
      sources: [0.6, 0.42],
    });
    expect(alerts.map((a) => a.kind)).toEqual(["BOOK_VS_CHAIN", "SOURCES_SPLIT"]);
    expect(alerts[0]).toMatchObject({ severity: "serious", detail: "Pinnacle 57.0% vs Polymarket 50.0% (7.0 pts)" });
    expect(alerts[1].detail).toBe("Specialists disagree on who the favourite is");
    expect(alerts[1].detail).not.toMatch(/\d/);
    expect(computeAlerts({ polymarket: 0.5, book: null, kalshi: 0.51, sources: [0.5, 0.52] })).toEqual([]);
  });

  it("KalshiCrowd and ManifoldCrowd report their venue's price, and are absent without it", async () => {
    const { specialistModel } = await import("../src/lib/specialists/models");
    const base = {
      market: { ...REPLAY_FIXTURES[0].market },
      info: {} as never,
      asOf: "2026-11-05T02:55:00.000Z",
      onchain: { p: 0.6, p6h: 0.58, p24h: 0.55 },
      book: null,
      bpi: null,
      espnGame: null,
    };
    const withVoices = {
      ...base,
      kalshi: { ticker: "KXNBAGAME-X", probability: 0.62, spread: 0.01, reference: "CANDLE_CLOSE" as const },
      manifold: { marketId: "m", probability: 0.55, reference: "BET_HISTORY" as const },
    };
    expect(specialistModel("kalshi-crowd", withVoices)!.p).toBe(0.62);
    expect(specialistModel("kalshi-crowd", withVoices)!.rationale).toMatch(/KXNBAGAME-X hourly close 62\.0% \(spread \+1\.0 pts\)/);
    expect(specialistModel("manifold-crowd", withVoices)!.p).toBe(0.55);
    expect(specialistModel("kalshi-crowd", { ...base, kalshi: null, manifold: null })).toBeNull();
    expect(specialistModel("manifold-crowd", { ...base, kalshi: null, manifold: null })).toBeNull();
  });
});
