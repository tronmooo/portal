// PERF Phase 2 (PERF_PLAN_LAUNCH 2026-07-16): one-round-trip warmup for a
// profile scope. Switching the dashboard scope re-keys EVERY scoped query
// (~45 hooks on the dashboard page + the hub KPI strip) — with nothing cached
// for the new scope that used to mean a multi-second skeleton wall and a
// parallel fan-out of serverless requests. Prefetching the scoped
// /api/dashboard-bootstrap and seeding its payload (seedDashboardCaches fills
// the exact query keys those hooks read) turns a switch into ONE request.
//
// Used by:
//  - HubProfileSwitcher / MultiProfileFilter row hover+touch (warm BEFORE the
//    user commits the switch),
//  - profileFilter's setters (warm the moment the switch happens, so even a
//    cold switch fires one aggregate request instead of dozens).
import { queryClient, apiRequest } from "./queryClient";
import { seedDashboardCaches } from "./bootstrap-seed";
import { perfMark, perfMeasure } from "./perf-marks";

export function prefetchScopeBootstrap(mode: "everyone" | "selected", ids: string[]): void {
  const month = new Date().toISOString().slice(0, 7);
  const cleanIds = mode === "selected" ? ids.filter(Boolean) : [];
  const qs = cleanIds.length > 0
    ? `?profileIds=${cleanIds.join(",")}&month=${month}`
    : `?month=${month}`;
  const queryKey = ["/api/dashboard-bootstrap", mode, ...cleanIds, month];

  // Fresh-enough data already cached (or an identical prefetch in flight) —
  // don't spend a serverless invocation re-warming it.
  const state = queryClient.getQueryState(queryKey);
  if (state && (state.fetchStatus === "fetching" ||
      (state.data != null && Date.now() - state.dataUpdatedAt < 60_000))) {
    return;
  }

  perfMark(`scope-prefetch-start:${cleanIds.join(",") || "everyone"}`);
  void queryClient.prefetchQuery({
    queryKey,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/dashboard-bootstrap${qs}`);
      const b = await r.json();
      seedDashboardCaches(b, mode, cleanIds, month);
      perfMeasure("scope-prefetch-landed", `scope-prefetch-start:${cleanIds.join(",") || "everyone"}`);
      return b ?? null;
    },
    staleTime: 60_000,
  });
}
