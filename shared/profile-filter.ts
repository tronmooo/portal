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
//
// Stage 0 (BUG-20260528-scope-unification): the final intersect/orphan
// decision is now delegated to `isInScope` in `shared/scope.ts`. This file
// stays the entity-level entry point (it knows how to extract a candidate
// owner-id set from an entity's `linkedProfiles`) but the actual answer
// comes from the same primitive that `shared/net-worth.ts` uses, so the two
// scope checks can no longer drift apart on the core question.

import { isInScope, selfIdsFrom, withAncestorOwnerIds } from "./scope";

export interface ProfileLike {
  id: string;
  type?: string;
  /** Owner chain: a car's bill is the car's, and so the car owner's. */
  parentProfileId?: string | null;
}

export interface ProfileFilterContext {
  /** IDs the user has explicitly selected. Empty array = no filter active. */
  selectedIds: string[];
  /**
   * The full list of known profiles. Only the `id` and `type` fields are
   * used, so callers can pass a slimmer shape if they want.
   */
  allProfiles: Pick<ProfileLike, "id" | "type" | "parentProfileId">[];
}

/**
 * Returns true if any selected profile is a `self` profile. Used to decide
 * whether legacy/orphan items (no linkedProfiles) should show through the
 * filter. Memoize at the call site if you need to apply this hot.
 *
 * Kept exported for backward compatibility with existing call sites. Its
 * answer is unchanged — it now derives `selfIds` the same way `isInScope`
 * does internally.
 */
export function selfInSelection(ctx: ProfileFilterContext): boolean {
  if (!ctx.selectedIds.length) return false;
  const selfIds = selfIdsFrom(ctx.allProfiles);
  return ctx.selectedIds.some(id => selfIds.has(id));
}

/**
 * Single source of truth for "does this entity pass the active profile
 * filter?". `linkedProfiles` is whatever the entity stores (string[] or
 * undefined for legacy rows). Pass the same `selectedIds` you'd pass to the
 * server as `?profileIds=`.
 *
 * Stage 0: implementation delegates to `isInScope` so this function and
 * `isProfileInNetWorthScope` can never disagree on the core decision again.
 * Public behavior is unchanged — see tests/profile-filter.test.ts.
 */
export function passesProfileFilter(
  linkedProfiles: string[] | undefined | null,
  ctx: ProfileFilterContext,
): boolean {
  // An item linked to a profile is also in scope for that profile's owners:
  // the insurance bill linked to the Honda (parent: Self) is Self's bill, and
  // Linda's car's registration is Linda's. Without the walk, the Self view
  // dropped every bill and expense attached to the user's own car, home or
  // account from the bills list and the cash-flow total.
  const linked = withAncestorOwnerIds(
    Array.isArray(linkedProfiles) ? linkedProfiles.filter((id): id is string => typeof id === "string" && !!id) : [],
    ctx.allProfiles,
  );
  return isInScope(
    linked,
    { selectedIds: ctx.selectedIds, selfIds: selfIdsFrom(ctx.allProfiles) },
    "belongs_to_self",
  );
}
