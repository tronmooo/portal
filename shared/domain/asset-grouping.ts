// shared/domain/asset-grouping.ts — assets grouped by category and sorted on
// purpose, so a house is never buried under a phone case.
//
// Pure. Pinned by tests/consistency-layer-assets.test.ts.

import { resolveAssetValue } from "../asset-value";
import { accountKindOf, isDebtAccountKind } from "../account-kinds";

export type AssetGroup =
  | "Real Estate" | "Vehicles" | "Financial Accounts" | "Investments" | "Electronics" | "Personal Property" | "Other";

export const ASSET_GROUP_ORDER: readonly AssetGroup[] = [
  "Real Estate", "Vehicles", "Financial Accounts", "Investments", "Electronics", "Personal Property", "Other",
];

export type AssetSort = "value" | "name" | "updated" | "owner" | "change";

export interface AssetLike {
  id: string;
  name: string;
  type?: string | null;
  type_key?: string | null;
  fields?: Record<string, any> | null;
  updatedAt?: string | null;
  parentProfileId?: string | null;
}

const ELECTRONICS = /\b(laptop|macbook|imac|computer|pc|desktop|monitor|tv|television|phone|iphone|ipad|tablet|watch|camera|console|playstation|xbox|nintendo|kindle|printer|router|drone|headphones|airpods|speaker)\b/i;
const ELECTRONICS_KEY = /^(electronics?|device|computer|phone|laptop|tablet|camera|gadget)$/i;

export function assetGroupOf(p: AssetLike | null | undefined): AssetGroup {
  if (!p) return "Other";
  const t = String(p.type ?? "").toLowerCase();
  const key = String(p.type_key ?? "").toLowerCase();
  if (t === "property" || /real_?estate|house|home|condo|land/.test(key)) return "Real Estate";
  if (t === "vehicle" || /vehicle|car|truck|boat|motorcycle|rv/.test(key)) return "Vehicles";
  if (t === "investment" || /invest|brokerage|401k|ira|crypto|stock/.test(key)) return "Investments";
  if (t === "account") return isDebtAccountKind(accountKindOf(p)) ? "Other" : "Financial Accounts";
  if (ELECTRONICS_KEY.test(key) || ELECTRONICS.test(p.name)) return "Electronics";
  if (t === "asset") return "Personal Property";
  return "Other";
}

export interface AssetRow<T extends AssetLike = AssetLike> {
  asset: T;
  value: number;
  group: AssetGroup;
  /** Change vs. purchase/previous value when the record carries one. */
  change: number | null;
}

export interface AssetGroupBlock<T extends AssetLike = AssetLike> {
  group: AssetGroup;
  items: AssetRow<T>[];
  total: number;
}

function changeOf(p: AssetLike, value: number): number | null {
  const f = p.fields || {};
  const base = Number(f.purchasePrice ?? f.previousValue ?? f.originalValue);
  return Number.isFinite(base) && base > 0 ? Math.round((value - base) * 100) / 100 : null;
}

function comparator<T extends AssetLike>(sort: AssetSort, ownerName: (a: T) => string): (a: AssetRow<T>, b: AssetRow<T>) => number {
  switch (sort) {
    case "name": return (a, b) => a.asset.name.localeCompare(b.asset.name);
    case "updated": return (a, b) => String(b.asset.updatedAt || "").localeCompare(String(a.asset.updatedAt || "")) || a.asset.name.localeCompare(b.asset.name);
    case "owner": return (a, b) => ownerName(a.asset).localeCompare(ownerName(b.asset)) || b.value - a.value;
    case "change": return (a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity) || b.value - a.value;
    default: return (a, b) => b.value - a.value || a.asset.name.localeCompare(b.asset.name);
  }
}

/**
 * Group assets by category, sort within each group, and order the groups by
 * total value (highest first) so high-value holdings lead.
 */
export function groupAndSortAssets<T extends AssetLike>(
  assets: readonly T[],
  sort: AssetSort = "value",
  ownerName: (a: T) => string = () => "",
): AssetGroupBlock<T>[] {
  const blocks = new Map<AssetGroup, AssetGroupBlock<T>>();
  for (const asset of assets) {
    const group = assetGroupOf(asset);
    const value = resolveAssetValue(asset);
    const row: AssetRow<T> = { asset, value, group, change: changeOf(asset, value) };
    const block = blocks.get(group) ?? { group, items: [], total: 0 };
    block.items.push(row);
    block.total = Math.round((block.total + value) * 100) / 100;
    blocks.set(group, block);
  }
  const cmp = comparator<T>(sort, ownerName);
  const out = [...blocks.values()];
  for (const b of out) b.items.sort(cmp);
  return out.sort((a, b) => b.total - a.total || ASSET_GROUP_ORDER.indexOf(a.group) - ASSET_GROUP_ORDER.indexOf(b.group));
}
