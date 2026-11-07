import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileReadCacheStore, invalidateReadModels, readThrough, setReadCacheStore } from "../src/lib/server/read-cache";
import { recordView } from "../src/lib/server/read-models";
import type { EpisodicPredictionRecord } from "../src/lib/types/calibro";
import { digest } from "./fixtures/digest";

describe("Shared read cache (what visitors see when Walrus is slow or down)", () => {
  beforeEach(() => setReadCacheStore(fileReadCacheStore(mkdtempSync(join(tmpdir(), "calibro-rc-")))));
  afterEach(() => setReadCacheStore(null));

  it("serves a fresh value without touching Walrus again", async () => {
    const load = vi.fn(async () => ({ games: 37 }));
    const a = await readThrough("settled", load);
    const b = await readThrough("settled", load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ value: { games: 37 }, stale: false });
    expect(b.asOf).toBe(a.asOf);
  });

  it("reloads before serving once a write has invalidated the read models", async () => {
    let games = 37;
    const load = vi.fn(async () => ({ games }));
    await readThrough("settled", load);
    games = 38; // a settlement landed on Walrus
    await invalidateReadModels();
    const after = await readThrough("settled", load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(after).toMatchObject({ value: { games: 38 }, stale: false });
  });

  it("serves the last good copy, flagged stale, when the reload fails", async () => {
    await readThrough("settled", async () => ({ games: 37 }));
    await invalidateReadModels();
    const failing = vi.fn(async () => {
      throw new Error("Walrus Memory request timed out after 15000ms during preflight GET /version");
    });
    const res = await readThrough("settled", failing);
    expect(failing).toHaveBeenCalledTimes(2); // one retry for relayer blips
    expect(res).toMatchObject({ value: { games: 37 }, stale: true });
    expect(res.error).toMatch(/timed out/);
  }, 10_000);

  it("surfaces the error when there has never been a value (no invented data)", async () => {
    await expect(
      readThrough("inventory", async () => {
        throw new Error("relayer down");
      })
    ).rejects.toThrow("relayer down");
  }, 10_000);

  it("refreshes a value older than freshMs behind the response, serving the old one meanwhile", async () => {
    let n = 0;
    const load = vi.fn(async () => ({ n: ++n }));
    await readThrough("counts", load, { freshMs: 0 });
    const served = await readThrough("counts", load, { freshMs: 0 });
    expect(served.value).toEqual({ n: 1 });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("shares one Walrus read between concurrent readers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const load = vi.fn(async () => {
      await gate;
      return { games: 37 };
    });
    const both = Promise.all([readThrough("settled", load), readThrough("settled", load)]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await both;
    expect(load).toHaveBeenCalledTimes(1);
    expect(a.value).toEqual(b.value);
  });
});

describe("Record view", () => {
  const settled = (marketId: string, outcome: 0 | 1, calibro: number, market: number, settledAt: string): EpisodicPredictionRecord => ({
    kind: "episodic_v1",
    marketId,
    domain: "NBA",
    title: `Game ${marketId}`,
    bookImpliedProb: market,
    onchainImpliedProb: market,
    calibroCalibratedProb: calibro,
    naiveEqualWeightProb: calibro,
    recommendedAction: "PASS_NO_EDGE",
    kellyFraction: 0,
    recommendedStakeUsd: 0,
    signalsUsed: [
      { specialistId: "sharp-steam", rawProbability: market, calibratedProbability: market, weight: 0.6, x402TxDigest: digest(`PAY-${marketId}`), x402Mode: "LIVE_MAINNET" },
      { specialistId: "power-rating", rawProbability: calibro, calibratedProbability: calibro, weight: 0.4, x402TxDigest: digest(`PAY2-${marketId}`), x402Mode: "LIVE_MAINNET" },
    ],
    signalsVetoed: [{ specialistId: "hype-contrarian", reason: "recalled Brier 0.310 > 0.265", savedFeeSui: "0.002" }],
    outcome,
    pnlUsd: 0,
    settledAt,
    createdAt: settledAt,
  });

  it("lists games newest first with their payments, refusals and Walrus record, and totals them", () => {
    const view = recordView([
      { blobId: "blob-a", record: settled("a", 1, 0.6, 0.5, "2026-11-01T00:00:00Z") },
      { blobId: "blob-b", record: settled("b", 0, 0.4, 0.3, "2026-11-02T00:00:00Z") },
    ]);
    expect(view.games.map((g) => g.marketId)).toEqual(["b", "a"]);
    expect(view.games[0]).toMatchObject({ postMortemBlobId: "blob-b", outcome: 0, refused: [{ specialistId: "hype-contrarian" }] });
    expect(view.games[0].paid.map((p) => p.txDigest)).toEqual([digest("PAY-b"), digest("PAY2-b")]);
    expect(view.totals.games).toBe(2);
    expect(view.totals.paidSignals).toBe(4);
    expect(view.totals.refusals).toBe(2);
    // Brier: a = (0.6-1)^2 = 0.16, b = (0.4-0)^2 = 0.16; market a = 0.25, b = 0.09
    expect(view.totals.calibroBrier).toBeCloseTo(0.16, 10);
    expect(view.totals.marketBrier).toBeCloseTo(0.17, 10);
  });
});
