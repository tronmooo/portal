// shared/profile-selection.ts — the pure toggle rule for a profile selection.
//
// The global scope store (client/src/lib/profileFilter.ts toggleFilterProfile)
// and any LOCAL selection (the calendar's person filter, QA 2026-09-18 F-03)
// must toggle by the same rule: switching from Everyone starts a single
// selection, deselecting the last remaining profile is a no-op (an empty
// selection is not a scope), and names travel in a parallel array.

export interface ProfileSelection {
  mode: "everyone" | "selected";
  selectedIds: string[];
  selectedNames: string[];
}

export const EVERYONE_SELECTION: ProfileSelection = Object.freeze({
  mode: "everyone", selectedIds: [], selectedNames: [],
}) as ProfileSelection;

/** A new selection with `id` toggled. Never mutates the input. */
export function toggleScopeSelection(current: ProfileSelection, id: string, name: string): ProfileSelection {
  if (current.mode === "everyone") {
    return { mode: "selected", selectedIds: [id], selectedNames: [name] };
  }
  const idx = current.selectedIds.indexOf(id);
  if (idx >= 0) {
    if (current.selectedIds.length === 1) return current; // never empty the selection
    return {
      mode: "selected",
      selectedIds: current.selectedIds.filter((_, i) => i !== idx),
      selectedNames: current.selectedNames.filter((_, i) => i !== idx),
    };
  }
  return {
    mode: "selected",
    selectedIds: [...current.selectedIds, id],
    selectedNames: [...current.selectedNames, name],
  };
}
