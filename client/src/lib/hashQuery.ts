// Reading query params out of the hash route.
//
// The app runs on wouter's hash router, so a deep link looks like
// `https://portol.me/#/profiles/abc?section=birthday`. Everything after `#`
// is the fragment, which means `window.location.search` is empty and
// `new URL(href).searchParams` reads the WRONG query (the one before the
// hash, if any). These helpers read the query that actually belongs to the
// route.

/** The URLSearchParams of the current hash route (empty when there is none). */
export function hashParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  const hash = window.location.hash || "";
  const i = hash.indexOf("?");
  return new URLSearchParams(i >= 0 ? hash.slice(i + 1) : "");
}

/** One param from the current hash route. */
export function hashParam(name: string): string | null {
  return hashParams().get(name);
}

/**
 * Drop params from the hash route without touching the router's state, so a
 * refresh doesn't re-trigger a one-shot deep link (opening a tab, focusing a
 * row). Keeps the path and any params not named.
 */
export function stripHashParams(...names: string[]): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash || "";
  const i = hash.indexOf("?");
  if (i < 0) return;
  const path = hash.slice(0, i);
  const params = new URLSearchParams(hash.slice(i + 1));
  for (const n of names) params.delete(n);
  const qs = params.toString();
  window.history.replaceState(
    null, "",
    `${window.location.pathname}${window.location.search}${path}${qs ? `?${qs}` : ""}`,
  );
}
