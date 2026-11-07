# CALIBRO — Autonomous Bayesian Prediction & Sports-Odds Syndicate

> **Total Recall: Tatum x Walrus Memory Hackathon Master Specification**
> **Primary Track:** Markets & Sports Prediction ($1,000)
> **Bonus Targets:** Best Walrus Memory ($500) · Best Use of Agent Payments ($500) · Best Tatum AI Builder App ($500)
> **Core Stack:** Next.js 15 · TypeScript · `@mysten-incubation/memwal` (`0.1.13`) · `@mysten/seal` · `@mysten/sui` (`v2`) · Tatum Sui Mainnet Gateway & v4 Data APIs · HTTP `x402` + `MPP`
> **License:** Apache-2.0

---

## 1. Problem Statement & Core Thesis

Prediction agents and sports-betting copilots suffer from **epistemic amnesia**:
1. Every session starts with flat priors — treating a noisy Twitter sentiment scraper and an elite injury/line-movement model identically.
2. Agents waste money buying redundant or degraded paid data feeds (`x402` / `MPP`) because they cannot recall historical **Value of Information (VoI)** by league, market type, or volatility regime.
3. Even when an agent logs outcomes in a local SQLite file, that calibration intelligence is trapped on one machine and unencrypted or unverifiable.

**Calibro** turns **Walrus Memory Mainnet** (encrypted via Mysten **SEAL** and anchored to a Sui `MemWalAccount`) into a **portable, self-calibrating epistemic ledger**, paired with **Tatum's Sui Mainnet RPC & Data APIs** and **Sui `x402`/`MPP` micropayments**.

---

## 2. System Architecture

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                     BOOKMAKER vs. ON-CHAIN ODDS INGESTION                    │
│  Sharp Sportsbooks (Pinnacle/DraftKings via Odds API + curated replay)       │
│  vs. Prediction Markets & Sui Pool State (via Tatum Sui RPC + Data APIs)     │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│               1. WALRUS MEMORY RECALL PHASE (@mysten-incubation/memwal)      │
│  • Recall `calibro:mandates` (sort: "recent") -> Kelly cap, x402 slate cap   │
│  • Recall `calibro:calibration` (sort: "recent") -> Specialist Brier + Slope │
│  • Recall `calibro:episodic` (sort: "relevance") -> Analogous historicals    │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│          2. DETERMINISTIC x402 VALUE-OF-INFORMATION (VoI) PAYMENT GATE       │
│  For each Specialist Signal Endpoint (`/api/signals/[specialistId]`):        │
│    Expected VoI > x402 Fee ?                                                 │
│      ├─ NO  -> VETO PAYMENT (save Sui/USDC; log reason to UI tape)           │
│      └─ YES -> Receive HTTP 402 + `WWW-Authenticate: Payment` (x402 + MPP)   │
│                Sign & execute Sui Mainnet PTB -> Verify via Tatum Sui RPC    │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│             3. BAYESIAN LOG-ODDS AGGREGATOR & KELLY RISK GATE                │
│  • De-bias each unlocked signal: logit(p_cal) = a_i * logit(p_raw) + b_i     │
│  • Precision-weight by inverse recalled Brier score in this market domain    │
│  • Size edge against sharp book / market via Fractional Kelly (<= 0.25x)     │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│            4. POST-MORTEM AUDITOR -> WALRUS MAINNET WRITEBACK                │
│  • Record episodic prediction + Sui x402 txDigests -> `calibro:episodic`     │
│  • Upon settlement: compute Brier delta, update Platt (a_i, b_i), write new  │
│    calibration memory -> `calibro:calibration` (returns Mainnet `blob_id`)   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. The 4 Specialist Signal Endpoints (`x402` + `MPP` Gated)

Each specialist exposes `/api/signals/[id]` protected by dual `x402` + `MPP` (`402 Payment Required`):

| Specialist ID | Domain Strength | Deliberate Historical Flaw (Learned by Calibro) | Fee (Sui Mainnet) |
| :--- | :--- | :--- | :--- |
| `sharp-steam` | Elite on NBA & EPL closing-line steam (Brier ~`0.13`) | Slightly conservative on heavy favorites | `0.002 SUI` (or `0.01 USDC`) |
| `injury-scout` | Elite on late NBA/EPL roster & pace shocks (Brier ~`0.15`) | Neutral when no lineup news exists | `0.002 SUI` |
| `onchain-flow` | Strong on crypto/macro prediction markets (Brier ~`0.16`) | Mediocre on low-liquidity sports props (Brier ~`0.27`) | `0.002 SUI` |
| `hype-contrarian` | High-noise retail narrative chaser — **uncalibrated** on EPL/NBA (Brier ~`0.35`, overconfident `>80%`) | Systematically overconfident; negative net VoI after Epoch 6 | `0.002 SUI` *(Auto-vetoed after Recall!)* |

This design guarantees a **dramatic, honest, reproducible demonstration**: in Cold Start (Epoch 1), Calibro buys all 4 signals. After resolving 12+ markets into Walrus Mainnet, Calibro automatically **vetoes `hype-contrarian` on sports**, **vetoes `onchain-flow` on sports props** (while keeping it on crypto/macro!), and concentrates weights on `sharp-steam` + `injury-scout`.

---

## 4. Deterministic Mathematical Model (`src/lib/calibration/brier.ts`)

1. **Brier Score (per specialist $i$, domain $d$):**
   $$\text{BS}_{i,d} = \frac{1}{N} \sum_{t=1}^{N} (p_{i,t} - y_t)^2 \in [0, 1]$$
   where $BS = 0.25$ is coin-flip uninformative noise, $BS < 0.18$ is sharp, and $BS > 0.26$ destroys edge.

2. **Log-Odds Recalibration (Platt / Shrinkage):**
   $$\text{logit}(p^{\text{cal}}_i) = \alpha_{i,d} \cdot \text{logit}(p^{\text{raw}}_i) + \beta_{i,d}$$
   Overconfident specialists receive $\alpha_{i,d} < 1$ (shrinking extreme $85\%$ calls back toward reality).

3. **x402 Value-of-Information (`VoI`) Gate:**
   $$\text{Skill}_{i,d} = \max(0, 0.25 - \text{BS}_{i,d}) \quad (\text{Brier Skill vs. 0.25 baseline})$$
   $$\text{ExpectedVoI}_{\text{USD}} = \text{BankrollUSD} \cdot \text{MaxKellyFraction} \cdot \text{Skill}_{i,d} \cdot \gamma$$
   If $N \ge 4$ resolved samples in domain $d$ and $(\text{BS}_{i,d} > 0.265 \text{ or } \text{ExpectedVoI}_{\text{USD}} \le \text{FeeUSD})$, the gate deterministically returns `VETO_PAYMENT`.

4. **Inverse-Brier Ensemble & Fractional Kelly Sizing:**
   - Specialist precision weight: $w_i \propto \max(0, 0.28 - \text{BS}_{i,d})^2$
   - Fractional Kelly stake for decimal odds $O$ and calibrated probability $P$:
     $$f^* = \text{clamp}\left(\kappa \cdot \frac{P \cdot O - 1}{O - 1},\ 0,\ f_{\max}\right), \quad \kappa = 0.25,\ f_{\max} = 0.05$$

---

## 5. Walrus Memory Namespace Schema

All records are formatted with BOTH **human/semantic search header text** (for high-precision vector embeddings in `memwal.recall()`) AND a deterministic **`JSON` payload block** (for exact parsing after SEAL decryption):

1. **`calibro:episodic`** — One memory per evaluated/settled market prediction (`marketId`, `domain`, `bookImpliedProb`, `calibroProb`, `rawSignals`, `x402TxDigests`, `outcome`, `pnlUsd`).
2. **`calibro:calibration`** — One memory per specialist-domain calibration checkpoint (`specialistId`, `domain`, `sampleSize`, `brierScore`, `alphaSlope`, `betaIntercept`, `x402PaidCount`, `x402VetoedCount`, `epoch`). Queried with `sort: "recent"`.
3. **`calibro:mandates`** — User risk & treasury rules (`bankrollUsd`, `kellyMultiplier`, `maxSingleBetPct`, `maxSlateX402BudgetSui`, `preferredDomains`). Queried with `sort: "recent"`.

---

## 6. Hackathon Rubric & Submission Checklist

- [ ] **Walrus Memory Mainnet (>= 10 Memories Mandatory):** Seed & verify **20+ real memories** on `https://relayer.memory.walrus.xyz` across `calibro:episodic`, `calibro:calibration`, and `calibro:mandates`. Surface every `blob_id` in the UI Proof Drawer & README.
- [ ] **Tatum Integration:**
  - [ ] Initial market-scanner scaffold generated via `ai.tatum.io` (documented with prompt + screenshots/artifact).
  - [ ] Live Sui Mainnet JSON-RPC calls via `https://sui-mainnet.gateway.tatum.io` (`sui_getLatestCheckpointSequenceNumber`, `sui_getTransactionBlock`, `suix_getAllBalances`).
  - [ ] Live SUI/USD & USDC/USD conversion via Tatum v4 Rates API (`https://api.tatum.io/v4/data/rate/symbol`).
- [ ] **Agent Payments (`x402` + `MPP` on Sui):** Real Sui Mainnet micro-transfers with on-chain `txDigest` verification via Tatum RPC.
- [ ] **Deliverables before Nov 10, 2026 @ 17:00 UTC:**
  - [ ] Public GitHub repository (`Apache-2.0`).
  - [ ] Deployed live demo URL (Vercel) + 3-minute walkthrough video.
  - [ ] Technical blog post (`docs/BLOG_POST.md` published to Dev.to / Medium / Mirror).
