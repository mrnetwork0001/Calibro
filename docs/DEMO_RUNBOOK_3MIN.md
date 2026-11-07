# Calibro: 3-minute demo runbook

**Before recording**
- `.env.local` has all Mainnet keys; `npm run verify` shows OK for Walrus, Tatum, the agent wallet and the data sources.
- `npm run train -- --server http://localhost:3004 --yes` has finished; `docs/mainnet-memory-proof.json` says `"complete": true` and lists two held-out NBA games.
- The agent wallet holds ≥ 0.05 SUI. `npm run dev -- --port 3004`, browser at `/` (landing page).
- A second terminal is open in an empty directory with the portable-agent command ready (step 7).
- The status ribbon shows a green **Live Mainnet** badge and "N memories sealed on Walrus Mainnet". If it says **Not configured**, stop and fix `.env.local`.
- Set the admin header for the browser session if `CALIBRO_ADMIN_TOKEN` is set (or record locally without it).

| Time | Screen | Say |
|---|---|---|
| **0:00–0:20** | Landing page hero | "Prediction agents forget. Every session they pay for the same signals and trust every source equally. Calibro keeps its track record on Walrus Memory and uses it to decide who to pay." |
| **0:20–0:40** | Scroll to *Track record · live from Walrus* | "These numbers are read from our Walrus account: real Polymarket games, settled to Polymarket's result. HypeContrarian crossed the cutoff in every league, and Calibro stopped paying it. And no, it doesn't beat the market; it learns who's worth paying." Click **Launch App**. |
| **0:40–0:55** | Terminal ribbon, then the Dislocation Matrix | "Live Sui checkpoint and SUI price from Tatum, Walrus relayer health, our wallet. Upcoming games with the DraftKings line next to Polymarket, and resolved games priced as of their start." |
| **0:55–1:35** | Filter **Resolved**, **Evaluate** a held-out NBA game from the proof file; watch the comparator and the payment tape | "Calibro recalls its NBA calibration from Walrus. HypeContrarian's recalled Brier is above 0.265, so it refuses that 402 and logs why. SharpSteam, PowerRating and OnchainFlow get paid: each 402 is paid with a real Sui transfer, and the server checks the digest through Tatum's Sui gateway before releasing the signal." Click a digest; Suiscan opens. |
| **1:35–1:55** | Comparator, both sides | "Left, the same agent with no memory pays all four and averages them. Right, de-biased and weighted by track record. If the edge against Polymarket clears the gate, the stake is quarter-Kelly, capped at 5% — on paper." |
| **1:55–2:25** | Panel 4: **Settle & write post-mortem to Walrus** | "This game has resolved on Polymarket, so Calibro recalls its sealed thesis, scores each signal against the real result, and writes the post-mortem and calibration checkpoints back to Walrus Mainnet. A cron job does this every 30 minutes in production." Point at the Brier before → after lines and the new blob id. |
| **2:25–2:35** | Scroll to Panel 5, drag the timeline slider to the 4th NBA settlement | "Every step is one settlement replayed from Walrus. Here HypeContrarian flips to vetoed, and the weights shift to the sources that earned it." Click the blob link. |
| **2:35–2:45** | `/app/picks`: drag the slider, show the coach, then your Earned line | "Before I sign, Calibro recalls my record from Walrus: (read out the coach's real numbers on screen). I'm a TopPicker now, so when Calibro uses my picks it pays my wallet on Sui. Here's the payout." Click the tx. |
| **2:45–2:52** | Second terminal: `MEMWAL_ACCOUNT_ID=… MEMWAL_PRIVATE_KEY=… TATUM_API_KEY=… npx tsx scripts/portable-agent-demo.ts --market <held-out id>` | "A brand-new process with no database and no `.env`. It recalls the same ledger and makes the same veto." |
| **2:52–3:00** | Click **Inspect →** in the ribbon | "Every memory is a real Walrus blob across the episodic, calibration and mandate namespaces. Real games, real payments, real memory; deterministic math. That's Calibro." |

**If something fails live**
- A payment error in the tape means the wallet is low or Tatum is rate-limited. Say "payments are verified on-chain, so a failed transfer means no signal", and evaluate again.
- Settle returns 409 "not resolved": the game hasn't resolved on Polymarket yet. Use the other held-out game.
- Settle shows ALREADY_SETTLED: that's the idempotency guard. Use the other held-out game.
