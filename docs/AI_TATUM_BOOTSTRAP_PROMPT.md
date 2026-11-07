# Tatum AI Builder (`ai.tatum.io`) Bootstrap Guide

> **Why this matters:** Total Recall awards a dedicated **$500 Best Tatum AI Builder App** bonus, and the rules explicitly note that builders can generate an initial foundation on `ai.tatum.io` and then wire up Walrus Memory + Tatum Sui RPCs + `x402`.

## Step 1: Run This Prompt on `https://ai.tatum.io` (Takes ~60 Seconds)

Copy and paste the prompt below into **`https://ai.tatum.io`**:

```text
Build a dark-mode institutional Sui Mainnet & Prediction Telemetry Dashboard called "Calibro Market Pulse" powered by Tatum RPC and Data APIs.

Include:
1. A live Sui Mainnet Network Telemetry bar using Tatum's Sui RPC gateway (`sui_getLatestCheckpointSequenceNumber` and wallet coin balance lookup via `suix_getAllBalances`).
2. Live USD spot rate cards for SUI and USDC using Tatum's Exchange Rate API (`/v4/data/rate/symbol`).
3. A Sui Payment Receipt Inspector widget where a user or autonomous x402 agent can paste a Sui Mainnet transaction digest (`sui_getTransactionBlock`) to verify execution status (`success`), checkpoint number, and recipient coin balance deltas.
4. A clean Bookmaker vs. On-Chain Implied Probability Dislocation table for NBA, Premier League, and Crypto Prediction Markets with monospace numbers and emerald/amber edge badges.
```

## Step 2: Export & Drop Into `src/components/tatum-ai/`

1. Save/export the generated component code (and grab the `ai.tatum.io` project URL / screenshot for `docs/BLOG_POST.md` and `README.md`).
2. Place the exported component(s) in `src/components/tatum-ai/` so Claude Code integrates them directly into `/project:phase3-terminal-ui` with clean provenance attribution!
