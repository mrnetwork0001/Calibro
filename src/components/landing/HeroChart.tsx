import { SPECIALIST_PROFILES } from "@/lib/specialists/models";
import type { HeroSeries } from "@/lib/landing/ledger";

const LO = 0.12;
const HI = 0.4;
const CUTOFF = 0.265;

type Dims = { W: number; H: number; M: { l: number; r: number; t: number; b: number } };
/** Desktop: wide plot with direct end labels. Phone: a narrow plot drawn near 1:1, names in a legend. */
const WIDE: Dims = { W: 640, H: 380, M: { l: 44, r: 150, t: 28, b: 36 } };
const NARROW: Dims = { W: 360, H: 260, M: { l: 34, r: 12, t: 26, b: 30 } };

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
  // If the stack ran past the bottom, shift it back up.
  const overflow = Math.max(0, Math.max(...placed) - bottom);
  return placed.map((y) => y - overflow);
}

/**
 * The hero exhibit: every source's Brier score after each real settlement in one league,
 * drawn in as the page loads. The refused source is the only coloured line.
 */
function Plot({ data, dims, labels, className }: { data: HeroSeries; dims: Dims; labels: boolean; className: string }) {
  const { W, H, M } = dims;
  const n = Math.max(2, data.settlements);
  const x = (i: number) => M.l + (i / (n - 1)) * (W - M.l - M.r);
  const y = (v: number) => M.t + (1 - (Math.min(HI, Math.max(LO, v)) - LO) / (HI - LO)) * (H - M.t - M.b);

  const lines = data.series.map((s) => {
    let d = "";
    let last: { i: number; v: number } | null = null;
    s.points.forEach((v, i) => {
      if (v === null) return;
      d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      last = { i, v };
    });
    return { ...s, d, last: last as { i: number; v: number } | null };
  });
  const labelYs = layoutLabels(
    lines.map((l) => (l.last ? y(l.last.v) : 0)),
    H - M.b
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`w-full overflow-visible ${className}`} role="img" aria-label={`Brier score of each source after every ${data.league} settlement`}>
      {/* grid */}
      {[0.15, 0.2, 0.25, 0.3, 0.35].map((t) => (
        <g key={t}>
          <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} stroke="rgba(245,243,238,0.09)" />
          <text x={M.l - (labels ? 10 : 8)} y={y(t) + 4} textAnchor="end" fill="rgba(245,243,238,0.45)" fontSize="11" style={{ fontVariantNumeric: "tabular-nums" }}>
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      <text x={M.l} y={H - 8} fill="rgba(245,243,238,0.45)" fontSize="11">
        settlement 1
      </text>
      <text x={W - M.r} y={H - 8} textAnchor="end" fill="rgba(245,243,238,0.45)" fontSize="11">
        {data.settlements}
      </text>

      {/* refusal cutoff */}
      <line x1={M.l} x2={W - M.r} y1={y(CUTOFF)} y2={y(CUTOFF)} stroke="#e0663c" strokeOpacity={0.75} strokeDasharray="4 4" className="fade-in" style={{ animationDelay: "300ms" }} />
      <text x={W - M.r - 4} y={y(CUTOFF) - 8} textAnchor="end" fill="#f08a62" fontSize="11" className="fade-in" style={{ animationDelay: "300ms" }}>
        {labels ? "refusal cutoff 0.265 · above it, Calibro stops paying" : "refusal cutoff 0.265"}
      </text>

      {/* series */}
      {lines.map((l, k) => (
        <g key={l.id}>
          <title>{`${SPECIALIST_PROFILES[l.id].name}: Brier ${l.final.toFixed(3)} after ${l.samples} games${l.refused ? " — refused" : ""}`}</title>
          <path
            d={l.d}
            pathLength={1}
            fill="none"
            stroke={l.refused ? "#e0663c" : "rgba(245,243,238,0.62)"}
            strokeWidth={l.refused ? 2.5 : 1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
            className="draw-line"
            style={{ animationDelay: `${400 + k * 160}ms` }}
          />
          {l.last && (
            <circle
              cx={x(l.last.i)}
              cy={y(l.last.v)}
              r={l.refused ? 4.5 : 3.5}
              fill={l.refused ? "#e0663c" : "#f5f3ee"}
              className="pop"
              style={{ animationDelay: `${2100 + k * 160}ms` }}
            />
          )}
        </g>
      ))}

      {/* direct labels (wide plot only) */}
      {labels &&
        lines.map((l, k) =>
          l.last ? (
            <g key={`${l.id}-label`} className="fade-in" style={{ animationDelay: `${2200 + k * 160}ms` }}>
              <line x1={x(l.last.i) + 6} x2={W - M.r + 10} y1={y(l.last.v)} y2={labelYs[k]} stroke="rgba(245,243,238,0.2)" />
              <text x={W - M.r + 14} y={labelYs[k] + 4} fontSize="12" fill={l.refused ? "#f08a62" : "rgba(245,243,238,0.85)"}>
                {SPECIALIST_PROFILES[l.id].name}
                <tspan fill="rgba(245,243,238,0.45)" dx="6" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {l.final.toFixed(3)}
                </tspan>
              </text>
            </g>
          ) : null
        )}
    </svg>
  );
}

/**
 * The hero exhibit: every source's Brier score after each real settlement in one league,
 * drawn in as the page loads. The refused source is the only coloured line.
 */
export function HeroChart({ data }: { data: HeroSeries }) {
  const refused = data.series.find((l) => l.refused);
  const ranked = [...data.series].filter((l) => l.samples > 0).sort((a, b) => a.final - b.final);

  return (
    <figure className="w-full">
      <Plot data={data} dims={WIDE} labels className="hidden sm:block" />
      <Plot data={data} dims={NARROW} labels={false} className="sm:hidden" />
      {/* Phone legend: the direct labels don't fit a narrow plot, so the names sit below it. */}
      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:hidden">
        {ranked.map((l) => (
          <li key={l.id} className="flex items-center justify-between gap-2 border-b border-paper/10 pb-1">
            <span className={`flex min-w-0 items-center gap-1.5 ${l.refused ? "text-[#f08a62]" : "text-paper/80"}`}>
              <span aria-hidden className={`inline-block h-[2px] w-3 shrink-0 ${l.refused ? "bg-[#e0663c]" : "bg-paper/60"}`} />
              <span className="truncate">{SPECIALIST_PROFILES[l.id].name}</span>
            </span>
            <span className="font-mono text-paper/50 tabular-nums">{l.final.toFixed(3)}</span>
          </li>
        ))}
      </ul>
      <figcaption className="mt-3 max-w-[520px] text-[13px] leading-relaxed text-paper/55">
        Brier score of each source after every {data.league} game Calibro has settled, replayed from Walrus Memory. Lower is better; a coin flip
        scores 0.250.
        {refused && ` ${SPECIALIST_PROFILES[refused.id].name} crossed the cutoff after ${refused.samples} games and has not been paid since.`}
      </figcaption>
    </figure>
  );
}
