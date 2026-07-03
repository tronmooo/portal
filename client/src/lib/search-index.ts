// Client-side matching for the ⌘K command palette's local search cache.
//
// PERF-AUDIT (2026-07-03): every query used to hit /api/search (~1s round-trip),
// even when re-typing a term or extending a previous query. The server returns
// the FULL match set for a term, so a longer query's matches are always a strict
// subset of a shorter one's. `itemMatches` lets us narrow a cached broader
// result set locally for an instant first paint (see CommandSearch.tsx).

/**
 * Lowercased searchable text for a result row: every string (and string-array)
 * field value joined together. This is a safe SUPERSET of the fields the server
 * matches on (name/title/description/category/content/tags/…), so narrowing a
 * cached superset with this never drops a row the server would have kept.
 *
 * Only string VALUES are included — not object keys — so a query can't
 * accidentally match a field name like "description".
 */
export function searchableText(item: any): string {
  const parts: string[] = [];
  for (const v of Object.values(item ?? {})) {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) {
      for (const el of v) if (typeof el === "string") parts.push(el);
    }
  }
  return parts.join(" ").toLowerCase();
}

/** True if `item` matches `normalizedQuery` (already lowercased/trimmed). */
export function itemMatches(item: any, normalizedQuery: string): boolean {
  return searchableText(item).includes(normalizedQuery);
}
