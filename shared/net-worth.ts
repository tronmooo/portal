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

// ----- Scope check (mirrors HeroKPIPopups isInScope exactly) -----
// A profile is "in scope" of the active filter when:
//   - the filter is not active ("everyone" or no ids), OR
//   - its id is selected, OR
//   - its parent (fields._parentProfileId / parentProfileId) is selected, OR
//   - any of its co-owners (fields.owners / fields.ownerIds /
//     fields.linkedProfileIds) is selected.
export function isProfileInNetWorthScope(p: any, ctx: NetWorthContext): boolean {
  if (!p) return false;
  if (ctx.mode !== "selected" || ctx.selectedIds.length === 0) return true;
  if (ctx.selectedIds.includes(p.id)) return true;

  const parentId = p?.fields?._parentProfileId || p?.parentProfileId;
  if (parentId && ctx.selectedIds.includes(parentId)) return true;

  const ownerIds: string[] = Array.isArray(p?.fields?.owners)
    ? p.fields.owners.map((o: any) => o?.profileId || o?.id || o).filter(Boolean)
    : Array.isArray(p?.fields?.ownerIds)
    ? p.fields.ownerIds
    : Array.isArray(p?.fields?.linkedProfileIds)
    ? p.fields.linkedProfileIds
    : [];
  if (ownerIds.some((id) => ctx.selectedIds.includes(id))) return true;

  return false;
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
