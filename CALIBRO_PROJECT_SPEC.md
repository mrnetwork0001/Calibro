# Calibro: system specification (as built)

> Total Recall, Tatum x Walrus Memory Hackathon · Markets & Sports Prediction track · Best Walrus Memory · Best Use of Agent Payments
> Stack: Next.js 15 (App Router) · React 19 · TypeScript · Tailwind v4 · `@mysten-incubation/memwal` 0.1.13 + `@mysten/seal` · `@mysten/sui` v2 · Tatum Sui GraphQL gateway + v4 rates · HTTP 402 (x402 + MPP) · vitest
> License: Apache-2.0

This document describes the system as it exists in the repository. `CLAUDE.md` holds the working rules.

---

## 1. Problem

Prediction agents forget. Each session they pay for the same signals, trust every source equally, and learn nothing when a source is confidently wrong. Where results are logged at all, the log sits on one machine and nobody else can check it.

Calibro keeps a per-league track record of every source on Walrus Memory, uses it to decide which signals are worth paying for over HTTP 402 on Sui, and updates it from real results. The record is portable: any process with the account id and delegate key recalls the same state.

## 2. Architecture

```text
 Polymarket (Gamma + CLOB)   ESPN (DraftKings lines, BPI)   The Odds API (Pinnacle)   Kalshi   Manifold
            │  point-in-time snapshot: resolved markets priced 5 min before the start
            ▼
 1. RECALL   Walrus Memory: calibro:mandates (risk rules), calibro:calibration (per source × league),
             calibro:episodic (similar settled games)
            ▼
 2. GATE     per source: exploration (first 4 settled games) → veto if Brier > 0.265
             → veto if VoI ≤ fee in USD (Tatum v4 SUI/USD) → veto if the slate budget is spent
            ▼
 3. PAY      GET /api/signals/:id → 402 (MPP + x402) → Sui Mainnet transfer → paid retry
             → server verifies the digest through Tatum's Sui GraphQL gateway → signed signal
            ▼
 4. DECIDE   Platt de-biasing → trust weights → quarter-Kelly across book and on-chain legs (paper)
            ▼  thesis sealed in calibro:episodic (signals, digests, vetoes, stake)
 5. LEARN    when Polymarket resolves (clean 1/0): score each bought signal, update Brier + Platt,
             write calibration checkpoints and the post-mortem back to Walrus
```

Code: `src/lib/orchestrator/syndicate-engine.ts` (loop), `src/lib/calibration/brier.ts` (maths), `src/lib/walrus/memory-client.ts` (memory), `src/lib/tatum/sui-rpc.ts` (Tatum), `src/lib/x402/` (payments), `src/lib/markets/` and `src/lib/data/` (data).

## 3. Data (all real)

| What | Source |
|---|---|
| Markets, prices, hourly history, resolution | Polymarket Gamma + CLOB public APIs; resolved means UMA "resolved" with a clean 1/0 payout |
| Sportsbook lines | DraftKings open/close/current via ESPN; Pinnacle via The Odds API for upcoming games when `THE_ODDS_API_KEY` is set |
| Model forecast | ESPN BPI pre-game matchup predictor (NBA) |
| Outside crowds | Kalshi exchange candles; Manifold bet history |
| SUI/USD | Tatum v4 rate API |

Resolved markets are priced as of 5 minutes before the scheduled start (last Polymarket print, closing line, pre-game BPI), so training uses no hindsight.

## 4. Sources

Seven sources, all sold behind the same HTTP 402 gate (`src/lib/specialists/models.ts`). Four are Calibro's own documented models, two are outside crowds, one is Calibro's users. None is assumed to be good; Calibro measures each per league.

| id | model | leagues |
|---|---|---|
| `sharp-steam` | de-vigged sportsbook line + ½ of the open→close move (capped ±10 pts) | NBA, EPL, UFC |
| `power-rating` | ESPN BPI win probability | NBA |
| `onchain-flow` | Polymarket price + ½ of its last-6h move | all |
| `hype-contrarian` | `0.5 − 0.8·(p − 0.5) − 0.5·Δ24h` | all |
| `kalshi-crowd` | Kalshi price (hourly close; live bid/ask mid within 10 pts) | NBA, EPL, UFC |
| `manifold-crowd` | Manifold forecast (last bet before the start) | NBA |
| `top-pickers` | trust-weighted picks of users with ≥ 3 graded picks and Brier ≤ 0.25 | upcoming NBA, EPL, UFC |

A source with no data for a market answers 404 before any challenge, so it is never paid for nothing.

## 5. Maths (`src/lib/calibration/brier.ts`, deterministic)

- Brier per source and league: `BS = (1/N) Σ (p − y)²`; 0.25 is a coin flip.
- Platt de-biasing: `logit(p_cal) = α·logit(p_raw) + β`, updated online with bounded log-loss steps.
- Gate: buy everything for the first 4 settled games in a league; then veto when `BS > 0.265`, or when `VoI = bankroll × κ × (0.265 − BS) × 0.6` is at most the fee in USD, or when the slate's x402 budget (mandate, default 0.05 SUI) is spent.
- Trust weight: `max(0.01, 0.28 − BS)²`, boosted once a source has ≥ 4 samples; the weighted log-odds mean is Calibro's probability. The equal-weight mean is kept for comparison.
- Stake: `f = min(κ·(P·O − 1)/(O − 1), 5%)`, κ ≤ 0.25, minimum edge 2%, evaluated for YES at the book, YES on-chain and NO on-chain; the best leg wins. Paper only.

## 6. Walrus Memory

Mainnet relayer `https://relayer.memory.walrus.xyz`, SEAL-encrypted. Each record is a semantic header (embedded for recall) plus a JSON payload (parsed exactly after decryption).

| Namespace | Records |
|---|---|
| `calibro:episodic` | `episodic_v1` theses (prices, Calibro and equal-weight probabilities, signals used with x402 digests, vetoes with reasons, recommended action and stake) and the same record settled (outcome, realized Brier, P&L) |
| `calibro:calibration` | `calibration_v1` checkpoint per source × league per settlement (samples, Brier, α, β, paid/vetoed counts, last settled market) |
| `calibro:mandates` | `mandate_v1` bankroll, Kelly multiplier, max stake, min edge, slate x402 budget, leagues |
| `calibro:picks` | `pick_v1` wallet-signed picks, `scorecard_v1` per-user scorecards, `payout_v1` TopPickers payouts |

Recall caps at 100 hits and `sort: "recent"` re-sorts a semantic window, so calibration is recalled per (source, league), and the track record, ledger and learning timeline are replayed from settled post-mortems with the engine's own update function (the replay reproduces the stored checkpoints exactly; see `tests/products.test.ts`). Settlement is idempotent: each checkpoint records the market that produced it.

## 7. Agent payments (x402 + MPP on Sui)

- `402` carries `WWW-Authenticate: Payment realm="calibro-signals", protocol="mpp-sui-v1", network="sui:mainnet", recipient, coinType, amount, challengeId` and `X-Payment-Required` (base64 JSON, x402 v1). `challengeId` is an HMAC-signed, self-describing token, so a stateless function can check the paid retry.
- Paid retry: `Authorization: Payment <base64>` or `X-Payment: <base64>` with `{ txDigest, challengeId, payer }`.
- Verification through Tatum's Sui GraphQL (`transaction(digest)`): status success; recipient and every split share credited at least the amount in the challenge's coin; sender is the payer; landed after the challenge; never redeemed. The digest is reserved before the RPC and released on failure. Malformed digests are rejected with 402.
- Replay ledger: Upstash Redis / Vercel KV in production, file locally.
- The buyer (`src/lib/x402/http-signal-provider.ts`, `sui-payer.ts`) refuses challenges for more, or for another coin, than the gate approved, serializes payments from one wallet, and refuses to pay itself.

| Product | Price | Paid to |
|---|---|---|
| Specialist signals (`/api/signals/:id`) | 0.002 SUI (`CALIBRO_X402_DEFAULT_PRICE_RAW`) | signal treasury |
| TopPickers signal | 0.002 SUI split by trust weight | qualified pickers' wallets, one transaction |
| Calibro's forecast (`/api/forecast`) | 0.01 SUI (`CALIBRO_FORECAST_PRICE_RAW`) | agent wallet (funds its own signal purchases) |

Discovery: `/.well-known/x402` and `/llms.txt`.

## 8. Users

- **Pick journal** (`/app/picks`): connect a Sui wallet (Wallet Standard), sign a probability up to one minute before the start; the signature is verified through Tatum's gateway (zkLogin included) and the pick is sealed in `calibro:picks`. Rate limited per address and globally.
- **Grading**: when Polymarket resolves, the settlement job grades picks and updates the scorecard (Brier and Platt per league, the market's Brier on the same games, Calibro's on overlapping games, findings such as overconfidence on favourites).
- **Coach**: before signing, the user's graded picks and Calibro's settled games are recalled; the deterministic coach (`src/lib/picks/coach.ts`) suggests a shrunk number. Scorecards compare picks made with and without following it.
- **TopPickers**: users with ≥ 3 graded picks and Brier ≤ 0.25 become a paid, calibrated, vetoable source.

## 9. Reads, caching and scheduling

- **Read cache** (`src/lib/server/read-cache.ts`): Upstash Redis / Vercel KV when configured, shared by every serverless instance; otherwise a JSON file under `.calibro/cache/` locally or the OS temp dir on Vercel without KV. Fresh values are served directly, stale ones while they refresh, and when Walrus Memory fails the last good value is served marked stale with its time. Writes (settle, picks) bump a generation so readers reload.
- **Read models** (`src/lib/server/read-models.ts`) behind `/api/calibration`, `/api/timeline`, `/api/leaderboard`, `/api/walrus/audit`, `/api/record` and the landing page.
- **Cron**: `GET /api/cron/settle` settles resolved theses and grades picks; `GET /api/cron/warm` refreshes the read models. Both need `CRON_SECRET`. GitHub Actions (`.github/workflows/settle.yml`) calls them every 30 minutes; `vercel.json` adds a daily run (Hobby-compatible).

## 10. Pages and routes

| Page | What it shows |
|---|---|
| `/` | live track record, hero chart of source Brier scores, method, docs for agents |
| `/app` Terminal | markets (Polymarket vs book, alerts), forecast comparator (no memory vs recalled record), payment tape, calibration ledger and reliability curve, learning timeline, memory inventory |
| `/app/picks` Pick journal | log a pick with the coach, scorecard, leaderboard |
| `/app/record` Record | every settled game from Walrus: Calibro vs Polymarket, Brier, paid sources with Sui tx links, refused sources and why, post-mortem blob links, account / wallet / treasury links |

Visitors can press Evaluate on a resolved market: `POST /api/evaluate/preview` runs the same engine with Calibro's real recalled record and signals computed in-process, pays nothing and writes nothing, and is labelled "Preview · nothing paid or written". If Calibro evaluated that game on Mainnet, the recorded blobs and payment digests are shown alongside. Live evaluation (`POST /api/evaluate`) and settlement (`POST /api/settle`) spend SUI and write Walrus, so they need the operator's `x-calibro-admin` token; agents can buy upcoming forecasts over x402 instead.

Read routes: `markets`, `status`, `calibration`, `timeline`, `record`, `leaderboard`, `walrus/audit`, `picks`, `picks/coach`. Paid: `signals/[specialistId]`, `forecast`. Guarded: `evaluate`, `settle`, `cron/settle`, `cron/warm`.

## 11. Scripts

| Command | Does |
|---|---|
| `npm run setup:keys` | creates `.env.local` with an agent wallet and server secrets |
| `npm run memwal:provision` | creates the Walrus Memory account and delegate key |
| `npm run verify` | preflight: keys, wallet balance, data sources, maths |
| `npm run train -- --server <url> --yes` | trains on resolved Polymarket games with real payments and writes; merges into `docs/mainnet-memory-proof.json` |
| `npm run train:preview` | the same backtest, unpaid, nothing written |
| `npm run settle [-- --every 30]` | settles and grades locally |
| `npm run agent:portable` | a stateless process that recalls the same ledger and makes the same vetoes |
| `npm run buy:forecast` | an outside buyer for the forecast product |

## 12. Known limits

- Recall exactness up to roughly 50 settlements per league; beyond that, a compaction snapshot.
- A vetoed source cannot earn its way back (an unpaid signal can't be scored); exploration is the first 4 settled games per league.
- The signal treasury is ours: no outside vendor sells sports signals over x402 on Sui today. The payments are still real Mainnet transfers.
- Stakes are recommendations on a paper bankroll.
