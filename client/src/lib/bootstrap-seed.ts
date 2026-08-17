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
import { isStalePayload } from "./cache-bus";

/**
 * Publish a bootstrap payload into the ~24 query keys it covers.
 *
 * `startedAt` is when the request that produced `b` was ISSUED. Pass it
 * whenever you have it (every caller can) — without it the seed is
 * unconditional, which is the pre-audit behaviour and is only safe for a
 * response you know postdates every write.
 *
 * WRITE-ORDERING GUARD (asset/liability propagation audit)
 * -------------------------------------------------------
 * `setQueryData` both overwrites the value AND re-stamps the entry as fresh.
 * That makes an in-flight bootstrap a time bomb: issue it, let the user save an
 * asset (which invalidates and refetches `/api/profiles` with the new row), let
 * the bootstrap land a moment later — and the new row is wiped out of the list
 * AND the list is marked fresh, so nothing refetches it for the whole staleTime
 * window. The user's only recovery is a hard refresh. Background sibling-scope
 * warmups (scope-prefetch.ts) fire these constantly, so this was not a rare
 * race.
 *
 * Two independent checks close it:
 *   1. If ANY write landed after this request started, drop the whole payload —
 *      it describes the pre-write world.
 *   2. Per key, never overwrite an entry that was updated after this request
 *      started; that entry came from a newer response than ours.
 *
 * Dropping a seed is always safe: the seeded keys are ordinary queries that
 * fetch themselves on mount. Publishing a stale one is not.
 */
export function seedDashboardCaches(
  b: any,
  mode: string,
  ids: string[],
  month: string,
  startedAt?: number,
): void {
  if (startedAt != null && isStalePayload(startedAt)) return;
  for (const { key, data } of bootstrapSeedEntries(b, mode, ids, month)) {
    if (startedAt != null) {
      const state = queryClient.getQueryState(key as any);
      if (state?.dataUpdatedAt && state.dataUpdatedAt > startedAt) continue;
    }
    queryClient.setQueryData(key, data);
  }
}
