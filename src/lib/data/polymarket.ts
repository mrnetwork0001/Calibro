/**
 * Polymarket public APIs (no key): Gamma for market metadata + resolution, CLOB for
 * hourly price history. Polymarket is Calibro's on-chain venue and its resolution is
 * the ground truth used to settle every market.
 */
import type { MarketDomain } from "../types/calibro";
import { getJson } from "./http";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

export const POLY_DOMAIN_TAGS: Record<MarketDomain, { tag: string; idPrefix: string }> = {
  NBA: { tag: "nba", idPrefix: "nba" },
  EPL: { tag: "premier-league", idPrefix: "epl" },
  UFC: { tag: "ufc", idPrefix: "ufc" },
  CRYPTO_MACRO: { tag: "crypto", idPrefix: "crypto" },
};

export interface GammaMarket {
  id: string;
  question: string;
  slug?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  endDate?: string;
  startDate?: string;
  gameStartTime?: string;
  sportsMarketType?: string;
  groupItemTitle?: string;
  active?: boolean;
  closed?: boolean;
  umaResolutionStatus?: string;
  volumeNum?: number;
  volume24hr?: number;
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
}

interface GammaEvent {
  id: string;
  title: string;
  slug?: string;
  endDate?: string;
  markets?: GammaMarket[];
}

export type PolyResolution =
  | { status: "OPEN" }
  | { status: "RESOLVED"; outcome: 0 | 1; resolvedAt?: string }
  /** Closed without a clean 1/0 payout (cancelled, 50/50, disputed) — never used for learning. */
  | { status: "VOID" };

export interface PolyMarketInfo {
  marketId: string;
  polymarketId: string;
  domain: MarketDomain;
  question: string;
  eventTitle: string;
  yesLabel: string;
  noLabel: string;
  yesTokenId: string;
  /** Sports: scheduled start. Crypto/macro: market end minus 24h (the forecast point). */
  startTime: string;
  endDate: string;
  closed: boolean;
  resolution: PolyResolution;
  /** Current YES price when open (mid of best bid/ask, else last outcome price). */
  currentPrice: number | null;
  volume: number;
  url?: string;
}

export function parseJsonArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function isoFromGamma(ts: string | undefined): string | null {
  if (!ts) return null;
  const d = new Date(ts.replace(" ", "T").replace(/\+00$/, "Z"));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export function toMarketId(domain: MarketDomain, polymarketId: string): string {
  return `poly-${POLY_DOMAIN_TAGS[domain].idPrefix}-${polymarketId}`;
}

export function parseMarketId(marketId: string): { domain: MarketDomain; polymarketId: string } | null {
  const m = /^poly-([a-z]+)-(\d+)$/.exec(marketId);
  if (!m) return null;
  const domain = (Object.keys(POLY_DOMAIN_TAGS) as MarketDomain[]).find((d) => POLY_DOMAIN_TAGS[d].idPrefix === m[1]);
  return domain ? { domain, polymarketId: m[2] } : null;
}

export function resolutionOf(m: GammaMarket): PolyResolution {
  if (!m.closed) return { status: "OPEN" };
  const prices = parseJsonArray(m.outcomePrices).map(Number);
  if (m.umaResolutionStatus === "resolved" && prices.length === 2) {
    if (prices[0] === 1 && prices[1] === 0) return { status: "RESOLVED", outcome: 1 };
    if (prices[0] === 0 && prices[1] === 1) return { status: "RESOLVED", outcome: 0 };
  }
  return { status: "VOID" };
}

/** Normalises a Gamma market into Calibro's view, or null if it isn't a usable binary market. */
export function toPolyMarketInfo(m: GammaMarket, domain: MarketDomain, eventTitle = ""): PolyMarketInfo | null {
  const outcomes = parseJsonArray(m.outcomes);
  const tokens = parseJsonArray(m.clobTokenIds);
  if (outcomes.length !== 2 || tokens.length !== 2) return null;
  const isSports = domain !== "CRYPTO_MACRO";
  if (isSports && m.sportsMarketType !== "moneyline") return null;
  if ((m.groupItemTitle ?? "").toLowerCase().startsWith("draw")) return null;

  const endDate = isoFromGamma(m.endDate) ?? "";
  const start = isSports
    ? isoFromGamma(m.gameStartTime)
    : endDate
      ? new Date(Date.parse(endDate) - 24 * 3600_000).toISOString()
      : null;
  if (!start) return null;

  // "Yes"/"No" markets (EPL "Will X win?") name the team in groupItemTitle.
  const yesIsGeneric = outcomes[0].toLowerCase() === "yes";
  const yesLabel = yesIsGeneric && isSports && m.groupItemTitle ? m.groupItemTitle : outcomes[0];
  const noLabel = yesIsGeneric && isSports ? `Not ${yesLabel}` : outcomes[1];

  let currentPrice: number | null = null;
  if (!m.closed) {
    const bid = Number(m.bestBid);
    const ask = Number(m.bestAsk);
    if (bid > 0 && ask > 0 && ask >= bid && ask - bid <= 0.1) currentPrice = (bid + ask) / 2;
    else {
      const p = Number(parseJsonArray(m.outcomePrices)[0]);
      currentPrice = Number.isFinite(p) ? p : null;
    }
  }

  return {
    marketId: toMarketId(domain, m.id),
    polymarketId: m.id,
    domain,
    question: m.question,
    eventTitle: eventTitle || m.question,
    yesLabel,
    noLabel,
    yesTokenId: tokens[0],
    startTime: start,
    endDate,
    closed: Boolean(m.closed),
    resolution: resolutionOf(m),
    currentPrice,
    volume: Number(m.volumeNum ?? 0),
    url: m.slug ? `https://polymarket.com/market/${m.slug}` : undefined,
  };
}

export async function getPolyMarket(marketId: string): Promise<PolyMarketInfo | null> {
  const parsed = parseMarketId(marketId);
  if (!parsed) return null;
  const m = await getJson<GammaMarket>(`${GAMMA}/markets/${parsed.polymarketId}`, { ttlMs: 30_000 });
  return toPolyMarketInfo(m, parsed.domain);
}

function pickPerEvent(ev: GammaEvent, domain: MarketDomain): PolyMarketInfo[] {
  const out: PolyMarketInfo[] = [];
  for (const m of ev.markets ?? []) {
    const info = toPolyMarketInfo(m, domain, ev.title);
    if (!info) continue;
    out.push(info);
    if (domain !== "CRYPTO_MACRO") break; // one moneyline per game: sides of one game are not independent
  }
  return out;
}

/** Open markets whose forecast point is still in the future (pre-game only for sports). */
export async function listOpenMarkets(domain: MarketDomain, limit = 6): Promise<PolyMarketInfo[]> {
  const { tag } = POLY_DOMAIN_TAGS[domain];
  const events = await getJson<GammaEvent[]>(
    `${GAMMA}/events?tag_slug=${tag}&active=true&closed=false&limit=40&order=volume24hr&ascending=false`,
    { ttlMs: 60_000 }
  );
  const now = Date.now();
  const out: PolyMarketInfo[] = [];
  for (const ev of events) {
    for (const info of pickPerEvent(ev, domain)) {
      if (info.closed || info.currentPrice === null) continue;
      if (!(info.currentPrice >= 0.03 && info.currentPrice <= 0.97)) continue;
      if (domain !== "CRYPTO_MACRO" && Date.parse(info.startTime) <= now) continue; // in-play: no pre-game edge
      out.push(info);
    }
  }
  return out.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)).slice(0, limit);
}

/** Cleanly resolved markets whose forecast point lies in [since, until], newest first. */
export async function listResolvedMarkets(
  domain: MarketDomain,
  options: { limit: number; since?: Date; until?: Date; minVolume?: number }
): Promise<PolyMarketInfo[]> {
  const { tag } = POLY_DOMAIN_TAGS[domain];
  const until = (options.until ?? new Date()).getTime();
  const since = options.since?.getTime() ?? 0;
  const out: PolyMarketInfo[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < 600 && out.length < options.limit; offset += 100) {
    const events = await getJson<GammaEvent[]>(
      `${GAMMA}/events?tag_slug=${tag}&closed=true&limit=100&offset=${offset}&order=endDate&ascending=false`,
      { ttlMs: 10 * 60_000 }
    );
    if (events.length === 0) break;
    for (const ev of events) {
      for (const info of pickPerEvent(ev, domain)) {
        if (info.resolution.status !== "RESOLVED" || seen.has(info.marketId)) continue;
        const t = Date.parse(info.startTime);
        if (t > until || t < since) continue;
        if ((options.minVolume ?? 0) > info.volume) continue;
        seen.add(info.marketId);
        out.push(info);
      }
    }
  }
  return out.sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime)).slice(0, options.limit);
}

export interface PricePoint {
  t: number; // unix seconds
  p: number;
}

/** Hourly YES-price history up to `endMs`. Past windows are cached forever. */
export async function getPriceHistory(tokenId: string, startMs: number, endMs: number): Promise<PricePoint[]> {
  const startTs = Math.floor(startMs / 1000);
  const endTs = Math.floor(endMs / 1000);
  const isPast = endMs < Date.now() - 10 * 60_000;
  const res = await getJson<{ history?: PricePoint[] }>(
    `${CLOB}/prices-history?market=${tokenId}&startTs=${startTs}&endTs=${endTs}&fidelity=60`,
    { ttlMs: isPast ? Infinity : 60_000 }
  );
  return (res.history ?? []).filter((x) => Number.isFinite(x.p) && Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
}

/** Last observed price at or before `atMs`, if one exists within `maxAgeMs`. */
export function priceAt(history: PricePoint[], atMs: number, maxAgeMs = 3 * 3600_000): number | null {
  let best: PricePoint | null = null;
  for (const x of history) {
    if (x.t * 1000 <= atMs) best = x;
    else break;
  }
  if (!best || atMs - best.t * 1000 > maxAgeMs) return null;
  return best.p;
}
