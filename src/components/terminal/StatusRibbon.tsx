"use client";

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";
import { Burger, Drawer, DrawerLink } from "../mobile/Drawer";
import { BrandMark } from "../brand/BrandMark";
import { SuiLogo } from "../brand/SuiLogo";
import type { StatusResponse } from "./api";
import { short } from "./api";

type Section = "terminal" | "picks" | "record";

/**
 * Shared top bar for the app pages, sticky at the top of the viewport. Render it as a
 * direct child of the page (outside the masthead) so it can stick for the whole scroll.
 * ≥ 901px: brand left, sections centred, `right` on the right. ≤ 900px: brand +
 * `mobileRight` + burger, with `drawer` content inside the menu.
 */
export function AppHeader({
  active,
  right,
  mobileRight,
  drawer,
}: {
  active: Section;
  right?: ReactNode;
  mobileRight?: ReactNode;
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
  return (
    <header className="sticky top-0 z-50 border-b border-paper/10 bg-ink text-paper">
      {/* Desktop: three columns, brand left, sections centred on the page, status right. */}
      <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between gap-4 px-4 min-[901px]:grid min-[901px]:h-auto min-[901px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] min-[901px]:gap-6 min-[901px]:px-6">
        <Link href="/" className="group flex items-center gap-2.5 justify-self-start" title="Back to the landing page">
          <BrandMark size={28} tone="dark" />
          <span className="font-serif text-[22px] leading-none font-semibold tracking-tight text-paper">Calibro</span>
        </Link>
        <nav className="hidden gap-8 justify-self-center min-[901px]:flex" aria-label="App sections">
          {tab("/app", "Terminal", active === "terminal")}
          {tab("/app/picks", "Pick journal", active === "picks")}
          {tab("/app/record", "Record", active === "record")}
        </nav>
        <div className="hidden min-w-0 justify-self-end min-[901px]:block">{right}</div>
        <div className="flex items-center gap-3 min-[901px]:hidden">
          {mobileRight}
          <Burger open={open} onToggle={() => setOpen((o) => !o)} />
        </div>
      </div>
      <Drawer
        open={open}
        onClose={close}
        footer={
          <Link href="/" className="touch-btn flex items-center justify-center border border-paper/25 px-5 py-2.5 text-[14px] text-paper/85">
            Back to the landing page
          </Link>
        }
      >
        <DrawerLink href="/app" active={active === "terminal"}>
          Terminal
        </DrawerLink>
        <DrawerLink href="/app/picks" active={active === "picks"}>
          Pick journal
        </DrawerLink>
        <DrawerLink href="/app/record" active={active === "record"}>
          Record
        </DrawerLink>
        {drawer?.(close)}
      </Drawer>
    </header>
  );
}

/**
 * ≤ 900px only: the sections as a segmented control, plus page-specific controls (the
 * wallet bar on the pick journal). Sits at the top of the masthead and scrolls with it;
 * the sticky bar's menu has the same links.
 */
export function AppSections({ active, children }: { active: Section; children?: ReactNode }) {
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
    <div className="relative z-10 flex flex-col gap-3 border-b border-paper/10 px-4 py-3 min-[901px]:hidden">
      <nav className="grid grid-cols-3 border border-paper/20" aria-label="App sections, mobile">
        {seg("/app", "Terminal", active === "terminal")}
        {seg("/app/picks", "Pick journal", active === "picks")}
        {seg("/app/record", "Record", active === "record")}
      </nav>
      {children}
    </div>
  );
}

type Health = "good" | "warn" | "bad" | "idle";
const DOT: Record<Health, string> = { good: "bg-[#4cc26a]", warn: "bg-[#fab219]", bad: "bg-[#e5484d]", idle: "bg-paper/30" };

/**
 * One reading in the status row: label and its source on top, the value below, a dot for
 * its health. Values link to Suiscan where there is something to verify.
 */
function Cell({ label, source, health, href, title, children }: { label: string; source: string; health: Health; href?: string; title?: string; children: ReactNode }) {
  // One fixed line box for every value, linked or not, so the row shares a baseline.
  const valueClass = "flex h-5 min-w-0 items-center gap-1.5 font-mono text-[13px] leading-5 text-paper/90 tabular-nums";
  return (
    <div className="min-w-0 px-5 py-3 first:pl-0" title={title}>
      <p className="truncate text-[11.5px] leading-4 text-paper/50">
        {label}
        <span className="text-paper/30"> · {source}</span>
      </p>
      <div className="mt-1.5 flex h-5 min-w-0 items-center gap-2">
        <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT[health]} ${health === "good" ? "live-dot" : ""}`} />
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className={`${valueClass} decoration-paper/30 underline-offset-4 hover:underline`}>
            {children}
          </a>
        ) : (
          <span className={valueClass}>{children}</span>
        )}
      </div>
    </div>
  );
}

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
    <span className="inline-flex items-center gap-2 text-[13px] text-paper/80" title={on ? "Connected to Sui Mainnet" : undefined}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${on ? "live-dot bg-[#4cc26a]" : mode ? "bg-[#fab219]" : "bg-paper/40"}`} />
      {on ? (
        <>
          <SuiLogo height={15} className="text-paper" />
          <span>Mainnet</span>
        </>
      ) : mode ? (
        "Not configured"
      ) : (
        "Connecting…"
      )}
    </span>
  );
}

/** Values shared by the terminal's header (menu drawer) and its status strip. */
function statusView(status: StatusResponse | null) {
  const cp = status?.tatum.checkpoint;
  const rate = status?.tatum.suiRate;
  const health = status?.walrus.health;
  const inv = status?.walrus.inventory;
  const total = inv?.ok ? inv.value.total : null;
  const live = status?.mode.mode === "LIVE_MAINNET";
  const balances = status?.payments.payerBalances;
  const sui = balances?.ok ? balances.value.find((b) => b.coinType.endsWith("::sui::SUI")) : undefined;
  const suiBalance = balances?.ok ? (sui ? Number(sui.totalBalance) / 1e9 : 0) : null;

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
  return { cp, rate, health, live, suiBalance, checkpoint, usdRate, relayer, wallet, inventoryLabel };
}

/** The terminal's sticky header: sections, network, memory inventory, live status in the menu. */
export function TerminalHeader({ status, onOpenDrawer }: { status: StatusResponse | null; onOpenDrawer: () => void }) {
  const { checkpoint, usdRate, relayer, wallet, inventoryLabel } = statusView(status);
  return (
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
  );
}

/** The terminal's live readings (desktop), plus configuration warnings. Inside the masthead. */
export function StatusStrip({ status }: { status: StatusResponse | null }) {
  const { cp, rate, health, live, suiBalance, checkpoint, usdRate, relayer } = statusView(status);
  return (
    <>
      <div className="relative z-10 hidden border-b border-paper/10 min-[901px]:block">
        <div className="mx-auto grid max-w-[1440px] grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.4fr)] divide-x divide-paper/10 px-6">
          <Cell
            label="Sui checkpoint"
            source="Tatum RPC"
            health={!status ? "idle" : cp?.ok ? "good" : "bad"}
            href={cp?.ok ? `https://suiscan.xyz/mainnet/checkpoint/${cp.value}` : undefined}
            title={!cp || cp.ok ? undefined : cp.error}
          >
            <span className="truncate">{checkpoint}</span>
          </Cell>
          <Cell label="SUI / USD" source="Tatum Data API" health={!status ? "idle" : rate?.ok ? "good" : "bad"} title={!rate || rate.ok ? undefined : rate.error}>
            <span className="truncate">{usdRate}</span>
          </Cell>
          <Cell
            label="Walrus Memory relayer"
            source="Mainnet"
            health={!status ? "idle" : health?.ok ? (health.value.write_ready ? "good" : "warn") : "bad"}
            title={!health || health.ok ? undefined : health.error}
          >
            <span className="truncate">{health?.ok ? `${health.value.status ?? "ok"}${health.value.write_ready ? " · write-ready" : " · read-only"}` : relayer}</span>
          </Cell>
          <Cell
            label="Agent wallet"
            source="pays for signals"
            health={!status ? "idle" : !status.payments.payerAddress ? "bad" : suiBalance !== null && suiBalance < 0.03 ? "warn" : "good"}
            href={status?.payments.payerAddress ? `https://suiscan.xyz/mainnet/account/${status.payments.payerAddress}` : undefined}
            title={suiBalance !== null && suiBalance < 0.03 ? "Low balance: top up before evaluating live markets" : (status?.payments.payerAddress ?? undefined)}
          >
            {status?.payments.payerAddress ? (
              <>
                <span className="truncate">{short(status.payments.payerAddress, 6, 4)}</span>
                {suiBalance !== null && <span className="shrink-0 text-paper/60">· {suiBalance.toFixed(3)} SUI</span>}
              </>
            ) : (
              <span className="truncate">{status?.payments.payerError ?? "…"}</span>
            )}
          </Cell>
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
