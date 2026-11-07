"use client";

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import { Burger, Drawer, DrawerLink } from "../mobile/Drawer";
import type { StatusResponse } from "./api";
import { short } from "./api";

/**
 * Shared top bar for the terminal and the pick journal (sits on the dark masthead).
 * ≥ 901px: brand, tabs and `right` in one row. ≤ 900px: brand + `mobileRight` + burger, the
 * tabs as a segmented row underneath, `mobileBar` under that, and `drawer` inside the menu.
 */
export function AppHeader({
  active,
  right,
  mobileRight,
  mobileBar,
  drawer,
}: {
  active: "terminal" | "picks";
  right?: ReactNode;
  mobileRight?: ReactNode;
  mobileBar?: ReactNode;
  drawer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const tab = (href: string, label: string, on: boolean) => (
    <Link
      href={href}
      className={`border-b-2 py-4 text-[14px] transition-colors ${on ? "border-paper text-paper" : "border-transparent text-paper/55 hover:text-paper"}`}
    >
      {label}
    </Link>
  );
  const seg = (href: string, label: string, on: boolean) => (
    <Link
      href={href}
      aria-current={on ? "page" : undefined}
      className={`touch-btn flex items-center justify-center text-[14px] transition-colors ${on ? "bg-paper font-medium text-ink" : "text-paper/70 hover:text-paper"}`}
    >
      {label}
    </Link>
  );
  return (
    <div className="relative z-10 border-b border-paper/10">
      <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-4 px-4 min-[901px]:h-auto min-[901px]:gap-6 min-[901px]:px-6">
        <div className="flex items-center gap-8">
          <Link href="/" className="group flex items-baseline gap-2" title="Back to the landing page">
            <span className="font-serif text-[22px] leading-none font-semibold tracking-tight text-paper">Calibro</span>
            <span className="inline-block h-1.5 w-1.5 translate-y-[-2px] bg-[#e0663c]" aria-hidden />
          </Link>
          <nav className="hidden gap-6 min-[901px]:flex">
            {tab("/app", "Terminal", active === "terminal")}
            {tab("/app/picks", "Pick journal", active === "picks")}
          </nav>
        </div>
        <div className="hidden min-[901px]:block">{right}</div>
        <div className="flex items-center gap-3 min-[901px]:hidden">
          {mobileRight}
          <Burger open={open} onToggle={() => setOpen((o) => !o)} />
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t border-paper/10 px-4 py-3 min-[901px]:hidden">
        <nav className="grid grid-cols-2 border border-paper/20" aria-label="App sections">
          {seg("/app", "Terminal", active === "terminal")}
          {seg("/app/picks", "Pick journal", active === "picks")}
        </nav>
        {mobileBar}
      </div>
      <Drawer
        open={open}
        onClose={close}
        footer={
          <Link href="/" className="touch-btn flex items-center justify-center border border-paper/25 px-5 py-2.5 text-[14px] text-paper/85">
            ← Back to the landing page
          </Link>
        }
      >
        <DrawerLink href="/app" active={active === "terminal"}>
          Terminal
        </DrawerLink>
        <DrawerLink href="/app/picks" active={active === "picks"}>
          Pick journal
        </DrawerLink>
        {drawer?.(close)}
      </Drawer>
    </div>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-paper/45">{label} </span>
      <span className="font-mono text-paper/85 tabular-nums">{children}</span>
    </span>
  );
}

const Sep = () => <span className="text-paper/20">/</span>;

/** Dark, ledger-ruled band holding the header, status strip and page title. */
export function Masthead({ children }: { children: ReactNode }) {
  return <div className="ledger-dark grain grain-light relative text-paper [--margin:12px]">{children}</div>;
}

export function PageTitle({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="relative z-10 mx-auto max-w-[1440px] px-4 pt-6 pb-10 min-[901px]:px-6 min-[901px]:pt-10 min-[901px]:pb-12">
      <h1 className="rise font-serif text-[34px] leading-tight font-medium tracking-tight text-paper min-[901px]:text-[44px]">{title}</h1>
      <p className="rise mt-2 max-w-3xl text-[14px] leading-relaxed text-paper/70 min-[901px]:text-[15px]" style={{ animationDelay: "80ms" }}>
        {children}
      </p>
    </div>
  );
}

function LiveMode({ mode }: { mode: "LIVE_MAINNET" | "UNCONFIGURED" | undefined }) {
  const on = mode === "LIVE_MAINNET";
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-paper/80">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${on ? "live-dot bg-[#4cc26a]" : mode ? "bg-[#fab219]" : "bg-paper/40"}`} />
      {on ? "Sui Mainnet" : mode ? "Not configured" : "Connecting…"}
    </span>
  );
}

export function StatusRibbon({ status, onOpenDrawer }: { status: StatusResponse | null; onOpenDrawer: () => void }) {
  const cp = status?.tatum.checkpoint;
  const rate = status?.tatum.suiRate;
  const health = status?.walrus.health;
  const inv = status?.walrus.inventory;
  const total = inv?.ok ? inv.value.total : null;
  const live = status?.mode.mode === "LIVE_MAINNET";
  const balances = status?.payments.payerBalances;
  const sui = balances?.ok ? balances.value.find((b) => b.coinType.endsWith("::sui::SUI")) : undefined;

  const checkpoint = cp?.ok ? Number(cp.value).toLocaleString() : status ? "unavailable" : "…";
  const usdRate = rate?.ok ? `$${rate.value.usdPrice.toFixed(4)}` : status ? "unavailable" : "…";
  const relayer = health?.ok ? `${health.value.status}${health.value.write_ready ? ", write-ready" : ""}` : status ? "unreachable" : "…";
  const wallet = status?.payments.payerAddress ? (
    <>
      {short(status.payments.payerAddress)}
      {balances?.ok && ` · ${sui ? (Number(sui.totalBalance) / 1e9).toFixed(3) : "0"} SUI`}
    </>
  ) : (
    (status?.payments.payerError ?? "…")
  );
  const inventoryLabel = total === null ? "Memory inventory" : `${total} memories on Walrus`;

  return (
    <>
      <AppHeader
        active="terminal"
        right={
          <div className="flex items-center gap-5">
            <LiveMode mode={status?.mode.mode} />
            <button
              type="button"
              onClick={onOpenDrawer}
              className="text-[13px] text-paper underline decoration-paper/30 underline-offset-4 transition-colors hover:decoration-paper"
              title="Walk the Walrus Memory inventory"
            >
              {inventoryLabel}
            </button>
          </div>
        }
        mobileRight={<LiveMode mode={status?.mode.mode} />}
        drawer={(close) => (
          <>
            <button
              type="button"
              onClick={() => {
                close();
                onOpenDrawer();
              }}
              className="flex min-h-12 w-full items-center justify-between border-b border-paper/10 text-left text-[17px] text-paper/75 hover:text-paper"
            >
              {inventoryLabel}
              <span className="text-paper/35">→</span>
            </button>
            <p className="pt-6 pb-2 text-[12px] tracking-wide text-paper/40">Live status</p>
            <dl className="divide-y divide-paper/10 text-[13px]">
              {(
                [
                  ["Sui checkpoint", checkpoint],
                  ["SUI/USD via Tatum", usdRate],
                  ["Walrus relayer", relayer],
                  ["Agent wallet", wallet],
                ] as Array<[string, ReactNode]>
              ).map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-4 py-2.5">
                  <dt className="shrink-0 text-paper/45">{k}</dt>
                  <dd className="min-w-0 text-right font-mono break-words text-paper/85 tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      />
      <div className="relative z-10 hidden border-b border-paper/10 min-[901px]:block">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2 text-[12px]">
          <Item label="Sui checkpoint">{checkpoint}</Item>
          <Sep />
          <Item label="SUI/USD">{usdRate}</Item>
          <span className="text-paper/35">via Tatum</span>
          <Sep />
          <Item label="Walrus relayer">{relayer}</Item>
          <Sep />
          <Item label="Agent wallet">{wallet}</Item>
        </div>
      </div>
      {status && !live && (
        <div className="relative z-10 border-b border-[#ecd9a8] bg-[#fbf3df] px-4 py-2 text-[12px] text-warning-ink min-[901px]:px-6">
          Not connected to Mainnet: {status.mode.missing.join(", ")} missing. Markets and prices are live; nothing can be evaluated, paid or written until the
          keys are set.
        </div>
      )}
      {status?.replayLedger.error && (
        <div className="relative z-10 border-b border-[#ecd9a8] bg-[#fbf3df] px-4 py-2 text-[12px] text-warning-ink min-[901px]:px-6">{status.replayLedger.error}</div>
      )}
    </>
  );
}
