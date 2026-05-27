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

  it("produces a breakdown with self + sorted descendants by depth", () => {
    const pc = mk("pc", { currentValue: 3000 });
    const mouse = mk("mouse", { currentValue: 80 }, "pc");
    const kb = mk("kb", { currentValue: 150 }, "pc");
    const monitor = mk("monitor", { currentValue: 400 }, "pc");
    const rollup = computeAssetRollup(pc, [mouse, kb, monitor]);
    expect(rollup.breakdown.length).toBe(4);
    expect(rollup.breakdown[0].isSelf).toBe(true);
    expect(rollup.breakdown[0].id).toBe("pc");
    // depth-1 children sorted alphabetically: kb < monitor < mouse
    expect(rollup.breakdown.slice(1).map((r) => r.id)).toEqual(["kb", "monitor", "mouse"]);
    expect(rollup.breakdown.slice(1).every((r) => r.depth === 1)).toBe(true);
  });

  it("breakdown records depth across multiple nesting levels", () => {
    const home = mk("home", { currentValue: 500000 });
    const furniture = mk("furn", { currentValue: 5000 }, "home");
    const couch = mk("couch", { currentValue: 800 }, "furn");
    const screws = mk("screws", { value: 5 }, "couch");
    const rollup = computeAssetRollup(home, [furniture, couch, screws]);
    const byId = Object.fromEntries(rollup.breakdown.map((r) => [r.id, r]));
    expect(byId.home.depth).toBe(0);
    expect(byId.furn.depth).toBe(1);
    expect(byId.couch.depth).toBe(2);
    expect(byId.screws.depth).toBe(3);
  });

  it("breakdown computes per-row netValue (baseValue - baseLoans)", () => {
    const pc = mk("pc", { currentValue: 3000, remainingBalance: 1200 });
    const mouse = mk("mouse", { currentValue: 80 }, "pc");
    const rollup = computeAssetRollup(pc, [mouse]);
    const self = rollup.breakdown.find((r) => r.isSelf)!;
    expect(self.netValue).toBe(1800);
    const m = rollup.breakdown.find((r) => r.id === "mouse")!;
    expect(m.netValue).toBe(80);
  });
});
