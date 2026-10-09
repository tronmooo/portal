// ─── Synchronization instrumentation (development / test only) ──────────────
//
// One structured log for every event that decides whether two screens agree:
// a mutation starting and settling, a cache invalidation, a stale response
// being rejected, a valuation landing, a notification resolving, a filter
// being applied or reset, a record's owner set changing.
//
// Off in production builds: nothing is printed and nothing is kept, so no
// internal id ever reaches a user's console or screen. On in a dev build, under
// the test runner, or when a maintainer opts one browser in with
// `localStorage.portol_sync_debug = "1"`.
//
// The last entries are kept in a small ring buffer so a regression test can
// assert that, say, a stale valuation response was REJECTED rather than merely
// observing the end state.

export type SyncChannel =
  | "mutation"
  | "invalidate"
  | "stale-reject"
  | "valuation"
  | "notification"
  | "filter"
  | "ownership"
  | "fetch-failure";

export interface SyncLogEntry {
  at: number;
  channel: SyncChannel;
  message: string;
  data?: Record<string, unknown>;
}

const RING_MAX = 200;
const ring: SyncLogEntry[] = [];
let forced: boolean | null = null;

function envEnabled(): boolean {
  try {
    const env = (import.meta as any)?.env;
    if (env && (env.DEV || env.MODE === "test")) return true;
  } catch { /* not a Vite host */ }
  try {
    const p = (globalThis as any).process;
    if (p?.env?.VITEST || p?.env?.NODE_ENV === "test" || p?.env?.NODE_ENV === "development") return true;
  } catch { /* no process */ }
  try {
    return (globalThis as any).localStorage?.getItem?.("portol_sync_debug") === "1";
  } catch {
    return false;
  }
}

/** Is sync logging on for this runtime? */
export function syncLogEnabled(): boolean {
  return forced ?? envEnabled();
}

/** Test hook: force logging on/off (null restores environment detection). */
export function __setSyncLogEnabled(on: boolean | null): void {
  forced = on;
}

export function syncLog(channel: SyncChannel, message: string, data?: Record<string, unknown>): void {
  if (!syncLogEnabled()) return;
  const entry: SyncLogEntry = { at: Date.now(), channel, message, ...(data ? { data } : {}) };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  // Quiet under the test runner: the ring buffer is what tests read, and a
  // console line per cache event would drown the suite's output.
  try {
    const p = (globalThis as any).process;
    if (p?.env?.VITEST) return;
  } catch { /* ignore */ }
  try { console.debug(`[sync:${channel}] ${message}`, data ?? ""); } catch { /* ignore */ }
}

/** Entries recorded so far (newest last), optionally for one channel. */
export function getSyncLog(channel?: SyncChannel): SyncLogEntry[] {
  return channel ? ring.filter((e) => e.channel === channel) : ring.slice();
}

export function clearSyncLog(): void {
  ring.length = 0;
}
