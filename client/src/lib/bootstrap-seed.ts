// [PERF 2026-06-10] Single-round-trip dashboard paint.
//
// The dashboard fired ~12 separate GETs on mount; on serverless each parallel
// request can land on its own cold instance (1-3s each), producing the
// "skeletons forever" cold open. /api/dashboard-bootstrap now returns every
// mount-time dataset in one response; this helper seeds the EXACT query keys
// the dashboard components read, so they render from cache instantly and only
// refetch in the background per staleTime / after mutations.
//
// The concrete key list lives in bootstrap-seed-keys.ts (a pure,
// queryClient-free module) so the pre-mount hydrator in queryClient.ts can
// reuse the identical shapes — one source of truth, per the audit.
import { queryClient } from "./queryClient";
import { bootstrapSeedEntries } from "./bootstrap-seed-keys";

/* [PERF 2026-08-17] "Coming back to a section reloads everything."
   ─────────────────────────────────────────────────────────────────
   Measured on production (Playwright drive, smoke account): leaving the
   Executive tab for >3 min and returning fired 12 parallel API requests;
   Finance fired 8. Every one of those datasets is ALREADY carried by
   /api/dashboard-bootstrap and re-seeded by this function.

   Cause: seeding stamps each key fresh at the same instant, so all ~25
   seeded slots cross the global 3-min staleTime together. On the next
   mount every component independently refetched its own slot — while the
   bootstrap refetched too and then overwrote all of them with the same
   rows. The individual requests were pure waste, and on serverless each
   one is its own invocation.

   Fix: the bootstrap is the designated refresher for the data it carries,
   so its dependents are given a longer staleTime than the bootstrap's own.
   The bootstrap goes stale first, refetches once, and re-seeds every
   dependent slot before any of them expires — one request instead of a
   dozen. Freshness is unaffected: it is invalidation-driven in this app
   (every mutation path invalidates the domains it touched, and
   invalidation ignores staleTime entirely), and a stale-marked query still
   refetches on the next mount exactly as before. */
const SEEDED_STALE_TIME_MS = 10 * 60_000;

export function seedDashboardCaches(
  b: any,
  mode: string,
  ids: string[],
  month: string,
): void {
  for (const { key, data } of bootstrapSeedEntries(b, mode, ids, month)) {
    queryClient.setQueryData(key, data);
    // Defaults are per exact seeded key (scope discriminators included), so
    // this never widens to an unrelated query. A component that passes its
    // own staleTime still wins — see the seeded consumers, which deliberately
    // no longer do.
    queryClient.setQueryDefaults(key as any, { staleTime: SEEDED_STALE_TIME_MS });
  }
}
