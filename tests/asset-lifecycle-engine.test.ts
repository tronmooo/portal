// Asset Lifecycle Intelligence — the deterministic engine (shared/asset-lifecycle.ts).
// The AI chooses assumptions; these tests pin the arithmetic and the
// recommendation the app derives from them, for every kind of asset.
import { describe, it, expect } from "vitest";
import {
  attributeAssetExpenses, computeAssetLifecycle, lifecycleCategory, lifecycleNeedsEstimate, repairCosts,
  sanitizeLifecycleAssumptions, salvageGuard, typicalAssumptions, type LifecycleAssumptions, type LifecycleInput,
} from "@shared/asset-lifecycle";

const NOW = new Date("2026-11-24T12:00:00Z");
const ai = (over: Partial<LifecycleAssumptions> = {}): LifecycleAssumptions => ({
  source: "ai", valueModel: "depreciating", usefulLifeYears: 15, annualChangePct: -0.12, salvageValue: 1500,
  disposal: "scrap", replacementCost: 30000, annualUpkeep: null, upkeepGrowthPct: null,
  majorRepairCost: null, majorFailureChancePct: null, majorFailureChanceGrowthPct: null, carryingCostPct: null, sellingCostPct: null, newEfficiencySavings: null,
  resaleRetention: null, anticipatedRepairs: null, marketDemand: null, disposalReasoning: null,
  confidence: "high", basis: "Compact sedan.", assumptions: ["15-year life"], asOf: "2026-11-24T00:00:00Z", ...over,
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

describe("the Optimal Disposal Point: an economic decision model (owner, 2026-11-26)", () => {
  const curve = [{ years: 1, value: 6200 }, { years: 2, value: 5500 }, { years: 3, value: 4900 }, { years: 5, value: 3900 }, { years: 8, value: 2700 }];
  const aiInputs = { annualUpkeep: 900, upkeepGrowthPct: 0.12, majorRepairCost: 3500, majorFailureChancePct: 0.05, majorFailureChanceGrowthPct: 0.2, carryingCostPct: 0.04, sellingCostPct: 0.08, newEfficiencySavings: 0, marketDemand: "normal", disposalReasoning: "Compact sedans sell easily. Sell before the next major service. It will fetch $5,000 in 2029." };
  const withCurve = (over: Record<string, unknown> = {}) => {
    const a = sanitizeLifecycleAssumptions({ valueModel: "depreciating", usefulLifeYears: 15, annualChangePct: -0.12, salvageValue: 1500, replacementCost: 30000, confidence: "high", resaleCurve: curve, ...aiInputs, ...over }, { purchasePrice: 19000, currentValue: 7000 })!;
    return { ...a, asOf: NOW.toISOString() };
  };
  const od = (over: Record<string, unknown> = {}, inp: Partial<LifecycleInput> = {}) =>
    computeAssetLifecycle(input({ assumptions: withCurve(over), facts: { hasUsage: true, hasCondition: true, maintenanceRecords: 2 }, ...inp })).optimalDisposal!;

  it("never reports the salvage value: the disposal value is a market value comfortably above it", () => {
    const cases = [
      od(),
      od({ annualUpkeep: 0, upkeepGrowthPct: 0, majorFailureChancePct: 0, replacementCost: null }),
      computeAssetLifecycle(input({ assumptions: ai({ annualUpkeep: 0, upkeepGrowthPct: 0 }) })).optimalDisposal!,
      computeAssetLifecycle(input({ category: "furniture", purchasePrice: 2000, purchaseDate: "2023-01-01", currentValue: 900, assumptions: null })).optimalDisposal!,
    ];
    // The sofa's typical salvage is 3% of $2,000 = $60: never that, never near it.
    expect(cases[3].valueAt).toBeGreaterThanOrEqual(salvageGuard(60, 900));
    // The car's salvage is $1,500: its disposal value is well above it.
    expect(cases[0].valueAt).toBeGreaterThan(1500 + 0.05 * 7000);
    expect(cases[1].valueAt).toBeGreaterThan(1500 + 0.05 * 7000);
    expect(cases[2].valueAt).toBeGreaterThan(1500);
  });

  it("follows the AI's resale curve for this asset, scaled to today's value", () => {
    const o = od();
    expect(o.curveSource).toBe("ai");
    // The schedule's values are the AI's curve: $5,500 at two years from $7,000.
    expect(o.schedule.find((r) => r.years === 2)!.value).toBe(5500);
    // A new valuation re-prices the plan without asking the AI again.
    const revalued = od({}, { currentValue: 8400 });
    expect(revalued.schedule.find((r) => r.years === 2)!.value).toBe(Math.round(5500 * 1.2));
  });

  it("compares keeping it against replacing it at every interval and names the decision", () => {
    const o = od();
    expect(["keep", "sell_now"]).toContain(o.decision);
    expect(o.newAnnualCost).toBeGreaterThan(0);
    expect(o.schedule.length).toBeGreaterThan(1);
    for (const r of o.schedule) expect(r.keepCostPerYear).toBeGreaterThan(0);
    if (o.reason === "cheaper_to_replace") expect(o.costAfter!).toBeGreaterThan(o.newAnnualCost!);
    expect(o.remainingEconomicLifeYears).toBeCloseTo(o.monthsFromNow / 12, 1);
    expect(o.projectedDepreciation).toBe(7000 - o.valueAt);
  });

  it("an anticipated repair and a rising failure risk bring the point forward", () => {
    const calm = od({ majorFailureChancePct: 0.01, majorFailureChanceGrowthPct: 0, anticipatedRepairs: [] });
    const hard = od({ majorFailureChancePct: 0.2, majorFailureChanceGrowthPct: 0.4, majorRepairCost: 6000, anticipatedRepairs: [{ item: "Transmission", inYears: 1.5, cost: 4500 }] });
    expect(Date.parse(hard.date)).toBeLessThanOrEqual(Date.parse(calm.date));
    expect(hard.factors.some((f) => f.key === "anticipated" && f.detail.includes("Transmission"))).toBe(true);
  });

  it("an asset that costs more to keep than to replace is sold now, at its current value", () => {
    const o = computeAssetLifecycle(input({ purchaseDate: "2008-01-01", currentValue: 2500, assumptions: ai({ annualUpkeep: 4000, upkeepGrowthPct: 0.2 }) })).optimalDisposal!;
    expect(o.decision).toBe("sell_now");
    expect(o.monthsFromNow).toBe(0);
    expect(o.date).toBe("2026-11-24");
    expect(o.valueAt).toBe(2500);
  });

  it("is specific to the category: a laptop and a car with the same value do not share a date", () => {
    const car = computeAssetLifecycle(input({ category: "vehicle", purchasePrice: 6000, purchaseDate: "2025-05-01", currentValue: 5000, assumptions: null })).optimalDisposal!;
    const laptop = computeAssetLifecycle(input({ category: "electronics", purchasePrice: 6000, purchaseDate: "2025-05-01", currentValue: 5000, assumptions: null })).optimalDisposal!;
    expect(car.date).not.toBe(laptop.date);
  });

  it("says how sure it is, what is missing, and gives a range when it is only an estimate", () => {
    const thin = computeAssetLifecycle(input({ purchaseDate: null, purchasePrice: null, ageYears: null, currentValueSource: "estimate", valuation: { valuedAt: null, confidenceLabel: "low", sources: [] }, assumptions: null })).optimalDisposal!;
    expect(thin.confidence).toBe("low");
    expect(thin.estimated).toBe(true);
    expect(thin.missing).toEqual(expect.arrayContaining(["the purchase date or model year", "the purchase price"]));
    expect(thin.range.valueLow).toBeLessThanOrEqual(thin.valueAt);
    expect(thin.range.valueHigh).toBeGreaterThanOrEqual(thin.valueAt);
    const rich = od();
    expect(rich.confidence).not.toBe("low");
  });

  it("shows the AI's explanation without any figure of its own, beside the model's summary", () => {
    const o = od();
    expect(o.explanation.ai).toBe("Compact sedans sell easily. Sell before the next major service.");
    expect(o.explanation.summary).toMatch(/\$[\d,]+/);
  });

  it("with no current value, today's is estimated from the purchase price, never taken as it", () => {
    const o = computeAssetLifecycle(input({ category: "electronics", purchasePrice: 1200, purchaseDate: "2023-11-24", currentValue: null, currentValueSource: "none", assumptions: null })).optimalDisposal!;
    expect(o.currentValue).toBeLessThan(1200);
    expect(o.missing).toContain("a current value");
  });

  it("recalculates from the records: maintenance records raise its confidence, usage too", () => {
    const without = computeAssetLifecycle(input({ assumptions: withCurve(), facts: { hasUsage: false, hasCondition: false, maintenanceRecords: 0 } })).optimalDisposal!;
    const withAll = od();
    expect(withAll.confidenceScore).toBeGreaterThan(without.confidenceScore);
    expect(without.missing).toEqual(expect.arrayContaining(["its usage (mileage or hours)", "its condition", "maintenance and repair records"]));
  });

  it("the AI's curve is checked: rising points, out-of-range years and too few points are refused", () => {
    expect(sanitizeLifecycleAssumptions({ valueModel: "depreciating", resaleCurve: [{ years: 1, value: 900 }] }, { currentValue: 1000 })!.resaleRetention).toBeNull();
    const c = sanitizeLifecycleAssumptions({ valueModel: "depreciating", resaleCurve: [{ years: 1, value: 900 }, { years: 2, value: 1300 }, { years: 3, value: 700 }, { years: 99, value: 10 }] }, { currentValue: 1000 })!.resaleRetention!;
    expect(c).toEqual([{ years: 1, ratio: 0.9 }, { years: 3, ratio: 0.7 }]);
    // Read back from storage as ratios, unchanged.
    expect(sanitizeLifecycleAssumptions({ valueModel: "depreciating", resaleRetention: c }, {})!.resaleRetention).toEqual(c);
  });

  it("an answer stored before the decision model's inputs were asked for is asked again, once", () => {
    const { disposalReasoning, ...old } = ai();
    void disposalReasoning;
    expect(lifecycleNeedsEstimate({ lifecycleAssumptions: { ...old, inputsKey: "fp1", asOf: NOW.toISOString() } }, "fp1", NOW)).toBe(true);
    expect(lifecycleNeedsEstimate({ lifecycleAssumptions: { ...ai(), inputsKey: "fp1", asOf: NOW.toISOString() } }, "fp1", NOW)).toBe(false);
  });
});

describe("the Optimal Disposal Point weighs every factor (owner, 2026-11-26: \"take all factors into consideration\")", () => {
  const base = { annualUpkeep: 600, upkeepGrowthPct: 0.1, majorRepairCost: 3500, majorFailureChancePct: 0.04, majorFailureChanceGrowthPct: 0.15, carryingCostPct: 0.04, sellingCostPct: 0.08, newEfficiencySavings: 0 };
  const od = (over: Partial<LifecycleAssumptions> = {}, inp: Partial<LifecycleInput> = {}) =>
    computeAssetLifecycle(input({ assumptions: ai({ ...base, ...over }), ...inp })).optimalDisposal!;

  it("lists each factor with its yearly cost now and before the point, and where its figure came from", () => {
    const o = od();
    expect(o.factors.map((f) => f.key)).toEqual(["depreciation", "upkeep", "major_failure", "carrying", "capital", "selling"]);
    expect(o.factors.find((f) => f.key === "upkeep")!.source).toBe("ai");
    expect(o.factors.find((f) => f.key === "major_failure")!.now).toBeGreaterThan(0);
    expect(o.factors.find((f) => f.key === "carrying")!.now).toBeGreaterThan(0);
    for (const f of o.factors) expect(f.detail.length).toBeGreaterThan(10);
  });

  it("a rising chance of a major failure brings the point forward", () => {
    const calm = od({ majorFailureChancePct: 0.01, majorFailureChanceGrowthPct: 0 });
    const risky = od({ majorFailureChancePct: 0.15, majorFailureChanceGrowthPct: 0.4, majorRepairCost: 6000 });
    expect(Date.parse(risky.date)).toBeLessThan(Date.parse(calm.date));
  });

  it("a warranty covers repairs and failures while it runs, and is named", () => {
    const covered = od({}, { warrantyEnds: "2028-06-01" });
    const bare = od();
    expect(covered.factors.find((f) => f.key === "major_failure")!.now).toBe(0);
    expect(covered.factors.find((f) => f.key === "upkeep")!.now).toBeLessThan(bare.factors.find((f) => f.key === "upkeep")!.now);
    expect(covered.notes.some((n) => n.startsWith("Warranty runs until"))).toBe(true);
  });

  it("a loan on it: the money tied up costs the loan's rate, and owing more than it is worth is said", () => {
    const free = od();
    const owed = od({}, { loan: { balance: 9000, ratePct: 11, name: "Auto loan" } });
    const cap = (o: typeof free) => o.factors.find((f) => f.key === "capital")!;
    expect(cap(owed).now).toBeGreaterThan(cap(free).now);
    expect(cap(owed).source).toBe("on_file");
    expect(owed.notes.some((n) => n.includes("more than it is worth today"))).toBe(true);
  });

  it("a newer model's running-cost saving makes replacing win sooner", () => {
    const none = od({ newEfficiencySavings: 0, annualUpkeep: 1500, upkeepGrowthPct: 0.2 });
    const big = od({ newEfficiencySavings: 2500, annualUpkeep: 1500, upkeepGrowthPct: 0.2 });
    expect(big.newAnnualCost!).toBeLessThan(none.newAnnualCost!);
    expect(Date.parse(big.date)).toBeLessThanOrEqual(Date.parse(none.date));
    expect(big.factors.some((f) => f.key === "efficiency")).toBe(true);
  });

  it("the cost of selling is counted once, at the point", () => {
    const cheap = od({ sellingCostPct: 0 });
    const dear = od({ sellingCostPct: 0.3 });
    expect(dear.factors.find((f) => f.key === "selling")!.atPoint).toBeGreaterThan(0);
    expect(cheap.factors.find((f) => f.key === "selling")!.atPoint).toBe(0);
  });

  it("insurance and tax that follow its value fall as it ages", () => {
    const o = od();
    const c = o.factors.find((f) => f.key === "carrying")!;
    if (o.monthsFromNow > 12) expect(c.atPoint).toBeLessThan(c.now);
  });

  it("with no AI answer, every factor uses the category's typical figures, labelled Typical", () => {
    const o = computeAssetLifecycle(input({ assumptions: null })).optimalDisposal!;
    for (const k of ["major_failure", "carrying", "selling"]) expect(o.factors.find((f) => f.key === k)!.source).toBe("typical");
  });

  it("the AI's factor figures are bounded, not clamped", () => {
    const ok = sanitizeLifecycleAssumptions({ valueModel: "depreciating", majorRepairCost: "3,000", majorFailureChancePct: 6, carryingCostPct: 0.05, sellingCostPct: 10, newEfficiencySavings: 200 }, { purchasePrice: 20000 })!;
    expect(ok.majorRepairCost).toBe(3000);
    expect(ok.majorFailureChancePct).toBeCloseTo(0.06);
    expect(ok.sellingCostPct).toBeCloseTo(0.1);
    const bad = sanitizeLifecycleAssumptions({ valueModel: "depreciating", majorRepairCost: 900000, majorFailureChancePct: 95, carryingCostPct: 0.6, sellingCostPct: 80, newEfficiencySavings: -5 }, { purchasePrice: 20000 })!;
    expect([bad.majorRepairCost, bad.majorFailureChancePct, bad.carryingCostPct, bad.sellingCostPct, bad.newEfficiencySavings]).toEqual([null, null, null, null, null]);
  });
});
