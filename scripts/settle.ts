/**
 * Settle resolved predictions and grade users' picks — the same work /api/cron/settle does
 * on a deployment, runnable locally (nothing schedules the cron on a dev machine).
 *
 *   npm run settle                 # one pass
 *   npm run settle -- --every 30   # keep running, one pass every 30 minutes
 *
 * Only writes to Walrus when Polymarket has resolved a market (clean 1/0 payout).
 */
import { settleFromPolymarket } from "../src/lib/markets/settlement";
import { gradeResolvedPicks } from "../src/lib/picks/service";
import { SyndicateEngine } from "../src/lib/orchestrator/syndicate-engine";
import { TatumSuiClient } from "../src/lib/tatum/sui-rpc";
import { CalibroMemoryClient } from "../src/lib/walrus/memory-client";
import { flagValue, loadDotEnv, missingEnv } from "./lib/env";

async function pass(memory: CalibroMemoryClient, engine: SyndicateEngine): Promise<void> {
  const started = new Date().toISOString();
  const open = await memory.recallUnsettledTheses();
  console.log(`[${started}] ${open.length} open prediction(s) on Walrus`);
  for (const thesis of open) {
    try {
      const a = await settleFromPolymarket(engine, thesis.marketId, thesis);
      if (a.status === "SETTLED" || a.status === "ALREADY_SETTLED") {
        const s = a.result.settled;
        console.log(`  ${a.status.padEnd(15)} ${thesis.title} → ${a.outcome === 1 ? "YES" : "NO"} · Calibro Brier ${s.realizedBrier?.toFixed(3) ?? "?"}`);
      } else {
        console.log(`  ${a.status.padEnd(15)} ${thesis.title}: ${a.detail}`);
      }
    } catch (err) {
      console.log(`  ERROR           ${thesis.title}: ${(err as Error).message}`);
    }
  }
  const graded = await gradeResolvedPicks(memory, 50);
  const done = graded.filter((g) => g.status === "GRADED");
  console.log(`  picks: ${done.length} graded, ${graded.length - done.length} waiting for Polymarket to resolve`);
  for (const g of done) console.log(`    graded ${g.owner.slice(0, 10)}… on ${g.marketId}: Brier ${g.brier?.toFixed(3)} (scorecard epoch ${g.scorecardEpoch})`);
}

async function main() {
  loadDotEnv();
  const missing = missingEnv(["MEMWAL_PRIVATE_KEY", "MEMWAL_ACCOUNT_ID", "TATUM_API_KEY"]);
  if (missing.length) {
    console.error(`Missing ${missing.join(", ")}.`);
    process.exit(1);
  }
  const memory = new CalibroMemoryClient({ mode: "LIVE_MAINNET" });
  const engine = new SyndicateEngine({
    memory,
    rates: new TatumSuiClient(),
    // Settlement never buys signals.
    signals: { acquireSignal: async () => Promise.reject(new Error("settlement does not buy signals")) },
  });
  const every = Number(flagValue("--every"));
  await pass(memory, engine);
  if (!(every > 0)) return;
  console.log(`Running every ${every} min (Ctrl+C to stop).`);
  setInterval(() => void pass(memory, engine).catch((e) => console.error("pass failed:", (e as Error).message)), every * 60_000);
}

main().catch((err) => {
  console.error("Settle failed:", err);
  process.exit(1);
});
