Check **the web app** against `CALIBRO_PROJECT_SPEC.md`.

1. Pages: `/` (landing, live record), `/app` (Terminal: markets, forecast comparator, payment tape, calibration ledger, learning timeline, memory inventory), `/app/picks` (Pick journal: log a pick with the coach, scorecard, leaderboard), `/app/record` (every settled game with Sui tx and Walrus blob links).
2. Visitors without the admin token can preview resolved markets (labelled "Preview · nothing paid or written"); the token form sits behind an "Operator" link.
3. Every panel shows an honest error with retry when Walrus Memory is slow, and labels stale data with its time; never an empty "no record" state in place of an error.
4. Mobile: at ≤ 900px the header becomes a burger with a left drawer; no horizontal overflow at 390px and 768px.
5. Run `npm run typecheck && npm test && npm run build`.
