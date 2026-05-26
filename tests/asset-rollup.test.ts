import { describe, it, expect } from "vitest";
import { computeAssetRollup } from "../shared/asset-rollup";
import type { Profile } from "../shared/schema";

// Build a minimal Profile-shaped object for the rollup math.
// The rollup ignores everything except `fields` and `parentProfileId`,
// so we don't need a full Profile here.
const mk = (id: string, fields: Record<string, any>, parentProfileId?: string): Profile =>
  ({ id, name: id, type: "asset", fields, parentProfileId } as any);

describe("computeAssetRollup", () => {
  it("rolls up value + loans across one level of children", () => {
    const home = mk("home", { currentValue: 500000 });
    const tv = mk("tv", { currentValue: 1500 }, "home");
    const couch = mk("couch", { value: 800 }, "home");
    const rollup = computeAssetRollup(home, [tv, couch]);
    expect(rollup.baseValue).toBe(500000);
    expect(rollup.nestedValue).toBe(2300);
    expect(rollup.totalValue).toBe(502300);
    expect(rollup.childCount).toBe(2);
    expect(rollup.descendantCount).toBe(2);
  });

  it("rolls up across multiple nesting levels (infinite-depth requirement)", () => {
    const home = mk("home", { currentValue: 500000 });
    const furniture = mk("furniture", { currentValue: 5000 }, "home");
    const couch = mk("couch", { currentValue: 800 }, "furniture");
    const screws = mk("screws", { value: 5 }, "couch");
    // Caller is responsible for passing all descendants of `home`.
    const rollup = computeAssetRollup(home, [furniture, couch, screws]);
    expect(rollup.nestedValue).toBe(5805);
    expect(rollup.totalValue).toBe(505805);
    expect(rollup.childCount).toBe(1);          // direct == furniture only
    expect(rollup.descendantCount).toBe(3);     // furniture + couch + screws
  });

  it("aggregates monthly expense across descendants and normalises freq to monthly", () => {
    const home = mk("home", { monthlyCost: 200 });
    const utility = mk("utility", { cost: 1800, frequency: "yearly" }, "home"); // 150/mo
    const sub = mk("sub", { cost: 14.99, frequency: "weekly" }, "home");        // ~65.13/mo
    const rollup = computeAssetRollup(home, [utility, sub]);
    expect(rollup.monthlyExpense).toBeCloseTo(200 + 150 + 14.99 * 4.345, 2);
  });

  it("aggregates maintenance cost across descendants", () => {
    const vehicle = mk("car", { maintenanceCost: 250 });
    const tires = mk("tires", { maintenanceCost: 120 }, "car");
    const dashcam = mk("dash", { serviceCost: 40 }, "car");
    const rollup = computeAssetRollup(vehicle, [tires, dashcam]);
    expect(rollup.maintenanceCost).toBe(410);
  });

  it("returns zeroed monthly/maintenance when no fields present", () => {
    const a = mk("a", { currentValue: 100 });
    const rollup = computeAssetRollup(a, []);
    expect(rollup.monthlyExpense).toBe(0);
    expect(rollup.maintenanceCost).toBe(0);
    expect(rollup.totalValue).toBe(100);
  });

  it("nets loans against total value", () => {
    const home = mk("home", { currentValue: 500000, remainingBalance: 300000 });
    const rollup = computeAssetRollup(home, []);
    expect(rollup.baseLoans).toBe(300000);
    expect(rollup.netValue).toBe(200000);
  });
});
