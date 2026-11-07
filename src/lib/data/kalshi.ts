/**
 * Kalshi (CFTC-regulated exchange) public market data — no key. Game-winner markets for
 * the NBA, EPL and UFC, with hourly candlesticks, so past prices are point-in-time.
 * Used as a third-party "voice" whose track record Calibro measures.
 */
import type { MarketDomain } from "../types/calibro";
import { nameMatches } from "./espn";
import { getJson } from "./http";

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES: Partial<Record<MarketDomain, string>> = { NBA: "KXNBAGAME", EPL: "KXEPLGAME", UFC: "KXUFCFIGHT" };
/** Wider than this, the quote isn't a price anyone agreed on. */
const MAX_SPREAD = 0.1;

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  yes_sub_title?: string;
  occurrence_datetime?: string;
  expected_expiration_time?: string;
  close_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
}

interface Candle {
  end_period_ts: number;
  price?: { close_dollars?: string | null };
  yes_bid?: { close_dollars?: string | null };
  yes_ask?: { close_dollars?: string | null };
}

export interface KalshiQuote {
  ticker: string;
  probability: number;
  spread: number | null;
  reference: "CANDLE_CLOSE" | "LIVE_QUOTE";
}

const num = (s: string | null | undefined) => (s === null || s === undefined ? NaN : Number(s));

function mid(bid: number, ask: number): { p: number; spread: number } | null {
  if (!(bid > 0) || !(ask > 0) || ask < bid || ask - bid > MAX_SPREAD) return null;
  return { p: (bid + ask) / 2, spread: ask - bid };
}

/** Finds the Kalshi market for the YES side of a game, matched by names and time. */
async function findMarket(domain: MarketDomain, yesNames: string[], otherNames: string[], startMs: number, historical: boolean): Promise<KalshiMarket | null> {
  const series = SERIES[domain];
  if (!series) return null;
  const s = Math.floor(startMs / 1000);
  const url = historical
    ? `${KALSHI}/markets?series_ticker=${series}&status=settled&min_close_ts=${s - 6 * 3600}&max_close_ts=${s + 14 * 3600}&limit=500`
    : `${KALSHI}/markets?series_ticker=${series}&status=open&limit=500`;
  const res = await getJson<{ markets?: KalshiMarket[] }>(url, { ttlMs: historical ? Infinity : 5 * 60_000 });
  const markets = res.markets ?? [];
  const inWindow = (m: KalshiMarket) => {
    const t = Date.parse(m.occurrence_datetime ?? m.expected_expiration_time ?? "");
    return Number.isFinite(t) && t >= startMs - 6 * 3600_000 && t <= startMs + 12 * 3600_000;
  };
  const label = (m: KalshiMarket) => [m.yes_sub_title ?? "", (m.title ?? "").replace(/ wins?$/i, "")];
  for (const m of markets) {
    if (!inWindow(m) || !yesNames.some((n) => nameMatches(n, label(m)))) continue;
    if (otherNames.length > 0) {
      const siblings = markets.filter((x) => x.event_ticker === m.event_ticker && x.ticker !== m.ticker);
      if (!siblings.some((x) => otherNames.some((n) => nameMatches(n, label(x))))) continue;
    }
    return m;
  }
  return null;
}

/** Kalshi's YES probability for the game at `asOfMs` (candle close for past games, live mid otherwise). */
export async function getKalshiQuote(
  domain: MarketDomain,
  yesNames: string[],
  otherNames: string[],
  startIso: string,
  asOfMs: number,
  historical: boolean
): Promise<KalshiQuote | null> {
  const startMs = Date.parse(startIso);
  const m = await findMarket(domain, yesNames, otherNames, startMs, historical).catch(() => null);
  if (!m) return null;
  if (!historical) {
    const q = mid(num(m.yes_bid_dollars), num(m.yes_ask_dollars));
    return q ? { ticker: m.ticker, probability: Number(q.p.toFixed(4)), spread: Number(q.spread.toFixed(4)), reference: "LIVE_QUOTE" } : null;
  }
  const series = SERIES[domain]!;
  const end = Math.floor(asOfMs / 1000);
  const res = await getJson<{ candlesticks?: Candle[] }>(
    `${KALSHI}/series/${series}/markets/${m.ticker}/candlesticks?start_ts=${end - 30 * 3600}&end_ts=${end}&period_interval=60`,
    { ttlMs: Infinity }
  ).catch(() => ({ candlesticks: [] as Candle[] }));
  const candles = (res.candlesticks ?? []).filter((c) => c.end_period_ts <= end).sort((a, b) => a.end_period_ts - b.end_period_ts);
  const last = candles[candles.length - 1];
  if (!last || end - last.end_period_ts > 3 * 3600) return null;
  const q = mid(num(last.yes_bid?.close_dollars), num(last.yes_ask?.close_dollars));
  const p = q?.p ?? num(last.price?.close_dollars);
  if (!(p > 0 && p < 1)) return null;
  return { ticker: m.ticker, probability: Number(p.toFixed(4)), spread: q ? Number(q.spread.toFixed(4)) : null, reference: "CANDLE_CLOSE" };
}
