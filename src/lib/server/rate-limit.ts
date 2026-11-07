/**
 * Fixed-window rate limits. Uses the same Upstash / Vercel KV REST store as the replay
 * ledger when configured (shared across instances); in-process otherwise.
 */
const local = new Map<string, { count: number; resetAt: number }>();

export async function rateLimit(key: string, limit: number, windowSec: number): Promise<{ ok: boolean; remaining: number }> {
  const url = (process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL)?.trim().replace(/\/$/, "");
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN)?.trim();
  if (url && token) {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([
        ["INCR", `calibro:rl:${key}`],
        ["EXPIRE", `calibro:rl:${key}`, windowSec, "NX"],
      ]),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json().catch(() => [])) as Array<{ result?: number }>;
    const count = Number(body[0]?.result ?? Number.POSITIVE_INFINITY);
    return { ok: count <= limit, remaining: Math.max(0, limit - count) };
  }
  const now = Date.now();
  const cur = local.get(key);
  const entry = !cur || cur.resetAt <= now ? { count: 0, resetAt: now + windowSec * 1000 } : cur;
  entry.count += 1;
  local.set(key, entry);
  return { ok: entry.count <= limit, remaining: Math.max(0, limit - entry.count) };
}
