/**
 * Small fetch helper for the public data sources (Polymarket, ESPN): timeout, one retry
 * on transient failures, and an in-process TTL cache. `ttlMs: Infinity` is used for
 * point-in-time data about the past (it cannot change).
 */
const cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();
const MAX_ENTRIES = 2_000;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function fetchOnce<T>(url: string, timeoutMs: number): Promise<T> {
  const work = (async () => {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "calibro/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) throw new HttpError(`HTTP ${res.status} from ${new URL(url).host}${new URL(url).pathname}`, res.status);
    return (await res.json()) as T;
  })();
  work.catch(() => undefined); // a late failure after the deadline must not become an unhandled rejection
  // Hard deadline: a fetch that fails inside the framework can leave its promise unsettled,
  // which would stall a streamed page forever. Never wait longer than timeout + 5 s.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(`Timed out after ${timeoutMs + 5000} ms: ${new URL(url).host}`, 0)), timeoutMs + 5000);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T>(url: string, options: { ttlMs?: number; timeoutMs?: number } = {}): Promise<T> {
  const ttl = options.ttlMs ?? 0;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && now - hit.at < hit.ttl) return hit.value as Promise<T>;

  const value = (async () => {
    try {
      return await fetchOnce<T>(url, timeoutMs);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      if (status >= 400 && status < 500 && status !== 429) throw err;
      await new Promise((r) => setTimeout(r, 600));
      return fetchOnce<T>(url, timeoutMs);
    }
  })();

  if (ttl > 0) {
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(url, { at: now, ttl, value });
    value.catch(() => cache.delete(url));
  }
  return value;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}
