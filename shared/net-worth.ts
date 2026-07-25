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
  isNetWorthLiabilityProfile,
} from "./asset-value";
import { isInScope } from "./scope";
import { shareForParties, type OwnershipLink } from "./ownership-model";

export type ProfileFilterMode = "everyone" | "selected";

/**
 * The relational ownership tables, in the shape the API returns them.
 *
 * Supplying these makes `computeNetWorth` ownership-adjusted: a 50%-owned
 * house contributes $250k to its co-owner's net worth, not $500k. WITHOUT
 * them the function falls back to whole values, which is only correct for an
 * unfiltered ("everyone") household total.
 *
 * QA report 2026-07-25: "House: $250,000 in Finance but $500,000 in Assets …
 * Mike's mortgage: $174,444 in Finance but $348,888.89 in Liabilities. This
 * looks like ownership percentages are applied in one component but ignored
 * in another." They were: the server finance snapshot multiplied by
 * `shareForParties`, this module did not, and each surface picked one.
 */
export interface OwnershipTables {
  /** `asset_party_links` rows. */
  assetLinks?: ReadonlyArray<{
    assetProfileId?: string | null;
    partyProfileId?: string | null;
    ownershipPercentage?: number | string | null;
    role?: string | null;
  }> | null;
  /** `liability_profile_links` rows. */
  liabilityLinks?: ReadonlyArray<{
    liabilityProfileId?: string | null;
    partyProfileId?: string | null;
    ownershipPercentage?: number | string | null;
    role?: string | null;
  }> | null;
  /** Self profile id — an item with no explicit links is Self's at 100%. */
  selfProfileId?: string | null;
}

export interface NetWorthContext {
  mode: ProfileFilterMode;
  selectedIds: string[];
  /**
   * Ownership link tables. Omit ONLY when the caller genuinely wants whole
   * values (e.g. a household "everyone" total, where every share sums to 100%
   * anyway). Any per-person figure must pass them.
   */
  ownership?: OwnershipTables;
}

/** One line of the balance sheet, mirroring the server's breakdown rows. */
export interface NetWorthRow {
  id: string;
  name: string;
  type: string;
  /** Full value of the item, before ownership is applied. */
  grossValue: number;
  /** Percentage of the item attributable to the current scope (0–100). */
  share: number;
  /** grossValue × share / 100 — the number to display. */
  value: number;
  /** The originating profile, for callers that need more than the summary. */
  profile: any;
}

export interface NetWorthResult {
  assets: number;
  liabilities: number;
  netWorth: number;
  assetProfiles: any[];
  liabilityProfiles: any[];
  /** Per-item breakdown. `assetRows` always sums to `assets` exactly. */
  assetRows: NetWorthRow[];
  liabilityRows: NetWorthRow[];
}

// ----- Scope check -----
// A profile is "in scope" of the active filter when:
//   - the filter is not active ("everyone" or no ids), OR
//   - its id is selected, OR
//   - its parent (parentProfileId column) is selected, OR
//   - any of its co-owners is selected.
//
// Stage 0 (BUG-20260528-scope-unification): the intersect decision is
// delegated to `isInScope` in `shared/scope.ts` — the same primitive
// `passesProfileFilter` uses. This file's responsibility is now ONLY
// extracting the candidate owner-id set; the actual "any candidate id in
// selection?" answer comes from one place.
//
// Stage 7 (FIX 2 of the divergence elimination): co-owner candidates for
// asset/liability profiles come exclusively from the relational link tables
// (`asset_party_links`, `liability_profile_links`). They must be supplied by
// the caller via `coOwnerIds`. The legacy in-JSON shapes (`fields.owners`,
// `fields.ownerIds`, `fields.linkedProfileIds`) are no longer consulted —
// they were extinct in production (0 rows) and their presence in the reader
// made the data path quietly accept stale ghost-state.
//
// Orphan policy is `out_of_scope` because every profile is its own owner
// (its `id` is always in the candidate set), so the absent-candidate branch
// in `isInScope` is unreachable here — picking `out_of_scope` makes that
// intent explicit and prevents a malformed profile from silently landing in
// someone else's net worth.
function extractCandidateOwnerIds(p: any, coOwnerIds?: readonly string[]): string[] {
  if (!p) return [];
  const ids: string[] = [];
  if (typeof p.id === "string" && p.id) ids.push(p.id);
  // Parent pointer: the `parentProfileId` column is the source of truth.
  //   The legacy `fields._parentProfileId` JSON shadow disagreed with the
  //   column on 3 production rows (column null, JSON set) before the Stage 7
  //   backfill that mirrored every JSON pointer back to the column.
  const parentId = p?.parentProfileId;
  if (typeof parentId === "string" && parentId) ids.push(parentId);
  if (coOwnerIds && coOwnerIds.length > 0) {
    for (const oid of coOwnerIds) {
      if (typeof oid === "string" && oid) ids.push(oid);
    }
  }
  return ids;
}

export function isProfileInNetWorthScope(
  p: any,
  ctx: NetWorthContext,
  coOwnerIds?: readonly string[],
): boolean {
  if (!p) return false;
  // Translate the net-worth-shaped context into the canonical ScopeContext.
  // The empty `selfIds` set is fine here because the `out_of_scope` orphan
  // policy never consults selfIds — we keep the type-correct shape so the
  // primitive's contract is honored.
  const active = ctx.mode === "selected" && ctx.selectedIds.length > 0;
  if (!active) return true;
  return isInScope(
    extractCandidateOwnerIds(p, coOwnerIds),
    { selectedIds: ctx.selectedIds, selfIds: new Set<string>() },
    "out_of_scope",
  );
}

// ─── Balance sheet from the server snapshot ──────────────────────────────────
//
// The server's `financeSnapshot` already carries ownership-adjusted
// `assetBreakdown` / `liabilityBreakdown` rows AND the matching totals. Any
// surface that HIDES rows (the synthetic-test-data toggle) must recompute the
// totals from what's left, or the header stops matching the list.
//
// QA report 2026-07-25: "KPI header: $1,398,804 / Net Worth pop-up:
// $1,398,954 — a $150 difference on the same screen." The popup dropped the
// $150 QA liability row and re-summed; the KPI tile kept the server total that
// still included it. Both now call this, so the headline is BY CONSTRUCTION
// the sum of the visible rows.

export interface BalanceSheet {
  assets: any[];
  liabilities: any[];
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}

const EMPTY_SHEET: BalanceSheet = {
  assets: [], liabilities: [], totalAssets: 0, totalLiabilities: 0, netWorth: 0,
};

/**
 * Derive the displayable balance sheet from a server finance snapshot.
 *
 * `isHidden` is the row-visibility predicate (e.g. the test-entity filter).
 * Totals are ALWAYS the sum of the rows this function returns — never a
 * separately-reported figure — so the header and the list cannot disagree.
 *
 * Returns zeros when `snapshot` is absent; callers must treat that as "not
 * loaded yet" and render a loading state rather than a $0 total.
 */
export function balanceSheetFromSnapshot(
  snapshot: any,
  isHidden?: (row: any) => boolean,
): BalanceSheet {
  if (!snapshot) return EMPTY_SHEET;
  const rawAssets = Array.isArray(snapshot.assetBreakdown) ? snapshot.assetBreakdown : [];
  const rawLiabilities = Array.isArray(snapshot.liabilityBreakdown) ? snapshot.liabilityBreakdown : [];
  const assets = isHidden ? rawAssets.filter((r: any) => !isHidden(r)) : rawAssets;
  const liabilities = isHidden ? rawLiabilities.filter((r: any) => !isHidden(r)) : rawLiabilities;
  const totalAssets = assets.reduce((s: number, r: any) => s + (Number(r?.value) || 0), 0);
  const totalLiabilities = liabilities.reduce((s: number, r: any) => s + (Number(r?.value) || 0), 0);
  return { assets, liabilities, totalAssets, totalLiabilities, netWorth: totalAssets - totalLiabilities };
}

// ----- Ownership shares -----
// Index the link tables once per call so a 200-profile walk stays O(n).
function indexLinks(
  rows: ReadonlyArray<any> | null | undefined,
  itemKey: "assetProfileId" | "liabilityProfileId",
): Map<string, OwnershipLink[]> {
  const out = new Map<string, OwnershipLink[]>();
  for (const r of rows || []) {
    const itemId = r?.[itemKey];
    const partyId = r?.partyProfileId;
    if (typeof itemId !== "string" || !itemId) continue;
    if (typeof partyId !== "string" || !partyId) continue;
    const link: OwnershipLink = {
      partyProfileId: partyId,
      ownershipPercentage: Number(r.ownershipPercentage ?? 0),
      role: r.role ?? undefined,
    };
    const list = out.get(itemId);
    if (list) list.push(link);
    else out.set(itemId, [link]);
  }
  return out;
}

/**
 * The percentage of an item attributable to the active scope. Mirrors the
 * server finance snapshot's `shareForAsset` / `shareForLiability` exactly:
 *
 *   - no filter ("everyone")           → 100% (household total)
 *   - the item itself is selected      → 100% (you asked for that item)
 *   - otherwise                        → the selected parties' combined share,
 *                                        defaulting to Self-owns-100% when the
 *                                        item has no explicit owner links
 *
 * Returns 100 when no link tables were supplied, preserving the pre-ownership
 * behaviour for callers that only ever compute household totals.
 */
function shareForItem(
  p: any,
  ctx: NetWorthContext,
  links: Map<string, OwnershipLink[]>,
): number {
  const active = ctx.mode === "selected" && ctx.selectedIds.length > 0;
  if (!active) return 100;
  if (ctx.selectedIds.includes(p?.id)) return 100;
  return shareForParties(ctx.selectedIds, links.get(p?.id) || null, ctx.ownership?.selfProfileId ?? null);
}

/**
 * Compute net worth from a set of profiles under the given filter context.
 * Pure function — no I/O, no React hooks. Use inside useMemo on the client
 * and directly in server endpoints.
 *
 * Pass `ctx.ownership` whenever the result is scoped to specific people;
 * without it a jointly-owned asset is counted in full for every co-owner and
 * the per-person figures silently disagree with the Finance tab.
 */
export function computeNetWorth(profiles: any[], ctx: NetWorthContext): NetWorthResult {
  const assetProfiles: any[] = [];
  const liabilityProfiles: any[] = [];
  const assetRows: NetWorthRow[] = [];
  const liabilityRows: NetWorthRow[] = [];
  let assets = 0;
  let liabilities = 0;

  const hasTables = !!(ctx.ownership && (ctx.ownership.assetLinks || ctx.ownership.liabilityLinks));
  const assetLinkIndex = indexLinks(ctx.ownership?.assetLinks, "assetProfileId");
  const liabLinkIndex = indexLinks(ctx.ownership?.liabilityLinks, "liabilityProfileId");

  for (const p of profiles || []) {
    // With ownership tables present, the SHARE decides membership — exactly the
    // rule the server's finance snapshot uses (an item you own 0% of is not
    // yours, whatever it is nested under). Without them we fall back to the
    // legacy parent/co-owner scope gate at whole value, which is only right for
    // an unfiltered household total.
    if (!hasTables && !isProfileInNetWorthScope(p, ctx)) continue;

    if (isAssetProfile(p)) {
      const gross = resolveAssetValue(p);
      const share = gross > 0 ? shareForItem(p, ctx, assetLinkIndex) : 0;
      const value = (gross * share) / 100;
      if (gross > 0 && share > 0) {
        assets += value;
        assetProfiles.push(p);
        assetRows.push({ id: p.id, name: p.name, type: p.type, grossValue: gross, share, value, profile: p });
      }
    }
    if (isNetWorthLiabilityProfile(p)) {
      const gross = resolveLiabilityBalance(p);
      const share = gross > 0 ? shareForItem(p, ctx, liabLinkIndex) : 0;
      const value = (gross * share) / 100;
      if (gross > 0 && share > 0) {
        liabilities += value;
        liabilityProfiles.push(p);
        liabilityRows.push({ id: p.id, name: p.name, type: p.type, grossValue: gross, share, value, profile: p });
      }
    }
  }

  assetRows.sort((a, b) => b.value - a.value);
  liabilityRows.sort((a, b) => b.value - a.value);

  return {
    assets,
    liabilities,
    netWorth: assets - liabilities,
    assetProfiles,
    liabilityProfiles,
    assetRows,
    liabilityRows,
  };
}
