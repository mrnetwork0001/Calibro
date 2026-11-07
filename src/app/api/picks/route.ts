import { PickError, submitPick } from "@/lib/picks/service";
import { scorecardInsights } from "@/lib/picks/scorecard";
import { qualifies, TOP_PICKERS_MAX_BRIER, TOP_PICKERS_MIN_GRADED } from "@/lib/picks/crowd";
import { normalizeSuiAddress } from "@/lib/tatum/sui-rpc";
import { errorResponse, getMemory, jsonResponse, requireLive } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST { message, signature } — a wallet-signed pick, sealed on Walrus before the game. Public. */
export async function POST(request: Request): Promise<Response> {
  let body: { message?: string; signature?: string; coach?: { suggestedPercent?: unknown } };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: "Body must be JSON: { message, signature }" });
  }
  try {
    requireLive();
    const { pick, blobId } = await submitPick(getMemory(), {
      message: body.message ?? "",
      signature: body.signature ?? "",
      coach: body.coach && typeof body.coach === "object" ? body.coach : undefined,
    });
    return jsonResponse(201, { pick, blobId });
  } catch (err) {
    if (err instanceof PickError) return jsonResponse(err.status, { error: err.message });
    return errorResponse(err);
  }
}

/** GET ?address=0x… — that wallet's picks (open + graded), scorecard and computed insights. */
export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("address");
  if (!raw || !/^0x[0-9a-fA-F]{1,64}$/.test(raw)) return jsonResponse(400, { error: "`address` must be a Sui address." });
  try {
    requireLive();
    const owner = normalizeSuiAddress(raw);
    const memory = getMemory();
    const [picks, scorecard, payouts] = await Promise.all([memory.findUserPicks(owner), memory.recallScorecard(owner), memory.findUserPayouts(owner)]);
    const qualified = qualifies(scorecard);
    return jsonResponse(200, {
      owner,
      picks,
      scorecard,
      insights: scorecard ? scorecardInsights(scorecard) : [],
      payouts,
      earnedRaw: payouts.reduce((a, p) => a + BigInt(p.record.amountRaw), 0n).toString(),
      topPickers: {
        qualified,
        minGraded: TOP_PICKERS_MIN_GRADED,
        maxBrier: TOP_PICKERS_MAX_BRIER,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
