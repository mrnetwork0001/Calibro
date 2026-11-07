import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Loads .env.local then .env without overriding variables already set in the shell. */
export function loadDotEnv(): void {
  for (const name of [".env.local", ".env"]) {
    const p = resolve(process.cwd(), name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}

export function missingEnv(keys: string[]): string[] {
  return keys.filter((k) => !process.env[k]?.trim());
}

export function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export function flagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
