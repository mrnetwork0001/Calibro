Execute **Phase 3: Institutional Terminal UI + Tatum AI Builder Module Integration** of `CALIBRO_PROJECT_SPEC.md`.

Steps:
1. Check `docs/AI_TATUM_BOOTSTRAP_PROMPT.md` and integrate/preserve the `ai.tatum.io`-bootstrapped market & Sui RPC telemetry components inside `src/components/tatum-ai/`.
2. Build an institutional, high-contrast quantitative trading & sports-syndicate terminal in `src/app/page.tsx` and `src/components/`:
   - **Top Status Ribbon:** Live Tatum Sui Mainnet Checkpoint ticker, SUI/USD rate from Tatum v4 API, Walrus Memory Relayer status (`LIVE_MAINNET` vs `MOCK_SANDBOX`), and Live Mainnet Memory Counter (`e.g. 24 Memories Sealed on Walrus Mainnet` — green badge when `>= 10`).
   - **Panel 1 — Bookmaker vs. On-Chain Dislocation Matrix:** Interactive slate of NBA, EPL, UFC, and Crypto/Macro markets showing Sharp Book Implied %, On-Chain Implied %, Raw Spread, and `[Evaluate with Calibro]` trigger.
   - **Panel 2 — "Cold Start vs. Total Recall" Split-Screen Comparator (THE HERO DEMO FEATURE):** One-click comparison showing how a zero-memory agent behaves (pays all 4 `x402` gates, naive 25% weights) vs. Calibro after recalling Walrus calibration memories (vetoes `hype-contrarian` `x402` fee, shrinks overconfidence, concentrates weight on sharp specialists, outputs calibrated Kelly stake).
   - **Panel 3 — Live HTTP `x402` / `MPP` Micropayment & Tatum Receipt Tape:** Real-time log of `402` challenges, `PAID` Sui `txDigest` links (Suiscan/Suivision) verified via Tatum RPC, and `VETOED` fees saved in SUI/USD.
   - **Panel 4 — Epistemic Calibration & Brier Curve Visualizer:** Pure SVG reliability diagram (Predicted Probability vs Observed Hit Rate against the $y=x$ diagonal) + domain Brier leaderboard across the 4 specialists + interactive `[Settle & Write Post-Mortem to Walrus]` button with live job status (`pending -> running -> uploaded -> done`).
   - **Panel 5 — Proof-of-Mainnet Walrus Blob Inspector & Portable Brain Drawer:** Lists real `blob_id`s, namespaces (`calibro:episodic`, `calibro:calibration`, `calibro:mandates`), `created_at` timestamps, and the CLI command to hydrate a stateless agent from the exact same `MEMWAL_ACCOUNT_ID`.
3. Ensure zero layout jitter, crisp monospace numbers (`tabular-nums`), responsive layout, and `npm run build` succeeding cleanly.
