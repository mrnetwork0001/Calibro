Check **Walrus Memory, Tatum and the calibration engine** against `CALIBRO_PROJECT_SPEC.md`.

1. Read `src/lib/types/calibro.ts`, `src/lib/calibration/brier.ts`, `src/lib/walrus/memory-client.ts`, `src/lib/tatum/sui-rpc.ts` and `src/lib/orchestrator/syndicate-engine.ts`.
2. Confirm the loop: recall (`calibro:mandates`, per-pair `calibro:calibration`, `calibro:episodic`), gate for the seven sources, Platt + trust-weight aggregation, quarter-Kelly, and `settleMarketAndLearn()` writing checkpoints and the post-mortem.
3. Tatum calls go to the GraphQL gateway (`https://sui-mainnet.gateway.tatum.io/graphql`) through `createTatumFetch()`; rates come from Tatum v4 with no static fallback.
4. Run `npm run typecheck && npm test && npm run verify` and report exact results.
