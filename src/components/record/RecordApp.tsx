"use client";

import { useMemo, useState } from "react";
import type { MarketDomain } from "@/lib/types/calibro";
import { api, DOMAIN_LABEL, pct, short, SPECIALIST_LABEL, suiscanTx, walruscanBlob, type RecordGame, type RecordResponse } from "../terminal/api";
import { AppHeader, AppSections, Masthead, PageTitle } from "../terminal/StatusRibbon";
import { Badge, Empty, LoadError, Panel, Segmented, Skeleton, StaleNote } from "../terminal/ui";
import { useLoad } from "../terminal/useLoad";

const label = (id: string) => SPECIALIST_LABEL[id as keyof typeof SPECIALIST_LABEL] ?? id;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" }) : "—");
const suiscan = (kind: "object" | "account", id: string) => `https://suiscan.xyz/mainnet/${kind}/${id}`;

function Figure({ value, caption }: { value: string; caption: string }) {
  return (
    <div className="min-w-0">
      <p className="font-serif text-[30px] leading-none text-ink tabular-nums sm:text-[36px]">{value}</p>
      <p className="mt-1.5 text-[12px] text-ink-3">{caption}</p>
    </div>
  );
}

function GameRow({ g }: { g: RecordGame }) {
  const beat = g.calibroBrier < g.marketBrier;
  return (
    <details className="group border-b border-rule last:border-b-0">
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-5 py-3 hover:bg-[#faf9f6] md:grid-cols-[64px_56px_minmax(0,1fr)_88px_150px_120px_96px] md:items-baseline [&::-webkit-details-marker]:hidden">
        <span className="hidden text-[12px] text-ink-3 tabular-nums md:block">{day(g.settledAt ?? g.marketAsOf)}</span>
        <span className="hidden text-[12px] text-ink-3 md:block">{DOMAIN_LABEL[g.domain]}</span>
        <span className="min-w-0 text-[14px] text-ink">
          <span className="mr-1.5 inline-block text-ink-4 transition-transform group-open:rotate-90" aria-hidden>
            ›
          </span>
          {g.title}
          <span className="block text-[12px] text-ink-3 md:hidden">
            {day(g.settledAt ?? g.marketAsOf)} · {DOMAIN_LABEL[g.domain]} · {g.outcome === 1 ? "YES" : "NO"} won
          </span>
        </span>
        <span className="hidden text-[13px] text-ink-2 md:block">{g.outcome === 1 ? "YES" : "NO"} won</span>
        <span className="text-right font-mono text-[12px] text-ink-2 tabular-nums md:text-left">
          {pct(g.calibroProb)} <span className="text-ink-4">vs</span> {pct(g.marketProb)}
        </span>
        <span className="hidden font-mono text-[12px] tabular-nums md:block" title="Brier: Calibro / Polymarket (lower is better)">
          <span className={beat ? "text-good-ink" : "text-ink"}>{g.calibroBrier.toFixed(3)}</span>
          <span className="text-ink-4"> / {g.marketBrier.toFixed(3)}</span>
        </span>
        <span className="col-span-2 text-[12px] text-ink-3 md:col-span-1">
          {g.paid.length} paid{g.refused.length > 0 && <span className="text-critical-ink"> · {g.refused.length} refused</span>}
        </span>
      </summary>
      <div className="grid gap-6 bg-sunken px-5 py-4 text-[12px] md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:pl-[140px]">
        <div className="min-w-0">
          <p className="mb-2 text-ink-3">Paid over x402 on Sui (0.002 SUI each)</p>
          {g.paid.length === 0 ? (
            <p className="text-ink-3">Nothing was bought.</p>
          ) : (
            <table className="w-full">
              <tbody>
                {g.paid.map((p) => (
                  <tr key={p.specialistId} className="border-t border-rule first:border-t-0">
                    <td className="py-1.5 pr-3 text-ink-2">{label(p.specialistId)}</td>
                    <td className="py-1.5 pr-3 font-mono text-ink-3 tabular-nums">{pct(p.probability, 0)}</td>
                    <td className="py-1.5 pr-3 font-mono text-ink-3 tabular-nums" title="weight in Calibro's forecast">
                      w {(p.weight * 100).toFixed(0)}%
                    </td>
                    <td className="py-1.5 text-right">
                      {p.txDigest ? (
                        <a className="link font-mono text-[11px]" href={suiscanTx(p.txDigest)} target="_blank" rel="noreferrer">
                          {short(p.txDigest, 6, 4)}
                        </a>
                      ) : (
                        <span className="text-ink-4">no digest</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="min-w-0 space-y-3">
          {g.refused.length > 0 && (
            <div>
              <p className="mb-1 text-ink-3">Refused</p>
              {g.refused.map((r) => (
                <p key={r.specialistId} className="text-ink-2">
                  <Badge tone="critical">{label(r.specialistId)}</Badge>
                  <span className="mt-0.5 block text-ink-3">{r.reason}</span>
                </p>
              ))}
            </div>
          )}
          <div className="text-ink-3">
            <p>
              Equal-weight average {pct(g.naiveProb)} · {g.bookProb !== null ? `sportsbook ${pct(g.bookProb)}` : "no sportsbook line"}
            </p>
            <p>
              Decision: <span className="text-ink-2">{g.action}</span> · paper P&amp;L {g.pnlUsd >= 0 ? "+" : "−"}${Math.abs(g.pnlUsd).toFixed(2)}
            </p>
            {g.marketAsOf && <p>Priced as of {new Date(g.marketAsOf).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p>}
            <p className="mt-1">
              Post-mortem on Walrus{" "}
              <a className="link font-mono text-[11px]" href={walruscanBlob(g.postMortemBlobId)} target="_blank" rel="noreferrer">
                {short(g.postMortemBlobId, 8, 6)}
              </a>
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}

export function RecordApp() {
  const load = useLoad(() => api.record());
  const data: RecordResponse | null = load.data;
  const [league, setLeague] = useState<MarketDomain | "ALL">("ALL");
  const leagues = useMemo(() => [...new Set((data?.games ?? []).map((g) => g.domain))], [data]);
  const games = (data?.games ?? []).filter((g) => league === "ALL" || g.domain === league);
  const t = data?.totals;
  const ids = data?.identities;

  return (
    <div className="grain min-h-screen bg-paper text-ink">
      <AppHeader
        active="record"
        right={
          <a href="/api/record" className="text-[13px] text-paper/70 underline decoration-paper/30 underline-offset-4 hover:text-paper">
            Raw JSON
          </a>
        }
      />
      <Masthead>
        <AppSections active="record" />
        <PageTitle title="Record">
          Every game Calibro has settled, read live from its post-mortems on Walrus Memory: what it forecast against Polymarket, which sources it paid on
          Sui and which it refused, and why. Every payment and record links to the chain.
        </PageTitle>
      </Masthead>

      <main className="relative z-10 mx-auto -mt-6 flex max-w-[1440px] flex-col gap-4 px-3 pb-10 min-[901px]:gap-6 min-[901px]:px-6 min-[901px]:pb-12">
        <Panel title="The record so far" kicker="Totals over every settled game on the Walrus Memory account">
          {!data && load.error ? (
            <LoadError error={load.error} retrying={load.retrying} onRetry={load.reload} />
          ) : !data || !t ? (
            <Skeleton rows={3} />
          ) : (
            <>
              <StaleNote cache={data.cache} />
              <div className="grid grid-cols-2 gap-x-6 gap-y-6 md:grid-cols-5">
                <Figure value={String(t.games)} caption="games settled" />
                <Figure value={t.calibroBrier.toFixed(3)} caption={`Calibro's Brier (Polymarket ${t.marketBrier.toFixed(3)})`} />
                <Figure value={String(t.paidSignals)} caption="signals paid for on Sui" />
                <Figure value={String(t.refusals)} caption="payments refused" />
                <Figure value={`${t.paperPnlUsd >= 0 ? "+" : "−"}$${Math.abs(t.paperPnlUsd).toFixed(0)}`} caption="paper P&L, $2,500 bankroll" />
              </div>
              <dl className="mt-6 grid gap-x-8 gap-y-3 border-t border-rule pt-4 text-[13px] sm:grid-cols-3">
                {(
                  [
                    ["Walrus Memory account", ids?.accountId, "object"],
                    ["Agent wallet, pays for signals", ids?.agentAddress, "account"],
                    ["Treasury, receives signal fees", ids?.treasury, "account"],
                  ] as const
                ).map(([k, id, kind]) =>
                  id ? (
                    <div key={k} className="min-w-0">
                      <dt className="text-[12px] text-ink-3">{k}</dt>
                      <dd>
                        <a className="link font-mono text-[12px]" href={suiscan(kind, id)} target="_blank" rel="noreferrer">
                          {short(id, 10, 6)}
                        </a>
                      </dd>
                    </div>
                  ) : null
                )}
              </dl>
              <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
                Brier is the squared miss, averaged; lower is better and 0.250 is a coin flip. Calibro doesn&apos;t claim to beat the market: the point is
                which sources it learns to pay.
              </p>
            </>
          )}
        </Panel>

        <Panel
          delay={80}
          title="Games"
          kicker="Newest first. Open a game to see who was paid, with the Sui transaction, and who was refused."
          right={
            leagues.length > 1 ? (
              <Segmented
                value={league}
                onChange={setLeague}
                options={[{ value: "ALL" as const, label: "All" }, ...leagues.map((d) => ({ value: d, label: DOMAIN_LABEL[d] }))]}
              />
            ) : null
          }
        >
          {!data && load.error ? (
            <LoadError error={load.error} retrying={load.retrying} onRetry={load.reload} />
          ) : !data ? (
            <Skeleton rows={8} />
          ) : games.length === 0 ? (
            <Empty>No settled games in this league yet.</Empty>
          ) : (
            <div className="-mx-5 -my-4">
              <div className="hidden grid-cols-[64px_56px_minmax(0,1fr)_88px_150px_120px_96px] gap-x-4 border-b border-rule px-5 py-2 text-[12px] text-ink-3 md:grid">
                <span>Settled</span>
                <span>League</span>
                <span>Game</span>
                <span>Result</span>
                <span>Calibro vs Poly</span>
                <span>Brier</span>
                <span>Sources</span>
              </div>
              {games.map((g) => (
                <GameRow key={g.marketId} g={g} />
              ))}
            </div>
          )}
        </Panel>
      </main>
    </div>
  );
}
