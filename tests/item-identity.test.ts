// Pins the pure Item Identity Layer (shared/item-identity) on the examples it
// was specified with: the kind of item behind a mention, the four specificity
// levels (generic / category / model / exact), the per-kind attribute policy
// (only what identity materially changes), and deterministic OTC medication
// identity — a brand pins the family, a strength is never guessed when the
// product comes in several.
import { describe, it, expect } from "vitest";
import {
  inferItemKind,
  classifyItemSpecificity,
  decideItemEnrichment,
  itemAppliesAutomatically,
  identifyMedication,
  parseDoseText,
  medicationAttributes,
  userProvidedAttributeKeys,
  buildAttributePatch,
  ITEM_ATTRIBUTE_POLICY,
  MEDICATION_DB,
  type ProvenancedAttribute,
} from "../shared/item-identity";

const NOW = "2026-10-17T12:00:00.000Z";

describe("kind inference", () => {
  it("reads the kind from the words", () => {
    expect(inferItemKind("I took Advil")).toBe("medication");
    expect(inferItemKind("two Nature Made fish oil capsules")).toBe("supplement");
    expect(inferItemKind("Purina Pro Plan Sensitive Skin & Stomach Salmon")).toBe("pet_food");
    expect(inferItemKind("2021 Honda CR-V EX")).toBe("vehicle");
    expect(inferItemKind("MacBook Air M3 15-inch")).toBe("device");
    expect(inferItemKind("Tesla Model Y Long Range")).toBe("vehicle");
    expect(inferItemKind("Netflix Premium")).toBe("subscription");
    expect(inferItemKind("Chase Sapphire Preferred")).toBe("account");
    expect(inferItemKind("Garmin Forerunner 965")).toBe("wearable");
    expect(inferItemKind("Dyson V15")).toBe("appliance");
    expect(inferItemKind("20x25x1 MERV 13 HVAC filter")).toBe("consumable");
  });
  it("where it was logged outranks the words", () => {
    expect(inferItemKind("Fish Oil", { trackerCategory: "medication", trackerName: "Fish Oil" })).toBe("supplement");
    expect(inferItemKind("Lisinopril", { trackerCategory: "medication" })).toBe("medication");
    expect(inferItemKind("Honda", { profileType: "vehicle" })).toBe("vehicle");
    expect(inferItemKind("Spotify", { obligationCategory: "subscription" })).toBe("subscription");
    expect(inferItemKind("Coke", { trackerCategory: "nutrition" })).toBe("beverage");
    expect(inferItemKind("kibble", { trackerName: "Dog Food" })).toBe("pet_food");
  });
});

describe("specificity: generic → category → model → exact", () => {
  it("the vehicle ladder", () => {
    expect(classifyItemSpecificity("my car", "vehicle").level).toBe("generic");
    expect(classifyItemSpecificity("Honda", "vehicle").level).toBe("category");
    expect(classifyItemSpecificity("Honda CR-V", "vehicle").level).toBe("model");
    const exact = classifyItemSpecificity("2021 Honda CR-V EX AWD", "vehicle");
    expect(exact.level).toBe("exact");
    expect(exact.signals).toEqual(expect.arrayContaining(["year", "model", "trim"]));
  });
  it("the medication ladder preserves the strength as the exact signal", () => {
    expect(classifyItemSpecificity("pain medicine", "medication").level).toBe("generic");
    expect(classifyItemSpecificity("Advil", "medication").level).toBe("category");
    expect(classifyItemSpecificity("two Advil 200 mg tablets", "medication").level).toBe("exact");
  });
  it("the other spec examples land where expected", () => {
    expect(classifyItemSpecificity("MacBook Air M3 15-inch", "device").level).toBe("exact");
    expect(classifyItemSpecificity("Tesla Model Y Long Range", "vehicle").level).toBe("exact");
    expect(classifyItemSpecificity("Netflix Premium", "subscription").level).toBe("exact");
    expect(classifyItemSpecificity("Netflix", "subscription").level).toBe("model");
    expect(classifyItemSpecificity("Chase Sapphire Preferred", "account").level).toBe("exact");
    expect(classifyItemSpecificity("Nature Made Fish Oil 1200 mg", "supplement").level).toBe("exact");
    expect(classifyItemSpecificity("Garmin Forerunner 965", "wearable").level).toBe("model");
    expect(classifyItemSpecificity("Dyson V15", "appliance").level).toBe("model");
    expect(classifyItemSpecificity("20x25x1 MERV 13 HVAC filter", "consumable").level).toBe("exact");
    expect(classifyItemSpecificity("Purina Pro Plan Sensitive Skin & Stomach Salmon", "pet_food").level).toBe("exact");
    expect(classifyItemSpecificity("dog food", "pet_food").level).toBe("generic");
  });
});

describe("decision: enrich only when identity changes the tracking", () => {
  it("never for generic wording; a brand alone only for medication/supplement/subscription families", () => {
    expect(decideItemEnrichment("auto", "vehicle", classifyItemSpecificity("my car", "vehicle")).attempt).toBe(false);
    expect(decideItemEnrichment("auto", "vehicle", classifyItemSpecificity("Honda", "vehicle")).attempt).toBe(false);
    expect(decideItemEnrichment("auto", "vehicle", classifyItemSpecificity("Honda CR-V", "vehicle")).attempt).toBe(true);
    expect(decideItemEnrichment("auto", "medication", classifyItemSpecificity("Advil", "medication")).attempt).toBe(true);
    expect(decideItemEnrichment("off", "medication", classifyItemSpecificity("Advil 200 mg", "medication")).attempt).toBe(false);
    expect(decideItemEnrichment("auto", "other", classifyItemSpecificity("Some Thing", "other")).attempt).toBe(false);
  });
  it("Automatic writes high+ onto the record; Ask only exact", () => {
    expect(itemAppliesAutomatically("auto", "high")).toBe(true);
    expect(itemAppliesAutomatically("auto", "medium")).toBe(false);
    expect(itemAppliesAutomatically("ask", "high")).toBe(false);
    expect(itemAppliesAutomatically("ask", "exact")).toBe(true);
  });
  it("every kind's policy names only attributes with a tracking effect, each key once", () => {
    for (const [kind, specs] of Object.entries(ITEM_ATTRIBUTE_POLICY)) {
      const keys = specs.map((s) => s.key);
      expect(new Set(keys).size, kind).toBe(keys.length);
      for (const s of specs) expect(s.effect, `${kind}.${s.key}`).toBeTruthy();
    }
    expect(ITEM_ATTRIBUTE_POLICY.vehicle.map((s) => s.key)).toEqual(expect.arrayContaining(["mpgCombined", "fuelTankGallons", "oilChangeIntervalMiles"]));
    expect(ITEM_ATTRIBUTE_POLICY.food).toEqual([]); // nutrition has its own layer
  });
});

describe("medication identity and dose", () => {
  it("every product has a brand, a generic and at least one strength", () => {
    for (const p of MEDICATION_DB) {
      expect(p.strengthsMg.length, p.id).toBeGreaterThan(0);
      expect(p.aliases.length, p.id).toBeGreaterThan(0);
    }
  });
  it("'I took Advil' → ibuprofen family, single OTC strength, no count", () => {
    const id = identifyMedication("I took Advil")!;
    expect(id.genericName).toBe("ibuprofen");
    expect(id.strengthMg).toBe(200);
    expect(id.strengthSource).toBe("product");
    expect(id.dose.count).toBeNull();
    expect(id.totalDoseMg).toBeNull();
  });
  it("'I took two Advil 200 mg tablets' → exact 400 mg total", () => {
    const id = identifyMedication("I took two Advil 200 mg tablets")!;
    expect(id.dose).toEqual({ count: 2, statedStrengthMg: 200, form: "tablet" });
    expect(id.strengthSource).toBe("user");
    expect(id.totalDoseMg).toBe(400);
    const attrs = medicationAttributes(id, NOW);
    expect(attrs.totalDoseMg).toMatchObject({ value: 400, unit: "mg", calculatedOrDirect: "calculated", confidence: "exact" });
    expect(attrs.activeIngredient.value).toBe("ibuprofen");
    expect(attrs.strengthAmbiguous.value).toBe(false);
  });
  it("'I took Tylenol' preserves the ambiguity — three common strengths, none guessed", () => {
    const id = identifyMedication("I took Tylenol")!;
    expect(id.genericName).toBe("acetaminophen");
    expect(id.strengthMg).toBeNull();
    expect(id.strengthAmbiguous).toBe(true);
    expect(medicationAttributes(id, NOW).strengthMg).toBeUndefined();
    expect(medicationAttributes(id, NOW).strengthAmbiguous.value).toBe(true);
  });
  it("a variant word resolves the strength; a different ingredient is named", () => {
    expect(identifyMedication("Tylenol Extra Strength, 2 caplets")).toMatchObject({ strengthMg: 500, totalDoseMg: 1000 });
    expect(identifyMedication("one Aleve")).toMatchObject({ genericName: "naproxen sodium", strengthMg: 220, totalDoseMg: 220 });
    expect(identifyMedication("Sudafed PE")!.genericName).toBe("phenylephrine");
    expect(identifyMedication("took 2 melatonin")).toMatchObject({ strengthAmbiguous: true, totalDoseMg: null });
    expect(identifyMedication("I took pain medicine")).toBeNull();
  });
  it("parseDoseText handles words and forms", () => {
    expect(parseDoseText("a couple of ibuprofen capsules")).toMatchObject({ count: 2, form: "capsule" });
    expect(parseDoseText("3 gummies")).toMatchObject({ count: 3, form: "gummy" });
    expect(parseDoseText("10 mg")).toMatchObject({ count: null, statedStrengthMg: 10 });
  });
});

describe("record patching never touches the user's fields", () => {
  const attr = (value: any, confidence: ProvenancedAttribute["confidence"]): ProvenancedAttribute => ({
    value, label: "x", source: "test", sourceType: "model_estimate", confidence, calculatedOrDirect: "direct", effect: "specifications", enrichedAt: NOW,
  });
  it("existing non-empty attribute keys are the user's; the patch skips them and anything below the floor", () => {
    const existing = { year: 2021, make: "Honda", model: "CR-V", mpgCombined: 30, fuelTankGallons: "" };
    expect(userProvidedAttributeKeys("vehicle", existing)).toEqual(["mpgCombined"]);
    const patch = buildAttributePatch("vehicle", {
      mpgCombined: attr(29, "exact"),
      fuelTankGallons: attr(14, "high"),
      oilChangeIntervalMiles: attr(7500, "medium"),
      notAnAttribute: attr(1, "exact"),
    }, ["mpgCombined"]);
    expect(patch).toEqual({ fuelTankGallons: 14 });
  });
});
