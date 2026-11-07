# CALIBRO: Claude Code directives

> **Event:** Total Recall, Tatum x Walrus Memory Hackathon (`https://tatum.io/hackathon/total-recall`)
> **Deadline:** **November 10, 2026 @ 17:00 UTC**
> **Prize targets:** Markets & Sports Prediction track · Best Walrus Memory · Best Use of Agent Payments (x402 / MPP settled on Sui).

Read `CALIBRO_PROJECT_SPEC.md` (the system as built) before architectural changes. Run `npm run typecheck && npm test` after every change, and `npm run build` after UI or route changes.

---

## 1. What Calibro is

A forecaster for real sports and prediction markets that keeps score of its sources. For each Polymarket market it recalls each source's record from Walrus Memory, buys only the signals worth their fee over HTTP 402 (x402 + MPP) with real Sui Mainnet payments verified through Tatum, de-biases and weights them by record, sizes a paper stake with quarter-Kelly, and after Polymarket resolves the game writes the post-mortem and updated calibration back to Walrus. Users log wallet-signed picks, get coached from their own record, and the best of them are paid as a source (TopPickers).

## 2. Ground truth (do not hallucinate)

### Walrus Memory (`@mysten-incubation/memwal@^0.1.13`)
- Peer deps `@mysten/sui` (`^2.39.0`) and `@mysten/seal` (`^1.5.3`) must stay installed (relayer mode builds a client-side SEAL session key).
- Mainnet relayer `https://relayer.memory.walrus.xyz` (packageId `0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5`, registryId `0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f`).
- Client: `MemWal.create({ key, accountId, serverUrl, namespace, recallTimeoutMs: 40_000, preflightTimeoutMs: 15_000 })` in `src/lib/walrus/memory-client.ts`. Writes use `rememberAndWait` / `rememberBulkAndWait` (≤ 20 items); recall uses the object form only.
- Recall limits: at most 100 hits per call, and `sort: "recent"` re-sorts a semantic window rather than listing the namespace. So calibration is recalled per (source, league) pair, and the ledger, timeline and track record are replayed from settled post-mortems (one recall per league). Exact up to roughly 50 settlements per league; beyond that a compaction snapshot is needed.
- Inventory: `listNamespaces()` + `listMemories({ cursor, namespace })`, paginated on `page.has_more`, never on array length.
- Four namespaces:
  - `calibro:episodic`: pre-game theses (prices, signals bought, x402 digests, vetoes, stake) and settled post-mortems.
  - `calibro:calibration`: one checkpoint per (source, league) per settlement: Brier, Platt α/β, samples, paid/vetoed counts.
  - `calibro:mandates`: bankroll, Kelly multiplier, max stake, min edge, slate x402 budget.
  - `calibro:picks`: wallet-signed user picks, per-user scorecards, TopPickers payout records.
- Records are a semantic header plus a JSON payload, never chat logs.

### `@mysten/sui` v2 (the imports actually used)
- `SuiGraphQLClient` from `@mysten/sui/graphql` (pointed at Tatum's gateway), `Transaction` and `coinWithBalance` from `@mysten/sui/transactions`, `Ed25519Keypair` from `@mysten/sui/keypairs/ed25519`, `verifyPersonalMessageSignature` from `@mysten/sui/verify`. Wallet connection uses `@mysten/wallet-standard`.
- Never import from `@mysten/sui/client` (removed in v2). Calibro does not use JSON-RPC.

### Tatum
- Sui Mainnet gateway is GraphQL: `https://sui-mainnet.gateway.tatum.io/graphql` with header `x-api-key: $TATUM_API_KEY` (the JSON-RPC root returns 404). Free plans allow 3 requests a second; `createTatumFetch()` throttles and retries on 429.
- Used for: latest checkpoint, agent wallet balances, x402 receipt verification (`transaction(digest)`), executing the agent's payments, and verifying pick signatures (zkLogin included).
- SUI/USD: Tatum v4 `GET https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD`. No static fallback.

### Agent payments (x402 + MPP on Sui Mainnet)
- Unpaid `GET /api/signals/:id` or `/api/forecast` returns `402` with `WWW-Authenticate: Payment realm="calibro-signals", protocol="mpp-sui-v1", network="sui:mainnet", recipient, coinType, amount, challengeId` and `X-Payment-Required` (base64 JSON, x402 v1). The `challengeId` is HMAC-signed and self-describing.
- Paid retry: `Authorization: Payment <base64>` or `X-Payment: <base64>` with `{ txDigest, challengeId, payer }`.
- The server releases the product only after Tatum's GraphQL confirms: status success; the recipient (and every split share) credited at least the amount in the challenge's coin; sender = payer; landed after the challenge was issued; digest never redeemed. The digest is reserved before the RPC call and released if verification fails. A malformed digest is a 402, not a 502.
- Products: seven specialist signals (default 0.002 SUI, paid to `CALIBRO_SIGNAL_TREASURY_ADDRESS`), `calibro-forecast` (0.01 SUI, paid to the agent wallet), and TopPickers, whose challenge carries `splits` so one transaction pays every qualified picker. Catalog at `/.well-known/x402`.
- Replay ledger: Upstash Redis / Vercel KV in production (required on Vercel), a file in `.calibro/` locally.

### Sources (`src/lib/specialists/models.ts`)
| id | what it is | leagues |
|---|---|---|
| `sharp-steam` | de-vigged sportsbook line plus half the open-to-close move | NBA, EPL, UFC |
| `power-rating` | ESPN BPI win probability | NBA |
| `onchain-flow` | Polymarket price plus half its last-6h move | all |
| `hype-contrarian` | fades the crowd and the last day's move | all |
| `kalshi-crowd` | Kalshi exchange price | NBA, EPL, UFC |
| `manifold-crowd` | Manifold community forecast | NBA |
| `top-pickers` | trust-weighted picks of users with ≥ 3 graded picks and Brier ≤ 0.25; fee split to their wallets | upcoming NBA, EPL, UFC |

## 3. Rules

1. **No mock data.** Markets, prices, lines and results are real (Polymarket, ESPN, The Odds API, Kalshi, Manifold). Without Walrus keys the app reports UNCONFIGURED and is read-only. `MemWalMock` appears only in tests, in the cold-start counterfactual, in the visitor preview's empty-memory comparison, and in `npm run train:preview`, each labelled as such. Fail closed rather than fall back to fixtures.
2. **Never fabricate a `blob_id` or `txDigest`.** Every one shown comes from a relayer or Sui response.
3. **Deterministic maths only** (`src/lib/calibration/brier.ts`): Brier, Platt de-biasing, the payment gate, trust weights and Kelly. No LLM produces a probability, a payment decision or a stake.
   - Exploration: every source is bought for its first 4 settled games in a league.
   - Veto: recalled Brier > 0.265 after 4 samples, or VoI = bankroll × κ × (0.265 − Brier) × 0.6 ≤ fee in USD, or the slate's SUI budget is spent.
   - Kelly: κ ≤ 0.25, ≤ 5% of bankroll per market, minimum edge 2%.
4. **Point-in-time.** Resolved markets are priced as of 5 minutes before the scheduled start. Settlement happens only on Polymarket's clean 1/0 resolution.
5. **Writes are guarded.** Evaluate (spends SUI) and settle (writes Walrus) need `x-calibro-admin` when `CALIBRO_ADMIN_TOKEN` is set and are refused in production without it. Visitors get the read-only preview on resolved markets. Cron routes need `CRON_SECRET`.
6. **Reads go through the shared read cache** (`src/lib/server/read-cache.ts`, `src/lib/server/read-models.ts`): Redis when configured, else a file cache. Serve the last good value marked stale when Walrus is slow; never show an empty state in place of an error.
7. **Secrets.** Never read `.env`, `.env.local` or `~/.memwal/credentials.json`, and never print keys.

## 4. Map

- Pages: `/` landing, `/app` Terminal, `/app/picks` Pick journal, `/app/record` Record.
- Routes: `markets`, `status`, `calibration`, `timeline`, `record`, `leaderboard`, `walrus/audit`, `signals/[specialistId]`, `forecast`, `picks`, `picks/coach`, `evaluate`, `evaluate/preview`, `settle`, `cron/settle`, `cron/warm`, `/.well-known/x402`.
- Scripts: `npm run verify`, `memwal:provision`, `setup:keys`, `train` / `train:preview`, `settle`, `agent:portable`, `buy:forecast`.
- Proof: `docs/mainnet-memory-proof.json` (written by `npm run train` from real responses; partial runs merge into it).
