// ─── Canonical query key shapes ─────────────────────────────────────
// Why this exists: query keys must be IDENTICAL across every page that
// reads the same data, otherwise React Query stores them as separate
// caches and `setQueryData` from one page won't show up on another.
// Historically, dashboard.tsx used `["/api/goals", "id1,id2"]` while
// trackers.tsx used `["/api/goals"]` — both invalidated correctly
// (prefix match) but optimistic deletes from one page never updated
// the other's cache slot. See finding 6.1 in audit/stabilization-findings.md.
//
// Rule: when a query is profile-filterable, the key MUST be:
//   [endpoint, filterMode, ...filterIds]
// where:
//   - filterMode is "all" when no profile filter is applied, or
//     "selected" when one or more profile IDs are selected.
//   - filterIds are SORTED ascending so [a,b] and [b,a] produce the
//     same key.
// For queries that are not profile-filterable, the key is just [endpoint].

export type ProfileFilterMode = "all" | "selected";

// Build a canonical key for /api/goals. Both dashboard and trackers
// MUST use this so their caches collapse to the same slot.
export function goalsQueryKey(profileIds: string[] = []): readonly unknown[] {
  if (!profileIds || profileIds.length === 0) {
    return ["/api/goals", "all"] as const;
  }
  const sorted = [...profileIds].filter(Boolean).sort();
  return ["/api/goals", "selected", ...sorted] as const;
}

// Build a profile-filterable key for any endpoint.
export function profileFilteredKey(
  endpoint: string,
  profileIds: string[] = [],
): readonly unknown[] {
  if (!profileIds || profileIds.length === 0) {
    return [endpoint, "all"] as const;
  }
  const sorted = [...profileIds].filter(Boolean).sort();
  return [endpoint, "selected", ...sorted] as const;
}
