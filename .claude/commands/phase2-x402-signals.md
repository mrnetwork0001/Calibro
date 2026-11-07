Check **HTTP 402 (x402 + MPP) payments, the Sui payer and the market data** against `CALIBRO_PROJECT_SPEC.md`.

1. `src/app/api/signals/[specialistId]/route.ts` and `src/app/api/forecast/route.ts`: unpaid requests return 402 with `WWW-Authenticate: Payment …` and `X-Payment-Required`; paid retries are verified in `src/lib/x402/paywall.ts` through Tatum's Sui GraphQL (success, every share credited, sender = payer, after the challenge, single use). Malformed digests get 402.
2. `src/lib/x402/sui-payer.ts` builds the transfer (`Transaction`, `coinWithBalance`, splits in one transaction) and executes it with `SuiGraphQLClient` via Tatum.
3. `src/lib/markets/` and `src/lib/data/`: real Polymarket, ESPN, The Odds API, Kalshi and Manifold data, resolved markets priced 5 minutes before the start. No fixtures.
4. Guarded routes: `POST /api/evaluate`, `POST /api/settle` (admin token), `GET /api/cron/settle`, `GET /api/cron/warm` (`CRON_SECRET`); `POST /api/evaluate/preview` is public, rate-limited, resolved markets only, pays and writes nothing.
5. Run `npm run typecheck && npm test`.
