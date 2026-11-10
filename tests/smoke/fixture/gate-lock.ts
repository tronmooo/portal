/**
 * One production gate at a time per test account.
 *
 * The contract suite, Live E2E and live sweeps all write as the shared smoke
 * account, and the contract suite starts by WIPING it (reset.ts). Two runs that
 * overlap — a pre-push here, CI, a push from another session — delete each
 * other's records mid-test, and the gate goes red with 404s and wrong list
 * counts on a production that is fine (2026-11-09/10: 9–11 contract failures
 * that passed on a quiet rerun). A red gate must mean a regression, so every
 * gate run holds this lock while it writes.
 *
 * The lock is a preference row on the account itself, so it works across
 * machines (CI runners, sessions, laptops) with no server change:
 *   value = {"holder": "...", "gate": "...", "expiresAt": <ms>}
 * Acquire = wait until it is free or expired, write ours, wait SETTLE_MS for
 * any racing writer to land, read back: only the run whose claim survived
 * proceeds; the other goes back to waiting. The holder refreshes expiresAt
 * while it runs, so a crashed run frees the account after TTL_MS.
 *
 * Guard: tests/live-gate-rate-limit.test.ts (lock logic + every gate uses it).
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

export const GATE_LOCK_KEY = "smoke_gate_lock";

export type GateLockIo = {
  /** The stored lock value ("" or null when free). */
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
};

export type GateLockOptions = {
  gate: string;
  ttlMs?: number;
  settleMs?: number;
  pollMs?: number;
  maxWaitMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
};

type LockValue = { holder: string; gate: string; expiresAt: number };

function parse(raw: string | null): LockValue | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.holder === "string" && typeof v.expiresAt === "number" ? v : null;
  } catch {
    return null;
  }
}

/** Acquire the gate lock; resolves with a release function. Throws if the
 * account stays busy past maxWaitMs, naming the run that holds it. */
export async function acquireGateLock(io: GateLockIo, opts: GateLockOptions): Promise<() => Promise<void>> {
  const ttlMs = opts.ttlMs ?? 10 * 60_000;
  const settleMs = opts.settleMs ?? 3_000;
  const pollMs = opts.pollMs ?? 10_000;
  const maxWaitMs = opts.maxWaitMs ?? 15 * 60_000;
  const heartbeatMs = opts.heartbeatMs ?? 2 * 60_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((m: string) => console.log(`[gate-lock] ${m}`));

  const holder = `${opts.gate}@${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const claim = () => JSON.stringify({ holder, gate: opts.gate, expiresAt: now() + ttlMs } satisfies LockValue);
  const started = now();
  let lastSeen = "";

  for (;;) {
    const current = parse(await io.read());
    if (current && current.holder !== holder && current.expiresAt > now()) {
      if (now() - started > maxWaitMs) {
        throw new Error(`[gate-lock] test account still busy after ${Math.round(maxWaitMs / 60_000)} min: held by ${current.holder}`);
      }
      if (current.holder !== lastSeen) log(`waiting: ${current.gate} run ${current.holder} is using the test account`);
      lastSeen = current.holder;
      await sleep(pollMs);
      continue;
    }
    await io.write(claim());
    await sleep(settleMs);
    const after = parse(await io.read());
    if (after?.holder === holder) break;
    // Another run's claim landed after ours: it holds the lock; wait.
  }
  log(`acquired by ${holder}`);

  let released = false;
  const timer = setInterval(() => {
    if (!released) io.write(claim()).catch(() => undefined);
  }, heartbeatMs);
  (timer as any).unref?.();

  return async () => {
    released = true;
    clearInterval(timer);
    const current = parse(await io.read().catch(() => null));
    if (current?.holder === holder) await io.write("").catch(() => undefined);
    log(`released by ${holder}`);
  };
}

/** Lock I/O over the app's preferences API, for any authenticated fetcher. */
export function preferenceLockIo(
  call: (method: "GET" | "PUT", path: string, body?: any) => Promise<{ ok: boolean; status: number; data: any }>,
): GateLockIo {
  const path = `/preferences/${GATE_LOCK_KEY}`;
  return {
    async read() {
      const r = await call("GET", path);
      if (!r.ok) throw new Error(`[gate-lock] read failed: ${r.status} ${JSON.stringify(r.data)}`);
      const v = r.data?.value;
      return typeof v === "string" ? v : null;
    },
    async write(value: string) {
      const r = await call("PUT", path, { value });
      if (!r.ok) throw new Error(`[gate-lock] write failed: ${r.status} ${JSON.stringify(r.data)}`);
    },
  };
}
