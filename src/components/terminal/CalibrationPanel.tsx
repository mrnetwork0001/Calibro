"use client";

import { useMemo, useState } from "react";
import type { MarketDomain, SpecialistId } from "@/lib/types/calibro";
import type { CalibrationResponse, MarketEvaluation, SettleResponse } from "./api";
import { DOMAIN_LABEL, SPECIALIST_LABEL, pct, short } from "./api";
import { Badge, Button, Empty, ErrorLine, LoadError, Panel, SERIES, Segmented, Skeleton, StaleNote } from "./ui";

const SPECIALISTS: SpecialistId[] = ["sharp-steam", "power-rating", "onchain-flow", "hype-contrarian", "kalshi-crowd", "manifold-crowd", "top-pickers"];
const BINS = 5;

interface Bin {
  idx: number;
  meanP: number;
  observed: number;
  n: number;
}

function binPoints(points: Array<{ p: number; y: 0 | 1 }>): Bin[] {
  const acc = Array.from({ length: BINS }, () => ({ sumP: 0, sumY: 0, n: 0 }));
  for (const pt of points) {
    const i = Math.min(BINS - 1, Math.floor(pt.p * BINS));
    acc[i].sumP += pt.p;
    acc[i].sumY += pt.y;
    acc[i].n += 1;
  }
  return acc.flatMap((a, idx) => (a.n === 0 ? [] : [{ idx, meanP: a.sumP / a.n, observed: a.sumY / a.n, n: a.n }]));
}

const W = 300;
const H = 240;
const M = { l: 36, r: 12, t: 10, b: 30 };
const x = (p: number) => M.l + p * (W - M.l - M.r);
const y = (p: number) => H - M.b - p * (H - M.t - M.b);

function Reliability({ calibro, specialist, specialistName }: { calibro: Bin[]; specialist: Bin[]; specialistName: string }) {
  const [hover, setHover] = useState<{ series: string; bin: Bin } | null>(null);
  const series = [
    { key: "Calibro", color: SERIES.calibro, bins: calibro },
    { key: specialistName, color: SERIES.specialist, bins: specialist },
  ];

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Reliability diagram: predicted probability vs observed hit rate">
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} stroke="var(--color-rule)" strokeWidth={1} />
            <text x={M.l - 6} y={y(t) + 3} textAnchor="end" className="fill-ink-3 text-[9px]">
              {t * 100}%
            </text>
            <text x={x(t)} y={H - M.b + 13} textAnchor="middle" className="fill-ink-3 text-[9px]">
              {t * 100}%
            </text>
          </g>
        ))}
        <text x={x(0.5)} y={H - 3} textAnchor="middle" className="fill-ink-3 text-[9px]">
          Predicted probability
        </text>
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--color-ink-4)" strokeWidth={1} strokeDasharray="4 4" />

        {series.map((s) => (
          <g key={s.key}>
            {s.bins.length > 1 && (
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                points={s.bins.map((b) => `${x(b.meanP)},${y(b.observed)}`).join(" ")}
              />
            )}
            {s.bins.map((b) => (
              <g key={b.idx}>
                <circle cx={x(b.meanP)} cy={y(b.observed)} r={5} fill={s.color} stroke="#ffffff" strokeWidth={2} />
                <circle
                  cx={x(b.meanP)}
                  cy={y(b.observed)}
                  r={12}
                  fill="transparent"
                  onMouseEnter={() => setHover({ series: s.key, bin: b })}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            ))}
          </g>
        ))}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute border border-rule-strong bg-surface px-2.5 py-1.5 text-[11px] text-ink shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
          style={{ left: `${(x(hover.bin.meanP) / W) * 100}%`, top: `${(y(hover.bin.observed) / H) * 100}%`, transform: "translate(-50%, -120%)" }}
        >
          <p className="font-semibold">{hover.series}</p>
          <p>predicted {pct(hover.bin.meanP)}</p>
          <p>observed {pct(hover.bin.observed)}</p>
          <p className="text-ink-3">n = {hover.bin.n}</p>
        </div>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-2">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
            {s.key}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-ink-3">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="var(--color-ink-4)" strokeDasharray="4 3" />
          </svg>
          perfect calibration
        </span>
      </div>
    </div>
  );
}

export function CalibrationPanel(props: {
  data: CalibrationResponse | null;
  /** Set when the last read failed (the panel then says so; it never shows an empty record) */
  loadError?: string | null;
  retrying?: boolean;
  onRetry?: () => void;
  evaluation: MarketEvaluation | null;
  /** Operator only: settling writes to Walrus */
  canSettle?: boolean;
  settling: boolean;
  settleError: string | null;
  lastSettle: SettleResponse | null;
  onSettle: () => void;
}) {
  const [domain, setDomain] = useState<MarketDomain>("NBA");
  const [compareTo, setCompareTo] = useState<SpecialistId>("hype-contrarian");
  const [asTable, setAsTable] = useState(false);

  const rows = useMemo(
    () =>
      SPECIALISTS.map((id) => props.data?.calibrations.find((c) => c.specialistId === id && c.domain === domain) ?? null),
    [props.data, domain]
  );

  const pts = props.data?.points ?? [];
  const calibroBins = binPoints(pts.filter((p) => p.source === "calibro"));
  const specBins = binPoints(pts.filter((p) => p.source === compareTo));
  const evaluated = props.evaluation?.market;
  const isLive = props.evaluation?.market.source === "LIVE";
  const settle = props.lastSettle?.result;

  const title = "Calibration ledger";
  const kicker = "Each source's Brier score by league, recalled from Walrus Memory. Lower is better; 0.250 is a coin flip.";
  if (!props.data) {
    return (
      <Panel delay={240} title={title} kicker={kicker}>
        {props.loadError ? (
          <LoadError error={props.loadError} retrying={Boolean(props.retrying)} onRetry={props.onRetry ?? (() => undefined)} />
        ) : (
          <Skeleton rows={7} />
        )}
      </Panel>
    );
  }

  return (
    <Panel delay={240} title={title} kicker={kicker}>
      <StaleNote cache={props.data.cache} />
      {props.loadError && (
        <p className="mb-3 text-[12px] text-warning-ink" title={props.loadError}>
          ▲ Refreshing from Walrus failed; showing the record loaded earlier.
        </p>
      )}
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-3">
            <Segmented
              value={domain}
              onChange={setDomain}
              options={(Object.keys(DOMAIN_LABEL) as MarketDomain[]).map((d) => ({ value: d, label: DOMAIN_LABEL[d] }))}
            />
          </div>
          <div className="-mx-5 overflow-x-auto px-5">
          <table className="w-full max-sm:min-w-[440px] text-left text-[13px]">
            <thead className="text-[12px] text-ink-3">
              <tr>
                <th className="py-1.5 font-normal">Source</th>
                <th className="py-1.5 text-right font-normal">Brier</th>
                <th className="py-1.5 text-right font-normal">Slope α</th>
                <th className="py-1.5 text-right font-normal" title="settled samples · payments refused">n · refused</th>
                <th className="py-1.5 pl-3 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {SPECIALISTS.map((id, i) => {
                const r = rows[i];
                const status = !r
                  ? { tone: "neutral" as const, label: "No record" }
                  : r.sampleSize < 4
                    ? { tone: "info" as const, label: "Exploring" }
                    : r.brierScore > 0.265
                      ? { tone: "critical" as const, label: "Refused" }
                      : { tone: "good" as const, label: "Paid" };
                return (
                  <tr key={id} className="border-t border-rule">
                    <td className="py-1.5 text-ink-2">{SPECIALIST_LABEL[id]}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-ink">{r ? r.brierScore.toFixed(3) : "—"}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-ink-2">{r ? r.alphaSlope.toFixed(2) : "—"}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-ink-3">{r ? `${r.sampleSize} · ${r.x402VetoedCount}` : "—"}</td>
                    <td className="py-1.5 pl-3">
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <p className="mt-2 text-[12px] text-ink-3">A source is refused once its Brier passes 0.265 after 4 settled games in a league.</p>

          {props.canSettle ? (
          <div className="mt-6 border-t border-rule pt-4">
            <p className="text-[13px] text-ink-2">
              {evaluated ? (
                <>
                  Settle <span className="text-ink">{evaluated.title}</span> to Polymarket&apos;s resolution{" "}
                  {isLive && <span className="text-ink-3">(upcoming: possible once the market resolves; the 30-minute settlement job also does it)</span>}
                </>
              ) : (
                "Evaluate a market first, then settle it to write the post-mortem."
              )}
            </p>
            <div className="mt-2">
              <Button onClick={props.onSettle} busy={props.settling} disabled={!evaluated}>
                Settle and record on Walrus
              </Button>
            </div>
            {props.settling && <p className="mt-2 text-[12px] text-ink-3">Writing the calibration updates and post-mortem to Walrus…</p>}
            <ErrorLine error={props.settleError} />
            {settle?.status === "SETTLED" && (
              <div className="mt-3 text-[12px] text-ink-2">
                <p className="text-ink">
                  Settled {settle.settled.outcome === 1 ? "YES" : "NO"}. Calibro scored {settle.settled.realizedBrier?.toFixed(3)} (equal weights would have scored{" "}
                  {settle.settled.naiveRealizedBrier?.toFixed(3)}); paper P&amp;L ${settle.settled.pnlUsd}.
                </p>
                <p className="mt-1 text-ink-3">
                  Post-mortem <span className="font-mono">{short(settle.episodicWrite.blob_id, 10, 6)}</span>
                </p>
                {settle.updates.map((u) => (
                  <p key={u.specialistId} className="text-ink-3">
                    {SPECIALIST_LABEL[u.specialistId]} {u.kind === "SAMPLE" ? `Brier ${u.prevBrier.toFixed(3)} → ${u.nextBrier.toFixed(3)}` : u.kind === "VETO_TALLY" ? "veto tallied" : "already applied"}
                  </p>
                ))}
              </div>
            )}
            {settle?.status === "ALREADY_SETTLED" && <p className="mt-2 text-[12px] text-ink-3">Already settled; nothing is written twice.</p>}
          </div>
          ) : (
            <p className="mt-6 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
              Settling writes the post-mortem to Walrus, so it&apos;s done by the operator and by the settlement job every 30 minutes, once Polymarket
              resolves a game.
            </p>
          )}
        </div>

        <div className="min-w-0">
          <p className="font-serif text-[16px] text-ink">Does 70% mean 70%?</p>
          <p className="mb-3 text-[12px] text-ink-3">Predicted probability against how often it happened, across every settled market.</p>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-[12px] text-ink-3">
              Compare Calibro with
              <select
                value={compareTo}
                onChange={(e) => setCompareTo(e.target.value as SpecialistId)}
                className="border border-rule-strong bg-surface px-1.5 py-0.5 text-[12px] text-ink"
              >
                {SPECIALISTS.map((id) => (
                  <option key={id} value={id}>
                    {SPECIALIST_LABEL[id]}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => setAsTable((v) => !v)} className="link text-[12px]">
              {asTable ? "Chart view" : "Table view"}
            </button>
          </div>
          {pts.length === 0 ? (
            <Empty>No settled markets on Walrus yet. Run the training script or settle resolved markets to draw the reliability curve.</Empty>
          ) : asTable ? (
            <table className="w-full font-mono text-[12px] tabular-nums">
              <thead className="text-ink-3">
                <tr>
                  <th className="text-left font-normal">Series</th>
                  <th className="text-right font-normal">Predicted</th>
                  <th className="text-right font-normal">Observed</th>
                  <th className="text-right font-normal">n</th>
                </tr>
              </thead>
              <tbody className="text-ink-2">
                {[
                  ["Calibro", calibroBins],
                  [SPECIALIST_LABEL[compareTo], specBins],
                ].flatMap(([name, bins]) =>
                  (bins as Bin[]).map((b) => (
                    <tr key={`${name}-${b.idx}`}>
                      <td>{name as string}</td>
                      <td className="text-right">{pct(b.meanP)}</td>
                      <td className="text-right">{pct(b.observed)}</td>
                      <td className="text-right">{b.n}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <Reliability calibro={calibroBins} specialist={specBins} specialistName={SPECIALIST_LABEL[compareTo]} />
          )}
          <p className="mt-2 text-[12px] text-ink-3">
            {props.data?.settled.length ?? 0} settled markets recalled from Walrus, all leagues, in five probability bins.
          </p>
        </div>
      </div>
    </Panel>
  );
}
