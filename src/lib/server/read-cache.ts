/**
 * Shared cache for Calibro's slow read models: everything derived from recalling Walrus
 * Memory (settled games, inventory, scorecards). One full recall takes 15-25 s and the
 * relayer occasionally stalls, so reads go through here.
 *
 * Store: Upstash Redis / Vercel KV (REST) when configured, shared by every serverless
 * instance; otherwise one JSON file per key under .calibro/cache (local) or the OS temp
 * dir (a serverless deployment without KV, per instance).
 *
 * Policy, per key:
 *  - fresh (younger than `freshMs`, same write generation): served as is;
 *  - older than `freshMs`: served at once and refreshed behind the response;
 *  - written since (generation moved, e.g. a settlement): reloaded before serving, so
 *    nobody sees pre-settlement numbers after a write;
 *  - the reload fails: the last good value is served, flagged `stale` with its time.
 *    Only if there has never been a value does the error reach the caller.
 * Values are real Walrus reads; nothing here synthesizes data.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "next/server";
import { redisRestEnv } from "./redis-env";

export interface Cached<T> {
  value: T;
  /** When the value was read from Walrus */
  asOf: string;
  /** True when Walrus failed just now and this is the last good copy */
  stale: boolean;
  error?: string;
}

interface Entry<T> {
  value: T;
  at: number;
  gen: number;
}

interface Store {
  readonly kind: "redis" | "file";
  read<T>(name: string): Promise<{ gen: number; entry: Entry<T> | null }>;
  write<T>(name: string, entry: Entry<T>): Promise<void>;
  bump(): Promise<number>;
}

const PREFIX = "calibro:rm:";
const GEN_KEY = `${PREFIX}gen`;
const DEFAULT_FRESH_MS = 5 * 60_000;

class RedisStore implements Store {
  readonly kind = "redis" as const;
  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  private async pipeline(commands: Array<Array<string | number>>): Promise<Array<{ result?: unknown; error?: string }>> {
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`read cache (Redis): HTTP ${res.status}`);
    return (await res.json()) as Array<{ result?: unknown; error?: string }>;
  }

  async read<T>(name: string) {
    const [gen, entry] = await this.pipeline([
      ["GET", GEN_KEY],
      ["GET", PREFIX + name],
    ]);
    return {
      gen: Number(gen?.result ?? 0),
      entry: typeof entry?.result === "string" ? (JSON.parse(entry.result) as Entry<T>) : null,
    };
  }

  async write<T>(name: string, entry: Entry<T>) {
    // Kept for a week: the last good copy is what visitors see if Walrus is down.
    const [r] = await this.pipeline([["SET", PREFIX + name, JSON.stringify(entry), "EX", 7 * 86_400]]);
    if (r?.error) throw new Error(`read cache (Redis): ${r.error}`);
  }

  async bump() {
    const [r] = await this.pipeline([["INCR", GEN_KEY]]);
    return Number(r?.result ?? 0);
  }
}

class FileStore implements Store {
  readonly kind = "file" as const;
  constructor(private readonly dir: string) {}

  private path(name: string) {
    return join(this.dir, `${name.replace(/[^\w-]/g, "_")}.json`);
  }

  private readJson<T>(path: string): T | null {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
      return null;
    }
  }

  async read<T>(name: string) {
    return {
      gen: this.readJson<{ gen: number }>(this.path("_gen"))?.gen ?? 0,
      entry: this.readJson<Entry<T>>(this.path(name)),
    };
  }

  async write<T>(name: string, entry: Entry<T>) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(name), JSON.stringify(entry));
  }

  async bump() {
    const gen = (this.readJson<{ gen: number }>(this.path("_gen"))?.gen ?? 0) + 1;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path("_gen"), JSON.stringify({ gen }));
    return gen;
  }
}

let store: Store | null = null;

export function readCacheStore(): Store {
  if (store) return store;
  const creds = redisRestEnv();
  store =
    creds
      ? new RedisStore(creds.url, creds.token)
      : new FileStore(process.env.CALIBRO_CACHE_DIR?.trim() || (process.env.VERCEL ? join(tmpdir(), "calibro-cache") : join(process.cwd(), ".calibro", "cache")));
  return store;
}

/** Test hook: use a specific store (e.g. a temp-dir FileStore). */
export function setReadCacheStore(s: Store | null): void {
  store = s;
}

export function fileReadCacheStore(dir: string): Store {
  return new FileStore(dir);
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * Loads once per key at a time (per process), with one retry for relayer blips. Resolves to
 * the stored entry, so the caller reports the same read time that later readers will see.
 */
function reload<T>(name: string, load: () => Promise<T>, gen: number): Promise<Entry<T>> {
  const running = inflight.get(name);
  if (running) return running as Promise<Entry<T>>;
  const p = (async () => {
    let value: T;
    try {
      value = await load();
    } catch {
      await new Promise((r) => setTimeout(r, 1_500));
      value = await load();
    }
    const stored: Entry<T> = { value, at: Date.now(), gen };
    await readCacheStore()
      .write(name, stored)
      .catch((err) => console.warn(`[read-cache] could not store ${name}:`, err instanceof Error ? err.message : err));
    return stored;
  })().finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

/** Runs work after the response when inside a request; otherwise just starts it. */
function background(work: () => Promise<unknown>): void {
  const run = () => work().catch((err) => console.warn("[read-cache] background refresh failed:", err instanceof Error ? err.message : err));
  try {
    after(run);
  } catch {
    void run();
  }
}

export async function readThrough<T>(name: string, load: () => Promise<T>, opts: { freshMs?: number } = {}): Promise<Cached<T>> {
  const freshMs = opts.freshMs ?? DEFAULT_FRESH_MS;
  const { gen, entry } = await readCacheStore()
    .read<T>(name)
    .catch((err) => {
      console.warn(`[read-cache] store unavailable for ${name}:`, err instanceof Error ? err.message : err);
      return { gen: 0, entry: null as Entry<T> | null };
    });

  if (entry && entry.gen === gen) {
    if (Date.now() - entry.at >= freshMs) background(() => reload(name, load, gen));
    return { value: entry.value, asOf: new Date(entry.at).toISOString(), stale: false };
  }

  try {
    const loaded = await reload(name, load, gen);
    return { value: loaded.value, asOf: new Date(loaded.at).toISOString(), stale: false };
  } catch (err) {
    if (entry) {
      return { value: entry.value, asOf: new Date(entry.at).toISOString(), stale: true, error: err instanceof Error ? err.message : String(err) };
    }
    throw err;
  }
}

/** Marks every read model as outdated (call after writing settlements or grades). */
export async function invalidateReadModels(): Promise<void> {
  await readCacheStore()
    .bump()
    .catch((err) => console.warn("[read-cache] could not invalidate:", err instanceof Error ? err.message : err));
}

/** Reloads one read model now and stores it (cron warm-up, post-settlement refresh). */
export async function refreshReadModel<T>(name: string, load: () => Promise<T>): Promise<void> {
  const { gen } = await readCacheStore().read<T>(name);
  await reload(name, load, gen);
}
