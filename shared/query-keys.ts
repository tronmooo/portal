// ─── Canonical query key shapes ─────────────────────────────────────
// Why this exists: query keys must be IDENTICAL across every page that
// reads the same data, otherwise React Query stores them as separate
// caches and `setQueryData` from one page won't show up on another.
// Historically, dashboard.tsx used `["/api/goals", "id1,id2"]` while
// trackers.tsx used `["/api/goals"]` — both invalidated correctly
// (prefix match) but optimistic deletes from one page never updated
// the other's cache slot. See finding 6.1 in audit/stabilization-findings.md.
//
// There is exactly ONE profile-scope convention in the live app, and it is
// the one the dashboard persists/seeds and every tab reads:
//
//   [endpoint, mode, ...selectedIds, ...extra]
//
// where:
//   - mode is "everyone" when no profile filter is applied, or "selected"
//     when one or more profile IDs are chosen (mirrors profileFilter's
//     FilterMode so client keys and the bootstrap seed collapse to one slot).
//   - selectedIds are appended verbatim (the live filter store holds no ids in
//     "everyone" mode, so steady-state "everyone" keys carry none — keeping the
//     key bit-identical to the historical ad-hoc `[endpoint, filterMode, ...ids]`
//     the tab readers already build).
//   - extra are trailing sub-slice discriminators (e.g. "hero", "trends", a
//     month string) appended verbatim after the scope segment.
//
// A previous "all"/"selected" helper (profileFilteredKey/profileScopeKey) used
// a DIFFERENT first segment ("all" vs "everyone") and was never wired into a
// live query — any code reaching for it would have silently missed the live
// cache. It has been removed in favor of this single builder.

export type ProfileFilterMode = "everyone" | "selected";

/**
 * The one canonical builder for a profile-scoped react-query key. Every live
 * caller (dashboard bootstrap seed, pre-mount hydration, and the list tabs)
 * MUST route through this so their caches collapse to the same slot.
 *
 * Output matches the live convention exactly:
 *   scopedKey("/api/tasks", "everyone", [])          -> ["/api/tasks", "everyone"]
 *   scopedKey("/api/tasks", "selected", ["b","a"])   -> ["/api/tasks", "selected", "b", "a"]
 *   scopedKey("/api/incomes", "everyone", [], "hero")-> ["/api/incomes", "everyone", "hero"]
 *
 * IDs are appended verbatim (falsy entries dropped). Order is preserved as
 * given — all live callers read the selection from the single profileFilter
 * store, so the order is stable and the key is bit-identical to the historical
 * ad-hoc `[endpoint, filterMode, ...ids, ...extra]` the tab readers build.
 */
export function scopedKey(
  endpoint: string,
  mode: ProfileFilterMode,
  profileIds: string[] = [],
  ...extra: unknown[]
): readonly unknown[] {
  const ids = (profileIds || []).filter(Boolean);
  return [endpoint, mode, ...ids, ...extra] as const;
}

// Build a canonical key for /api/goals. Both dashboard and trackers MUST use
// this so their caches collapse to the same slot. Mode is inferred from the
// id set: every live caller passes [] for the unfiltered ("everyone") scope
// and a non-empty selection otherwise, so this matches the ad-hoc keys the
// dashboard bootstrap seeds under scopedKey("/api/goals", ...).
export function goalsQueryKey(profileIds: string[] = []): readonly unknown[] {
  const ids = (profileIds || []).filter(Boolean);
  return ids.length === 0
    ? scopedKey("/api/goals", "everyone", [])
    : scopedKey("/api/goals", "selected", ids);
}
