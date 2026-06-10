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

/** Get the current filter state */
export function getProfileFilter(): FilterState {
  return { ..._state };
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

/** Set filter to "everyone" (no filtering) */
export function setFilterEveryone() {
  _state = { mode: "everyone", selectedIds: [], selectedNames: [] };
  saveToStorage();
}

/** Set filter to specific profile IDs */
export function setFilterSelected(ids: string[], names: string[]) {
  _state = { mode: "selected", selectedIds: [...ids], selectedNames: [...names] };
  saveToStorage();
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
