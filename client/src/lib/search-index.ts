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

// ─── Ranking ──────────────────────────────────────────────────────────────────
// QA 2026-09-18 BUG-24: "na" listed the expense "Haircut" (it matched the
// category "personal") and the event "Car" (a link-enriched row that matched
// nothing at all), each with no visible reason. The server's match is a flat
// substring test over every field, so the palette ranks its rows here: a
// word-prefix hit on the record's own name/title outranks a substring hit,
// which outranks a hit on a secondary field (category, vendor, notes…), and a
// row that only matched a secondary field says which one. Rows the server
// added as RELATED to a match (`_related`) sit last and are labelled as such.

/** Which fields count as the record's own name — the primary match target. */
const TITLE_FIELDS = ["name", "title"] as const;
/** Fields never worth showing as "matched on …" (ids, timestamps, internals). */
const IGNORED_FIELDS = new Set([
  "id", "userId", "user_id", "createdAt", "updatedAt", "deletedAt", "date", "startDate", "endDate",
  "_type", "_related", "_relationship", "_confidence", "_outOfScope", "_score", "_matchField",
  "linkedProfiles", "profileId", "mimeType", "storagePath", "fileData", "status", "priority",
]);

export interface SearchMatch {
  /** 0 = no match. Higher is better; see the ladder in `scoreMatch`. */
  score: number;
  /** The field the best match was found on (`null` when nothing matched). */
  field: string | null;
  /** True when the match is on the record's own name/title. */
  onTitle: boolean;
}

/** Does `q` start a word of `text` ("na" starts "Dana's"? no; "birthday" starts "Birthday"? yes). */
export function isWordPrefixMatch(text: string, q: string): boolean {
  if (!q) return true;
  const t = text.toLowerCase();
  let at = t.indexOf(q);
  while (at !== -1) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(t[at - 1])) return true;
    at = t.indexOf(q, at + 1);
  }
  return false;
}

function scoreText(text: string, q: string): number {
  const t = text.toLowerCase();
  if (t === q) return 4;                   // exact
  if (t.startsWith(q)) return 3;           // leading prefix
  if (isWordPrefixMatch(t, q)) return 2;   // starts a later word
  if (t.includes(q)) return 1;             // buried substring
  return 0;
}

/**
 * How well (and where) `item` matches `normalizedQuery`. The ladder:
 *   title exact 100 · title prefix 90 · title word-prefix 80 · title substring 60
 *   tag prefix/word 50 · tag substring 40
 *   other field word-prefix 30 · other field substring 20
 *   related-only row 5 (kept so a linked record can still be reached)
 * Out-of-scope rows (`_outOfScope`, see /api/search) rank below every in-scope
 * row of the same kind: their score is halved.
 */
export function scoreMatch(item: any, normalizedQuery: string): SearchMatch {
  const q = (normalizedQuery || "").trim().toLowerCase();
  if (!item || typeof item !== "object") return { score: 0, field: null, onTitle: false };
  if (!q) return { score: 1, field: null, onTitle: false };

  let best: SearchMatch = { score: 0, field: null, onTitle: false };
  const consider = (score: number, field: string, onTitle: boolean) => {
    if (score > best.score) best = { score, field, onTitle };
  };

  for (const f of TITLE_FIELDS) {
    const v = item[f];
    if (typeof v !== "string" || !v) continue;
    const s = scoreText(v, q);
    if (s === 4) consider(100, f, true);
    else if (s === 3) consider(90, f, true);
    else if (s === 2) consider(80, f, true);
    else if (s === 1) consider(60, f, true);
  }
  const tags = Array.isArray(item.tags) ? item.tags.filter((t: unknown): t is string => typeof t === "string") : [];
  for (const t of tags) {
    const s = scoreText(t, q);
    if (s >= 2) consider(50, "tags", false);
    else if (s === 1) consider(40, "tags", false);
  }
  for (const [k, v] of Object.entries(item)) {
    if ((TITLE_FIELDS as readonly string[]).includes(k) || k === "tags" || IGNORED_FIELDS.has(k)) continue;
    if (typeof v !== "string" || !v) continue;
    const s = scoreText(v, q);
    if (s >= 2) consider(30, k, false);
    else if (s === 1) consider(20, k, false);
  }
  if (best.score === 0 && item._related) best = { score: 5, field: "_related", onTitle: false };
  if (best.score > 0 && item._outOfScope) best = { ...best, score: best.score / 2 };
  return best;
}

/**
 * The rows worth showing for `normalizedQuery`, best first. Rows that match
 * nothing (and are not link-related to a match) are dropped. Each surviving
 * row carries `_score` and `_matchField` for the renderer. Sorting is stable,
 * so equal scores keep the server's order.
 */
export function rankResults<T extends Record<string, any>>(raw: T[], normalizedQuery: string): T[] {
  const q = (normalizedQuery || "").trim().toLowerCase();
  const scored = (raw || []).map((item, i) => ({ item, i, m: scoreMatch(item, q) }));
  return scored
    .filter(({ m }) => m.score > 0)
    .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
    .map(({ item, m }) => ({ ...item, _score: m.score, _matchField: m.field }));
}

/** Human label for a field key: "vendor" → "vendor", "extractedData" → "extracted data". */
function fieldLabel(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
}

/**
 * The note a row's subtitle should end with, or "" when the match is on the
 * row's own name (nothing to explain). "matched on category" · "linked to a
 * match" · "outside current scope".
 */
export function matchNote(item: any): string {
  if (!item || typeof item !== "object") return "";
  const parts: string[] = [];
  const field = item._matchField as string | null | undefined;
  if (field === "_related") parts.push("linked to a match");
  else if (field && !(TITLE_FIELDS as readonly string[]).includes(field)) parts.push(`matched on ${fieldLabel(field)}`);
  if (item._outOfScope) parts.push("outside current scope");
  return parts.join(" · ");
}
