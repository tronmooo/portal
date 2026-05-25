import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { hashNavigate } from "./lib/hashNavigate";
import { hydrateQueryCache } from "./lib/queryClient";
import { installStaleChunkHandlers } from "./components/ErrorBoundary";

// Install BEFORE anything else — catches lazy-import failures thrown from
// route Switches, sentinels, or any code path that bypasses the React tree.
// When the browser has a cached HTML referencing chunk hashes that no longer
// exist on the server (after a deploy), we auto-reload once to pick up the
// new bundle instead of leaving the user on a dead-end error screen.
installStaleChunkHandlers();

// Restore the React Query cache from localStorage BEFORE React mounts so the
// dashboard renders with cached data instantly instead of flashing a skeleton.
// hydrate is a no-op if nothing was persisted, or if data is older than 24h.
hydrateQueryCache();

// Hash-router URL normalization.
// The app uses wouter's useHashLocation, so the canonical URL shape is
// `/#/dashboard` rather than `/dashboard`. When users (or browser autocomplete,
// PWA shortcuts, deep-links from emails, etc.) hit `portol.me/dashboard`
// directly, the static host falls back to index.html and the path is dropped —
// previously this silently landed everyone on Chat. We now preserve the
// intended route by promoting the pathname into the hash before React mounts.
(function normalizeHashRoute() {
  const { pathname, search, hash } = window.location;
  // Anything that's not the root path AND has no hash yet should be promoted.
  // Skip auth and known static paths the server handles directly.
  const STATIC_PATHS = new Set(["/", ""]);
  const SERVER_PATHS = ["/api/", "/auth/callback"];
  if (hash) return; // already a hash route, leave alone
  if (STATIC_PATHS.has(pathname)) {
    hashNavigate("/");
    return;
  }
  if (SERVER_PATHS.some(p => pathname.startsWith(p))) return;
  // Promote /dashboard?x=1 -> /#/dashboard?x=1 without reloading
  const target = `#${pathname}${search || ""}`;
  window.history.replaceState(null, "", `/${target}`);
})();

createRoot(document.getElementById("root")!).render(<App />);
