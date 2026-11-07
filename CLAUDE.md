# CALIBRO — Claude Code Master Directives

> **Event:** Total Recall | Tatum x Walrus Memory Hackathon (`https://tatum.io/hackathon/total-recall`)
> **Deadline:** **November 10, 2026 @ 17:00 UTC**
> **Prize Target ($2,500 / $4,500 pool):**
> 1. **Markets & Sports Prediction Track** ($1,000)
> 2. **Best Walrus Memory** ($500 — deepest closed-loop learning on Walrus Mainnet, **>= 10 real Mainnet memories mandatory**, target 20-30)
> 3. **Best Use of Agent Payments** ($500 — HTTP `402` via **x402 + MPP** settled on **Sui Mainnet**, verified via Tatum Sui RPC)
> 4. **Best Tatum AI Builder App** ($500 — initial market shell generated on `ai.tatum.io`, extended into Calibro)

Always read `CALIBRO_PROJECT_SPEC.md` before making architectural changes.

---

## 1. What Calibro Is (And Why It Wins)

**Calibro** is an **Autonomous Bayesian Prediction & Sports-Odds Syndicate** that compares live bookmaker implied probabilities (NBA / EPL / UFC / macro events) against on-chain prediction markets, purchases live specialist signals behind **HTTP `402 Payment Required` (`x402` + `MPP`)** gates settled on **Sui Mainnet**, verifies every payment receipt deterministically via **Tatum Sui Mainnet RPC**, and uses **Walrus Memory Mainnet** (`@mysten-incubation/memwal` + Mysten SEAL encryption) to maintain an evolving **Epistemic Calibration Ledger** (domain-specific Brier scores, log-odds Platt parameters, and specialist Value-of-Information EV gates).

### The Non-Gimmicky Closed-Loop Recall Proof (Core Judge Hook)
- **Epoch 1 (Cold Start — 0 Memories):** Calibro has flat priors (`Brier = 0.25`, `weight = 0.25` across 4 signal specialists). It pays `x402` micro-fees to all 4 specialists on Sui and outputs a naive equal-weighted consensus probability.
- **Post-Mortem Resolution Loop:** As events resolve, Calibro recalls its original sealed prediction memories from `calibro:episodic`, computes domain-specific Brier scores & log-odds calibration slopes/intercepts, and writes updated calibration records to `calibro:calibration` on **Walrus Memory Mainnet** (`rememberAndWait` / `rememberBulkAndWait`).
- **Epoch 12+ (After Total Recall):** On a new slate of markets, Calibro recalls `calibro:calibration` (`sort: "recent"`) and `calibro:episodic` (`sort: "relevance"`):
  1. **Autonomous `x402` Payment Veto:** Refuses to pay `402` micro-fees to an uncalibrated noisy specialist when expected Value-of-Information (`VoI`) is below the `x402` fee (*"Vetoed 0.002 SUI x402 payment to SentimentContrarian — recalled EPL Brier 0.348"*).
  2. **Log-Odds De-biasing & Re-weighting:** Shrinks overconfident specialists toward base rate and upweights calibrated sharp scouts (`0.58x`).
  3. **Portable Brain Proof:** Any stateless CLI worker (`scripts/portable-agent-demo.ts`) given the same `MEMWAL_ACCOUNT_ID` + delegate key (or hydrated via `memwal.restore()`) immediately inherits 100% of the learned calibration state with zero local DB.

---

## 2. Ground-Truth SDK & API Rules (DO NOT HALLUCINATE)

### A. Walrus Memory (`@mysten-incubation/memwal@^0.1.13`)
- **Required Peer Dependencies:** `@mysten/sui` (`>=2.5.0`, installed `^2.39.0`) and `@mysten/seal` (`>=1.1.0`, installed `^1.5.3`) MUST stay installed — relayer-mode routes build an ephemeral client-side SEAL `SessionKey` (`x-seal-session`).
- **Live Mainnet Relayer & Contracts (verified from `https://relayer.memory.walrus.xyz/config`):**
  - `serverUrl`: `"https://relayer.memory.walrus.xyz"`
  - `packageId`: `"0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5"`
  - `registryId`: `"0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f"`
- **Exact Client API (`import { MemWal, MemWalMock } from "@mysten-incubation/memwal"`):**
  - `const memwal = MemWal.create({ key: process.env.MEMWAL_PRIVATE_KEY!, accountId: process.env.MEMWAL_ACCOUNT_ID!, serverUrl: "https://relayer.memory.walrus.xyz", namespace: "calibro:episodic" })`
  - Single write (waits for `blob_id`): `const res = await memwal.rememberAndWait(text, { idempotencyKey, dedupe: true, timeoutMs: 45_000 })` -> returns `{ id, job_id, blob_id, owner, namespace }`. *(Note: pass namespace string as 2nd arg OR options object to keep default namespace).*
  - Batch write (max 20 items per call, parallel Walrus upload + PTB): `await memwal.rememberBulkAndWait([{ text, namespace: "calibro:calibration" }])`
  - Poll status for live UI progress bar: `await memwal.getRememberStatus(jobId)` -> `"pending" | "running" | "uploaded" | "done" | "failed" | "not_found"`
  - Semantic recall (object form ONLY — positional is deprecated):
    - Analogous past games: `await memwal.recall({ query, namespace: "calibro:episodic", limit: 8, maxDistance: 0.75, sort: "relevance" })`
    - Latest calibration state ("newest wins" via `created_at`): `await memwal.recall({ query, namespace: "calibro:calibration", limit: 12, sort: "recent" })`
  - Proof-of-Mainnet audit (walks full inventory without guessing queries): `await memwal.listNamespaces()` and `await memwal.listMemories({ cursor, namespace })` (paginate using `page.has_more`, NEVER `memories.length`).
  - Disaster recovery / portable hydration: `await memwal.restore(namespace, 20)`
- **Account Provisioning (`import { generateDelegateKey, createAccount, addDelegateKey } from "@mysten-incubation/memwal/account"`):** wrapped in `scripts/provision-memwal-account.ts`.

### B. `@mysten/sui` v2 (`^2.39.0`) — CRITICAL V2 BREAKING CHANGES
- **NEVER** write `import { SuiClient } from "@mysten/sui/client"` — that was v1 and does not exist in v2!
- Use v2 subpath imports ONLY:
  - JSON-RPC (for **Tatum Sui Mainnet Gateway**): `import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc"`
  - gRPC (for Mysten fullnode fallback): `import { SuiGrpcClient } from "@mysten/sui/grpc"`
  - Transactions / PTBs: `import { Transaction } from "@mysten/sui/transactions"`
  - Keypairs: `import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"`
- **Architectural Synergy Point:** Mysten's public fullnodes deprecated JSON-RPC in favor of gRPC, making **Tatum's Sui Mainnet JSON-RPC Gateway (`https://sui-mainnet.gateway.tatum.io`)** essential infrastructure for JSON-RPC `sui_getTransactionBlock` verification and checkpoint monitoring.

### C. Tatum Infrastructure (`TATUM_API_KEY`)
- **Sui Mainnet RPC Gateway:** `POST https://sui-mainnet.gateway.tatum.io` with header `x-api-key: process.env.TATUM_API_KEY`.
- **Tatum v4 Data / Rates API:** `GET https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD` with header `x-api-key`.
- **`ai.tatum.io` Integration:** Follow `docs/AI_TATUM_BOOTSTRAP_PROMPT.md` to generate the initial market-scanner module on `ai.tatum.io`, preserve provenance in `src/components/tatum-ai/`, and wire it into the main terminal.

### D. Agent Payments (`x402` + `MPP` on Sui Mainnet)
- Unpaid requests to `/api/signals/[specialistId]` MUST return HTTP `402 Payment Required` with:
  - `WWW-Authenticate: Payment realm="calibro-signals", protocol="mpp-sui-v1", network="sui:mainnet", recipient="<address>", coinType="<coin>", amount="<raw>", challengeId="<nonce>"`
  - `X-Payment-Required` JSON header (`x402` payload matching the challenge).
- Paid retry includes `Authorization: Payment <base64-receipt>` / `X-Payment: <base64-receipt>` carrying `{ txDigest, challengeId, payer }`.
- Server MUST verify `txDigest` on-chain via **Tatum Sui Mainnet RPC** (`sui_getTransactionBlock` with `showEffects: true, showBalanceChanges: true, showInput: true`), asserting:
  1. `effects.status.status === "success"`
  2. `balanceChanges` credits `recipient` by `>= amount` of `coinType`
  3. `txDigest` has never been redeemed before (anti-replay ledger).

---

## 3. Non-Negotiable Engineering Honesty Rules

1. **Zero Fake Mainnet Claims:** Never fabricate a Walrus `blob_id` or Sui `txDigest`. Every displayed `blob_id` and `txDigest` must come from an actual relayer / Tatum RPC response, or be explicitly badged `MOCK_SANDBOX` when running with `CALIBRO_MEMORY_MODE=mock`.
2. **Zero-LLM Math Gate:** Brier scores, log-odds Platt calibration, `x402` Value-of-Information (`VoI`) payment vetoes, and fractional Kelly bankroll sizing in `src/lib/calibration/brier.ts` are **100% deterministic TypeScript math**. LLMs may summarize qualitative rationales, never invent probabilities or bypass the risk gate.
3. **3-Namespace Memory Hygiene:** Never dump raw unstructured chat logs into Walrus. Always write compact, deterministic JSON-plus-natural-language records across:
   - `calibro:episodic` — Pre-settlement market theses, bookmaker vs on-chain odds, specialist signals bought, `x402` digests.
   - `calibro:calibration` — Post-settlement Brier scores, domain reliability curves, overconfidence slopes, EV gate status.
   - `calibro:mandates` — User bankroll constraints, max fractional Kelly (`<= 0.25`), max `x402` budget per slate, League preferences.

---

## 4. Phased Build Workflow (Slash Commands)

Run tests (`npm test` and `npm run typecheck`) at the end of EVERY phase before moving on:

1. `/project:phase1-memory-and-rpc` — Harden & test Walrus Memory 3-namespace engine, Tatum Sui RPC verifier, and live account/checkpoint preflight.
2. `/project:phase2-x402-signals` — Build the 4 specialist `x402`/`MPP` API routes, autonomous Sui PTB micro-payer, anti-replay receipt verifier, and live/fallback sportsbook + prediction market odds aggregator.
3. `/project:phase3-terminal-ui` — Build the institutional Next.js 15 terminal: Dislocation Matrix (`ai.tatum.io` module), Epoch 1 vs Epoch N Split-Screen Recall Comparator, Live `x402` Payment Tape, Brier Calibration Curve SVG, and Mainnet Walrus Blob Inspector Drawer.
4. `/project:phase4-seed-mainnet` — Build & execute `scripts/seed-mainnet-memories.ts` + `scripts/portable-agent-demo.ts` to write and verify **20+ real Seal-encrypted memories on Walrus Mainnet** and capture verifiable `blob_id`s + Sui `txDigest`s.
5. `/project:phase5-submission-audit` — Full 100-point rubric audit, README polish, `docs/BLOG_POST.md` technical writeup, and 3-minute demo runbook.
