import { describe, expect, it } from "vitest";
import { redisRestEnv } from "../src/lib/server/redis-env";

describe("Redis REST credentials (Upstash / Vercel KV)", () => {
  it("reads the plain Upstash names, trimming a trailing slash", () => {
    expect(redisRestEnv({ UPSTASH_REDIS_REST_URL: "https://a.upstash.io/", UPSTASH_REDIS_REST_TOKEN: "t1" })).toEqual({ url: "https://a.upstash.io", token: "t1" });
  });

  it("reads the plain Vercel KV names", () => {
    expect(redisRestEnv({ KV_REST_API_URL: "https://b.upstash.io", KV_REST_API_TOKEN: "t2" })).toEqual({ url: "https://b.upstash.io", token: "t2" });
  });

  it("reads names with a custom integration prefix, and never the read-only token", () => {
    const env = {
      STORAGE_KV_REST_API_URL: "https://c.upstash.io",
      STORAGE_KV_REST_API_READ_ONLY_TOKEN: "read-only",
      STORAGE_KV_REST_API_TOKEN: "write",
    };
    expect(redisRestEnv(env)).toEqual({ url: "https://c.upstash.io", token: "write" });
    expect(redisRestEnv({ STORAGE_KV_REST_API_URL: "https://c.upstash.io", STORAGE_KV_REST_API_READ_ONLY_TOKEN: "read-only" })).toBeNull();
  });

  it("returns null when nothing usable is set", () => {
    expect(redisRestEnv({ UPSTASH_REDIS_REST_URL: "https://d.upstash.io" })).toBeNull();
    expect(redisRestEnv({})).toBeNull();
  });
});
