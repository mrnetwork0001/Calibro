---
name: calibro-total-recall
description: Architecture, verified @mysten-incubation/memwal (v0.1.13) + @mysten/sui (v2) SDK rules, Tatum Sui Mainnet RPC gateway specs, and Sui x402/MPP payment rules for Calibro (Total Recall Hackathon).
---

# Calibro — Total Recall Hackathon Execution Skill

Always consult `CLAUDE.md` and `CALIBRO_PROJECT_SPEC.md` at the repository root.

## Quick Rules
1. **Walrus Memory (`@mysten-incubation/memwal@^0.1.13`):**
   - Must write **>= 10 real Mainnet memories** (target 20+) across `calibro:episodic`, `calibro:calibration`, and `calibro:mandates` on `https://relayer.memory.walrus.xyz`.
   - Keep `@mysten/sui` (`>=2.5.0`) and `@mysten/seal` (`>=1.1.0`) installed for client-side SEAL session keys.
2. **Tatum Integration:**
   - Sui Mainnet JSON-RPC: `https://sui-mainnet.gateway.tatum.io` (`x-api-key`).
   - USD Exchange Rates: `https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD`.
   - Preserve `ai.tatum.io` bootstrap modules inside `src/components/tatum-ai/`.
3. **Sui Agent Payments (`x402` + `MPP`):**
   - Dual HTTP `402` headers (`WWW-Authenticate: Payment` + `X-Payment-Required`).
   - Verify on-chain `txDigest` finality, recipient delta, and anti-replay via Tatum `sui_getTransactionBlock`.
4. **Zero-LLM Math Gate:**
   - All Brier scores, Platt log-odds recalibrations, `x402` VoI vetoes, and fractional Kelly stakes live in `src/lib/calibration/brier.ts`.
