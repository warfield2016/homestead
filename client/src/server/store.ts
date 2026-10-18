import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

// Tiny JSON-file persistence. Homestead keeps very little state of its own: the app key,
// the login hash, your feed preferences, and a cache of signer -> app lookups. Everything
// else is read from your node on demand.

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

export function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(config.dataDir, name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write (temp file + rename) so a crash never leaves half a key on disk. */
export function writeJson(name: string, value: unknown, mode = 0o600): void {
  const path = join(config.dataDir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, path);
}
