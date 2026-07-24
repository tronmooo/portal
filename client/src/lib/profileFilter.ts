// Universal multi-select profile filter state
// Persists in localStorage namespaced by authenticated user id, so signing
// out and back in as a different user on the same device does not leak the
// previous user's filter (ST3 fix).
// "everyone" mode = no filter applied, all data shown (default).
// Otherwise, selectedIds contains the checked profile IDs.

const STORAGE_KEY = "portol_profile_filter";
const LOCAL_KEY_BASE = "portol_profile_filter_v5"; // v5: default scope is now the Self profile (not "everyone")
const USER_ID_KEY = "portol_active_user_id";
const FILTER_EVENT = "portol:profile-filter-change";

export type FilterMode = "everyone" | "selected";

interface FilterState {
  mode: FilterMode;
  selectedIds: string[]; // profile IDs that are checked
  selectedNames: string[]; // parallel array for display
}

// Clean up old (un-namespaced) storage keys to prevent stale filter state
try {
  localStorage.removeItem("portol_profile_filter_v2");
  localStorage.removeItem("portol_profile_filter_v3");
  localStorage.removeItem("portol_profile_filter");
  sessionStorage.removeItem("portol_profile_filter");
} catch {}
// NOTE: we intentionally do NOT eagerly delete the v4 namespaced keys here —
// they belong to a per-user slot we can't enumerate cheaply. The v5 bump means
// any user without a v5 value is treated as "unset", so initDefaultProfileFilter
// will seed their Self profile on first load. Stale v4 keys are harmless.

/** Get the storage key for the currently-active user. Falls back to a global
 *  slot only if no user id is known yet (e.g. during initial page load before
 *  auth resolves). The global slot is cleared on sign-out via clearProfileFilterForUser(). */
function storageKey(): string {
  try {
    const uid = localStorage.getItem(USER_ID_KEY) || "";
    return uid ? `${LOCAL_KEY_BASE}:${uid}` : LOCAL_KEY_BASE;
  } catch {
    return LOCAL_KEY_BASE;
  }
}

let _state: FilterState = loadFromStorage();

// Referentially-stable snapshot for reactive consumers (useSyncExternalStore).
// getProfileFilter() intentionally returns a FRESH object every call (callers
// rely on that for defensive copies), which makes it unusable as a
// useSyncExternalStore snapshot — a new reference every render triggers an
// infinite re-render loop. `_snapshot` is rebuilt ONLY when the state actually
// changes (see rebuildSnapshot() callers) and returned as-is between changes,
// so Object.is sees a stable value until something really moves. This is the
// single reactive source of truth every page subscribes to via useProfileScope.
let _snapshot: Readonly<FilterState> = freezeState(_state);

function freezeState(s: FilterState): Readonly<FilterState> {
  return Object.freeze({
    mode: s.mode,
    selectedIds: Object.freeze([...s.selectedIds]) as string[],
    selectedNames: Object.freeze([...s.selectedNames]) as string[],
  });
}

/** Rebuild the stable snapshot after any mutation to `_state`. Cheap (small
 *  arrays); called once per state change, never per render. */
function rebuildSnapshot(): void {
  _snapshot = freezeState(_state);
}

function loadFromStorage(): FilterState {
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw) return JSON.parse(raw);
  } catch {}
  return { mode: "everyone", selectedIds: [], selectedNames: [] };
}

/** Auth layer calls this when a user signs in or the active session changes.
 *  Reloads the in-memory filter state from this user's namespaced key so the
 *  UI immediately shows their saved filter (or default "everyone"). */
export function setActiveUserForFilter(userId: string | null) {
  try {
    if (userId) {
      localStorage.setItem(USER_ID_KEY, userId);
    } else {
      localStorage.removeItem(USER_ID_KEY);
    }
  } catch {}
  _state = loadFromStorage();
  rebuildSnapshot();
  try {
    if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
      window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail: { ..._state } }));
    }
  } catch {}
}

/** Auth layer calls this on sign-out to clear in-memory state, the active
 *  user's namespaced slot, and any legacy global slot. Capturing the active
 *  userId BEFORE removing USER_ID_KEY is required so we can target the
 *  namespaced key — otherwise it would be left behind and rehydrated on the
 *  next sign-in for the same user (filter persists across sign-out). */
export function clearProfileFilterForUser() {
  _state = { mode: "everyone", selectedIds: [], selectedNames: [] };
  rebuildSnapshot();
  try {
    const uid = localStorage.getItem(USER_ID_KEY) || "";
    if (uid) localStorage.removeItem(`${LOCAL_KEY_BASE}:${uid}`);
    localStorage.removeItem(USER_ID_KEY);
    localStorage.removeItem(LOCAL_KEY_BASE); // legacy global slot
    sessionStorage.removeItem(STORAGE_KEY); // backward compat slot
  } catch {}
  try {
    if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
      window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail: { ..._state } }));
    }
  } catch {}
}

function saveToStorage() {
  // Refresh the reactive snapshot FIRST so any synchronous listener that reads
  // getProfileFilterSnapshot() in response to the event below sees the new value.
  rebuildSnapshot();
  try {
    const json = JSON.stringify(_state);
    localStorage.setItem(storageKey(), json);
    sessionStorage.setItem(STORAGE_KEY, json); // backward compat
  } catch {}
  // Broadcast so pages can sync their local state even if a child component's
  // onChange callback is stale or never fires.
  try {
    if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
      window.dispatchEvent(new CustomEvent(FILTER_EVENT, { detail: { ..._state } }));
    }
  } catch {}
}

/**
 * Subscribe to filter changes. Fires every time the filter is mutated through
 * the helpers in this module. Returns an unsubscribe function.
 */
export function subscribeProfileFilter(
  cb: (state: FilterState) => void
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as FilterState | undefined;
    cb(detail ? { ...detail } : getProfileFilter());
  };
  window.addEventListener(FILTER_EVENT, handler as EventListener);
  // Also react to other tabs writing to localStorage
  const storageHandler = (e: StorageEvent) => {
    // Only react to the current user's namespaced key (ST3 fix).
    if (e.key !== storageKey()) return;
    try {
      _state = e.newValue ? JSON.parse(e.newValue) : { mode: "everyone", selectedIds: [], selectedNames: [] };
      rebuildSnapshot();
      cb(getProfileFilter());
    } catch {}
  };
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(FILTER_EVENT, handler as EventListener);
    window.removeEventListener("storage", storageHandler);
  };
}

// ── Public API ──────────────────────────────────────────────

/** Get the current filter state. Returns a fresh defensive copy every call —
 *  safe to mutate, but NOT referentially stable. For reactive subscriptions use
 *  getProfileFilterSnapshot() with subscribeProfileFilterRaw() (see
 *  hooks/useProfileScope.ts), never this. */
export function getProfileFilter(): FilterState {
  return { ..._state };
}

/** Referentially-stable snapshot for useSyncExternalStore. The SAME object is
 *  returned until the filter actually changes, so it can drive React's external
 *  store subscription without an infinite loop. Treat the result as read-only. */
export function getProfileFilterSnapshot(): Readonly<FilterState> {
  return _snapshot;
}

/** Bare subscribe for useSyncExternalStore: invokes `onChange` (no args) on any
 *  filter mutation, including cross-tab storage writes. Returns an unsubscribe
 *  function. Built on subscribeProfileFilter so there is exactly one event path. */
export function subscribeProfileFilterRaw(onChange: () => void): () => void {
  return subscribeProfileFilter(() => onChange());
}

/** Whether the active user has an explicitly-stored filter choice. When false,
 *  the in-memory state is the "everyone" fallback and callers may seed a
 *  better default (the Self profile) via initDefaultProfileFilter(). */
export function hasStoredFilter(): boolean {
  try {
    return localStorage.getItem(storageKey()) != null;
  } catch {
    return false;
  }
}

/**
 * Seed the default scope on first load. The DEFAULT is the primary user — the
 * single `self` profile — so the app opens as that person's personal dashboard
 * rather than the aggregate "Everyone" view. Only runs when the user has made
 * no explicit choice yet (hasStoredFilter() === false). If there is no Self
 * profile, we leave the filter on "everyone" (the Household dashboard), which
 * is a sensible fallback when there is no single primary user.
 *
 * Idempotent: once a value is stored (here or via a user action) this is a
 * no-op, so a user who deliberately picks "Everyone" is never overridden.
 */
export function initDefaultProfileFilter(profiles: Array<{ id: string; name?: string; type?: string }> | null | undefined): void {
  if (hasStoredFilter()) return;
  if (!profiles || profiles.length === 0) return;
  const self = profiles.find(p => p?.type === "self");
  if (!self) return; // no primary user → keep Everyone (Household) default
  setFilterSelected([self.id], [self.name || "Me"]);
}

/**
 * Self-heal a persisted selection whose profile IDs no longer exist.
 *
 * The selection (ids + display names) persists in localStorage, but profiles
 * can be hard-deleted and recreated (QA cleanup, re-imports). When that
 * happens the stored id matches nothing: every module queries
 * `?profileIds=<dead-id>` and correctly returns empty, while the switcher
 * still shows the remembered name — the dashboard reads "Mike" yet every
 * tile is 0 even though Mike's data exists under a new id.
 *
 * Given a SUCCESSFULLY loaded, non-empty profile list (callers must not pass
 * transient/errored results — an empty list is ignored here as a guard):
 *   1. keep ids that still resolve,
 *   2. re-map dead ids to a live profile with the same stored name
 *      (people/pets/self preferred),
 *   3. drop ids that can't be re-mapped,
 *   4. if nothing survives, fall back to the Self profile (or Everyone).
 * No-op when every id already resolves, so it's safe to call on every load.
 */
export function reconcileProfileFilter(
  profiles: Array<{ id: string; name?: string; type?: string }> | null | undefined
): void {
  if (!profiles || profiles.length === 0) return;
  if (_state.mode !== "selected" || _state.selectedIds.length === 0) return;
  const live = (id: string) => profiles.some(p => p.id === id);
  if (_state.selectedIds.every(live)) return;

  const ids: string[] = [];
  const names: string[] = [];
  _state.selectedIds.forEach((id, i) => {
    const match = profiles.find(p => p.id === id);
    if (match) {
      ids.push(id);
      names.push(match.name || _state.selectedNames[i] || "");
      return;
    }
    const wanted = (_state.selectedNames[i] || "").trim().toLowerCase();
    if (!wanted) return; // dead id with no name to re-map by — drop
    const primary = ["self", "person", "pet"];
    const byName =
      profiles.find(p => primary.includes(p.type || "") && (p.name || "").trim().toLowerCase() === wanted && !ids.includes(p.id)) ||
      profiles.find(p => (p.name || "").trim().toLowerCase() === wanted && !ids.includes(p.id));
    if (byName) {
      ids.push(byName.id);
      names.push(byName.name || _state.selectedNames[i] || "");
    }
  });

  if (ids.length > 0) {
    _state = { mode: "selected", selectedIds: ids, selectedNames: names };
  } else {
    const self = profiles.find(p => p?.type === "self");
    _state = self
      ? { mode: "selected", selectedIds: [self.id], selectedNames: [self.name || "Me"] }
      : { mode: "everyone", selectedIds: [], selectedNames: [] };
  }
  saveToStorage();
}

// PERF Phase 2.2 (2026-07-16): the moment the scope changes, warm the new
// scope's dashboard-bootstrap and seed every scoped query key from its payload
// (lib/scope-prefetch.ts). Without this a switch re-keys ~45 dashboard queries
// against an empty cache — a wall of skeletons plus a serverless fan-out.
// Dynamic import mirrors setFilterEveryone's queryClient pattern below (this
// module must stay dependency-light; auth.tsx imports it at boot).
function warmScope(mode: FilterMode, ids: string[]): void {
  try {
    const idsCopy = [...ids];
    void import("./scope-prefetch").then((m) => {
      try { m.prefetchScopeBootstrap(mode, idsCopy); } catch { /* best-effort */ }
      // [PERF 2026-07-17] Also warm the SELECTED profile's detail bootstrap so
      // the Info tab opens instantly. onTouchStart/onMouseEnter in the profile
      // switcher fires the same warm, but iOS Safari does NOT emit hover before
      // tap in every navigation gesture (e.g. sidebar swipe + row tap), leaving
      // the Info tab as a blank 6-block skeleton until profile-bootstrap lands.
      // Firing at commit is fire-and-forget: warmProfileDetail dedupes inside a
      // 25s window and only warms the server's response cache — zero risk to
      // the client cache shape (that's still owned by profile-detail.tsx).
      if (mode === "selected" && idsCopy.length === 1) {
        try { m.warmProfileDetail(idsCopy[0]); } catch { /* best-effort */ }
      }
    }).catch(() => {});
  } catch { /* SSR / test envs without the module graph */ }
}

/** Set filter to "everyone" (no filtering) */
export function setFilterEveryone() {
  _state = { mode: "everyone", selectedIds: [], selectedNames: [] };
  saveToStorage();
  // BUG-20260715-everyone-zeros: entering Everyone must always re-aggregate.
  // Every dashboard query is keyed [endpoint, mode, ...ids]; the "everyone"
  // slots can hold junk that then renders as 0 in every category: entries
  // hydrated from the persisted localStorage snapshot (up to 24h old), or
  // fetched during the pre-hydration boot window (which can race auth and
  // cache empty results as success). Within the 60s global staleTime nothing
  // refetches, so the zeros stick. Invalidating the everyone-keyed slots on
  // every switch forces active views to refetch fresh aggregate data.
  // Dynamic import avoids a static cycle (queryClient ↔ profileFilter).
  try {
    void import("./queryClient").then(({ queryClient }) => {
      queryClient.invalidateQueries({
        predicate: (q) =>
          String(q.queryKey?.[0] || "").startsWith("/api/") &&
          q.queryKey?.[1] === "everyone",
      });
      // AFTER the everyone-keyed slots are invalidated (order matters — a
      // prefetch fired first would be immediately re-marked stale), warm the
      // aggregate scope in one bootstrap round trip.
      warmScope("everyone", []);
    }).catch(() => {});
  } catch { /* SSR / test envs without the module graph */ }
}

/** Set filter to specific profile IDs */
export function setFilterSelected(ids: string[], names: string[]) {
  _state = { mode: "selected", selectedIds: [...ids], selectedNames: [...names] };
  saveToStorage();
  warmScope("selected", ids);
}

/** Toggle a single profile in/out of the selection */
export function toggleFilterProfile(id: string, name: string) {
  if (_state.mode === "everyone") {
    // Switching from everyone to selected — start with just this one
    _state = { mode: "selected", selectedIds: [id], selectedNames: [name] };
  } else {
    const idx = _state.selectedIds.indexOf(id);
    if (idx >= 0) {
      _state.selectedIds.splice(idx, 1);
      _state.selectedNames.splice(idx, 1);
      // If nothing selected, go back to everyone
      if (_state.selectedIds.length === 0) {
        _state.mode = "everyone";
      }
    } else {
      _state.selectedIds.push(id);
      _state.selectedNames.push(name);
    }
  }
  saveToStorage();
  warmScope(_state.mode, _state.selectedIds);
}

// P2.5: the legacy passesFilter() helper was deleted — it hid orphan items
// (no linkedProfiles) whenever a filter was active, diverging from the
// canonical "orphans belong to self" rule. Use passesProfileFilter from
// @shared/profile-filter (with the loaded profile list) instead.

/** Get display label for the current filter */
export function getFilterLabel(): string {
  if (_state.mode === "everyone") return "Everyone";
  if (_state.selectedNames.length === 1) return _state.selectedNames[0];
  if (_state.selectedNames.length === 2) return _state.selectedNames.join(" & ");
  return `${_state.selectedNames[0]} +${_state.selectedNames.length - 1}`;
}

// P2.5: the legacy single-select compat shims getDashboardProfileFilter() /
// setDashboardProfileFilter() were deleted. Read getProfileFilter().selectedIds
// and write via setFilterSelected() / setFilterEveryone() instead.
