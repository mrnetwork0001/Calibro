/**
 * The Odds API (THE_ODDS_API_KEY): live Pinnacle h2h prices, de-vigged. Used only for
 * upcoming games; past games use the open/close line ESPN keeps.
 */
import type { MarketDomain } from "../types/calibro";
import { devig, nameMatches } from "./espn";
import { getJson } from "./http";

const ODDS_API = "https://api.the-odds-api.com/v4";

const SPORT_KEYS: Partial<Record<MarketDomain, string>> = {
  NBA: "basketball_nba",
  EPL: "soccer_epl",
  UFC: "mma_mixed_martial_arts",
};

interface OddsEvent {
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers?: Array<{
    key: string;
    title: string;
    markets?: Array<{ key: string; outcomes: Array<{ name: string; price: number }> }>;
  }>;
}

export function hasOddsApiKey(): boolean {
  return Boolean(process.env.THE_ODDS_API_KEY?.trim());
}

/** De-vigged YES probability from Pinnacle (or the first listed book), or null. */
export async function getOddsApiLine(
  domain: MarketDomain,
  yesName: string,
  otherName: string,
  startTimeIso: string
): Promise<{ provider: string; yesDecimal: number; yesProb: number } | null> {
  const key = process.env.THE_ODDS_API_KEY?.trim();
  const sport = SPORT_KEYS[domain];
  if (!key || !sport) return null;
  // One request per sport per 5 minutes keeps the free 500-request monthly quota safe.
  const events = await getJson<OddsEvent[]>(
    `${ODDS_API}/sports/${sport}/odds?regions=eu&markets=h2h&oddsFormat=decimal&bookmakers=pinnacle&apiKey=${encodeURIComponent(key)}`,
    { ttlMs: 5 * 60_000 }
  );
  const start = Date.parse(startTimeIso);
  for (const ev of events) {
    if (Math.abs(Date.parse(ev.commence_time) - start) > 6 * 3600_000) continue;
    const yesTeam = nameMatches(yesName, [ev.home_team]) ? ev.home_team : nameMatches(yesName, [ev.away_team]) ? ev.away_team : null;
    if (!yesTeam) continue;
    const otherTeam = yesTeam === ev.home_team ? ev.away_team : ev.home_team;
    if (otherName && !nameMatches(otherName, [otherTeam])) continue;
    const book = ev.bookmakers?.find((b) => b.key === "pinnacle") ?? ev.bookmakers?.[0];
    const h2h = book?.markets?.find((m) => m.key === "h2h");
    if (!book || !h2h) continue;
    const yes = h2h.outcomes.find((o) => o.name === yesTeam);
    const rest = h2h.outcomes.filter((o) => o.name !== yesTeam);
    if (!yes) continue;
    const prob = devig([yes.price, ...rest.map((o) => o.price)]);
    if (prob === null) continue;
    return { provider: `${book.title} (The Odds API)`, yesDecimal: yes.price, yesProb: Number(prob.toFixed(4)) };
  }
  return null;
}
