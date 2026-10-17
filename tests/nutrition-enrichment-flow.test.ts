// Pins the server half of the Item Enrichment Layer
// (server/nutrition-enrichment) against the in-memory storage, with every
// network source injected — so the suite proves the ORDER the feature rests
// on: the base entry is saved first and stands untouched whatever the lookup
// does; the user's own numbers are never replaced; one source item moves its
// linked trackers; a portion edit rescales everything in place; deleting the
// source removes what it derived; Off is a no-op and Ask waits for the user.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import {
  enrichNutritionEntry,
  rescaleNutritionEntry,
  planEnrichmentCandidate,
  componentPhrases,
  nutrientsFromOffNutriments,
  type EnrichmentDeps,
} from "../server/nutrition-enrichment";
import { removeTrackerEntry, updateTrackerEntryEverywhere } from "../server/tracker-entries";
import { LINKED_SOURCE_KEY, NUTRITION_ENRICHMENT_PREF_KEY } from "../shared/nutrition-enrichment";
import { parsePackageQuantity, loadLearnedAliases, aliasKey } from "../server/nutrition-enrichment";
import { sanitizeTrackerEntryValues } from "../server/tracker-entry-guard";

const NOW = "2026-10-16T12:00:00.000Z";
const NUTRITION_FIELDS = [
  { name: "calories", type: "number" as const, unit: "kcal", isPrimary: true },
  { name: "protein", type: "number" as const, unit: "g" },
  { name: "carbs", type: "number" as const, unit: "g" },
  { name: "fat", type: "number" as const, unit: "g" },
  { name: "item", type: "text" as const },
];

/** No network: a lookup that reaches a source that is not wired throws loudly. */
const offline: EnrichmentDeps = {
  productLookup: async () => { throw new Error("network must not be reached for internal matches"); },
  modelEstimate: async () => { throw new Error("model must not be reached for internal matches"); },
  now: () => NOW,
};

let storage: MemStorage;
let nutritionId: string;
let hydrationId: string;

async function logFood(values: Record<string, any>) {
  const entry = await storage.logEntry({ trackerId: nutritionId, values });
  if (!entry) throw new Error("base entry did not save");
  return entry;
}

beforeEach(async () => {
  storage = new MemStorage();
  const nutrition = await storage.createTracker({ name: "Nutrition", category: "nutrition", fields: NUTRITION_FIELDS });
  nutritionId = nutrition.id;
  const hydration = await storage.createTracker({ name: "Hydration", category: "health", fields: [{ name: "amount", type: "number", unit: "oz", isPrimary: true }] });
  hydrationId = hydration.id;
});

describe("the base entry is saved first and never depends on the lookup", () => {
  it("a candidate is planned without I/O for a specific food, and not for a vague one", async () => {
    const coke = await logFood({ item: "Coca-Cola (12 oz)", calories: 150, sugar: 40 });
    const tracker = (await storage.getTracker(nutritionId))!;
    const cand = planEnrichmentCandidate(coke, tracker, "I drank a 12 oz Coke");
    expect(cand).toMatchObject({ entryId: coke.id, trackerId: nutritionId, item: "Coca-Cola (12 oz)", message: "I drank a 12 oz Coke" });
    expect(cand!.specificity.level).toBe("product");
    const vague = await logFood({ item: "Some fruit", calories: 80 });
    expect(planEnrichmentCandidate(vague, tracker, "I had some fruit")).toBeNull();
    const run = await storage.createTracker({ name: "Running", category: "fitness", fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }] });
    expect(planEnrichmentCandidate({ id: "x", values: { distance: 3 } }, run, "ran 3 miles")).toBeNull();
  });

  it("a lookup that throws leaves the saved entry exactly as the agent wrote it", async () => {
    const entry = await logFood({ item: "Trader Joe's Chicken Shawarma Bowl", calories: 400, protein: 20, carbs: 45, fat: 12 });
    const before = JSON.stringify((await storage.getTrackerEntry(entry.id))!.values);
    const out = await enrichNutritionEntry(storage, {
      entryId: entry.id, message: "I ate a Trader Joe's Chicken Shawarma Bowl", mode: "auto",
      deps: { productLookup: async () => { throw new Error("boom"); }, modelEstimate: async () => { throw new Error("boom"); }, now: () => NOW },
    });
    expect(["skipped", "failed"]).toContain(out.status);
    expect(JSON.stringify((await storage.getTrackerEntry(entry.id))!.values)).toBe(before);
  });

  it("a partial identification does not apply a partial meal total", async () => {
    const entry = await logFood({ item: "Big Mac + mystery sauce thing", calories: 700 });
    const out = await enrichNutritionEntry(storage, {
      entryId: entry.id, mode: "auto",
      deps: { productLookup: async () => null, modelEstimate: async () => null, now: () => NOW },
    });
    expect(out.status).toBe("skipped");
    expect(out.reason).toMatch(/could not identify/);
    expect((await storage.getTrackerEntry(entry.id))!.values.calories).toBe(700);
  });
});

describe("automatic enrichment from the internal reference (no network)", () => {
  it("'I drank a 12 oz Coke': label values, provenance, and a linked Hydration row carrying the source id", async () => {
    const entry = await logFood({ item: "Coca-Cola (12 oz)", calories: 150, sugar: 40, carbs: 40 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, message: "I drank a 12 oz Coke", mode: "auto", deps: offline });
    expect(out.status).toBe("applied");
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values).toMatchObject({ item: "Coca-Cola (12 oz)", calories: 140, sugar: 39, carbs: 39, sodium: 45, caffeine: 34 });
    const n = (after.computed as any).nutrition;
    expect(n.status).toBe("applied");
    expect(n.confidence).toBe("exact");
    expect(n.totals.calories).toMatchObject({ value: 140, unit: "kcal", sourceType: "manufacturer", confidence: "exact", calculatedOrDirect: "direct" });
    expect(n.components[0]).toMatchObject({ sourceItem: "Coca-Cola Classic", userQuantity: "Coca-Cola (12 oz)", servings: 1 });
    // the ≈-marker provenance the tracker UIs already read: a label value is not an estimate
    expect((after.computed as any).enrichment.calculated.calories.isEstimated).toBe(false);
    // the tracker gained first-class fields for what was written
    const tracker = (await storage.getTracker(nutritionId))!;
    expect(tracker.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["sugar", "sodium", "caffeine"]));
    expect(tracker.fields.find((f) => f.name === "sodium")!.unit).toBe("mg");
    // linked measurement: 355 ml of fluid on the Hydration tracker the user already has
    const hydration = (await storage.getTracker(hydrationId))!;
    expect(hydration.entries).toHaveLength(1);
    expect(hydration.entries[0].values.amount).toBeCloseTo(12, 0);
    expect(hydration.entries[0].values[LINKED_SOURCE_KEY]).toBe(entry.id);
    expect(n.linkedEntries).toEqual([expect.objectContaining({ trackerId: hydrationId, entryId: hydration.entries[0].id, nutrient: "fluidMl" })]);
    // no Caffeine tracker exists → none is created
    expect((await storage.getTrackers()).map((t) => t.name)).not.toContain("Caffeine");
  });

  it("is idempotent: enriching twice neither re-runs nor doubles the linked row", async () => {
    const entry = await logFood({ item: "Coke", calories: 150 });
    await enrichNutritionEntry(storage, { entryId: entry.id, message: "a Coke", mode: "auto", deps: offline });
    const again = await enrichNutritionEntry(storage, { entryId: entry.id, message: "a Coke", mode: "auto", deps: offline });
    expect(again.status).toBe("applied");
    expect(again.reason).toBe("already enriched");
    expect((await storage.getTracker(hydrationId))!.entries).toHaveLength(1);
  });

  it("the spec's meal: oatmeal packet + 2% milk → two components, a calculated total, the base estimate replaced by label data", async () => {
    const entry = await logFood({ item: "Quaker Instant Oatmeal Maple & Brown Sugar (1 packet) + 2% milk (1 cup)", calories: 300, protein: 10, carbs: 50, fat: 6 });
    const out = await enrichNutritionEntry(storage, {
      entryId: entry.id, message: "I ate 1 packet of Quaker Instant Oatmeal Maple & Brown Sugar with 1 cup of 2% milk", mode: "auto", deps: offline,
    });
    expect(out.status).toBe("applied");
    const n = out.enrichment!;
    expect(n.components.map((c) => c.sourceItem)).toEqual(["Quaker Instant Oatmeal Maple & Brown Sugar", "Milk, 2% reduced fat"]);
    expect(n.components.map((c) => c.userQuantity)).toEqual(["Quaker Instant Oatmeal Maple & Brown Sugar (1 packet)", "2% milk (1 cup)"]);
    expect(n.totals.calories).toMatchObject({ value: 282, sourceType: "calculated", calculatedOrDirect: "calculated" });
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values.calories).toBe(282);
    expect(after.values.protein).toBeCloseTo(12.1, 1);
    expect(after.values.sodium).toBe(375);
    // milk is a drink, but the meal is food: still one entry, and the linked fluid goes to Hydration
    expect((await storage.getTracker(nutritionId))!.entries).toHaveLength(1);
    expect((await storage.getTracker(hydrationId))!.entries[0].values.amount).toBeCloseTo(8.1, 0);
  });

  it("'3 eggs, 2 pieces of wheat toast with butter, a banana, and coffee with creamer' stays ONE entry with six components", async () => {
    const entry = await logFood({ item: "3 eggs, 2 pieces of wheat toast with butter, a banana, and coffee with creamer", calories: 600 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, mode: "auto", deps: offline });
    expect(out.status).toBe("applied");
    expect(out.enrichment!.components).toHaveLength(6);
    expect((await storage.getTracker(nutritionId))!.entries).toHaveLength(1);
    expect(out.enrichment!.totals.calories!.value).toBe(Math.round(72 * 3 + 80 * 2 + 102 + 105 + 2 + 20));
    expect(out.enrichment!.totals.caffeine!.value).toBe(95);
  });

  it("'2 eggs' needs no source beyond the reference and never reaches the network", async () => {
    const entry = await logFood({ item: "2 eggs", calories: 140 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, message: "I ate 2 eggs", mode: "auto", deps: offline });
    expect(out.status).toBe("applied");
    expect(out.enrichment!.components[0]).toMatchObject({ servings: 2, sourceType: "reference" });
    expect((await storage.getTrackerEntry(entry.id))!.values.calories).toBe(144);
  });
});

describe("user-provided values are preserved", () => {
  it("'it says 210 calories and 20g protein' keeps the user's numbers beside the product's", async () => {
    const entry = await logFood({ item: "Quest protein bar", calories: 210, protein: 20 });
    const out = await enrichNutritionEntry(storage, {
      entryId: entry.id, message: "I ate a Quest protein bar. It says 210 calories and 20g protein.", mode: "auto", deps: offline,
    });
    expect(out.status).toBe("applied");
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values.calories).toBe(210);
    expect(after.values.protein).toBe(20);
    expect(after.values.carbs).toBe(21); // filled from the product
    const n = (after.computed as any).nutrition;
    expect(n.userProvided).toEqual(["calories", "protein"]);
    expect(n.totals.calories).toMatchObject({ value: 210, sourceType: "user" });
    expect(n.components[0].nutrients.calories.value).toBe(190); // the product's own value, kept for comparison
  });

  it("a nutrient the user edits by hand afterwards becomes theirs in the provenance", async () => {
    const entry = await logFood({ item: "Coke", calories: 150 });
    await enrichNutritionEntry(storage, { entryId: entry.id, mode: "auto", deps: offline });
    const edited = await updateTrackerEntryEverywhere(storage, { trackerId: nutritionId, entryId: entry.id, patch: { values: { sugar: 30 } } });
    expect(edited.ok).toBe(true);
    const n = (edited.entry.computed as any).nutrition;
    expect(n.userProvided).toContain("sugar");
    expect(n.totals.sugar).toMatchObject({ value: 30, sourceType: "user" });
    expect(n.totals.calories.sourceType).toBe("manufacturer"); // untouched
  });
});

describe("editing and deleting", () => {
  it("'actually I only ate half': values, components and the linked Hydration row all halve in place", async () => {
    const entry = await logFood({ item: "Coke", calories: 150 });
    await enrichNutritionEntry(storage, { entryId: entry.id, message: "a Coke", mode: "auto", deps: offline });
    const half = await rescaleNutritionEntry(storage, { entryId: entry.id, factor: 0.5, now: () => NOW });
    expect(half.ok).toBe(true);
    expect(half.linkedUpdated).toBe(1);
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values.calories).toBe(70);
    expect(after.values.sugar).toBeCloseTo(19.5, 1);
    expect(after.values.caffeine).toBe(17);
    expect((after.computed as any).nutrition.servingFactor).toBe(0.5);
    expect((after.computed as any).nutrition.components[0].servings).toBe(0.5);
    expect((await storage.getTracker(hydrationId))!.entries[0].values.amount).toBeCloseTo(6, 0);
    expect((await storage.getTracker(nutritionId))!.entries).toHaveLength(1);
  });

  it("an un-enriched entry rescales its own nutrient fields", async () => {
    const entry = await logFood({ item: "Cereal", calories: 220, protein: 6 });
    const half = await rescaleNutritionEntry(storage, { entryId: entry.id, factor: 0.5 });
    expect(half.ok).toBe(true);
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values).toMatchObject({ item: "Cereal", calories: 110, protein: 3 });
    expect((after.computed as any).servingFactor).toBe(0.5);
  });

  it("deleting the Coke deletes the Hydration row it produced — no orphaned fluid", async () => {
    const entry = await logFood({ item: "Coke", calories: 150 });
    await enrichNutritionEntry(storage, { entryId: entry.id, mode: "auto", deps: offline });
    expect((await storage.getTracker(hydrationId))!.entries).toHaveLength(1);
    const removed = await removeTrackerEntry(storage, { trackerId: nutritionId, entryId: entry.id });
    expect(removed.ok).toBe(true);
    expect((await storage.getTracker(hydrationId))!.entries).toHaveLength(0);
    expect((await storage.getTracker(nutritionId))!.entries).toHaveLength(0);
  });
});

describe("modes", () => {
  it("Off: nothing is looked up and nothing changes", async () => {
    await storage.setPreference(NUTRITION_ENRICHMENT_PREF_KEY, "off");
    const entry = await logFood({ item: "Coke", calories: 150 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, deps: offline });
    expect(out.status).toBe("skipped");
    expect(out.reason).toMatch(/off/);
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values.calories).toBe(150);
    expect((after.computed as any).nutrition).toBeUndefined();
    expect((await storage.getTracker(hydrationId))!.entries).toHaveLength(0);
  });

  it("Ask when uncertain: a non-exact match is proposed, not applied, until the user chooses", async () => {
    await storage.setPreference(NUTRITION_ENRICHMENT_PREF_KEY, "ask");
    const entry = await logFood({ item: "Big Mac", calories: 550 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, deps: offline });
    expect(out.status).toBe("proposed");
    expect((await storage.getTrackerEntry(entry.id))!.values.calories).toBe(550);
    expect(((await storage.getTrackerEntry(entry.id))!.computed as any).nutrition.status).toBe("proposed");
    // Use exact match
    const accepted = await enrichNutritionEntry(storage, { entryId: entry.id, intent: "force", deps: offline });
    expect(accepted.status).toBe("applied");
    expect((await storage.getTrackerEntry(entry.id))!.values.calories).toBe(590);
  });

  it("Ask: 'Use generic estimate' keeps the base numbers and records the choice", async () => {
    await storage.setPreference(NUTRITION_ENRICHMENT_PREF_KEY, "ask");
    const entry = await logFood({ item: "Big Mac", calories: 550 });
    await enrichNutritionEntry(storage, { entryId: entry.id, deps: offline });
    const rejected = await enrichNutritionEntry(storage, { entryId: entry.id, intent: "reject", deps: offline });
    expect(rejected.status).toBe("skipped");
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values.calories).toBe(550);
    expect((after.computed as any).nutrition.status).toBe("skipped");
  });

  it("Ask: an exact label match applies by itself", async () => {
    await storage.setPreference(NUTRITION_ENRICHMENT_PREF_KEY, "ask");
    const entry = await logFood({ item: "Coke", calories: 150 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, message: "I drank a Coke", deps: offline });
    expect(out.status).toBe("applied");
  });

  it("'2 servings of Kellogg's Special K Red Berries Breakfast Cereal' → the exact product, scaled to two servings, the generic cereal row never used (screenshot regression)", async () => {
    const entry = await logFood({ item: "Kellogg's Special K Red Berries Breakfast Cereal (2 servings)", calories: 240, protein: 6, carbs: 56, fat: 2 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, message: "I ate 2 servings of Kellogg's Special K Red Berries Breakfast Cereal", mode: "auto", deps: offline });
    expect(out.status).toBe("applied");
    const n = out.enrichment!;
    expect(n.confidence).toBe("exact");
    expect(n.components).toHaveLength(1);
    expect(n.components[0]).toMatchObject({ sourceItem: "Kellogg's Special K Red Berries", servings: 2, sourceType: "manufacturer" });
    expect(n.components[0].matchedServing!.label).toBe("1 cup (39 g)");
    expect((await storage.getTrackerEntry(entry.id))!.values).toMatchObject({ calories: 280, protein: 6, carbs: 68, fat: 1 });
  });

  it("a branded phrase the reference only knows generically goes to the product database first; the generic row is the last resort and a rough one is dropped", async () => {
    const entry = await logFood({ item: "Honey Bunches of Oats cereal (1 cup)", calories: 160 });
    const seen: string[] = [];
    const out = await enrichNutritionEntry(storage, {
      entryId: entry.id, message: "I ate a cup of Honey Bunches of Oats", mode: "auto",
      deps: {
        productLookup: async (phrase) => {
          seen.push(phrase);
          return { name: "Post Honey Bunches of Oats Honey Roasted", brand: "Post", serving: { amount: 1, unit: "cup", grams: 40, ml: null, label: "1 cup (40 g)" }, perServing: { calories: 160, protein: 3, carbs: 33, fat: 2, sugar: 9, sodium: 190 }, source: "Open Food Facts product 2", sourceType: "product_database", confidence: "exact", unitWords: ["cup", "cups"] };
        },
        modelEstimate: async () => { throw new Error("not needed"); },
        now: () => NOW,
      },
    });
    expect(seen).toHaveLength(1);
    expect(out.status).toBe("applied");
    expect(out.enrichment!.components[0].sourceType).toBe("product_database");
    expect((await storage.getTrackerEntry(entry.id))!.values.sodium).toBe(190);
    // Nothing answers → the generic cereal row is LOW → no proposal, the saved estimate stands.
    const other = await logFood({ item: "Honey Bunches of Oats cereal (1 cup)", calories: 160 });
    const none = await enrichNutritionEntry(storage, { entryId: other.id, mode: "auto", deps: { productLookup: async () => null, modelEstimate: async () => null, now: () => NOW } });
    expect(none.status).toBe("skipped");
    expect(none.reason).toMatch(/rough/);
    expect(((await storage.getTrackerEntry(other.id))!.computed as any).nutrition).toBeUndefined();
  });

  it("Automatic: a low-confidence model estimate is dropped, never shown as a competing proposal", async () => {
    const entry = await logFood({ item: "Trader Joe's Chicken Shawarma Bowl", calories: 400 });
    const out = await enrichNutritionEntry(storage, {
      entryId: entry.id, mode: "auto",
      deps: {
        productLookup: async () => null,
        modelEstimate: async () => [{ name: "Chicken shawarma bowl (generic)", nutrients: { calories: 520, protein: 30, carbs: 48, fat: 20 }, confidence: "low", basis: "no label known" }],
        now: () => NOW,
      },
    });
    expect(out.status).toBe("skipped");
    expect((await storage.getTrackerEntry(entry.id))!.values.calories).toBe(400);
    expect(((await storage.getTrackerEntry(entry.id))!.computed as any).nutrition).toBeUndefined();
  });

  it("Automatic: a medium model estimate fills missing nutrients but keeps the base calorie estimate (one guess does not replace another)", async () => {
    const entry = await logFood({ item: "Trader Joe's Chicken Shawarma Bowl", calories: 400 });
    const out = await enrichNutritionEntry(storage, {
      entryId: entry.id, mode: "auto",
      deps: {
        productLookup: async () => null,
        modelEstimate: async () => [{ name: "Chicken shawarma bowl", nutrients: { calories: 520, protein: 30, carbs: 48, fat: 20, sodium: 900 }, confidence: "high" }],
        now: () => NOW,
      },
    });
    expect(out.status).toBe("applied");
    expect(out.enrichment!.confidence).toBe("medium"); // a model estimate is capped at medium
    const after = (await storage.getTrackerEntry(entry.id))!;
    expect(after.values.calories).toBe(400);
    expect(after.values.sodium).toBe(900);
    expect((after.computed as any).enrichment.estimated.sodium.isEstimated).toBe(true);
  });
});

describe("the value guard reads nutrition as intake, not blood levels", () => {
  const fields = [...NUTRITION_FIELDS, { name: "sodium", type: "number" as const, unit: "mg" }, { name: "caffeine", type: "number" as const, unit: "mg" }];
  it("a Coke's 45 mg and a Big Mac's 1,050 mg of sodium both pass on a Nutrition tracker (live-run regression)", () => {
    expect(sanitizeTrackerEntryValues(fields, { item: "Coke", calories: 140, sodium: 45, caffeine: 34 }, { name: "Calories", category: "nutrition" }).error).toBeUndefined();
    expect(sanitizeTrackerEntryValues(fields, { item: "Big Mac", calories: 590, sodium: 1050 }, { name: "Nutrition", category: "custom" }).error).toBeUndefined();
  });
  it("a serum sodium reading on a lab tracker is still bounded", () => {
    expect(sanitizeTrackerEntryValues([{ name: "sodium", type: "number", unit: "mmol/L" }], { sodium: 45 }, { name: "Sodium", category: "health" }).error).toMatch(/sodium/i);
  });
});

describe("the in-turn pass (sync): tables only, exact/high only, never a proposal", () => {
  it("Special K is refined inside the turn from the label table with no network and no model", async () => {
    const entry = await logFood({ item: "Kellogg's Special K Red Berries Breakfast Cereal (2 servings)", calories: 220 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, message: "I ate 2 servings of Kellogg's Special K Red Berries Breakfast Cereal", sync: true, deps: { productLookup: async () => { throw new Error("no network in the turn"); }, modelEstimate: async () => { throw new Error("no model in the turn"); }, now: () => NOW } });
    expect(out.status).toBe("applied");
    expect(out.needsMore).toBeFalsy();
    expect(out.entry!.values.calories).toBe(280);
  });
  it("a branded phrase the tables cannot pin is left for the full pass — nothing written, candidate kept", async () => {
    const entry = await logFood({ item: "Honey Bunches of Oats cereal (1 cup)", calories: 160 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, sync: true, deps: { now: () => NOW } });
    expect(out.status).toBe("skipped");
    expect(out.needsMore).toBe(true);
    expect(((await storage.getTrackerEntry(entry.id))!.computed as any).nutrition).toBeUndefined();
    expect((await storage.getTrackerEntry(entry.id))!.values.calories).toBe(160);
  });
  it("a generic food resolves in the turn and needs nothing more", async () => {
    const entry = await logFood({ item: "2 eggs", calories: 140 });
    const out = await enrichNutritionEntry(storage, { entryId: entry.id, sync: true, deps: { now: () => NOW } });
    expect(out.status).toBe("applied");
    expect(out.needsMore).toBeFalsy();
  });
});

describe("learned aliases", () => {
  it("accepting a product-database match teaches the wording; the next mention resolves offline", async () => {
    const match = { name: "Post Honey Bunches of Oats Honey Roasted", brand: "Post", serving: { amount: 1, unit: "cup", grams: 40, ml: null, label: "1 cup (40 g)" }, perServing: { calories: 160, protein: 3, carbs: 33, fat: 2, sodium: 190 }, source: "Open Food Facts product 2", sourceType: "product_database" as const, confidence: "high" as const, unitWords: ["cup", "cups"] };
    await storage.setPreference(NUTRITION_ENRICHMENT_PREF_KEY, "ask");
    const first = await logFood({ item: "Honey Bunches of Oats cereal (1 cup)", calories: 160 });
    const proposed = await enrichNutritionEntry(storage, { entryId: first.id, deps: { productLookup: async () => match, modelEstimate: async () => null, now: () => NOW } });
    expect(proposed.status).toBe("proposed");
    const accepted = await enrichNutritionEntry(storage, { entryId: first.id, intent: "force", deps: { now: () => NOW } });
    expect(accepted.status).toBe("applied");
    const learned = await loadLearnedAliases(storage);
    expect(Object.keys(learned)).toContain(aliasKey("Honey Bunches of Oats cereal (1 cup)"));
    // Next time, the same wording never reaches the network.
    const second = await logFood({ item: "Honey Bunches of Oats cereal (2 cups)", calories: 320 });
    const out = await enrichNutritionEntry(storage, { entryId: second.id, mode: "auto", deps: { productLookup: async () => { throw new Error("must not be called"); }, modelEstimate: async () => { throw new Error("must not be called"); }, now: () => NOW } });
    expect(out.status).toBe("applied");
    expect(out.enrichment!.components[0]).toMatchObject({ sourceType: "product_database", servings: 2 });
    expect((await storage.getTrackerEntry(second.id))!.values.sodium).toBe(380);
  });
  it("aliasKey strips quantities and filler", () => {
    expect(aliasKey("2 cups of Cinnamon Toast Crunch")).toBe("cinnamon toast crunch");
    expect(aliasKey("Fairlife choc (8 oz)")).toBe("fairlife choc");
  });
  it("a package size from the product database parses into grams or ml", () => {
    expect(parsePackageQuantity("473 ml")).toEqual({ ml: 473, label: "473 ml" });
    expect(parsePackageQuantity("27.5 oz (780 g)")).toEqual({ grams: 780, label: "27.5 oz (780 g)" });
    expect(parsePackageQuantity("1 L")).toEqual({ ml: 1000, label: "1 L" });
    expect(parsePackageQuantity("")).toBeNull();
  });
});

describe("external product data mapping", () => {
  it("Open Food Facts nutriments → per-serving vector, preferring *_serving and converting g → mg", () => {
    const v = nutrientsFromOffNutriments({
      "energy-kcal_serving": 370, proteins_serving: 22, carbohydrates_serving: 48, fat_serving: 11,
      sodium_serving: 0.86, fiber_100g: 4, sugars_100g: 2,
    }, 300);
    expect(v).toMatchObject({ calories: 370, protein: 22, carbs: 48, fat: 11, sodium: 860, fiber: 12, sugar: 6 });
    expect(nutrientsFromOffNutriments({ salt_100g: 1 }, 100)).toBeNull();
  });

  it("a branded phrase reaches the product database; its match becomes a component with its serving", async () => {
    const entry = await logFood({ item: "Trader Joe's Chicken Burrito Bowl", calories: 400 });
    const seen: string[] = [];
    const out = await enrichNutritionEntry(storage, {
      entryId: entry.id, mode: "auto",
      deps: {
        productLookup: async (phrase) => {
          seen.push(phrase);
          return {
            name: "Trader Joe's Chicken Burrito Bowl", brand: "Trader Joe's",
            serving: { amount: 1, unit: "serving", grams: 340, ml: null, label: "1 bowl (340 g)" },
            perServing: { calories: 370, protein: 22, carbs: 48, fat: 11, sodium: 860 },
            source: "Open Food Facts product 1", sourceType: "product_database", confidence: "exact",
          };
        },
        modelEstimate: async () => { throw new Error("not needed"); },
        now: () => NOW,
      },
    });
    expect(seen).toEqual(["Trader Joe's Chicken Burrito Bowl"]);
    expect(out.status).toBe("applied");
    expect((await storage.getTrackerEntry(entry.id))!.values).toMatchObject({ calories: 370, protein: 22, carbs: 48, fat: 11, sodium: 860 });
  });

  it("componentPhrases pairs each food with the message's quantity for it", () => {
    const phrases = componentPhrases("Oatmeal + 2% milk", "I ate 1 packet of Quaker oatmeal with 1 cup of 2% milk");
    expect(phrases.map((p) => p.quantityText)).toEqual(["1 packet of Quaker oatmeal", "1 cup of 2% milk"]);
  });
});
