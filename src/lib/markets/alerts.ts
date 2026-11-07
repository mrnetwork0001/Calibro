/**
 * Disagreement alerts: flag markets where the venues or the sources don't agree.
 * Deterministic thresholds; specialist values are never revealed here (they're sold
 * behind x402), only the fact that they split.
 */
import type { MarketAlert } from "../types/calibro";

export const VENUE_GAP = 0.03;
const VENUE_GAP_SERIOUS = 0.06;
const SOURCE_RANGE = 0.1;

const pts = (d: number) => `${(Math.abs(d) * 100).toFixed(1)} pts`;
const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

export function computeAlerts(input: {
  polymarket: number;
  book: { probability: number; provider: string } | null;
  kalshi: number | null;
  /** Probabilities of the non-contrarian sources (a contrarian disagrees by design) */
  sources: number[];
}): MarketAlert[] {
  const out: MarketAlert[] = [];
  const venue = (kind: MarketAlert["kind"], label: string, p: number) => {
    const gap = p - input.polymarket;
    if (Math.abs(gap) < VENUE_GAP) return;
    out.push({
      kind,
      severity: Math.abs(gap) >= VENUE_GAP_SERIOUS ? "serious" : "warning",
      magnitude: Number(Math.abs(gap).toFixed(4)),
      detail: `${label} ${pct(p)} vs Polymarket ${pct(input.polymarket)} (${pts(gap)})`,
    });
  };
  if (input.book) venue("BOOK_VS_CHAIN", input.book.provider, input.book.probability);
  if (input.kalshi !== null) venue("KALSHI_VS_CHAIN", "Kalshi", input.kalshi);

  if (input.sources.length >= 2) {
    const max = Math.max(...input.sources);
    const min = Math.min(...input.sources);
    const sideSplit = max >= 0.55 && min <= 0.45;
    if (sideSplit || max - min >= SOURCE_RANGE) {
      out.push({
        kind: "SOURCES_SPLIT",
        severity: sideSplit ? "serious" : "warning",
        magnitude: Number((max - min).toFixed(4)),
        detail: sideSplit ? "Specialists disagree on who the favourite is" : `Specialists are ${pts(max - min)} apart`,
      });
    }
  }
  // Venue gaps and source spreads aren't the same unit: order by severity, then by kind.
  const order: MarketAlert["kind"][] = ["BOOK_VS_CHAIN", "KALSHI_VS_CHAIN", "SOURCES_SPLIT"];
  return out.sort((a, b) => Number(b.severity === "serious") - Number(a.severity === "serious") || order.indexOf(a.kind) - order.indexOf(b.kind));
}
