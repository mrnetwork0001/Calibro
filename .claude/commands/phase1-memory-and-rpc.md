Execute **Phase 1: Core Walrus Memory, Tatum Sui RPC & Calibration Engine** of `CALIBRO_PROJECT_SPEC.md`.

Steps:
1. Inspect `src/lib/types/calibro.ts`, `src/lib/calibration/brier.ts`, `src/lib/walrus/memory-client.ts`, and `src/lib/tatum/sui-rpc.ts`.
2. Build `src/lib/orchestrator/syndicate-engine.ts` that wires the full closed loop:
   - Step A: Recall active mandate (`calibro:mandates`), latest domain calibrations (`calibro:calibration` with `sort: "recent"`), and analogous past markets (`calibro:episodic` with `sort: "relevance"`).
   - Step B: Evaluate `shouldPayX402Gate()` for each of the 4 specialists (`sharp-steam`, `injury-scout`, `onchain-flow`, `hype-contrarian`), converting the SUI/USDC `x402` fee into USD via Tatum's live rate (with deterministic fallback if offline).
   - Step C: Aggregate unlocked signals via Platt log-odds de-biasing + inverse-Brier precision weighting, then run the Fractional Kelly gate against bookmaker vs on-chain implied odds.
   - Step D: Provide `settleMarketAndLearn()` which computes per-specialist Brier deltas, updates Platt `(alphaSlope, betaIntercept)` via online gradient/shrinkage update, and writes both the settled episodic record and updated calibration records back to Walrus Memory (`rememberAndWait` / `rememberBulkAndWait`).
3. Add thorough Vitest tests in `tests/syndicate-engine.test.ts` verifying Epoch 1 -> Epoch 12 learning on `MemWalMock`.
4. Run `npm run typecheck && npm test && npm run verify` and report exact results.
