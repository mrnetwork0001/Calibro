"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Renders the real value on the server (no JS = correct number), then, in the browser,
 * counts up from 0 the first time it scrolls into view.
 */
export function CountUp({ value, decimals = 0, duration = 1400, className = "" }: { value: number; decimals?: number; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [shown, setShown] = useState(value);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    setShown(0); // before paint: no flash of the final number
    let raf = 0;
    let started = false;
    // If the observer or animation frames never fire (background tab, odd browser), show the real number anyway.
    const fallback = setTimeout(() => {
      if (!started) setShown(value);
    }, 2500);
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      started = true;
      clearTimeout(fallback);
      const t0 = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, (t - t0) / duration);
        setShown(value * (1 - Math.pow(1 - k, 3)));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(fallback);
      cancelAnimationFrame(raf);
    };
  }, [value, duration]);
  return (
    <span ref={ref} className={`tabular-nums ${className}`}>
      {shown.toFixed(decimals)}
    </span>
  );
}
