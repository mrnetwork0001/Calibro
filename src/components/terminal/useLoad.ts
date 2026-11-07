"use client";

import { useCallback, useEffect, useState } from "react";

const BACKOFF_MS = [4_000, 10_000, 20_000];

/**
 * Loads a panel's data and retries on its own (after 4 s, 10 s, 20 s) when the read fails,
 * then offers a Retry button. A failed read is always shown as a failure, never as an
 * empty record, and the last good data stays on screen while a refresh fails.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      load()
        .then((v) => {
          if (!live) return;
          setData(v);
          setError(null);
          setRetrying(false);
        })
        .catch((e: Error) => {
          if (!live) return;
          setError(e.message);
          const wait = BACKOFF_MS[n];
          setRetrying(wait !== undefined);
          if (wait !== undefined) timer = setTimeout(() => attempt(n + 1), wait);
        });
    };
    attempt(0);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce((x) => x + 1), []);
  return { data, error, retrying, reload, loading: data === null && error === null };
}
