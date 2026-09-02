// ─── Full-list fetch limit ─────────────────────────────────────────────────
// The list routes that go through the server's generic paginate() (tasks,
// habits, obligations, goals, events, documents, journal) return the NEWEST
// 100 rows unless the caller passes ?limit=. The aggregate tiles are computed
// server-side over the whole set, so a page that fetched a list without a
// limit counted everything in its tile and listed only the newest hundred —
// the 101st task was invisible everywhere but the count.
//
// Every page that is meant to show the WHOLE set appends this. 500 is the
// route-level hard cap, so asking for more changes nothing.
export const FULL_LIST_LIMIT = 500;

/** Append `limit=FULL_LIST_LIMIT` to a list URL, whether or not it has a query string. */
export function withFullLimit(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}limit=${FULL_LIST_LIMIT}`;
}
