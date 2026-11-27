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
//
// NO STALE OVERWRITE (Rule 6; integrity run 2026-11-27). The payload is as old
// as the moment its request STARTED. Seeding it is a write into caches this
// request does not own, so it yields to anything newer:
//   · a list written after the request started (its own refetch, an optimistic
//     edit, the row a write's manifest patched in) is left alone;
//   · if a write was acknowledged — or is still in the air — after the request
//     started, the payload may predate that write: lists that already hold data
//     keep it, and what had to be seeded for a first paint is marked stale so
//     it is read again.
// Before this, a bootstrap that began just before a task was ticked done
// landed after the tick, put "todo" back into every list and stamped them
// fresh for three minutes.
import { queryClient } from "./queryClient";
import { bootstrapSeedEntries } from "./bootstrap-seed-keys";
import { readMayPredateWrite, writesInFlight } from "./write-clock";

/**
 * @param startedAt `Date.now()` taken BEFORE the bootstrap request was sent.
 */
export function seedDashboardCaches(
  b: any,
  mode: string,
  ids: string[],
  month: string,
  startedAt: number,
): void {
  const suspect = readMayPredateWrite(startedAt);
  const seededWhileSuspect: unknown[][] = [];
  for (const { key, data } of bootstrapSeedEntries(b, mode, ids, month)) {
    const state = queryClient.getQueryState(key);
    const hasData = state?.data !== undefined;
    if (hasData && (suspect || (state?.dataUpdatedAt ?? 0) >= startedAt)) continue;
    queryClient.setQueryData(key, data);
    if (suspect) seededWhileSuspect.push(key);
  }
  if (!suspect) return;
  // A write still in the air invalidates its own domains when it lands; asking
  // again now would only fetch the same pre-write payload in a loop.
  if (writesInFlight() > 0) {
    for (const key of seededWhileSuspect) void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
    return;
  }
  // The write already landed, and its invalidation could not restart a request
  // nobody was observing: read the suspect payload (and what it seeded) again.
  setTimeout(() => {
    for (const key of seededWhileSuspect) void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "active" });
    void queryClient.invalidateQueries({ queryKey: ["/api/dashboard-bootstrap"], refetchType: "active" });
  }, 0);
}
