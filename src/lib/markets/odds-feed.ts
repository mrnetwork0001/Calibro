/**
 * Market feed: real Polymarket markets only.
 *  - live:     open, pre-game markets priced now
 *  - resolved: recently resolved markets priced as of their scheduled start, which the
 *              terminal can evaluate point-in-time and settle against the real result
 * Sportsbook prices come from ESPN (DraftKings) or The Odds API (Pinnacle) and are never
 * synthesised: a market without a matched line carries `bookImpliedProb: null`.
 */
import { mapLimit } from "../data/http";
import { hasOddsApiKey } from "../data/odds-api";
import { listOpenMarkets, listResolvedMarkets, type PolyMarketInfo } from "../data/polymarket";
import type { MarketDomain, MarketOpportunity } from "../types/calibro";
import { buildSnapshot, loadSnapshot, primeSnapshot, type MarketSnapshot } from "./snapshot";

const FEED_TTL_MS = 60_000;
const LIVE_DOMAINS: MarketDomain[] = ["NBA", "EPL", "UFC", "CRYPTO_MACRO"];
const RESOLVED_DOMAINS: MarketDomain[] = ["NBA", "EPL", "UFC"];

export interface MarketFeed {
  markets: MarketOpportunity[];
  sources: {
    polymarket: { ok: boolean; live: number; resolved: number; error?: string };
    sportsbook: { espnMatched: number; oddsApiEnabled: boolean };
  };
  fetchedAt: string;
}

async function snapshotsFor(infos: PolyMarketInfo[]): Promise<MarketSnapshot[]> {
  const snaps = await mapLimit(infos, 4, (info) => buildSnapshot(info).catch(() => null));
  const ok = snaps.filter((s): s is MarketSnapshot => s !== null);
  ok.forEach(primeSnapshot);
  return ok;
}

let cache: { at: number; feed: Promise<MarketFeed> } | null = null;

export async function getMarketFeed(): Promise<MarketFeed> {
  if (cache && Date.now() - cache.at < FEED_TTL_MS) return cache.feed;
  const feed = (async (): Promise<MarketFeed> => {
    const polymarket: MarketFeed["sources"]["polymarket"] = { ok: false, live: 0, resolved: 0 };
    let live: MarketSnapshot[] = [];
    let resolved: MarketSnapshot[] = [];
    try {
      const [openInfos, resolvedInfos] = await Promise.all([
        Promise.all(LIVE_DOMAINS.map((d) => listOpenMarkets(d, 5).catch(() => []))),
        Promise.all(
          RESOLVED_DOMAINS.map((d) =>
            listResolvedMarkets(d, { limit: 4, since: new Date(Date.now() - 10 * 86_400_000) }).catch(() => [])
          )
        ),
      ]);
      [live, resolved] = await Promise.all([snapshotsFor(openInfos.flat()), snapshotsFor(resolvedInfos.flat())]);
      polymarket.ok = true;
      polymarket.live = live.length;
      polymarket.resolved = resolved.length;
    } catch (err) {
      polymarket.error = (err as Error).message;
    }
    const all = [...live, ...resolved];
    return {
      markets: all.map((s) => s.market),
      sources: {
        polymarket,
        sportsbook: { espnMatched: all.filter((s) => s.book).length, oddsApiEnabled: hasOddsApiKey() },
      },
      fetchedAt: new Date().toISOString(),
    };
  })();
  cache = { at: Date.now(), feed };
  feed.catch(() => (cache = null));
  return feed;
}

export async function findMarket(marketId: string): Promise<MarketOpportunity | undefined> {
  return (await loadSnapshot(marketId))?.market;
}
