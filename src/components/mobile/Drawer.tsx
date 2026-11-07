"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Burger button that morphs into an ×. Shown only at ≤ 900px. */
export function Burger({ open, onToggle, label = "Open menu" }: { open: boolean; onToggle: () => void; label?: string }) {
  return (
    <button
      type="button"
      data-burger
      aria-label={open ? "Close menu" : label}
      aria-expanded={open}
      aria-controls="mobile-drawer"
      onClick={onToggle}
      className="burger inline-flex h-10 w-10 flex-col items-center justify-center gap-[4.5px] border border-paper/20 text-paper transition-colors hover:border-paper/50 min-[901px]:hidden"
    >
      <span />
      <span />
      <span />
    </button>
  );
}

/**
 * Left drawer (≤ 900px): dimmed backdrop, brand + Close head, closes on backdrop tap,
 * Esc, Close, and after any link tap. Locks page scroll while open. Portalled to <body> so a
 * transformed or backdrop-filtered ancestor (the sticky blurred header) can't clip it.
 */
export function Drawer({ open, onClose, children, footer }: { open: boolean; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // Close on any desktop-width resize so the drawer never lingers over the desktop layout.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 901px)");
    const onChange = () => mq.matches && onClose();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [onClose]);

  if (!mounted) return null;
  return createPortal(
    <>
      <button
        type="button"
        aria-label="Close menu"
        tabIndex={-1}
        data-drawer-backdrop
        data-open={open}
        onClick={onClose}
        className="drawer-backdrop fixed inset-0 z-[60] bg-black/55 min-[901px]:hidden"
      />
      <aside
        id="mobile-drawer"
        data-drawer
        data-open={open}
        aria-hidden={!open}
        inert={!open}
        role="dialog"
        aria-label="Menu"
        onClick={(e) => (e.target as HTMLElement).closest("a") && onClose()}
        className="drawer grain grain-light fixed inset-y-0 left-0 z-[70] flex h-[100dvh] w-[min(88vw,320px)] flex-col overflow-y-auto border-r border-paper/10 bg-ink text-paper min-[901px]:hidden"
      >
        <div className="relative z-10 flex h-14 shrink-0 items-center justify-between border-b border-paper/10 px-5">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="font-serif text-[22px] leading-none font-semibold tracking-tight">Calibro</span>
            <span className="inline-block h-1.5 w-1.5 translate-y-[-2px] bg-[#e0663c]" aria-hidden />
          </Link>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="inline-flex h-10 w-10 items-center justify-center text-[24px] leading-none text-paper/70 hover:text-paper"
          >
            ×
          </button>
        </div>
        <div className="relative z-10 flex-1 px-5 py-4">{children}</div>
        {footer && <div className="relative z-10 shrink-0 border-t border-paper/10 px-5 pt-4 pb-[calc(16px+env(safe-area-inset-bottom))]">{footer}</div>}
      </aside>
    </>,
    document.body
  );
}

/** A large, touch-sized drawer link. */
export function DrawerLink({ href, children, active, external }: { href: string; children: ReactNode; active?: boolean; external?: boolean }) {
  const cls = `flex min-h-12 items-center justify-between border-b border-paper/10 text-[17px] transition-colors ${active ? "text-paper" : "text-paper/75 hover:text-paper"}`;
  const arrow = <span className="text-paper/35">→</span>;
  return external || href.startsWith("#") ? (
    <a href={href} className={cls}>
      {children}
      {arrow}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {children}
      {arrow}
    </Link>
  );
}
