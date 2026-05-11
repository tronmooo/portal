/**
 * Centralized hash-routing helpers — single source of truth for code paths
 * that need to change the location outside of a React component (where
 * Wouter's `useLocation()` is the preferred API).
 *
 * The app's <Router> is wired with `useHashLocation`, so the URL hash is the
 * router's state. Writing to `window.location.hash` directly works but
 * scatters routing knowledge across many call sites; route everything through
 * here so future refactors (e.g. moving off hash routing) touch one file.
 */

/** Normalize a path so it is always prefixed with `#/` exactly once. */
function toHash(pathOrHash: string): string {
  const p = pathOrHash || "/";
  if (p.startsWith("#/")) return p;
  if (p.startsWith("#")) return "#/" + p.slice(1).replace(/^\/+/, "");
  return "#" + (p.startsWith("/") ? p : "/" + p);
}

/**
 * Navigate to a path via the hash router. Safe to call from anywhere
 * (components prefer `useLocation()` from wouter — this helper exists for
 * non-React call sites and for tests that want a single mockable seam).
 *
 * Implementation note: we route through location.assign with a rebuilt URL
 * so callers do not need to write to the hash directly, and so this module
 * can centralize history-entry handling if we ever switch off hash routing.
 */
export function hashNavigate(pathOrHash: string): void {
  if (typeof window === "undefined") return;
  const next = toHash(pathOrHash);
  const url = new URL(window.location.href);
  url.hash = next;
  window.location.assign(url.toString());
}
