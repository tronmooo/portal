/**
 * Single source of truth for tracker categories the app no longer surfaces.
 *
 * Money lives in /expenses, /budgets, and /obligations — never in /trackers.
 * Any category in this set must be (a) rejected by POST /api/trackers and
 * (b) filtered out of client-side tracker lists/filter chips.
 *
 * Adding to this set requires a regression test in
 * tests/smoke/contracts/regressions.test.ts and a paired UI/server check.
 *
 * See BUG-20260528-finance-tracker for the original report.
 */
export const HIDDEN_TRACKER_CATEGORIES = new Set<string>([
  "finance",
  "budget",
  "savings",
  "investment",
  "money",
  "spending",
]);

/** Returns true if a tracker with `category` should be shown in the UI / accepted by the API. */
export function isTrackerCategoryVisible(category: string | null | undefined): boolean {
  if (!category) return true;
  return !HIDDEN_TRACKER_CATEGORIES.has(String(category).toLowerCase().trim());
}
