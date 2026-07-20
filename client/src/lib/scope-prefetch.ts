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
import { flattenProfile } from "./flattenProfile";

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

// ── Info tab warmup ─────────────────────────────────────────────────────────
// [PERF 2026-07-20 "tabs should already be loaded"] The Info chip navigates to
// /profiles/:id/info, whose page query is ["/api/profiles", id, "detail"] —
// the ONE hub tab whose data is not in the dashboard bootstrap. Prefetch it
// during idle so the tab paints instantly. queryFn mirrors profile-info.tsx /
// profile-detail.tsx exactly (same key, same flattenProfile(b.detail) shape,
// same sibling-key seeding) so whichever page mounts first reads a
// shape-identical cache entry.
export function prefetchProfileInfoDetail(id: string): void {
  if (!id) return;
  const key = ["/api/profiles", id, "detail"];
  const state = queryClient.getQueryState(key);
  if (state && (state.fetchStatus === "fetching" ||
      (state.data != null && Date.now() - state.dataUpdatedAt < 60_000))) {
    return;
  }
  void queryClient.prefetchQuery({
    queryKey: key,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/profile-bootstrap/${id}`);
      const b = await res.json();
      if (b && typeof b === "object" && b.detail) {
        if (b.tree) queryClient.setQueryData(["/api/profiles", id, "tree"], b.tree);
        if (b.profiles) queryClient.setQueryData(["/api/profiles"], b.profiles);
        if (b.assetPartyLinks) queryClient.setQueryData(["/api/asset-party-links"], b.assetPartyLinks);
        if (b.liabilityProfileLinks) queryClient.setQueryData(["/api/liability-profile-links"], b.liabilityProfileLinks);
        return flattenProfile(b.detail);
      }
      const r2 = await apiRequest("GET", `/api/profiles/${id}/detail`);
      return flattenProfile(await r2.json());
    },
    staleTime: 60_000,
  });
}

// One-shot idle warmup for the few tab queries the dashboard bootstrap does
// not carry: the lite profiles list (Info redirect + hub switcher), memories
// (Info page), artifacts (Documents/Artifacts tab), and the Info tab's target
// profile detail (the single selected person, else the Self profile). All
// fire-and-forget, all deduped by React Query, ≤4 requests once per session.
export function warmSecondaryTabData(selectedIds: string[]): void {
  const idlePrefetch = (key: unknown[], url: string) => {
    const state = queryClient.getQueryState(key);
    if (state && (state.fetchStatus === "fetching" ||
        (state.data != null && Date.now() - state.dataUpdatedAt < 60_000))) {
      return;
    }
    void queryClient.prefetchQuery({
      queryKey: key,
      queryFn: async () => (await apiRequest("GET", url)).json(),
      staleTime: 60_000,
    });
  };
  idlePrefetch(["/api/profiles", "lite"], "/api/profiles/lite");
  idlePrefetch(["/api/memories"], "/api/memories");
  idlePrefetch(["/api/artifacts"], "/api/artifacts");

  // Info tab target: the selected person when exactly one is selected,
  // otherwise the Self profile (InfoSelfRedirect's destination).
  let infoId = selectedIds.length === 1 ? selectedIds[0] : "";
  if (!infoId) {
    const profiles = queryClient.getQueryData<any[]>(["/api/profiles"]);
    infoId = (profiles || []).find((p: any) => p?.type === "self")?.id || "";
  }
  if (infoId) prefetchProfileInfoDetail(infoId);
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
