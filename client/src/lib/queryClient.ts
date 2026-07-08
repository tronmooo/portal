import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { decodeSessionUserId, selectHydratableEntries } from "./cache-isolation";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** Detect browser timezone once and reuse across all requests */
export const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    // Try to parse the body as JSON and extract a friendly message.
    // Server convention: { error: "msg" } or { error: { issues: [{ message }, ...] } } from Zod.
    let friendly = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const e = parsed.error;
        if (typeof e === 'string') friendly = e;
        else if (e && Array.isArray(e.issues) && e.issues[0]?.message) friendly = e.issues.map((i: any) => i.message).filter(Boolean).join('; ');
        else if (e && typeof e === 'object' && typeof e.message === 'string') friendly = e.message;
        else if (typeof parsed.message === 'string') friendly = parsed.message;
      }
    } catch {
      // Not JSON — keep raw text
    }
    throw new Error(`${res.status}: ${friendly}`);
  }
}

const DEFAULT_TIMEOUT_MS = 60000; // 60s timeout — long enough for document file fetches (base64 PDFs/images can be MBs) but bounded so a truly hung request can't freeze the UI forever
const DOC_TIMEOUT_MS = 90000; // 90s for document binary fetches — file_data can be very large
const CHAT_TIMEOUT_MS = 170000; // 170s for chat — heavy multi-action queries make several AI rounds. Server function budget (vercel.json maxDuration) is 300s, so the client waits comfortably longer than a typical heavy request instead of aborting at the old 120s while the server was still working.

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const timeoutMs = (url.includes('/api/chat') || url.includes('/api/upload') || url.includes('/api/smart-fill')) ? CHAT_TIMEOUT_MS
    : (url.includes('/api/documents/')) ? DOC_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "X-Timezone": BROWSER_TIMEZONE };
    if (data) headers["Content-Type"] = "application/json";
    const res = await fetch(`${API_BASE}${url}`, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
      signal: controller.signal,
    });
    await throwIfResNotOk(res);
    return res;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey, signal }) => {
    // Build URL from queryKey — first element is the path, rest are ignored (used for cache segmentation)
    const url = String(queryKey[0]);
    // IDLE-FREEZE FIX: enforce a hard timeout on every query so a stuck refetch
    // after the tab regains focus can't hang the UI. React Query passes its own
    // AbortSignal too; we combine both so either path cancels the request.
    const ctrl = new AbortController();
    // Document fetches can carry large base64 file_data — use the longer doc timeout for those.
    const queryTimeoutMs = url.includes('/api/documents/') ? DOC_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => ctrl.abort(), queryTimeoutMs);
    if (signal) {
      signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    let res: Response;
    try {
      res = await window.fetch(`${API_BASE}${url}`, {
        headers: { "X-Timezone": BROWSER_TIMEZONE },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      // Bug #14/#41: a 401 here means the auth interceptor's refresh attempt
      // also failed (or this query bypassed it). Notify the app so the
      // AuthProvider can clear React state and the UI can redirect to /auth
      // instead of staying stuck rendering with null/empty data.
      try {
        window.dispatchEvent(new CustomEvent("portol:auth-cleared", {
          detail: { reason: "query-401", url },
        }));
      } catch { /* ignore */ }
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

/**
 * Helper for optimistic mutations — updates cache immediately, rolls back on error.
 * Usage: const mutation = useOptimisticMutation("/api/expenses", createExpenseFn);
 */
export function optimisticMutationConfig<T>(
  queryKey: string[],
  mutationFn: (data: T) => Promise<any>,
  addToCache: (old: any[], newItem: T) => any[]
) {
  return {
    mutationFn,
    onMutate: async (newData: T) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: any) => {
        if (Array.isArray(old)) return addToCache(old, newData);
        return old;
      });
      return { previous };
    },
    onError: (_err: any, _data: T, context: any) => {
      if (context?.previous) queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  };
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "returnNull" }),
      refetchInterval: false,
      /* IDLE-FREEZE FIX (2026-05-10) + SKELETON FIX (2026-05-19) + CHAT-SYNC TUNE (2026-05-22):
         The previous combination (refetchOnWindowFocus: true + long staleTime
         + ~25 active queries on the dashboard) caused the tab to lock up when
         the user returned after >2 min — every query refetched in parallel
         and the UI froze waiting for the storm to settle.

         The user's complaint "when I come back to the website, it's always
         loading in this skeleton" is from refetchOnMount + a cleared cache
         (full reload, not just tab switch). Combined with a refetch storm on
         focus, the UI shows skeletons even when nothing changed.

         Current strategy (see staleTime below):
         - 30s staleTime → AI chat / co-owner writes surface fast on the next
           render without waiting on an explicit invalidate. Returning to the
           tab within 30s reuses cache instantly; after 30s window-focus does
           one quiet background refetch.
         - refetchOnMount: true (not "always") → cached data renders instantly
           when navigating between pages; the background refetch fills in any
           data that was invalidated while the page was unmounted.
         - Cache is persisted to localStorage (see persistCache below) so a
           full reload restores instantly instead of showing skeletons.
         - networkMode: "always" → queries continue even on flaky network
           instead of leaving in-flight requests hanging forever. */
      refetchOnWindowFocus: true,
      refetchOnReconnect: "always",
      // refetchOnMount: true means "if the cached data is stale at the time
      // the component mounts, refetch in the background while showing the
      // cached data immediately." Crucially this is what makes invalidated
      // queries actually refresh when the user navigates from /chat to
      // /trackers — without it, react-query marks the cache stale but never
      // refetches because the tracker page wasn't mounted when the invalidate
      // happened. With `false`, the user had to hit refresh manually.
      // Setting to `true` (not "always") avoids the skeleton storm: cached
      // data still renders instantly; the refetch happens silently in the
      // background and swaps in fresh data without a loading state.
      refetchOnMount: true,
      /* STALE-DATA-LEAK FIX (2026-05-30, BUG-20260530-global-placeholder-leak):
         the previous default of `keepPreviousData` carried the prior query's
         data forward when the queryKey changed. On filter-keyed queries
         (every dashboard, popup, hero tile, tracker, calendar widget) this
         meant a new profile briefly — or persistently, if the new result
         filtered down to nothing — displayed the previous profile's numbers.
         That produced the recurring "Lexi shows 2% of $2,650 from Everyone"
         and "00 on popup after swap" bugs. The fix was being applied one
         query at a time (~6 patched, dozens still leaking). Flipping the
         GLOBAL default to undefined fixes every screen at once. Any query
         that actually wants carry-over (pagination, calendar date scroll,
         long lists not keyed by profile filter) can opt back in explicitly
         with `placeholderData: keepPreviousData`. */
      placeholderData: undefined,
      // 60s — matches the server's stats/enhanced/bootstrap cache TTL, so a
      // window-focus/mount refetch of the ~25 active dashboard queries can't
      // out-run the server cache anyway. Chat writes and mutations surface via
      // predicate INVALIDATION (which ignores staleTime), so this does not
      // delay data propagation — it only halves the idle focus-refetch wave.
      staleTime: 60_000,
      gcTime: 60 * 60_000,               // Keep unused data for 60 min
      networkMode: "always",             // Don't hang on flaky network
      retry: (failureCount, error) => {
        if (error instanceof Error) {
          const msg = error.message;
          if (msg.includes("401") || msg.includes("403") || msg.includes("404")) return false;
          if (msg.includes("500") || msg.includes("502") || msg.includes("503")) return failureCount < 2;
        }
        return failureCount < 1;
      },
    },
    mutations: {
      retry: false,
      onSuccess: () => {
        // PERF (2026-05-24): the previous default invalidated EVERY `/api/*`
        // query after any mutation — a single expense write triggered
        // refetches of profiles, obligations, events, trackers, goals,
        // habits, journal, etc. That's the "app feels slow / over-fetches"
        // symptom. We now mark them stale (no immediate refetch) so:
        //  - On-screen data updates the next time the component re-renders
        //    via the per-mutation optimistic update.
        //  - Background data refreshes silently when the user navigates to it.
        // Individual mutations still call invalidateQueries({queryKey: ...,
        // refetchType: "active"}) for the specific domain they touched, which
        // is the right scoped refresh.
        queryClient.invalidateQueries({
          predicate: (q) => String(q.queryKey?.[0] || "").startsWith("/api/"),
          refetchType: "none",
        });
      },
      onError: (error: Error) => {
        console.error("Mutation failed:", error.message);
      },
    },
  },
});

/* ---------------------------------------------------------------------------
   Lightweight query cache persistence — mirrors what @tanstack/query-sync-storage-persister
   does, but without the extra dep. Survives full page reloads so the user
   doesn't see a skeleton flash when they come back to the website.

   Strategy:
   - On every successful query, we snapshot the cache to localStorage (throttled).
   - On boot, we hydrate the cache from localStorage BEFORE React mounts.
   - Entries older than MAX_AGE are skipped on hydrate (avoid stale-by-days).
   - Auth-sensitive keys are excluded so logout doesn't leak a stale session.
--------------------------------------------------------------------------- */
const STORAGE_KEY = "portol-query-cache-v1";
const MAX_AGE_MS = 24 * 60 * 60_000; // 24h — anything older is re-fetched

/* SECURITY (cross-account leak fix): the persisted snapshot is stamped with the
   id of the user who created it, and is ONLY ever restored for that same user.
   The owning user is derived from the LIVE session token in sessionStorage
   (the same source AuthProvider uses for its provisional user) — NOT from a
   long-lived localStorage value, so a stale "active user" key can never grant
   access to another user's cached data.

   Without this, the localStorage query cache (which survives tab close, token
   expiry, and crashes — i.e. every path that bypasses signOut's clear) could be
   hydrated into a different user's session, showing user A's profiles/finances
   to user B. */
function currentSessionUserId(): string | null {
  try {
    return decodeSessionUserId(sessionStorage.getItem("portol_session"));
  } catch {
    return null;
  }
}

function isSafeToPersist(queryKey: any): boolean {
  const first = String(queryKey?.[0] || "");
  // Don't persist anything that's user-identity-bound at the URL level; React
  // Query's queryKey already segments by filter/profile so general /api/*
  // entries are safe.
  if (!first.startsWith("/api/")) return false;
  // Skip auth/session
  if (first.includes("/auth") || first.includes("/session")) return false;
  return true;
}

// P5.3: warn-once flag for the oversize-snapshot skip below (module scope =
// once per session; snapshotCache runs on a 1.5s throttle so a per-call warn
// would flood the console).
let oversizeSnapshotWarned = false;

function snapshotCache(): void {
  try {
    // Never persist data for a user we can't positively identify from the live
    // session. If nobody is signed in (signed out / expired), drop any existing
    // blob so it can't be revived for the next account.
    const uid = currentSessionUserId();
    if (!uid) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return;
    }
    const all = queryClient.getQueryCache().getAll();
    const out: Array<{ k: any; d: any; t: number }> = [];
    for (const q of all) {
      if (!q.state.data) continue;
      if (q.state.status !== "success") continue;
      if (!isSafeToPersist(q.queryKey)) continue;
      out.push({ k: q.queryKey, d: q.state.data, t: q.state.dataUpdatedAt });
    }
    // Cap size to avoid blowing localStorage (~5MB browser quota).
    // Stamp the snapshot with the owning user id (see currentSessionUserId).
    const json = JSON.stringify({ uid, entries: out });
    if (json.length > 2_500_000) { // ~2.5MB cap
      // P5.3: don't fail silently — warn once per session so the "skeleton
      // flash after reload" symptom is diagnosable. Snapshots run every 1.5s,
      // so the flag keeps this from spamming the console.
      if (!oversizeSnapshotWarned) {
        oversizeSnapshotWarned = true;
        console.warn(
          `[queryClient] query-cache snapshot is ${(json.length / 1_000_000).toFixed(1)}MB ` +
          `(> 2.5MB cap) — skipping localStorage persistence. The cache won't ` +
          `survive a full reload this session.`
        );
      }
      return;
    }
    localStorage.setItem(STORAGE_KEY, json);
  } catch { /* localStorage may be unavailable (private browsing) */ }
}

let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSnapshot(): void {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    snapshotCache();
  }, 1500); // throttle to once per 1.5s
}

// A-2: user-scoped UI state in localStorage that must not survive logout.
// These are NOT user-namespaced (unlike portol_profile_filter_v5:<uid>), so a
// different account signing in on the same browser would inherit them.
// Deliberately KEPT (device preferences / not user data): theme keys
// (portol.theme.mode / portol.theme.primary / portol.theme.accent in
// theme-provider.tsx).
const USER_SCOPED_LOCAL_KEYS = [
  "portol_doc_snooze_v1",        // dashboard: per-document expiring-doc snoozes (contains doc ids)
  "portol_dismissed_action_v2",  // dashboard: dismissed action-required items (contains item ids)
  "portol_dismissed_action_v1",  // legacy version of the above (dashboard only clears it on read)
  "portol_editor_links_sidebar", // editor: links-sidebar open/closed UI state
  "portol:lastError",            // ErrorBoundary crash payload (message/stack/url can embed user data)
];

// Bug #21: centralized full-cache clear for sign-out (or anywhere else we need
// to scrub user-scoped state). Wipes the in-memory React Query cache, the
// persisted localStorage snapshot, user-scoped UI state, and (lazily) the
// profile filter so the next user doesn't inherit anyone else's data.
export function clearAllClientCaches(): void {
  try {
    queryClient.clear();
  } catch { /* ignore */ }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* private mode — ignore */ }
  // A-2: scrub user-scoped UI state that previously survived logout.
  for (const key of USER_SCOPED_LOCAL_KEYS) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  // Profile filter lives in client/src/lib/profileFilter.ts. We dynamically
  // import to avoid a circular dep between auth, profileFilter, and this file.
  try {
    void import("./profileFilter").then((m) => {
      try { m.clearProfileFilterForUser(); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

// Synchronous query-cache-only reset for an in-tab account switch. Wipes the
// in-memory React Query cache and the persisted snapshot, but deliberately does
// NOT touch the profile filter (which is already namespaced per-user) so the
// caller can immediately seed the new user's filter without a race.
export function resetQueryCacheForUserSwitch(): void {
  try { queryClient.clear(); } catch { /* ignore */ }
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function hydrateQueryCache(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    // SECURITY: only restore the snapshot if it belongs to the user whose
    // session is live in this tab RIGHT NOW. Any mismatch — a different
    // account, a logged-out tab, or a legacy un-stamped (array) blob — is
    // treated as untrusted and purged so it can never bleed into another
    // account. (See cache-isolation.ts for the validated selection logic.)
    const sessionUid = currentSessionUserId();
    const { entries, purge } = selectHydratableEntries(raw, sessionUid, { maxAgeMs: MAX_AGE_MS });
    if (purge) {
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return;
    }

    for (const entry of entries) {
      // Only seed if no fresh data exists
      const existing = queryClient.getQueryData(entry.k as any);
      if (existing !== undefined) continue;
      queryClient.setQueryData(entry.k as any, entry.d, { updatedAt: entry.t });
    }
  } catch {
    // Corrupt cache — purge it rather than risk a partial/cross-user restore.
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}

// Wire up the snapshot loop. queryCache.subscribe fires on every cache event;
// we throttle to once per 1.5s so a refetch storm doesn't write to localStorage
// 25 times in a row.
if (typeof window !== "undefined") {
  queryClient.getQueryCache().subscribe(() => scheduleSnapshot());
  // Also snapshot on tab hide — catches the case where user switches away.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") snapshotCache();
  });
}

