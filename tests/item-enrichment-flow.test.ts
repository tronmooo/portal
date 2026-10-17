// Pins the server half of the Item Identity Layer (server/item-enrichment)
// against the in-memory storage with the model provider injected: a profile's
// specs are filled with provenance and never over the user's own fields; a
// medication dose entry gains its identity and computed total without touching
// the tracker's dosage; a subscription's price is filled only when missing
// and flagged estimated; Off is a no-op; Ask proposes; a failed provider
// changes nothing.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import {
  enrichItem,
  planProfileCandidate,
  planTrackerEntryCandidate,
  planObligationCandidate,
  type ItemEnrichmentDeps,
  type ModelIdentification,
} from "../server/item-enrichment";
import { ITEM_ENRICHMENT_FIELD_KEY, ITEM_ENRICHMENT_PREF_KEY } from "../shared/item-identity";

const NOW = "2026-10-17T12:00:00.000Z";
let storage: MemStorage;

const crv: ModelIdentification = {
  identity: { name: "2021 Honda CR-V EX AWD", brand: "Honda", model: "CR-V", variant: "EX AWD" },
  attributes: [
    { key: "mpgCity", value: 27, confidence: "exact", basis: "EPA rating, 2021 CR-V AWD" },
    { key: "mpgHighway", value: 32, confidence: "exact" },
    { key: "mpgCombined", value: 29, confidence: "exact" },
    { key: "fuelTankGallons", value: 14, confidence: "high" },
    { key: "oilChangeIntervalMiles", value: 7500, confidence: "medium", basis: "Maintenance Minder, varies" },
    { key: "drivetrain", value: "AWD", confidence: "exact" },
    { key: "seats", value: 5, confidence: "exact" },
    { key: "color", value: "blue", confidence: "exact" }, // not in the policy → dropped
    { key: "towingCapacityLbs", value: 1500, confidence: "low" },  // too uncertain → dropped
  ],
};
const deps = (m: ModelIdentification | null, calls: any[] = []): ItemEnrichmentDeps => ({
  modelIdentify: async (input) => { calls.push(input); return m; },
  now: () => NOW,
});
const noModel: ItemEnrichmentDeps = { modelIdentify: async () => { throw new Error("model must not be reached"); }, now: () => NOW };

beforeEach(() => { storage = new MemStorage(); });

describe("profiles", () => {
  it("a vehicle named exactly gets its specs with provenance; the user's own fields are never overwritten; low/off-policy attributes are dropped", async () => {
    const car = await storage.createProfile({ type: "vehicle", name: "2021 Honda CR-V EX AWD", fields: { year: 2021, make: "Honda", model: "CR-V", trim: "EX AWD", mpgCombined: 31 } });
    const cand = planProfileCandidate(car, "add my 2021 Honda CR-V EX AWD");
    expect(cand).toMatchObject({ target: "profile", id: car.id, kind: "vehicle" });
    expect(cand!.specificity.level).toBe("exact");
    const calls: any[] = [];
    const out = await enrichItem(storage, { target: "profile", id: car.id, mode: "auto", deps: deps(crv, calls) });
    expect(out.status).toBe("applied");
    expect(calls[0].known).toEqual({ mpgCombined: 31 });                    // told what not to repeat
    expect(calls[0].allowed.map((a: any) => a.key)).toContain("fuelTankGallons");
    const after = (await storage.getProfile(car.id))!;
    expect(after.fields.mpgCombined).toBe(31);                                 // user's value kept
    expect(after.fields.mpgCity).toBe(27);
    expect(after.fields.fuelTankGallons).toBe(14);
    expect(after.fields.drivetrain).toBe("AWD");
    expect(after.fields.oilChangeIntervalMiles).toBeUndefined();               // medium: shown, not written
    expect(after.fields.color).toBeUndefined();                                // off-policy
    expect(after.fields.towingCapacityLbs).toBeUndefined();                    // low
    const prov = after.fields[ITEM_ENRICHMENT_FIELD_KEY];
    expect(prov.status).toBe("applied");
    expect(prov.kind).toBe("vehicle");
    expect(prov.userProvided).toEqual(["mpgCombined"]);
    expect(prov.attributes.oilChangeIntervalMiles).toMatchObject({ value: 7500, confidence: "medium", sourceType: "model_estimate" });
    expect(prov.attributes.mpgCity.source).toMatch(/EPA rating/);
    expect(prov.applied).toEqual(expect.arrayContaining(["mpgCity", "mpgHighway", "fuelTankGallons", "drivetrain", "seats"]));
    expect(prov.applied).not.toContain("oilChangeIntervalMiles");
  });

  it("'my car' and a bare brand are not enriched; a model name is", async () => {
    const generic = await storage.createProfile({ type: "vehicle", name: "My car", fields: {} });
    expect(planProfileCandidate(generic, "add my car")).toBeNull();
    const brand = await storage.createProfile({ type: "vehicle", name: "Honda", fields: { make: "Honda" } });
    expect(planProfileCandidate(brand, "add my Honda")).toBeNull();
    const model = await storage.createProfile({ type: "vehicle", name: "Honda CR-V", fields: { make: "Honda", model: "CR-V" } });
    expect(planProfileCandidate(model, "add my Honda CR-V")!.specificity.level).toBe("model");
  });

  it("a provider failure or an empty identification leaves the profile exactly as created", async () => {
    const mac = await storage.createProfile({ type: "asset", name: "MacBook Air M3 15-inch", fields: { purchasePrice: 1299 } });
    const before = JSON.stringify((await storage.getProfile(mac.id))!.fields);
    const failed = await enrichItem(storage, { target: "profile", id: mac.id, mode: "auto", deps: { modelIdentify: async () => { throw new Error("boom"); }, now: () => NOW } });
    expect(failed.status).toBe("failed");
    expect(JSON.stringify((await storage.getProfile(mac.id))!.fields)).toBe(before);
    const empty = await enrichItem(storage, { target: "profile", id: mac.id, mode: "auto", deps: deps(null) });
    expect(empty.status).toBe("skipped");
    expect(JSON.stringify((await storage.getProfile(mac.id))!.fields)).toBe(before);
  });

  it("Off is a no-op; Ask stores a proposal and 'force' applies it, 'reject' keeps the record", async () => {
    await storage.setPreference(ITEM_ENRICHMENT_PREF_KEY, "off");
    const car = await storage.createProfile({ type: "vehicle", name: "2021 Honda CR-V EX", fields: {} });
    expect((await enrichItem(storage, { target: "profile", id: car.id, deps: deps(crv) })).status).toBe("skipped");
    expect((await storage.getProfile(car.id))!.fields[ITEM_ENRICHMENT_FIELD_KEY]).toBeUndefined();

    await storage.setPreference(ITEM_ENRICHMENT_PREF_KEY, "ask");
    const proposed = await enrichItem(storage, { target: "profile", id: car.id, deps: deps(crv) });
    expect(proposed.status).toBe("proposed");
    expect((await storage.getProfile(car.id))!.fields.mpgCity).toBeUndefined();
    expect((await storage.getProfile(car.id))!.fields[ITEM_ENRICHMENT_FIELD_KEY].status).toBe("proposed");
    const applied = await enrichItem(storage, { target: "profile", id: car.id, intent: "force", deps: noModel });
    expect(applied.status).toBe("applied");
    expect((await storage.getProfile(car.id))!.fields.mpgCity).toBe(27);

    const other = await storage.createProfile({ type: "vehicle", name: "2021 Honda CR-V EX", fields: {} });
    await enrichItem(storage, { target: "profile", id: other.id, deps: deps(crv) });
    const rejected = await enrichItem(storage, { target: "profile", id: other.id, intent: "reject", deps: noModel });
    expect(rejected.status).toBe("skipped");
    expect((await storage.getProfile(other.id))!.fields.mpgCity).toBeUndefined();
  });

  it("the legacy nutrition-only preference still governs when the new key was never set", async () => {
    await storage.setPreference("nutrition_enrichment", "off");
    const car = await storage.createProfile({ type: "vehicle", name: "2021 Honda CR-V EX", fields: {} });
    expect((await enrichItem(storage, { target: "profile", id: car.id, deps: deps(crv) })).status).toBe("skipped");
  });
});

describe("tracker entries: medications and supplements", () => {
  async function medTracker(name: string) {
    return storage.createTracker({ name, category: "medication", fields: [
      { name: "drug", type: "text", isPrimary: true }, { name: "dosage", type: "number", unit: "mg" }, { name: "unit", type: "text" },
    ] });
  }
  it("'two Advil 200 mg tablets' → ibuprofen identified, 400 mg total computed, the tracker's dosage untouched — no model call", async () => {
    const t = await medTracker("Advil");
    const entry = (await storage.logEntry({ trackerId: t.id, values: { drug: "Advil", dosage: 200 } }))!;
    const cand = planTrackerEntryCandidate(entry, t, "I took two Advil 200 mg tablets");
    expect(cand).toMatchObject({ target: "trackerEntry", kind: "medication" });
    const out = await enrichItem(storage, { target: "trackerEntry", id: entry.id, trackerId: t.id, message: "I took two Advil 200 mg tablets", mode: "auto", deps: noModel });
    expect(out.status).toBe("applied");
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values.dosage).toBe(200);                 // the user's per-tablet strength stays
    expect(after.values.totalDoseMg).toBe(400);
    expect(after.values.activeIngredient).toBe("ibuprofen");
    expect(after.values.unitCount).toBe(2);
    const prov = (after.computed as any).item;
    expect(prov.identity).toMatchObject({ name: "Advil", family: "ibuprofen" });
    expect(prov.attributes.totalDoseMg.calculatedOrDirect).toBe("calculated");
    expect(prov.attributes.strengthMg.sourceType).toBe("user");
  });

  it("the in-turn pass identifies from the table with no model; an unknown device is left for the full pass", async () => {
    const t = await medTracker("Advil");
    const entry = (await storage.logEntry({ trackerId: t.id, values: { drug: "Advil", dosage: 200 } }))!;
    const out = await enrichItem(storage, { target: "trackerEntry", id: entry.id, trackerId: t.id, message: "I took two Advil 200 mg tablets", mode: "auto", sync: true, deps: { modelIdentify: async () => { throw new Error("no model in the turn"); } } });
    expect(out.status).toBe("applied");
    expect(out.needsMore).toBeFalsy();
    const dev = await storage.createProfile({ type: "asset", name: "EcoFlow Delta 2", fields: {} });
    const sync = await enrichItem(storage, { target: "profile", id: dev.id, mode: "auto", sync: true });
    expect(sync.status).toBe("skipped");
    expect(sync.needsMore).toBe(true);
  });

  it("'I took Tylenol' identifies acetaminophen and keeps the strength ambiguous", async () => {
    const t = await medTracker("Tylenol");
    const entry = (await storage.logEntry({ trackerId: t.id, values: { drug: "Tylenol" } }))!;
    const out = await enrichItem(storage, { target: "trackerEntry", id: entry.id, trackerId: t.id, message: "I took Tylenol", mode: "auto", deps: noModel });
    expect(out.status).toBe("applied");
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values.activeIngredient).toBe("acetaminophen");
    expect(after.values.totalDoseMg).toBeUndefined();
    expect(after.values.dosage).toBeUndefined();
    expect((after.computed as any).item.attributes.strengthAmbiguous.value).toBe(true);
  });

  it("'I took pain medicine' is generic — nothing to identify, nothing changes", async () => {
    const t = await medTracker("Pain medicine");
    const entry = (await storage.logEntry({ trackerId: t.id, values: { drug: "pain medicine" } }))!;
    expect(planTrackerEntryCandidate(entry, t, "I took pain medicine")).toBeNull();
    const out = await enrichItem(storage, { target: "trackerEntry", id: entry.id, trackerId: t.id, message: "I took pain medicine", mode: "auto", deps: noModel });
    expect(out.status).toBe("skipped");
    expect((await storage.getTrackerEntry(entry.id))!.values).toEqual({ drug: "pain medicine" });
  });

  it("'two Nature Made fish oil capsules' → serving, omega-3 per the label, scaled to the count", async () => {
    const t = await storage.createTracker({ name: "Fish Oil", category: "medication", fields: [{ name: "drug", type: "text", isPrimary: true }, { name: "dosage", type: "number", unit: "mg" }] });
    const entry = (await storage.logEntry({ trackerId: t.id, values: { drug: "Nature Made Fish Oil" } }))!;
    const out = await enrichItem(storage, { target: "trackerEntry", id: entry.id, trackerId: t.id, message: "I took two Nature Made fish oil capsules", mode: "auto", deps: noModel });
    expect(out.status).toBe("applied");
    expect(out.enrichment!.kind).toBe("supplement");
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values.omega3Mg).toBe(720);
    expect(after.values.unitCount).toBe(2);
    expect((after.computed as any).item.attributes.servingSize.value).toBe("2 softgels");
    expect((after.computed as any).item.attributes.epaMg).toBeUndefined(); // the label does not split EPA/DHA → not invented
  });

  it("a Nutrition tracker entry is the food layer's, not this one's", async () => {
    const t = await storage.createTracker({ name: "Nutrition", category: "nutrition", fields: [{ name: "calories", type: "number", isPrimary: true }, { name: "item", type: "text" }] });
    const entry = (await storage.logEntry({ trackerId: t.id, values: { item: "Coke", calories: 140 } }))!;
    const cand = planTrackerEntryCandidate(entry, t, "I drank a Coke");
    expect(cand && !("target" in cand)).toBe(true);
  });
});

describe("obligations", () => {
  it("'Netflix Premium' with no amount gets the plan price filled and flagged estimated; a stated amount is never replaced", async () => {
    const ob = await storage.createObligation({ name: "Netflix Premium", amount: 0, frequency: "monthly", category: "subscription", nextDueDate: "2026-11-01" } as any);
    const cand = planObligationCandidate(ob, "I pay for Netflix Premium every month");
    expect(cand).toMatchObject({ target: "obligation", kind: "subscription" });
    const plan: ModelIdentification = {
      identity: { name: "Netflix Premium", brand: "Netflix", variant: "Premium" },
      attributes: [
        { key: "planTier", value: "Premium", confidence: "exact" },
        { key: "price", value: 24.99, confidence: "exact", basis: "US price as of 2025" }, // prices are capped at medium
        { key: "billingFrequency", value: "monthly", confidence: "exact" },
        { key: "planFeatures", value: ["4K", "4 screens", "spatial audio"], confidence: "high" },
      ],
    };
    const out = await enrichItem(storage, { target: "obligation", id: ob.id, mode: "auto", intent: "force", deps: deps(plan) });
    expect(out.status).toBe("applied");
    expect(out.enrichment!.attributes.price.confidence).toBe("medium");
    const after = (await storage.getObligation(ob.id))!;
    expect(after.amount).toBe(24.99);
    expect(after.fields!.amountEstimated).toBe(true);
    expect(after.fields!.planTier).toBe("Premium");
    expect(after.fields![ITEM_ENRICHMENT_FIELD_KEY].applied).toEqual(expect.arrayContaining(["planTier", "price"]));

    const paid = await storage.createObligation({ name: "Netflix Premium", amount: 22.99, frequency: "monthly", category: "subscription", nextDueDate: "2026-11-01" } as any);
    const out2 = await enrichItem(storage, { target: "obligation", id: paid.id, mode: "auto", intent: "force", deps: deps(plan) });
    expect(out2.status).toBe("applied");
    expect((await storage.getObligation(paid.id))!.amount).toBe(22.99);
    expect((await storage.getObligation(paid.id))!.fields!.amountEstimated).toBeUndefined();
  });

  it("in Automatic mode a price-only identification (medium) is stored as a proposal, not written", async () => {
    const ob = await storage.createObligation({ name: "Spotify Premium", amount: 0, frequency: "monthly", category: "subscription", nextDueDate: "2026-11-01" } as any);
    const out = await enrichItem(storage, { target: "obligation", id: ob.id, mode: "auto", deps: deps({ identity: { name: "Spotify Premium" }, attributes: [{ key: "price", value: 11.99, confidence: "high" }] }) });
    expect(out.status).toBe("proposed");
    expect((await storage.getObligation(ob.id))!.amount).toBe(0);
  });
});
