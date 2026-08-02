// shared/data-version.ts
//
// Read-your-own-write, in one place.
//
// THE BUG THIS EXISTS TO KILL (user report 2026-08-02: "I had to refresh the
// entire app for all the trackers to show up"):
//
// Server response caches are keyed by the user's Postgres DATA VERSION
// (`cacheUserKey` in server/routes.ts), so a write on any serverless instance
// makes every other instance's cached entries unaddressable. That works — but
// each instance MEMOIZES the version for VERSION_MEMO_MS (2s) to avoid a DB
// read per request. So the window right after a write looks like this:
//
//   t=0     POST /api/chat commits create_tracker, bumps the data version
//   t=0.3   client invalidates and refetches GET /api/trackers
//   t=0.3   that GET lands on a READ instance whose memo still says v=OLD
//           → computes `trackers:<uid>@v<OLD>`
//           → HITS the 5-minute cached PRE-WRITE list
//   t=0.3   React Query stores that stale list as FRESH for its 3-min staleTime
//   ⇒ the tracker is invisible until a full app reload.
//
// (/api/chat runs on a different Vercel function than the read API, so the
// chat handler's own `clearAllCache()` cannot help the instance serving reads.)
//
// The fix is a causality token rather than a timing guess. A write tells the
// client the version it produced; the client presents that as a FLOOR on
// subsequent reads; a server instance whose memo is below the floor re-reads
// the version from Postgres before computing any cache key. The read is then
// correct by construction instead of by winning a race — which is what makes it
// safe for React Query to cache the result for the full staleTime.
//
// Deliberately a FLOOR, not an assignment: the header can only ever cause the
// server to go ask Postgres. It never sets the version, so a stale, replayed or
// malformed value cannot poison a cache key — the worst case is one extra
// indexed read.

/** Request header carrying the minimum data version the caller has already observed. */
export const MIN_DATA_VERSION_HEADER = "x-min-data-version";

/**
 * How long a client keeps presenting a version floor after a write.
 *
 * The bump propagates to every instance within ~VERSION_MEMO_MS, so a few
 * seconds would do. 30s is generous enough to cover a slow chat turn whose
 * follow-up reads straggle, and short enough that any pathological value stops
 * mattering almost immediately.
 */
export const MIN_DATA_VERSION_TTL_MS = 30_000;

/** Parse the header value. Returns 0 for anything missing or malformed. */
export function parseMinDataVersion(headerValue: string | string[] | undefined | null): number {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (typeof raw !== "string" || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
