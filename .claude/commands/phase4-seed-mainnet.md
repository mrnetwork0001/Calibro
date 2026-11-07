**Train on Mainnet and refresh the proof.**

1. Run `npm run verify` first. If `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID`, `TATUM_API_KEY` or `CALIBRO_AGENT_SUI_PRIVATE_KEY` is missing, stop and tell the user (`npm run setup:keys`, `npm run memwal:provision`). Never fake a Mainnet write.
2. Start the server (`npm run dev -- --port 3004`), dry-run `npm run train -- --server http://localhost:3004` to see the game count and payment cap, then add `--yes` only with the user's go-ahead (it spends real SUI). Use `--nba N --epl N --ufc N --holdout N` to limit it.
3. Training merges into `docs/mainnet-memory-proof.json` (real blob ids and payment digests only).
4. Check the portable agent: `npm run agent:portable -- --market <held-out id>` recalls the same ledger with no local state.
