---
name: calibro-total-recall
description: Ground rules for Calibro (Total Recall hackathon): Walrus Memory (@mysten-incubation/memwal 0.1.13) on Mainnet, @mysten/sui v2 over Tatum's Sui GraphQL gateway, and HTTP 402 (x402 + MPP) payments on Sui.
---

# Calibro: working rules

Read `CLAUDE.md` (rules) and `CALIBRO_PROJECT_SPEC.md` (the system as built) first.

1. **Walrus Memory** (`@mysten-incubation/memwal@^0.1.13`, relayer `https://relayer.memory.walrus.xyz`):
   - Four namespaces: `calibro:episodic`, `calibro:calibration`, `calibro:mandates`, `calibro:picks`.
   - Recall returns at most 100 hits and `sort: "recent"` re-sorts a semantic window: recall calibration per (source, league) and replay settled post-mortems for ledgers and timelines.
   - Keep `@mysten/sui` and `@mysten/seal` installed (client-side SEAL session keys).
2. **Tatum**:
   - Sui Mainnet gateway is GraphQL: `https://sui-mainnet.gateway.tatum.io/graphql` with `x-api-key`. Calibro does not use JSON-RPC.
   - SUI/USD from `https://api.tatum.io/v4/data/rate/symbol?symbol=SUI&basePair=USD`.
   - 3 requests a second on free plans: go through `createTatumFetch()`.
3. **Payments (x402 + MPP on Sui Mainnet)**:
   - 402 with `WWW-Authenticate: Payment …` and `X-Payment-Required`; paid retry with `X-Payment` / `Authorization: Payment`.
   - Verify with Tatum GraphQL `transaction(digest)`: success, every recipient share credited, sender = payer, after the challenge, single use.
4. **Seven sources**: sharp-steam, power-rating, onchain-flow, hype-contrarian, kalshi-crowd, manifold-crowd, top-pickers.
5. **Maths** stays deterministic in `src/lib/calibration/brier.ts`: veto above Brier 0.265 after 4 samples, quarter-Kelly, 5% cap.
6. **No mock data and no fabricated `blob_id` / `txDigest`.**
