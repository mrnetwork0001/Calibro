"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Burger, Drawer, DrawerLink } from "../mobile/Drawer";

const LINKS: Array<[string, string]> = [
  ["#how", "How it works"],
  ["#record", "Track record"],
  ["#people", "For pickers"],
  ["#agents", "For agents"],
];

/** Landing header navigation: inline links on desktop, burger + left drawer at ≤ 900px. */
export function LandingNav() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <nav className="hidden items-center gap-7 text-[14px] text-paper/65 min-[901px]:flex">
        {LINKS.map(([href, label]) => (
          <a key={href} href={href} className="transition-colors hover:text-paper">
            {label}
          </a>
        ))}
      </nav>
      <Burger open={open} onToggle={() => setOpen((o) => !o)} />
      <Drawer
        open={open}
        onClose={close}
        footer={
          <div className="flex flex-col gap-3">
            <Link
              href="/app"
              className="touch-btn-primary inline-flex items-center justify-center gap-2 bg-paper px-5 py-3 text-[15px] font-medium text-ink"
            >
              Open the terminal <span aria-hidden>→</span>
            </Link>
            <Link
              href="/app/picks"
              className="touch-btn inline-flex items-center justify-center border border-paper/25 px-5 py-2.5 text-[14px] text-paper/85"
            >
              Make a pick
            </Link>
          </div>
        }
      >
        <p className="pb-2 text-[12px] tracking-wide text-paper/40">On this page</p>
        {LINKS.map(([href, label]) => (
          <DrawerLink key={href} href={href}>
            {label}
          </DrawerLink>
        ))}
        <p className="pt-6 pb-2 text-[12px] tracking-wide text-paper/40">The app</p>
        <DrawerLink href="/app">Terminal</DrawerLink>
        <DrawerLink href="/app/picks">Pick journal</DrawerLink>
        <DrawerLink href="/llms.txt" external>
          llms.txt
        </DrawerLink>
      </Drawer>
    </>
  );
}
