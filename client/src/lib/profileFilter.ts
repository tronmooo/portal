// Universal multi-select profile filter state
// Persists in sessionStorage across navigation within the same session.
// "everyone" mode = no filter applied, all data shown (default).
// Otherwise, selectedIds contains the checked profile IDs.

const STORAGE_KEY = "portol_profile_filter";

export type FilterMode = "everyone" | "selected";

interface FilterState {
  mode: FilterMode;
  selectedIds: string[]; // profile IDs that are checked
  selectedNames: string[]; // parallel array for display
}

let _state: FilterState = loadFromSession();

function loadFromSession(): FilterState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { mode: "everyone", selectedIds: [], selectedNames: [] };
}

function saveToSession() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
  } catch {}
}

// ── Public API ──────────────────────────────────────────────

/** Get the current filter state */
export function getProfileFilter(): FilterState {
  return { ..._state };
}

/** Set filter to "everyone" (no filtering) */
export function setFilterEveryone() {
  _state = { mode: "everyone", selectedIds: [], selectedNames: [] };
  saveToSession();
}

/** Set filter to specific profile IDs */
export function setFilterSelected(ids: string[], names: string[]) {
  _state = { mode: "selected", selectedIds: [...ids], selectedNames: [...names] };
  saveToSession();
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
  saveToSession();
}

/** Check if a specific profile ID passes the current filter */
export function passesFilter(linkedProfileIds: string[] | undefined | null): boolean {
  if (_state.mode === "everyone") return true;
  if (!linkedProfileIds || linkedProfileIds.length === 0) {
    // Items with no linked profiles: show if "everyone", hide if filtering
    return false;
  }
  return linkedProfileIds.some(id => _state.selectedIds.includes(id));
}

/** Get display label for the current filter */
export function getFilterLabel(): string {
  if (_state.mode === "everyone") return "Everyone";
  if (_state.selectedNames.length === 1) return _state.selectedNames[0];
  if (_state.selectedNames.length === 2) return _state.selectedNames.join(" & ");
  return `${_state.selectedNames[0]} +${_state.selectedNames.length - 1}`;
}

// ── Legacy compat (used by pages that still read single filter) ──
export function getDashboardProfileFilter(): { id: string | undefined; name: string } {
  if (_state.mode === "everyone") return { id: undefined, name: "Everyone" };
  if (_state.selectedIds.length === 1) return { id: _state.selectedIds[0], name: _state.selectedNames[0] };
  return { id: undefined, name: "Everyone" };
}

export function setDashboardProfileFilter(id: string | undefined, name: string) {
  if (!id) {
    setFilterEveryone();
  } else {
    setFilterSelected([id], [name]);
  }
}
