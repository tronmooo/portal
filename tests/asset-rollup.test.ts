import { describe, it, expect } from "vitest";
import { computeAssetRollup, collectDescendants } from "../shared/asset-rollup";
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
    const sub = mk("sub", { cost: 14.99, frequency: "weekly" }, "home");        // ~64.96/mo
    const rollup = computeAssetRollup(home, [utility, sub]);
    expect(rollup.monthlyExpense).toBeCloseTo(200 + 150 + 14.99 * (52 / 12), 2);
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

  // ----- User-spec example: Home / Computer / Mouse (4-level reference) -----
  it("matches the user-spec example: Home $400k > Computer $2,000 > Mouse $50", () => {
    const home     = mk("home",     { currentValue: 400_000 });
    const computer = mk("computer", { currentValue: 2_000 }, "home");
    const mouse    = mk("mouse",    { currentValue: 50 },    "computer");
    // Mouse alone
    const mouseRollup = computeAssetRollup(mouse, []);
    expect(mouseRollup.totalValue).toBe(50);
    // Computer alone (descendants = [mouse])
    const computerRollup = computeAssetRollup(computer, [mouse]);
    expect(computerRollup.totalValue).toBe(2_050);
    // Home (descendants = [computer, mouse])
    const homeRollup = computeAssetRollup(home, [computer, mouse]);
    expect(homeRollup.totalValue).toBe(402_050);
    expect(homeRollup.descendantCount).toBe(2);
    expect(homeRollup.childCount).toBe(1); // Computer is the only direct child
  });

  // ----- 5-level deep nesting -----
  it("handles 5+ levels of nesting without missing any descendant", () => {
    const l0 = mk("l0", { currentValue: 1000 });
    const l1 = mk("l1", { currentValue: 500 }, "l0");
    const l2 = mk("l2", { currentValue: 250 }, "l1");
    const l3 = mk("l3", { currentValue: 125 }, "l2");
    const l4 = mk("l4", { currentValue: 60 },  "l3");
    const l5 = mk("l5", { currentValue: 30 },  "l4");
    const rollup = computeAssetRollup(l0, [l1, l2, l3, l4, l5]);
    expect(rollup.totalValue).toBe(1000 + 500 + 250 + 125 + 60 + 30); // 1965
    expect(rollup.descendantCount).toBe(5);
    const byId = Object.fromEntries(rollup.breakdown.map((r) => [r.id, r]));
    expect(byId.l5.depth).toBe(5);
  });
});

describe("collectDescendants", () => {
  it("finds all descendants of a root", () => {
    const home     = mk("home",     { currentValue: 400_000 });
    const computer = mk("computer", { currentValue: 2_000 }, "home");
    const mouse    = mk("mouse",    { currentValue: 50 },    "computer");
    const garden   = mk("garden",   { currentValue: 1_500 }, "home");
    const flowers  = mk("flowers",  { currentValue: 25 },    "garden");
    const desc = collectDescendants("home", [home, computer, mouse, garden, flowers]);
    expect(desc.map(d => d.id).sort()).toEqual(["computer", "flowers", "garden", "mouse"]);
  });

  it("is cycle-safe: A → B → A doesn't infinite-loop", () => {
    const a = mk("a", { currentValue: 100 }, "b");
    const b = mk("b", { currentValue: 200 }, "a");
    // Should return [b] without crashing or repeating.
    const desc = collectDescendants("a", [a, b]);
    expect(desc.map(d => d.id)).toEqual(["b"]);
  });

  it("is cycle-safe: 3-node cycle A → B → C → A", () => {
    const a = mk("a", { currentValue: 100 }, "c");
    const b = mk("b", { currentValue: 200 }, "a");
    const c = mk("c", { currentValue: 300 }, "b");
    const desc = collectDescendants("a", [a, b, c]);
    // From a: walk to b (child of a), then c (child of b). c.parent=b which we just visited,
    // but c itself wasn't visited so it's included. b is the start so visited.
    // Total descendants should be 2 (b + c), never repeating a.
    expect(desc.length).toBe(2);
    expect(desc.map(d => d.id).sort()).toEqual(["b", "c"]);
  });

  it("respects maxDepth", () => {
    const l0 = mk("l0", { currentValue: 1 });
    const l1 = mk("l1", { currentValue: 1 }, "l0");
    const l2 = mk("l2", { currentValue: 1 }, "l1");
    const l3 = mk("l3", { currentValue: 1 }, "l2");
    const desc = collectDescendants("l0", [l0, l1, l2, l3], { maxDepth: 2 });
    expect(desc.map(d => d.id).sort()).toEqual(["l1", "l2"]);
  });

  // ----- Cross-profile leak guard -----
  it("never returns a profile that isn't in the supplied list", () => {
    // Simulates the cross-user scenario: server returns user-scoped list only,
    // so even if some other user's profile claims our id as a parent (bad data),
    // collectDescendants can't pull it in because it's not in `allProfiles`.
    const myHome = mk("my-home", { currentValue: 400_000 });
    const myMouse = mk("my-mouse", { currentValue: 50 }, "my-home");
    // someoneElsesPC is NOT in allProfiles — represents another user's data.
    const desc = collectDescendants("my-home", [myHome, myMouse]);
    expect(desc.map(d => d.id)).toEqual(["my-mouse"]);
    expect(desc.find(d => d.id === "someone-elses-pc")).toBeUndefined();
  });

  it("handles 500 nodes across 5 levels in well under 100ms", () => {
    const nodes: Profile[] = [mk("root", { currentValue: 1 })];
    // Build a roughly balanced tree of 500 nodes, ~5 deep
    let lastLevel = ["root"];
    let id = 0;
    while (nodes.length < 500) {
      const next: string[] = [];
      for (const parent of lastLevel) {
        for (let i = 0; i < 5 && nodes.length < 500; i++) {
          const nid = `n${id++}`;
          nodes.push(mk(nid, { currentValue: 1 }, parent));
          next.push(nid);
        }
      }
      lastLevel = next;
      if (next.length === 0) break;
    }
    const t0 = performance.now();
    const desc = collectDescendants("root", nodes);
    const t1 = performance.now();
    expect(desc.length).toBe(499);
    expect(t1 - t0).toBeLessThan(100);
  });
});
