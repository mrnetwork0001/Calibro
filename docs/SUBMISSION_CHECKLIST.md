# Calibro — Submission & Demo Master Checklist

**Submission Deadline:** **November 10, 2026 @ 17:00 UTC** (`https://tatum.io/hackathon/total-recall`)

## 1. Mandatory Eligibility Gates
- [ ] **Walrus Memory on Mainnet (`>= 10` memories):** Fund the agent wallet, run `npm run memwal:provision`, then `npm run train -- --server http://localhost:3004 --yes` to train on real resolved Polymarket games. It writes ~100 real SEAL-encrypted memories across `calibro:episodic`, `calibro:calibration` and `calibro:mandates` and `docs/mainnet-memory-proof.json`. Commit the proof file.
- [ ] **Tatum Integration:**
  - [ ] Live Sui Mainnet calls via Tatum's Sui GraphQL gateway `https://sui-mainnet.gateway.tatum.io/graphql` (`x-api-key`).
  - [ ] Live SUI/USD & USDC/USD spot pricing via Tatum v4 Data API (`/v4/data/rate/symbol`).
  - [ ] Initial telemetry/dislocation shell bootstrapped on `https://ai.tatum.io` (`docs/AI_TATUM_BOOTSTRAP_PROMPT.md`).
- [ ] **Agent Payments (`x402` + `MPP` on Sui Mainnet):**
  - [ ] Live `402 Payment Required` challenge (`WWW-Authenticate: Payment` + `X-Payment-Required`).
  - [ ] Real Sui Mainnet micro-payment `txDigest` verified via Tatum Sui GraphQL `transaction(digest)`.
- [ ] **Differentiators to show in the demo:**
  - [ ] Pick journal (`/app/picks`): a wallet-signed pick sealed in `calibro:picks`, later graded with a scorecard and on the leaderboard.
  - [ ] Learning timeline (terminal panel 5): drag to the 4th game in a league and show HypeContrarian flip to Vetoed, with the Walrus blob link.
  - [ ] Calibro as a vendor: `npm run buy:forecast` buys the forecast over x402 from another wallet; show `/.well-known/x402`.
  - [ ] Third-party voices (KalshiCrowd, ManifoldCrowd) in the calibration ledger; disagreement alerts in the matrix.
  - [ ] CI badge green on GitHub; settlement workflow secrets (`CALIBRO_URL`, `CRON_SECRET`) set.
- [ ] **Core Artifacts:**
  - [ ] Public GitHub repository (`Apache-2.0`).
  - [ ] Live deployed web app (Vercel) + 3-minute demo video.
  - [ ] Published technical blog post (`docs/BLOG_POST.md` -> Dev.to / Medium).

## 2. 3-Minute Demo Video Arc (Designed for Maximum Judge Score)
- **0:00 – 0:30 | The Problem:** Prediction agents have epistemic amnesia — they pay `x402` fees to noisy sources every session and treat uncalibrated Twitter scrapers the same as sharp line-movement models.
- **0:30 – 1:15 | Tatum + `ai.tatum.io` + Live Dislocation Scan:** Show live Sui Mainnet checkpoint & SUI/USD rate via Tatum APIs, plus NBA/EPL/Crypto bookmaker vs on-chain implied probability spreads.
- **1:15 – 2:10 | Cold Start vs. Total Recall (Hero Moment):**
  - Show **Epoch 1 (Cold Start)**: Agent pays `x402` micro-fees to all 4 specialists (`25%` each).
  - Trigger **Total Recall from Walrus Mainnet** on a held-out real game: Agent recalls `calibro:calibration`, **autonomously vetoes the `x402` payment** to `hype-contrarian` (recalled Brier above the 0.265 cutoff), pays the other specialists on Sui Mainnet, verifies each `txDigest` via Tatum's Sui GraphQL gateway, de-biases log-odds, and outputs a quarter-Kelly paper stake.
- **2:10 – 2:45 | Post-Mortem Learning + Portable Brain Proof:** Settle a resolved market live against Polymarket's result -> watch Walrus Memory status (`pending -> running -> uploaded -> done`) mint a new Mainnet `blob_id` -> run `npx tsx scripts/portable-agent-demo.ts` in a blank terminal with zero local DB to prove instant cross-runtime memory portability.
- **2:45 – 3:00 | Proof-of-Mainnet Audit Drawer:** Open the Walrus Inventory Drawer showing the live Mainnet `blob_id`s across all 3 namespaces.
