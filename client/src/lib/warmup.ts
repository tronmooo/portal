// Single source of truth for pre-warming the serverless API function.
//
// Previously main.tsx (public, fired twice), auth.tsx (authed, on OAuth +
// session restore), and App.tsx KeepAlive (authed, on mount) each fired their
// own /api/warmup independently. On a normal authed boot that stacked 3-4
// warmup requests within the first second — all hitting the same cold instance,
// none of them cheap. This collapses them behind one deduped entry point.
//
// Dedup rules:
//   - Two warmups inside WARMUP_DEDUP_MS collapse to one, EXCEPT an authed
//     warmup always supersedes a preceding public one (the authed request
//     pre-populates the per-user server cache, which the public one cannot).
//   - The 90s KeepAlive interval naturally falls outside the window, so
//     steady-state keep-alive pings are never suppressed.

import { getProfileFilter } from "@/lib/profileFilter";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

const WARMUP_DEDUP_MS = 15_000;

let lastWarmupAt = 0;
let lastWarmupWasAuthed = false;

/** Build the saved-scope query string so an authed warmup pre-populates the
 *  server cache for the scope the user will actually land on, instead of
 *  always warming the (heaviest) "everyone" aggregate. */
function savedScopeQuery(): string {
  try {
    const { mode, selectedIds } = getProfileFilter();
    const month = new Date().toISOString().slice(0, 7);
    if (mode === "selected" && selectedIds.length > 0) {
      return `?profileIds=${selectedIds.join(",")}&month=${month}`;
    }
    return `?month=${month}`;
  } catch {
    return "";
  }
}

/**
 * Pre-warm the serverless API. Fire-and-forget; never throws.
 *
 * @param authHeader Optional auth headers. When present the warmup is treated
 *   as authed: it carries the bearer token and the saved profile scope so the
 *   server can warm the per-user response cache. When absent it's a cheap
 *   public warmup (used before the user has a session).
 */
export function warmup(authHeader?: Record<string, string>): void {
  const authed = !!(authHeader && Object.keys(authHeader).length > 0);
  const now = Date.now();
  const withinWindow = now - lastWarmupAt < WARMUP_DEDUP_MS;

  // Collapse duplicates in the window — but let an authed warmup override a
  // public one that fired moments earlier (it does strictly more).
  if (withinWindow && !(authed && !lastWarmupWasAuthed)) return;

  lastWarmupAt = now;
  lastWarmupWasAuthed = authed;

  try {
    const url = authed
      ? `${API_BASE}/api/warmup${savedScopeQuery()}`
      : `${API_BASE}/api/warmup`;
    fetch(url, {
      method: "GET",
      cache: "no-store",
      keepalive: true,
      headers: authed ? authHeader : undefined,
    }).catch(() => {});
    // The AI lambda is a SEPARATE Vercel function (vercel.json routes
    // /api/chat/* to api/ai.js) that /api/warmup never touches — without this
    // ping the first chat message of every session paid its full cold start
    // (~2-3s of module parsing) before the fast paths could even run.
    fetch(`${API_BASE}/api/chat/warmup`, {
      method: "GET",
      cache: "no-store",
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
