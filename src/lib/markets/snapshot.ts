/**
 * Point-in-time market snapshots: every price a forecast may use, as of one instant.
 *
 *  - LIVE (open Polymarket market): asOf = now.
 *  - HISTORICAL (resolved market): asOf = 5 minutes before the scheduled start. Only
 *    data from before that instant is used (Polymarket hourly history, the sportsbook
 *    closing line, ESPN's pre-game BPI), so training on it is not hindsight.
 *
 * The same snapshot feeds the engine's MarketOpportunity and the paid specialist
 * endpoints, so the server sells exactly the signal the client's market describes.
 */
import { SpecialistIdSchema, type MarketOpportunity } from "../types/calibro";
import { findEspnGame, getEspnBookLine, getEspnBpi, isSportsDomain, nameMatches, type BookLine, type EspnGame } from "../data/espn";
import { getKalshiQuote, type KalshiQuote } from "../data/kalshi";
import { getManifoldQuote, type ManifoldQuote } from "../data/manifold";
import { getOddsApiLine } from "../data/odds-api";
import { getPolyMarket, getPriceHistory, priceAt, type PolyMarketInfo } from "../data/polymarket";
import { availableSpecialists, specialistModel } from "../specialists/models";
import { computeAlerts } from "./alerts";

export const HISTORICAL_LEAD_MS = 5 * 60_000;

export interface MarketSnapshot {
  market: MarketOpportunity;
  info: PolyMarketInfo;
  asOf: string;
  onchain: { p: number; p6h: number | null; p24h: number | null };
  book: BookLine | null;
  bpi: number | null;
  espnGame: EspnGame | null;
  kalshi: KalshiQuote | null;
  manifold: ManifoldQuote | null;
}

/** Opponent name: the NO outcome, or for "Will X win?" markets the other side of "A vs. B". */
function opponentOf(info: PolyMarketInfo): string {
  if (!info.noLabel.startsWith("Not ")) return info.noLabel;
  const sides = info.eventTitle.split(/\s+vs\.?\s+/i).map((x) => x.trim());
  if (sides.length !== 2) return "";
  return nameMatches(info.yesLabel, [sides[0]]) ? sides[1] : sides[0];
}

export async function buildSnapshot(info: PolyMarketInfo, now: Date = new Date()): Promise<MarketSnapshot | null> {
  const historical = info.closed;
  if (historical && info.resolution.status !== "RESOLVED") return null;
  const asOfMs = historical ? Date.parse(info.startTime) - HISTORICAL_LEAD_MS : now.getTime();
  if (!historical && info.domain !== "CRYPTO_MACRO" && Date.parse(info.startTime) <= asOfMs) return null; // in-play

  const history = await getPriceHistory(info.yesTokenId, asOfMs - 30 * 3600_000, asOfMs);
  const p = historical ? priceAt(history, asOfMs) : (info.currentPrice ?? priceAt(history, asOfMs));
  if (p === null || !(p >= 0.03 && p <= 0.97)) return null;
  const onchain = {
    p: Number(p.toFixed(4)),
    p6h: priceAt(history, asOfMs - 6 * 3600_000),
    p24h: priceAt(history, asOfMs - 24 * 3600_000),
  };

  let espnGame: EspnGame | null = null;
  let book: BookLine | null = null;
  let bpi: number | null = null;
  let kalshi: KalshiQuote | null = null;
  let manifold: ManifoldQuote | null = null;
  if (isSportsDomain(info.domain)) {
    const opponent = opponentOf(info);
    espnGame = await findEspnGame(info.domain, info.yesLabel, opponent, info.startTime).catch(() => null);
    if (espnGame) {
      [book, bpi] = await Promise.all([getEspnBookLine(espnGame), getEspnBpi(espnGame)]);
    }
    if (!historical) {
      const pinnacle = await getOddsApiLine(info.domain, info.yesLabel, opponent, info.startTime).catch(() => null);
      if (pinnacle) {
        book = {
          provider: pinnacle.provider,
          yesDecimal: pinnacle.yesDecimal,
          yesProb: pinnacle.yesProb,
          yesProbOpen: book?.yesProbOpen ?? null, // opening line from ESPN when matched
          reference: "CURRENT",
        };
      }
    }
    const yesNames = [info.yesLabel, espnGame?.yesName].filter((x): x is string => Boolean(x));
    const otherNames = [opponent, espnGame?.otherName].filter((x): x is string => Boolean(x));
    [kalshi, manifold] = await Promise.all([
      getKalshiQuote(info.domain, yesNames, otherNames, info.startTime, asOfMs, historical).catch(() => null),
      info.domain === "NBA" && espnGame
        ? getManifoldQuote(espnGame.yesName, espnGame.otherName, info.startTime, asOfMs, historical).catch(() => null)
        : Promise.resolve(null),
    ]);
  }

  const asOf = new Date(asOfMs).toISOString();
  const market: MarketOpportunity = {
    marketId: info.marketId,
    domain: info.domain,
    title: info.question,
    subtitle: `YES = ${info.yesLabel} · Polymarket${historical ? ` · priced as of ${asOf.slice(0, 16).replace("T", " ")} UTC` : ""}`,
    closesAt: info.startTime,
    bookDecimalOdds: book ? book.yesDecimal : null,
    bookImpliedProb: book ? book.yesProb : null,
    onchainImpliedProb: onchain.p,
    venueLabel: book ? `${book.provider} vs Polymarket` : "Polymarket (no sportsbook line)",
    bookSource: book ? `${book.provider} (${book.reference.toLowerCase()})` : undefined,
    source: historical ? "HISTORICAL" : "LIVE",
    asOf,
    yesLabel: info.yesLabel,
    sourceUrl: info.url,
  };
  const snapshot: MarketSnapshot = { market, info, asOf, onchain, book, bpi, espnGame, kalshi, manifold };
  market.availableSignals = availableSpecialists(snapshot, SpecialistIdSchema.options);
  // TopPickers reads users' picks from Walrus when bought; it answers 404 (never charged)
  // if no picker with a record has picked the game.
  if (!historical && info.domain !== "CRYPTO_MACRO") market.availableSignals.push("top-pickers");
  market.alerts = computeAlerts({
    polymarket: onchain.p,
    book: book ? { probability: book.yesProb, provider: book.provider } : null,
    kalshi: kalshi?.probability ?? null,
    sources: market.availableSignals
      .filter((id) => id !== "hype-contrarian")
      .map((id) => specialistModel(id, snapshot)?.p)
      .filter((p): p is number => typeof p === "number"),
  });
  return snapshot;
}

const snapshotCache = new Map<string, { at: number; snap: Promise<MarketSnapshot | null> }>();
const LIVE_SNAPSHOT_TTL_MS = 60_000;

/** Snapshot by Calibro market id. Historical snapshots are immutable and cached for the process. */
export async function loadSnapshot(marketId: string): Promise<MarketSnapshot | null> {
  const hit = snapshotCache.get(marketId);
  if (hit) {
    const snap = await hit.snap;
    if (snap?.market.source === "HISTORICAL" || Date.now() - hit.at < LIVE_SNAPSHOT_TTL_MS) return snap;
  }
  const snap = (async () => {
    const info = await getPolyMarket(marketId);
    return info ? buildSnapshot(info) : null;
  })();
  snapshotCache.set(marketId, { at: Date.now(), snap });
  snap.catch(() => snapshotCache.delete(marketId));
  if (snapshotCache.size > 500) snapshotCache.delete(snapshotCache.keys().next().value!);
  return snap;
}

export function primeSnapshot(snapshot: MarketSnapshot): void {
  snapshotCache.set(snapshot.market.marketId, { at: Date.now(), snap: Promise.resolve(snapshot) });
}
