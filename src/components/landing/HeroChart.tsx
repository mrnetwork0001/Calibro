"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { HeroSeries } from "@/lib/landing/ledger";
import { SPECIALIST_PROFILES } from "@/lib/specialists/models";

const LO = 0.12;
const HI = 0.4;
const CUTOFF = 0.265;

/** Replay pacing: one settlement per STEP_MS, a pause on the final state, then again. */
const STEP_MS = 340;
const HOLD_END_MS = 3200;
const HOLD_FIRST_MS = 1600;

type Dims = { W: number; H: number; M: { l: number; r: number; t: number; b: number } };
/** Desktop: wide plot with direct end labels. Phone: a narrow plot drawn near 1:1, names in a legend. */
const WIDE: Dims = { W: 640, H: 380, M: { l: 44, r: 150, t: 28, b: 36 } };
const NARROW: Dims = { W: 360, H: 260, M: { l: 34, r: 12, t: 26, b: 30 } };

const PAPER = "rgba(245,243,238,";
const RUST = "#e0663c";
const RUST_TEXT = "#f08a62";

/** Spread end labels so none overlap (min gap in px), keeping their order. */
function layoutLabels(ys: number[], bottom: number, gap = 17): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const placed: number[] = new Array(ys.length);
  let prev = -Infinity;
  for (const o of order) {
    const y = Math.max(o.y, prev + gap);
    placed[o.i] = y;
    prev = y;
  }
  const overflow = Math.max(0, Math.max(...placed, -Infinity) - bottom);
  return placed.map((y) => y - overflow);
}

/** A source's Brier at a fractional settlement index, interpolated between real settlements. */
function valueAt(points: Array<number | null>, t: number): number | null {
  const i = Math.floor(t);
  const a = points[i];
  if (a === null || a === undefined) return null;
  const b = points[i + 1];
  const f = t - i;
  return b === null || b === undefined || f === 0 ? a : a + (b - a) * f;
}

/**
 * Drives the replay: a cursor `t` from settlement 0 to the last, looping. Starts on the
 * final state (what the server rendered), pauses off-screen, and stays on the final state
 * for anyone who prefers reduced motion.
 */
function useReplay(n: number, root: React.RefObject<HTMLElement | null>): number {
  const last = n - 1;
  const [t, setT] = useState(last);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || last < 1) return;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.05 });
    if (root.current) io.observe(root.current);

    const playMs = last * STEP_MS;
    const cycle = playMs + HOLD_END_MS;
    let raf = 0;
    let clock = -HOLD_FIRST_MS; // ms into the current cycle; negative = first hold on the final state
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, now - prev);
      prev = now;
      if (visible) {
        clock += dt;
        if (clock >= cycle) clock -= cycle;
        setT(clock < 0 ? last : clock < playMs ? clock / STEP_MS : last);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [last, root]);
  return t;
}

function Plot({ data, dims, labels, className, t }: { data: HeroSeries; dims: Dims; labels: boolean; className: string; t: number }) {
  const clipId = useId().replace(/:/g, "");
  const { W, H, M } = dims;
  const n = Math.max(2, data.settlements);
  const x = (i: number) => M.l + (i / (n - 1)) * (W - M.l - M.r);
  const y = (v: number) => M.t + (1 - (Math.min(HI, Math.max(LO, v)) - LO) / (HI - LO)) * (H - M.t - M.b);

  // Full paths once; the replay only moves a clip edge over them.
  const paths = useMemo(
    () =>
      data.series.map((s) => {
        let d = "";
        s.points.forEach((v, i) => {
          if (v === null) return;
          d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        });
        return d;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, dims]
  );

  const step = Math.floor(t);
  const cx = x(t);
  const now = data.series.map((s) => ({ s, v: valueAt(s.points, t), refusedNow: s.statuses?.[step] === "VETOED" }));
  const shown = now.filter((r) => r.v !== null);
  const labelYs = layoutLabels(
    shown.map((r) => y(r.v!)),
    H - M.b
  );
  const atEnd = t >= n - 1 - 1e-6;
  const playX = Math.min(W - M.r - 18, Math.max(M.l + 18, cx));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`w-full overflow-visible ${className}`} role="img" aria-label={`Brier score of each source after every ${data.league} settlement, replayed`}>
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={Math.max(0, cx + 1)} height={H} />
        </clipPath>
      </defs>

      {/* grid */}
      {[0.15, 0.2, 0.25, 0.3, 0.35].map((g) => (
        <g key={g}>
          <line x1={M.l} x2={W - M.r} y1={y(g)} y2={y(g)} stroke={`${PAPER}0.09)`} />
          <text x={M.l - (labels ? 10 : 8)} y={y(g) + 4} textAnchor="end" fill={`${PAPER}0.45)`} fontSize="11" style={{ fontVariantNumeric: "tabular-nums" }}>
            {g.toFixed(2)}
          </text>
        </g>
      ))}

      {/* x-axis: ends, and the playhead's game number */}
      {!atEnd && cx - M.l > 70 && (
        <text x={M.l} y={H - 8} fill={`${PAPER}0.35)`} fontSize="11">
          1
        </text>
      )}
      {!atEnd && W - M.r - cx > 50 && (
        <text x={W - M.r} y={H - 8} textAnchor="end" fill={`${PAPER}0.35)`} fontSize="11">
          {data.settlements}
        </text>
      )}
      <text
        x={atEnd ? W - M.r : playX}
        y={H - 8}
        textAnchor={atEnd ? "end" : "middle"}
        fill={`${PAPER}0.7)`}
        fontSize="11"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {atEnd ? `${data.settlements} games settled` : `game ${step + 1}`}
      </text>

      {/* refusal cutoff, gently flowing */}
      <line x1={M.l} x2={W - M.r} y1={y(CUTOFF)} y2={y(CUTOFF)} stroke={RUST} strokeOpacity={0.75} strokeDasharray="4 4" className="cutoff-flow" />
      <text x={W - M.r - 4} y={y(CUTOFF) - 8} textAnchor="end" fill={RUST_TEXT} fontSize="11">
        {labels ? "refusal cutoff 0.265 · above it, Calibro stops paying" : "refusal cutoff 0.265"}
      </text>

      {/* playhead */}
      {!atEnd && <line x1={cx} x2={cx} y1={M.t - 6} y2={H - M.b} stroke={`${PAPER}0.22)`} strokeWidth={1} />}

      {/* series, revealed up to the playhead */}
      <g clipPath={`url(#${clipId})`}>
        {data.series.map((s, k) => (
          <path
            key={s.id}
            d={paths[k]}
            fill="none"
            stroke={s.refused ? RUST : `${PAPER}0.62)`}
            strokeWidth={s.refused ? 2.5 : 1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            <title>{`${SPECIALIST_PROFILES[s.id].name}: Brier ${s.final.toFixed(3)} after ${s.samples} games${s.refused ? ", refused" : ""}`}</title>
          </path>
        ))}
      </g>

      {/* dots riding the playhead */}
      {shown.map(({ s, v, refusedNow }) => (
        <g key={`${s.id}-dot`}>
          {refusedNow && <circle cx={cx} cy={y(v!)} r={4.5} fill="none" stroke={RUST} strokeWidth={1.5} className="ring-pulse" />}
          <circle cx={cx} cy={y(v!)} r={s.refused ? 4.5 : 3.5} fill={s.refused ? RUST : "#f5f3ee"} />
        </g>
      ))}

      {/* direct labels (wide plot only), counting with the replay */}
      {labels &&
        shown.map(({ s, v, refusedNow }, k) => (
          <g key={`${s.id}-label`}>
            <line x1={cx + 6} x2={W - M.r + 10} y1={y(v!)} y2={labelYs[k]} stroke={`${PAPER}0.2)`} />
            <text x={W - M.r + 14} y={labelYs[k] + 4} fontSize="12" fill={s.refused ? RUST_TEXT : `${PAPER}0.85)`}>
              {SPECIALIST_PROFILES[s.id].name}
              <tspan fill={`${PAPER}0.45)`} dx="6" style={{ fontVariantNumeric: "tabular-nums" }}>
                {v!.toFixed(3)}
              </tspan>
              {refusedNow && (
                <tspan fill={RUST_TEXT} dx="6">
                  refused
                </tspan>
              )}
            </text>
          </g>
        ))}
    </svg>
  );
}

/**
 * The hero exhibit: every source's Brier score after each real settlement in one league,
 * replayed on a loop from Walrus Memory. The refused source is the only coloured line;
 * its label says "refused" from the settlement where Calibro stopped paying it.
 */
export function HeroChart({ data }: { data: HeroSeries }) {
  const rootRef = useRef<HTMLElement | null>(null);
  const t = useReplay(Math.max(2, data.settlements), rootRef);
  const refused = data.series.find((l) => l.refused);
  const ranked = [...data.series].filter((l) => l.samples > 0).sort((a, b) => a.final - b.final);
  const step = Math.floor(t);

  return (
    <figure ref={rootRef} className="w-full">
      <Plot data={data} dims={WIDE} labels className="hidden sm:block" t={t} />
      <Plot data={data} dims={NARROW} labels={false} className="sm:hidden" t={t} />
      {/* Phone legend: the direct labels don't fit a narrow plot, so the names sit below it. */}
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:hidden">
        {ranked.map((l) => {
          const v = valueAt(l.points, t);
          const refusedNow = l.statuses?.[step] === "VETOED";
          return (
            <li key={l.id} className="flex items-center justify-between gap-2 border-b border-paper/10 pb-1">
              <span className={`flex min-w-0 items-center gap-1.5 ${l.refused ? "text-[#f08a62]" : "text-paper/80"}`}>
                <span aria-hidden className={`inline-block h-[2px] w-3 shrink-0 ${l.refused ? "bg-[#e0663c]" : "bg-paper/60"}`} />
                <span className="truncate">
                  {SPECIALIST_PROFILES[l.id].name}
                  {refusedNow && " · refused"}
                </span>
              </span>
              <span className="font-mono text-paper/50 tabular-nums">{v === null ? "—" : v.toFixed(3)}</span>
            </li>
          );
        })}
      </ul>
      <figcaption className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-paper/55">
        Brier score of each source after every {data.league} game Calibro has settled, replayed from Walrus Memory. Lower is better; a coin flip
        scores 0.250.
        {refused && ` ${SPECIALIST_PROFILES[refused.id].name} crossed the cutoff after ${refused.samples} games and has not been paid since.`}
      </figcaption>
    </figure>
  );
}
