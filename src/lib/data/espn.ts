/**
 * ESPN public endpoints (no key; unofficial but stable): game lookup, the DraftKings
 * moneyline ESPN publishes (open / close / current), and ESPN's BPI matchup predictor
 * for the NBA. Past games keep their open and close lines, so these are point-in-time
 * data, not hindsight.
 */
import type { MarketDomain } from "../types/calibro";
import { getJson } from "./http";

type SportsDomain = Exclude<MarketDomain, "CRYPTO_MACRO">;

const LEAGUES: Record<SportsDomain, { site: string; core: string }> = {
  NBA: { site: "basketball/nba", core: "basketball/leagues/nba" },
  EPL: { site: "soccer/eng.1", core: "soccer/leagues/eng.1" },
  UFC: { site: "mma/ufc", core: "mma/leagues/ufc" },
};

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const CORE = "https://sports.core.api.espn.com/v2/sports";

export function isSportsDomain(d: MarketDomain): d is SportsDomain {
  return d !== "CRYPTO_MACRO";
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(fc|afc|the|city|united)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/** True when a distinctive token of `name` appears among `candidates`' tokens. */
export function nameMatches(name: string, candidates: string[]): boolean {
  const hay = new Set(candidates.flatMap(tokens));
  const want = tokens(name);
  return want.length > 0 && want.some((t) => hay.has(t));
}

interface SiteCompetitor {
  id?: string;
  homeAway?: "home" | "away";
  order?: number;
  team?: { displayName?: string; shortDisplayName?: string; name?: string; location?: string };
  athlete?: { displayName?: string; fullName?: string; shortName?: string };
}

interface SiteCompetition {
  id: string;
  date?: string;
  startDate?: string;
  competitors: SiteCompetitor[];
  status?: { type?: { completed?: boolean } };
}

interface SiteEvent {
  id: string;
  date: string;
  name: string;
  competitions: SiteCompetition[];
}

export interface EspnGame {
  domain: SportsDomain;
  eventId: string;
  competitionId: string;
  startTime: string;
  /** Side of the YES competitor. MMA has no home/away; the odds feed is mapped by athlete id. */
  yesSide: "home" | "away";
  yesCompetitorId?: string;
  /** Full display names from ESPN, e.g. "Miami Heat" */
  yesName: string;
  otherName: string;
  name: string;
}

function competitorNames(c: SiteCompetitor): string[] {
  return [
    c.team?.displayName,
    c.team?.shortDisplayName,
    c.team?.name,
    c.team?.location,
    c.athlete?.displayName,
    c.athlete?.fullName,
  ].filter((x): x is string => Boolean(x));
}

function yyyymmdd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * Finds the ESPN game for a Polymarket market: both sides must match by name and the
 * scheduled start must be within 6 hours of Polymarket's.
 */
export async function findEspnGame(
  domain: SportsDomain,
  yesName: string,
  otherName: string,
  startTimeIso: string
): Promise<EspnGame | null> {
  const startMs = Date.parse(startTimeIso);
  const isPast = startMs < Date.now() - 6 * 3600_000;
  const dates = [...new Set([yyyymmdd(startMs - 86_400_000), yyyymmdd(startMs)])];
  for (const date of dates) {
    const board = await getJson<{ events?: SiteEvent[] }>(`${SITE}/${LEAGUES[domain].site}/scoreboard?dates=${date}`, {
      ttlMs: isPast ? Infinity : 10 * 60_000,
    });
    for (const ev of board.events ?? []) {
      for (const comp of ev.competitions ?? []) {
        const when = Date.parse(comp.startDate ?? comp.date ?? ev.date);
        if (!Number.isFinite(when) || Math.abs(when - startMs) > 6 * 3600_000) continue;
        if (comp.competitors.length !== 2) continue;
        const [a, b] = comp.competitors;
        const aNames = competitorNames(a);
        const bNames = competitorNames(b);
        let yes: SiteCompetitor | null = null;
        if (nameMatches(yesName, aNames) && (!otherName || nameMatches(otherName, bNames))) yes = a;
        else if (nameMatches(yesName, bNames) && (!otherName || nameMatches(otherName, aNames))) yes = b;
        if (!yes) continue;
        const yesSide: "home" | "away" =
          yes.homeAway ?? (comp.competitors.indexOf(yes) === 0 ? "home" : "away");
        return {
          domain,
          eventId: ev.id,
          competitionId: comp.id,
          startTime: new Date(when).toISOString(),
          yesSide,
          yesCompetitorId: yes.id,
          yesName: competitorNames(yes)[0] ?? yesName,
          otherName: competitorNames(yes === a ? b : a)[0] ?? otherName,
          name: ev.name,
        };
      }
    }
  }
  return null;
}

interface CoreLine {
  moneyLine?: { decimal?: number; american?: string } | number;
}
interface CoreSideOdds {
  athlete?: { $ref?: string };
  moneyLine?: number;
  open?: CoreLine;
  close?: CoreLine;
  current?: CoreLine;
}
interface CoreOddsItem {
  provider?: { name?: string; priority?: number };
  homeTeamOdds?: CoreSideOdds;
  awayTeamOdds?: CoreSideOdds;
  homeAthleteOdds?: CoreSideOdds;
  awayAthleteOdds?: CoreSideOdds;
  drawOdds?: { moneyLine?: number };
}

export function americanToDecimal(a: number): number | null {
  if (!Number.isFinite(a) || a === 0 || Math.abs(a) < 100) return null;
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

function lineDecimal(line: CoreLine | undefined): number | null {
  const ml = line?.moneyLine;
  if (ml === undefined) return null;
  if (typeof ml === "number") return americanToDecimal(ml);
  if (ml.decimal && ml.decimal > 1) return ml.decimal;
  return ml.american ? americanToDecimal(Number(ml.american)) : null;
}

/** De-vigged probability of outcome 0 from decimal prices of all outcomes. */
export function devig(decimals: number[]): number | null {
  if (decimals.some((d) => !(d > 1))) return null;
  const inv = decimals.map((d) => 1 / d);
  const total = inv.reduce((a, b) => a + b, 0);
  return inv[0] / total;
}

export interface BookLine {
  provider: string;
  /** Decimal price for YES at the reference time (close for past games, current for upcoming). */
  yesDecimal: number;
  /** De-vigged YES probability at the reference time. */
  yesProb: number;
  /** De-vigged YES probability at the opening line, when ESPN has it. */
  yesProbOpen: number | null;
  reference: "CLOSE" | "CURRENT";
}

/** DraftKings (ESPN priority-1 provider) moneyline for the YES side, de-vigged (2- or 3-way). */
export async function getEspnBookLine(game: EspnGame): Promise<BookLine | null> {
  const isPast = Date.parse(game.startTime) < Date.now() - 6 * 3600_000;
  const url = `${CORE}/${LEAGUES[game.domain].core}/events/${game.eventId}/competitions/${game.competitionId}/odds`;
  let res: { items?: CoreOddsItem[] };
  try {
    res = await getJson(url, { ttlMs: isPast ? Infinity : 5 * 60_000 });
  } catch {
    return null;
  }
  const items = [...(res.items ?? [])].sort((a, b) => (b.provider?.priority ?? 0) - (a.provider?.priority ?? 0));
  for (const item of items) {
    const line = parseBookItem(item, game, isPast);
    if (line) return line;
  }
  return null;
}

function parseBookItem(item: CoreOddsItem, game: EspnGame, isPast: boolean): BookLine | null {
  const home = item.homeTeamOdds ?? item.homeAthleteOdds;
  const away = item.awayTeamOdds ?? item.awayAthleteOdds;
  if (!home || !away) return null;
  let yesIsHome = game.yesSide === "home";
  const homeRef = item.homeAthleteOdds?.athlete?.$ref;
  const awayRef = item.awayAthleteOdds?.athlete?.$ref;
  if (game.yesCompetitorId && (homeRef || awayRef)) {
    const idIn = (ref?: string) => Boolean(ref && new RegExp(`/athletes/${game.yesCompetitorId}(\\?|$)`).test(ref));
    if (idIn(homeRef)) yesIsHome = true;
    else if (idIn(awayRef)) yesIsHome = false;
    else return null;
  }
  const [yes, other] = yesIsHome ? [home, away] : [away, home];
  const draw = item.drawOdds?.moneyLine !== undefined ? americanToDecimal(item.drawOdds.moneyLine) : null;

  const reference: BookLine["reference"] = isPast ? "CLOSE" : "CURRENT";
  const pick = (s: CoreSideOdds) =>
    (isPast ? lineDecimal(s.close) : lineDecimal(s.current)) ??
    lineDecimal(s.close) ??
    (s.moneyLine !== undefined ? americanToDecimal(s.moneyLine) : null);
  const yesDec = pick(yes);
  const otherDec = pick(other);
  if (!yesDec || !otherDec) return null;
  const isThreeWay = game.domain === "EPL";
  if (isThreeWay && !draw) return null;
  const yesProb = devig(isThreeWay ? [yesDec, otherDec, draw!] : [yesDec, otherDec]);
  if (yesProb === null) return null;

  const yesOpen = lineDecimal(yes.open);
  const otherOpen = lineDecimal(other.open);
  // ESPN keeps no opening draw price; the current/close draw price stands in for it.
  const yesProbOpen =
    yesOpen && otherOpen ? devig(isThreeWay ? [yesOpen, otherOpen, draw!] : [yesOpen, otherOpen]) : null;

  return {
    provider: item.provider?.name ?? "ESPN BET",
    yesDecimal: Number(yesDec.toFixed(4)),
    yesProb: Number(yesProb.toFixed(4)),
    yesProbOpen: yesProbOpen === null ? null : Number(yesProbOpen.toFixed(4)),
    reference,
  };
}

interface CorePredictorSide {
  statistics?: Array<{ name?: string; value?: number; displayValue?: string }>;
}

/** ESPN BPI pre-game win probability for the YES side (NBA only). */
export async function getEspnBpi(game: EspnGame): Promise<number | null> {
  if (game.domain !== "NBA") return null;
  const isPast = Date.parse(game.startTime) < Date.now() - 6 * 3600_000;
  const url = `${CORE}/${LEAGUES.NBA.core}/events/${game.eventId}/competitions/${game.competitionId}/predictor`;
  let res: { homeTeam?: CorePredictorSide; awayTeam?: CorePredictorSide };
  try {
    res = await getJson(url, { ttlMs: isPast ? Infinity : 30 * 60_000 });
  } catch {
    return null;
  }
  const proj = (s: CorePredictorSide | undefined) => {
    const st = s?.statistics?.find((x) => x.name === "gameProjection");
    const v = st?.value ?? (st?.displayValue !== undefined ? Number(st.displayValue) : NaN);
    return Number.isFinite(v) ? v / 100 : null;
  };
  const home = proj(res.homeTeam) ?? (proj(res.awayTeam) !== null ? 1 - proj(res.awayTeam)! : null);
  if (home === null || !(home > 0 && home < 1)) return null;
  return Number((game.yesSide === "home" ? home : 1 - home).toFixed(4));
}
