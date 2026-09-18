// shared/record-highlight.ts — landing on a RECORD, not a page.
//
// A search result for a "Groceries" expense used to drop the user at the top
// of the Finance tab with no way to tell which of three Groceries rows it
// meant (QA 2026-09-18 F-52). A result now navigates with `?highlight=<type>:<id>`;
// the target page reads it, scrolls that row into view and flashes it.

export interface RecordHighlight { type: string; id: string }

export const HIGHLIGHT_PARAM = "highlight";
/** How long the landed-on row stays lit. */
export const HIGHLIGHT_MS = 2500;

/** `/dashboard/finance` + expense abc → `/dashboard/finance?highlight=expense:abc`. */
export function highlightHref(basePath: string, type: string, id: string | number): string {
  const sep = basePath.includes("?") ? "&" : "?";
  return `${basePath}${sep}${HIGHLIGHT_PARAM}=${encodeURIComponent(`${type}:${id}`)}`;
}

/**
 * The highlight a hash-route carries, if any. Accepts the raw hash
 * ("#/dashboard/finance?highlight=expense:abc"), a path with query, or the
 * bare query string. Returns null for anything malformed.
 */
export function parseHighlight(hashOrQuery: string | null | undefined): RecordHighlight | null {
  const raw = String(hashOrQuery || "");
  const q = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw.startsWith("#") ? "" : raw;
  if (!q) return null;
  let value: string | null = null;
  try { value = new URLSearchParams(q).get(HIGHLIGHT_PARAM); } catch { return null; }
  if (!value) return null;
  const i = value.indexOf(":");
  if (i <= 0 || i === value.length - 1) return null;
  return { type: value.slice(0, i), id: value.slice(i + 1) };
}

/** The same hash with the highlight parameter removed (and no dangling "?"). */
export function stripHighlight(hash: string): string {
  const i = hash.indexOf("?");
  if (i === -1) return hash;
  const params = new URLSearchParams(hash.slice(i + 1));
  params.delete(HIGHLIGHT_PARAM);
  const rest = params.toString();
  return rest ? `${hash.slice(0, i)}?${rest}` : hash.slice(0, i);
}
