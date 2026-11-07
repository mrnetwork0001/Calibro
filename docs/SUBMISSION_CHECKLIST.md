# Calibro: submission checklist

**Deadline:** November 10, 2026, 17:00 UTC. Repo, demo and blog post are due then (`https://tatum.io/hackathon/total-recall`).
**Targets:** Markets & Sports Prediction track; Best Walrus Memory; Best Use of Agent Payments.

## 1. The hackathon's checklist

| Requirement | Status | Evidence |
|---|---|---|
| Walrus Memory integrated and writing on Mainnet | Done | Account `0x47a5e5519693665084fd119d8f0c8802c7a331d8d80b71298183e80af833c0ec`; every evaluation, settlement and pick writes to it |
| Tatum RPC used for on-chain data | Done | Tatum's Sui GraphQL gateway for checkpoints, balances, x402 receipt verification, executing payments and verifying pick signatures; Tatum v4 for SUI/USD |
| At least 10 memories on Mainnet | Done | 232 as of 7 Nov 2026 (76 episodic, 155 calibration, 1 mandates); `docs/mainnet-memory-proof.json` |
| Published blog post (what it does, how it uses Tatum + Walrus, how it learned) | **To do** | `docs/BLOG_POST.md` is written; publish it and link it from the README |
| Working demo and public repo | **To do** | Make the repo public, deploy, record the video |
| Optional: built with Tatum AI Builder | Not pursued | Calibro wasn't built primarily with ai.tatum.io, so that bonus doesn't apply |

## 2. Judging criteria and what covers them

- **Walrus and Tatum integration (30%)**: four namespaces with SEAL-encrypted records that change behaviour (sources refused from their recalled Brier, weights from their record, a coach from the user's own picks); per-pair recall and replay; portable agent; Tatum for every on-chain read, payment execution and verification.
- **Technical quality (30%)**: deterministic maths with tests, point-in-time pricing, idempotent settlement, receipt verification with anti-replay, shared read cache with honest stale/error states, CI (typecheck, tests, build) on every push.
- **Creativity (20%)**: an agent that refuses to pay sources with a bad record; it sells its own forecast over x402; its best human pickers are paid in one split Sui transaction.
- **Presentation (20%)**: README, blog post, Record tab with links for every game, the 3-minute video (`docs/DEMO_RUNBOOK_3MIN.md`), a deployed URL.
- **Bonus**: a post on X or LinkedIn (tagging `@Tatum_io` and `@WalrusFoundation` is optional).

## 3. Owner's steps, in order

1. **Make the GitHub repo public** (Settings → General → Danger zone → Change visibility).
2. **Create a free Upstash Redis database** and copy its REST URL and token.
3. **Deploy to Vercel** with these environment variables:
   - `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID`, `TATUM_API_KEY`
   - `CALIBRO_AGENT_SUI_PRIVATE_KEY`, `CALIBRO_SIGNAL_TREASURY_ADDRESS`
   - `CALIBRO_X402_CHALLENGE_SECRET` (a long random string; without it each serverless instance would sign challenges with its own random key)
   - `CALIBRO_ADMIN_TOKEN` (operator evaluate/settle), `CRON_SECRET`
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (replay ledger, rate limits, read cache)
   - optional `THE_ODDS_API_KEY`
4. **Add GitHub repository secrets** `CALIBRO_URL` (the deployed URL) and `CRON_SECRET`, so `settle.yml` settles, grades and warms the cache every 30 minutes. Run it once by hand (Actions → Settle & grade → Run workflow).
5. **Top up the agent wallet** `0xe33f666912d7e58ea5f86b25c37059b8c47e4dcfb83deadce4603c37e1267c82`. One live evaluation costs about 0.015 SUI (up to six 0.002 SUI payments plus gas).
6. **Log real picks from your own wallet** in the Pick journal before tonight's games. Three graded picks with a Brier of 0.25 or better make you a TopPicker. Picks are graded when Polymarket resolves the game: by the deployed cron, or locally with `npm run settle`.
7. **Record the 3-minute video** following `docs/DEMO_RUNBOOK_3MIN.md`.
8. **Publish the blog post** (Dev.to, Medium, Mirror or similar) and add the demo URL, video and blog links to the top of `README.md`.
9. **Post on X or LinkedIn** with the demo link.
10. **Submit the form**: repo URL, demo URL, blog URL, your **Tatum dashboard account ID**, and your **MEMWAL_AGENT_ID** (the public key under Delegate keys in the Walrus Memory dashboard).

## 4. Before you submit

- `npm run typecheck && npm test && npm run build` pass, and CI is green on `main`.
- On the deployed site: `/api/status` reports `LIVE_MAINNET`; `/app/record` lists the settled games with working Suiscan and Walruscan links; a visitor can preview a resolved game; the Pick journal connects a wallet.
- `git ls-files` shows no `.env*` (other than `.env.example`), keys or `.calibro/` files.
