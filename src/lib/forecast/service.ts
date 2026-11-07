/**
 * Calibro's own product: its calibrated forecast for a market, sold over x402.
 * A thesis Calibro wrote on Walrus in the last 15 minutes is reused; otherwise the full
 * loop runs (recall → gate → buy specialists over x402 → de-bias → Kelly) and the new
 * thesis is sealed on Walrus. Concurrent buyers of one market share one evaluation.
 */
import type { SyndicateEngine } from "../orchestrator/syndicate-engine";
import type { EpisodicPredictionRecord, MarketOpportunity, SpecialistId } from "../types/calibro";
import type { CalibroMemoryClient } from "../walrus/memory-client";

const FRESH_MS = 15 * 60_000;

export interface CalibroForecast {
  marketId: string;
  title: string;
  domain: string;
  yesLabel: string | null;
  /** Calibrated P(YES): Platt de-biased, track-record weighted */
  probability: number;
  /** Equal-weight average of the same purchased signals, for comparison */
  naiveProbability: number;
  polymarket: number;
  sportsbook: { probability: number; source: string | null } | null;
  recommendation: {
    action: "TAKE_EDGE" | "PASS_NO_EDGE";
    side?: "YES" | "NO";
    venue?: "SPORTSBOOK" | "ONCHAIN";
    decimalOdds?: number;
    netEdge?: number;
    kellyFraction: number;
  };
  sources: Array<{ specialistId: SpecialistId; weight: number; rawProbability: number; calibratedProbability: number; x402TxDigest?: string }>;
  vetoed: Array<{ specialistId: SpecialistId; reason: string }>;
  thesisBlobId: string | null;
  generatedAt: string;
  freshness: "REUSED_FROM_WALRUS" | "NEW";
}

export function forecastFromThesis(t: EpisodicPredictionRecord, market: MarketOpportunity, blobId: string | null, freshness: CalibroForecast["freshness"]): CalibroForecast {
  return {
    marketId: t.marketId,
    title: t.title,
    domain: t.domain,
    yesLabel: market.yesLabel ?? null,
    probability: t.calibroCalibratedProb,
    naiveProbability: t.naiveEqualWeightProb,
    polymarket: t.onchainImpliedProb,
    sportsbook: t.bookImpliedProb === null ? null : { probability: t.bookImpliedProb, source: market.bookSource ?? null },
    recommendation: {
      action: t.recommendedAction,
      side: t.betSide,
      venue: t.betVenue,
      decimalOdds: t.betDecimalOdds,
      netEdge: t.netEdge,
      kellyFraction: t.kellyFraction,
    },
    sources: t.signalsUsed.map((s) => ({
      specialistId: s.specialistId,
      weight: s.weight,
      rawProbability: s.rawProbability,
      calibratedProbability: s.calibratedProbability,
      x402TxDigest: s.x402TxDigest,
    })),
    vetoed: t.signalsVetoed.map((v) => ({ specialistId: v.specialistId, reason: v.reason })),
    thesisBlobId: blobId,
    generatedAt: t.createdAt,
    freshness,
  };
}

const inFlight = new Map<string, Promise<CalibroForecast>>();

export function getForecast(memory: CalibroMemoryClient, engine: () => SyndicateEngine, market: MarketOpportunity, now = new Date()): Promise<CalibroForecast> {
  const pending = inFlight.get(market.marketId);
  if (pending) return pending;
  const p = (async () => {
    const { thesis, settled } = await memory.findMarketEpisodes(market.marketId, `Domain=${market.domain} Market="${market.title}"`);
    if (thesis && !settled && now.getTime() - Date.parse(thesis.record.createdAt) < FRESH_MS) {
      return forecastFromThesis(thesis.record, market, thesis.blobId, "REUSED_FROM_WALRUS");
    }
    const ev = await engine().evaluateMarket(market);
    if (ev.acquired.length === 0) throw new Error("No specialist signal could be acquired for this market right now.");
    return forecastFromThesis(ev.thesis, market, ev.thesisWrite?.blob_id ?? null, "NEW");
  })().finally(() => inFlight.delete(market.marketId));
  inFlight.set(market.marketId, p);
  return p;
}
