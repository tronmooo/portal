// The Assets-tab sweep, server side: one status call over the whole list, no
// fanout, and concurrent per-asset refreshes where one slow or failing
// valuation never holds the others.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemStorage } from "../server/storage";
import { getValuationStatus, refreshValuation } from "../server/valuation/service";
import { setEvidenceProvidersForTest } from "../server/valuation/providers/registry";
import type { ValuationEvidence } from "@shared/valuation/types";

const NOW = new Date("2026-09-16T12:00:00Z");
const DAY = 86_400_000;

function live(value: number, now: Date): ValuationEvidence {
  return {
    id: "live-search:blend", kind: "live_market_search", source: "KBB", provider: "live-search",
    observedAt: now.toISOString(), fetchedAt: now.toISOString(), value, low: value * 0.95, high: value * 1.05,
    currency: "USD", reliability: 0.8, relevance: 0.9, halfLifeMs: 30 * DAY,
  };
}

describe("Assets-tab valuation sweep", () => {
  let storage: MemStorage;
  beforeEach(() => { storage = new MemStorage(); delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { setEvidenceProvidersForTest(null); });

  async function seed() {
    const self = await storage.createProfile({ name: "Me", type: "self", fields: {}, tags: [], notes: "" } as any);
    const mk = (name: string, type: string, fields: any) => storage.createProfile({ name, type, parentProfileId: self.id, fields, tags: [], notes: "" } as any);
    const car = await mk("Honda CR-V", "vehicle", { year: 2021, make: "Honda", model: "CR-V", mileage: 80000 });
    const laptop = await mk("MacBook Air", "asset", { brand: "Apple", model: "MacBook Air M2", purchasePrice: 1200, purchaseDate: "2024-01-05" });
    const house = await mk("123 Evergreen Ln", "property", { address: "123 Evergreen Ln", city: "Boise", state: "ID", currentValue: 345000, currentValueSource: "user" });
    const card = await mk("Visa", "liability", { balance: 2000 });
    const person = await storage.createProfile({ name: "Jane", type: "person", fields: {}, tags: [], notes: "" } as any);
    return { self, car, laptop, house, card, person };
  }

  it("status: one row per owned thing, nothing for people/liabilities, stale until valued, no provider call", async () => {
    const { car, laptop, house } = await seed();
    let calls = 0;
    setEvidenceProvidersForTest([{ id: "live-search", supports: (_c, p) => p.providers.includes("live-search"), fetch: async () => { calls++; return []; } }]);
    const rows = await getValuationStatus(storage, { now: NOW });
    expect(rows.map(r => r.profileId).sort()).toEqual([car.id, laptop.id, house.id].sort());
    expect(rows.every(r => !r.fresh && r.reason === "first_valuation" && r.status === "none")).toBe(true);
    expect(calls).toBe(0);
  });

  it("after refreshes the status is fresh; a profile edit flips only that asset; the read is two storage calls", async () => {
    const { car, laptop } = await seed();
    setEvidenceProvidersForTest([{ id: "live-search", supports: (_c, p) => p.providers.includes("live-search"), fetch: async (run) => [live(run.ctx.name.includes("Honda") ? 20000 : 900, run.now)] }]);
    await Promise.all([car, laptop].map(p => refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW })));
    let rows = await getValuationStatus(storage, { now: NOW });
    const byId = Object.fromEntries(rows.map(r => [r.profileId, r]));
    expect(byId[car.id]).toMatchObject({ fresh: true, status: "valued" });
    expect(byId[car.id].value).toBeGreaterThan(0);
    expect(byId[laptop.id].fresh).toBe(true);

    await storage.updateProfile(car.id, { fields: { mileage: 140000 } } as any);
    rows = await getValuationStatus(storage, { now: NOW });
    expect(rows.find(r => r.profileId === car.id)).toMatchObject({ fresh: false, reason: "inputs_changed" });
    expect(rows.find(r => r.profileId === laptop.id)!.fresh).toBe(true);

    // An irrelevant edit does not flip it.
    await storage.updateProfile(laptop.id, { fields: { insurer: "AppleCare" } } as any);
    rows = await getValuationStatus(storage, { now: NOW });
    expect(rows.find(r => r.profileId === laptop.id)!.fresh).toBe(true);

    // Cost: the sweep reads the profiles list and the valuation store — no per-asset detail.
    let detailReads = 0;
    const orig = storage.getProfileDetail.bind(storage);
    (storage as any).getProfileDetail = async (id: string) => { detailReads++; return orig(id); };
    await getValuationStatus(storage, { now: NOW });
    expect(detailReads).toBe(0);
  });

  it("concurrent refreshes: one slow and one failing asset never block the others, and each persists as it lands", async () => {
    const { car, laptop, house } = await seed();
    const landed: string[] = [];
    setEvidenceProvidersForTest([{
      id: "live-search", supports: (_c, p) => p.providers.includes("live-search"),
      fetch: async (run) => {
        if (run.ctx.name.includes("Honda")) { await new Promise(r => setTimeout(r, 300)); return [live(20000, run.now)]; }
        if (run.ctx.name.includes("Evergreen")) throw new Error("AVM unavailable");
        return [live(900, run.now)];
      },
    }]);
    const t0 = Date.now();
    const runs = [car, laptop, house].map(p =>
      refreshValuation(storage, p.id, { reason: "first_valuation", now: NOW }).then(out => { landed.push(p.name); return out; }),
    );
    const laptopOut = await runs[1];
    const tLaptop = Date.now() - t0;
    expect(laptopOut.snapshot!.record!.status).toBe("valued");
    expect(tLaptop).toBeLessThan(250); // did not wait for the 300ms car
    const [carOut, , houseOut] = await Promise.all(runs);
    expect(carOut.snapshot!.record!.status).toBe("valued");
    // The house's live source failed; its user value still supports a number
    // and the previous canonical value is never replaced with null/zero.
    expect(houseOut.snapshot!.record!.status).toBe("valued");
    expect(houseOut.snapshot!.record!.error).toMatch(/AVM unavailable/);
    expect((await storage.getProfile(house.id))!.fields.currentValue).toBeGreaterThan(0);
    expect(landed[0]).not.toBe("Honda CR-V");
  });

  it("the canonical value the Assets list reads equals the value the profile card shows", async () => {
    const { house } = await seed();
    setEvidenceProvidersForTest([{ id: "live-search", supports: (_c, p) => p.providers.includes("live-search"), fetch: async (run) => [live(360000, run.now)] }]);
    const out = await refreshValuation(storage, house.id, { reason: "first_valuation", now: NOW });
    const { resolveAssetValue } = await import("@shared/asset-value");
    const row = (await storage.getProfiles()).find(p => p.id === house.id)!;
    expect(resolveAssetValue(row)).toBe(out.snapshot!.record!.value);
    expect(row.fields.currentValueAsOf).toBe(out.snapshot!.record!.valuedAt);
    expect(row.fields.userEnteredValue).toBe(345000);
  });

  it("specs the live search auto-filled do not make the list sweep re-value the asset", async () => {
    const { house } = await seed();
    let calls = 0;
    setEvidenceProvidersForTest([{ id: "live-search", supports: (_c, p) => p.providers.includes("live-search"), fetch: async (run) => { calls++; return [{ ...live(360000, run.now), raw: { specs: { sqft: 1468, bedrooms: 4, yearBuilt: 2016 }, missing: [] } }]; } }]);
    const out = await refreshValuation(storage, house.id, { reason: "first_valuation", now: NOW });
    expect(out.filledSpecs).toEqual({ sqft: 1468, bedrooms: 4, yearBuilt: 2016 });
    const row = (await getValuationStatus(storage, { now: NOW })).find(r => r.profileId === house.id)!;
    expect(row.fresh).toBe(true);
    await refreshValuation(storage, house.id, { reason: "scheduled", now: NOW });
    expect(calls).toBe(1);
  });

  it("a record whose profile fingerprint is out of date is healed by the next fresh check, without re-valuing", async () => {
    const { house } = await seed();
    let calls = 0;
    setEvidenceProvidersForTest([{ id: "live-search", supports: (_c, p) => p.providers.includes("live-search"), fetch: async (run) => { calls++; return [live(360000, run.now)]; } }]);
    await refreshValuation(storage, house.id, { reason: "first_valuation", now: NOW });
    const rec = (await storage.getAssetValuation(house.id))!;
    await storage.touchAssetValuation(house.id, { ...rec, profileFingerprint: "stale-from-old-build" });
    expect((await getValuationStatus(storage, { now: NOW })).find(r => r.profileId === house.id)!.fresh).toBe(false);
    const out = await refreshValuation(storage, house.id, { reason: "scheduled", now: NOW });
    expect(out.ran).toBe(false);
    expect(calls).toBe(1);
    expect((await getValuationStatus(storage, { now: NOW })).find(r => r.profileId === house.id)!.fresh).toBe(true);
  });
});
