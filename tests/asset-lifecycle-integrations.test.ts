// Asset Lifecycle Intelligence across the app: Needs Attention (significant
// recommendations only, one dismissable id per asset + recommendation, never a
// task), the Calendar (derived, read-only dates — no action can reach the
// asset), and Finance (each asset's loss counted once).
import { describe, it, expect } from "vitest";
import {
  computeAssetLifecycle, lifecycleAlertId, lifecycleAttentionItems, summarizeLifecycles, type LifecycleAssumptions,
} from "@shared/asset-lifecycle";
import { selectAttentionRows, attentionHeading } from "@shared/executive-attention";
import { seriesFromAll, seriesFromLifecycles } from "@shared/calendar-adapters";
import { capabilitiesFor, occurrenceMenuFor } from "@shared/calendar-capabilities";

const NOW = new Date("2026-11-24T12:00:00Z");
const A = (over: Partial<LifecycleAssumptions> = {}): LifecycleAssumptions => ({
  source: "ai", valueModel: "depreciating", usefulLifeYears: 15, annualChangePct: -0.12, salvageValue: 1500, disposal: "scrap",
  replacementCost: 30000, confidence: "high", basis: "", assumptions: [], ...over,
});
const row = (id: string, name: string, input: Record<string, unknown>, a: Partial<LifecycleAssumptions> = {}) => ({
  profileId: id, name, parentProfileId: null, repairs: { last12m: 0, total: 0, count: 0 }, nested: null,
  lifecycle: computeAssetLifecycle({ now: NOW, category: "vehicle", purchasePrice: 19000, purchaseDate: "2016-05-01", ageYears: null, currentValue: 7000, currentValueSource: "estimate", valuation: null, assumptions: A(a), ...input } as any),
});
const civic = row("civic", "Honda Civic", {});                                                // consider selling
const laptop = row("laptop", "Old laptop", { category: "electronics", purchasePrice: 1500, purchaseDate: "2019-01-01", currentValue: 120 }, { usefulLifeYears: 5, salvageValue: 30, replacementCost: 1400 }); // replace
const newCar = row("new", "New car", { purchaseDate: "2025-06-01", currentValue: 17000 });      // keep

describe("Needs Attention", () => {
  it("raises only significant recommendations, opening the asset, never as a task", () => {
    const items = lifecycleAttentionItems([civic, laptop, newCar], [], NOW);
    expect(items.map((i) => i.key).sort()).toEqual([lifecycleAlertId("civic", "consider_selling"), lifecycleAlertId("laptop", "replace")].sort());
    for (const i of items) {
      expect(i.kind).toBe("alert");
      expect(i.href).toMatch(/^\/profiles\//);
      expect(i.action).toEqual({ kind: "open", label: "Open" });
      expect(i.dismissIds).toEqual([i.key]);
    }
    expect(items.find((i) => i.key.includes("laptop"))!.title).toBe("Old laptop: Replace");
    // Advice for now, not a deadline: no date chip, and a sentence a person reads.
    const sell = items.find((i) => i.key.includes("civic"))!;
    expect(sell.daysUntil).toBe(0);
    expect(sell.reason).toMatch(/^It is in its best selling window \(until Jan 2029\)/);
    expect(sell.reason).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("a dismissed recommendation stays gone; a different one later is a new row", () => {
    const dismissed = [lifecycleAlertId("civic", "consider_selling")];
    expect(lifecycleAttentionItems([civic], dismissed, NOW)).toEqual([]);
    const worn = row("civic", "Honda Civic", { purchaseDate: "2010-01-01", currentValue: 2500 });
    expect(worn.lifecycle.recommendation!.action).toBe("replace");
    expect(lifecycleAttentionItems([worn], dismissed, NOW).map((i) => i.key)).toEqual([lifecycleAlertId("civic", "replace")]);
  });

  it("the card keeps them after the expirations, under 'Also needs attention'", () => {
    const expiry: any = { key: "doc:1", sourceKey: "document:1", kind: "document", title: "Passport", reason: "expires in 9d", tier: "soon", daysUntil: 9, score: 80, href: "/documents/1" };
    const rows = selectAttentionRows({ immediate: [], health: [], documents: [expiry], lifecycle: lifecycleAttentionItems([civic, laptop], [], NOW) });
    expect(rows[0].key).toBe("doc:1");
    expect(rows).toHaveLength(3);
    expect(attentionHeading(rows[1])).toBe("other");
  });
});

describe("Calendar", () => {
  it("adds the replacement date and the selling window as one-off dates", () => {
    const s = seriesFromLifecycles([civic, newCar], "2026-11-24");
    const civicSeries = s.filter((x) => x.id.startsWith("lifecycle:civic"));
    expect(civicSeries.map((x) => x.title).sort()).toEqual(["Replace: Honda Civic", "Sell by: Honda Civic"]);
    expect(s.find((x) => x.id === "lifecycle:new:sell-window")!.title).toBe("Best time to sell opens: New car");
    for (const x of s) expect(x.recurrence).toBe("none");
    // It reaches the one calendar stream.
    expect(seriesFromAll({ lifecycles: [civic], today: "2026-11-24" }).some((x) => x.id === "lifecycle:civic:replace")).toBe(true);
  });

  it("is read-only: the only action opens the asset — no delete could ever reach it", () => {
    const [series] = seriesFromLifecycles([civic], "2026-11-24");
    const caps = capabilitiesFor(series);
    expect(caps.filter((c) => c.enabled).map((c) => c.action)).toEqual(["edit"]);
    expect(occurrenceMenuFor(series, { status: "upcoming", date: series.baseDate }, { isOpen: true }).map((m) => m.action)).not.toContain("deleteSeries");
    expect(series.source.href).toBe("/profiles/civic");
  });

  it("an appreciating asset puts nothing on the calendar", () => {
    const house = row("house", "House", { category: "real_estate", purchasePrice: 400000, currentValue: 520000 }, { valueModel: "appreciating", usefulLifeYears: null, annualChangePct: 0.04, salvageValue: null });
    expect(seriesFromLifecycles([house], "2026-11-24")).toEqual([]);
  });
});

describe("Finance", () => {
  it("sums each asset's own projected loss, separates gains, counts significant recommendations", () => {
    const house = row("house", "House", { category: "real_estate", purchasePrice: 400000, currentValue: 500000 }, { valueModel: "appreciating", usefulLifeYears: null, annualChangePct: 0.04, salvageValue: null });
    const sum = summarizeLifecycles([civic, laptop, newCar, house]);
    const expected = [civic, laptop, newCar].reduce((t, r) => t + Math.max(0, r.lifecycle.depreciationNext12m!), 0);
    expect(sum.depreciationNext12m).toBe(expected);
    expect(sum.appreciationNext12m).toBe(20000);
    expect(sum.significant).toBe(2);
    expect(sum.assets).toBe(4);
    expect(sum.biggestLosers[0].loss).toBeGreaterThanOrEqual(sum.biggestLosers[1].loss);
  });
});
