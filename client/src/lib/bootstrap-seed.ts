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

export function seedDashboardCaches(
  b: any,
  mode: string,
  ids: string[],
  month: string,
): void {
  if (!b || typeof b !== "object") return;
  const seed = (key: unknown[], data: unknown) => {
    if (data !== undefined && data !== null) queryClient.setQueryData(key, data);
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
}
