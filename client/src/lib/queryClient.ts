import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { decodeSessionUserId, selectHydratableEntries } from "./cache-isolation";
import { bootstrapSeedEntries, isTrimmedSeedEntry, projectBootstrapShell } from "./bootstrap-seed-keys";
import { getProfileFilterSnapshot } from "./profileFilter";
import { ACTIVE_PROFILE_HEADER } from "@shared/active-scope";
import {
  MIN_DATA_VERSION_HEADER,
  MIN_DATA_VERSION_TTL_MS,
} from "@shared/data-version";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

/** Detect browser timezone once and reuse across all requests */
export const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';

/**
 * The profile scope the user is looking at RIGHT NOW, sent on every request.
 *
 * QA report 2026-07-29 PROP-005: with `Mike` selected, Add Expense wrote the
 * row into the self profile's ledger. Each create surface resolved the owner
 * on its own — so any surface that forgot (or whose profile list hadn't loaded
 * yet) silently fell back to self, and the row landed in the wrong person's
 * ledger with no error. Carrying the scope on the wire lets the server apply
 * the invariant once, for every writer, instead of trusting N call sites.
 *
 * Read straight from the store snapshot: the header always reflects the same
 * value `useProfileScope()` is rendering, with no extra subscription to keep
 * in sync.
 */
function activeProfileHeader(): Record<string, string> {
  try {
    const snap = getProfileFilterSnapshot();
    if (snap.mode !== "selected" || snap.selectedIds.length === 0) return {};
    return { [ACTIVE_PROFILE_HEADER]: snap.selectedIds.join(",") };
  } catch {
    return {}; // store not ready (SSR/tests) — server keeps its old defaulting
  }
}

/* ── Read-your-own-write floor (see @shared/data-version) ──────────────────
   A write tells us the data version it produced; we present that as a floor on
   every subsequent read so a server instance with a stale 2s version memo can't
   serve us the pre-write list — which React Query would then cache as fresh for
   its full staleTime, making the write invisible until a full app reload. */
let minDataVersion: { v: number; at: number } | null = null;

/** Record the data version a write produced. Called with `meta.dataVersion`. */
export function noteDataVersion(version: unknown): void {
  const v = typeof version === "number" ? version : Number.parseInt(String(version ?? ""), 10);
  if (!Number.isFinite(v) || v <= 0) return;
  // Monotonic within the TTL: a slower response from an earlier write must
  // never lower a floor a later write already raised.
  if (minDataVersion && minDataVersion.v >= v && Date.now() - minDataVersion.at < MIN_DATA_VERSION_TTL_MS) return;
  minDataVersion = { v, at: Date.now() };
}

/** The floor header, while it is still worth presenting. */
function minDataVersionHeader(): Record<string, string> {
  if (!minDataVersion) return {};
  if (Date.now() - minDataVersion.at >= MIN_DATA_VERSION_TTL_MS) {
    minDataVersion = null;
    return {};
  }
  return { [MIN_DATA_VERSION_HEADER]: String(minDataVersion.v) };
}

/** Test seam — drops the floor so suites don't leak state between cases. */
export function resetDataVersionFloor(): void {
  minDataVersion = null;
}

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
const SEARCH_TIMEOUT_MS = 15000; // 15s for ⌘K search — must fail fast with an error state, never spin for the full 60s default.

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const timeoutMs = (url.includes('/api/chat') || url.includes('/api/upload') || url.includes('/api/smart-fill')) ? CHAT_TIMEOUT_MS
    : (url.includes('/api/documents/')) ? DOC_TIMEOUT_MS
    // Search must fail fast: a spinner that hangs for the full 60s default reads
    // as "search is broken". 15s is well beyond a healthy query yet bounded.
    : (url.includes('/api/search')) ? SEARCH_TIMEOUT_MS
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "X-Timezone": BROWSER_TIMEZONE,
      ...activeProfileHeader(),
      ...minDataVersionHeader(),
    };
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
        headers: {
          "X-Timezone": BROWSER_TIMEZONE,
          ...activeProfileHeader(),
          ...minDataVersionHeader(),
        },
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
         - refetchOnMount: true (not "always") → cached data renders instantly
           when navigating between pages; the background refetch fills in any
           data that was invalidated while the page was unmounted.
         - Cache is persisted to localStorage (see persistCache below) so a
           full reload restores instantly instead of showing skeletons.
         - networkMode: "always" → queries continue even on flaky network
           instead of leaving in-flight requests hanging forever. */
      /* SINGLE-RESUME-PATH FIX (2026-07-21, BUG mobile-skeleton-storm):
         refetchOnWindowFocus + refetchOnReconnect are DISABLED. Return-to-app
         has exactly one refresh path now — recoverWedgedQueries (below),
         invoked once per real resume from the visibilitychange/pageshow
         listeners. Previously focus refetch (every ~25 active dashboard
         queries at once) + reconnect refetch + KeepAlive + wedged-recovery all
         fired on the same resume, and on a cold serverless instance under
         high-data accounts that refetch storm produced wedged in-flight
         queries → skeletons that never terminated and the "taking too long"
         card. With these off, recovery only touches queries that are actually
         stuck (in-flight-since-before-freeze) or that failed while frozen
         (errored / dataless-idle active), matching the known-good baseline of
         ~2 API requests after a 16s return. Freshness stays invalidation-driven
         (600+ mutation call sites explicitly invalidate touched domains). */
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
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
      // REFETCH-STACKING TUNE (2026-07-21): raised 60s → 3 min. Freshness in
      // this app is INVALIDATION-driven, not staleTime-driven: every mutation
      // path (cache-bus invalidateDomains, per-mutation invalidateQueries —
      // 600+ call sites) explicitly invalidates the domains it touched, and
      // invalidation ignores staleTime entirely. So a longer staleTime does
      // NOT delay post-write propagation. What it fixes: with 60s,
      // refetchOnMount + refetchOnWindowFocus re-ran queries that a mutation
      // had JUST refetched via invalidation ("refetch stacking") whenever the
      // user backgrounded/returned or navigated right after a write. 3 min
      // keeps window-focus recovery (iOS wake — see recoverWedgedQueries
      // below, which handles wedged fetches independently of staleTime) while
      // collapsing the redundant waves. Cross-device/co-owner writes now
      // surface within ≤3 min on focus instead of ≤60s — an accepted,
      // moderate trade; anything needing tighter freshness can set a
      // per-query staleTime override.
      staleTime: 180_000,
      gcTime: 60 * 60_000,               // Keep unused data for 60 min
      networkMode: "always",             // Don't hang on flaky network
      retry: (failureCount, error) => {
        if (error instanceof Error) {
          const msg = error.message;
          if (msg.includes("401") || msg.includes("403") || msg.includes("404")) return false;
          if (msg.includes("500") || msg.includes("502") || msg.includes("503")) return failureCount < 2;
          // Rate-limited or timed out (stuck-skeleton fix, 2026-07-16): both
          // are transient by definition — retry instead of freezing the
          // section in an error state the UI renders as eternal "loading".
          if (msg.includes("429") || msg.toLowerCase().includes("timed out")) return failureCount < 2;
        }
        return failureCount < 1;
      },
      // Back off meaningfully between retries (1s, 3s) so a 429 retry doesn't
      // instantly re-trip the limiter.
      retryDelay: (attempt) => Math.min(1_000 * 3 ** attempt, 10_000),
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
    // PERF Phase 1.1/1.2: tokens now live primarily in localStorage (see
    // lib/auth.tsx readStoredSessionRaw — same read order used here to stay a
    // single source of truth), and an expired-but-refreshable token still
    // identifies the cache owner (allowExpired) so the persisted snapshot
    // survives the ~1h access-token lifetime instead of being purged on every
    // real app open.
    let raw: string | null = null;
    try { raw = localStorage.getItem("portol_session"); } catch { /* sandboxed */ }
    if (!raw) raw = sessionStorage.getItem("portol_session");
    return decodeSessionUserId(raw, undefined, /* allowExpired */ true);
  } catch {
    return null;
  }
}

/* CURATED PERSISTENCE (2026-07-17 perf): only the handful of keys that drive
   first-paint are persisted — the bootstrap payload plus the stats / enhanced /
   profiles it seeds. The old behavior serialized EVERY /api/* success entry on
   every cache event, which (a) wrote megabytes to localStorage on a hot path
   dozens of times per session and (b) tripped a 2.5MB all-or-nothing cap where a
   single heavy dashboard payload disabled ALL fast-restore. Curating to these
   keys keeps the snapshot tiny and the restore instant; the individual list
   pages re-fetch on mount as before. */
const ESSENTIAL_PERSIST_PREFIXES = [
  "/api/dashboard-bootstrap",
  "/api/stats",
  "/api/dashboard-enhanced",
  "/api/profiles",
  // [PERF 2026-07-31] The calendar timeline is the ONE dataset the calendar
  // tab paints from; excluding it made every calendar open a cold network
  // fetch behind a 12s "taking too long" guard. The payload is a bounded
  // ~52-day window (shared/calendar-window.ts), so it fits the entry budget.
  "/api/calendar/timeline",
];
export function isEssentialToPersist(queryKey: any): boolean {
  const first = String(queryKey?.[0] || "");
  if (first.includes("/auth") || first.includes("/session")) return false;
  return ESSENTIAL_PERSIST_PREFIXES.some((p) => first === p);
}

// Per-entry / total localStorage budgets. A single oversize payload is dropped
// on its OWN (see snapshotCache) so it can never disable persistence of the
// other essential keys — the failure mode the old total-only cap created.
const MAX_ENTRY_BYTES = 800_000;   // ~0.8MB per curated entry
const MAX_TOTAL_BYTES = 2_500_000; // ~2.5MB total (localStorage quota margin)
// Above-the-fold rows kept per list domain when the FULL bootstrap payload
// exceeds MAX_ENTRY_BYTES. Enough to paint every tab's first screen; the full
// lists refetch in the background on mount. See projectBootstrapShell.
const SHELL_MAX_ROWS = 100;
// Lightweight, opt-in persistence instrumentation (?perfLog=1). Logs the
// bootstrap payload / persisted-shell byte sizes so the Phase 2 cliff frequency
// can be sized without noisy production logging or any PII.
function perfLogEnabled(): boolean {
  try {
    return typeof window !== "undefined" &&
      /(?:\?|&)perfLog=1\b/.test(window.location.search + window.location.hash);
  } catch { return false; }
}

export function snapshotCache(): void {
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
    const candidates: Array<{ k: any; d: any; t: number; bytes: number }> = [];
    const debug = perfLogEnabled();
    for (const q of all) {
      if (!q.state.data) continue;
      if (q.state.status !== "success") continue;
      if (!isEssentialToPersist(q.queryKey)) continue;
      let data: any = q.state.data;
      let bytes = 0;
      try { bytes = JSON.stringify(data).length; } catch { continue; }
      if (bytes > MAX_ENTRY_BYTES) {
        const isBootstrap = Array.isArray(q.queryKey) && q.queryKey[0] === "/api/dashboard-bootstrap";
        if (isBootstrap) {
          // PERSISTENCE CLIFF FIX (Phase 2): rather than silently dropping the
          // whole bootstrap — which regressed the instant dashboard for exactly
          // the heavy-data users who most need it — persist a bounded shell
          // projection (aggregates whole + first SHELL_MAX_ROWS rows per list).
          // The full payload refetches on mount and swaps in complete lists.
          const shell = projectBootstrapShell(data, SHELL_MAX_ROWS);
          let shellBytes = 0;
          try { shellBytes = JSON.stringify(shell).length; } catch { shellBytes = Number.MAX_SAFE_INTEGER; }
          if (debug) {
            // eslint-disable-next-line no-console
            console.log(`[perfLog] bootstrap over cap: full=${bytes}B shell=${shellBytes}B (cap ${MAX_ENTRY_BYTES}B)`);
          }
          if (shellBytes <= MAX_ENTRY_BYTES) {
            data = shell;
            bytes = shellBytes;
          } else {
            // Even the shell is too big — drop it, but keep collecting the rest.
            continue;
          }
        } else {
          // Drop this one heavy non-bootstrap payload but keep collecting the
          // rest — heavy data must not disable all useful fast-restore.
          continue;
        }
      }
      candidates.push({ k: q.queryKey, d: data, t: q.state.dataUpdatedAt, bytes });
    }
    // Freshest first, then fill up to the total budget so the newest scope's
    // fast-restore data is preferred if we ever have to trim.
    candidates.sort((a, b) => b.t - a.t);
    const out: Array<{ k: any; d: any; t: number }> = [];
    let total = 0;
    for (const c of candidates) {
      if (total + c.bytes > MAX_TOTAL_BYTES) continue;
      total += c.bytes;
      out.push({ k: c.k, d: c.d, t: c.t });
    }
    // Nothing curated is loaded yet (very early boot) — leave any existing blob
    // in place rather than wiping a good restore snapshot.
    if (out.length === 0) return;
    // Stamp the snapshot with the owning user id (see currentSessionUserId).
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ uid, entries: out }));
  } catch { /* localStorage may be unavailable (private browsing) */ }
}

// Serialize during idle time (never on the hot cache-event path). requestIdleCallback
// runs snapshotCache when the main thread is free; setTimeout is the fallback.
function idleSnapshot(): void {
  const w = window as any;
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(() => snapshotCache(), { timeout: 2000 });
  } else {
    setTimeout(snapshotCache, 0);
  }
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

    // [PERF 2026-07-31 "one refresh, not twenty"] Restored entries used to be
    // seeded with their persisted timestamp, so refetchOnMount saw every one
    // of them as stale and re-fired ~20 background requests on EVERY launch —
    // a fan-out that regularly landed on a cold serverless instance and kept
    // skeletons/"loading" tiles up past the 12s guard. Now only the bootstrap
    // entry keeps its old timestamp (making it the ONE query that refetches);
    // everything else is seeded fresh. When that single bootstrap refetch
    // lands, seedDashboardCaches overwrites all dependent keys with fresh
    // rows — so staleness is bounded by one round trip, not by the blob age.
    const seededAt = Date.now();
    let bootstrapEntry: { k: any; d: any; t: number } | null = null;
    for (const entry of entries) {
      // Only seed if no fresh data exists
      const existing = queryClient.getQueryData(entry.k as any);
      if (existing !== undefined) continue;
      const isBootstrap = Array.isArray(entry.k) && entry.k[0] === "/api/dashboard-bootstrap";
      queryClient.setQueryData(entry.k as any, entry.d, { updatedAt: isBootstrap ? entry.t : seededAt });
      if (isBootstrap) {
        bootstrapEntry = entry as { k: any; d: any; t: number };
      }
    }

    // PERF Phase 1 (extend instant-paint to every tab): the persisted bootstrap
    // blob already carries the mount-time datasets for ~24 dependent list slots
    // (tasks, expenses, obligations, habits, goals, journal, events, documents,
    // trackers, reminders, …). Re-run the SAME seeding the dashboard does at
    // runtime so those tabs paint cached rows BEFORE React mounts, instead of
    // skeletoning on every cold reload. This reuses bytes already in
    // localStorage — no extra persistence cost. The bootstrap key encodes the
    // scope it was captured under: ["/api/dashboard-bootstrap", mode, ...ids, month].
    if (bootstrapEntry) {
      const k = bootstrapEntry.k as unknown[];
      const mode = String(k[1] ?? "everyone");
      const month = k.length > 2 ? String(k[k.length - 1]) : "";
      const ids = k.slice(2, Math.max(2, k.length - 1)).map(String);
      // Seeded FRESH (see the block above): the stale bootstrap query is the
      // single designated refresher; its landing re-seeds every one of these
      // keys via seedDashboardCaches. Seeding them stale here re-created the
      // ~20-request launch fan-out this pass exists to remove. Only fill empty
      // slots (never clobber a fresher restore).
      for (const entry of bootstrapSeedEntries(bootstrapEntry.d, mode, ids, month)) {
        const { key, data } = entry;
        if (queryClient.getQueryData(key as any) !== undefined) continue;
        // A list projectBootstrapShell truncated is NOT the whole list, so it
        // must not be stamped fresh — otherwise a heavy-data user paints their
        // first SHELL_MAX_ROWS rows and keeps them for the full staleTime.
        // Stamping it with the persisted timestamp makes it stale on arrival:
        // the rows still paint instantly, and refetchOnMount completes them in
        // the background. Complete lists keep the fresh stamp, so this does not
        // reintroduce the launch-time refetch fan-out.
        const updatedAt = isTrimmedSeedEntry(entry, bootstrapEntry.d) ? bootstrapEntry.t : seededAt;
        queryClient.setQueryData(key as any, data, { updatedAt });
      }
    }
  } catch {
    // Corrupt cache — purge it rather than risk a partial/cross-user restore.
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}

/* ---------------------------------------------------------------------------
   Wedged-query recovery (stuck-skeleton fix, 2026-07-16).

   Mobile Safari orphans in-flight fetches when it suspends a tab: the promise
   never resolves OR rejects, and the setTimeout driving our AbortController is
   frozen too, so the 60s abort never fires. On resume the query observer is
   still fetchStatus:"fetching", and React Query refuses to start a second
   fetch for a query it believes is already fetching — refetchOnWindowFocus,
   refetchOnReconnect, invalidateQueries, and pull-to-refresh ALL no-op.
   Result: whatever that query gates renders skeleton forever.

   The fix: on resume, CANCEL any query that has been in-flight since before
   the tab was hidden (cancel resolves the orphaned promise via the abort
   signal), then invalidate actively-observed /api/* queries so on-screen data
   refetches. Cached data stays rendered throughout — no skeleton wipe.
--------------------------------------------------------------------------- */
let hiddenAt = 0;

// Resume dedupe: visibilitychange, pageshow(persisted), and auth's own resume
// hook can all fire within the same instant when the app comes back to the
// foreground. Collapse them so recovery runs at most once per real resume —
// this is what makes return-to-app a SINGLE refresh path.
const RESUME_DEDUP_MS = 3_000;
let lastRecoverAt = 0;

export async function recoverWedgedQueries(): Promise<void> {
  const now = Date.now();
  if (now - lastRecoverAt < RESUME_DEDUP_MS) return;
  lastRecoverAt = now;
  try {
    const isApiQuery = (q: { queryKey?: readonly unknown[] }) =>
      String(q.queryKey?.[0] || "").startsWith("/api/");
    const all = queryClient.getQueryCache().getAll();
    const wedged = all.filter((q) =>
      q.state.fetchStatus === "fetching" && isApiQuery(q),
    );
    // FROZEN-REJECTION FIX (2026-07-21): a fetch can also REJECT while the tab
    // is frozen (socket killed by the OS, an abort timer firing mid-freeze).
    // Such a query isn't "fetching" on resume — it sits in error state (or,
    // after a cancel-with-revert, back in pending/idle with no data). Focus
    // refetch fires ONCE at resume; if the rejection lands after that instant
    // (5G radio still waking up), nothing ever re-triggers the query and the
    // section's skeleton/guard sits forever. On resume we also invalidate
    // actively-observed /api queries that are errored or dataless-idle so they
    // get exactly one fresh attempt. Bounded: active observers only, /api only.
    const failedWhileAway = all.filter((q) =>
      isApiQuery(q) &&
      q.state.fetchStatus !== "fetching" &&
      q.isActive() &&
      (q.state.status === "error" ||
        (q.state.status === "pending" && q.state.data === undefined)),
    );
    // Nothing is actually stuck — do NOT touch the cache. With focus/reconnect
    // refetch disabled (see queries defaults above), a settled cache on resume
    // means there is genuinely nothing to refresh: cached data stays rendered
    // and freshness arrives via mutation-driven invalidation. A blanket
    // invalidate here (the old behavior) fired a redundant refetch wave on
    // every tab return — exactly the storm this fix removes.
    if (wedged.length === 0 && failedWhileAway.length === 0) return;

    if (wedged.length > 0) {
      // Cancel ONLY the orphaned in-flight queries — cancel resolves their frozen
      // promises via the abort signal so React Query will start fresh fetches.
      await queryClient.cancelQueries({
        predicate: (q) => q.state.fetchStatus === "fetching" && isApiQuery(q),
      });
    }
    // Refetch ONLY what we just unwedged or what failed while frozen (and only
    // if actively observed), so a stuck query recovers without triggering a
    // blanket /api sweep.
    const recoverKeys = [...wedged, ...failedWhileAway].map((q) => q.queryKey);
    await queryClient.invalidateQueries({
      predicate: (q) => recoverKeys.some((k) => JSON.stringify(k) === JSON.stringify(q.queryKey)),
      refetchType: "active",
    });
  } catch { /* recovery is best-effort — never throw from a lifecycle handler */ }
}

// Persistence is driven by IDLE + lifecycle events, NOT by every cache event.
// A periodic idle tick captures fresh data mid-session; pagehide/visibility
// hidden flush synchronously before the tab is frozen or closed.
if (typeof window !== "undefined") {
  // Periodic idle snapshot — captures the latest curated data during a long
  // session without hooking the hot query-cache event stream.
  setInterval(idleSnapshot, 30_000);
  // Flush synchronously when the tab is being frozen/closed — these fire before
  // the browser can discard the page, so the snapshot must be synchronous.
  window.addEventListener("pagehide", () => { snapshotCache(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      snapshotCache();
    } else if (document.visibilityState === "visible") {
      // Only run recovery after a real absence (≥15s) — quick tab flips
      // shouldn't cancel healthy in-flight requests.
      if (hiddenAt && Date.now() - hiddenAt >= 15_000) void recoverWedgedQueries();
      hiddenAt = 0;
    }
  });
  // bfcache restore (iOS back/forward, app switcher): the page resumes with
  // whatever promise graveyard it was frozen with — same recovery applies.
  window.addEventListener("pageshow", (e: PageTransitionEvent) => {
    if (e.persisted) void recoverWedgedQueries();
  });
}
