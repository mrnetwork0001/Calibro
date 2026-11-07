/**
 * Portable brain proof: a stateless agent with ZERO local state inherits Calibro's
 * learned calibration purely from Walrus Memory Mainnet.
 *
 *   MEMWAL_ACCOUNT_ID=... MEMWAL_PRIVATE_KEY=... TATUM_API_KEY=... npx tsx scripts/portable-agent-demo.ts
 *
 * Flags:
 *   --restore              memwal.restore() each namespace first (re-index from Walrus blobs)
 *   --market <id>          Polymarket market to evaluate, e.g. poly-nba-6409790 (a held-out game
 *                          from docs/mainnet-memory-proof.json); default: the next upcoming NBA game
 *   --server <url>         buy signals over HTTP 402 from a running Calibro server with real
 *                          Sui payments (needs CALIBRO_AGENT_SUI_PRIVATE_KEY); without it, signals
 *                          are computed in-process, unpaid, and nothing is written
 *   --write                persist the thesis to calibro:episodic (default: read-only)
 *
 * Reads only environment variables — no .env file, no database, no cache.
 */
import { listOpenMarkets } from "../src/lib/data/polymarket";
import { buildSnapshot, loadSnapshot } from "../src/lib/markets/snapshot";
import { SPECIALIST_IDS, SyndicateEngine, type SpecialistSignalProvider } from "../src/lib/orchestrator/syndicate-engine";
import { computeSpecialistSignal } from "../src/lib/specialists/models";
import { TatumSuiClient } from "../src/lib/tatum/sui-rpc";
import { CALIBRO_NAMESPACES, MarketDomainSchema } from "../src/lib/types/calibro";
import { HttpX402SignalProvider } from "../src/lib/x402/http-signal-provider";
import { SuiX402Payer } from "../src/lib/x402/sui-payer";
import { CalibroMemoryClient } from "../src/lib/walrus/memory-client";
import { flagValue, hasFlag, missingEnv } from "./lib/env";

async function main() {
  console.log("=== CALIBRO · stateless portable agent ===");
  console.log(`pid ${process.pid} · cwd-independent · no .env loaded · no local database\n`);

  const missing = missingEnv(["MEMWAL_PRIVATE_KEY", "MEMWAL_ACCOUNT_ID"]);
  if (missing.length > 0) {
    console.error(`Missing ${missing.join(", ")} in the environment. Pass them inline, e.g.:`);
    console.error("  MEMWAL_ACCOUNT_ID=0x... MEMWAL_PRIVATE_KEY=... TATUM_API_KEY=... npx tsx scripts/portable-agent-demo.ts");
    process.exit(1);
  }

  const memory = new CalibroMemoryClient({ mode: "LIVE_MAINNET" });
  const tatum = new TatumSuiClient();

  if (hasFlag("--restore")) {
    console.log("memwal.restore() — re-indexing from Walrus blobs:");
    for (const ns of Object.values(CALIBRO_NAMESPACES)) {
      const r = await memory.restoreNamespace(ns, 20);
      console.log(`  ${ns}: ${JSON.stringify(r)}`);
    }
    console.log();
  }

  const audit = await memory.auditInventory();
  console.log(`Walrus Mainnet inventory (${memory.serverUrl}): ${audit.totalMemories} memories`);
  for (const ns of audit.namespaces) console.log(`  ${ns.name.padEnd(22)} ${ns.memory_count}`);

  console.log("\nRecalled calibration ledger (calibro:calibration, sort: recent):");
  console.log("  domain        specialist        n   vetoes  brier   alpha   beta");
  for (const domain of MarketDomainSchema.options) {
    const { bySpecialist } = await memory.recallDomainCalibrations(domain);
    for (const id of SPECIALIST_IDS) {
      const c = bySpecialist[id];
      console.log(
        `  ${domain.padEnd(13)} ${id.padEnd(17)} ${c ? String(c.sampleSize).padStart(2) : " -"}  ${c ? String(c.x402VetoedCount).padStart(6) : "     -"}  ` +
          `${c ? c.brierScore.toFixed(3) : "  -  "}   ${c ? c.alphaSlope.toFixed(2) : " -  "}   ${c ? c.betaIntercept.toFixed(2) : " - "}`
      );
    }
  }

  const requested = flagValue("--market");
  let snapshot = requested ? await loadSnapshot(requested) : null;
  if (!requested) {
    for (const info of await listOpenMarkets("NBA", 5)) {
      snapshot = await buildSnapshot(info);
      if (snapshot) break;
    }
  }
  if (!snapshot) throw new Error(requested ? `Cannot price market ${requested}` : "No upcoming NBA market could be priced.");
  const market = snapshot.market;

  const server = flagValue("--server");
  const tape: string[] = [];
  let signals: SpecialistSignalProvider;
  if (server) {
    const pk = process.env.CALIBRO_AGENT_SUI_PRIVATE_KEY?.trim();
    if (!pk) throw new Error("--server needs CALIBRO_AGENT_SUI_PRIVATE_KEY to pay for signals.");
    signals = new HttpX402SignalProvider({
      baseUrl: server.replace(/\/$/, ""),
      payer: new SuiX402Payer({ privateKey: pk }),
      onEvent: (e) => tape.push(`  ${e.kind.padEnd(13)} ${e.specialistId.padEnd(16)} ${e.txDigest ?? ""} ${e.detail}`),
    });
  } else {
    const snap = snapshot;
    signals = {
      async acquireSignal(req) {
        const signal = computeSpecialistSignal(req.specialistId, snap);
        if (!signal) throw new Error("no data");
        return { signal, payment: { mode: "UNPAID" } };
      },
    };
  }

  const engine = new SyndicateEngine({ memory, signals, rates: tatum });
  console.log(
    `\nEvaluating ${market.marketId} (${market.title}, ${market.source === "HISTORICAL" ? `as of ${market.asOf}` : "upcoming"}) ` +
      `${server ? `buying signals over x402 from ${server}` : "with unpaid in-process signals (read-only)"}:`
  );
  console.log(`  Polymarket ${market.onchainImpliedProb} · book ${market.bookImpliedProb ?? "n/a"} ${market.bookSource ?? ""}`);
  const ev = await engine.evaluateMarket(market, { persistThesis: Boolean(server) && hasFlag("--write") });

  for (const g of ev.gates) {
    console.log(`  ${g.decision === "VETO_PAYMENT" ? "VETO   " : "APPROVE"} ${g.specialistId.padEnd(16)} ${g.reason}`);
  }
  if (tape.length) console.log("\nx402 tape:\n" + tape.join("\n"));
  for (const e of ev.acquisitionErrors) console.log(`  ! ${e.specialistId}: ${e.error}`);

  const t = ev.thesis;
  console.log(
    `\nConsensus p=${t.calibroCalibratedProb} (naive ${t.naiveEqualWeightProb}) → ${t.recommendedAction}` +
      (t.recommendedAction === "TAKE_EDGE" ? ` ${t.betSide} @ ${t.betVenue} odds ${t.betDecimalOdds} stake $${t.recommendedStakeUsd}` : "")
  );
  console.log(`Calibration sources: ${Object.entries(ev.context.calibrationSources).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(ev.thesisWrite ? `Thesis written: blob ${ev.thesisWrite.blob_id}` : "Read-only run: nothing written.");
}

main().catch((err) => {
  console.error("Portable agent failed:", err);
  process.exit(1);
});
