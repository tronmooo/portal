// Cost of ownership — surface an ASSET's expenses on its OWNER's profile
// WITHOUT duplicating the record.
//
// Single source of truth: an expense for an asset (e.g. "gas for my Honda")
// is linked to the ASSET only — one row, one link. The asset's own profile
// shows it directly (linkedProfiles[0] === assetId, matching the strict
// owner rule the Finance tab already uses). To let the OWNER see the full
// cost of ownership, we DERIVE the same rows from the assets that person
// owns — we never write a second link or a second expense, so every
// aggregate that sums the distinct expense set (dashboard, cash flow,
// budgets, reports) still counts each expense exactly once.

export interface OwnedAssetLike {
  id: string;
  name?: string;
  type?: string;
  /** This owner's share of the asset (0–100), when co-owned. */
  _ownershipPercentage?: number;
}

export interface ExpenseLike {
  id: string;
  amount?: number;
  linkedProfiles?: string[];
  [k: string]: any;
}

export interface OwnedAssetExpense<E extends ExpenseLike = ExpenseLike> {
  /** The original expense row, unchanged (same id — one record). */
  expense: E;
  /** The asset this cost belongs to. */
  viaAsset: { id: string; name: string; type?: string };
  /** Owner's share of the asset, if co-owned (else undefined = 100%). */
  ownershipPercentage?: number;
}

/**
 * Given the asset profiles a person owns and the full expense set, return the
 * expenses that belong to those assets — each expense at most once, attributed
 * to the asset it was created under.
 *
 * Attribution uses `linkedProfiles[0]` (the "owner" link the expense was
 * created with) so a cost shows under exactly one asset, mirroring how the
 * asset's own Finance tab selects its expenses. `excludeExpenseIds` lets the
 * caller drop rows already shown as the person's DIRECT expenses, so nothing
 * is listed twice on the same page.
 */
export function collectOwnedAssetExpenses<E extends ExpenseLike>(
  ownedAssets: OwnedAssetLike[],
  allExpenses: E[],
  excludeExpenseIds: Set<string> = new Set(),
): OwnedAssetExpense<E>[] {
  const assetById = new Map<string, OwnedAssetLike>();
  for (const a of ownedAssets) {
    if (a && a.id) assetById.set(a.id, a);
  }
  if (assetById.size === 0) return [];

  const out: OwnedAssetExpense<E>[] = [];
  const seen = new Set<string>();
  for (const e of allExpenses) {
    if (!e || !e.id || seen.has(e.id) || excludeExpenseIds.has(e.id)) continue;
    const owner = Array.isArray(e.linkedProfiles) ? e.linkedProfiles[0] : undefined;
    if (!owner) continue;
    const asset = assetById.get(owner);
    if (!asset) continue;
    seen.add(e.id);
    out.push({
      expense: e,
      viaAsset: { id: asset.id, name: asset.name || "Asset", type: asset.type },
      ownershipPercentage:
        typeof asset._ownershipPercentage === "number" ? asset._ownershipPercentage : undefined,
    });
  }
  return out;
}

export interface ProfileNode {
  id: string;
  type?: string;
  parentProfileId?: string | null;
}
export interface AssetPartyLinkLike {
  assetProfileId?: string;
  partyProfileId?: string;
}

const ASSET_TYPES = new Set(["vehicle", "asset", "investment", "property", "account"]);

/**
 * Given a set of selected person profile ids, return the ids of the ASSET
 * profiles those people own or contain — so a person-scoped financial view can
 * include the cost of ownership of their assets. An asset qualifies when:
 *   - it is nested (parentProfileId chain) under a selected person, OR
 *   - it is owned by a selected person via an asset_party_links row.
 *
 * Pure + cycle-safe. Used to widen the expense scope for the dashboard so a
 * "$50 gas for my truck" (linked to the truck) still counts in the owner's
 * monthly spend / cash flow — while every aggregate still sums distinct
 * expense rows, so nothing is double-counted.
 */
export function ownedAssetIds(
  selectedIds: string[],
  allProfiles: ProfileNode[],
  assetPartyLinks: AssetPartyLinkLike[] = [],
): Set<string> {
  const out = new Set<string>();
  if (!selectedIds || selectedIds.length === 0) return out;
  const persons = new Set(selectedIds);
  const byId = new Map(allProfiles.map((p) => [p.id, p] as const));

  // 1) Nested assets: walk each asset's parent chain up to a selected person.
  for (const p of allProfiles) {
    if (!p || !ASSET_TYPES.has(String(p.type))) continue;
    let cur: ProfileNode | undefined = p;
    const seen = new Set<string>();
    while (cur && cur.parentProfileId && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (persons.has(cur.parentProfileId)) { out.add(p.id); break; }
      cur = byId.get(cur.parentProfileId);
    }
  }

  // 2) Owned assets: asset_party_links where the party is a selected person.
  for (const l of assetPartyLinks || []) {
    if (!l || !l.assetProfileId || !l.partyProfileId) continue;
    if (persons.has(l.partyProfileId)) {
      const a = byId.get(l.assetProfileId);
      if (!a || ASSET_TYPES.has(String(a.type))) out.add(l.assetProfileId);
    }
  }
  return out;
}

/**
 * Total cost of ownership across owned-asset expenses. When a share is known
 * (co-owned asset), the person's allocated portion is used; otherwise the full
 * amount. Pure — same input, same total.
 */
export function ownedAssetExpenseTotal(rows: OwnedAssetExpense[]): number {
  let sum = 0;
  for (const r of rows) {
    const amt = Number(r.expense.amount) || 0;
    const share = typeof r.ownershipPercentage === "number" ? r.ownershipPercentage / 100 : 1;
    sum += amt * share;
  }
  return Math.round(sum * 100) / 100;
}
