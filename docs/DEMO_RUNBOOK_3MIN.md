# Calibro: 3-minute demo runbook

**Before recording**
- `npm run verify` is OK for Walrus, Tatum, the agent wallet and the data sources. The agent wallet holds at least 0.05 SUI (one evaluation costs about 0.015 SUI: up to six 0.002 SUI payments plus gas).
- The app is running (https://www.trycalibro.xyz, or `npm run dev -- --port 3004`). Warm the read cache once: open `/app/record`, or call `GET /api/cron/warm` with the cron secret.
- In the terminal, filter **Resolved** and note two NBA games: one marked **settled** (for the visitor preview) and one not settled (for the live run). The terminal lists the four newest resolved games per league.
- Log a few real picks from your own wallet a day ahead so the Pick journal has a graded scorecard; run `npm run settle` after the games if you're local.
- Two browser windows: a private one with no admin token (visitor), and a normal one where you'll unlock the operator mode.
- A second terminal with the portable-agent command ready (last step).
- The header shows the green dot with the **Sui logo** and "Mainnet", and the memory count. If it says **Not configured**, stop and fix the environment.

| Time | Screen | Say |
|---|---|---|
| **0:00–0:15** | Landing hero | "Prediction agents forget. Every session they pay for the same signals and trust every source equally. Calibro keeps each source's record on Walrus Memory and uses it to decide who to pay." |
| **0:15–0:30** | Scroll to *The record so far* | "These numbers are read live from our Walrus account: real Polymarket games, settled to Polymarket's own result. It doesn't beat the market. What it learns is who's worth paying." Click **Open the terminal**. |
| **0:30–0:45** | Terminal status strip, then Markets | "Sui checkpoint and SUI price from Tatum, Walrus relayer health, our agent wallet. Upcoming games with the sportsbook line next to Polymarket; flagged rows are where they disagree." |
| **0:45–1:10** | Private window: **Resolved** → **Preview** on the settled game | "Anyone can do this. It's a preview: Calibro recalls its real record from Walrus and computes the signals, but pays nothing and writes nothing. Left, an agent with no memory pays everyone and averages them. Right, Calibro refuses HypeContrarian because its recalled Brier is above 0.265. And here is what it actually did on Mainnet for this game." Click a payment link; Suiscan opens. |
| **1:10–1:50** | Normal window: **Operator access** (foot of the terminal) → token → **Evaluate** the unsettled game; watch the payment tape | "Now for real. Each paid source answers 402; Calibro pays on Sui Mainnet, and the server checks the transaction through Tatum's Sui gateway before releasing the signal. HypeContrarian is refused and the saved fee is logged." Click a digest. |
| **1:50–2:10** | Calibration ledger: **Settle and record on Walrus** | "The game has resolved, so Calibro recalls its sealed thesis, scores every signal it bought against the result, and writes the post-mortem and new calibration checkpoints to Walrus Mainnet." Point at Brier before → after and the post-mortem blob id. |
| **2:10–2:25** | Learning timeline, drag to the fourth NBA settlement | "Each step is one settlement replayed from Walrus. Here HypeContrarian flips to refused, and the weight moves to the sources that earned it." |
| **2:25–2:40** | **Record** tab | "Every game Calibro has settled, straight from Walrus: its number against Polymarket's, who it paid with the Sui transaction, who it refused and why, and the post-mortem blob. The game we just settled is at the top." Click a Walruscan link. |
| **2:40–2:52** | **Pick journal**: connect wallet, pick a game, move the slider | "People pick too. Before I sign, Calibro recalls my record and tells me what it says about my number. The pick is signed by my wallet and sealed on Walrus, graded when the game resolves, and pickers with a good record become a paid source." |
| **2:52–3:00** | Second terminal: `MEMWAL_ACCOUNT_ID=… MEMWAL_PRIVATE_KEY=… TATUM_API_KEY=… npm run agent:portable -- --market <game id>` | "A fresh process with no database. It recalls the same ledger and makes the same refusal. Real games, real payments, real memory." |

**If something fails live**
- A payment error in the tape means the wallet is low or Tatum is rate-limiting. Payments are verified on-chain, so a failed transfer means no signal; evaluate again.
- Settle returns 409 "not resolved": Polymarket hasn't resolved the game yet. Use another resolved game.
- Settle shows ALREADY_SETTLED: the idempotency guard. Use another resolved game.
- A panel says Walrus Memory is slow: it shows the last good values with their time and retries on its own. Say so and move on.
