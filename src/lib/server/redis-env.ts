/**
 * Upstash Redis / Vercel KV REST credentials from the environment, shared by the replay
 * ledger, the rate limiter and the read cache.
 *
 * Accepts the plain names (UPSTASH_REDIS_REST_URL + _TOKEN, or KV_REST_API_URL + _TOKEN) and
 * the prefixed names Vercel's storage integration creates when a custom prefix is chosen
 * (e.g. STORAGE_KV_REST_API_URL + STORAGE_KV_REST_API_TOKEN). Never picks the read-only token.
 */
const PAIRS: Array<[url: string, token: string]> = [
  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
];

export function redisRestEnv(env: Record<string, string | undefined> = process.env): { url: string; token: string } | null {
  const clean = (url: string, token: string) => ({ url: url.trim().replace(/\/$/, ""), token: token.trim() });
  for (const [u, t] of PAIRS) {
    const url = env[u]?.trim();
    const token = env[t]?.trim();
    if (url && token) return clean(url, token);
  }
  for (const key of Object.keys(env).sort()) {
    for (const [u, t] of PAIRS) {
      if (!key.endsWith(`_${u}`)) continue;
      const prefix = key.slice(0, key.length - u.length);
      const url = env[key]?.trim();
      const token = env[`${prefix}${t}`]?.trim();
      if (url && token) return clean(url, token);
    }
  }
  return null;
}
