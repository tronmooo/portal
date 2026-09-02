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
import { ownedAssetIds, type AssetPartyLinkLike } from "./cost-of-ownership";

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
  /**
   * Co-ownership (asset_party_links). With these, selecting a person also
   * selects the assets that person owns or co-owns, so the car's bill, tasks
   * and documents show for its co-owner the way its expenses always did.
   */
  assetPartyLinks?: ReadonlyArray<AssetPartyLinkLike> | null;
}

/**
 * The selection widened with the assets the selected people own (parent
 * chain) or co-own (party links). Only expenses used to get this widening
 * (shared/cost-of-ownership); every scoped list now does.
 */
export function effectiveSelection(ctx: ProfileFilterContext): string[] {
  const ids = ctx.selectedIds || [];
  if (ids.length === 0) return ids;
  const owned = ownedAssetIds(ids, ctx.allProfiles as any, (ctx.assetPartyLinks || []) as any);
  if (owned.size === 0) return ids;
  return Array.from(new Set([...ids, ...owned]));
}

/**
 * The selection as a DB containment filter can use it: every profile whose
 * ancestor-or-self is in the effective selection. `passesProfileFilter`
 * widens each row's LINKED ids with their ancestors before matching; a
 * pushed-down `linked_profiles && ids` filter cannot, so the same rule is
 * expressed from the other side — widen the SELECTION with its descendants.
 * The two agree on every row (some linked id has an ancestor-or-self in the
 * selection ⇔ some linked id is in this closure), except the orphan rule,
 * which pushdown callers keep on the fetch-all path.
 */
export function pushdownSelection(ctx: ProfileFilterContext): string[] {
  const base = effectiveSelection(ctx);
  if (base.length === 0) return base;
  const out = new Set(base);
  const children = new Map<string, string[]>();
  for (const p of ctx.allProfiles || []) {
    if (!p || typeof p.id !== "string" || !p.parentProfileId) continue;
    const arr = children.get(p.parentProfileId);
    if (arr) arr.push(p.id); else children.set(p.parentProfileId, [p.id]);
  }
  const stack = [...base];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const kid of children.get(cur) || []) {
      if (out.has(kid)) continue; // cycle-safe
      out.add(kid);
      stack.push(kid);
    }
  }
  return Array.from(out);
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
    { selectedIds: effectiveSelection(ctx), selfIds: selfIdsFrom(ctx.allProfiles) },
    "belongs_to_self",
  );
}
