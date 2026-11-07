/**
 * One-shot local setup:  npm run setup:keys [-- --tatum-key <key>] [-- --treasury 0x...]
 *
 * Creates .env.local from .env.example (if missing) and fills ONLY empty values:
 *   - CALIBRO_AGENT_SUI_PRIVATE_KEY   fresh Ed25519 wallet (pays x402 fees + Walrus account gas)
 *   - CALIBRO_SIGNAL_TREASURY_ADDRESS fresh, separate wallet (its key is kept as
 *                                     CALIBRO_TREASURY_SUI_PRIVATE_KEY so fees are recoverable)
 *   - CALIBRO_X402_CHALLENGE_SECRET / CALIBRO_ADMIN_TOKEN  random secrets
 *   - TATUM_API_KEY                   from --tatum-key, if given
 * Existing values are never overwritten. Secrets are never printed — only public addresses.
 */
import { randomBytes } from "node:crypto";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SECRETS_FILE, ensureSecretsFile, readSecret, upsertSecrets } from "./lib/env-file";
import { flagValue } from "./lib/env";

function main() {
  const created = ensureSecretsFile();
  console.log(`${created ? "Created" : "Using"} ${SECRETS_FILE} (git-ignored, chmod 600)\n`);

  const updates: Record<string, string> = {};
  const report: string[] = [];

  const tatumArg = flagValue("--tatum-key");
  if (tatumArg && !readSecret("TATUM_API_KEY")) {
    updates.TATUM_API_KEY = tatumArg.trim();
    report.push("TATUM_API_KEY            set from --tatum-key");
  } else {
    report.push(`TATUM_API_KEY            ${readSecret("TATUM_API_KEY") ? "already set" : "MISSING — re-run with --tatum-key <key>"}`);
  }

  let agentAddress: string;
  const existingAgent = readSecret("CALIBRO_AGENT_SUI_PRIVATE_KEY");
  if (existingAgent) {
    agentAddress = Ed25519Keypair.fromSecretKey(existingAgent).getPublicKey().toSuiAddress();
    report.push(`agent wallet             already set · ${agentAddress}`);
  } else {
    const kp = new Ed25519Keypair();
    agentAddress = kp.getPublicKey().toSuiAddress();
    updates.CALIBRO_AGENT_SUI_PRIVATE_KEY = kp.getSecretKey();
    report.push(`agent wallet             generated · ${agentAddress}`);
  }

  const treasuryArg = flagValue("--treasury");
  const existingTreasury = readSecret("CALIBRO_SIGNAL_TREASURY_ADDRESS");
  if (existingTreasury) {
    report.push(`treasury                 already set · ${existingTreasury}`);
  } else if (treasuryArg) {
    updates.CALIBRO_SIGNAL_TREASURY_ADDRESS = treasuryArg.trim();
    report.push(`treasury                 set from --treasury · ${treasuryArg.trim()}`);
  } else {
    const kp = new Ed25519Keypair();
    updates.CALIBRO_SIGNAL_TREASURY_ADDRESS = kp.getPublicKey().toSuiAddress();
    updates.CALIBRO_TREASURY_SUI_PRIVATE_KEY = kp.getSecretKey();
    report.push(`treasury                 generated · ${updates.CALIBRO_SIGNAL_TREASURY_ADDRESS}`);
  }

  for (const [key, bytes] of [["CALIBRO_X402_CHALLENGE_SECRET", 32], ["CALIBRO_ADMIN_TOKEN", 24]] as const) {
    if (readSecret(key)) {
      report.push(`${key.padEnd(24)} already set`);
    } else {
      updates[key] = randomBytes(bytes).toString("hex");
      report.push(`${key.padEnd(24)} generated`);
    }
  }

  if (Object.keys(updates).length > 0) upsertSecrets(updates);
  for (const r of report) console.log(`  ${r}`);

  console.log(`
Next:
  1. Send ~0.2 SUI on Sui Mainnet to the agent wallet:
       ${agentAddress}
     (account creation gas + delegate key + ~0.002 SUI per paid signal)
  2. npm run verify            # shows the balance once it lands
  3. npm run memwal:provision  # creates the Walrus Memory account, writes MEMWAL_* into .env.local
  4. npm run train -- --server http://localhost:3004 --yes   # trains on real games, writes docs/mainnet-memory-proof.json
  5. Restart \`npm run dev\` so the app picks up the new keys.`);
}

main();
