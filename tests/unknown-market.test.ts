import { afterEach, describe, expect, it, vi } from "vitest";
import { getPolyMarket } from "../src/lib/data/polymarket";

describe("Unknown markets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null when Polymarket has no such market, so routes answer 404 instead of 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    await expect(getPolyMarket("poly-nba-999999901")).resolves.toBeNull();
  });

  it("still fails loudly when Polymarket itself is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    await expect(getPolyMarket("poly-nba-999999902")).rejects.toThrow();
  }, 30_000);
});
