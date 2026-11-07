"use client";

import type { TapeEvent } from "./api";
import { SPECIALIST_LABEL, short, suiscanTx } from "./api";
import { Badge, Empty, Panel } from "./ui";

const KIND: Record<TapeEvent["kind"], { tone: "info" | "neutral" | "good" | "critical" | "serious"; label: string }> = {
  CHALLENGE_402: { tone: "info", label: "402" },
  PAID: { tone: "neutral", label: "Paid" },
  VERIFIED: { tone: "good", label: "Verified" },
  VETOED: { tone: "critical", label: "Vetoed" },
  ERROR: { tone: "serious", label: "Error" },
};

export function PaymentTape({ tape }: { tape: TapeEvent[] }) {
  const paidSui = tape
    .filter((e) => e.kind === "VERIFIED" && e.amountRaw)
    .reduce((acc, e) => acc + Number(e.amountRaw) / 1e9, 0);
  const savedSui = tape
    .filter((e) => e.kind === "VETOED" && e.amountRaw)
    .reduce((acc, e) => acc + Number(e.amountRaw) / 1e9, 0);

  return (
    <Panel
      delay={160}
      kicker="Every HTTP 402 challenge, Sui transfer, Tatum check and refusal, newest first"
      title="Payments"
      right={
        <span className="text-[12px] text-ink-3">
          paid <span className="font-mono text-ink-2 tabular-nums">{paidSui.toFixed(3)}</span> · refused{" "}
          <span className="font-mono text-ink-2 tabular-nums">{savedSui.toFixed(3)}</span> SUI
        </span>
      }
    >
      {tape.length === 0 ? (
        <Empty>Nothing paid yet this session. Evaluate a market and each payment appears here with its Sui transaction.</Empty>
      ) : (
        <ol className="-mx-5 flex max-h-[380px] flex-col overflow-auto text-[12px]">
          {[...tape].reverse().map((e, i) => {
            const k = KIND[e.kind];
            return (
              <li key={`${e.at}-${e.kind}-${e.specialistId}`} className="rise flex min-w-0 items-start gap-2 border-b border-rule px-5 py-1.5 sm:gap-3" style={{ animationDuration: "450ms" }}>
                <span className="hidden w-14 shrink-0 font-mono text-[11px] text-ink-3 tabular-nums sm:inline">{new Date(e.at).toLocaleTimeString([], { hour12: false })}</span>
                <span className="w-20 shrink-0">
                  <Badge tone={k.tone}>{k.label}</Badge>
                </span>
                <span className="w-24 shrink-0 truncate text-ink-2">{SPECIALIST_LABEL[e.specialistId]}</span>
                <span className="min-w-0 flex-1 truncate text-ink-3" title={e.detail}>
                  {e.txDigest ? (
                    <a href={suiscanTx(e.txDigest)} target="_blank" rel="noreferrer" className="link mr-1.5 font-mono text-[11px]">
                      {short(e.txDigest, 6, 4)}
                    </a>
                  ) : null}
                  {e.detail}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
