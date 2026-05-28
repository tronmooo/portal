/**
 * One-time seed for the whole contract suite.
 *
 * Vitest runs each *.test.ts file in its own worker by default, but we don't
 * want to reseed in every file. Instead we use a tiny lockfile to coordinate:
 * the first worker to call ensureSeeded() runs reset+seed and writes the
 * lockfile; subsequent workers see the lockfile and skip.
 *
 * The lockfile lives in the OS temp dir and includes a timestamp so a stale
 * lock from a previous run can't fool us.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seed, SeedResult } from "./seed";
import { reset } from "./reset";

const LOCK_DIR = join(tmpdir(), "portol-smoke");
const LOCK_FILE = join(LOCK_DIR, "seeded.json");
const TTL_MS = 5 * 60 * 1000; // re-seed if lock is older than 5min

let cached: SeedResult | null = null;

export async function ensureSeeded(): Promise<SeedResult> {
  if (cached) return cached;
  if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true });

  if (existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
      if (Date.now() - lock.at < TTL_MS && lock.result) {
        cached = lock.result;
        return cached!;
      }
    } catch {
      // ignore — fall through to re-seed
    }
  }

  await reset();
  const result = await seed();
  writeFileSync(LOCK_FILE, JSON.stringify({ at: Date.now(), result }));
  cached = result;
  return result;
}

/** For CI: force a fresh seed regardless of lock state. */
export async function forceReseed(): Promise<SeedResult> {
  if (existsSync(LOCK_FILE)) rmSync(LOCK_FILE);
  cached = null;
  return ensureSeeded();
}
