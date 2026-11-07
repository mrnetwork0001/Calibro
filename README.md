# Calibro

**An autonomous Bayesian prediction syndicate that remembers which sources were wrong.**

Calibro compares sportsbook and Polymarket prices on real NBA, EPL, UFC and crypto markets, buys specialist signals behind **HTTP 402** gates (**x402 + MPP**) settled on **Sui Mainnet**, verifies every receipt through **Tatum's Sui Mainnet gateway** (Sui GraphQL), and keeps a per-league calibration ledger on **Walrus Memory Mainnet** (`@mysten-incubation/memwal`, SEAL-encrypted). Every market is settled to Polymarket's own resolution. Once a source's recalled track record is bad, Calibro refuses to pay it; the rest are de-biased and weighted by their record, and stakes are sized with quarter-Kelly.

There is no mock data and no sandbox mode: markets, prices, sportsbook lines and results are real, and without Walrus keys the app is read-only.

Built for **Total Recall: Tatum × Walrus Memory Hackathon** · Markets & Sports Prediction · Best Walrus Memory · Best Use of Agent Payments.

---

## Data: all real

| What | Source |
|---|---|
| Markets, prices, hourly history, results | Polymarket Gamma + CLOB public APIs (resolution = UMA "resolved" with a clean 1/0 payout) |
| Sportsbook lines | DraftKings open/close/current moneylines via ESPN; Pinnacle via The Odds API for upcoming games when `THE_ODDS_API_KEY` is set |
| Model forecast | ESPN BPI pre-game matchup predictor (NBA) |
| Outside crowds | Kalshi exchange candles; Manifold bet history |
| SUI/USD | Tatum v4 rates (no static fallback) |

Past markets are priced **point-in-time**, as of 5 minutes before the scheduled start: the last Polymarket print before then, the sportsbook closing line, ESPN's pre-game BPI. Training on them uses no hindsight.

## The sources

Seven sources, sold behind HTTP 402 ([`src/lib/specialists/models.ts`](src/lib/specialists/models.ts)). Four are Calibro's own documented models, two are third-party crowds, and one is Calibro's own users. Nobody claims any of them is good: Calibro measures it per league.

| Source | Model | Coverage |
|---|---|---|
| SharpSteam | de-vigged sportsbook line + ½ of the open→close move (capped ±10 pts) | NBA, EPL, UFC |
| PowerRating | ESPN BPI win probability | NBA |
| OnchainFlow | Polymarket price + ½ of its last-6h move | all |
| HypeContrarian | fades the crowd: `0.5 − 0.8·(p − 0.5) − 0.5·Δ24h` | all |
| KalshiCrowd | Kalshi exchange price (hourly close; live bid/ask mid within 10 pts) | NBA, EPL, UFC |
| ManifoldCrowd | Manifold community forecast (last bet before the start) | NBA |
| TopPickers | trust-weighted picks of Calibro's users with a record (≥ 3 graded, Brier ≤ 0.25); fee split to their wallets | NBA, EPL, UFC (upcoming) |

A specialist without data for a market answers 404 before any challenge, so it is never paid for nothing.

## Features

- **Pick journal** (`/app/picks`): connect any Sui wallet (Wallet Standard), sign a probability before the game, and it's sealed in `calibro:picks` on Walrus. The signature is verified server-side (zkLogin-capable, via Tatum's gateway). When Polymarket resolves the game, the settlement job grades it and updates your scorecard with the same Brier and Platt maths the sources get, with plain findings such as "overconfident on favourites", each computed from your graded picks. A leaderboard ranks you against the market on your own games, and against Calibro and every source.
- **Pick coach**: before you sign, Calibro recalls your record and its own from Walrus and tells you what they say about your number. For example: how often your past picks at this confidence actually won, read as a shrunk estimate you can adopt with one click; how you've done when you disagreed with the market; how sides priced like this one did across every game Calibro settled. Each pick stores whether a suggestion was shown, and your scorecard reports your Brier when you followed the coach versus when you didn't.
- **Calibro pays its best pickers (TopPickers)**: users with ≥ 3 graded picks and Brier ≤ 0.25 become a paid source. When Calibro buys the TopPickers signal for an upcoming game, the x402 fee is split by trust weight and paid straight into those users' wallets in one Sui transaction; the server checks through Tatum that every share was credited, and each payout is written to the picker's history on Walrus. TopPickers is scored and vetoed like any other source.
- **Record** (`/app/record`): every game Calibro has settled, read live from Walrus Memory and readable by anyone: Calibro's probability next to Polymarket's, both Brier scores, the sources it paid with a Suiscan link for each payment, the sources it refused and why, and the post-mortem blob on Walruscan. The Walrus account, agent wallet and treasury are linked at the top.
- **Preview for visitors**: anyone can press Preview on a resolved game. `POST /api/evaluate/preview` runs the same engine with Calibro's real recalled record and computes the signals in-process with the same models; nothing is paid and nothing is written, and the result is labelled "Preview · nothing paid or written". If Calibro evaluated that game on Mainnet, the recorded thesis, post-mortem and payment digests are shown beside it. Live evaluation of upcoming games spends real SUI, so it stays with the operator (the token form sits behind an "Operator" link); agents can buy the same forecast over x402.
- **Learning timeline** (terminal): a slider over the settled post-mortems on Walrus. Each step is one settlement; trust weights shift, vetoes switch on, and each step links to its post-mortem blob. Status and weights come from the engine's own gate and weighting functions.
- **Calibro sells its forecast** (`GET /api/forecast?marketId=…`, 0.01 SUI over x402 / MPP): any agent can buy Calibro's calibrated P(YES) with the sources it paid, their weights, the vetoes and the Walrus blob of the thesis. Revenue goes to the agent wallet that pays the specialists. Discovery: [`/.well-known/x402`](src/app/.well-known/x402/route.ts) and [`/llms.txt`](public/llms.txt); a complete outside buyer is `npm run buy:forecast`.
- **Disagreement alerts**: markets where the sportsbook or Kalshi is ≥ 3 points from Polymarket, or where the sources split on the favourite, are flagged in the terminal (source values stay behind the paywall).
- **Settles itself**: `/api/cron/settle` settles resolved markets and grades picks, and `/api/cron/warm` refreshes the cached read models. A GitHub Actions schedule ([`settle.yml`](.github/workflows/settle.yml)) calls both every 30 minutes; [`vercel.json`](vercel.json) adds a daily run.
- **Fast, honest reads**: the Walrus-backed views (calibration, timeline, leaderboard, inventory, record, landing) go through a shared read cache: Upstash Redis / Vercel KV when configured, a local file otherwise. When the relayer is slow, the last good value is served and labelled with its time; when nothing is cached, the panel says what failed and retries. It never shows an empty record in place of an error.

## Real-data backtest

Training run on Mainnet (`npm run train -- --server … --yes`), as of 7 Nov 2026: 37 real games played 31 October – 7 November 2026 (23 NBA, 7 EPL, 7 UFC), each signal bought with a real Sui payment, everything written to Walrus. Numbers from [`docs/mainnet-memory-proof.json`](docs/mainnet-memory-proof.json):

| | Mean Brier |
|---|---|
| Polymarket price | 0.181 |
| Calibro | 0.188 |
| Equal-weight average of bought signals | 0.186 |

- HypeContrarian's recalled Brier passed the 0.265 cutoff in every league (0.31–0.35), and Calibro **refused to pay it 25 times** (19 NBA, 3 EPL, 3 UFC).
- The other sources stayed near the market (0.14–0.22) and kept being paid: 124 paid signals, each with a Sui digest. KalshiCrowd and ManifoldCrowd were added late (9 and 8 of the 37 games) and are paid in the NBA.
- Paper P&L on a $2,500 bankroll was −$313: small "edges" against an efficient market lost.
- Inventory after the run: 232 memories (76 `calibro:episodic`, 155 `calibro:calibration`, 1 `calibro:mandates`).
- A second wallet (our signal treasury, standing in for an outside agent) bought Calibro's forecast for 0.01 SUI ([tx](https://suiscan.xyz/mainnet/tx/6LdsBThaAGd1VhkcfVXKwwS98qJr5XGypwuwmZpUnNY4)); to fill it Calibro paid five sources over x402 and vetoed one. That game was settled too, so the live app shows one more game than the proof file.

What this shows is that Calibro learns which sources are worth paying for, from real outcomes. It does not show that Calibro beats Polymarket, and on this sample it does not.

## The loop

1. **Recall** (`calibro:mandates`, `calibro:calibration` with `sort: "recent"`, `calibro:episodic` with `sort: "relevance"`): the risk mandate, the newest Brier score and Platt parameters per specialist and league, and similar past markets.
2. **Gate**: for each specialist, expected value of information vs the x402 fee in USD (Tatum v4 rates). Veto when the recalled Brier score is above 0.265 after 4 samples, or when VoI ≤ fee, or when the slate's SUI budget is spent.
3. **Pay and verify**: `GET /api/signals/:id` → `402` with `WWW-Authenticate: Payment …` + `X-Payment-Required` → Sui Mainnet transfer → paid retry with `Authorization: Payment <receipt>` → server checks the digest through Tatum's Sui GraphQL gateway (`transaction(digest)`): success, recipient credited ≥ amount in the right coin, sender = payer, landed after the challenge, never redeemed before.
4. **Decide**: Platt de-biasing `logit(p_cal) = α·logit(p_raw) + β`, inverse-Brier precision weights, then fractional Kelly across the sportsbook and on-chain legs (≤ 0.25 Kelly, ≤ 5% bankroll).
5. **Learn**: once Polymarket resolves the market, recall the sealed thesis from Walrus, update Brier and Platt per specialist, write calibration checkpoints (`rememberBulkAndWait`) and the post-mortem (`rememberAndWait`). A cron job (`/api/cron/settle`, every 30 min) settles open theses automatically. Settlement is idempotent and crash-safe.

All probability, payment and sizing math is deterministic TypeScript in [`src/lib/calibration/brier.ts`](src/lib/calibration/brier.ts). No LLM is involved.

## Run it

```bash
npm install
npm run setup:keys          # creates .env.local: agent wallet, treasury, server secrets
                            # then add TATUM_API_KEY (and optionally THE_ODDS_API_KEY)
npm run verify              # preflight: keys, wallet balance, data sources
npm run train:preview       # real-data backtest, nothing paid or written
npm run dev                 # http://localhost:3000 → Open the terminal → /app
```

Without Walrus keys the terminal shows live markets and prices but is read-only.

### API

| Route | What |
|---|---|
| `GET /api/markets` | upcoming and recently resolved Polymarket markets with book prices and alerts |
| `GET /api/status` | Tatum checkpoint and SUI/USD, relayer health, memory count, agent wallet |
| `GET /api/calibration` · `/api/timeline` · `/api/record` · `/api/leaderboard` · `/api/walrus/audit` | Walrus-backed read models (cached) |
| `GET /api/signals/:id` · `/api/forecast` | paid over HTTP 402 (x402 + MPP) on Sui |
| `POST /api/picks` · `GET /api/picks` · `GET /api/picks/coach` | signed picks, scorecards, coach data |
| `POST /api/evaluate/preview` | public preview on resolved markets: nothing paid, nothing written |
| `POST /api/evaluate` · `POST /api/settle` | operator only (`x-calibro-admin`) |
| `GET /api/cron/settle` · `/api/cron/warm` | scheduled (`CRON_SECRET`) |
| `GET /.well-known/x402` · `/llms.txt` | discovery for agents |

### Going live on Mainnet

| Step | Command |
|---|---|
| Fund the agent wallet | send ~0.5 SUI to the address `npm run verify` prints |
| Walrus account | `npm run memwal:provision` (writes `MEMWAL_ACCOUNT_ID` / `MEMWAL_PRIVATE_KEY` into `.env.local`) |
| Train on real games | `npm run dev -- --port 3004` in one terminal, then `npm run train -- --server http://localhost:3004 --yes` |
| Settle + grade picks locally | `npm run settle` (or `npm run settle -- --every 30` to keep running) |
| Portable brain | `MEMWAL_ACCOUNT_ID=… MEMWAL_PRIVATE_KEY=… TATUM_API_KEY=… npm run agent:portable` |
| Outside agent buys a forecast | `BUYER_SUI_PRIVATE_KEY=… npm run buy:forecast -- --server http://localhost:3004` |

Training buys every signal over HTTP 402 with a real Sui transfer (verified via Tatum), writes each thesis, post-mortem and calibration checkpoint to Walrus, and updates `docs/mainnet-memory-proof.json` after every market with the real blob ids and digests. It is resumable, and a partial run (for example `--nba 1 --epl 0 --ufc 0 --holdout 0`) merges into the existing proof instead of replacing it.

### Deploying (Vercel)

Set the same variables plus:
- `CALIBRO_ADMIN_TOKEN`: evaluate and settle require the `x-calibro-admin` header, so visitors can't spend your SUI or write to your Walrus account.
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or Vercel KV): the shared anti-replay ledger, rate limits and read cache. Without it, signal sales are refused on Vercel and every function instance reads Walrus on its own.
- `CRON_SECRET`: authenticates `/api/cron/settle` and `/api/cron/warm`. [`vercel.json`](vercel.json) runs settlement daily (Hobby-compatible); add repository secrets `CALIBRO_URL` and `CRON_SECRET` for the 30-minute GitHub Actions schedule, which also keeps the read cache warm.

## Mainnet proof

`docs/mainnet-memory-proof.json` is written by `npm run train` from the relayer's and Sui's responses: per market, the thesis and post-mortem blob ids, calibration blob ids, every x402 payment digest, and the account inventory. In the app, the **Record** tab lists every settled game with its payment and blob links, and the terminal's **memory inventory** drawer walks `listNamespaces()` + `listMemories()` live and links each blob to Walruscan.

## What to know

- **The treasury is ours.** No outside signal vendor sells over x402 on Sui today, so Calibro's own specialists are the vendors and their fees go to a treasury we control. The payments are still real Sui Mainnet transfers, verified through Tatum.
- **Stakes are paper.** Calibro recommends a leg and a quarter-Kelly stake; it doesn't place bets.
- **ESPN's endpoints are public but unofficial.** BPI isn't timestamped by ESPN; Calibro uses the published pre-game projection.

## Known limits

- **Tatum's Sui gateway is GraphQL, not JSON-RPC.** `https://sui-mainnet.gateway.tatum.io` (the JSON-RPC root) returns 404; Calibro uses `/graphql`. Free plans allow 3 requests a second; the client throttles and retries on 429.

- **Recall scale.** The relayer returns at most 100 hits and `sort: "recent"` only re-sorts a semantic window, so Calibro recalls each (source, league) pair separately: the newest checkpoint is exact up to ~50 settlements per league. The learning timeline and track record replay settled post-mortems per league (exact up to ~50 settled markets per league). Beyond that, a compaction snapshot is needed.
- **Anti-replay ledger**: a file locally, Redis (Upstash / Vercel KV) in production. On Vercel without Redis, signal sales are refused rather than risking replays.
- **No re-exploration after a veto:** a vetoed specialist can't earn its way back, because an unpaid signal can't be scored. Exploration is the first 4 settled games per league.

## Layout

```
src/lib/calibration/brier.ts            deterministic Brier / Platt / VoI / Kelly
src/lib/orchestrator/syndicate-engine.ts  recall → gate → decide → learn
src/lib/walrus/memory-client.ts         4-namespace Walrus Memory client
src/lib/tatum/sui-rpc.ts                Tatum Sui GraphQL verifier + v4 rates (throttled, 3 req/s)
src/lib/x402/                           402 protocol, shared paywall, signal gate, buyer, Sui payer, replay ledger
src/lib/picks/ · src/lib/forecast/      pick journal + scorecards · forecast product
src/lib/timeline/                       learning-timeline replay of the calibration ledger
src/lib/data/                           Polymarket, ESPN, The Odds API, Kalshi, Manifold clients
src/lib/markets/                        point-in-time snapshots, market feed, settlement
src/lib/server/                         runtime wiring, shared read cache + read models, rate limits
src/app/api/                            see the API table above
src/app/page.tsx · src/app/app/         landing page · terminal · app/picks (pick journal) · app/record
scripts/                                verify, provision, train-mainnet, portable-agent-demo
```

## Checks

```bash
npm run typecheck && npm test && npm run build
```

GitHub Actions runs the same three on every push ([`ci.yml`](.github/workflows/ci.yml)).

## License

Apache-2.0. See [LICENSE](./LICENSE).
