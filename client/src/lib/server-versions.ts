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
  if (!seen) { seen = { ...incoming }; return []; }
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

/** Sign-out / account switch, and tests. */
export function resetServerVersions(): void { seen = null; }
