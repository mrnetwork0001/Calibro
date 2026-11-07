"use client";

import { useCallback, useEffect, useState } from "react";
import type { MarketOpportunity } from "@/lib/types/calibro";
import {
  adminToken,
  api,
  type AuditResponse,
  type CalibrationResponse,
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
import { Masthead, PageTitle, StatusRibbon } from "./StatusRibbon";
import { Button, ErrorLine } from "./ui";
import { WalrusDrawer } from "./WalrusDrawer";

export function Terminal() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [feed, setFeed] = useState<MarketFeed | null>(null);
  const [calibration, setCalibration] = useState<CalibrationResponse | null>(null);
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [drawer, setDrawer] = useState(false);

  const [evalRes, setEvalRes] = useState<EvaluateResponse | null>(null);
  const [tape, setTape] = useState<TapeEvent[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  const [settling, setSettling] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [lastSettle, setLastSettle] = useState<SettleResponse | null>(null);
  const [timelineKey, setTimelineKey] = useState(0);

  const [tokenDraft, setTokenDraft] = useState("");
  const needsToken = /x-calibro-admin|CALIBRO_ADMIN_TOKEN/.test(`${evalError ?? ""} ${settleError ?? ""}`);

  const refreshStatus = useCallback(() => api.status().then(setStatus).catch(() => undefined), []);
  const refreshCalibration = useCallback(() => api.calibration().then(setCalibration).catch(() => undefined), []);

  useEffect(() => {
    refreshStatus();
    refreshCalibration();
    api.markets().then(setFeed).catch(() => undefined);
    const t = setInterval(refreshStatus, 30_000);
    return () => clearInterval(t);
  }, [refreshStatus, refreshCalibration]);

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

  const evaluate = useCallback(async (m: MarketOpportunity) => {
    setBusyId(m.marketId);
    setEvalError(null);
    setLastSettle(null);
    setSettleError(null);
    try {
      const res = await api.evaluate(m.marketId);
      setEvalRes(res);
      setTape((prev) => [...prev, ...res.tape].slice(-200));
      refreshStatus();
    } catch (e) {
      setEvalError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }, [refreshStatus]);

  const settle = useCallback(async () => {
    const m = evalRes?.evaluation.market;
    if (!m) return;
    setSettling(true);
    setSettleError(null);
    try {
      const res = await api.settle(m.marketId);
      setLastSettle(res);
      setTimelineKey((k) => k + 1);
      refreshCalibration();
      refreshStatus();
    } catch (e) {
      setSettleError((e as Error).message);
    } finally {
      setSettling(false);
    }
  }, [evalRes, refreshCalibration, refreshStatus]);

  const settledIds = new Set(calibration?.settled.map((s) => s.marketId) ?? []);

  return (
    <div className="grain min-h-screen bg-paper text-ink">
      <Masthead>
        <StatusRibbon status={status} onOpenDrawer={openDrawer} />
        <PageTitle title="Terminal">
          Choose a market. Calibro recalls each source&apos;s record from Walrus Memory, pays over x402 only for the ones worth paying, and sizes a
          stake. Settle it once Polymarket resolves the game, and the record updates.
        </PageTitle>
      </Masthead>

      <main className="relative z-10 mx-auto -mt-6 flex max-w-[1440px] flex-col gap-4 px-3 pb-10 min-[901px]:gap-6 min-[901px]:px-6 min-[901px]:pb-12">
        <ErrorLine error={evalError} />
        {needsToken && (
          <form
            className="flex flex-wrap items-center gap-2 border border-rule bg-surface px-4 py-3 text-[13px] text-ink-2"
            onSubmit={(e) => {
              e.preventDefault();
              adminToken.set(tokenDraft);
              setTokenDraft("");
              setEvalError(null);
              setSettleError(null);
            }}
          >
            <span>Evaluating spends real SUI and writes to Walrus, so it&apos;s limited to the operator. Admin token:</span>
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
          </form>
        )}

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <DislocationMatrix feed={feed} selectedId={evalRes?.evaluation.market.marketId ?? null} busyId={busyId} settledIds={settledIds} onEvaluate={evaluate} />
          <RecallComparator evaluation={evalRes?.evaluation ?? null} coldStart={evalRes?.coldStart ?? null} />
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <PaymentTape tape={tape} />
          <CalibrationPanel
            data={calibration}
            evaluation={evalRes?.evaluation ?? null}
            settling={settling}
            settleError={settleError}
            lastSettle={lastSettle}
            onSettle={settle}
          />
        </div>

        <LearningTimeline refreshKey={timelineKey} />

        <footer className="max-w-3xl border-t border-rule pt-4 text-[12px] leading-relaxed text-ink-3">
          Markets, prices and results are real: Polymarket, DraftKings via ESPN, ESPN BPI, Kalshi, Manifold. Calibro&apos;s own sources are fixed, documented
          models over that data, and Calibro measures how good each one is. Stakes are recommendations, not placed bets. Every probability, Brier score,
          payment decision and stake is deterministic TypeScript; no language model is involved.
        </footer>
      </main>

      <WalrusDrawer open={drawer} onClose={() => setDrawer(false)} audit={audit} error={auditError} loading={auditLoading} />
    </div>
  );
}
