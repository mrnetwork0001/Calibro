import { settleFromPolymarket, type SettleAttempt } from "@/lib/markets/settlement";
import { gradeResolvedPicks } from "@/lib/picks/service";
import { buildEngine, errorResponse, getMemory, jsonResponse, requireLive } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PER_RUN = 3;
/** Stop starting new work after this long, so a run finishes inside the 60 s function limit. */
const BUDGET_MS = 35_000;

/**
 * Scheduled settlement (Vercel Cron, see vercel.json). Finds open theses on Walrus,
 * checks each against Polymarket's resolution, settles the resolved ones, then grades
 * users' open picks on resolved markets and updates their scorecards.
 * Vercel sends `Authorization: Bearer $CRON_SECRET`; the admin token is also accepted.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const cronSecret = process.env.CRON_SECRET?.trim();
  const adminToken = process.env.CALIBRO_ADMIN_TOKEN?.trim();
  const ok =
    (cronSecret && auth === `Bearer ${cronSecret}`) ||
    (adminToken && request.headers.get("x-calibro-admin") === adminToken) ||
    (!cronSecret && !adminToken && process.env.NODE_ENV !== "production");
  if (!ok) return jsonResponse(401, { error: "Unauthorized" });

  try {
    requireLive();
    const started = Date.now();
    const open = await getMemory().recallUnsettledTheses();
    const engine = buildEngine(new URL(request.url).origin, []);
    const attempts: SettleAttempt[] = [];
    let settled = 0;
    for (const thesis of open) {
      if (settled >= MAX_PER_RUN || Date.now() - started > BUDGET_MS) break;
      const attempt = await settleFromPolymarket(engine, thesis.marketId, thesis);
      attempts.push(attempt);
      if (attempt.status === "SETTLED") settled++;
    }
    const picks = Date.now() - started > BUDGET_MS ? [] : await gradeResolvedPicks(getMemory(), 3);
    return jsonResponse(200, {
      picksGraded: picks.filter((p) => p.status === "GRADED"),
      picksWaiting: picks.filter((p) => p.status !== "GRADED").length,
      openTheses: open.length,
      settled,
      attempts: attempts.map((a) =>
        a.status === "SETTLED" || a.status === "ALREADY_SETTLED"
          ? { marketId: a.marketId, status: a.status, outcome: a.outcome }
          : { marketId: a.marketId, status: a.status, detail: a.detail }
      ),
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
