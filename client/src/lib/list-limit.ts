// ─── Full-list fetch ───────────────────────────────────────────────────────
// History: list routes used to go through a generic paginate() that returned
// the NEWEST 100 rows unless the caller passed ?limit=, so whole-set pages
// appended `limit=500` through this helper.
//
// Every list route is full-by-default now (server/routes.ts paginateFull /
// paginateProfiles; tests/list-routes-full-by-default.test.ts), and that made
// the old `?limit=500` actively harmful: it CAPPED the list at 500 rows while
// other components fetched the same cache key with the bare URL and got every
// row. One cache slot, two payloads — whichever component fetched last decided
// what the dashboard, Tasks and Habits showed (audit 2026-10-09, Rule 1: one
// resource, one query key, one payload).
//
// So the whole set is the bare URL. The helper stays (28 call sites name the
// intent "I need the whole list") but no longer adds a pager.
export const FULL_LIST_LIMIT: number | null = null;

/** The URL that returns the whole list — the bare URL, now that routes are full by default. */
export function withFullLimit(url: string): string {
  return url;
}
