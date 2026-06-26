/// <reference types="vite-plugin-pwa/client" />
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
// P1.3: self-hosted fonts (were render-blocking Google Fonts CDN links in
// index.html). Plus Jakarta Sans Variable is the primary UI typeface (matches
// the dashboard design); Inter is kept as a fallback. Both register their own
// font-family names; index.css lists Plus Jakarta first in --font-sans.
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { registerSW } from "virtual:pwa-register";
import { hashNavigate } from "./lib/hashNavigate";
import { hydrateQueryCache } from "./lib/queryClient";
import { installStaleChunkHandlers } from "./components/ErrorBoundary";

// P1.2: register the vite-plugin-pwa service worker (autoUpdate: new deploys
// activate immediately and refresh the page). Registered here — not via an
// inline script in index.html — so CSP can drop 'unsafe-inline'.
registerSW({
  immediate: true,
  // Long-lived tabs must converge on new deploys without a manual refresh:
  // poll for a new service worker every 60s (plus the built-in check on
  // every navigation). With registerType:"autoUpdate" the new SW activates
  // immediately (skipWaiting+clientsClaim) and the NetworkFirst shell route
  // picks up the new bundles on the next navigation.
  onRegisteredSW(_url, registration) {
    if (registration) {
      setInterval(() => { registration.update().catch(() => {}); }, 60_000);
    }
  },
});

// Pre-warm the serverless API as early as possible — BEFORE auth, before React
// even mounts. On Vercel the API is a serverless function that cold-starts after
// inactivity; the very first request (often /api/auth/signin or /api/auth/me)
// otherwise eats the whole cold start and can fail with "Load failed". Firing a
// public /api/warmup the instant the bundle loads means the function is already
// warming while the user reads the sign-in screen, so their first real request
// hits a warm instance. Fire-and-forget; failures are irrelevant.
try {
  const warm = () => { fetch("/api/warmup", { method: "GET", cache: "no-store", keepalive: true }).catch(() => {}); };
  warm();
  // A second nudge shortly after, in case the first hit a different cold instance.
  setTimeout(warm, 1500);
} catch { /* ignore */ }

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
