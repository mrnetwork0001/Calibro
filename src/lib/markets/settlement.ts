/**
 * Settlement against Polymarket's own resolution: a market is settled only once Gamma
 * reports it closed with a clean 1/0 payout (UMA resolution "resolved"). Nobody types
 * an outcome in.
 */
import { getPolyMarket } from "../data/polymarket";
import type { SettlementResult, SyndicateEngine } from "../orchestrator/syndicate-engine";
import type { EpisodicPredictionRecord } from "../types/calibro";

export type SettleAttempt =
  | { status: "SETTLED"; marketId: string; outcome: 0 | 1; result: SettlementResult }
  | { status: "ALREADY_SETTLED"; marketId: string; outcome: 0 | 1; result: SettlementResult }
  | { status: "NOT_RESOLVED"; marketId: string; detail: string }
  | { status: "VOID"; marketId: string; detail: string }
  | { status: "UNKNOWN_MARKET"; marketId: string; detail: string };

export async function settleFromPolymarket(
  engine: SyndicateEngine,
  marketId: string,
  thesisHint?: Pick<EpisodicPredictionRecord, "domain" | "title">
): Promise<SettleAttempt> {
  const info = await getPolyMarket(marketId);
  if (!info) return { status: "UNKNOWN_MARKET", marketId, detail: "Not a Polymarket market id Calibro knows." };
  if (info.resolution.status === "OPEN") {
    return { status: "NOT_RESOLVED", marketId, detail: info.closed ? "Closed, awaiting UMA resolution." : "Market still open." };
  }
  if (info.resolution.status === "VOID") {
    return { status: "VOID", marketId, detail: "Closed without a clean 1/0 payout; not used for learning." };
  }
  const outcome = info.resolution.outcome;
  const domain = thesisHint?.domain ?? info.domain;
  const title = thesisHint?.title ?? info.question;
  const result = await engine.settleMarketAndLearn({
    marketId,
    outcome,
    contextQuery: `Domain=${domain} Market="${title}"`,
  });
  return result.status === "SETTLED"
    ? { status: "SETTLED", marketId, outcome, result }
    : { status: "ALREADY_SETTLED", marketId, outcome, result };
}
