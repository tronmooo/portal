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
import { getProfileFilter } from "./profileFilter";
import { perfMark, perfMeasure } from "./perf-marks";

// ── Profile detail warmup ────────────────────────────────────────────────────
// First open of an asset/liability detail measured ~8s in production
// (2026-07-17 live drive): the /api/profile-bootstrap/:id aggregation runs
// ~12 Supabase queries cold. Firing it on hover/touchstart of the row warms
// the SERVER's 30s response cache, so the page's own fetch (which owns the
// client cache shape — flattenProfile + sibling-key seeding lives in
// profile-detail.tsx) becomes a near-instant cache hit. Deliberately
// fire-and-forget with NO client cache writes: zero shape risk.
const detailWarmed = new Map<string, number>();
export function warmProfileDetail(id: string): void {
  if (!id) return;
  const last = detailWarmed.get(id) || 0;
  if (Date.now() - last < 25_000) return; // inside the server's 30s cache window
  detailWarmed.set(id, Date.now());
  apiRequest("GET", `/api/profile-bootstrap/${id}`).catch(() => {
    detailWarmed.delete(id); // let a later hover retry after a failure
  });
}

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

// ── App-return refresh ───────────────────────────────────────────────────────
// Called when the user comes back to the tab (visibility → visible / bfcache
// restore). Refreshes the WHOLE dashboard through the single /api/dashboard-
// bootstrap aggregate for the currently-active profile scope, exactly like the
// boot and scope-switch paths do.
//
// Why this exists: with refetchOnWindowFocus, returning to the tab used to
// refetch every one of the dashboard's ~25 scoped queries in parallel. On
// serverless (one Vercel function, one region) that fan-out cold-starts several
// instances and saturates the DB pool, so on a weak mobile link the slow
// requests queue past the StuckLoadingGuard deadline and their cards sit on
// "loading". Routing the come-back through the aggregate turns that storm into
// ONE request whose payload seeds every card's cache (seedDashboardCaches).
// prefetchScopeBootstrap's own freshness guard means a quick return (<60s)
// reuses cache and spends no request at all.
export function refreshDashboardOnReturn(): void {
  try {
    const { mode, selectedIds } = getProfileFilter();
    prefetchScopeBootstrap(mode, mode === "selected" ? selectedIds : []);
  } catch { /* best-effort — never throw from a lifecycle handler */ }
}
