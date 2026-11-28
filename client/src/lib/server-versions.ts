// Another device wrote: learn it from the server's version map, and say which
// domains moved.
//
// WHY (owner, 2026-11-27: "Every device receives relevant updates"; integrity
// run: a payment recorded elsewhere left an open loan's header on the old
// balance until a reload). The server keeps a counter per data domain and
// bumps it on every write. A tab learns its OWN writes' counters from the
// write's answer; nothing told it about anybody else's, so it trusted its
// lists for three minutes. Every GET now carries the server's current map
// (`X-Server-Data-Version`), and a counter that rose for a reason other than
// this tab's own write names a domain to read again.
// Guard: tests/server-versions.test.ts.
import { decodeVersionMap, EPOCH_KEY } from "@shared/cache-domains";

export const SERVER_VERSION_HEADER = "X-Server-Data-Version";
/** Every list must be read again (the account moved and no domain was named). */
export const ALL_DOMAINS = "*";

let seen: Record<string, number> | null = null;
/** A snapshot was restored with no version map of its own (written before
 *  the map was persisted): the first map seen cannot tell what it missed. */
let restoredBlind = false;

/**
 * Take a version map the server sent. Answers the domains that moved because
 * of SOMEONE ELSE: a counter this tab has seen lower, that this tab's own
 * write (its `ownDomains`, each expected to rise by exactly one) does not
 * explain. The first map a session sees is only a baseline.
 */
export function observeServerVersions(raw: unknown, opts: { ownDomains?: readonly string[] | null } = {}): string[] {
  const incoming = decodeVersionMap(raw);
  const names = Object.keys(incoming);
  if (names.length === 0) return [];
  if (!seen) {
    seen = { ...incoming };
    if (restoredBlind) { restoredBlind = false; return [ALL_DOMAINS]; }
    return [];
  }
  const own = opts.ownDomains ? new Set(opts.ownDomains) : null;
  const moved: string[] = [];
  let epochRose = false;
  for (const d of names) {
    const v = incoming[d];
    if (!Number.isFinite(v)) continue;
    const prev = seen[d] ?? 0;
    if (v <= prev) continue;
    seen[d] = v;
    if (d === EPOCH_KEY) { epochRose = true; continue; }
    if (!own || !own.has(d) || v - prev > 1) moved.push(d);
  }
  // The account moved, nothing was named, and it was not this tab: read everything.
  if (moved.length === 0 && epochRose && !own) return [ALL_DOMAINS];
  return moved;
}

/*
 * A RELOAD IS NOT A NEW BASELINE (integrity run, isolated stack, 2026-11-28).
 * The query cache is saved to localStorage and restored on reload as a first
 * paint (lib/queryClient.ts: snapshotCache / hydrateQueryCache), most of it as
 * fresh. If the first map after the reload became the baseline, a write another
 * device made while this tab was closed was already IN that map: nothing ever
 * looked new, and the restored lists kept the old rows (device A added a task;
 * device B reloaded and its dashboard and Tasks list never showed it). So the
 * map this tab had SEEN is saved with the snapshot, and restoring the snapshot
 * restores it: the first map after the reload is compared with what the saved
 * data was read under, and every domain that moved since is read again.
 * Guard: tests/sync-devices-reload-and-double-submit.test.ts.
 */
/** The map this tab has seen, to save beside the cached data it describes. */
export function serverVersionsSnapshot(): Record<string, number> | null {
  return seen ? { ...seen } : null;
}

/**
 * Restoring cached data saved by an earlier page load. `map` is what that load
 * had seen (`serverVersionsSnapshot`); null when the snapshot predates the map,
 * in which case the first map seen re-reads everything once. Never moves a
 * baseline this load already has.
 */
export function restoreServerVersions(map: unknown): void {
  if (seen) return;
  const decoded: Record<string, number> = {};
  if (map && typeof map === "object" && !Array.isArray(map)) {
    for (const [d, v] of Object.entries(map as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) decoded[d] = Math.floor(v);
    }
  }
  if (Object.keys(decoded).length === 0) { restoredBlind = true; return; }
  seen = { ...decoded };
  restoredBlind = false;
}

/** Sign-out / account switch, and tests. */
export function resetServerVersions(): void { seen = null; restoredBlind = false; }
