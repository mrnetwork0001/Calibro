"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { coachPick } from "@/lib/picks/coach";
import { buildPickMessage } from "@/lib/picks/message";
import type { MarketOpportunity } from "@/lib/types/calibro";
import {
  api,
  DOMAIN_LABEL,
  friendlyError,
  pct,
  short,
  SPECIALIST_LABEL,
  suiscanTx,
  walruscanBlob,
  type CoachDataResponse,
  type LeaderboardResponse,
  type PicksResponse,
} from "../terminal/api";
import { AppHeader, AppSections, Masthead, PageTitle } from "../terminal/StatusRibbon";
import { Badge, Button, Empty, ErrorLine, LoadError, Panel, Skeleton, Stat } from "../terminal/ui";
import { useLoad } from "../terminal/useLoad";
import { useSuiWallet } from "./useSuiWallet";

const f3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(3));

function WalletBar({ w }: { w: ReturnType<typeof useSuiWallet> }) {
  if (w.address) {
    return (
      <div className="flex items-center gap-3 text-[13px] whitespace-nowrap">
        <span className="inline-flex items-center gap-2 text-paper/80" title={w.wallet?.name ?? "Wallet"}>
          <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[#4cc26a]" />
          <span className="max-[900px]:inline min-[901px]:max-[1099px]:hidden">{w.wallet?.name ?? "Wallet"}</span>
        </span>
        <span className="font-mono text-paper">{short(w.address)}</span>
        <button type="button" onClick={() => void w.disconnect()} className="text-paper/60 underline decoration-paper/30 underline-offset-4 hover:text-paper">
          Disconnect
        </button>
      </div>
    );
  }
  if (w.wallets.length === 0) {
    return (
      <span className="whitespace-nowrap text-[13px] text-paper/60" title="Calibro works with any Sui wallet that supports wallet-standard signing.">
        No Sui wallet found ·{" "}
        <a className="text-paper underline decoration-paper/30 underline-offset-4 hover:decoration-paper" href="https://slush.app" target="_blank" rel="noreferrer">
          Get Slush
        </a>
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {w.wallets.map((x) => (
        <button
          key={x.name}
          type="button"
          onClick={() => void w.connect(x)}
          className="touch-btn bg-paper px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-white"
        >
          Connect {x.name}
        </button>
      ))}
    </div>
  );
}

export function PicksApp() {
  const w = useSuiWallet();
  const [markets, setMarkets] = useState<MarketOpportunity[] | null>(null);
  const [selected, setSelected] = useState<MarketOpportunity | null>(null);
  const [percent, setPercent] = useState(60);
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  const [sealed, setSealed] = useState<{ blobId: string; title: string } | null>(null);
  const [mine, setMine] = useState<PicksResponse | null>(null);
  const [mineError, setMineError] = useState<string | null>(null);
  const boardLoad = useLoad(() => api.leaderboard());
  const board: LeaderboardResponse | null = boardLoad.data;
  const [coachData, setCoachData] = useState<CoachDataResponse | null>(null);
  const [coachError, setCoachError] = useState<string | null>(null);

  useEffect(() => {
    api
      .markets()
      .then((f) => setMarkets(f.markets.filter((m) => m.source === "LIVE" && m.domain !== "CRYPTO_MACRO")))
      .catch(() => setMarkets([]));
  }, []);

  const refreshMine = useCallback(() => {
    if (!w.address) return;
    setMineError(null);
    api
      .picks(w.address)
      .then(setMine)
      .catch((e: Error) => setMineError(e.message));
  }, [w.address]);
  useEffect(() => {
    setMine(null);
    refreshMine();
  }, [refreshMine]);

  // Recall the coach's memories whenever the market or wallet changes.
  useEffect(() => {
    setCoachData(null);
    setCoachError(null);
    if (!selected) return;
    let live = true;
    api
      .coach(selected.marketId, w.address)
      .then((d) => live && setCoachData(d))
      .catch((e: Error) => live && setCoachError(e.message));
    return () => {
      live = false;
    };
  }, [selected, w.address]);

  const advice = useMemo(
    () =>
      selected && coachData && coachData.marketId === selected.marketId
        ? coachPick({
            percent,
            domain: selected.domain,
            yesLabel: selected.yesLabel ?? "YES",
            marketProb: selected.onchainImpliedProb,
            picks: coachData.picks,
            league: coachData.league,
            marketHistory: coachData.marketHistory,
          })
        : null,
    [selected, coachData, percent]
  );

  const pickedIds = useMemo(() => new Set(mine?.picks.map((p) => p.record.marketId) ?? []), [mine]);

  const seal = useCallback(async () => {
    if (!selected || !w.address) return;
    setSealing(true);
    setSealError(null);
    setSealed(null);
    try {
      const message = buildPickMessage({
        marketId: selected.marketId,
        question: selected.title,
        yesLabel: selected.yesLabel ?? "YES",
        percent,
        address: w.address,
        signedAt: new Date().toISOString(),
      });
      const signature = await w.signMessage(message);
      const res = await api.submitPick(message, signature, advice ? { suggestedPercent: advice.suggestedPercent } : undefined);
      setSealed({ blobId: res.blobId, title: selected.title });
      refreshMine();
    } catch (e) {
      setSealError((e as Error).message);
    } finally {
      setSealing(false);
    }
  }, [selected, w, percent, refreshMine, advice]);

  const card = mine?.scorecard ?? null;

  return (
    <div className="grain min-h-screen bg-paper text-ink">
      <AppHeader active="picks" right={<WalletBar w={w} />} />
      <Masthead>
        <AppSections active="picks">
          <WalletBar w={w} />
        </AppSections>
        <PageTitle title="Pick journal">
          Sign a probability before the game. It&apos;s sealed on Walrus Memory with your wallet&apos;s signature, graded against Polymarket&apos;s
            result, and scored with the same Brier and Platt maths Calibro uses on its own sources. Signing is free and moves no funds.
        </PageTitle>
      </Masthead>

      <main className="relative z-10 mx-auto -mt-6 flex max-w-[1440px] flex-col gap-4 px-3 pb-10 min-[901px]:gap-6 min-[901px]:px-6 min-[901px]:pb-12">
        <ErrorLine error={w.error} />

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,6fr)_minmax(0,6fr)]">
          <Panel kicker="Before the game" title="Log a pick">
            {!markets ? (
              <Empty>Loading upcoming games…</Empty>
            ) : markets.length === 0 ? (
              <Empty>No upcoming NBA, EPL or UFC games on Polymarket right now.</Empty>
            ) : (
              <div className="flex flex-col gap-3">
                <ul className="max-h-[300px] overflow-auto border border-rule">
                  {markets.map((m) => {
                    const done = pickedIds.has(m.marketId);
                    const active = selected?.marketId === m.marketId;
                    return (
                      <li key={m.marketId}>
                        <button
                          type="button"
                          disabled={done}
                          onClick={() => {
                            setSelected(m);
                            setPercent(Math.round(m.onchainImpliedProb * 100));
                            setSealed(null);
                          }}
                          className={`flex w-full items-center justify-between gap-2 border-b border-rule px-3 py-2 text-left text-xs ${active ? "bg-sunken" : "hover:bg-sunken"} ${done ? "opacity-50" : ""}`}
                        >
                          <span className="min-w-0">
                            <span className="mr-2 font-mono text-[10px] text-ink-3">{DOMAIN_LABEL[m.domain]}</span>
                            <span className="text-ink">{m.title}</span>
                            <span className="block text-[11px] text-ink-3">
                              YES = {m.yesLabel} · starts {new Date(m.closesAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                            </span>
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-ink-2 tabular-nums">
                            {done ? "picked" : `Poly ${pct(m.onchainImpliedProb, 0)}`}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {selected && (
                  <div className="border border-rule-strong p-3">
                    <p className="text-sm text-ink">{selected.title}</p>
                    <p className="text-[11px] text-ink-3">
                      Polymarket {pct(selected.onchainImpliedProb)} · {selected.bookSource ? `${selected.bookSource} ${pct(selected.bookImpliedProb)}` : "no sportsbook line"}
                    </p>
                    <label className="mt-3 block font-mono text-[11px] text-ink-3" htmlFor="pick-pct">
                      Your probability that <span className="text-ink">{selected.yesLabel}</span> wins:{" "}
                      <span className="text-base text-ink tabular-nums">{percent}%</span>
                    </label>
                    <input
                      id="pick-pct"
                      type="range"
                      min={1}
                      max={99}
                      value={percent}
                      onChange={(e) => setPercent(Number(e.target.value))}
                      className="mt-1 w-full accent-ink"
                    />
                    <div className="mt-3 border border-rule-strong bg-sunken p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[12px] text-ink-2">Pick coach · recalled from Walrus</p>
                        {coachData?.scorecardBlobId && (
                          <a
                            className="link text-[11px]"
                            href={walruscanBlob(coachData.scorecardBlobId)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            your scorecard {short(coachData.scorecardBlobId, 5, 3)}
                          </a>
                        )}
                      </div>
                      {coachError ? (
                        <p className="mt-1 text-xs text-ink-3" title={coachError}>Coach unavailable: {friendlyError(coachError)}</p>
                      ) : !advice ? (
                        <p className="mt-1 text-xs text-ink-3">Recalling your record and Calibro&apos;s…</p>
                      ) : (
                        <>
                          <ul className="mt-1 space-y-1 text-xs text-ink-2">
                            {advice.findings.map((f) => (
                              <li key={f.kind}>• {f.text}</li>
                            ))}
                          </ul>
                          {advice.suggestedPercent !== null && advice.suggestedPercent !== percent && (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <Button variant="ghost" onClick={() => setPercent(advice.suggestedPercent!)}>
                                Use {advice.suggestedPercent}%
                              </Button>
                              <span className="text-[11px] text-ink-3">Your scorecard will track whether following the coach helps.</span>
                            </div>
                          )}
                          {!w.address && <p className="mt-1 text-[11px] text-ink-3">Connect a wallet to be coached on your own record.</p>}
                        </>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <Button onClick={() => void seal()} busy={sealing} disabled={!w.address}>
                        {w.address ? "Sign & seal on Walrus" : "Connect a wallet to pick"}
                      </Button>
                      {sealing && <span className="font-mono text-[11px] text-ink-3">Waiting for your wallet, then writing to Walrus (≈ 10 s)…</span>}
                    </div>
                    <ErrorLine error={sealError} />
                    {sealed && (
                      <p className="mt-2 font-mono text-[11px] text-good-ink">
                        ✓ Sealed: {sealed.title} ·{" "}
                        <a className="link" href={walruscanBlob(sealed.blobId)} target="_blank" rel="noreferrer">
                          blob {short(sealed.blobId, 8, 6)}
                        </a>
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </Panel>

          <Panel kicker="After the game" title="Your scorecard" right={card && <Badge tone="info">{card.graded} graded</Badge>}>
            {!w.address ? (
              <Empty>Connect a wallet to see your picks and scorecard.</Empty>
            ) : mineError ? (
              <LoadError error={mineError} retrying={false} onRetry={refreshMine} />
            ) : !mine ? (
              <Empty>Recalling your picks from Walrus…</Empty>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-3 gap-3">
                  <Stat label="Your Brier" value={card ? f3(card.brier) : "—"} sub="lower is better · 0.25 = coin flip" />
                  <Stat label="Market, same games" value={card ? f3(card.marketBrier) : "—"} sub="Polymarket at your pick time" />
                  <Stat label="Calibro, same games" value={card?.calibroCompared ? f3(card.calibroBrier) : "—"} sub={card ? `${card.calibroCompared} overlapping` : ""} />
                </div>
                <div className={`border p-3 text-xs ${mine.topPickers.qualified ? "border-[#bcdcbc] bg-[#eff7ef]" : "border-rule-strong"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-ink">
                      {mine.topPickers.qualified ? (
                        <>
                          <Badge tone="good">TopPicker</Badge> Calibro buys your picks over x402 and pays your wallet directly.
                        </>
                      ) : (
                        <>
                          Become a <span className="text-ink">TopPicker</span>: {mine.topPickers.minGraded} graded picks with Brier ≤ {mine.topPickers.maxBrier}, and
                          Calibro starts paying your wallet when it uses your picks. You: {card?.graded ?? 0} graded
                          {card && card.graded > 0 ? `, Brier ${f3(card.brier)}` : ""}.
                        </>
                      )}
                    </p>
                    <span className="font-mono text-sm text-ink tabular-nums">
                      Earned {(Number(mine.earnedRaw) / 1e9).toFixed(4)} SUI
                    </span>
                  </div>
                  {mine.payouts.length > 0 && (
                    <ul className="mt-2 space-y-0.5 font-mono text-[11px] text-ink-3">
                      {mine.payouts.slice(0, 5).map(({ record: p }) => (
                        <li key={p.txDigest}>
                          +{(Number(p.amountRaw) / 1e9).toFixed(4)} SUI · {p.title} ·{" "}
                          <a className="link" href={suiscanTx(p.txDigest)} target="_blank" rel="noreferrer">
                            tx {short(p.txDigest, 6, 4)}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {mine.insights.length > 0 && (
                  <ul className="space-y-1 text-xs text-ink-2">
                    {mine.insights.map((t) => (
                      <li key={t}>• {t}</li>
                    ))}
                  </ul>
                )}
                {mine.picks.length === 0 ? (
                  <Empty>No picks yet. Pick a game on the left.</Empty>
                ) : (
                  <div className="-mx-5 overflow-x-auto px-5">
                  <table className="w-full text-left max-sm:min-w-[480px] text-xs">
                    <thead className="text-[12px] text-ink-3">
                      <tr>
                        <th className="py-1 font-normal">Game</th>
                        <th className="px-2 py-1 text-right font-normal">You</th>
                        <th className="px-2 py-1 text-right font-normal">Poly</th>
                        <th className="px-2 py-1 font-normal">Result</th>
                        <th className="py-1 font-normal">Walrus</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mine.picks.map(({ blobId, record: p }) => (
                        <tr key={p.marketId} className="border-t border-rule">
                          <td className="max-w-0 truncate py-1.5 pr-2" title={p.title}>
                            {p.title}
                          </td>
                          <td className="px-2 text-right font-mono tabular-nums">{pct(p.probability, 0)}</td>
                          <td className="px-2 text-right font-mono tabular-nums text-ink-3">{pct(p.marketProbAtPick, 0)}</td>
                          <td className="px-2">
                            {p.outcome === undefined ? (
                              <Badge tone="neutral">Open</Badge>
                            ) : (
                              <span className="font-mono text-[11px]">
                                {p.outcome === 1 ? `${p.yesLabel} won` : `${p.yesLabel} lost`} · {f3(p.brier)}
                              </span>
                            )}
                          </td>
                          <td>
                            <a className="link font-mono text-[11px]" href={walruscanBlob(blobId)} target="_blank" rel="noreferrer">
                              {short(blobId, 5, 3)}
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            )}
          </Panel>
        </div>

        <Panel kicker="You vs Calibro vs the market" title="Leaderboard">
          {!board && boardLoad.error ? (
            <LoadError error={boardLoad.error} retrying={boardLoad.retrying} onRetry={boardLoad.reload} />
          ) : !board ? (
            <Skeleton rows={4} />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
              {board.users.length === 0 ? (
                <Empty>No graded picks yet. Picks are graded automatically when Polymarket resolves the game.</Empty>
              ) : (
                <div className="-mx-5 min-w-0 overflow-x-auto px-5">
                <table className="w-full text-left max-sm:min-w-[560px] text-xs">
                  <thead className="text-[12px] text-ink-3">
                    <tr>
                      <th className="py-1 font-normal">#</th>
                      <th className="py-1 font-normal">Wallet</th>
                      <th className="px-2 py-1 text-right font-normal">Picks</th>
                      <th className="px-2 py-1 text-right font-normal">Brier</th>
                      <th className="px-2 py-1 text-right font-normal">Market</th>
                      <th className="px-2 py-1 text-right font-normal">Edge</th>
                      <th className="px-2 py-1 text-right font-normal">Earned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.users.map((u, i) => (
                      <tr key={u.owner} className={`border-t border-rule ${u.owner === w.address ? "bg-sunken" : ""}`}>
                        <td className="py-1.5 font-mono text-ink-3">{u.graded >= 3 ? i + 1 : "–"}</td>
                        <td className="font-mono">{short(u.owner)}</td>
                        <td className="px-2 text-right font-mono tabular-nums">{u.graded}</td>
                        <td className="px-2 text-right font-mono tabular-nums">{f3(u.brier)}</td>
                        <td className="px-2 text-right font-mono tabular-nums text-ink-3">{f3(u.marketBrier)}</td>
                        <td className="px-2 text-right font-mono tabular-nums">
                          {u.edgeVsMarket >= 0 ? "+" : ""}
                          {u.edgeVsMarket.toFixed(3)}
                        </td>
                        <td className="px-2 text-right font-mono tabular-nums">
                          {u.topPicker && <span className="mr-1 text-[10px] text-good-ink">TopPicker</span>}
                          {Number(u.earnedRaw) > 0 ? `${(Number(u.earnedRaw) / 1e9).toFixed(4)} SUI` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              )}
              <div className="border border-rule p-3 text-xs">
                <p className="text-[12px] text-ink-3">Reference · all settled markets</p>
                {board.reference ? (
                  <table className="mt-2 w-full">
                    <tbody>
                      <tr>
                        <td className="py-1 text-ink">Calibro</td>
                        <td className="text-right font-mono tabular-nums">{f3(board.reference.calibro)}</td>
                      </tr>
                      <tr>
                        <td className="py-1 text-ink">Polymarket price</td>
                        <td className="text-right font-mono tabular-nums">{f3(board.reference.polymarket)}</td>
                      </tr>
                      {board.reference.specialists.map((s) => (
                        <tr key={s.id}>
                          <td className="py-1 text-ink-3">{SPECIALIST_LABEL[s.id] ?? s.id}</td>
                          <td className="text-right font-mono tabular-nums text-ink-3">
                            {f3(s.brier)} <span className="text-[10px]">n={s.samples}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="mt-2 text-ink-3">No settled markets on Walrus yet.</p>
                )}
                <p className="mt-2 text-[10px] text-ink-3">
                  Edge = market Brier − your Brier on your own games; positive means you beat the price you could have bet at.
                </p>
              </div>
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
