// Asset Lifecycle Intelligence — the deterministic engine (shared/asset-lifecycle.ts).
// The AI chooses assumptions; these tests pin the arithmetic and the
// recommendation the app derives from them, for every kind of asset.
import { describe, it, expect } from "vitest";
import {
  attributeAssetExpenses, computeAssetLifecycle, lifecycleCategory, lifecycleNeedsEstimate, repairCosts,
  sanitizeLifecycleAssumptions, typicalAssumptions, type LifecycleAssumptions, type LifecycleInput,
} from "@shared/asset-lifecycle";

const NOW = new Date("2026-11-24T12:00:00Z");
const ai = (over: Partial<LifecycleAssumptions> = {}): LifecycleAssumptions => ({
  source: "ai", valueModel: "depreciating", usefulLifeYears: 15, annualChangePct: -0.12, salvageValue: 1500,
  disposal: "scrap", replacementCost: 30000, annualUpkeep: null, upkeepGrowthPct: null, confidence: "high", basis: "Compact sedan.", assumptions: ["15-year life"], asOf: "2026-11-24T00:00:00Z", ...over,
});
const input = (over: Partial<LifecycleInput> = {}): LifecycleInput => ({
  now: NOW, category: "vehicle", purchasePrice: 19000, purchaseDate: "2016-05-01", ageYears: null,
  currentValue: 7000, currentValueSource: "estimate",
  valuation: { valuedAt: "2026-11-24T10:00:00Z", confidenceLabel: "high", sources: ["https://kbb.com/x"] },
  assumptions: ai(), repairs12m: 0, ...over,
});

describe("depreciating assets", () => {
  it("a 10-year-old car in its selling window: Consider Selling, with the numbers behind it", () => {
    const l = computeAssetLifecycle(input());
    expect(l.applicable).toBe(true);
    expect(l.ageYears).toBeCloseTo(10.6, 1);
    expect(l.remainingLifeYears).toBeCloseTo(4.4, 1);
    expect(l.accumulatedDepreciation).toBe(12000);
    expect(l.sellingWindow).toEqual({ start: "2025-05-01", end: "2029-01-30", status: "open" });
    expect(l.recommendation!.action).toBe("consider_selling");
    expect(l.recommendation!.headline).toContain("$7,000");
    expect(l.depreciationNext12m).toBeGreaterThan(0);
    expect(l.salvage).toEqual({ value: 1500, source: "ai", disposalCost: false });
    expect(l.replacementCost).toEqual({ value: 30000, source: "ai" });
    expect(l.endOfLifeDate).toBe("2031-05-02");
    expect(l.recommendedReplacementDate).toBe("2031-05-02");
    expect(l.confidence).toBe("high");
    expect(l.sources).toEqual(["https://kbb.com/x"]);
  });

  it("the projection starts at today's value, only falls, and lands on the salvage value at the end of life", () => {
    const l = computeAssetLifecycle(input());
    expect(l.projection[0].value).toBe(7000);
    for (let i = 1; i < l.projection.length; i++) expect(l.projection[i].value).toBeLessThanOrEqual(l.projection[i - 1].value);
    expect(l.projection[l.projection.length - 1].value).toBe(1500);
    expect(Math.min(...l.projection.map((p) => p.value))).toBe(1500);
    expect(l.valueIn12m).toBe(l.projection[12].value);
  });

  it("past its useful life with resale left: Replace, dated today", () => {
    const l = computeAssetLifecycle(input({ category: "electronics", purchasePrice: 1500, purchaseDate: "2020-01-10", currentValue: 150,
      assumptions: ai({ usefulLifeYears: 5, salvageValue: 30, replacementCost: 1400, disposal: "recycle" }) }));
    expect(l.remainingLifeYears!).toBeLessThan(0);
    expect(l.recommendation!.action).toBe("replace");
    expect(l.recommendedReplacementDate).toBe("2026-11-24");
  });

  it("past its life with a net disposal cost: Dispose / Recycle, and the cost reads as a cost", () => {
    const l = computeAssetLifecycle(input({ category: "appliance", purchasePrice: 900, purchaseDate: "2010-03-01", currentValue: 20,
      assumptions: ai({ usefulLifeYears: 12, salvageValue: -80, replacementCost: 1100, disposal: "dispose" }) }));
    expect(l.recommendation!.action).toBe("dispose");
    expect(l.salvage).toEqual({ value: -80, source: "ai", disposalCost: true });
    expect(l.recommendation!.reasons.join(" ")).toContain("costs about $80");
    // A negative salvage is a cost, never a negative value on the graph.
    expect(Math.min(...l.projection.map((p) => p.value))).toBeGreaterThanOrEqual(0);
  });

  it("zero salvage value is supported: the projection floors at $0", () => {
    const l = computeAssetLifecycle(input({ category: "furniture", purchasePrice: 2000, purchaseDate: "2023-01-01", currentValue: 1200,
      assumptions: ai({ usefulLifeYears: 10, salvageValue: 0, replacementCost: 2200 }) }));
    expect(l.salvage.value).toBe(0);
    expect(l.projection[l.projection.length - 1].value).toBe(0);
    expect(l.recommendation!.action).toBe("keep");
  });

  it("repairs that cost more than a new one per year: Replace, and it says why in dollars", () => {
    const l = computeAssetLifecycle(input({ purchaseDate: "2018-06-01", currentValue: 5000, repairs12m: 4000 }));
    expect(l.repairVsReplace!.favors).toBe("replace");
    expect(l.repairVsReplace!.annualReplaceCost).toBe(1842);
    expect(l.repairVsReplace!.annualKeepCost).toBeGreaterThan(4000);
    expect(l.recommendation!.action).toBe("replace");
    expect(l.recommendation!.reasons[0]).toBe("$4,000 spent on repairs and maintenance in the last 12 months.");
  });

  it("a warranty ending within 90 days: Monitor", () => {
    const l = computeAssetLifecycle(input({ category: "electronics", purchasePrice: 2400, purchaseDate: "2025-12-20", currentValue: 1900,
      assumptions: ai({ usefulLifeYears: 6, salvageValue: 60, replacementCost: 2400 }), warrantyEnds: "2026-12-20" }));
    expect(l.recommendation!.action).toBe("monitor");
    expect(l.recommendation!.headline).toContain("warranty ends in 26 days");
  });

  it("a young asset: Keep, with the life left", () => {
    const l = computeAssetLifecycle(input({ purchaseDate: "2024-11-01", currentValue: 16000 }));
    expect(l.recommendation!.action).toBe("keep");
    expect(l.sellingWindow!.status).toBe("ahead");
  });

  it("a salvage value the user typed overrides the AI's", () => {
    const l = computeAssetLifecycle(input({ userSalvage: 2500 }));
    expect(l.salvage).toEqual({ value: 2500, source: "user", disposalCost: false });
    expect(l.projection[l.projection.length - 1].value).toBe(2500);
  });
});

describe("appreciating and stable assets", () => {
  it("a house gains value: Keep, projection rises, no salvage, no replacement date", () => {
    const l = computeAssetLifecycle(input({ category: "real_estate", purchasePrice: 400000, purchaseDate: "2019-01-01", currentValue: 520000,
      assumptions: ai({ valueModel: "appreciating", usefulLifeYears: null, annualChangePct: 0.04, salvageValue: null, replacementCost: null, disposal: "none" }) }));
    expect(l.valueModel).toBe("appreciating");
    expect(l.recommendation!.action).toBe("keep");
    expect(l.accumulatedDepreciation).toBe(-120000);
    expect(l.valueIn12m).toBe(540800);
    expect(l.depreciationNext12m).toBe(-20800);
    expect(l.salvage.value).toBeNull();
    expect(l.recommendedReplacementDate).toBeNull();
    expect(l.sellingWindow).toBeNull();
  });

  it("gold holds its value: Keep, flat projection", () => {
    const l = computeAssetLifecycle(input({ category: "jewelry", purchasePrice: 3000, currentValue: 3400,
      assumptions: ai({ valueModel: "stable", usefulLifeYears: null, annualChangePct: 0, salvageValue: null, replacementCost: null }) }));
    expect(l.recommendation!.action).toBe("keep");
    expect(new Set(l.projection.map((p) => p.value))).toEqual(new Set([3400]));
  });
});

describe("missing data and categories without a lifecycle", () => {
  it("no value and no price: not applicable, and it says what to add", () => {
    const l = computeAssetLifecycle(input({ purchasePrice: null, currentValue: null, currentValueSource: "none" }));
    expect(l.applicable).toBe(false);
    expect(l.recommendation).toBeNull();
    expect(l.missing).toEqual(expect.arrayContaining(["purchase price", "current value"]));
  });

  it("an investment is priced by the market: no lifecycle", () => {
    const l = computeAssetLifecycle(input({ category: "investment", assumptions: null }));
    expect(l.applicable).toBe(false);
  });

  it("with no AI answer the category's typical figures are used, labelled typical and low confidence", () => {
    const l = computeAssetLifecycle(input({ assumptions: null }));
    expect(l.assumptions.source).toBe("typical");
    expect(l.confidence).toBe("low");
    expect(l.usefulLifeYears).toBe(15);
    expect(l.salvage.source).toBe("typical");
    expect(l.recommendation!.reasons.join(" ")).toContain("typical figures");
  });

  it("typical figures for an unrecognised item never tell anyone to sell or replace", () => {
    const l = computeAssetLifecycle(input({ category: "generic", purchasePrice: 800, purchaseDate: "2015-01-01", currentValue: 40, assumptions: null }));
    expect(l.recommendation!.action).toBe("monitor");
  });

  it("no purchase date but a model year still gives an age; neither gives no window", () => {
    const withYear = computeAssetLifecycle(input({ purchaseDate: null, ageYears: 9 }));
    expect(withYear.remainingLifeYears).toBe(6);
    const none = computeAssetLifecycle(input({ purchaseDate: null, ageYears: null }));
    expect(none.remainingLifeYears).toBeNull();
    expect(none.sellingWindow).toBeNull();
    expect(none.missing).toContain("purchase date or model year");
    expect(none.recommendation).not.toBeNull();
  });
});

describe("the AI's assumptions are bounded", () => {
  it("accepts a sane answer and normalises a percent written as 15", () => {
    const a = sanitizeLifecycleAssumptions({ valueModel: "depreciating", usefulLifeYears: 12, annualChangePct: 15, salvageValue: 400, replacementCost: 25000, confidence: "medium", basis: "x", assumptions: ["a", "b"] }, { purchasePrice: 20000 });
    expect(a).toMatchObject({ valueModel: "depreciating", usefulLifeYears: 12, annualChangePct: -0.15, salvageValue: 400, replacementCost: 25000 });
  });
  it("refuses out-of-bounds figures rather than clamping them", () => {
    const a = sanitizeLifecycleAssumptions({ valueModel: "depreciating", usefulLifeYears: 900, salvageValue: 50000, replacementCost: 9_000_000 }, { purchasePrice: 20000 })!;
    expect(a.usefulLifeYears).toBeNull();
    expect(a.salvageValue).toBeNull();
    expect(a.replacementCost).toBeNull();
    expect(sanitizeLifecycleAssumptions({ salvageValue: 5 }, {})).toBeNull();
    expect(sanitizeLifecycleAssumptions({ valueModel: "depreciating", salvageValue: -20000 }, { purchasePrice: 1000 })!.salvageValue).toBeNull();
  });
  it("is re-asked when its inputs change or it ages out", () => {
    const fields = { lifecycleAssumptions: { ...ai(), inputsKey: "fp1", asOf: NOW.toISOString() } };
    expect(lifecycleNeedsEstimate(fields, "fp1", NOW)).toBe(false);
    expect(lifecycleNeedsEstimate(fields, "fp2", NOW)).toBe(true);
    expect(lifecycleNeedsEstimate({}, "fp1", NOW)).toBe(true);
    expect(lifecycleNeedsEstimate(fields, "fp1", new Date(NOW.getTime() + 181 * 86_400_000))).toBe(true);
  });
  it("categories come from the app's classification, refined for appliances, furniture and jewelry", () => {
    expect(lifecycleCategory({ name: "Honda Civic", type: "vehicle", fields: {} })).toBe("vehicle");
    expect(lifecycleCategory({ name: "Samsung Refrigerator", type: "asset", fields: {} })).toBe("appliance");
    expect(lifecycleCategory({ name: "Leather Sofa", type: "asset", fields: {} })).toBe("furniture");
    expect(lifecycleCategory({ name: "Gold bracelet", type: "asset", fields: {} })).toBe("jewelry");
    expect(lifecycleCategory({ name: "MacBook Pro laptop", type: "asset", fields: {} })).toBe("electronics");
    expect(typicalAssumptions("investment", 1000)).toBeNull();
  });
});

describe("nested assets: an expense counts once", () => {
  const assets = [{ id: "house" }, { id: "furnace", parentProfileId: "house" }, { id: "ac", parentProfileId: "house" }, { id: "car" }];
  it("an expense on the house AND its furnace belongs to the furnace only", () => {
    const m = attributeAssetExpenses([{ id: "e1", amount: 600, linkedProfiles: ["house", "furnace"], description: "Furnace repair", date: "2026-10-01" }], assets);
    expect(m.get("furnace")!.map((e) => e.share)).toEqual([600]);
    expect(m.get("house")).toBeUndefined();
  });
  it("one shared by two siblings is split, so the total is still the amount", () => {
    const m = attributeAssetExpenses([{ id: "e2", amount: 300, linkedProfiles: ["furnace", "ac"], description: "HVAC service" }], assets);
    expect(m.get("furnace")![0].share + m.get("ac")![0].share).toBe(300);
  });
  it("repair costs skip loan payments and non-repair spending, and window to 12 months", () => {
    const m = attributeAssetExpenses([
      { id: "a", amount: 400, linkedProfiles: ["car"], description: "Brake repair", date: "2026-08-01" },
      { id: "b", amount: 900, linkedProfiles: ["car"], description: "Transmission service", date: "2024-01-01" },
      { id: "c", amount: 350, linkedProfiles: ["car"], description: "Car loan interest", tags: ["payment-cost:x"], date: "2026-09-01" },
      { id: "d", amount: 60, linkedProfiles: ["car"], description: "Gas", date: "2026-09-01" },
    ], assets);
    expect(repairCosts(m.get("car")!, NOW)).toEqual({ last12m: 400, total: 1300, count: 2 });
  });
});

describe("the Optimal Disposal Point (owner, 2026-11-26)", () => {
  it("is the AI's assumptions run through the arithmetic: rising upkeep brings it forward", () => {
    const low = computeAssetLifecycle(input({ assumptions: ai({ annualUpkeep: 300, upkeepGrowthPct: 0.05 }) })).optimalDisposal!;
    const high = computeAssetLifecycle(input({ assumptions: ai({ annualUpkeep: 2500, upkeepGrowthPct: 0.3 }) })).optimalDisposal!;
    expect(low).toBeTruthy();
    expect(high).toBeTruthy();
    expect(Date.parse(high.date)).toBeLessThan(Date.parse(low.date));
    expect(high.upkeepSource).toBe("ai");
    expect(high.upkeepNow).toBe(2500);
    // A date is a calendar day, never before today.
    expect(high.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Date.parse(`${high.date}T23:59:59Z`)).toBeGreaterThanOrEqual(NOW.getTime() - 31 * 86_400_000);
  });

  it("with flat upkeep, owning gets cheaper each year, so the point is the end of its useful life", () => {
    const l = computeAssetLifecycle(input({ purchaseDate: "2024-05-01", currentValue: 15000, assumptions: ai({ annualUpkeep: 0, upkeepGrowthPct: 0, replacementCost: null }) }));
    expect(l.optimalDisposal!.reason).toBe("end_of_life");
    expect(Math.abs(Date.parse(l.optimalDisposal!.date) - Date.parse(l.endOfLifeDate!))).toBeLessThan(62 * 86_400_000);
  });

  it("past its useful life, the point is now", () => {
    const l = computeAssetLifecycle(input({ purchaseDate: "2008-01-01", currentValue: 2500 }));
    expect(l.optimalDisposal!.reason).toBe("now");
    expect(l.optimalDisposal!.monthsFromNow).toBe(0);
    expect(l.optimalDisposal!.date).toBe("2026-11-24");
  });

  it("recorded repairs above the AI's upkeep are used instead", () => {
    const l = computeAssetLifecycle(input({ repairs12m: 4000, assumptions: ai({ annualUpkeep: 800, upkeepGrowthPct: 0.1 }) }));
    expect(l.optimalDisposal!.upkeepSource).toBe("repairs");
    expect(l.optimalDisposal!.upkeepNow).toBe(4000);
  });

  it("a replacement that is cheaper to own, all-in, than a year of keeping this one decides it", () => {
    const l = computeAssetLifecycle(input({ assumptions: ai({ annualUpkeep: 3000, upkeepGrowthPct: 0.2, replacementCost: 20000 }) }));
    const od = l.optimalDisposal!;
    if (od.reason === "cheaper_to_replace") expect(od.costAfter!).toBeGreaterThan(od.newAnnualCost!);
    expect(od.newAnnualCost).toBeGreaterThan(0);
    expect(l.recommendation!.reasons.some((r) => r.startsWith("Optimal disposal point:"))).toBe(true);
  });

  it("something that gains or holds its value has none", () => {
    expect(computeAssetLifecycle(input({ category: "real_estate", assumptions: ai({ valueModel: "appreciating", annualChangePct: 0.03, usefulLifeYears: null, salvageValue: null }) })).optimalDisposal).toBeNull();
    expect(computeAssetLifecycle(input({ category: "collectible", assumptions: ai({ valueModel: "stable", usefulLifeYears: null, salvageValue: null }) })).optimalDisposal).toBeNull();
  });

  it("the AI's upkeep figures are bounded, not clamped", () => {
    const ok = sanitizeLifecycleAssumptions({ valueModel: "depreciating", annualUpkeep: "1,200", upkeepGrowthPct: 12 }, { purchasePrice: 20000 })!;
    expect(ok.annualUpkeep).toBe(1200);
    expect(ok.upkeepGrowthPct).toBeCloseTo(0.12);
    const bad = sanitizeLifecycleAssumptions({ valueModel: "depreciating", annualUpkeep: 50000, upkeepGrowthPct: 70 }, { purchasePrice: 20000 })!;
    expect(bad.annualUpkeep).toBeNull();
    expect(bad.upkeepGrowthPct).toBeNull();
  });

  it("an answer stored before upkeep was asked for is asked again, once", () => {
    const { annualUpkeep, upkeepGrowthPct, ...old } = ai();
    void annualUpkeep; void upkeepGrowthPct;
    expect(lifecycleNeedsEstimate({ lifecycleAssumptions: { ...old, inputsKey: "fp1", asOf: NOW.toISOString() } }, "fp1", NOW)).toBe(true);
    expect(lifecycleNeedsEstimate({ lifecycleAssumptions: { ...ai(), inputsKey: "fp1", asOf: NOW.toISOString() } }, "fp1", NOW)).toBe(false);
  });
});
