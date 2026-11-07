"use client";

import { useCallback, useEffect, useState } from "react";
import type { MarketOpportunity } from "@/lib/types/calibro";
import {
  adminToken,
  api,
  type AuditResponse,
  type EvaluateResponse,
  type MarketFeed,
  type SettleResponse,
  type StatusResponse,
  type TapeEvent,
} from "./api";
import { CalibrationPanel } from "./CalibrationPanel";
import { DislocationMatrix } from "./DislocationMatrix";
import { LearningTimeline } from "./LearningTimeline";
import { PaymentTape } from "./PaymentTape";
import { RecallComparator } from "./RecallComparator";
import { AppSections, Masthead, PageTitle, StatusStrip, TerminalHeader } from "./StatusRibbon";
import { ErrorLine } from "./ui";
import { useLoad } from "./useLoad";
import { WalrusDrawer } from "./WalrusDrawer";

export function Terminal() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [feed, setFeed] = useState<MarketFeed | null>(null);
  const calibration = useLoad(() => api.calibration());
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [drawer, setDrawer] = useState(false);

  const [evalRes, setEvalRes] = useState<EvaluateResponse | null>(null);
  const [locked, setLocked] = useState<MarketOpportunity | null>(null);
  const [tape, setTape] = useState<TapeEvent[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [lastSettle, setLastSettle] = useState<SettleResponse | null>(null);
  const [timelineKey, setTimelineKey] = useState(0);

  // Operator = this deployment needs no token (local dev) or this browser holds one.
  const [hasToken, setHasToken] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  useEffect(() => setHasToken(Boolean(adminToken.get())), []);
  const canOperate = hasToken || status?.operator?.tokenRequired === false;

  const refreshStatus = useCallback(() => api.status().then(setStatus).catch(() => undefined), []);

  useEffect(() => {
    refreshStatus();
    api.markets().then(setFeed).catch(() => undefined);
    const t = setInterval(refreshStatus, 30_000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  const openDrawer = useCallback(() => {
    setDrawer(true);
    setAuditLoading(true);
    setAuditError(null);
    api
      .audit()
      .then(setAudit)
      .catch((e: Error) => setAuditError(e.message))
      .finally(() => setAuditLoading(false));
  }, []);

  const evaluate = useCallback(
    async (m: MarketOpportunity) => {
      setEvalError(null);
      setLastSettle(null);
      setSettleError(null);
      // Visitors on an upcoming game: explain instead of failing (it would spend real SUI).
      if (!canOperate && m.source !== "HISTORICAL") {
        setEvalRes(null);
        setLocked(m);
        return;
      }
      setLocked(null);
      setBusyId(m.marketId);
      try {
        const res = canOperate ? await api.evaluate(m.marketId) : await api.preview(m.marketId);
        setEvalRes(res);
        if (!res.preview) setTape((prev) => [...prev, ...res.tape].slice(-200));
        refreshStatus();
      } catch (e) {
        const msg = (e as Error).message;
        if (/x-calibro-admin|CALIBRO_ADMIN_TOKEN/.test(msg)) {
          adminToken.clear();
          setHasToken(false);
          setShowUnlock(true);
          setEvalError("That operator token wasn't accepted.");
        } else {
          setEvalError(msg);
        }
      } finally {
        setBusyId(null);
      }
    },
    [canOperate, refreshStatus]
  );

  const settle = useCallback(async () => {
    const m = evalRes?.evaluation.market;
    if (!m) return;
    setSettling(true);
    setSettleError(null);
    try {
      const res = await api.settle(m.marketId);
      setLastSettle(res);
      setTimelineKey((k) => k + 1);
      calibration.reload();
      refreshStatus();
    } catch (e) {
      setSettleError((e as Error).message);
    } finally {
      setSettling(false);
    }
  }, [evalRes, calibration, refreshStatus]);

  const settledIds = new Set(calibration.data?.settled.map((s) => s.marketId) ?? []);
  const openUnlock = useCallback(() => setShowUnlock(true), []);

  return (
    <div className="grain min-h-screen bg-paper text-ink">
      <TerminalHeader status={status} onOpenDrawer={openDrawer} />
      <Masthead>
        <AppSections active="terminal" />
        <StatusStrip status={status} />
        <PageTitle title="Terminal">
          Choose a market. Calibro recalls each source&apos;s record from Walrus Memory, pays over x402 only for the ones worth paying, and sizes a
          stake. Settle it once Polymarket resolves the game, and the record updates.
        </PageTitle>
      </Masthead>

      <main className="relative z-10 mx-auto -mt-6 flex max-w-[1440px] flex-col gap-4 px-3 pb-10 min-[901px]:gap-6 min-[901px]:px-6 min-[901px]:pb-12">
        <ErrorLine error={evalError} />
        {showUnlock && !hasToken && (
          <form
            className="rise flex flex-wrap items-center gap-2 border border-rule bg-surface px-4 py-3 text-[13px] text-ink-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!tokenDraft.trim()) return;
              adminToken.set(tokenDraft);
              setTokenDraft("");
              setHasToken(true);
              setShowUnlock(false);
              setEvalError(null);
              setSettleError(null);
            }}
          >
            <span>Operator access: live evaluations spend real SUI and write to Walrus. Token:</span>
            <input
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              className="touch-btn min-w-0 flex-1 border border-rule-strong bg-paper px-2 py-1 font-mono text-[12px] text-ink sm:w-64 sm:flex-none"
              aria-label="Admin token"
            />
            <button type="submit" className="touch-btn bg-ink px-3 py-1 text-paper hover:bg-ink-2">
              Unlock
            </button>
            <button type="button" onClick={() => setShowUnlock(false)} className="touch-btn px-2 py-1 text-ink-3 hover:text-ink">
              Cancel
            </button>
          </form>
        )}

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <DislocationMatrix
            feed={feed}
            selectedId={evalRes?.evaluation.market.marketId ?? locked?.marketId ?? null}
            busyId={busyId}
            settledIds={settledIds}
            onEvaluate={evaluate}
            canOperate={canOperate}
          />
          <RecallComparator
            evaluation={evalRes?.evaluation ?? null}
            coldStart={evalRes?.coldStart ?? null}
            preview={Boolean(evalRes?.preview)}
            recorded={evalRes?.recorded ?? null}
            locked={locked}
            canOperate={canOperate}
            onOperatorAccess={openUnlock}
            busy={busyId !== null}
          />
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <PaymentTape tape={tape} />
          <CalibrationPanel
            data={calibration.data}
            loadError={calibration.error}
            retrying={calibration.retrying}
            onRetry={calibration.reload}
            evaluation={evalRes && !evalRes.preview ? evalRes.evaluation : null}
            canSettle={canOperate}
            settling={settling}
            settleError={settleError}
            lastSettle={lastSettle}
            onSettle={settle}
          />
        </div>

        <LearningTimeline refreshKey={timelineKey} />

        <footer className="flex max-w-3xl flex-col gap-2 border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
          <p>
            Markets, prices and results are real: Polymarket, DraftKings via ESPN, ESPN BPI, Kalshi, Manifold. Calibro&apos;s own sources are fixed,
            documented models over that data, and Calibro measures how good each one is. Stakes are recommendations, not placed bets. Every probability,
            Brier score, payment decision and stake is deterministic TypeScript; no language model is involved.
          </p>
          {!canOperate && !showUnlock && (
            <button type="button" onClick={openUnlock} className="link self-start text-[12px]">
              Operator access
            </button>
          )}
        </footer>
      </main>

      <WalrusDrawer open={drawer} onClose={() => setDrawer(false)} audit={audit} error={auditError} loading={auditLoading} onRetry={openDrawer} />
    </div>
  );
}
