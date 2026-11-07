import type {
  BankrollMandateRecord,
  KellySizingDecision,
  MarketDomain,
  SpecialistCalibrationRecord,
  SpecialistId,
  X402GateDecision,
} from "../types/calibro";

const PROB_MIN = 0.005;
const PROB_MAX = 0.995;
const BASELINE_BRIER = 0.25;
const HARD_MAX_KELLY_MULTIPLIER = 0.25;
const HARD_MAX_SINGLE_STAKE_PCT = 0.05;

/**
 * Clamp probability strictly inside (0, 1) to prevent +/-Infinity in logit().
 */
export function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(PROB_MAX, Math.max(PROB_MIN, p));
}

export function logit(p: number): number {
  const c = clampProb(p);
  return Math.log(c / (1 - c));
}

export function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x > 12) return PROB_MAX;
  if (x < -12) return PROB_MIN;
  return clampProb(1 / (1 + Math.exp(-x)));
}

/**
 * Single-event or batch Brier Score in [0, 1]. Lower is sharper; 0.25 = coin flip.
 */
export function computeBrierScore(
  predictions: ReadonlyArray<{ probability: number; outcome: 0 | 1 }>
): number {
  if (predictions.length === 0) return BASELINE_BRIER;
  let sumSq = 0;
  for (const item of predictions) {
    const diff = clampProb(item.probability) - item.outcome;
    sumSq += diff * diff;
  }
  return Number((sumSq / predictions.length).toFixed(6));
}

/**
 * Default uninformative prior when Walrus Memory holds zero records for (specialist, domain).
 */
export function createColdStartCalibration(
  specialistId: SpecialistId,
  domain: MarketDomain
): SpecialistCalibrationRecord {
  return {
    kind: "calibration_v1",
    specialistId,
    domain,
    epoch: 0,
    sampleSize: 0,
    brierScore: 0.22, // optimistic exploration prior so Epoch 1 explores all 4 specialists
    alphaSlope: 1.0,
    betaIntercept: 0.0,
    x402PaidCount: 0,
    x402VetoedCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * De-bias a raw specialist probability using recalled Platt log-odds parameters:
 *   logit(p_cal) = alphaSlope * logit(p_raw) + betaIntercept
 */
export function recalibrateProbability(
  rawProbability: number,
  calibration: Pick<SpecialistCalibrationRecord, "alphaSlope" | "betaIntercept">
): number {
  const alpha = Math.min(1.5, Math.max(0.15, calibration.alphaSlope));
  const beta = Math.min(1.2, Math.max(-1.2, calibration.betaIntercept));
  return sigmoid(alpha * logit(rawProbability) + beta);
}

/**
 * Online post-mortem update after a market resolves to outcome in {0, 1}.
 * Computes exact running Brier score and nudges Platt (alphaSlope, betaIntercept)
 * via bounded log-loss gradient descent so overconfident sources shrink automatically.
 */
export function updateCalibrationOnline<
  T extends Pick<SpecialistCalibrationRecord, "epoch" | "sampleSize" | "brierScore" | "alphaSlope" | "betaIntercept" | "updatedAt">,
>(prev: T, rawProbability: number, outcome: 0 | 1): T {
  const pRaw = clampProb(rawProbability);
  const pCal = recalibrateProbability(pRaw, prev);
  const singleBrier = (pRaw - outcome) * (pRaw - outcome);

  const nextN = prev.sampleSize + 1;
  const nextBrier =
    prev.sampleSize === 0
      ? singleBrier
      : (prev.brierScore * prev.sampleSize + singleBrier) / nextN;

  // Gradient of binary cross-entropy wrt (alpha, beta) at z = alpha * x + beta:
  // dL/dz = pCal - outcome
  const x = logit(pRaw);
  const err = pCal - outcome;
  const lr = 0.08 / Math.sqrt(Math.max(1, nextN));

  const nextAlpha = Math.min(
    1.35,
    Math.max(0.2, prev.alphaSlope - lr * err * x)
  );
  const nextBeta = Math.min(
    0.85,
    Math.max(-0.85, prev.betaIntercept - lr * err * 0.5)
  );

  return {
    ...prev,
    epoch: prev.epoch + 1,
    sampleSize: nextN,
    brierScore: Number(nextBrier.toFixed(6)),
    alphaSlope: Number(nextAlpha.toFixed(4)),
    betaIntercept: Number(nextBeta.toFixed(4)),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Deterministic Value-of-Information (VoI) gate deciding whether an x402/MPP
 * micropayment is justified given the recalled calibration record on Walrus.
 */
export function shouldPayX402Gate(params: {
  calibration: SpecialistCalibrationRecord;
  mandate: BankrollMandateRecord;
  feeUsd: number;
  minExplorationSamples?: number;
  maxAcceptableBrier?: number;
}): X402GateDecision {
  const {
    calibration,
    mandate,
    feeUsd,
    minExplorationSamples = 4,
    maxAcceptableBrier = 0.265,
  } = params;

  // Exploration window: buy signal until we have >= 4 resolved domain observations
  if (calibration.sampleSize < minExplorationSamples) {
    const explorationVoi =
      mandate.bankrollUsd *
      Math.min(mandate.kellyMultiplier, HARD_MAX_KELLY_MULTIPLIER) *
      0.03;
    return {
      specialistId: calibration.specialistId,
      domain: calibration.domain,
      decision: "APPROVE_PAYMENT",
      recalledBrierScore: calibration.brierScore,
      sampleSize: calibration.sampleSize,
      expectedVoiUsd: Number(explorationVoi.toFixed(4)),
      feeUsd: Number(feeUsd.toFixed(6)),
      reason: `Exploration regime (${calibration.sampleSize}/${minExplorationSamples} samples in ${calibration.domain}) — acquiring signal to calibrate source.`,
    };
  }

  // Hard epistemic cutoff: worse than coin-flip (0.25 + margin) destroys ensemble accuracy
  if (calibration.brierScore > maxAcceptableBrier) {
    return {
      specialistId: calibration.specialistId,
      domain: calibration.domain,
      decision: "VETO_PAYMENT",
      recalledBrierScore: calibration.brierScore,
      sampleSize: calibration.sampleSize,
      expectedVoiUsd: 0,
      feeUsd: Number(feeUsd.toFixed(6)),
      reason: `Vetoed x402 payment: recalled ${calibration.domain} Brier ${calibration.brierScore.toFixed(3)} exceeds cutoff ${maxAcceptableBrier} across ${calibration.sampleSize} settled markets.`,
    };
  }

  // Brier Skill relative to 0.265 cutoff -> expected dollar VoI on active bankroll
  const brierSkill = Math.max(0, maxAcceptableBrier - calibration.brierScore);
  const effectiveKelly = Math.min(
    mandate.kellyMultiplier,
    HARD_MAX_KELLY_MULTIPLIER
  );
  const expectedVoiUsd = mandate.bankrollUsd * effectiveKelly * brierSkill * 0.6;

  if (expectedVoiUsd <= feeUsd) {
    return {
      specialistId: calibration.specialistId,
      domain: calibration.domain,
      decision: "VETO_PAYMENT",
      recalledBrierScore: calibration.brierScore,
      sampleSize: calibration.sampleSize,
      expectedVoiUsd: Number(expectedVoiUsd.toFixed(4)),
      feeUsd: Number(feeUsd.toFixed(6)),
      reason: `Vetoed x402 payment: expected VoI ($${expectedVoiUsd.toFixed(4)}) <= x402 fee ($${feeUsd.toFixed(4)}).`,
    };
  }

  return {
    specialistId: calibration.specialistId,
    domain: calibration.domain,
    decision: "APPROVE_PAYMENT",
    recalledBrierScore: calibration.brierScore,
    sampleSize: calibration.sampleSize,
    expectedVoiUsd: Number(expectedVoiUsd.toFixed(4)),
    feeUsd: Number(feeUsd.toFixed(6)),
    reason: `Approved x402 payment: recalled ${calibration.domain} Brier ${calibration.brierScore.toFixed(3)} yields +$${expectedVoiUsd.toFixed(4)} expected VoI vs $${feeUsd.toFixed(4)} fee.`,
  };
}

/**
 * Un-normalised trust weight of a source: precision rises quadratically as Brier improves
 * below 0.28, boosted once it has ≥ 4 settled samples. Shared by the aggregator and the
 * learning timeline.
 */
export function trustWeight(calibration: Pick<SpecialistCalibrationRecord, "brierScore" | "sampleSize">): number {
  const margin = Math.max(0.01, 0.28 - calibration.brierScore);
  const confidenceBoost = calibration.sampleSize >= 4 ? Math.min(1.5, 0.8 + calibration.sampleSize * 0.05) : 0.75;
  return margin * margin * confidenceBoost;
}

/**
 * Precision-weighted log-odds aggregation across unlocked specialists.
 * Also returns the naive equal-weight average for side-by-side Cold-Start comparison.
 */
export function aggregateCalibratedSignals(
  inputs: ReadonlyArray<{
    specialistId: SpecialistId;
    rawProbability: number;
    calibration: SpecialistCalibrationRecord;
  }>
): {
  calibratedConsensusProb: number;
  naiveEqualWeightProb: number;
  breakdown: Array<{
    specialistId: SpecialistId;
    rawProbability: number;
    calibratedProbability: number;
    normalizedWeight: number;
  }>;
} {
  if (inputs.length === 0) {
    return {
      calibratedConsensusProb: 0.5,
      naiveEqualWeightProb: 0.5,
      breakdown: [],
    };
  }

  const rawWeights = inputs.map(({ calibration }) => trustWeight(calibration));

  const weightSum = rawWeights.reduce((acc, w) => acc + w, 0) || 1;
  let weightedLogit = 0;
  let naiveSum = 0;

  const breakdown = inputs.map((item, idx) => {
    const normalizedWeight = rawWeights[idx] / weightSum;
    const calibratedProbability = recalibrateProbability(
      item.rawProbability,
      item.calibration
    );
    weightedLogit += normalizedWeight * logit(calibratedProbability);
    naiveSum += clampProb(item.rawProbability);

    return {
      specialistId: item.specialistId,
      rawProbability: Number(clampProb(item.rawProbability).toFixed(4)),
      calibratedProbability: Number(calibratedProbability.toFixed(4)),
      normalizedWeight: Number(normalizedWeight.toFixed(4)),
    };
  });

  return {
    calibratedConsensusProb: Number(sigmoid(weightedLogit).toFixed(4)),
    naiveEqualWeightProb: Number((naiveSum / inputs.length).toFixed(4)),
    breakdown,
  };
}

/**
 * Deterministic Fractional Kelly Gate with hard safety ceilings:
 * - Never exceeds 0.25x Kelly
 * - Never exceeds 5% of bankroll on a single market
 * - Requires net probability edge >= mandate.minEdgeThreshold
 */
export function computeFractionalKelly(params: {
  calibratedProb: number;
  decimalOdds: number;
  mandate: BankrollMandateRecord;
}): KellySizingDecision {
  const p = clampProb(params.calibratedProb);
  const decimalOdds = Math.max(1.02, params.decimalOdds);
  const impliedProb = 1 / decimalOdds;
  const netEdge = p - impliedProb;

  const minEdge = Math.max(0.01, params.mandate.minEdgeThreshold);
  if (netEdge < minEdge) {
    return {
      action: "PASS_NO_EDGE",
      calibratedProb: Number(p.toFixed(4)),
      targetMarketImpliedProb: Number(impliedProb.toFixed(4)),
      decimalOdds: Number(decimalOdds.toFixed(3)),
      netEdge: Number(netEdge.toFixed(4)),
      rawKellyFraction: 0,
      cappedKellyFraction: 0,
      stakeUsd: 0,
      reason: `Net calibrated edge ${(netEdge * 100).toFixed(2)}% is below minimum threshold ${(minEdge * 100).toFixed(2)}%.`,
    };
  }

  const b = decimalOdds - 1;
  const rawKelly = Math.max(0, (p * decimalOdds - 1) / b);
  const kellyScalar = Math.min(
    Math.max(0.05, params.mandate.kellyMultiplier),
    HARD_MAX_KELLY_MULTIPLIER
  );
  const maxPct = Math.min(
    Math.max(0.005, params.mandate.maxSingleStakePct),
    HARD_MAX_SINGLE_STAKE_PCT
  );

  const cappedKelly = Math.min(rawKelly * kellyScalar, maxPct);
  const stakeUsd = Number((params.mandate.bankrollUsd * cappedKelly).toFixed(2));

  return {
    action: "TAKE_EDGE",
    calibratedProb: Number(p.toFixed(4)),
    targetMarketImpliedProb: Number(impliedProb.toFixed(4)),
    decimalOdds: Number(decimalOdds.toFixed(3)),
    netEdge: Number(netEdge.toFixed(4)),
    rawKellyFraction: Number(rawKelly.toFixed(4)),
    cappedKellyFraction: Number(cappedKelly.toFixed(4)),
    stakeUsd,
    reason: `Calibrated edge +${(netEdge * 100).toFixed(2)}% clears gate -> ${(cappedKelly * 100).toFixed(2)}% bankroll ($${stakeUsd.toFixed(2)}).`,
  };
}
