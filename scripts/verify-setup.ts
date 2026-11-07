import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  aggregateCalibratedSignals,
  computeFractionalKelly,
  createColdStartCalibration,
  shouldPayX402Gate,
  updateCalibrationOnline,
} from "../src/lib/calibration/brier";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { TatumSuiClient, normalizeCoinType, normalizeSuiAddress } from "../src/lib/tatum/sui-rpc";

function loadDotEnvIfPresent() {
  for (const name of [".env.local", ".env"]) {
    const p = resolve(process.cwd(), name);
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  }
}

async function main() {
  loadDotEnvIfPresent();
  console.log("=== CALIBRO PREFLIGHT VERIFICATION ===\n");

  // 1. Walrus Memory Mainnet Relayer Health & Contract Config
  const relayerUrl =
    process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz";
  try {
    const [healthRes, cfgRes] = await Promise.all([
      fetch(`${relayerUrl}/health`, { signal: AbortSignal.timeout(7_000) }),
      fetch(`${relayerUrl}/config`, { signal: AbortSignal.timeout(7_000) }),
    ]);
    const health = (await healthRes.json()) as {
      status?: string;
      mode?: string;
      write_ready?: boolean;
    };
    const cfg = (await cfgRes.json()) as {
      network?: string;
      packageId?: string;
      registryId?: string;
    };
    console.log(
      `[OK] Walrus Memory Relayer (${relayerUrl}): status=${health.status}, mode=${health.mode}, write_ready=${health.write_ready}`
    );
    console.log(
      `     network=${cfg.network} packageId=${cfg.packageId?.slice(0, 18)}...`
    );
  } catch (err) {
    console.log(
      `[WARN] Could not reach Walrus Relayer (${relayerUrl}): ${(err as Error).message}`
    );
  }

  // 2. Credential Readiness Check
  const hasMemwalKey = Boolean(process.env.MEMWAL_PRIVATE_KEY?.trim());
  const hasMemwalAccount = Boolean(process.env.MEMWAL_ACCOUNT_ID?.trim());
  const hasTatumKey = Boolean(process.env.TATUM_API_KEY?.trim());

  console.log(
    `[${hasMemwalKey && hasMemwalAccount ? "OK" : "PENDING"}] MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID: ${
      hasMemwalKey && hasMemwalAccount
        ? "configured"
        : "not set yet in .env (run `npm run memwal:provision` or sign in at memory.walrus.xyz)"
    }`
  );

  // 3. Tatum Sui Mainnet RPC & v4 Exchange Rate Check
  const tatum = new TatumSuiClient();
  if (hasTatumKey) {
    try {
      const [checkpoint, suiRate] = await Promise.all([
        tatum.getLatestCheckpoint(),
        tatum.getUsdExchangeRate("SUI"),
      ]);
      console.log(
        `[OK] Tatum Sui Mainnet RPC: latest checkpoint=${checkpoint} | SUI/USD=$${suiRate.usdPrice} (${suiRate.source})`
      );
    } catch (err) {
      console.log(
        `[WARN] Tatum Sui RPC check failed: ${(err as Error).message}`
      );
    }
  } else {
    console.log(
      "[PENDING] TATUM_API_KEY: not set yet in .env (get free key at https://dashboard.tatum.io)"
    );
  }

  // 3b. x402 agent wallet + treasury (public addresses only — secrets are never printed)
  const agentKey = process.env.CALIBRO_AGENT_SUI_PRIVATE_KEY?.trim();
  const treasury = process.env.CALIBRO_SIGNAL_TREASURY_ADDRESS?.trim();
  let agentAddress: string | null = null;
  if (!agentKey) {
    console.log("[PENDING] CALIBRO_AGENT_SUI_PRIVATE_KEY: not set (agent wallet that pays x402 fees + Walrus account gas)");
  } else {
    try {
      agentAddress = Ed25519Keypair.fromSecretKey(agentKey).getPublicKey().toSuiAddress();
      let balance = "unknown (no TATUM_API_KEY)";
      if (hasTatumKey) {
        try {
          const balances = await tatum.getAllBalances(agentAddress);
          const sui = balances.find((b) => normalizeCoinType(b.coinType) === normalizeCoinType("0x2::sui::SUI"));
          balance = `${(Number(sui?.totalBalance ?? 0) / 1e9).toFixed(4)} SUI`;
        } catch (err) {
          balance = `lookup failed (${(err as Error).message.slice(0, 80)})`;
        }
      }
      console.log(`[OK] Agent wallet: ${agentAddress} · balance ${balance}`);
    } catch (err) {
      console.log(`[WARN] CALIBRO_AGENT_SUI_PRIVATE_KEY is not a valid suiprivkey: ${(err as Error).message}`);
    }
  }
  if (!treasury) {
    console.log("[PENDING] CALIBRO_SIGNAL_TREASURY_ADDRESS: not set (receives x402 signal fees)");
  } else if (!/^0x[0-9a-fA-F]{1,64}$/.test(treasury)) {
    console.log("[WARN] CALIBRO_SIGNAL_TREASURY_ADDRESS is not a 0x… Sui address");
  } else if (agentAddress && normalizeSuiAddress(treasury) === normalizeSuiAddress(agentAddress)) {
    console.log("[WARN] Treasury equals the agent wallet: self-payments net to −gas and will FAIL verification. Use a different address.");
  } else {
    console.log(`[OK] Treasury: ${treasury}`);
  }
  // Real data sources (no keys needed) and production settings.
  const reach = async (label: string, url: string) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      console.log(`${r.ok ? "[OK]" : "[WARN]"} ${label}: HTTP ${r.status}`);
    } catch (err) {
      console.log(`[WARN] ${label}: ${(err as Error).message}`);
    }
  };
  await reach("Polymarket Gamma API", "https://gamma-api.polymarket.com/events?tag_slug=nba&limit=1");
  await reach("Polymarket CLOB API", "https://clob.polymarket.com/time");
  await reach("ESPN scoreboard API", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard");
  const set = (k: string) => Boolean(process.env[k]?.trim());
  console.log(`[${set("THE_ODDS_API_KEY") ? "OK" : "INFO"}] THE_ODDS_API_KEY ${set("THE_ODDS_API_KEY") ? "set (Pinnacle lines for upcoming games)" : "not set: upcoming games use DraftKings via ESPN"}`);
  const redis = (set("UPSTASH_REDIS_REST_URL") && set("UPSTASH_REDIS_REST_TOKEN")) || (set("KV_REST_API_URL") && set("KV_REST_API_TOKEN"));
  console.log(`[${redis ? "OK" : "PENDING"}] Shared replay ledger: ${redis ? "Redis configured" : "not set (fine locally; REQUIRED on Vercel: UPSTASH_REDIS_REST_URL + _TOKEN or Vercel KV)"}`);
  console.log(`[${set("CALIBRO_ADMIN_TOKEN") ? "OK" : "PENDING"}] CALIBRO_ADMIN_TOKEN ${set("CALIBRO_ADMIN_TOKEN") ? "set" : "not set (required in production)"}`);
  console.log(`[${set("CRON_SECRET") ? "OK" : "INFO"}] CRON_SECRET ${set("CRON_SECRET") ? "set" : "not set (Vercel sets it for cron jobs; needed for /api/cron/settle in production)"}`);

  // 4. Deterministic Brier + VoI x402 gate self-test (fixed inputs, checks the maths only)
  let hypeCal = createColdStartCalibration("hype-contrarian", "EPL");
  for (let i = 0; i < 6; i++) {
    // Overconfident 85% picks that lose (outcome = 0)
    hypeCal = updateCalibrationOnline(hypeCal, 0.85, 0);
  }

  const mandate = {
    kind: "mandate_v1" as const,
    bankrollUsd: 1000,
    kellyMultiplier: 0.25,
    maxSingleStakePct: 0.05,
    minEdgeThreshold: 0.02,
    maxSlateX402BudgetSui: 0.05,
    preferredDomains: ["NBA" as const, "EPL" as const],
    updatedAt: new Date().toISOString(),
  };

  const gate = shouldPayX402Gate({
    calibration: hypeCal,
    mandate,
    feeUsd: 0.0045,
  });

  let sharpCal = createColdStartCalibration("sharp-steam", "EPL");
  for (let i = 0; i < 6; i++) {
    sharpCal = updateCalibrationOnline(sharpCal, 0.72, 1);
  }

  const agg = aggregateCalibratedSignals([
    { specialistId: "sharp-steam", rawProbability: 0.68, calibration: sharpCal },
  ]);
  const kelly = computeFractionalKelly({
    calibratedProb: agg.calibratedConsensusProb,
    decimalOdds: 1.75,
    mandate,
  });

  console.log(
    `[OK] Math self-test: degraded Brier=${hypeCal.brierScore.toFixed(3)} -> x402=${gate.decision} | sharp Kelly=${kelly.action} ($${kelly.stakeUsd})`
  );
  console.log("\nPreflight complete.");
}

main().catch((err) => {
  console.error("Preflight error:", err);
  process.exit(1);
});
