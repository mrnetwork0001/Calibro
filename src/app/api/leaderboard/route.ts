import { getLedgerSummary } from "@/lib/landing/ledger";
import { qualifies } from "@/lib/picks/crowd";
import { errorResponse, getMemory, jsonResponse, requireLive } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * You vs Calibro vs the market. Users are ranked by Brier (≥ 3 graded picks first); each
 * row carries the market's Brier on that user's own games, so the comparison is like for like.
 */
export async function GET(): Promise<Response> {
  try {
    requireLive();
    const [cards, ledger, payouts] = await Promise.all([getMemory().recallScorecards(), getLedgerSummary(), getMemory().recallPayouts()]);
    const earned = new Map<string, bigint>();
    for (const p of payouts) earned.set(p.owner, (earned.get(p.owner) ?? 0n) + BigInt(p.amountRaw));
    const users = cards
      .map((c) => ({
        owner: c.owner,
        graded: c.graded,
        brier: c.brier,
        marketBrier: c.marketBrier,
        edgeVsMarket: Number((c.marketBrier - c.brier).toFixed(6)),
        calibroBrier: c.calibroBrier,
        calibroCompared: c.calibroCompared,
        earnedRaw: (earned.get(c.owner) ?? 0n).toString(),
        topPicker: qualifies(c),
        updatedAt: c.updatedAt,
      }))
      .sort((a, b) => Number(b.graded >= 3) - Number(a.graded >= 3) || a.brier - b.brier);

    const specialists = new Map<string, { n: number; sum: number }>();
    for (const c of ledger?.calibrations ?? []) {
      const s = specialists.get(c.specialistId) ?? { n: 0, sum: 0 };
      s.n += c.sampleSize;
      s.sum += c.brierScore * c.sampleSize;
      specialists.set(c.specialistId, s);
    }
    return jsonResponse(200, {
      users,
      reference: ledger
        ? {
            settledMarkets: ledger.settledMarkets,
            calibro: ledger.calibroBrier,
            polymarket: ledger.marketBrier,
            specialists: [...specialists].map(([id, s]) => ({ id, samples: s.n, brier: s.n ? s.sum / s.n : null })),
          }
        : null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
