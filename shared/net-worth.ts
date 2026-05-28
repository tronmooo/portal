// shared/net-worth.ts — Canonical net-worth computation across profile sets.
//
// Replaces FOUR independent reimplementations (audit findings 2.4, 3.1, 3.4, 7.4):
//   - dashboard.tsx HeroKPISection (its own matchesProfileFilter missing co-owner arrays)
//   - dashboard.tsx FinanceSection (a third, slightly different filter)
//   - finance.tsx Net Worth KPI (reads enhanced.financeSnapshot, diverges client-side)
//   - profile-detail.tsx Financial Overview (truncated resolver, no useMemo)
// Plus the popup's canonical isInScope (HeroKPIPopups.tsx) which DOES cover
// co-ownership. This module copies that exact logic so all four surfaces
// agree to the dollar.

import {
  resolveAssetValue,
  resolveLiabilityBalance,
  isAssetProfile,
  isLiabilityProfile,
} from "./asset-value";
import { isInScope } from "./scope";

export type ProfileFilterMode = "everyone" | "selected";

export interface NetWorthContext {
  mode: ProfileFilterMode;
  selectedIds: string[];
}

export interface NetWorthResult {
  assets: number;
  liabilities: number;
  netWorth: number;
  assetProfiles: any[];
  liabilityProfiles: any[];
}

// ----- Scope check -----
// A profile is "in scope" of the active filter when:
//   - the filter is not active ("everyone" or no ids), OR
//   - its id is selected, OR
//   - its parent (fields._parentProfileId / parentProfileId) is selected, OR
//   - any of its co-owners (fields.owners / fields.ownerIds /
//     fields.linkedProfileIds) is selected.
//
// Stage 0 (BUG-20260528-scope-unification): the intersect decision is
// delegated to `isInScope` in `shared/scope.ts` — the same primitive
// `passesProfileFilter` uses. This file's responsibility is now ONLY
// extracting the candidate owner-id set from the profile's various legacy
// field shapes; the actual "any candidate id in selection?" answer comes
// from one place. Orphan policy is `out_of_scope` because every profile is
// its own owner (its `id` is always in the candidate set), so the absent-
// candidate branch in `isInScope` is unreachable here — picking
// `out_of_scope` makes that intent explicit and prevents a malformed
// profile from silently landing in someone else's net worth.
function extractCandidateOwnerIds(p: any): string[] {
  if (!p) return [];
  const ids: string[] = [];
  if (typeof p.id === "string" && p.id) ids.push(p.id);
  const parentId = p?.fields?._parentProfileId || p?.parentProfileId;
  if (typeof parentId === "string" && parentId) ids.push(parentId);
  if (Array.isArray(p?.fields?.owners)) {
    for (const o of p.fields.owners) {
      const oid = o?.profileId || o?.id || (typeof o === "string" ? o : null);
      if (typeof oid === "string" && oid) ids.push(oid);
    }
  } else if (Array.isArray(p?.fields?.ownerIds)) {
    for (const oid of p.fields.ownerIds) {
      if (typeof oid === "string" && oid) ids.push(oid);
    }
  } else if (Array.isArray(p?.fields?.linkedProfileIds)) {
    for (const oid of p.fields.linkedProfileIds) {
      if (typeof oid === "string" && oid) ids.push(oid);
    }
  }
  return ids;
}

export function isProfileInNetWorthScope(p: any, ctx: NetWorthContext): boolean {
  if (!p) return false;
  // Translate the net-worth-shaped context into the canonical ScopeContext.
  // The empty `selfIds` set is fine here because the `out_of_scope` orphan
  // policy never consults selfIds — we keep the type-correct shape so the
  // primitive's contract is honored.
  const active = ctx.mode === "selected" && ctx.selectedIds.length > 0;
  if (!active) return true;
  return isInScope(
    extractCandidateOwnerIds(p),
    { selectedIds: ctx.selectedIds, selfIds: new Set<string>() },
    "out_of_scope",
  );
}

/**
 * Compute net worth from a set of profiles under the given filter context.
 * Pure function — no I/O, no React hooks. Use inside useMemo on the client
 * and directly in server endpoints.
 */
export function computeNetWorth(profiles: any[], ctx: NetWorthContext): NetWorthResult {
  const assetProfiles: any[] = [];
  const liabilityProfiles: any[] = [];
  let assets = 0;
  let liabilities = 0;

  for (const p of profiles || []) {
    if (!isProfileInNetWorthScope(p, ctx)) continue;

    if (isAssetProfile(p)) {
      const v = resolveAssetValue(p);
      if (v > 0) {
        assets += v;
        assetProfiles.push(p);
      }
    }
    if (isLiabilityProfile(p)) {
      const v = resolveLiabilityBalance(p);
      if (v > 0) {
        liabilities += v;
        liabilityProfiles.push(p);
      }
    }
  }

  return {
    assets,
    liabilities,
    netWorth: assets - liabilities,
    assetProfiles,
    liabilityProfiles,
  };
}
