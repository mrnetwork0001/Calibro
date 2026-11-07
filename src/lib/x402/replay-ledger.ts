import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Anti-replay ledger for x402 receipts. A key (Sui txDigest, or challengeId for
 * sandbox receipts) can be redeemed exactly once.
 *
 * `reserve()` is check-and-set: it claims the key before the (slow) Tatum RPC
 * verification so two concurrent requests with the same digest cannot both pass.
 * A failed verification calls `release()` so an honest retry is still possible.
 *
 * Scope: the in-memory ledger protects one server process; the file ledger survives
 * restarts on one machine; `RedisReplayLedger` (Upstash / Vercel KV REST) is shared by
 * every instance of a serverless deployment and is required in production.
 */
type MaybePromise<T> = T | Promise<T>;

export interface ReplayLedger {
  readonly kind: "memory" | "file" | "redis";
  reserve(key: string): MaybePromise<boolean>;
  commit(key: string, meta: Record<string, unknown>): MaybePromise<void>;
  release(key: string): MaybePromise<void>;
  has(key: string): MaybePromise<boolean>;
}

export class InMemoryReplayLedger implements ReplayLedger {
  readonly kind: ReplayLedger["kind"] = "memory";
  protected readonly pending = new Set<string>();
  protected readonly redeemed = new Map<string, Record<string, unknown>>();

  reserve(key: string): boolean {
    if (this.pending.has(key) || this.redeemed.has(key)) return false;
    this.pending.add(key);
    return true;
  }

  commit(key: string, meta: Record<string, unknown>): void {
    this.pending.delete(key);
    this.redeemed.set(key, { ...meta, redeemedAt: new Date().toISOString() });
  }

  release(key: string): void {
    this.pending.delete(key);
  }

  has(key: string): boolean {
    return this.pending.has(key) || this.redeemed.has(key);
  }
}

export class FileReplayLedger extends InMemoryReplayLedger {
  override readonly kind = "file" as const;
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
        for (const [k, v] of Object.entries(data)) this.redeemed.set(k, v);
      } catch {
        // A corrupt ledger must not silently reset to empty in a way that allows replays:
        throw new Error(`Replay ledger at ${path} is unreadable; refusing to start with an empty ledger.`);
      }
    }
  }

  override commit(key: string, meta: Record<string, unknown>): void {
    super.commit(key, meta);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.redeemed), null, 2));
  }
}

/**
 * Shared ledger over the Upstash Redis REST API (Vercel KV speaks the same protocol).
 * `reserve` is an atomic `SET NX`, so concurrent requests on different instances cannot
 * both claim one digest. Pending claims expire after 5 minutes if a verifier crashes.
 */
export class RedisReplayLedger implements ReplayLedger {
  readonly kind = "redis" as const;
  private readonly prefix = "calibro:x402:";

  constructor(
    private readonly url: string,
    private readonly token: string
  ) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): RedisReplayLedger | null {
    const url = (env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL)?.trim();
    const token = (env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN)?.trim();
    return url && token ? new RedisReplayLedger(url.replace(/\/$/, ""), token) : null;
  }

  private async command<T>(args: Array<string | number>): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
    if (!res.ok || body.error) throw new Error(`Replay ledger (Redis) error: ${body.error ?? `HTTP ${res.status}`}`);
    return body.result as T;
  }

  async reserve(key: string): Promise<boolean> {
    const ok = await this.command<string | null>(["SET", this.prefix + key, "pending", "NX", "EX", 300]);
    return ok === "OK";
  }

  async commit(key: string, meta: Record<string, unknown>): Promise<void> {
    await this.command(["SET", this.prefix + key, JSON.stringify({ ...meta, redeemedAt: new Date().toISOString() })]);
  }

  async release(key: string): Promise<void> {
    await this.command(["DEL", this.prefix + key]);
  }

  async has(key: string): Promise<boolean> {
    return (await this.command<number>(["EXISTS", this.prefix + key])) === 1;
  }
}
