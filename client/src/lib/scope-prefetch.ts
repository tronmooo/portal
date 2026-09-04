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
import { queryClient, apiRequest, BROWSER_TIMEZONE } from "./queryClient";
import { getUserCurrentMonth } from "@shared/timezone";
import { seedDashboardCaches } from "./bootstrap-seed";
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

/** The exact key dashboard.tsx's bootstrap useQuery reads, so a prefetch here
 *  and the page's own hook collapse onto ONE request (React Query dedupes an
 *  in-flight key) instead of two cold serverless invocations. */
export function scopeBootstrapKey(mode: "everyone" | "selected", ids: string[]): unknown[] {
  const month = getUserCurrentMonth(BROWSER_TIMEZONE); // browser-zone month, same key the dashboard reads
  const cleanIds = mode === "selected" ? ids.filter(Boolean) : [];
  return ["/api/dashboard-bootstrap", mode, ...cleanIds, month];
}

/**
 * Make sure the scope's bootstrap is loaded (or loading) and return a promise
 * for it. Unlike prefetchScopeBootstrap this REJECTS on failure and, when the
 * bootstrap is already in flight, resolves with that same request — callers
 * that want to piggyback on the one aggregate round-trip (seededQueryFn) need
 * both.
 */
export function ensureScopeBootstrap(
  mode: "everyone" | "selected",
  ids: string[],
): Promise<unknown> {
  const month = getUserCurrentMonth(BROWSER_TIMEZONE);
  const cleanIds = mode === "selected" ? ids.filter(Boolean) : [];
  const qs = cleanIds.length > 0
    ? `?profileIds=${cleanIds.join(",")}&month=${month}`
    : `?month=${month}`;
  const queryKey = scopeBootstrapKey(mode, cleanIds);

  // Fresh-enough data already cached — don't spend a serverless invocation
  // re-warming it. (An identical fetch in flight is joined by fetchQuery.)
  const state = queryClient.getQueryState(queryKey);
  if (state && state.fetchStatus !== "fetching" &&
      state.data != null && Date.now() - state.dataUpdatedAt < 60_000) {
    return Promise.resolve(state.data);
  }

  const label = cleanIds.join(",") || "everyone";
  if (!state || state.fetchStatus !== "fetching") perfMark(`scope-prefetch-start:${label}`);
  return queryClient.fetchQuery({
    queryKey,
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/dashboard-bootstrap${qs}`);
      const b = await r.json();
      seedDashboardCaches(b, mode, cleanIds, month);
      perfMeasure("scope-prefetch-landed", `scope-prefetch-start:${label}`);
      return b ?? null;
    },
    staleTime: 60_000,
  });
}

export function prefetchScopeBootstrap(
  mode: "everyone" | "selected",
  ids: string[],
): Promise<void> {
  // Best-effort warmup: never rejects, never throws into a hover handler.
  return ensureScopeBootstrap(mode, ids).then(() => undefined, () => undefined);
}

// ── Piggyback a cold tab query on the scope bootstrap ───────────────────────
// Every hub tab is gated on one list (trackers, profiles, documents, expenses)
// that /api/dashboard-bootstrap already returns and seeds under the tab's
// exact query key. But a tab opened COLD (deep link, reload on a non-Executive
// tab, first visit before the bootstrap lands) fired its own request for that
// list in parallel with the bootstrap — two cold serverless invocations racing
// for the same rows, and on a slow instance the tab's skeleton outlived the
// 20s StuckLoadingGuard while the bootstrap that would have painted it was
// still working (2026-09-04 "This is taking too long to load" on Assets).
//
// seededQueryFn turns that into ONE request: with nothing cached under the
// key, await the scope bootstrap (starting it if nobody has) and read the
// slot it seeds. Anything else — a refetch of data already on screen, a
// bootstrap that failed or didn't carry the slot, a scope the bootstrap
// doesn't cover — falls through to the tab's own direct fetch, exactly as
// before. Errors from the bootstrap are swallowed here on purpose: the direct
// fetch is the one whose failure the tab reports.
export function seededQueryFn<T>(
  queryKey: readonly unknown[],
  mode: "everyone" | "selected",
  ids: string[],
  direct: () => Promise<T>,
): () => Promise<T> {
  return async () => {
    // Data on screen already: this is a refetch (invalidation, Retry), and the
    // caller wants THIS list refreshed, not the whole bootstrap re-run.
    if (queryClient.getQueryData(queryKey) !== undefined) return direct();
    try {
      await ensureScopeBootstrap(mode, ids);
    } catch {
      return direct();
    }
    const seeded = queryClient.getQueryData<T>(queryKey);
    return seeded !== undefined ? seeded : direct();
  };
}

// ── Sibling-scope warmup ─────────────────────────────────────────────────────
// Hover/touch prefetch only helps when the pointer rests on the row long enough
// to cover a 1.5-4.6s bootstrap — on mobile (no hover) and on a decisive click
// it buys almost nothing, so switching people still meant waiting out a cold
// aggregation (PERF_PLAN_LAUNCH_2026-07-16 §B1).
//
// Once the ACTIVE scope has painted, the app is idle and the network is free:
// walk the other people in the household and warm each one's bootstrap in the
// background. seedDashboardCaches fills every scoped query key from each
// response, so by the time the user opens the switcher the next person's
// dashboard is already in the client cache — the switch renders with no
// network at all. On the server these follow-up requests are cheap: the
// bootstrap reuses the first request's raw table reads (see the
// `bootstrap-raw:` cache in server/routes.ts), so only the JS aggregation
// re-runs.
//
// Deliberately conservative — this is background work that must never compete
// with what the user is looking at:
//   - starts only after the active scope has landed, on an idle callback,
//   - runs STRICTLY sequentially (one in-flight bootstrap at a time), so it can
//     never fan out N serverless invocations at once,
//   - capped at MAX_SIBLING_WARMS profiles,
//   - skipped while the tab is hidden, and abandoned mid-sweep if it goes
//     hidden or the caller unmounts/rescopes.
const MAX_SIBLING_WARMS = 6;
const SIBLING_WARM_TTL_MS = 5 * 60_000;
const siblingWarmedAt = new Map<string, number>();

function idle(fn: () => void, timeout = 2_000): void {
  const w = window as any;
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(fn, { timeout });
  else setTimeout(fn, 0);
}

/**
 * Warm every OTHER person's dashboard scope in the background.
 * `personIds` is the switcher's profile list; `activeIds` is the scope on
 * screen right now (skipped — it's already loaded).
 *
 * Returns a cancel function; call it when the caller unmounts or the active
 * scope changes so an in-flight sweep stops queueing further requests.
 */
export function warmSiblingScopes(personIds: string[], activeIds: string[]): () => void {
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return cancel;

  const active = new Set(activeIds.filter(Boolean));
  const now = Date.now();
  const targets = personIds
    .filter(Boolean)
    .filter((id) => !active.has(id))
    .filter((id) => now - (siblingWarmedAt.get(id) || 0) >= SIBLING_WARM_TTL_MS)
    .slice(0, MAX_SIBLING_WARMS);
  if (targets.length === 0) return cancel;

  const step = (i: number) => {
    if (cancelled || i >= targets.length) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const id = targets[i];
    siblingWarmedAt.set(id, Date.now());
    prefetchScopeBootstrap("selected", [id])
      .catch(() => { siblingWarmedAt.delete(id); }) // let a later sweep retry
      .finally(() => { if (!cancelled) idle(() => step(i + 1)); });
  };
  idle(() => step(0));
  return cancel;
}
