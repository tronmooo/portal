// [PERF 2026-06-10] Single-round-trip dashboard paint.
//
// The dashboard fired ~12 separate GETs on mount; on serverless each parallel
// request can land on its own cold instance (1-3s each), producing the
// "skeletons forever" cold open. /api/dashboard-bootstrap now returns every
// mount-time dataset in one response; this helper seeds the EXACT query keys
// the dashboard components read, so they render from cache instantly and only
// refetch in the background per staleTime / after mutations.
//
// Key shapes must stay in lockstep with the components' queryKey definitions
// (client/src/pages/dashboard.tsx) — if a key changes there, change it here.
import { queryClient } from "./queryClient";
import { goalsQueryKey } from "@shared/query-keys";

export function seedDashboardCaches(
  b: any,
  mode: string,
  ids: string[],
  month: string,
  // [PERF 2026-07-20 "tabs should already be loaded"] When re-seeding from a
  // PERSISTED bootstrap snapshot (see seedFromHydratedBootstrap), stamp the
  // seeds with the snapshot's own timestamp so staleTime treats them as old
  // data — cached numbers paint instantly, a background refetch replaces them.
  // Never clobber a key that already holds fresher data.
  opts?: { updatedAt?: number },
): void {
  if (!b || typeof b !== "object") return;
  const updatedAt = opts?.updatedAt;
  const seed = (key: unknown[], data: unknown) => {
    if (data === undefined || data === null) return;
    if (updatedAt !== undefined) {
      const state = queryClient.getQueryState(key);
      if (state && state.dataUpdatedAt >= updatedAt) return;
      queryClient.setQueryData(key, data, { updatedAt });
    } else {
      queryClient.setQueryData(key, data);
    }
  };
  seed(["/api/stats", mode, ...ids], b.stats);
  seed(["/api/dashboard-enhanced", mode, ...ids], b.enhanced);
  seed(["/api/profiles"], b.profiles);
  seed(["/api/incomes", mode, ...ids, "hero"], b.incomes);
  seed(["/api/incomes", mode, ...ids], b.incomes);
  seed(["/api/budgets/summary", month, mode, ...ids, "hero"], b.budgetSummary);
  seed(["/api/budgets/summary", month, mode, ...ids], b.budgetSummary);
  seed(["/api/expenses", mode, ...ids], b.expenses);
  seed(["/api/budgets", month, mode, ...ids], b.budgets);
  seed(["/api/obligations", mode, ...ids], b.obligations);
  seed(["/api/asset-party-links"], b.assetPartyLinks);
  seed(["/api/liability-profile-links"], b.liabilityProfileLinks);
  // [PERF 2026-07-16, user report "tiles stuck on loading"] Briefing/Upcoming
  // datasets ride in the same bootstrap response now, so the Executive
  // briefing's and Upcoming section's queries (gated on bootstrap settling)
  // resolve from these seeds instead of firing 14 more network requests that
  // fight the bootstrap download on weak mobile links. Key shapes mirror the
  // consuming components exactly (ExecutiveBriefing.tsx, dashboard.tsx).
  seed(["/api/tasks", mode, ...ids], b.tasks);
  seed(["/api/habits", mode, ...ids], b.habits);
  seed(["/api/goals", mode, ...ids], b.goals);
  seed([...goalsQueryKey(ids)], b.goals);
  seed(["/api/journal", mode, ...ids], b.journal);
  seed(["/api/events", mode, ...ids], b.events);
  seed(["/api/documents", mode, ...ids], b.documents);
  seed(["/api/trackers", mode, ...ids], b.trackers);
  seed(["/api/trackers", mode, ...ids, "trends"], b.trackers);
  seed(["/api/reminders", mode, ...ids], b.reminders);
  // [PERF 2026-07-20] Finance tab's last cold query — key shape mirrors
  // finance.tsx exactly. Older bootstrap payloads (server not yet redeployed,
  // or a persisted pre-upgrade snapshot) simply don't carry the field and the
  // seed() null-guard skips it.
  seed(["/api/paychecks", mode, ...ids], b.paychecks);
}

// [PERF 2026-07-20, user report "when I go to different tabs on the dashboard,
// I should already be loaded"] The bootstrap payload is one of the few entries
// persisted to localStorage (queryClient.ts ESSENTIAL_PERSIST_PREFIXES), but
// the per-tab keys it seeds are NOT — they only exist as a side effect of the
// bootstrap queryFn running. On a fresh app open the hydrated snapshot restored
// the bootstrap blob and then every tab (Trackers / Finance / Wellness /
// Assets / Calendar…) still mounted cold, showing skeletons until the network
// round trip landed. Re-running the seeding over every hydrated bootstrap
// entry makes each tab paint instantly from last session's data; the seeds
// carry the snapshot's timestamp, so React Query still refetches in the
// background on mount.
//
// Call AFTER hydrateQueryCache() and BEFORE React mounts (main.tsx).
export function seedFromHydratedBootstrap(): void {
  try {
    for (const q of queryClient.getQueryCache().getAll()) {
      const k = q.queryKey as unknown[];
      // Key shape (App.tsx DataPrefetch / scope-prefetch.ts):
      // ["/api/dashboard-bootstrap", mode, ...ids, month]
      if (k?.[0] !== "/api/dashboard-bootstrap" || k.length < 3) continue;
      const b = q.state.data;
      if (!b || typeof b !== "object") continue;
      const mode = String(k[1]);
      const month = String(k[k.length - 1]);
      const ids = k.slice(2, -1).map(String);
      seedDashboardCaches(b, mode, ids, month, { updatedAt: q.state.dataUpdatedAt });
    }
  } catch { /* seeding is best-effort — never block boot */ }
}
