// ─── Asset lifecycle, computed on read ───────────────────────────────────────
// Every screen that shows a lifecycle figure (the asset page, the Assets tab,
// Needs Attention, the Calendar, Finance) reads THIS result, through
// GET /api/assets/lifecycle (Rule 1). Nothing it returns is stored: the AI's
// assumptions and the valuation records are the stored inputs; the
// recommendation, the selling window, the dates and the projection are the
// pure engine's arithmetic over them (shared/asset-lifecycle.ts), so a
// completed action or a changed record changes the answer on the next read
// (Rule 5).
//
// Nested assets: each asset's figures are its OWN (its own value, the
// expenses attributed to it — `attributeAssetExpenses` gives an expense linked
// to a parent and a child to the child alone). A parent's `nested` line sums
// its descendants' figures separately, so nothing is counted twice.

import type { IStorage } from "./storage";
import { collectDescendants } from "@shared/asset-rollup";
import { parseMoney, resolveAssetValue } from "@shared/asset-value";
import { salvageSource, SALVAGE_KEY } from "@shared/asset-salvage";
import { rulesFromAll } from "@shared/date-rules";
import { buildValuationContext, currentAssetValue, isAutoValuationEnabled, isEstimatorOwnedValue } from "@shared/valuation";
import {
  attributeAssetExpenses, computeAssetLifecycle, lifecycleCategory, readStoredAssumptions, repairCosts,
  type LifecycleRow,
} from "@shared/asset-lifecycle";
export type { LifecycleRow };
import { evidenceSources, isValuableProfile } from "./valuation/service";
import { isAssetTabProfile, isLiabilityProfile } from "@shared/asset-value";
import { readBalance, readInterestRatePct } from "@shared/liability-fields";

/**
 * The loan secured by each asset — a liability linked to it in the link table,
 * nested under it, or naming it as its asset — summed per asset with the
 * balance-weighted rate. One of the optimal disposal point's factors: the
 * money tied up in the asset costs the loan's rate, and selling while more is
 * owed than it fetches means covering the gap.
 */
export function securedLoans(
  profiles: ReadonlyArray<any>,
  links: ReadonlyArray<{ liabilityProfileId: string; assetProfileId: string }>,
): Map<string, { balance: number; ratePct: number | null; name: string | null }> {
  const byId = new Map(profiles.map((p: any) => [p.id, p]));
  // A debt is a liability that is not itself an owned thing (a `vehicle` sits in both type sets).
  const isDebt = (p: any) => !!p && !p.deletedAt && isLiabilityProfile(p) && !isAssetTabProfile(p);
  const pairs = new Map<string, Set<string>>();
  const add = (assetId: string | null | undefined, liabilityId: string) => {
    if (!assetId || !byId.has(assetId)) return;
    if (!pairs.has(assetId)) pairs.set(assetId, new Set());
    pairs.get(assetId)!.add(liabilityId);
  };
  for (const l of links) add(l.assetProfileId, l.liabilityProfileId);
  for (const p of profiles) {
    if (!isDebt(p)) continue;
    const parent = p.parentProfileId ? byId.get(p.parentProfileId) : null;
    if (parent && isAssetTabProfile(parent)) add(parent.id, p.id);
    const named = p.fields?.linkedAssetId || p.fields?.assetProfileId;
    if (typeof named === "string") add(named, p.id);
  }
  const out = new Map<string, { balance: number; ratePct: number | null; name: string | null }>();
  for (const [assetId, ids] of pairs) {
    let balance = 0, weighted = 0, rated = 0;
    const names: string[] = [];
    for (const id of ids) {
      const l = byId.get(id);
      if (!isDebt(l)) continue;
      const b = readBalance(l);
      if (!(b > 0)) continue;
      balance += b;
      names.push(l.name);
      const r = readInterestRatePct(l);
      if (r > 0) { weighted += r * b; rated += b; }
    }
    if (balance > 0) out.set(assetId, { balance: Math.round(balance), ratePct: rated > 0 ? Math.round((weighted / rated) * 100) / 100 : null, name: names.join(", ") || null });
  }
  return out;
}

const isoDay = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

export async function computeLifecycles(storage: IStorage, opts: { now?: Date } = {}): Promise<LifecycleRow[]> {
  const now = opts.now ?? new Date();
  const [profiles, records, expenses, documents, links] = await Promise.all([
    storage.getProfiles(),
    storage.listAssetValuations().catch(() => ({} as Record<string, any>)),
    storage.getExpenses(),
    storage.getDocuments().catch(() => [] as any[]),
    // Optional input: without the link table a loan nested under the asset still counts.
    storage.getLiabilityAssetLinks().catch(() => [] as any[]),
  ]);
  const loans = securedLoans(profiles as any[], links as any[]);
  const assets = profiles.filter((p: any) => !p.deletedAt && isValuableProfile(p));
  const attributed = attributeAssetExpenses(expenses as any[], assets.map((a: any) => ({ id: a.id, parentProfileId: a.parentProfileId ?? null })));

  // Warranty end per asset, from the date-rule engine (the bell's own rules).
  const warranty = new Map<string, string>();
  const today = now.toISOString().slice(0, 10);
  for (const r of rulesFromAll({ profiles: assets, documents })) {
    if (!r.profileId || r.supersededBy || !r.active) continue;
    if (r.ruleSubtype !== "warranty" && !/warrant/i.test(`${r.sourceField} ${r.label}`)) continue;
    const d = isoDay(r.date);
    if (!d) continue;
    const cur = warranty.get(r.profileId);
    // The nearest end still ahead; else the latest one that passed.
    if (!cur || (d >= today && (cur < today || d < cur)) || (d < today && cur < today && d > cur)) warranty.set(r.profileId, d);
  }

  const rows: LifecycleRow[] = assets.map((p: any) => {
    const fields = p.fields || {};
    const record = (records as any)[p.id] ?? null;
    const auto = isAutoValuationEnabled(fields);
    const cur = auto ? currentAssetValue(fields, record, resolveAssetValue) : { value: resolveAssetValue(fields) || null, source: "stored" as const };
    const valueSource = cur.value == null ? "none" : cur.source === "estimate" || (cur.source === "stored" && auto && isEstimatorOwnedValue(fields)) ? "estimate" : "user";
    const ctx = buildValuationContext({ profile: { id: p.id, name: p.name, type: p.type, type_key: p.type_key ?? null, tags: p.tags, fields, notes: p.notes ?? null } }, now);
    const repairs = repairCosts(attributed.get(p.id) || [], now);
    const sources = record ? evidenceSources(record) : String(fields.valuationSources || "").split(",").map((s: string) => s.trim()).filter((s: string) => /^https?:\/\//.test(s));
    const lifecycle = computeAssetLifecycle({
      now,
      category: lifecycleCategory(p),
      purchasePrice: ctx.purchase.price,
      purchaseDate: ctx.purchase.date,
      ageYears: ctx.ageYears,
      currentValue: cur.value,
      currentValueSource: valueSource as any,
      valuation: {
        valuedAt: valueSource === "estimate" ? (record?.valuedAt ?? fields.currentValueAsOf ?? null) : (fields.currentValueAsOf ?? null),
        confidenceLabel: valueSource === "estimate" ? (record?.confidenceLabel ?? fields.valuationConfidence ?? null) : null,
        sources: valueSource === "estimate" ? sources : [],
      },
      assumptions: readStoredAssumptions(fields),
      userSalvage: salvageSource(fields) === "user" ? parseMoney(fields[SALVAGE_KEY]) : null,
      repairs12m: repairs.last12m,
      warrantyEnds: warranty.get(p.id) ?? null,
      loan: loans.get(p.id) ?? null,
      facts: {
        hasUsage: Object.keys(ctx.usage || {}).length > 0,
        hasCondition: !!ctx.condition,
        maintenanceRecords: repairs.count,
      },
    });
    return { profileId: p.id, name: p.name, parentProfileId: p.parentProfileId ?? null, lifecycle, repairs, nested: null };
  });

  const byId = new Map(rows.map((r) => [r.profileId, r]));
  for (const r of rows) {
    const kids = collectDescendants(r.profileId, assets as any).filter((k: any) => byId.has(k.id));
    if (!kids.length) continue;
    let value = 0, dep = 0;
    for (const k of kids) {
      const l = byId.get(k.id)!.lifecycle;
      value += l.currentValue ?? 0;
      dep += l.applicable ? l.depreciationNext12m ?? 0 : 0;
    }
    r.nested = { count: kids.length, value: Math.round(value), depreciationNext12m: Math.round(dep) };
  }
  return rows;
}
