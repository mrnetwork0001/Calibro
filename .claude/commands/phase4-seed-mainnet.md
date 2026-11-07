Execute **Phase 4: Mainnet Walrus Memory Seeding (>= 20 Memories) & Portable Stateless Agent Proof** of `CALIBRO_PROJECT_SPEC.md`.

Steps:
1. Verify `.env` / `.env.local` has valid `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID`, and `TATUM_API_KEY` (run `npm run verify` first; if credentials are missing, stop and tell the user the exact command `npm run memwal:provision` or `.env` keys needed — NEVER fake Mainnet writes).
2. Create `scripts/seed-mainnet-memories.ts`:
   - Writes 1 user risk mandate to `calibro:mandates`.
   - Steps through 14 realistic historical NBA, EPL, UFC, and Crypto/Macro market evaluations & settlements across Epochs 1..14, writing 14 episodic memories to `calibro:episodic` and 8 updated specialist-domain calibration checkpoints to `calibro:calibration` (**23 real Mainnet memories total**, comfortably exceeding the 10-memory mandatory gate).
   - Uses `idempotencyKey` + `dedupe: true` so re-running never mints duplicate blobs.
   - Saves a verifiable manifest of returned `{ id, blob_id, namespace, owner }` to `docs/mainnet-memory-proof.json`.
3. Create `scripts/portable-agent-demo.ts`:
   - Zero local state, zero database files. Takes ONLY `MEMWAL_ACCOUNT_ID` + `MEMWAL_PRIVATE_KEY` + `TATUM_API_KEY`.
   - Calls `listNamespaces()` and `recall()` from Walrus Mainnet, prints every recalled specialist Brier score, runs a live market evaluation, demonstrates deterministic `x402` fee veto on `hype-contrarian`, and optionally executes 1 real Sui Mainnet `x402` payment verified via Tatum Sui RPC.
4. Execute both scripts against Mainnet and verify `listMemories()` reports `>= 20` live blobs.
