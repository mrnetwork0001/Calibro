/**
 * Deterministic grading of user picks — the same Brier and Platt maths the specialists
 * are held to. No LLM: every number and every sentence below is computed.
 */
import { computeBrierScore, updateCalibrationOnline } from "../calibration/brier";
import type { MarketDomain, PickRecord, ScorecardRecord, UserLeagueCalibration } from "../types/calibro";
import { FOLLOW_TOLERANCE } from "./coach";

/** Prior weight (in picks) pulling a small sample's hit rate toward the stated confidence. */
const FAVOURITE_PRIOR = 4;
const FAVOURITE_MIN_CONF = 0.6;

export function emptyScorecard(owner: string, now = new Date()): ScorecardRecord {
  return {
    kind: "scorecard_v1",
    owner,
    epoch: 0,
    graded: 0,
    brier: 0,
    marketBrier: 0,
    calibroBrier: null,
    calibroCompared: 0,
    byDomain: {},
    favourites: { n: 0, statedSum: 0, wins: 0, statedAvg: 0, hitRate: 0, adjusted: 0 },
    gradedMarketIds: [],
    updatedAt: now.toISOString(),
  };
}

export function gradePick(pick: PickRecord, outcome: 0 | 1, calibroProb: number | null, now = new Date()): PickRecord {
  return {
    ...pick,
    outcome,
    brier: computeBrierScore([{ probability: pick.probability, outcome }]),
    marketBrier: computeBrierScore([{ probability: pick.marketProbAtPick, outcome }]),
    calibroProb,
    gradedAt: now.toISOString(),
  };
}

const runningMean = (prev: number, n: number, x: number) => (prev * n + x) / (n + 1);

/** Folds one graded pick into the user's scorecard. Idempotent per market. */
export function applyGradedPick(card: ScorecardRecord, graded: PickRecord, now = new Date()): ScorecardRecord {
  if (graded.outcome === undefined || graded.brier === undefined || graded.marketBrier === undefined) {
    throw new Error("applyGradedPick needs a graded pick.");
  }
  if (card.gradedMarketIds.includes(graded.marketId)) return card;
  const y = graded.outcome;
  const n = card.graded;

  const prevLeague: UserLeagueCalibration = card.byDomain[graded.domain] ?? {
    domain: graded.domain,
    epoch: 0,
    sampleSize: 0,
    brierScore: 0,
    alphaSlope: 1,
    betaIntercept: 0,
    marketBrier: 0,
    updatedAt: now.toISOString(),
  };
  const league = {
    ...updateCalibrationOnline(prevLeague, graded.probability, y),
    marketBrier: Number(runningMean(prevLeague.marketBrier, prevLeague.sampleSize, graded.marketBrier).toFixed(6)),
    updatedAt: now.toISOString(),
  };

  let calibroBrier = card.calibroBrier;
  let calibroCompared = card.calibroCompared;
  if (typeof graded.calibroProb === "number") {
    const b = computeBrierScore([{ probability: graded.calibroProb, outcome: y }]);
    calibroBrier = Number(runningMean(calibroBrier ?? 0, calibroCompared, b).toFixed(6));
    calibroCompared += 1;
  }

  // Favourite-side confidence vs how often that side won.
  const conf = Math.max(graded.probability, 1 - graded.probability);
  const won = (graded.probability >= 0.5 && y === 1) || (graded.probability < 0.5 && y === 0) ? 1 : 0;
  let favourites = card.favourites;
  if (conf >= FAVOURITE_MIN_CONF) {
    const fn = favourites.n + 1;
    const statedSum = favourites.statedSum + conf;
    const wins = favourites.wins + won;
    const statedAvg = statedSum / fn;
    favourites = {
      n: fn,
      statedSum: Number(statedSum.toFixed(6)),
      wins,
      statedAvg: Number(statedAvg.toFixed(6)),
      hitRate: Number((wins / fn).toFixed(6)),
      adjusted: Number(((wins + FAVOURITE_PRIOR * statedAvg) / (fn + FAVOURITE_PRIOR)).toFixed(6)),
    };
  }

  let coach = card.coach ?? { followed: { n: 0, brierSum: 0 }, ignored: { n: 0, brierSum: 0 } };
  const suggestion = graded.coach?.suggestedProbability;
  if (typeof suggestion === "number") {
    const key = Math.abs(graded.probability - suggestion) <= FOLLOW_TOLERANCE + 1e-9 ? "followed" : "ignored";
    coach = { ...coach, [key]: { n: coach[key].n + 1, brierSum: Number((coach[key].brierSum + graded.brier).toFixed(6)) } };
  }

  return {
    ...card,
    coach,
    epoch: card.epoch + 1,
    graded: n + 1,
    brier: Number(runningMean(card.brier, n, graded.brier).toFixed(6)),
    marketBrier: Number(runningMean(card.marketBrier, n, graded.marketBrier).toFixed(6)),
    calibroBrier,
    calibroCompared,
    byDomain: { ...card.byDomain, [graded.domain]: league },
    favourites,
    gradedMarketIds: [...card.gradedMarketIds, graded.marketId].slice(-500),
    updatedAt: now.toISOString(),
  };
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Plain-language findings, each derived from the numbers in the scorecard. */
export function scorecardInsights(card: ScorecardRecord): string[] {
  if (card.graded === 0) return ["No graded picks yet. Picks are graded when Polymarket resolves the game."];
  const out: string[] = [];
  const vsMarket = card.brier - card.marketBrier;
  out.push(
    `Brier ${card.brier.toFixed(3)} over ${card.graded} pick${card.graded === 1 ? "" : "s"}; the Polymarket price at the moment you picked scored ${card.marketBrier.toFixed(3)} on the same games` +
      (Math.abs(vsMarket) < 0.005 ? " (level)." : vsMarket < 0 ? " — you beat it." : " — the market was sharper.")
  );
  for (const [domain, c] of Object.entries(card.byDomain) as Array<[MarketDomain, UserLeagueCalibration]>) {
    if (c.sampleSize >= 3) out.push(`${domain}: Brier ${c.brierScore.toFixed(3)} over ${c.sampleSize} picks (market ${c.marketBrier.toFixed(3)}).`);
  }
  const f = card.favourites;
  if (f.n >= 3) {
    const gap = f.statedAvg - f.hitRate;
    if (gap > 0.05) {
      out.push(
        `Overconfident on favourites: you average ${pct(f.statedAvg)} but those sides won ${pct(f.hitRate)} of ${f.n}. Calibro would shrink your ${pct(f.statedAvg)} to ${pct(f.adjusted)}.`
      );
    } else if (gap < -0.05) {
      out.push(`Underconfident on favourites: you average ${pct(f.statedAvg)} and those sides won ${pct(f.hitRate)} of ${f.n}. You could back them harder (≈ ${pct(f.adjusted)}).`);
    } else {
      out.push(`Well calibrated on favourites: ${pct(f.statedAvg)} stated, ${pct(f.hitRate)} won over ${f.n} picks.`);
    }
  }
  const c = card.coach;
  if (c && c.followed.n + c.ignored.n >= 2) {
    const f = c.followed.n ? (c.followed.brierSum / c.followed.n).toFixed(3) : "—";
    const i = c.ignored.n ? (c.ignored.brierSum / c.ignored.n).toFixed(3) : "—";
    out.push(`Coach: when you followed its suggestion (${c.followed.n} picks) you scored Brier ${f}; when you didn't (${c.ignored.n}), ${i}.`);
  }
  if (card.calibroCompared >= 3 && card.calibroBrier !== null) {
    out.push(`On the ${card.calibroCompared} games Calibro also forecast, Calibro scored ${card.calibroBrier.toFixed(3)}.`);
  }
  return out;
}
