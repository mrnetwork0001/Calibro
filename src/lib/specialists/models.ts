/**
 * The 4 specialist signal vendors sold behind HTTP 402.
 *
 * Each vendor is a fixed, documented, deterministic model over real public data that
 * existed at the market's `asOf` instant. Nothing here knows the outcome. Whether a
 * vendor is any good is not asserted anywhere: Calibro measures it, per league, from
 * settled Polymarket results and writes the track record to Walrus Memory.
 *
 *  sharp-steam     DraftKings moneyline via ESPN (or Pinnacle via The Odds API for upcoming
 *                  games), de-vigged, plus half of the open→close line move ("steam").
 *  power-rating    ESPN BPI matchup predictor (NBA only).
 *  onchain-flow    Polymarket YES price plus half of its last-6h move (momentum).
 *  hype-contrarian Fades the crowd: mirrors the Polymarket favourite toward the underdog
 *                  and leans against its last-24h move. A popular retail heuristic, kept as
 *                  a real source whose (likely poor) record Calibro must learn to stop paying for.
 *  kalshi-crowd    Third-party: the Kalshi exchange's price for the same outcome (NBA, EPL, UFC).
 *  manifold-crowd  Third-party: the Manifold community forecast (play money, NBA).
 *
 * A vendor without the data it needs returns `null` and is never charged for.
 */
import { clampProb } from "../calibration/brier";
import type { MarketSnapshot } from "../markets/snapshot";
import type { SpecialistId, SpecialistSignal } from "../types/calibro";

export interface SpecialistProfile {
  id: SpecialistId;
  name: string;
  thesis: string;
  dataSource: string;
  coverage: string;
}

export const SPECIALIST_PROFILES: Record<SpecialistId, SpecialistProfile> = {
  "sharp-steam": {
    id: "sharp-steam",
    name: "SharpSteam",
    thesis: "Sportsbook moneyline, de-vigged, plus half the open→close line move",
    dataSource: "DraftKings via ESPN · Pinnacle via The Odds API (upcoming games, when keyed)",
    coverage: "NBA · EPL · UFC",
  },
  "power-rating": {
    id: "power-rating",
    name: "PowerRating",
    thesis: "ESPN BPI pre-game matchup projection",
    dataSource: "ESPN BPI predictor",
    coverage: "NBA",
  },
  "onchain-flow": {
    id: "onchain-flow",
    name: "OnchainFlow",
    thesis: "Polymarket price plus half its last-6h move (order-flow momentum)",
    dataSource: "Polymarket CLOB price history",
    coverage: "All leagues",
  },
  "hype-contrarian": {
    id: "hype-contrarian",
    name: "HypeContrarian",
    thesis: "Fades the crowd: backs the Polymarket underdog and leans against the last-24h move",
    dataSource: "Polymarket CLOB price history",
    coverage: "All leagues",
  },
  "kalshi-crowd": {
    id: "kalshi-crowd",
    name: "KalshiCrowd",
    thesis: "The Kalshi exchange price for the same outcome (third-party, CFTC-regulated)",
    dataSource: "Kalshi public market data (hourly candles; live bid/ask mid within 10 pts)",
    coverage: "NBA · EPL · UFC",
  },
  "manifold-crowd": {
    id: "manifold-crowd",
    name: "ManifoldCrowd",
    thesis: "The Manifold Markets community forecast (third-party, play money)",
    dataSource: "Manifold public API (ManifoldSports game markets, bet history)",
    coverage: "NBA",
  },
  "top-pickers": {
    id: "top-pickers",
    name: "TopPickers",
    thesis: "Calibro's own users: wallet-signed picks from people with a proven record, weighted by it. The fee is split straight into their wallets",
    dataSource: "Pick journal on Walrus (calibro:picks): pickers with ≥ 3 graded picks and Brier ≤ 0.25",
    coverage: "NBA · EPL · UFC (upcoming games)",
  },
};

const STEAM_WEIGHT = 0.5;
/** Line moves beyond ±10 pts are mostly news already in the closing line; cap the extrapolation. */
const MAX_STEAM = 0.1;
const MOMENTUM_WEIGHT = 0.5;
const CONTRARIAN_SHRINK = 0.8;
const CONTRARIAN_MOVE_WEIGHT = 0.5;

function confidenceTag(p: number): SpecialistSignal["confidenceTag"] {
  const d = Math.abs(p - 0.5);
  return d >= 0.25 ? "HIGH" : d >= 0.12 ? "MEDIUM" : "LOW";
}

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;
const pts = (d: number) => `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)} pts`;

/** Raw model output (unclamped) and a rationale naming every input, or null if no data. */
export function specialistModel(id: SpecialistId, s: MarketSnapshot): { p: number; rationale: string } | null {
  const { onchain, book, bpi, kalshi, manifold } = s;
  switch (id) {
    case "sharp-steam": {
      if (!book) return null;
      const steam =
        book.yesProbOpen === null ? 0 : Math.max(-MAX_STEAM, Math.min(MAX_STEAM, book.yesProb - book.yesProbOpen));
      return {
        p: book.yesProb + STEAM_WEIGHT * steam,
        rationale:
          `${book.provider} ${book.reference.toLowerCase()} line ${book.yesDecimal.toFixed(2)} → ${pct(book.yesProb)} de-vigged` +
          (book.yesProbOpen === null ? " (no opening line)" : `; opened ${pct(book.yesProbOpen)}, steam ${pts(steam)} × ${STEAM_WEIGHT}`),
      };
    }
    case "power-rating": {
      if (bpi === null) return null;
      return { p: bpi, rationale: `ESPN BPI projects ${s.market.yesLabel ?? "YES"} to win ${pct(bpi)}` };
    }
    case "onchain-flow": {
      if (onchain.p6h === null) return null;
      const move = onchain.p - onchain.p6h;
      return {
        p: onchain.p + MOMENTUM_WEIGHT * move,
        rationale: `Polymarket ${pct(onchain.p)}, 6h ago ${pct(onchain.p6h)}: momentum ${pts(move)} × ${MOMENTUM_WEIGHT}`,
      };
    }
    case "hype-contrarian": {
      const move = onchain.p24h === null ? 0 : onchain.p - onchain.p24h;
      return {
        p: 0.5 - CONTRARIAN_SHRINK * (onchain.p - 0.5) - CONTRARIAN_MOVE_WEIGHT * move,
        rationale:
          `Fades Polymarket ${pct(onchain.p)} toward the underdog` +
          (onchain.p24h === null ? " (no 24h history)" : ` and against its 24h move ${pts(move)}`),
      };
    }
    case "kalshi-crowd": {
      if (!kalshi) return null;
      return {
        p: kalshi.probability,
        rationale: `Kalshi ${kalshi.ticker} ${kalshi.reference === "LIVE_QUOTE" ? "bid/ask mid" : "hourly close"} ${pct(kalshi.probability)}${kalshi.spread !== null ? ` (spread ${pts(kalshi.spread)})` : ""}`,
      };
    }
    case "manifold-crowd": {
      if (!manifold) return null;
      return { p: manifold.probability, rationale: `Manifold community ${pct(manifold.probability)} (${manifold.reference === "LIVE" ? "live" : "last bet before start"})` };
    }
    case "top-pickers":
      // Read from users' picks on Walrus at request time (src/lib/picks/crowd.ts), not from market data.
      return null;
  }
}

export function availableSpecialists(s: MarketSnapshot, ids: readonly SpecialistId[]): SpecialistId[] {
  return ids.filter((id) => specialistModel(id, s) !== null);
}

export function computeSpecialistSignal(
  specialistId: SpecialistId,
  snapshot: MarketSnapshot,
  now: Date = new Date()
): SpecialistSignal | null {
  const out = specialistModel(specialistId, snapshot);
  if (!out) return null;
  const rawProbability = Number(clampProb(Math.min(0.97, Math.max(0.03, out.p))).toFixed(4));
  return {
    specialistId,
    specialistName: SPECIALIST_PROFILES[specialistId].name,
    marketId: snapshot.market.marketId,
    domain: snapshot.market.domain,
    rawProbability,
    confidenceTag: confidenceTag(rawProbability),
    rationale: `${out.rationale} (data as of ${snapshot.asOf})`,
    generatedAt: now.toISOString(),
  };
}
