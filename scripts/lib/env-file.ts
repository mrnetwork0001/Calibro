import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Local secrets file used by setup/provision scripts (git-ignored). */
export const SECRETS_FILE = resolve(process.cwd(), ".env.local");
const TEMPLATE_FILE = resolve(process.cwd(), ".env.example");

/** Creates .env.local from .env.example if it does not exist. Returns true if created. */
export function ensureSecretsFile(): boolean {
  if (existsSync(SECRETS_FILE)) return false;
  const template = existsSync(TEMPLATE_FILE) ? readFileSync(TEMPLATE_FILE, "utf8") : "";
  writeFileSync(SECRETS_FILE, template, { mode: 0o600 });
  return true;
}

/** Current non-empty value for `key` in .env.local, or undefined. */
export function readSecret(key: string): string | undefined {
  if (!existsSync(SECRETS_FILE)) return undefined;
  for (const line of readFileSync(SECRETS_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (m && m[1] === key) {
      const v = m[2].trim().replace(/^['"]|['"]$/g, "");
      return v || undefined;
    }
  }
  return undefined;
}

/**
 * Sets `KEY=value` lines in .env.local: replaces an existing (possibly empty) line for
 * the key, otherwise appends. Never logs values. Keeps the file owner-readable only.
 */
export function upsertSecrets(values: Record<string, string>): void {
  ensureSecretsFile();
  const lines = readFileSync(SECRETS_FILE, "utf8").split(/\r?\n/);
  const pending = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1])!;
      pending.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  writeFileSync(SECRETS_FILE, out.join("\n").replace(/\n*$/, "\n"));
  chmodSync(SECRETS_FILE, 0o600);
}
