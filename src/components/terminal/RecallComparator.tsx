"use client";

import type { MarketOpportunity } from "@/lib/types/calibro";
import type { MarketEvaluation, RecordGame } from "./api";
import { SPECIALIST_LABEL, pct, short, suiscanTx, usd, walruscanBlob } from "./api";
import { CountUp } from "../motion/CountUp";
import { Badge, Button, Empty, Panel, Skeleton } from "./ui";

/** One agent's decision: which sources it paid, how it weighted them, what it would do. */
function Side({ title, note, ev, unavailable, preview }: { title: string; note: string; ev: MarketEvaluation; unavailable: Set<string>; preview?: boolean }) {
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
        {preview ? "Would pay" : "Paid"} <span className="font-mono text-ink-2">{spentSui.toFixed(3)} SUI</span> for {t.signalsUsed.length} signal
        {t.signalsUsed.length === 1 ? "" : "s"}
        {savedSui > 0 && (
          <>
            , {preview ? "would refuse" : "refused"} <span className="font-mono text-ink-2">{savedSui.toFixed(3)} SUI</span>
          </>
        )}
        . Equal-weight average {pct(t.naiveEqualWeightProb)}.
      </p>
    </div>
  );
}

/** What Calibro actually did on this game on Mainnet, read from its post-mortem on Walrus. */
function Recorded({ g }: { g: RecordGame }) {
  return (
    <div className="mt-5 border-l-2 border-ink bg-sunken px-4 py-3 text-[12px] leading-relaxed text-ink-2">
      <p className="text-[13px] text-ink">
        On Mainnet, Calibro forecast <span className="font-mono">{pct(g.calibroProb)}</span> against Polymarket&apos;s{" "}
        <span className="font-mono">{pct(g.marketProb)}</span>; {g.outcome === 1 ? "YES" : "NO"} won, Brier{" "}
        <span className="font-mono">{g.calibroBrier.toFixed(3)}</span>.
      </p>
      <p className="mt-1">
        Paid:{" "}
        {g.paid.length === 0
          ? "nothing"
          : g.paid.map((p, i) => (
              <span key={p.specialistId}>
                {i > 0 && ", "}
                {SPECIALIST_LABEL[p.specialistId as keyof typeof SPECIALIST_LABEL] ?? p.specialistId}
                {p.txDigest && (
                  <>
                    {" "}
                    <a className="link font-mono text-[11px]" href={suiscanTx(p.txDigest)} target="_blank" rel="noreferrer">
                      {short(p.txDigest, 6, 4)}
                    </a>
                  </>
                )}
              </span>
            ))}
        .
        {g.refused.length > 0 && (
          <> Refused: {g.refused.map((r) => SPECIALIST_LABEL[r.specialistId as keyof typeof SPECIALIST_LABEL] ?? r.specialistId).join(", ")}.</>
        )}
      </p>
      <p className="mt-1">
        Post-mortem on Walrus{" "}
        <a className="link font-mono text-[11px]" href={walruscanBlob(g.postMortemBlobId)} target="_blank" rel="noreferrer">
          {short(g.postMortemBlobId, 8, 6)}
        </a>
        {" · "}
        <a className="link" href="/app/record">
          every game on the Record tab
        </a>
      </p>
    </div>
  );
}

export function RecallComparator({
  evaluation,
  coldStart,
  preview,
  recorded,
  locked,
  canOperate,
  onOperatorAccess,
  busy,
}: {
  evaluation: MarketEvaluation | null;
  coldStart: MarketEvaluation | null;
  preview?: boolean;
  recorded?: RecordGame | null;
  locked?: MarketOpportunity | null;
  canOperate?: boolean;
  onOperatorAccess?: () => void;
  /** A preview or evaluation is running */
  busy?: boolean;
}) {
  const gated = evaluation?.gates.map((g) => g.specialistId) ?? [];
  const recalled = evaluation ? gated.filter((id) => evaluation.context.calibrationSources[id] === "WALRUS_RECALL").length : 0;
  const unavailable = new Set((evaluation?.acquisitionErrors ?? []).filter((e) => /has no signal|no counterfactual signal/.test(e.error)).map((e) => e.specialistId));
  const failed = (evaluation?.acquisitionErrors ?? []).filter((e) => !/has no signal|no counterfactual signal/.test(e.error));

  return (
    <Panel
      delay={80}
      title="Forecast"
      kicker="The same market, decided with no memory and with Calibro's recalled record"
      right={
        evaluation &&
        (preview ? (
          <Badge tone="info" title="Calibro's real record from Walrus decided over signals computed in-process. No SUI was spent and nothing was written.">
            Preview · nothing paid or written
          </Badge>
        ) : (
          <span className="text-[12px] text-ink-3">
            {recalled} of {gated.length} records recalled from Walrus
          </span>
        ))
      }
    >
      {busy ? (
        <div className="py-2" aria-live="polite">
          <p className="mb-3 text-[13px] text-ink-3">
            {canOperate
              ? "Recalling Calibro's record from Walrus, buying the signals worth paying for over x402 on Sui, verifying each payment through Tatum…"
              : "Recalling Calibro's record from Walrus and pricing the game as it stood before kickoff…"}
          </p>
          <Skeleton rows={6} />
        </div>
      ) : locked ? (
        <div className="px-2 py-6 text-[13px] leading-relaxed text-ink-2">
          <p className="font-serif text-[20px] leading-snug text-ink">{locked.title}</p>
          <p className="mt-3 max-w-xl">
            This game hasn&apos;t started, so evaluating it means buying live signals with real SUI and writing the thesis to Walrus. That&apos;s done
            by the operator. Two other ways in:
          </p>
          <ul className="mt-2 max-w-xl list-disc space-y-1 pl-5 text-ink-3">
            <li>
              Filter <span className="text-ink">Resolved</span> and press <span className="text-ink">Preview</span> on a finished game: Calibro&apos;s real
              record decides, nothing is paid or written.
            </li>
            <li>
              Agents can buy this forecast for 0.01 SUI over x402:{" "}
              <span className="font-mono text-[12px] text-ink">GET /api/forecast?marketId={locked.marketId}</span>
            </li>
          </ul>
          {onOperatorAccess && (
            <div className="mt-4">
              <Button variant="ghost" onClick={onOperatorAccess}>
                Operator access
              </Button>
            </div>
          )}
        </div>
      ) : !evaluation || !coldStart ? (
        <Empty>
          {canOperate ? (
            <span>
              Choose a market and press <span className="text-ink">Evaluate</span>.
              <br />
              You&apos;ll see what an agent with no memory would do next to what Calibro does with its record.
            </span>
          ) : (
            <span>
              Choose a resolved game and press <span className="text-ink">Preview</span>.
              <br />
              Calibro&apos;s real record from Walrus decides; nothing is paid or written. Then compare it with an agent that has no memory.
            </span>
          )}
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
                preview
              />
            </div>
            <div className="rise md:pl-6" style={{ animationDelay: "160ms" }}>
              <Side
                title="With Calibro's record"
                note={
                  preview
                    ? `Recalled from Walrus Memory: ${recalled} source records and the ${evaluation.context.mandateSource === "WALRUS_RECALL" ? "stored" : "default"} risk mandate, as they stand today${recorded ? " (they already include this game)" : ""}. Signals computed in-process; nothing paid or written.`
                    : `Recalled from Walrus Memory: ${recalled} source records and the ${evaluation.context.mandateSource === "WALRUS_RECALL" ? "stored" : "default"} risk mandate.`
                }
                ev={evaluation}
                unavailable={unavailable}
                preview={preview}
              />
            </div>
          </div>
          {preview && recorded && <Recorded g={recorded} />}
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
