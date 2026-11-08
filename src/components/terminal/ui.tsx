"use client";

import type { ReactNode } from "react";
import { SuiLogo } from "../brand/SuiLogo";
import { asOfLabel, friendlyError } from "./api";

/** Reserved status palette (never reused for series). Always rendered with an icon + label. */
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

/** Categorical chart slots, validated on the light surface (adjacent CVD ΔE 24.7). */
export const SERIES = { calibro: "#2a78d6", specialist: "#eb6834" } as const;

/**
 * A section of the terminal: a hairline-bordered sheet with a quiet header.
 * `kicker` is kept for API compatibility and rendered as a plain descriptor.
 */
export function Panel(props: { title: string; kicker?: string; right?: ReactNode; children: ReactNode; className?: string; delay?: number }) {
  const descriptor = props.kicker?.replace(/^Panel \d+ · /, "");
  return (
    <section
      className={`rise flex min-w-0 flex-col border border-rule bg-surface shadow-[0_1px_0_rgba(21,21,20,0.04),0_8px_24px_-16px_rgba(21,21,20,0.18)] ${props.className ?? ""}`}
      style={{ animationDelay: `${props.delay ?? 0}ms` }}
    >
      <header className="flex items-start justify-between gap-x-4 gap-y-2 border-b border-rule px-5 pt-4 pb-3 max-[900px]:flex-wrap">
        <div className="min-w-0">
          <h2 className="font-serif text-[19px] leading-tight font-medium text-ink">{props.title}</h2>
          {descriptor && <p className="mt-0.5 text-[12px] text-ink-3">{descriptor}</p>}
        </div>
        {props.right && <div className="shrink-0 pt-0.5">{props.right}</div>}
      </header>
      <div className="min-w-0 flex-1 px-5 py-4">{props.children}</div>
    </section>
  );
}

type Tone = keyof typeof STATUS | "neutral" | "info";

const ICON: Record<Tone, string> = {
  good: "●",
  warning: "▲",
  serious: "▲",
  critical: "✕",
  neutral: "○",
  info: "●",
};
const DOT: Record<Tone, string> = {
  good: STATUS.good,
  warning: STATUS.warning,
  serious: STATUS.serious,
  critical: STATUS.critical,
  neutral: "#8f8c84",
  info: "#1d4ed8",
};

/** Status label: a small coloured glyph carries the state, the text stays in ink. */
export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-ink-2">
      <span aria-hidden className="text-[9px] leading-none" style={{ color: DOT[tone] }}>
        {ICON[tone]}
      </span>
      {children}
    </span>
  );
}

export function ModeBadge({ mode }: { mode: "LIVE_MAINNET" | "UNCONFIGURED" | undefined }) {
  if (!mode) return <Badge tone="neutral">Connecting…</Badge>;
  return mode === "LIVE_MAINNET" ? (
    <Badge tone="good" title="Connected to Sui Mainnet">
      <SuiLogo height={12} className="text-ink" />
      Mainnet
    </Badge>
  ) : (
    <Badge tone="warning" title="Walrus Memory / Tatum keys are missing: read-only until configured.">
      Not configured
    </Badge>
  );
}

export function Button(props: {
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  variant?: "primary" | "ghost";
  children: ReactNode;
  title?: string;
}) {
  const primary = props.variant !== "ghost";
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled || props.busy}
      className={`touch-btn inline-flex items-center justify-center gap-2 px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        primary
          ? "bg-ink text-paper hover:bg-ink-2"
          : "border border-rule-strong bg-surface text-ink hover:border-ink"
      }`}
    >
      {props.busy && (
        <span
          className={`h-3 w-3 animate-spin rounded-full border-2 ${primary ? "border-paper/30 border-t-paper" : "border-ink/20 border-t-ink"}`}
        />
      )}
      {props.children}
    </button>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[12px] text-ink-3">{label}</p>
      <p className="truncate font-serif text-[26px] leading-tight text-ink tabular-nums">{value}</p>
      {sub && <p className="truncate text-[12px] text-ink-3">{sub}</p>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-24 items-center justify-center px-6 py-8 text-center text-[13px] leading-relaxed text-ink-3">{children}</div>;
}

/** Shimmering placeholder rows while live data loads. */
export function Skeleton({ rows = 5, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`flex flex-col gap-3 py-2 ${className}`} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="skeleton h-3 flex-1" style={{ maxWidth: `${70 - (i % 3) * 12}%` }} />
          <div className="skeleton h-3 w-12" />
          <div className="skeleton h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/**
 * A read that failed, said plainly: what happened, that it's retrying, or a Retry button.
 * The raw error stays available on hover for anyone debugging.
 */
export function LoadError({ error, retrying, onRetry, compact }: { error: string; retrying: boolean; onRetry: () => void; compact?: boolean }) {
  return (
    <div role="status" className={`flex flex-col items-center justify-center gap-3 text-center text-[13px] text-ink-3 ${compact ? "py-3" : "min-h-24 px-6 py-8"}`}>
      <p title={error}>
        <span aria-hidden className="mr-1.5 text-[10px]" style={{ color: STATUS.warning }}>
          ▲
        </span>
        {friendlyError(error)}
      </p>
      {retrying ? <p className="text-[12px] text-ink-4">Retrying…</p> : <Button variant="ghost" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

/** Shown when the server served its last good copy because Walrus didn't answer just now. */
export function StaleNote({ cache }: { cache?: { asOf: string; stale: boolean } }) {
  if (!cache?.stale) return null;
  return (
    <p className="mb-3 text-[12px] text-warning-ink">
      ▲ Walrus Memory didn&apos;t answer just now; showing the record as read at {asOfLabel(cache.asOf)}.
    </p>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="mt-2 border-l-2 border-critical bg-[#fbecec] px-3 py-1.5 text-[12px] text-critical-ink">
      {error}
    </p>
  );
}

/** Segmented control for filters: one row, quiet, the active option inked. */
export function Segmented<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex border border-rule-strong">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => props.onChange(o.value)}
          className={`touch-btn px-2.5 py-1 text-[12px] transition-colors ${props.value === o.value ? "bg-ink text-paper" : "text-ink-2 hover:bg-sunken"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
