// Universal multi-select profile filter state
// Persists in sessionStorage across navigation within the same session.
// "everyone" mode = no filter applied, all data shown (default).
// Otherwise, selectedIds contains the checked profile IDs.

const STORAGE_KEY = "portol_profile_filter";
const LOCAL_KEY = "portol_profile_filter_v2"; // localStorage for persistence across sessions

export type FilterMode = "everyone" | "selected";

interface FilterState {
  mode: FilterMode;
  selectedIds: string[]; // profile IDs that are checked
  selectedNames: string[]; // parallel array for display
}

let _state: FilterState = loadFromStorage();

function loadFromStorage(): FilterState {
  try {
    // Try localStorage first (persistent), then sessionStorage (legacy)
    const raw = localStorage.getItem(LOCAL_KEY) || sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { mode: "everyone", selectedIds: [], selectedNames: [] };
}

function saveToStorage() {
  try {
    const json = JSON.stringify(_state);
    localStorage.setItem(LOCAL_KEY, json);
    sessionStorage.setItem(STORAGE_KEY, json); // backward compat
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

/** Validate stored filter against current profile list — clear stale IDs */
export function validateFilter(currentProfileIds: string[]) {
  if (_state.mode === "everyone") return;
  const validIds: string[] = [];
  const validNames: string[] = [];
  for (let i = 0; i < _state.selectedIds.length; i++) {
    if (currentProfileIds.includes(_state.selectedIds[i])) {
      validIds.push(_state.selectedIds[i]);
      validNames.push(_state.selectedNames[i]);
    }
  }
  if (validIds.length === 0) {
    _state = { mode: "everyone", selectedIds: [], selectedNames: [] };
    saveToStorage();
  } else if (validIds.length !== _state.selectedIds.length) {
    _state = { mode: "selected", selectedIds: validIds, selectedNames: validNames };
    saveToStorage();
  }
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

// ── React hook for centralized filter management ──────────────────────
// Import React hooks dynamically to keep this file usable in non-React contexts
import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

/**
 * Centralized hook for profile filter state.
 * - Reads initial state from localStorage
 * - Validates stored profiles against current DB profiles
 * - Clears stale profile IDs automatically
 * - Returns current filter state + onChange handler for MultiProfileFilter
 */
export function useProfileFilter() {
  const { data: profiles } = useQuery<{ id: string; name: string }[]>({ queryKey: ["/api/profiles"] });
  const [filterIds, setFilterIds] = useState<string[]>(() => getProfileFilter().selectedIds);
  const [filterMode, setFilterMode] = useState<FilterMode>(() => getProfileFilter().mode);
  const validatedRef = useRef(false);

  // Validate stored filter against actual profiles — clear stale IDs
  useEffect(() => {
    if (!profiles || profiles.length === 0 || validatedRef.current) return;
    validatedRef.current = true;
    const profileIds = profiles.map(p => p.id);
    validateFilter(profileIds);
    const updated = getProfileFilter();
    setFilterIds(updated.selectedIds);
    setFilterMode(updated.mode);
  }, [profiles]);

  const onChange = useCallback(({ mode, selectedIds }: { mode: FilterMode; selectedIds: string[] }) => {
    setFilterMode(mode);
    setFilterIds(selectedIds);
  }, []);

  return { filterIds, filterMode, onChange };
}
