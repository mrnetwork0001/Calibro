"use client";

import { useMemo, useState } from "react";
import type { MarketDomain, MarketOpportunity } from "@/lib/types/calibro";
import type { MarketFeed } from "./api";
import { DOMAIN_LABEL, pct } from "./api";
import { Button, Empty, Panel, Segmented, Skeleton } from "./ui";

const DOMAINS: Array<MarketDomain | "ALL"> = ["ALL", "NBA", "EPL", "UFC", "CRYPTO_MACRO"];

export function DislocationMatrix(props: {
  feed: MarketFeed | null;
  selectedId: string | null;
  busyId: string | null;
  settledIds: Set<string>;
  onEvaluate: (m: MarketOpportunity) => void;
}) {
  const [domain, setDomain] = useState<MarketDomain | "ALL">("ALL");
  const [source, setSource] = useState<"ALL" | "HISTORICAL" | "LIVE">("ALL");
  const [onlyAlerts, setOnlyAlerts] = useState(false);

  const rows = useMemo(
    () =>
      (props.feed?.markets ?? []).filter(
        (m) =>
          (domain === "ALL" || m.domain === domain) &&
          (source === "ALL" || m.source === source) &&
          (!onlyAlerts || (m.alerts?.length ?? 0) > 0)
      ),
    [props.feed, domain, source, onlyAlerts]
  );

  const poly = props.feed?.sources.polymarket;
  const book = props.feed?.sources.sportsbook;

  const alertCount = props.feed ? props.feed.markets.filter((m) => (m.alerts?.length ?? 0) > 0).length : 0;
  return (
    <Panel
      title="Markets"
      kicker={
        poly?.ok
          ? `Polymarket against the sportsbook line · ${poly.live} upcoming, ${poly.resolved} resolved${book?.oddsApiEnabled ? " · Pinnacle via The Odds API" : ""}`
          : poly
            ? "Polymarket unavailable"
            : "Loading Polymarket…"
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          value={domain}
          onChange={setDomain}
          options={DOMAINS.map((d) => ({ value: d, label: d === "ALL" ? "All leagues" : DOMAIN_LABEL[d] }))}
        />
        <Segmented
          value={source}
          onChange={setSource}
          options={[
            { value: "ALL", label: "All" },
            { value: "LIVE", label: "Upcoming" },
            { value: "HISTORICAL", label: "Resolved" },
          ]}
        />
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-2" title="Venues 3+ points apart, or sources split on the favourite">
          <input type="checkbox" checked={onlyAlerts} onChange={(e) => setOnlyAlerts(e.target.checked)} className="accent-ink" />
          Disagreements only <span className="font-mono text-ink-3">({alertCount})</span>
        </label>
      </div>

      {!props.feed ? (
        <Skeleton rows={7} />
      ) : rows.length === 0 ? (
        <Empty>{props.feed.sources.polymarket.ok ? "No markets match these filters." : `Polymarket unavailable: ${props.feed.sources.polymarket.error ?? "unknown error"}`}</Empty>
      ) : (
        <div className="-mx-5 max-h-[520px] overflow-auto">
          <table className="w-full border-separate border-spacing-0 text-left text-[13px]">
            <thead className="sticky top-0 z-10 bg-surface text-[12px] text-ink-3">
              <tr>
                <th className="border-b border-rule py-2 pr-3 pl-5 font-normal">Market</th>
                <th className="border-b border-rule px-2 py-2 text-right font-normal sm:px-3">Book</th>
                <th className="border-b border-rule py-2 pr-5 pl-2 text-right font-normal sm:px-3"><span className="sm:hidden">Poly</span><span className="hidden sm:inline">Polymarket</span></th>
                <th className="hidden border-b border-rule px-3 py-2 text-right font-normal sm:table-cell">Gap</th>
                <th className="hidden border-b border-rule py-2 pr-5 pl-3 font-normal sm:table-cell">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const spread = m.bookImpliedProb === null ? null : m.onchainImpliedProb - m.bookImpliedProb;
                const selected = m.marketId === props.selectedId;
                const meta = [
                  DOMAIN_LABEL[m.domain],
                  `YES ${m.yesLabel ?? "YES"}`,
                  m.source === "HISTORICAL" ? "resolved, priced at start" : new Date(m.closesAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }),
                ];
                return (
                  <tr key={m.marketId} className={selected ? "bg-sunken" : "hover:bg-[#faf9f6]"}>
                    <td className={`border-b border-rule py-3 pr-3 pl-5 align-top ${selected ? "shadow-[inset_2px_0_0_var(--color-ink)]" : ""}`}>
                      <p className="leading-snug text-ink">
                        {m.sourceUrl ? (
                          <a href={m.sourceUrl} target="_blank" rel="noreferrer" className="hover:underline">
                            {m.title}
                          </a>
                        ) : (
                          m.title
                        )}
                      </p>
                      <p className="mt-0.5 text-[12px] text-ink-3">
                        {meta.join(" · ")}
                        {props.settledIds.has(m.marketId) && <span className="text-good-ink"> · settled</span>}
                      </p>
                      {m.alerts?.slice(0, 1).map((a) => (
                        <p key={a.kind} className="mt-1 text-[12px] text-warning-ink">
                          ▲ {a.detail}
                        </p>
                      ))}
                      {/* Phones: no action column, so Evaluate sits under the market. */}
                      <div className="mt-2 sm:hidden">
                        <Button
                          variant={selected ? "primary" : "ghost"}
                          busy={props.busyId === m.marketId}
                          disabled={props.busyId !== null}
                          onClick={() => props.onEvaluate(m)}
                        >
                          Evaluate
                        </Button>
                      </div>
                    </td>
                    <td className="border-b border-rule px-2 py-3 text-right align-top font-mono text-ink-2 tabular-nums sm:px-3">{pct(m.bookImpliedProb)}</td>
                    <td className="border-b border-rule py-3 pr-5 pl-2 text-right align-top font-mono text-ink tabular-nums sm:px-3">{pct(m.onchainImpliedProb)}</td>
                    <td className="hidden border-b border-rule px-3 py-3 text-right align-top font-mono tabular-nums sm:table-cell">
                      {spread === null ? (
                        <span className="text-ink-4">—</span>
                      ) : (
                        <span className="text-ink-2">
                          {spread >= 0 ? "+" : "−"}
                          {Math.abs(spread * 100).toFixed(1)}
                        </span>
                      )}
                    </td>
                    <td className="hidden border-b border-rule py-3 pr-5 pl-3 text-right align-top sm:table-cell">
                      <Button
                        variant={selected ? "primary" : "ghost"}
                        busy={props.busyId === m.marketId}
                        disabled={props.busyId !== null}
                        onClick={() => props.onEvaluate(m)}
                      >
                        Evaluate
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
