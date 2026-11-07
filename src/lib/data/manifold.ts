/**
 * Manifold Markets public API — no key. Its ManifoldSports bot opens one market per NBA game
 * ("Boston Celtics at Charlotte Hornets, Nov 6") with one answer per team. A community
 * (play-money) forecast: a third-party voice Calibro scores like any other. Past prices come
 * from the bet history, so they are point-in-time.
 */
import { nameMatches } from "./espn";
import { getJson } from "./http";

const MANIFOLD = "https://api.manifold.markets/v0";

interface ManifoldMarket {
  id: string;
  question: string;
  url?: string;
  creatorUsername?: string;
  outcomeType?: string;
  closeTime?: number;
  shouldAnswersSumToOne?: boolean;
  answers?: Array<{ id: string; text: string; probability?: number }>;
}

interface Bet {
  answerId?: string;
  probAfter?: number;
  createdTime: number;
  isRedemption?: boolean;
}

export interface ManifoldQuote {
  marketId: string;
  url?: string;
  probability: number;
  reference: "BET_HISTORY" | "LIVE";
}

/** NBA only: other leagues' Manifold markets are three-way or too sparse to price exactly. */
export async function getManifoldQuote(
  yesFullName: string,
  otherFullName: string,
  startIso: string,
  asOfMs: number,
  historical: boolean
): Promise<ManifoldQuote | null> {
  const startMs = Date.parse(startIso);
  const term = encodeURIComponent(`${yesFullName} ${otherFullName}`);
  const found = await getJson<ManifoldMarket[]>(`${MANIFOLD}/search-markets?term=${term}&limit=20&sort=newest`, {
    ttlMs: historical ? Infinity : 10 * 60_000,
  }).catch(() => [] as ManifoldMarket[]);
  const candidate = found.find(
    (m) =>
      m.creatorUsername === "ManifoldSports" &&
      m.outcomeType === "MULTIPLE_CHOICE" &&
      typeof m.closeTime === "number" &&
      m.closeTime >= startMs - 6 * 3600_000 &&
      m.closeTime <= startMs + 14 * 3600_000 &&
      nameMatches(yesFullName, [m.question]) &&
      nameMatches(otherFullName, [m.question])
  );
  if (!candidate) return null;
  const market = await getJson<ManifoldMarket>(`${MANIFOLD}/market/${candidate.id}`, { ttlMs: historical ? Infinity : 5 * 60_000 }).catch(() => null);
  const answers = market?.answers ?? [];
  if (!market || answers.length !== 2 || market.shouldAnswersSumToOne === false) return null;
  const yes = answers.find((a) => nameMatches(yesFullName, [a.text]) && !nameMatches(otherFullName, [a.text]));
  if (!yes) return null;

  if (!historical) {
    const p = yes.probability;
    return p !== undefined && p > 0 && p < 1 ? { marketId: market.id, url: market.url, probability: Number(p.toFixed(4)), reference: "LIVE" } : null;
  }
  const bets = await getJson<Bet[]>(`${MANIFOLD}/bets?contractId=${market.id}&limit=50&beforeTime=${Math.floor(asOfMs)}`, { ttlMs: Infinity }).catch(
    () => [] as Bet[]
  );
  const before = bets.filter((b) => b.createdTime <= asOfMs && !b.isRedemption && typeof b.probAfter === "number" && b.answerId);
  const last = before.sort((a, b) => b.createdTime - a.createdTime)[0];
  if (!last || asOfMs - last.createdTime > 24 * 3600_000) return null;
  // Two answers that sum to one: the other answer's price is the complement.
  const p = last.answerId === yes.id ? last.probAfter! : 1 - last.probAfter!;
  if (!(p > 0 && p < 1)) return null;
  return { marketId: market.id, url: market.url, probability: Number(p.toFixed(4)), reference: "BET_HISTORY" };
}
