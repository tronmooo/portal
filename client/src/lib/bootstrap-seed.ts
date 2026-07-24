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

export function seedDashboardCaches(
  b: any,
  mode: string,
  ids: string[],
  month: string,
): void {
  for (const { key, data } of bootstrapSeedEntries(b, mode, ids, month)) {
    queryClient.setQueryData(key, data);
  }
}
