"use client";

import { useEffect, useMemo, useState } from "react";
import type { MarketDomain, SpecialistId } from "@/lib/types/calibro";
import { api, DOMAIN_LABEL, pct, short, SPECIALIST_LABEL, walruscanBlob, type Timeline, type TimelineSource, type TrustStatus } from "./api";
import { Badge, Button, Empty, Panel, SERIES, Segmented, Skeleton } from "./ui";

const CUTOFF = 0.265;
const STATUS_TONE: Record<TrustStatus, "neutral" | "good" | "critical"> = { EXPLORING: "neutral", TRUSTED: "good", VETOED: "critical" };
const STATUS_LABEL: Record<TrustStatus, string> = { EXPLORING: "Exploring", TRUSTED: "Paid", VETOED: "Refused" };

/** One small multiple: a source's recalled Brier after each settlement in this league. */
function BrierSpark({ points, cursor, label }: { points: Array<number | null>; cursor: number; label: string }) {
  const W = 220;
  const H = 56;
  const PAD = 4;
  const max = Math.max(0.4, ...points.filter((p): p is number => p !== null));
  const x = (i: number) => PAD + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - 2 * PAD));
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const segs: string[] = [];
  let cur = "";
  points.forEach((p, i) => {
    if (p === null) {
      if (cur) segs.push(cur);
      cur = "";
    } else cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`;
  });
  if (cur) segs.push(cur);
  const at = points[cursor];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" role="img" aria-label={`${label} Brier over settlements`}>
      <line x1={PAD} x2={W - PAD} y1={y(CUTOFF)} y2={y(CUTOFF)} stroke="var(--color-critical)" strokeOpacity={0.6} strokeDasharray="3 3" strokeWidth={1} />
      {points.length > 1 && <line x1={x(cursor)} x2={x(cursor)} y1={PAD} y2={H - PAD} stroke="var(--color-rule-strong)" strokeWidth={1} />}
      {segs.map((d) => (
        <path key={d} d={d} fill="none" stroke={SERIES.calibro} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {at !== null && at !== undefined && <circle cx={x(cursor)} cy={y(at)} r={4} fill={SERIES.calibro} stroke="#ffffff" strokeWidth={2} />}
      {points.map((p, i) =>
        p === null ? null : (
          <rect key={i} x={x(i) - 6} y={0} width={12} height={H} fill="transparent">
            <title>{`Settlement ${i + 1}: Brier ${p.toFixed(3)}`}</title>
          </rect>
        )
      )}
    </svg>
  );
}

function LeagueRows({ rows }: { rows: TimelineSource[] }) {
  if (rows.length === 0) return <Empty>No source has been scored in this league yet.</Empty>;
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.specialistId}>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-ink-2">{SPECIALIST_LABEL[r.specialistId]}</span>
            <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
              Brier {r.brier.toFixed(3)} <span className="text-ink-3">n={r.samples}</span>
              <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full rounded-full bg-rule" title={`trust weight ${(r.weight * 100).toFixed(0)}%`}>
            {r.weight > 0 && <div className="h-1.5 rounded-full bg-ink-4 transition-all duration-300" style={{ width: `${Math.max(2, r.weight * 100)}%` }} />}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LearningTimeline({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [league, setLeague] = useState<MarketDomain | null>(null);
  const [playing, setPlaying] = useState(false);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    api
      .timeline()
      .then((t) => {
        setData(t);
        setStep(Math.max(0, t.steps.length - 1));
        setLeague((l) => l ?? t.domains.find((d) => d === "NBA") ?? t.domains[0] ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, [refreshKey]);

  useEffect(() => {
    if (!playing || !data) return;
    if (step >= data.steps.length - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => s + 1), 700);
    return () => clearTimeout(t);
  }, [playing, step, data]);

  const current = data?.steps[step] ?? null;
  const leagueView = useMemo(() => {
    if (!data || !league) return null;
    const idx = data.steps.map((s, i) => ({ s, i })).filter(({ s }) => s.domain === league);
    const upto = idx.filter(({ i }) => i <= step);
    const rows = upto.length ? upto[upto.length - 1].s.league : [];
    const ids = [...new Set(idx.flatMap(({ s }) => s.league.map((r) => r.specialistId)))] as SpecialistId[];
    const series = ids.map((id) => ({
      id,
      points: idx.map(({ s }) => s.league.find((r) => r.specialistId === id)?.brier ?? null),
    }));
    return { rows, series, cursor: Math.max(0, upto.length - 1), count: idx.length };
  }, [data, league, step]);

  return (
    <Panel
      delay={320}
      kicker="Every settlement replayed from Walrus, in order: watch trust shift and refusals switch on"
      title="Learning timeline"
      right={
        data && data.domains.length > 0 && league ? (
          <Segmented value={league} onChange={setLeague} options={data.domains.map((d) => ({ value: d, label: DOMAIN_LABEL[d] }))} />
        ) : null
      }
    >
      {error ? (
        <Empty>{error}</Empty>
      ) : !data ? (
        <Skeleton rows={6} />
      ) : data.steps.length === 0 ? (
        <Empty>No settled markets on Walrus yet. Each settlement becomes a step here.</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => (step >= data.steps.length - 1 ? (setStep(0), setPlaying(true)) : setPlaying((p) => !p))}>
              {playing ? "Pause" : "Play"}
            </Button>
            <input
              type="range"
              min={0}
              max={data.steps.length - 1}
              value={step}
              onChange={(e) => {
                setPlaying(false);
                setStep(Number(e.target.value));
              }}
              className="w-full accent-ink"
              aria-label="Settlement step"
            />
            <span className="shrink-0 font-mono text-[11px] text-ink-3 tabular-nums">
              {step + 1} / {data.steps.length}
            </span>
          </div>

          {current && (
            <div className="border-y border-rule py-3 text-[13px]">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-ink">
                  <span className="mr-2 text-[12px] text-ink-3">
                    Settlement {current.index} · {DOMAIN_LABEL[current.domain]}
                  </span>
                  <span className="font-serif text-[17px]">{current.title}</span>
                  {current.outcome !== null && <span className="ml-2 text-ink-3">resolved {current.outcome === 1 ? "YES" : "NO"}</span>}
                </p>
                <span className="text-[12px] text-ink-3">
                  Calibro <span className="font-mono text-ink-2">{pct(current.calibroProb, 0)}</span> · Polymarket{" "}
                  <span className="font-mono text-ink-2">{pct(current.marketProb, 0)}</span>
                  {current.postMortemBlobId && (
                    <>
                      {" · "}
                      <a className="link" href={walruscanBlob(current.postMortemBlobId)} target="_blank" rel="noreferrer">
                        post-mortem on Walrus
                      </a>
                    </>
                  )}
                </span>
              </div>
              {current.flips.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {current.flips.map((f) => (
                    <Badge key={f.specialistId} tone={STATUS_TONE[f.to]}>
                      {SPECIALIST_LABEL[f.specialistId]}: {STATUS_LABEL[f.from]} → {STATUS_LABEL[f.to]}
                    </Badge>
                  ))}
                </div>
              )}
              <ul className="mt-2 grid gap-x-6 gap-y-0.5 text-[12px] text-ink-3 sm:grid-cols-2 lg:grid-cols-3">
                {current.changes.map((c) => (
                  <li key={c.specialistId}>
                    <span className="text-ink-2">{SPECIALIST_LABEL[c.specialistId]}</span>{" "}
                    {c.kind === "SAMPLE" ? (
                      <span className="font-mono">
                        {c.prevBrier.toFixed(3)} → {c.nextBrier.toFixed(3)}
                      </span>
                    ) : (
                      "refused, not scored"
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {leagueView && league && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
              <div>
                <p className="mb-3 text-[13px] text-ink-2">Who Calibro pays in the {DOMAIN_LABEL[league]}, and how much it trusts them</p>
                <LeagueRows rows={leagueView.rows} />
              </div>
              <div>
                <div className="mb-2 flex items-start justify-between gap-3">
                  <p className="text-[13px] text-ink-2">
                    Brier after each {DOMAIN_LABEL[league]} settlement{" "}
                    <span className="text-[12px] text-ink-3">
                      · dashed line: <span className="text-critical-ink">0.265</span> refusal cutoff
                    </span>
                  </p>
                  <button type="button" onClick={() => setShowTable((v) => !v)} className="link text-[12px]">
                    {showTable ? "Charts" : "Table"}
                  </button>
                </div>
                {showTable ? (
                  <div className="max-h-56 overflow-auto">
                    <table className="w-full max-sm:min-w-[480px] text-right font-mono text-[11px] tabular-nums">
                      <thead className="text-ink-3">
                        <tr>
                          <th className="text-left font-normal">#</th>
                          {leagueView.series.map((s) => (
                            <th key={s.id} className="font-normal">{SPECIALIST_LABEL[s.id]}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: leagueView.count }, (_, i) => (
                          <tr key={i} className={i === leagueView.cursor ? "text-ink" : "text-ink-3"}>
                            <td className="text-left">{i + 1}</td>
                            {leagueView.series.map((s) => (
                              <td key={s.id}>{s.points[i]?.toFixed(3) ?? "—"}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    {leagueView.series.map((s) => (
                      <div key={s.id}>
                        <p className="text-[11px] text-ink-2">{SPECIALIST_LABEL[s.id]}</p>
                        <BrierSpark points={s.points} cursor={leagueView.cursor} label={SPECIALIST_LABEL[s.id]} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <p className="text-[10px] text-ink-3">
            Replayed from {data.checkpoints} calibration checkpoints on Walrus. Status and weights use the engine&apos;s own gate and weighting functions.
          </p>
        </div>
      )}
    </Panel>
  );
}
