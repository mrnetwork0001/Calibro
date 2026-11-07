"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { MarketOpportunity } from "@/lib/types/calibro";

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

/**
 * A scrolling tape of upcoming games: Polymarket against the sportsbook, live.
 * Loaded in the browser from /api/markets so the page never waits on Polymarket.
 */
export function LiveTicker() {
  const [items, setItems] = useState<MarketOpportunity[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/markets", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((feed: { markets: MarketOpportunity[] }) => {
        if (live) setItems(feed.markets.filter((m) => m.source === "LIVE" && m.domain !== "CRYPTO_MACRO").slice(0, 16));
      })
      .catch(() => live && setItems([]));
    return () => {
      live = false;
    };
  }, []);

  if (!items) return <TickerShell note="Loading live prices…" />;
  if (items.length === 0) return <TickerShell note="No upcoming games listed right now." />;

  const row = (dup: boolean) => (
    <ul className="flex shrink-0 items-center" aria-hidden={dup}>
      {items.map((m) => {
        const gap = m.bookImpliedProb === null ? null : m.onchainImpliedProb - m.bookImpliedProb;
        return (
          <li key={`${m.marketId}-${dup}`} className="flex items-center gap-3 px-4 text-[13px] whitespace-nowrap sm:px-6">
            <span className="text-paper/40">{m.domain}</span>
            <span className="text-paper/90">{m.title.replace(/^Will (.+) win on .+\?$/, "$1 to win")}</span>
            <span className="font-mono text-paper tabular-nums">{pct(m.onchainImpliedProb)}</span>
            {gap !== null && (
              <span className={`text-[12px] ${Math.abs(gap) >= 0.03 ? "text-[#f0a24a]" : "text-paper/40"}`} title="De-vigged sportsbook price">
                book <span className="font-mono tabular-nums">{pct(m.bookImpliedProb!)}</span>
              </span>
            )}
            <span className="text-paper/15">/</span>
          </li>
        );
      })}
    </ul>
  );

  return (
    <TickerShell>
      <div className="marquee fade-in relative flex-1 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
        <div className="marquee-track" style={{ ["--marquee-duration" as string]: `${items.length * 5}s` }}>
          {row(false)}
          {row(true)}
        </div>
      </div>
    </TickerShell>
  );
}

export function TickerShell({ children, note }: { children?: ReactNode; note?: string }) {
  return (
    <div className="relative z-10 flex h-11 items-center border-b border-paper/10">
      <span className="flex h-full shrink-0 items-center gap-2 border-r border-paper/10 pr-3 pl-[24px] text-[12px] tracking-wide text-paper/70 sm:pr-5 sm:pl-[72px]">
        <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-[#4cc26a]" />
        <span className="sm:hidden">Live</span>
        <span className="hidden sm:inline">Upcoming on Polymarket</span>
      </span>
      {children ?? (note && <span className="truncate px-4 text-[12px] text-paper/40 sm:px-6">{note}</span>)}
    </div>
  );
}
