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

const isoDay = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;

export async function computeLifecycles(storage: IStorage, opts: { now?: Date } = {}): Promise<LifecycleRow[]> {
  const now = opts.now ?? new Date();
  const [profiles, records, expenses, documents] = await Promise.all([
    storage.getProfiles(),
    storage.listAssetValuations().catch(() => ({} as Record<string, any>)),
    storage.getExpenses(),
    storage.getDocuments().catch(() => [] as any[]),
  ]);
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
