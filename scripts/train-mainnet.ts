/**
 * Trains Calibro on REAL resolved Polymarket markets, in chronological order.
 *
 *   npm run train -- --preview                       # real data, unpaid in-process signals, empty
 *                                                    # local memory: prints the backtest, writes nothing
 *   npm run train -- --server http://localhost:3004 --yes
 *                                                    # LIVE: every signal bought over HTTP 402 with a
 *                                                    # real Sui Mainnet payment, verified via Tatum,
 *                                                    # every thesis/post-mortem/checkpoint on Walrus
 *
 * Options: --nba 14 --epl 5 --ufc 5 (markets per league), --days 21 (look-back),
 *          --holdout 2 (newest NBA games kept out of training for the demo).
 *
 * Each market is priced as of 5 minutes before its scheduled start (point-in-time:
 * Polymarket hourly history, the sportsbook closing line, ESPN's pre-game BPI) and
 * settled to Polymarket's own resolution. Resumable: markets already settled on Walrus
 * are skipped. docs/mainnet-memory-proof.json is rewritten after every market from real
 * relayer and Sui responses only, and marked complete when the run finishes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { MemWalMock } from "@mysten-incubation/memwal";
import { mapLimit } from "../src/lib/data/http";
import { listResolvedMarkets } from "../src/lib/data/polymarket";
import { buildSnapshot, type MarketSnapshot } from "../src/lib/markets/snapshot";
import {
  DEFAULT_MANDATE,
  SyndicateEngine,
  type AcquiredSignal,
  type SignalAcquisitionRequest,
  type SpecialistSignalProvider,
} from "../src/lib/orchestrator/syndicate-engine";
import { computeSpecialistSignal } from "../src/lib/specialists/models";
import { TatumSuiClient } from "../src/lib/tatum/sui-rpc";
import type { MarketDomain, SpecialistId } from "../src/lib/types/calibro";
import { CalibroMemoryClient } from "../src/lib/walrus/memory-client";
import { HttpX402SignalProvider, type TapeEvent } from "../src/lib/x402/http-signal-provider";
import { SuiX402Payer } from "../src/lib/x402/sui-payer";
import { flagValue, hasFlag, loadDotEnv, missingEnv } from "./lib/env";

const PROOF_PATH = "docs/mainnet-memory-proof.json";

/** Unpaid, in-process signals for --preview: the same real-data models, no payment. */
class PreviewSignalProvider implements SpecialistSignalProvider {
  constructor(private readonly snapshots: Map<string, MarketSnapshot>) {}
  async acquireSignal(req: SignalAcquisitionRequest): Promise<AcquiredSignal> {
    const snap = this.snapshots.get(req.market.marketId);
    const signal = snap ? computeSpecialistSignal(req.specialistId, snap) : null;
    if (!signal) throw new Error(`${req.specialistId}: no data`);
    return { signal, payment: { mode: "UNPAID" } };
  }
}

interface MarketRow {
  epoch: number;
  marketId: string;
  domain: MarketDomain;
  title: string;
  asOf: string;
  polymarketUrl?: string;
  outcome: 0 | 1;
  onchainProb: number;
  bookProb: number | null;
  calibroProb: number;
  naiveProb: number;
  calibroBrier: number;
  naiveBrier: number;
  marketBrier: number;
  paid: Array<{ specialistId: SpecialistId; p: number; txDigest?: string }>;
  vetoed: Array<{ specialistId: SpecialistId; reason: string }>;
  action: string;
  pnlUsd: number;
  thesisBlobId?: string;
  postMortemBlobId?: string;
  calibrationBlobIds: string[];
  status: "TRAINED" | "ALREADY_ON_WALRUS";
}

const n = (name: string, dflt: number) => {
  const v = Number(flagValue(name));
  return Number.isFinite(v) && v >= 0 ? v : dflt;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");

async function selectMarkets(): Promise<{ train: MarketSnapshot[]; holdout: MarketSnapshot[] }> {
  const since = new Date(Date.now() - n("--days", 21) * 86_400_000);
  const plan: Array<[MarketDomain, number]> = [
    ["NBA", n("--nba", 14) + n("--holdout", 2)],
    ["EPL", n("--epl", 5)],
    ["UFC", n("--ufc", 5)],
  ];
  const snaps: MarketSnapshot[] = [];
  for (const [domain, want] of plan) {
    if (want === 0) continue;
    // Over-fetch: some markets lack enough price history to be priced point-in-time.
    const infos = await listResolvedMarkets(domain, { limit: want * 2 + 4, since, minVolume: 10_000 });
    const built = (await mapLimit(infos, 4, (i) => buildSnapshot(i).catch(() => null))).filter(
      (s): s is MarketSnapshot => s !== null && (s.market.availableSignals?.length ?? 0) >= 2
    );
    const picked = built.slice(0, want); // newest first
    console.log(`   ${domain.padEnd(4)} ${picked.length}/${want} usable of ${infos.length} resolved since ${since.toISOString().slice(0, 10)}`);
    snaps.push(...picked);
  }
  const holdoutCount = n("--holdout", 2);
  const nba = snaps.filter((s) => s.market.domain === "NBA").sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf));
  const holdout = nba.slice(0, holdoutCount);
  const held = new Set(holdout.map((s) => s.market.marketId));
  const train = snaps.filter((s) => !held.has(s.market.marketId)).sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  return { train, holdout };
}

function writeProof(doc: unknown): void {
  mkdirSync("docs", { recursive: true });
  writeFileSync(PROOF_PATH, JSON.stringify(doc, null, 2));
}

async function main() {
  loadDotEnv();
  const preview = hasFlag("--preview");
  const server = flagValue("--server")?.replace(/\/$/, "");
  console.log(`=== CALIBRO · training on real resolved Polymarket markets ${preview ? "(PREVIEW: unpaid, nothing written)" : "(LIVE MAINNET)"} ===\n`);

  if (!preview) {
    const missing = missingEnv(["MEMWAL_PRIVATE_KEY", "MEMWAL_ACCOUNT_ID", "TATUM_API_KEY", "CALIBRO_AGENT_SUI_PRIVATE_KEY"]);
    if (missing.length > 0) {
      console.error(`Missing ${missing.join(", ")} — refusing to run live. Preview with: npm run train -- --preview`);
      process.exit(1);
    }
    if (!server) {
      console.error("Live training buys every signal over HTTP 402 from a running Calibro server: pass --server http://localhost:3004");
      process.exit(1);
    }
    const status = (await fetch(`${server}/api/status`).then((r) => r.json())) as { mode?: { mode?: string }; payments?: { treasury?: string | null } };
    if (status.mode?.mode !== "LIVE_MAINNET" || !status.payments?.treasury) {
      console.error(`Server ${server} is not LIVE_MAINNET with a treasury configured (${JSON.stringify(status.mode)}).`);
      process.exit(1);
    }
  }

  console.log("1) Selecting resolved markets (priced 5 min before start):");
  const { train, holdout } = await selectMarkets();
  console.log(`   → ${train.length} training markets, ${holdout.length} held out for the demo\n`);
  if (train.length === 0) throw new Error("No usable resolved markets found.");

  const tatum = new TatumSuiClient();
  const memory = preview
    ? new CalibroMemoryClient({ mode: "MOCK_SANDBOX", mockInstance: MemWalMock.create({ namespace: "calibro:episodic", owner: "preview" }) })
    : new CalibroMemoryClient({ mode: "LIVE_MAINNET" });
  const tape: TapeEvent[] = [];
  const snapshots = new Map(train.map((s) => [s.market.marketId, s]));
  const payer = preview ? null : new SuiX402Payer({ privateKey: process.env.CALIBRO_AGENT_SUI_PRIVATE_KEY!, tatumApiKey: process.env.TATUM_API_KEY });
  const signals: SpecialistSignalProvider = preview
    ? new PreviewSignalProvider(snapshots)
    : new HttpX402SignalProvider({ baseUrl: server!, payer, onEvent: (e) => tape.push(e) });
  const engine = new SyndicateEngine({ memory, signals, rates: tatum });

  if (!preview) {
    const maxPayments = train.reduce((acc, s) => acc + (s.market.availableSignals?.length ?? 0), 0);
    const balances = await tatum.getAllBalances(payer!.address).catch(() => []);
    const sui = balances.find((b) => b.coinType.endsWith("::sui::SUI"));
    console.log(`   Agent wallet ${payer!.address}: ${sui ? Number(sui.totalBalance) / 1e9 : 0} SUI`);
    console.log(`   At most ${maxPayments} x402 payments of 0.002 SUI (+ gas). Fees go to the treasury; vetoes reduce the count.`);
    if (!hasFlag("--yes")) {
      console.log("\n   Re-run with --yes to spend real SUI and write to Walrus Mainnet.");
      return;
    }
  }

  const mandate = await memory.recallLatestMandate();
  let mandateBlobId: string | undefined;
  if (!mandate) {
    const res = await memory.rememberMandate({ ...DEFAULT_MANDATE, updatedAt: new Date().toISOString() });
    mandateBlobId = res.blob_id;
    console.log(`   mandate written → ${res.blob_id}`);
  }

  console.log("2) Evaluate → pay → settle → learn, in chronological order:\n");
  const rows: MarketRow[] = [];
  const startedAt = new Date().toISOString();
  const proofDoc = () => ({
    generatedAt: new Date().toISOString(),
    startedAt,
    complete: false,
    network: "mainnet",
    relayer: memory.serverUrl,
    accountId: process.env.MEMWAL_ACCOUNT_ID,
    agentWallet: payer?.address,
    treasury: process.env.CALIBRO_SIGNAL_TREASURY_ADDRESS,
    mandateBlobId,
    dataSources: ["Polymarket Gamma + CLOB (prices, resolution)", "ESPN (DraftKings lines, BPI)"],
    markets: rows,
    heldOut: holdout.map((s) => ({ marketId: s.market.marketId, title: s.market.title, asOf: s.asOf })),
    x402Payments: tape.filter((t) => t.kind === "VERIFIED").map((t) => ({ specialistId: t.specialistId, marketId: t.marketId, txDigest: t.txDigest, checkpoint: t.checkpoint })),
  });

  for (const [i, snap] of train.entries()) {
    const m = snap.market;
    const outcome = snap.info.resolution.status === "RESOLVED" ? snap.info.resolution.outcome : null;
    if (outcome === null) continue;
    const ctx = `Domain=${m.domain} Market="${m.title}"`;

    let resumeThesis: import("../src/lib/types/calibro").EpisodicPredictionRecord | null = null;
    let resumeThesisBlob: string | undefined;
    if (!preview) {
      const existing = await memory.findMarketEpisodes(m.marketId, ctx);
      if (existing.thesis && !existing.settled) {
        // Interrupted after paying + writing the thesis: settle that thesis, don't pay again.
        resumeThesis = existing.thesis.record;
        resumeThesisBlob = existing.thesis.blobId;
      }
      if (existing.settled) {
        const r = existing.settled.record;
        rows.push(rowFrom(i + 1, snap, r, outcome, "ALREADY_ON_WALRUS", existing.thesis?.blobId, existing.settled.blobId, []));
        console.log(`  ${String(i + 1).padStart(2)} ${m.domain.padEnd(4)} ${m.title.slice(0, 38).padEnd(38)} already settled on Walrus`);
        continue;
      }
    }

    let thesis = resumeThesis;
    let thesisBlob = resumeThesisBlob;
    if (!thesis) {
      const ev = await engine.evaluateMarket(m);
      for (const e of ev.acquisitionErrors) console.log(`     ! ${e.specialistId}: ${e.error}`);
      thesis = ev.thesis;
      thesisBlob = ev.thesisWrite?.blob_id;
    } else {
      console.log(`     (resuming: thesis already on Walrus ${thesisBlob}, settling it)`);
    }
    const st = await engine.settleMarketAndLearn({ marketId: m.marketId, outcome, contextQuery: ctx, thesisFallback: thesis });
    if (st.status !== "SETTLED") throw new Error(`Unexpected ${st.status} for ${m.marketId}`);
    const calBlobs = st.calibrationWrite.results.map((r) => r.blob_id).filter((b): b is string => Boolean(b));
    const row = rowFrom(i + 1, snap, st.settled, outcome, "TRAINED", thesisBlob, st.episodicWrite.blob_id, calBlobs);
    rows.push(row);
    console.log(
      `  ${String(i + 1).padStart(2)} ${m.domain.padEnd(4)} ${m.title.slice(0, 38).padEnd(38)} y=${outcome} ` +
        `mkt=${f3(m.onchainImpliedProb)} calibro=${f3(row.calibroProb)} brier=${f3(row.calibroBrier)} ` +
        `paid[${row.paid.map((p) => p.specialistId.split("-")[0]).join(",")}] vetoed[${row.vetoed.map((v) => v.specialistId.split("-")[0]).join(",")}]`
    );
    if (!preview) writeProof(proofDoc());
  }

  // ---- report ----
  const q = Math.max(1, Math.floor(rows.length / 4));
  console.log("\n3) Results (real outcomes):");
  console.log(`   Calibro Brier, first ${q} markets: ${f3(mean(rows.slice(0, q).map((r) => r.calibroBrier)))} → last ${q}: ${f3(mean(rows.slice(-q).map((r) => r.calibroBrier)))}`);
  console.log(`   Mean Brier — Calibro ${f3(mean(rows.map((r) => r.calibroBrier)))} · equal-weight ${f3(mean(rows.map((r) => r.naiveBrier)))} · Polymarket price ${f3(mean(rows.map((r) => r.marketBrier)))}`);
  console.log(`   Payments vetoed: ${rows.reduce((a, r) => a + r.vetoed.length, 0)} · paid: ${rows.reduce((a, r) => a + r.paid.length, 0)} · paper P&L $${rows.reduce((a, r) => a + r.pnlUsd, 0).toFixed(2)}`);
  const ledger = await memory.recallCalibrationLedger();
  console.log("\n   Calibration ledger (newest per specialist × league):");
  for (const c of [...ledger.byKey.values()].sort((a, b) => a.domain.localeCompare(b.domain) || a.brierScore - b.brierScore)) {
    console.log(`   ${c.domain.padEnd(4)} ${c.specialistId.padEnd(16)} n=${String(c.sampleSize).padStart(2)} Brier ${c.brierScore.toFixed(3)} α=${c.alphaSlope.toFixed(2)} β=${c.betaIntercept.toFixed(2)} paid ${c.x402PaidCount} vetoed ${c.x402VetoedCount}`);
  }
  console.log("\n   Held out for the demo:");
  for (const s of holdout) console.log(`   ${s.market.marketId}  ${s.market.title}  (as of ${s.asOf})`);

  if (preview) {
    console.log("\nPreview complete. Nothing was paid or written. Go live with --server <url> --yes.");
    return;
  }
  const audit = await memory.auditInventory();
  writeProof({ ...proofDoc(), complete: true, inventoryTotal: audit.totalMemories, namespaces: audit.namespaces.map((x) => ({ name: x.name, memoryCount: x.memory_count })) });
  console.log(`\n✓ ${PROOF_PATH} written (${rows.length} markets, ${audit.totalMemories} memories on Walrus).`);
}

function rowFrom(
  epoch: number,
  snap: MarketSnapshot,
  r: import("../src/lib/types/calibro").EpisodicPredictionRecord,
  outcome: 0 | 1,
  status: MarketRow["status"],
  thesisBlobId: string | undefined,
  postMortemBlobId: string | undefined,
  calibrationBlobIds: string[]
): MarketRow {
  const sq = (p: number) => (p - outcome) ** 2;
  return {
    epoch,
    marketId: snap.market.marketId,
    domain: snap.market.domain,
    title: snap.market.title,
    asOf: snap.asOf,
    polymarketUrl: snap.market.sourceUrl,
    outcome,
    onchainProb: snap.market.onchainImpliedProb,
    bookProb: snap.market.bookImpliedProb,
    calibroProb: r.calibroCalibratedProb,
    naiveProb: r.naiveEqualWeightProb,
    calibroBrier: sq(r.calibroCalibratedProb),
    naiveBrier: sq(r.naiveEqualWeightProb),
    marketBrier: sq(snap.market.onchainImpliedProb),
    paid: r.signalsUsed.map((s) => ({ specialistId: s.specialistId, p: s.rawProbability, txDigest: s.x402TxDigest })),
    vetoed: r.signalsVetoed.map((v) => ({ specialistId: v.specialistId, reason: v.reason })),
    action: r.recommendedAction === "TAKE_EDGE" ? `${r.betSide}@${r.betVenue} $${r.recommendedStakeUsd}` : "PASS",
    pnlUsd: r.pnlUsd ?? 0,
    thesisBlobId,
    postMortemBlobId,
    calibrationBlobIds,
    status,
  };
}

main().catch((err) => {
  console.error("Training failed:", err);
  process.exit(1);
});
