import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addDelegateKey,
  createAccount,
  generateDelegateKey,
} from "@mysten-incubation/memwal/account";
import { SECRETS_FILE, upsertSecrets } from "./lib/env-file";

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
  console.log("=== WALRUS MEMORY MAINNET PROVISIONER ===\n");

  const packageId =
    process.env.MEMWAL_PACKAGE_ID ??
    "0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5";
  const registryId =
    process.env.MEMWAL_REGISTRY_ID ??
    "0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f";

  if (process.env.MEMWAL_PRIVATE_KEY?.trim() && process.env.MEMWAL_ACCOUNT_ID?.trim()) {
    console.log(`Already provisioned: MEMWAL_ACCOUNT_ID=${process.env.MEMWAL_ACCOUNT_ID} (delegate key present). Nothing to do.`);
    return;
  }

  const delegate = await generateDelegateKey();
  console.log("Generated fresh Ed25519 delegate keypair:");
  console.log(`  Delegate Sui address : ${delegate.suiAddress}`);
  console.log("  (private key is written to .env.local, never printed)\n");

  const suiPrivateKey = process.env.CALIBRO_AGENT_SUI_PRIVATE_KEY?.trim();
  const existingAccountId = process.env.MEMWAL_ACCOUNT_ID?.trim();

  if (!suiPrivateKey) {
    console.log("No `CALIBRO_AGENT_SUI_PRIVATE_KEY` found in `.env` yet.");
    console.log("Choose ONE of two ways to finish Mainnet setup:");
    console.log(
      "  Option A (Browser UI): Open https://memory.walrus.xyz, connect your Sui wallet, create/copy your Account ID, and authorize the delegate key above."
    );
    console.log(
      "  Option B (1-Click On-Chain CLI): run `npm run setup:keys`, fund the agent wallet it prints with ~0.2 SUI, then re-run `npm run memwal:provision`."
    );
    return;
  }

  let accountId = existingAccountId;
  if (!accountId) {
    console.log("Creating MemWalAccount on Sui Mainnet...");
    const created = await createAccount({
      packageId,
      registryId,
      suiPrivateKey,
      suiNetwork: "mainnet",
    });
    accountId = created.accountId;
    console.log(`  Created Account ID : ${accountId} (tx: ${created.digest})`);
  } else {
    console.log(`Using existing MEMWAL_ACCOUNT_ID: ${accountId}`);
  }

  console.log("Registering delegate key on MemWalAccount...");
  const added = await addDelegateKey({
    packageId,
    registryId,
    accountId,
    publicKey: delegate.publicKey,
    label: "Calibro Syndicate Agent",
    suiPrivateKey,
    suiNetwork: "mainnet",
  });

  console.log(`  Delegate key added. Tx digest: ${added.digest}\n`);
  upsertSecrets({ MEMWAL_ACCOUNT_ID: accountId, MEMWAL_PRIVATE_KEY: delegate.privateKey });
  console.log(`Wrote MEMWAL_ACCOUNT_ID=${accountId} and MEMWAL_PRIVATE_KEY to ${SECRETS_FILE}.`);
  console.log("Next: npm run verify, start the server (npm run dev -- --port 3004), then npm run train -- --server http://localhost:3004 --yes");
}

main().catch((err) => {
  console.error("Provisioning failed:", err);
  process.exit(1);
});
