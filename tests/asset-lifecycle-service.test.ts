// The lifecycle service (server/asset-lifecycle-service.ts) over the in-memory
// storage: the AI's stored assumptions plus the real records give each asset
// its lifecycle; nested assets and shared expenses are counted once; a warranty
// on file reaches the recommendation; nothing is written.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import { computeLifecycles } from "../server/asset-lifecycle-service";

const NOW = new Date("2026-11-24T12:00:00Z");
const stamp = (over: Record<string, unknown>) => ({
  source: "ai", valueModel: "depreciating", usefulLifeYears: 15, annualChangePct: -0.12, salvageValue: 0,
  disposal: "recycle", replacementCost: null, confidence: "high", basis: "", assumptions: [], inputsKey: "x", asOf: NOW.toISOString(), ...over,
});

describe("computeLifecycles", () => {
  let storage: MemStorage;
  beforeEach(() => { storage = new MemStorage(); });

  it("uses each asset's own value and the AI's assumptions; a parent's nested line sums its children once", async () => {
    const house = await storage.createProfile({ name: "Maple St house", type: "property", tags: [],
      fields: { purchasePrice: 400000, purchaseDate: "2019-01-01", currentValue: 520000,
        lifecycleAssumptions: stamp({ valueModel: "appreciating", usefulLifeYears: null, annualChangePct: 0.04, salvageValue: null }) } } as any);
    const furnace = await storage.createProfile({ name: "Furnace", type: "asset", tags: [], parentProfileId: house.id,
      fields: { purchasePrice: 6000, purchaseDate: "2012-01-01", currentValue: 400,
        lifecycleAssumptions: stamp({ usefulLifeYears: 18, salvageValue: -150, replacementCost: 7000, disposal: "dispose" }) } } as any);
    await storage.createExpense({ description: "Furnace repair", amount: 600, category: "home", date: "2026-10-01", linkedProfiles: [house.id, furnace.id] } as any);
    const before = JSON.stringify(await storage.getProfiles());

    const rows = await computeLifecycles(storage, { now: NOW });
    const h = rows.find((r) => r.profileId === house.id)!;
    const f = rows.find((r) => r.profileId === furnace.id)!;

    expect(h.lifecycle.currentValue).toBe(520000); // its own value — never plus the furnace
    expect(h.lifecycle.recommendation!.action).toBe("keep");
    expect(h.nested).toEqual({ count: 1, value: 400, depreciationNext12m: f.lifecycle.depreciationNext12m });
    // The repair linked to both is the furnace's alone.
    expect(f.repairs.last12m).toBe(600);
    expect(h.repairs.last12m).toBe(0);
    expect(f.lifecycle.salvage).toEqual({ value: -150, source: "ai", disposalCost: true });
    expect(f.lifecycle.recommendation!.action).toBe("replace");
    // Reading writes nothing.
    expect(JSON.stringify(await storage.getProfiles())).toBe(before);
  });

  it("a warranty date on the record reaches the recommendation", async () => {
    const tv = await storage.createProfile({ name: "LG OLED TV", type: "asset", tags: [],
      fields: { purchasePrice: 2400, purchaseDate: "2025-12-20", currentValue: 1900, warrantyExpiration: "2026-12-20",
        lifecycleAssumptions: stamp({ usefulLifeYears: 7, salvageValue: 50 }) } } as any);
    const row = (await computeLifecycles(storage, { now: NOW })).find((r) => r.profileId === tv.id)!;
    expect(row.lifecycle.recommendation!.action).toBe("monitor");
    expect(row.lifecycle.recommendation!.headline).toContain("warranty");
  });

  it("an asset with no AI answer yet gets its category's typical figures, labelled; an account gets none", async () => {
    const car = await storage.createProfile({ name: "Honda Civic", type: "vehicle", tags: [], fields: { make: "Honda", model: "Civic", purchasePrice: 19000, purchaseDate: "2016-05-01", currentValue: 7000 } } as any);
    const acct = await storage.createProfile({ name: "Checking", type: "account", tags: [], fields: { balance: 5000 } } as any);
    const rows = await computeLifecycles(storage, { now: NOW });
    const c = rows.find((r) => r.profileId === car.id)!;
    expect(c.lifecycle.assumptions.source).toBe("typical");
    expect(c.lifecycle.confidence).toBe("low");
    expect(rows.find((r) => r.profileId === acct.id)).toBeUndefined();
  });

  it("a user's salvage figure overrides the AI's", async () => {
    const car = await storage.createProfile({ name: "Honda Civic", type: "vehicle", tags: [],
      fields: { purchasePrice: 19000, purchaseDate: "2016-05-01", currentValue: 7000, salvageValue: 2500, salvageValueSource: "user",
        lifecycleAssumptions: stamp({ salvageValue: 1500 }) } } as any);
    const row = (await computeLifecycles(storage, { now: NOW })).find((r) => r.profileId === car.id)!;
    expect(row.lifecycle.salvage).toEqual({ value: 2500, source: "user", disposalCost: false });
  });
});
