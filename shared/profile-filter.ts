// Unified profile-filter rule used by BOTH the client UI and the server APIs.
//
// Rule: when a filter is active, items pass if any of their linkedProfiles is
// in the selection. Items with no linkedProfiles ("orphans") only pass when
// the active selection includes a self profile — matching the long-standing
// convention that legacy items with no link belong to "me".
//
// Why this lives in /shared: the previous code had four different
// implementations in /client/src/lib/profileFilter.ts, /server/storage.ts,
// /server/supabase-storage.ts and /client/src/pages/finance.tsx that
// disagreed on whether orphans show up. That made finance, calendar, the
// dashboard and individual pages return different answers for the same
// filter — which is exactly what the user calls out as breaking trust.

export interface ProfileLike {
  id: string;
  type?: string;
}

export interface ProfileFilterContext {
  /** IDs the user has explicitly selected. Empty array = no filter active. */
  selectedIds: string[];
  /**
   * The full list of known profiles. Only the `id` and `type` fields are
   * used, so callers can pass a slimmer shape if they want.
   */
  allProfiles: Pick<ProfileLike, "id" | "type">[];
}

/**
 * Returns true if any selected profile is a `self` profile. Used to decide
 * whether legacy/orphan items (no linkedProfiles) should show through the
 * filter. Memoize at the call site if you need to apply this hot.
 */
export function selfInSelection(ctx: ProfileFilterContext): boolean {
  if (!ctx.selectedIds.length) return false;
  return ctx.selectedIds.some(id =>
    ctx.allProfiles.find(p => p.id === id)?.type === "self"
  );
}

/**
 * Single source of truth for "does this entity pass the active profile
 * filter?". `linkedProfiles` is whatever the entity stores (string[] or
 * undefined for legacy rows). Pass the same `selectedIds` you'd pass to the
 * server as `?profileIds=`.
 */
export function passesProfileFilter(
  linkedProfiles: string[] | undefined | null,
  ctx: ProfileFilterContext,
): boolean {
  if (!ctx.selectedIds || ctx.selectedIds.length === 0) return true;
  const linked = Array.isArray(linkedProfiles) ? linkedProfiles : [];
  if (linked.length === 0) {
    // Orphan: only show when the user has explicitly chosen the self
    // profile. Otherwise we'd leak unrelated legacy data into a filtered
    // view (e.g. selecting only "Bob" and seeing rows that have no link to
    // anyone).
    return selfInSelection(ctx);
  }
  return linked.some(id => ctx.selectedIds.includes(id));
}
