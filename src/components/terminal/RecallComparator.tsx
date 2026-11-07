"use client";

import type { MarketEvaluation } from "./api";
import { SPECIALIST_LABEL, pct, usd } from "./api";
import { CountUp } from "../motion/CountUp";
import { Badge, Empty, Panel } from "./ui";

/** One agent's decision: which sources it paid, how it weighted them, what it would do. */
function Side({ title, note, ev, unavailable }: { title: string; note: string; ev: MarketEvaluation; unavailable: Set<string> }) {
  const t = ev.thesis;
  const spentSui = ev.slate.spentSui;
  const savedSui = t.signalsVetoed.reduce((acc, v) => acc + Number(v.savedFeeSui), 0);
  const leg = ev.chosenLeg;
  const take = t.recommendedAction === "TAKE_EDGE";

  return (
    <div className="flex min-w-0 flex-col">
      <h3 className="font-serif text-[17px] font-medium text-ink">{title}</h3>
      <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{note}</p>

      <div className="mt-4 flex items-baseline gap-3 border-y border-rule py-3">
        <span className="font-serif text-[40px] leading-none text-ink tabular-nums">
          <CountUp value={t.calibroCalibratedProb * 100} decimals={1} duration={900} />%
        </span>
        <span className="text-[12px] leading-snug text-ink-3">
          {take && leg ? (
            <>
              <span className="text-ink">
                {t.betSide} {t.betVenue === "ONCHAIN" ? "on Polymarket" : "at the book"}, {usd(t.recommendedStakeUsd, 0)}
              </span>
              <br />
              edge {pct(leg.decision.netEdge)} at {leg.decision.decimalOdds}
            </>
          ) : (
            <>
              <span className="text-ink">Pass</span>
              <br />
              {leg ? `best edge ${pct(leg.decision.netEdge)}, below the bar` : "no signal bought"}
            </>
          )}
        </span>
      </div>

      <table className="mt-3 w-full text-[12px]">
        <tbody>
          {ev.gates.map((g) => {
            const used = t.signalsUsed.find((s) => s.specialistId === g.specialistId);
            const vetoed = g.decision === "VETO_PAYMENT";
            const na = !used && !vetoed && unavailable.has(g.specialistId);
            return (
              <tr key={g.specialistId} className="align-top" title={vetoed ? g.reason : undefined}>
                <td className="py-1.5 pr-2 text-ink-2">{SPECIALIST_LABEL[g.specialistId]}</td>
                <td className="w-[46%] py-1.5">
                  {vetoed ? (
                    <Badge tone="critical">Refused · Brier {g.recalledBrierScore.toFixed(3)}</Badge>
                  ) : used ? (
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 bg-rule">
                        <div className="h-1.5 bg-ink-2" style={{ width: `${Math.max(3, used.weight * 100)}%` }} aria-label={`weight ${used.weight.toFixed(2)}`} />
                      </div>
                      <span className="w-9 text-right font-mono text-[11px] text-ink-3 tabular-nums">{(used.weight * 100).toFixed(0)}%</span>
                    </div>
                  ) : (
                    <span className="text-ink-4">{na ? "no data, not charged" : "not acquired"}</span>
                  )}
                </td>
                <td className="py-1.5 pl-2 text-right font-mono text-[11px] whitespace-nowrap text-ink-3 tabular-nums">
                  {used ? `${pct(used.rawProbability, 0)} → ${pct(used.calibratedProbability, 0)}` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="mt-3 border-t border-rule pt-2 text-[12px] text-ink-3">
        Paid <span className="font-mono text-ink-2">{spentSui.toFixed(3)} SUI</span> for {t.signalsUsed.length} signal{t.signalsUsed.length === 1 ? "" : "s"}
        {savedSui > 0 && (
          <>
            , refused <span className="font-mono text-ink-2">{savedSui.toFixed(3)} SUI</span>
          </>
        )}
        . Equal-weight average {pct(t.naiveEqualWeightProb)}.
      </p>
    </div>
  );
}

export function RecallComparator({ evaluation, coldStart }: { evaluation: MarketEvaluation | null; coldStart: MarketEvaluation | null }) {
  const gated = evaluation?.gates.map((g) => g.specialistId) ?? [];
  const recalled = evaluation ? gated.filter((id) => evaluation.context.calibrationSources[id] === "WALRUS_RECALL").length : 0;
  const unavailable = new Set((evaluation?.acquisitionErrors ?? []).filter((e) => /has no signal/.test(e.error)).map((e) => e.specialistId));
  const failed = (evaluation?.acquisitionErrors ?? []).filter((e) => !/has no signal/.test(e.error));

  return (
    <Panel
      delay={80}
      title="Forecast"
      kicker="The same market, decided with no memory and with Calibro's recalled record"
      right={evaluation && <span className="text-[12px] text-ink-3">{recalled} of {gated.length} records recalled from Walrus</span>}
    >
      {!evaluation || !coldStart ? (
        <Empty>
          <span>
            Choose a market and press <span className="text-ink">Evaluate</span>.
            <br />
            You&apos;ll see what an agent with no memory would do next to what Calibro does with its record.
          </span>
        </Empty>
      ) : (
        <>
          <div className="mb-4">
            <p className="font-serif text-[20px] leading-snug text-ink">{evaluation.market.title}</p>
            <p className="text-[12px] text-ink-3">{evaluation.market.subtitle}</p>
            {evaluation.market.alerts?.map((a) => (
              <p key={a.kind} className="mt-1 text-[12px] text-warning-ink">
                ▲ {a.detail}
              </p>
            ))}
          </div>
          <div key={evaluation.market.marketId} className="grid gap-8 md:grid-cols-2 md:gap-0 md:divide-x md:divide-rule">
            <div className="rise md:pr-6">
              <Side
                title="Without memory"
                note="Flat priors: pays every source, weights them equally. Computed for comparison; not paid, not stored."
                ev={coldStart}
                unavailable={unavailable}
              />
            </div>
            <div className="rise md:pl-6" style={{ animationDelay: "160ms" }}>
              <Side
                title="With Calibro's record"
                note={`Recalled from Walrus Memory: ${recalled} source records and the ${evaluation.context.mandateSource === "WALRUS_RECALL" ? "stored" : "default"} risk mandate.`}
                ev={evaluation}
                unavailable={unavailable}
              />
            </div>
          </div>
          {failed.length > 0 && (
            <div className="mt-4 border-l-2 border-serious bg-[#fbeee7] px-3 py-2 text-[12px] text-serious-ink">
              {failed.map((e) => (
                <p key={e.specialistId}>
                  {SPECIALIST_LABEL[e.specialistId]}: {e.error}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
