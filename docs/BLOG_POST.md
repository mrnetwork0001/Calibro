# Teaching a prediction agent who to trust: Walrus Memory, Sui x402 and Tatum

Most prediction agents start every session with amnesia. They buy the same paid signals every time, weigh a sharp line-movement model the same as a sentiment scraper, and learn nothing when a source is confidently wrong. If they do log results, the log sits in one machine's SQLite file, where no other runtime can use it and nobody can verify it.

Calibro is an attempt to fix that with three pieces of infrastructure: **Walrus Memory** for a portable, encrypted track record; **HTTP 402 payments on Sui** (x402 + MPP) so signals cost real money; and **Tatum's Sui Mainnet gateway** to verify every payment receipt. Everything runs on real data: Polymarket markets and resolutions, DraftKings lines and ESPN's BPI.

## The loop

```text
 Polymarket market + DraftKings line + ESPN BPI   (point-in-time)
            │
            ▼
 1. RECALL   calibro:mandates      (sort: recent)     bankroll, Kelly cap, x402 budget
             calibro:calibration   (sort: recent)     Brier, α, β per specialist × league
             calibro:episodic      (sort: relevance)  similar past markets
            │
            ▼
 2. GATE     VoI(specialist) > fee in USD ?  ── no ──▶ VETO (logged with the recalled Brier)
            │ yes
            ▼
 3. PAY      GET /api/signals/:id → 402 → Sui transfer → retry with receipt
             server verifies the digest via Tatum Sui GraphQL
            │
            ▼
 4. DECIDE   Platt de-bias → inverse-Brier weights → quarter-Kelly across venues
            │
            ▼
 5. LEARN    when Polymarket resolves: recall the thesis, update Brier/Platt, write back to Walrus
```

## The math is boring on purpose

Everything that touches money is deterministic TypeScript. No LLM produces a probability or overrides the risk gate.

- **Brier score** per specialist and league: `BS = (1/N) Σ (p − y)²`. 0.25 is a coin flip.
- **Platt de-biasing**: `logit(p_cal) = α·logit(p_raw) + β`, updated online by bounded log-loss gradient steps. An overconfident source drifts to α < 1, which shrinks its 85% calls toward reality.
- **Value-of-information gate**: during the first 4 settled games in a league, every source is bought (exploration). After that, a source with a Brier score above 0.265 is vetoed outright. Otherwise `VoI = bankroll × κ × (0.265 − BS) × γ` must exceed the fee in USD, priced live with Tatum's v4 rate API.
- **Fractional Kelly**: `f = min(κ·(P·O − 1)/(O − 1), 5%)` with κ ≤ 0.25, evaluated for YES at the sportsbook, YES on-chain and NO on-chain. The best leg wins. If there's no sportsbook price, that leg is skipped rather than invented.

## HTTP 402 on Sui

Each specialist endpoint speaks both payment dialects at once:

```http
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment realm="calibro-signals", protocol="mpp-sui-v1", network="sui:mainnet",
  recipient="0x…", coinType="0x2::sui::SUI", amount="2000000", challengeId="v1.…"
X-Payment-Required: <base64 { x402Version: 1, accepts: [{ scheme: "exact", network: "sui:mainnet", … }] }>
```

The `challengeId` is a self-describing HMAC-signed token. A stateless serverless function can verify the paid retry without a challenge database, and nobody can change the amount or recipient. The agent pays with a plain Sui transfer built with `@mysten/sui` v2 (`Transaction`, `splitCoins`, `transferObjects`) and executed with `SuiGraphQLClient` through Tatum's gateway. It then retries with `Authorization: Payment <{ txDigest, challengeId, payer }>`.

The server releases the signal only after a `transaction(digest)` query against Tatum's Sui GraphQL gateway (status, sender, timestamp, balance changes) confirms all of the following:

1. execution status is `success`;
2. `balanceChanges` credit the treasury with at least the amount, in the challenge's coin;
3. the transaction sender is the claimed payer;
4. the transaction landed after the challenge was issued, so an older payment to the same treasury can't be reused;
5. the digest has never been redeemed. The ledger reserves the digest before the RPC call, so two concurrent requests can't both pass.

The buyer also protects itself. It refuses any challenge asking for more, or for a different coin, than the gate approved, and it serializes payments from one wallet so concurrent transactions don't fight over the gas coin.

**Why Tatum matters here:** Sui is retiring JSON-RPC in favour of GraphQL and gRPC, and Tatum's Sui Mainnet gateway already serves the GraphQL API (`https://sui-mainnet.gateway.tatum.io/graphql`). Calibro uses it for receipt verification, checkpoints, balances, and for executing the agent's payments, without running a node. On the free plan that's 3 requests a second, so the client throttles and backs off on 429.

## Memory that actually changes behaviour

Calibro writes compact records, never chat logs. Each one has a semantic header, which the relayer embeds, and a JSON payload, which is parsed exactly after SEAL decryption. Calibro's own records go into three namespaces: `calibro:episodic` (theses and post-mortems), `calibro:calibration` (one checkpoint per specialist × league per settlement) and `calibro:mandates`. A fourth, `calibro:picks`, holds users' picks and scorecards (more on that below).

Two details took real debugging:

- **A single recall stops being complete.** The relayer returns at most 100 hits, and `sort: "recent"` only re-sorts a semantic window. Past 100 calibration checkpoints, one namespace-wide recall silently dropped whole sources. Calibro now recalls each (source, league) pair with its own query, and the learning timeline replays the settled post-mortems through the engine's own update function, which reproduces the stored checkpoints exactly.
- **Semantic recall is not an exact lookup.** Finding "the thesis for market `nba-game-11`" failed once there were about 20 near-identical records. The id's tokens appear all over the other records' numbers. Every episodic header now carries a hashed market tag, and the lookup queries by that tag and then checks the parsed `marketId`.
- **`sort: "recent"` re-sorts a semantic window by write time before truncating.** With a small `limit`, newer checkpoints of *other* specialists crowded the one I wanted off the page as soon as leagues were interleaved. That is the other reason each (source, league) pair gets its own query. It is exact up to roughly 50 settlements per league; past that, the ledger needs a compaction snapshot.

Settlement is idempotent. Re-settling a market is a no-op, and a crash between the calibration write and the post-mortem write can't double-count, because each checkpoint records the market that produced it.

## Real data, priced point-in-time

The first version of Calibro trained on synthetic games with simulated vendors of known quality. That proved the loop worked, but a hand-picked bad vendor that gets vetoed proves very little. So I replaced every fixture with real data:

- **Markets and results** come from Polymarket's public Gamma and CLOB APIs. A market counts as resolved only when UMA reports "resolved" with a clean 1/0 payout; cancelled or 50/50 markets are never used for learning.
- **Past markets are priced as of 5 minutes before the scheduled start**: the last Polymarket print before then, the DraftKings closing line ESPN keeps for every game, and ESPN's pre-game BPI. No hindsight.
- **The specialists are documented formulas over that data**: SharpSteam (de-vigged line plus half the line move), PowerRating (BPI), OnchainFlow (Polymarket momentum), HypeContrarian (fades the favourite and the last day's move). Calibro sells them to itself over x402, and the treasury is mine, which I say plainly.

## Results (real resolved games, live on Mainnet)

I trained Calibro live: every signal bought with a real Sui payment and verified through Tatum, every thesis, post-mortem and calibration checkpoint written to Walrus. As of 7 November 2026 the training run covers 37 real games played between 31 October and 7 November 2026 (23 NBA, 7 EPL, 7 UFC):

| | Mean Brier |
|---|---|
| Polymarket price | 0.181 |
| Calibro | 0.188 |
| Equal-weight average | 0.186 |

The interesting part is what Calibro learned. HypeContrarian's Brier crossed the 0.265 cutoff after four games in each league (0.31 to 0.35), and Calibro refused to pay it 25 times from then on (19 NBA, 3 EPL, 3 UFC). The other sources stayed between 0.14 and 0.22, close to the market, and kept being bought: 124 paid signals, each with a Sui digest. KalshiCrowd and ManifoldCrowd were added late (9 and 8 of the 37 games) and earned *paid* status in the NBA after their four exploration games.

It did not beat the market. Paper P&L on a $2,500 bankroll was −$313: on efficient markets, a small "edge" from sources that mostly echo the price is noise. I'm reporting that rather than tuning thresholds on the same games until the number turns green.

## Third-party voices

Grading only my own models invites the question "so you pay yourself?". Calibro now also scores two outside crowds, with point-in-time history: the **Kalshi** exchange price (hourly candles) and the **Manifold** community forecast (its sports bot opens one market per NBA game; past prices come from the bet history). They go through the same paywall, the same gate and the same Brier and Platt updates. They earn their weight or get vetoed like everyone else.

## You against it

The Markets & Sports track asks for apps where users log picks and the app learns who to trust. The pick journal does that with the same machinery. You connect a Sui wallet and sign a probability before the game. The signed message is sealed in a fourth namespace, `calibro:picks`, and the server checks the signature, zkLogin included, through Tatum's gateway. When Polymarket resolves the game, the settlement job grades it and updates your scorecard: Brier per league, Platt parameters, the market's Brier on your own games, and plain findings computed from those numbers, such as whether you are overconfident on favourites and what Calibro would shrink your typical confidence to. A leaderboard puts humans, Calibro, Polymarket and each source on one Brier scale.

## It coaches you, and pays you when you're right

The track brief asks for an app that remembers its users. Two features make Calibro's memory of you change what it does.

**The pick coach.** Before you sign, Calibro recalls your graded picks and scorecard from Walrus and shows what they say about the number on the slider. For example: how often your past picks at this confidence actually won, as a shrunk estimate you can adopt with one click; and how you've done when you disagreed with the market. Until you have history, it starts from its own memory: how sides priced like this one did across every game it has settled. The pick records whether a suggestion was on screen, so your scorecard can say whether following the coach actually lowered your Brier. The advice itself gets graded.

**TopPickers.** Once you have three graded picks with a Brier of 0.25 or better, you become a paid source. When Calibro buys the TopPickers signal for a game, it combines qualified users' picks by trust weight and splits the x402 fee among them in proportion. One Sui transaction pays every share. The challenge signs the shares in, so they can't be swapped, and the server checks through Tatum that each wallet was credited before releasing the signal. Each payout is written to the picker's history on Walrus. TopPickers is calibrated and vetoed like any other source, so a crowd that stops being right stops being paid. Humans and models compete on the same ledger for the same fees.

## Watching it learn

The learning timeline replays the settled post-mortems on Walrus through the engine's own update function, one settlement at a time; a test checks that the replay reproduces the stored calibration checkpoints exactly. Dragging the slider shows HypeContrarian flip from *exploring* to *vetoed* at the fourth game in each league, and the other sources' weights shift as their records diverge. Each step links to its post-mortem blob. Status and weights come from the engine's own gate and weighting functions, so the replay can't drift from what the agent actually did.

## Open to anyone

Three things make the record checkable without trusting me or my wallet:

- **The Record tab** (`/app/record`, backed by `GET /api/record`) lists every settled game straight from Walrus: Calibro's probability against Polymarket's, both Brier scores, each paid source with its Suiscan link, each refused source with the reason, and the post-mortem blob on Walruscan.
- **A preview for visitors.** Live evaluation spends real SUI, so it's limited to the operator. On a resolved game, anyone can press Preview: `POST /api/evaluate/preview` runs the same engine against Calibro's real recalled record with the signals computed in-process, pays nothing and writes nothing, and says so on screen. If Calibro evaluated that game on Mainnet, the recorded thesis, post-mortem and payment digests appear beside it.
- **Honest reads.** Recalling and decrypting a full track record takes the relayer 15 to 25 seconds, and its preflight occasionally stalls. The Walrus-backed views go through a shared cache (Upstash Redis when deployed, a file locally) that a cron job refreshes every 30 minutes. When the relayer is slow, the last good value is served with its timestamp; when nothing is cached, the panel says what failed and retries. An empty record is never shown in place of an error.

## Calibro as a vendor

Calibro now sells its own calibrated forecast over the same 402 protocol, for 0.01 SUI, with a machine-readable catalog at `/.well-known/x402` and an `llms.txt` for agents. The revenue goes to the agent wallet that pays the specialists, so the forecast funds its own inputs. If Calibro can't produce the forecast after a buyer paid, it frees the receipt so the same payment can be retried.

## Mainnet proof

Everything below comes from relayer and Sui responses recorded in `docs/mainnet-memory-proof.json`.

- Walrus Memory account: [`0x47a5e5519693665084fd119d8f0c8802c7a331d8d80b71298183e80af833c0ec`](https://suiscan.xyz/mainnet/object/0x47a5e5519693665084fd119d8f0c8802c7a331d8d80b71298183e80af833c0ec)
- Inventory as of 7 November 2026: **232 memories**: 76 in `calibro:episodic` (theses and post-mortems), 155 in `calibro:calibration`, 1 in `calibro:mandates`.
- Example blobs (one market, *Will Hull City AFC win on 2026-10-31?*):
  - thesis [`Z8seB8VSOkxSR6t8USdZAYnp42R3QdjzvZqt6Enhin0`](https://walruscan.com/mainnet/blob/Z8seB8VSOkxSR6t8USdZAYnp42R3QdjzvZqt6Enhin0)
  - post-mortem [`JdGYWx9D35MyD96MN2FOH_dp21FXMuRW_p76L_frN7o`](https://walruscan.com/mainnet/blob/JdGYWx9D35MyD96MN2FOH_dp21FXMuRW_p76L_frN7o)
  - calibration checkpoint [`hK1KBaCwWiPRe0rE8278wfjxls-3nJKYxr5GVB8kyMo`](https://walruscan.com/mainnet/blob/hK1KBaCwWiPRe0rE8278wfjxls-3nJKYxr5GVB8kyMo)
- x402 payment digests verified through Tatum (124 in the training run), for example [`6NBv24Pi…`](https://suiscan.xyz/mainnet/tx/6NBv24PiUEqycHN3uzhDAyXF41r6QEEZvBUz89e63Mpe), [`AM4U3Hog…`](https://suiscan.xyz/mainnet/tx/AM4U3Hog7ZQPpynZrDaUsnmogNwPu4ogbjSYuuZVgfoD), [`FiJa4jqf…`](https://suiscan.xyz/mainnet/tx/FiJa4jqfRsYbAL6KxyoSBZxmwVKCpivQTEDY6oh6Sxu1).
- A second wallet (our signal treasury, standing in for an outside agent) buying Calibro's forecast for 0.01 SUI: [`6LdsBTha…`](https://suiscan.xyz/mainnet/tx/6LdsBThaAGd1VhkcfVXKwwS98qJr5XGypwuwmZpUnNY4). To fill it, Calibro paid five sources over x402 and vetoed HypeContrarian (recalled NBA Brier 0.310).
- Agent wallet [`0xe33f…7c82`](https://suiscan.xyz/mainnet/account/0xe33f666912d7e58ea5f86b25c37059b8c47e4dcfb83deadce4603c37e1267c82) · signal treasury [`0x5e2d…a450`](https://suiscan.xyz/mainnet/account/0x5e2d891a6c7da182d4618d383d2221b20ba171c1dcdfa836d207af8ceff3a450)

## Portable brain

```bash
MEMWAL_ACCOUNT_ID=… MEMWAL_PRIVATE_KEY=… TATUM_API_KEY=… npx tsx scripts/portable-agent-demo.ts
```

A fresh process with no database and no `.env` prints the recalled ledger and makes the same veto decisions as the app, because the state *is* the Walrus account.

## What I'd do next

- Deterministic re-exploration, so a vetoed source can earn its way back.
- A minimum-edge threshold that accounts for Polymarket's spread, so Calibro passes instead of betting on noise.
- Small-sample shrinkage of Brier scores, so one unlucky call doesn't zero a sharp source's weight.
- Calibration snapshots, so recall stays exact past roughly 50 settlements per league.
