/**
 * Pick coach: before you sign, Calibro recalls two memories from Walrus and tells you
 * what they say about the number you're about to commit to.
 *
 *  1. Your record (calibro:picks): how often your picks at this confidence actually won,
 *     shrunk toward what you said while the sample is small, and how you've done when you
 *     disagreed with the market.
 *  2. Calibro's record (calibro:episodic): how often sides priced like this one won across
 *     every game Calibro has settled.
 *
 * Pure and deterministic (runs in the browser as the slider moves). No LLM.
 */
import { recalibrateProbability } from "../calibration/brier";
import type { MarketDomain } from "../types/calibro";

/** Picks pulled toward the stated confidence by this many virtual picks while history is thin. */
export const COACH_PRIOR = 4;
/** Half-width of the confidence bucket compared against. */
const BUCKET = 0.075;
/** Minimum comparable picks before the coach suggests a number. */
export const COACH_MIN_PICKS = 3;
/** A suggestion is only offered when it moves the pick by at least this much. */
const MIN_MOVE = 0.02;
/** Following the coach = signing within this distance of its suggestion. */
export const FOLLOW_TOLERANCE = 0.02;

export interface CoachPick {
  domain: MarketDomain;
  probability: number;
  marketProbAtPick: number;
  outcome: 0 | 1;
}

export interface CoachInput {
  /** The pick on the slider, 1–99 (% that YES happens) */
  percent: number;
  domain: MarketDomain;
  yesLabel: string;
  marketProb: number;
  /** The user's graded picks */
  picks: CoachPick[];
  /** The user's Platt calibration for this league, from their scorecard */
  league?: { alphaSlope: number; betaIntercept: number; sampleSize: number } | null;
  /** Polymarket price at start and result, for every game Calibro has settled */
  marketHistory: Array<{ domain: MarketDomain; p: number; y: 0 | 1 }>;
}

export interface CoachFinding {
  kind: "YOUR_CONFIDENCE" | "YOUR_PLATT" | "YOU_VS_MARKET" | "PRICE_RECORD" | "NEED_HISTORY";
  text: string;
  n: number;
}

export interface CoachAdvice {
  /** P(YES) Calibro would sign instead, in whole percent, or null if it wouldn't move you */
  suggestedPercent: number | null;
  findings: CoachFinding[];
}

const pc = (p: number) => `${Math.round(p * 100)}%`;
const brier = (p: number, y: 0 | 1) => (p - y) ** 2;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const LEAGUE: Record<MarketDomain, string> = { NBA: "NBA", EPL: "EPL", UFC: "UFC", CRYPTO_MACRO: "crypto" };

/** Confidence in the side you back, and whether that side won. */
function sideOf(p: number, y?: 0 | 1): { conf: number; won?: boolean } {
  const backsYes = p >= 0.5;
  return { conf: backsYes ? p : 1 - p, won: y === undefined ? undefined : backsYes ? y === 1 : y === 0 };
}

export function coachPick(input: CoachInput): CoachAdvice {
  const q = Math.min(0.99, Math.max(0.01, input.percent / 100));
  const { conf } = sideOf(q);
  const backsYes = q >= 0.5;
  const sideLabel = backsYes ? input.yesLabel : `not ${input.yesLabel}`;
  const findings: CoachFinding[] = [];
  let suggestedConf: number | null = null;

  // 1. Your record at this confidence (same league first, all leagues if thin).
  const inBucket = (p: CoachPick) => Math.abs(sideOf(p.probability).conf - conf) <= BUCKET;
  const league = input.picks.filter((p) => p.domain === input.domain && inBucket(p));
  const pool = league.length >= COACH_MIN_PICKS ? league : input.picks.filter(inBucket);
  const scope = pool === league ? LEAGUE[input.domain] : "all-league";
  if (pool.length >= COACH_MIN_PICKS) {
    const wins = pool.filter((p) => sideOf(p.probability, p.outcome).won).length;
    const hit = wins / pool.length;
    const shrunk = (wins + COACH_PRIOR * conf) / (pool.length + COACH_PRIOR);
    suggestedConf = shrunk;
    findings.push({
      kind: "YOUR_CONFIDENCE",
      n: pool.length,
      text:
        `Your last ${pool.length} ${scope} picks at ${pc(conf - BUCKET)}–${pc(conf + BUCKET)} on a side won ${wins} (${pc(hit)}). ` +
        (Math.abs(shrunk - conf) < MIN_MOVE ? `That matches your ${pc(conf)}.` : `Calibro reads your ${pc(conf)} on ${sideLabel} as ${pc(shrunk)}.`),
    });
  } else if (input.league && input.league.sampleSize >= COACH_MIN_PICKS) {
    const read = recalibrateProbability(q, { alphaSlope: input.league.alphaSlope, betaIntercept: input.league.betaIntercept });
    const readConf = backsYes ? read : 1 - read;
    suggestedConf = readConf;
    findings.push({
      kind: "YOUR_PLATT",
      n: input.league.sampleSize,
      text: `From your ${input.league.sampleSize} graded ${LEAGUE[input.domain]} picks, your calibration (α ${input.league.alphaSlope.toFixed(2)}, β ${input.league.betaIntercept.toFixed(2)}) reads ${pc(conf)} on ${sideLabel} as ${pc(readConf)}.`,
    });
  } else {
    findings.push({
      kind: "NEED_HISTORY",
      n: input.picks.length,
      text: `Calibro starts coaching you on your own record after ${COACH_MIN_PICKS} graded picks at a similar confidence; you have ${pool.length}.`,
    });
  }

  // 2. Your record when you disagreed with the market.
  if (Math.abs(q - input.marketProb) >= 0.05) {
    const against = input.picks.filter((p) => Math.abs(p.probability - p.marketProbAtPick) >= 0.05);
    if (against.length >= COACH_MIN_PICKS) {
      const you = mean(against.map((p) => brier(p.probability, p.outcome)));
      const mkt = mean(against.map((p) => brier(p.marketProbAtPick, p.outcome)));
      findings.push({
        kind: "YOU_VS_MARKET",
        n: against.length,
        text:
          `You're ${Math.round(Math.abs(q - input.marketProb) * 100)} pts from Polymarket (${pc(input.marketProb)}). On your ${against.length} past picks 5+ pts off the market, ` +
          `you scored Brier ${you.toFixed(3)} against the market's ${mkt.toFixed(3)}${you < mkt ? ": your disagreements have paid off." : ": the market was sharper."}`,
      });
    }
  }

  // 3. Calibro's record: how sides priced like this one have done.
  const marketConf = Math.max(input.marketProb, 1 - input.marketProb);
  const priced = (rows: CoachInput["marketHistory"]) => rows.filter((r) => Math.abs(Math.max(r.p, 1 - r.p) - marketConf) <= BUCKET);
  const sameLeague = priced(input.marketHistory.filter((r) => r.domain === input.domain));
  const rows = sameLeague.length >= COACH_MIN_PICKS ? sameLeague : priced(input.marketHistory);
  if (rows.length >= COACH_MIN_PICKS) {
    const favWon = rows.filter((r) => (r.p >= 0.5 ? r.y === 1 : r.y === 0)).length;
    findings.push({
      kind: "PRICE_RECORD",
      n: rows.length,
      text:
        `In ${rows.length} ${rows === sameLeague ? LEAGUE[input.domain] : ""} games Calibro has settled, the side Polymarket priced at ${pc(marketConf - BUCKET)}–${pc(marketConf + BUCKET)} won ${favWon} (${pc(favWon / rows.length)}).`.replace(
          /\s{2,}/g,
          " "
        ),
    });
  }

  let suggestedPercent: number | null = null;
  if (suggestedConf !== null && Math.abs(suggestedConf - conf) >= MIN_MOVE) {
    const p = backsYes ? suggestedConf : 1 - suggestedConf;
    suggestedPercent = Math.min(99, Math.max(1, Math.round(p * 100)));
  }
  return { suggestedPercent, findings };
}
