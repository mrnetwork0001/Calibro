import type { CoachPick } from "@/lib/picks/coach";
import { normalizeSuiAddress } from "@/lib/tatum/sui-rpc";
import { settledGames } from "@/lib/server/read-models";
import { errorResponse, findMarket, getMemory, jsonResponse, requireLive } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET ?marketId=…[&address=0x…] — the memories the pick coach reasons over:
 * the wallet's graded picks and league calibration (calibro:picks), and the
 * price-vs-result record of every game Calibro has settled (calibro:episodic).
 * The browser runs the deterministic coach (src/lib/picks/coach.ts) as the slider moves.
 */
export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const marketId = params.get("marketId");
  const raw = params.get("address");
  if (!marketId) return jsonResponse(400, { error: "`marketId` is required." });
  if (raw && !/^0x[0-9a-fA-F]{1,64}$/.test(raw)) return jsonResponse(400, { error: "`address` must be a Sui address." });
  try {
    requireLive();
    const memory = getMemory();
    const owner = raw ? normalizeSuiAddress(raw) : null;
    const [market, settledCached, picks, scorecard] = await Promise.all([
      findMarket(marketId),
      settledGames(),
      owner ? memory.findUserPicks(owner) : Promise.resolve([]),
      owner ? memory.recallScorecardWithBlob(owner) : Promise.resolve(null),
    ]);
    if (!market) return jsonResponse(404, { error: `Unknown market ${marketId}` });
    const settled = settledCached.value;
    const graded: CoachPick[] = picks.flatMap(({ record: p }) =>
      p.outcome === undefined ? [] : [{ domain: p.domain, probability: p.probability, marketProbAtPick: p.marketProbAtPick, outcome: p.outcome }]
    );
    const league = scorecard?.record.byDomain[market.domain];
    return jsonResponse(200, {
      marketId,
      domain: market.domain,
      picks: graded,
      league: league ? { alphaSlope: league.alphaSlope, betaIntercept: league.betaIntercept, sampleSize: league.sampleSize } : null,
      scorecardBlobId: scorecard?.blobId ?? null,
      marketHistory: settled.map(({ record: r }) => ({ domain: r.domain, p: r.onchainImpliedProb, y: r.outcome! })),
      settledMarkets: settled.length,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
