// The owner's nutrition test sheet (2026-11-24: "Chobani Zero Sugar Vanilla
// Greek Yogurt, 90 kcal, protein 12 g, carbs 7 g … it's good but it's not
// great"). 225 g of a 150 g yogurt had its calories scaled and its protein
// left at the per-cup figure.
//
// Every case here goes through the real in-turn pass (enrichNutritionEntry,
// sync: no network, no model) against the in-memory store, starting from an
// entry that carries a deliberately WRONG estimate — the kind the chat model
// saves — so a passing case proves the server, not the model, produced the
// figures. Expected values are the owner's.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import { enrichNutritionEntry, planEnrichmentCandidate, labelFor } from "../server/nutrition-enrichment";
import {
  NUTRIENT_KEYS, NUTRIENT_LABELS, NUTRIENT_UNITS, canonicalNutrientKey, detectUserStatedNutrition, netCarbsOf,
  normalizeQuantity, recapLine, roundNutrient, verificationOf, type NutritionEnrichment,
} from "../shared/nutrition-enrichment";
import { parseStatedLabel } from "../shared/nutrition-label";
import { lookupNutritionDb } from "../shared/nutrition-db";

const NOW = "2026-11-24T18:00:00.000Z";
const FIELDS = [
  { name: "calories", type: "number" as const, unit: "kcal", isPrimary: true },
  { name: "protein", type: "number" as const, unit: "g" },
  { name: "carbs", type: "number" as const, unit: "g" },
  { name: "fat", type: "number" as const, unit: "g" },
  { name: "item", type: "text" as const },
];
/** What the chat model saved: plausible-looking and wrong, so nothing below can pass on it. */
const WRONG = { calories: 1, protein: 1, carbs: 1, fat: 1 };

let storage: MemStorage;
let trackerId: string;

beforeEach(async () => {
  storage = new MemStorage();
  trackerId = (await storage.createTracker({ name: "Nutrition", category: "nutrition", fields: FIELDS })).id;
});

/** Log the model's entry, run the in-turn pass with the user's message, return what is stored. */
async function logged(item: string, message: string, base: Record<string, number> = WRONG) {
  const entry = await storage.logEntry({ trackerId, values: { item, ...base } });
  if (!entry) throw new Error("base entry did not save");
  const tracker = (await storage.getTracker(trackerId))!;
  if (!planEnrichmentCandidate(entry, tracker, message)) throw new Error(`no enrichment was planned for "${item}"`);
  const out = await enrichNutritionEntry(storage, { entryId: entry.id, trackerId, message, mode: "auto", sync: true, deps: { now: () => NOW } });
  const stored = (await storage.getTrackerEntry(entry.id))!;
  const enrichment = (stored as any).computed?.nutrition as NutritionEnrichment | undefined;
  const total = (k: string): number | undefined => (enrichment?.totals as any)?.[k]?.value;
  return { out, values: stored.values as Record<string, any>, enrichment, total };
}

describe("1. Specific branded foods use the product's own label, scaled by what was eaten", () => {
  it("one and a half Quest Chocolate Chip Cookie Dough bars → 285 kcal · 31.5 g protein · 33 g carbs · 13.5 g fat", async () => {
    const r = await logged("Quest Chocolate Chip Cookie Dough Protein Bar", "I ate one and a half Quest Chocolate Chip Cookie Dough protein bars.");
    expect(r.out.status).toBe("applied");
    expect(r.values).toMatchObject({ calories: 285, protein: 31.5, carbs: 33, fat: 13.5 });
    expect(r.total("fiber")).toBe(18);
    expect(r.total("sodium")).toBe(330);
  });

  it("half a Fairlife Core Power Elite 42g shake → 115 · 21 · 4.5 · 1.75; the product's '42g protein' is not a stated label", async () => {
    const msg = "I drank half a Fairlife Core Power Elite chocolate 42g protein shake.";
    expect(detectUserStatedNutrition(msg)).toEqual({});
    const r = await logged("Fairlife Core Power Elite Chocolate Protein Shake", msg);
    expect(r.out.status).toBe("applied");
    expect(r.values).toMatchObject({ calories: 115, protein: 21, carbs: 4.5, fat: 1.75 });
  });

  it("225 g of Chobani Zero Sugar Vanilla → 90 · 18 · 7.5 · 0 (the report: protein stayed 12)", async () => {
    const r = await logged("Chobani Zero Sugar Vanilla Greek Yogurt", "I ate 225 grams of Chobani Zero Sugar Vanilla Greek Yogurt.", { calories: 90, protein: 12, carbs: 7, fat: 0 });
    expect(r.out.status).toBe("applied");
    expect(r.values).toMatchObject({ calories: 90, protein: 18, carbs: 7.5, fat: 0 });
    expect(recapLine(r.enrichment!)).toBe("Chobani Zero Sugar Greek Yogurt (Vanilla) (225 g) — 90 kcal, 18 g protein, 7.5 g carbs, 0 g fat, 98 mg sodium");
    expect(verificationOf(r.enrichment!)).toBe("verified");
  });

  it("seven original Oreos → 373.3 · 2.33 · 58.33 · 16.33", async () => {
    const r = await logged("Oreo Cookies", "I ate seven original Oreo cookies.");
    expect(r.values).toMatchObject({ calories: 373.3, protein: 2.33, carbs: 58.33, fat: 16.33 });
    // "<1 g" fiber on the label is not a number: it stays unknown.
    expect(r.total("fiber")).toBeUndefined();
  });

  it("100 ml of the Fairlife Elite shake → 55.6 · 10.14 · 2.17 · 0.85", async () => {
    const r = await logged("Fairlife Core Power Elite Chocolate Protein Shake", "I drank 100 ml of Fairlife Core Power Elite chocolate 42g protein shake.");
    expect(r.values).toMatchObject({ calories: 55.6, protein: 10.14, carbs: 2.17, fat: 0.85 });
  });
});

describe("3. Generic foods: preparation and state decide the numbers", () => {
  const per100: Array<[string, string, number, number, number, number]> = [
    ["White rice, dry (100 g)", "I ate 100 grams of dry white rice", 365, 7.1, 80, 0.7],
    ["Chicken breast, raw (100 g)", "I ate 100 grams of raw chicken breast", 120, 22.5, 0, 2.6],
    ["Egg whites (100 g)", "I ate 100 grams of egg whites", 52, 10.9, 0.7, 0.2],
    ["Egg yolks (100 g)", "I ate 100 grams of egg yolks", 322, 15.9, 3.6, 26.5],
    ["Avocado (100 g)", "I ate 100 grams of avocado", 160, 2, 8.5, 14.7],
    ["Chia seeds (28 g)", "I ate 28 grams of chia seeds", 136, 4.6, 11.8, 8.6],
    ["Olive oil (1 tbsp)", "I had 1 tbsp of olive oil", 119, 0, 0, 13.5],
    ["Strawberries (100 g)", "I ate 100 grams of strawberries", 32, 0.7, 7.7, 0.3],
    ["Raisins (100 g)", "I ate 100 grams of raisins", 299, 3.1, 79.2, 0.5],
    ["Grapes (100 g)", "I ate 100 grams of grapes", 69, 0.7, 18.1, 0.2],
  ];
  for (const [item, msg, kcal, protein, carbs, fat] of per100) {
    it(`${msg} → ${kcal} kcal`, async () => {
      const r = await logged(item, msg);
      expect(r.out.status).toBe("applied");
      expect(Math.abs(r.values.calories - kcal)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(r.values.protein - protein)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(r.values.carbs - carbs)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(r.values.fat - fat)).toBeLessThanOrEqual(0.05);
    });
  }

  it("cooked rice and roasted chicken are the cooked references (130 and 165 per 100 g), never the raw ones", () => {
    expect(lookupNutritionDb("100 grams of cooked white rice")!.item.id).toBe("rice-white-cooked");
    expect(lookupNutritionDb("white rice")!.item.id).toBe("rice-white-cooked");
    expect(lookupNutritionDb("100 grams of dry white rice")!.item.id).toBe("rice-white-dry");
    expect(lookupNutritionDb("100 grams of roasted chicken breast")!.item.id).toBe("chicken-breast");
    expect(lookupNutritionDb("raw chicken breast")!.item.id).toBe("chicken-breast-raw");
    const cooked = lookupNutritionDb("white rice")!.item;
    expect(roundNutrient(cooked.perServing.calories! * 100 / cooked.serving.grams!, "calories")).toBe(130);
    const chicken = lookupNutritionDb("roasted chicken breast")!.item;
    expect(chicken.perServing).toMatchObject({ calories: 165, protein: 31, carbs: 0, fat: 3.6 });
  });

  it("'one and a half' is an amount, not coffee creamer and not two foods", () => {
    expect(normalizeQuantity("one and a half Quest bars").count).toBe(1.5);
    expect(lookupNutritionDb("one and a half Quest protein bars")!.item.id).toBe("quest-bar");
    expect(lookupNutritionDb("coffee with half and half")!.item.id).toBe("coffee-creamer");
  });
});

describe("4. A label the user reads out is scaled by what they ate; nothing else is added to it", () => {
  it("an entire bag, 3.5 servings per bag → 525 kcal, 31.5 g fat, 56 g carbs, 7 g protein", async () => {
    const r = await logged("Chips", "I ate an entire bag of chips. There are 3.5 servings per bag, and each serving contains 150 calories, 9g fat, 16g carbs and 2g protein.", { calories: 150, protein: 2, carbs: 16, fat: 9 });
    expect(r.out.status).toBe("applied");
    expect(r.values).toMatchObject({ calories: 525, fat: 31.5, carbs: 56, protein: 7 });
    expect(verificationOf(r.enrichment!)).toBe("verified");
  });

  it("75 g of a per-40 g cereal → 300 kcal, 5.63 g fat, 56.25 g carbs, 9.38 g protein, 15 g sugar; the generic cereal row adds nothing", async () => {
    // The model guessed fiber and sodium the label never stated.
    const r = await logged("Cereal", "I ate 75 grams of cereal. The label says 160 calories, 3g fat, 30g carbs, 5g protein and 8g sugar per 40 grams.", { calories: 160, protein: 5, carbs: 30, fat: 3, fiber: 4, sodium: 200 } as any);
    expect(r.values).toMatchObject({ calories: 300, fat: 5.63, carbs: 56.25, protein: 9.38, sugar: 15 });
    // Unknown stays unknown: not zero, and not the model's guess.
    expect("fiber" in r.values).toBe(false);
    expect("sodium" in r.values).toBe(false);
    expect(r.total("fiber")).toBeUndefined();
    expect(r.enrichment!.components).toHaveLength(1);
    expect(r.enrichment!.components[0].sourceType).toBe("user");
  });

  it("half a bar containing 200 kcal → 100, 10 protein, 12 carbs, 7 fiber, 3 sugar alcohol, 4 fat; calories are NOT recomputed from the macros", async () => {
    const r = await logged("Protein Bar", "I ate half a protein bar containing 200 calories, 20g protein, 24g total carbs, 14g fiber, 6g sugar alcohol and 8g fat.");
    expect(r.values).toMatchObject({ calories: 100, protein: 10, carbs: 12, fiber: 7, fat: 4 });
    expect(r.total("sugarAlcohol")).toBe(3);
    // "6g sugar alcohol" is not sugar.
    expect(r.total("sugar")).toBeUndefined();
    // 4/4/9 arithmetic says 124; the label says 100 and the label stands.
    expect(r.values.protein * 4 + r.values.carbs * 4 + r.values.fat * 9).toBe(124);
    expect(netCarbsOf({ carbs: r.values.carbs, fiber: r.values.fiber, sugarAlcohol: r.total("sugarAlcohol") })).toBe(2);
  });

  it("two servings of soup → 180 kcal, 960 mg sodium, 4 g fat, 24 g carbs, 12 g protein", async () => {
    const r = await logged("Soup", "I ate two servings of soup. Each serving contains 90 calories, 480mg sodium, 2g fat, 12g carbohydrates and 6g protein.");
    expect(r.values).toMatchObject({ calories: 180, sodium: 960, fat: 4, carbs: 24, protein: 12 });
  });

  it("one and a half of four portions of an 800 kcal recipe → 300 kcal, 22.5 protein, 37.5 carbs, 6.38 fat", async () => {
    const r = await logged("Homemade Chili", "I made four equal portions of a recipe containing 800 calories, 60g protein, 100g carbs and 17g fat. I ate one and a half portions.");
    expect(r.values).toMatchObject({ calories: 300, protein: 22.5, carbs: 37.5, fat: 6.38 });
    expect(parseStatedLabel("I made four equal portions of a recipe containing 800 calories, 60g protein, 100g carbs and 17g fat. I ate one and a half portions.")!.factor).toBe(0.375);
  });

  it("numbers stated as a TOTAL are left exactly as stated", () => {
    expect(parseStatedLabel("2 eggs, about 140 calories")).toMatchObject({ factor: 1, scaled: false, consumed: { calories: 140 } });
    expect(parseStatedLabel("I had a protein bar, it says 210 calories and 20g protein")).toMatchObject({ factor: 1, consumed: { calories: 210, protein: 20 } });
    expect(parseStatedLabel("two Quest bars, 190 calories and 21g protein each")).toMatchObject({ factor: 2, consumed: { calories: 380, protein: 42 } });
    expect(parseStatedLabel("I ate a banana")).toBeNull();
  });

  it("a label belongs to the food it follows, not to every food in the message", () => {
    const msg = "I had a banana and a protein bar that has 200 calories, 20g protein and 8g fat";
    expect(labelFor("Banana", msg)).toBeNull();
    expect(labelFor("Protein Bar", msg)).not.toBeNull();
  });
});

describe("5. Conversational wording", () => {
  it("three eggs but only two of the yolks → 3 whites + 2 yolks, not 3 whole eggs", async () => {
    const r = await logged("3 Eggs (only 2 yolks)", "I ate three eggs but only two of the yolks.");
    expect(r.out.status).toBe("applied");
    expect(r.enrichment!.components.map((c) => `${c.servings} × ${c.name}`)).toEqual(["3 × Egg whites", "2 × Egg yolk"]);
    expect(r.values.calories).toBe(161);
    expect(r.values.calories).toBeLessThan(216); // three whole eggs
  });

  it("200 g of chicken weighed before cooking is RAW weight → 240 kcal, not the cooked 330", async () => {
    const r = await logged("Chicken (200 g)", "I ate 200 grams of chicken weighed before cooking.");
    expect(r.enrichment!.components[0].name).toBe("Chicken breast, raw");
    expect(r.values).toMatchObject({ calories: 240, protein: 45, fat: 5.2 });
  });

  it("'made two sandwiches but only ate three quarters of one' is 0.75, not 2", () => {
    expect(normalizeQuantity("made two sandwiches but only ate three quarters of one").count).toBe(0.75);
  });

  it("'one with 30 ml of whole milk' is 30 ml of milk, not one cup", async () => {
    expect(normalizeQuantity("one with 30 ml of whole milk")).toMatchObject({ ml: 30, unit: "ml" });
    expect(normalizeQuantity("two 12 oz cokes").ml).toBeCloseTo(709.8, 1);
  });

  it("a 250-gram banana including the peel is about 160 g of banana (an estimate, and labelled as one)", async () => {
    const r = await enrichDirect("Banana (250 g with peel)", "I ate a 250-gram banana including the peel.");
    expect(r.enrichment!.components[0].source).toContain("250 g with peel ≈ 160 g edible");
    expect(r.total("calories")).toBeCloseTo(142.4, 1);
    expect(verificationOf(r.enrichment!)).toBe("estimated");
    // Without the peel remark the stated weight is all food.
    const plain = await enrichDirect("Banana (250 g)", "I ate a 250 gram banana.");
    expect(plain.total("calories")).toBeCloseTo(222.5, 1);
  });

  it("100 g of chicken with 15 g of olive oil counts the oil on its own", async () => {
    const r = await enrichDirect("Chicken (100 g) with Olive Oil (15 g)", "I ate 100 grams of chicken with 15 grams of olive oil.");
    expect(r.enrichment!.components.map((c) => c.name)).toEqual(["Chicken breast, cooked", "Olive oil"]);
    expect(r.total("calories")).toBeCloseTo(297.2, 1);
    expect(r.total("fat")).toBeCloseTo(18.6, 1);
  });

  /** The full (after-reply) pass with no network: where a medium-confidence reference is applied. */
  async function enrichDirect(item: string, message: string) {
    const entry = await storage.logEntry({ trackerId, values: { item, ...WRONG } });
    const out = await enrichNutritionEntry(storage, { entryId: entry!.id, trackerId, message, mode: "auto", deps: { now: () => NOW, aliases: {}, productLookup: async () => null, modelEstimate: async () => null } });
    const stored = (await storage.getTrackerEntry(entry!.id))!;
    const enrichment = (stored as any).computed?.nutrition as NutritionEnrichment | undefined;
    return { out, values: stored.values as Record<string, any>, enrichment, total: (k: string): number | undefined => (enrichment?.totals as any)?.[k]?.value };
  }
});

describe("6. The nutrition fields Portol holds", () => {
  it("every nutrient on the owner's checklist has a key, a label and a unit", () => {
    const checklist = [
      "calories", "protein", "carbs", "fat", "saturatedFat", "transFat", "monoFat", "polyFat", "fiber", "sugar", "addedSugar",
      "sugarAlcohol", "cholesterol", "sodium", "caffeine", "vitaminA", "vitaminB6", "vitaminB12", "vitaminC", "vitaminD",
      "vitaminE", "vitaminK", "calcium", "iron", "potassium", "magnesium", "zinc", "folate", "phosphorus", "selenium",
    ];
    for (const k of checklist) {
      expect(NUTRIENT_KEYS as readonly string[]).toContain(k);
      expect((NUTRIENT_LABELS as any)[k]).toBeTruthy();
      expect((NUTRIENT_UNITS as any)[k]).toBeTruthy();
    }
    expect(canonicalNutrientKey("Total Carbohydrates")).toBe("carbs");
    expect(canonicalNutrientKey("sugar alcohols")).toBe("sugarAlcohol");
    expect(canonicalNutrientKey("Vitamin B12")).toBe("vitaminB12");
  });

  it("net carbs are derived, and only from what is known", () => {
    expect(netCarbsOf({ carbs: 24, fiber: 14, sugarAlcohol: 6 })).toBe(4);
    expect(netCarbsOf({ carbs: 24 })).toBeNull();     // unknown fiber is not zero fiber
    expect(netCarbsOf({ fiber: 3 })).toBeNull();
  });

  it("scaled figures keep the arithmetic: one decimal of a calorie, two of a gram", () => {
    expect(roundNutrient(373.3333, "calories")).toBe(373.3);
    expect(roundNutrient(1.75, "fat")).toBe(1.75);
    expect(roundNutrient(3 * 1.875, "fat")).toBe(5.63);
    expect(roundNutrient(62.8, "sodium")).toBe(63);
  });
});

// ── Found with the real model on the preview (2026-11-25) ────────────────────
import { splitSeparateFoods } from "../shared/food-split";
import { restaurantBuildPhrases, lookupComponents } from "../server/nutrition-enrichment";
import { sumComponentTotals } from "../shared/nutrition-enrichment";

describe("7. Regressions the live run exposed", () => {
  it("'White rice, dry (100 g)' is ONE food: a preparation word after a comma never becomes a second entry (logged 730 kcal)", () => {
    expect(splitSeparateFoods("White rice, dry (100 g)")).toEqual(["White rice, dry (100 g)"]);
    expect(splitSeparateFoods("Chicken breast, raw (200 g)")).toEqual(["Chicken breast, raw (200 g)"]);
    expect(splitSeparateFoods("Black beans, canned, drained (1 cup)")).toEqual(["Black beans, canned, drained (1 cup)"]);
    // Real second foods still separate.
    expect(splitSeparateFoods("Chicken breast, raw (200 g), a banana")).toEqual(["Chicken breast, raw (200 g)", "a banana"]);
  });

  it("a label whose serving is a count or a household measure is scaled by what was eaten in that unit", () => {
    const dumplings = parseStatedLabel("I ate 5 dumplings. The label says one serving is 4 dumplings with 220 calories, 9g fat, 26g carbs and 9g protein.")!;
    expect(dumplings.consumed).toMatchObject({ calories: 275, fat: 11.25, carbs: 32.5, protein: 11.25 });
    const cereal = parseStatedLabel("I ate 1 cup of cereal. The label says a serving is 2/3 cup with 200 calories, 3g fat, 41g carbs and 6g protein.")!;
    expect(cereal.consumed).toMatchObject({ calories: 300, fat: 4.5, carbs: 61.5, protein: 9 });
    const yogurt = parseStatedLabel("I ate 90 g of yogurt. The tub says 150 g has 120 calories, 15g protein, 8g carbs and 3g fat.")!;
    expect(yogurt.consumed).toMatchObject({ calories: 72, protein: 9, carbs: 4.8, fat: 1.8 });
  });

  it("shares of a package, of a serving and of a recipe keep the precision of the division", () => {
    expect(parseStatedLabel("I ate a quarter of a bag of trail mix. There are 8 servings per bag and each serving contains 170 calories, 11g fat, 14g carbs and 5g protein.")!.consumed).toMatchObject({ calories: 340, fat: 22, carbs: 28, protein: 10 });
    expect(parseStatedLabel("I ate half a serving of ice cream. A serving has 270 calories, 17g fat, 26g carbs, 4g protein and 22g sugar.")!.consumed).toMatchObject({ calories: 135, fat: 8.5, sugar: 11 });
    // 2 of 6 servings of 2400 kcal is 800, not 799.9.
    expect(parseStatedLabel("I made six equal servings of chili containing 2400 calories, 150g protein, 210g carbs and 96g fat in total. I ate two servings.")!.consumed).toMatchObject({ calories: 800, protein: 50, carbs: 70, fat: 32 });
  });

  it("a build-your-own restaurant order is its ingredients: 'no X' leaves X out, 'double' is two, a burrito has its tortilla", async () => {
    const total = async (item: string, msg: string) => {
      const r = await lookupComponents(item, msg, { syncOnly: true, aliases: {} } as any, NOW);
      const t: any = sumComponentTotals(r.components, NOW);
      return { calories: t.calories?.value, protein: t.protein?.value, carbs: t.carbs?.value, fat: t.fat?.value, parts: r.components.length, unresolved: r.unresolved };
    };
    expect(await total("Chipotle Chicken Burrito Bowl", "I had a Chipotle burrito bowl with chicken, white rice, black beans and fresh tomato salsa, no cheese and no sour cream."))
      .toMatchObject({ calories: 545, protein: 44, carbs: 66, fat: 12.5, parts: 4, unresolved: [] });
    expect(await total("Chipotle Bowl", "I had a Chipotle bowl with chicken, double white rice, fajita veggies and guacamole."))
      .toMatchObject({ calories: 850, protein: 43, carbs: 93, fat: 37, parts: 4 });
    expect(await total("Chipotle Chicken Burrito", "I had a Chipotle chicken burrito with white rice, black beans, cheese and lettuce, but no salsa."))
      .toMatchObject({ calories: 955, protein: 58, carbs: 114, fat: 29.5, parts: 6 });
    // An ingredient the restaurant's table does not have: no partial build, the order is looked up as one item.
    expect(restaurantBuildPhrases("Chipotle Bowl", "I had a Chipotle bowl with chicken and mystery sauce")).toBeNull();
    // A restaurant with no ingredient table is never "built".
    expect(restaurantBuildPhrases("Subway Turkey Sub", "a Subway turkey sub with lettuce, tomato and mayo")).toBeNull();
  });

  it("an estimate gives what ONE serving holds; the server scales it by the stated weight and the result replaces the base figure", async () => {
    // The chat model saved the per-cup figure for 150 g (seen live: 222 kcal).
    const entry = await storage.logEntry({ trackerId, values: { item: "Purple Yam, boiled (150 g)", calories: 222, protein: 8, carbs: 39, fat: 3.5 } });
    const out = await enrichNutritionEntry(storage, {
      entryId: entry!.id, trackerId, message: "I ate 150 grams of boiled purple yam.", mode: "auto",
      deps: { now: () => NOW, aliases: {}, sourceLookup: async (asks) => asks.map(() => null),
        // The estimator's serving is 100 g; it also returns a WRONG "servings" the server must not use.
        modelEstimate: async () => [{ name: "Purple yam, boiled", servings: 1, serving: { amount: 100, unit: "g", grams: 100, label: "100 g" }, nutrients: { calories: 120, protein: 1.5, carbs: 28, fat: 0.1 }, confidence: "medium" }] },
    });
    expect(out.status).toBe("applied");
    const stored = (await storage.getTrackerEntry(entry!.id))! as any;
    expect(stored.values).toMatchObject({ calories: 180, protein: 2.25, carbs: 42, fat: 0.15 });
    expect(stored.computed.nutrition.verification).toBe("estimated");
    expect(stored.computed.nutrition.components[0].sourceType).toBe("model_estimate");
  });

  it("an estimate with no stated weight still never replaces the figures already on the entry", async () => {
    const entry = await storage.logEntry({ trackerId, values: { item: "Purple Yam Stew", calories: 300, protein: 5, carbs: 50, fat: 9 } });
    await enrichNutritionEntry(storage, {
      entryId: entry!.id, trackerId, message: "I had a bowl of purple yam stew", mode: "auto",
      deps: { now: () => NOW, aliases: {}, sourceLookup: async (asks) => asks.map(() => null),
        modelEstimate: async () => [{ name: "Purple yam stew", servings: 1, serving: { amount: 1, unit: "bowl", grams: 350, label: "1 bowl" }, nutrients: { calories: 410, protein: 9, carbs: 61, fat: 14 }, confidence: "medium" }] },
    });
    expect(((await storage.getTrackerEntry(entry!.id))! as any).values).toMatchObject({ calories: 300, protein: 5, carbs: 50, fat: 9 });
  });

  it("the databases are asked before the model, for generic and branded foods alike, and a database answer is recorded with its record", async () => {
    const asked: string[] = [];
    const entry = await storage.logEntry({ trackerId, values: { item: "Teff, cooked (200 g)", ...WRONG } });
    const out = await enrichNutritionEntry(storage, {
      entryId: entry!.id, trackerId, message: "I ate 200 grams of cooked teff.", mode: "auto",
      deps: { now: () => NOW, aliases: {},
        sourceLookup: async (asks) => { asked.push(...asks.map((a) => `${a.phrase}|${a.branded}`)); return asks.map(() => ({
          name: "Teff, cooked", userQuantity: "200 grams of cooked teff", normalizedQuantity: normalizeQuantity("200 grams"), servings: 2,
          matchedServing: { amount: 100, unit: "g", grams: 100, ml: null, label: "100 g" }, sourceType: "reference" as const,
          source: "USDA FoodData Central SR Legacy #168918 · 200 g", sourceItem: "Teff, cooked", confidence: "high" as const,
          perServing: { calories: 101, protein: 3.87, carbs: 19.86, fat: 0.65 },
          nutrients: Object.fromEntries(Object.entries({ calories: 202, protein: 7.74, carbs: 39.72, fat: 1.3 }).map(([k, v]) => [k, { value: v, unit: "g", source: "USDA", sourceType: "reference", confidence: "high", calculatedOrDirect: "calculated", enrichedAt: NOW }])) as any,
          sourceRef: { provider: "fdc" as const, id: "168918", dataType: "SR Legacy" },
        })); },
        modelEstimate: async () => { throw new Error("the model must not be asked when a database answered"); } },
    });
    expect(out.status).toBe("applied");
    expect(asked).toEqual(["Teff, cooked (200 g)|false"]);
    const stored = (await storage.getTrackerEntry(entry!.id))! as any;
    expect(stored.values).toMatchObject({ calories: 202, protein: 7.74, carbs: 39.72, fat: 1.3 });
    expect(stored.computed.nutrition.components[0].sourceRef).toEqual({ provider: "fdc", id: "168918", dataType: "SR Legacy" });
    expect(stored.computed.nutrition.verification).toBe("reference");
  });
});

describe("8. A label applies when the sentence talks about the package first", () => {
  it("'The bag has 2.5 servings and one serving is …' is still this food's label", () => {
    const popcorn = "I ate the whole bag of popcorn. The bag has 2.5 servings and one serving is 140 calories, 8g fat, 16g carbs and 2g protein.";
    expect(labelFor("Popcorn (whole bag, 2.5 servings)", popcorn)?.consumed).toMatchObject({ calories: 350, fat: 20, carbs: 40, protein: 5 });
    const yogurt = "I ate 90 g of yogurt. The tub says 150 g has 120 calories, 15g protein, 8g carbs and 3g fat.";
    expect(labelFor("Yogurt (90g)", yogurt)?.consumed).toMatchObject({ calories: 72, protein: 9 });
    // Two foods, a label for the second: still not the first one's.
    expect(labelFor("Banana", "I had a banana and a protein bar that has 200 calories, 20g protein and 8g fat")).toBeNull();
  });
});

describe("9. Found by the full real-model run (2026-11-25)", () => {
  it("the item is never cut into more foods than the user named", async () => {
    const { splitCombinedFoodLog } = await import("../server/meal-split");
    const one = (item: string, msg: string) => splitCombinedFoodLog({ trackerName: "Nutrition", values: { item, calories: 250 } }, msg);
    expect(await one("Salmon, Atlantic, farmed, sashimi (120 g)", "I ate 120 g of raw farmed Atlantic salmon as sashimi.")).toBeNull();
    expect(await one("Barilla Spaghetti No. 5, Italian, enriched (100 g)", "I ate 100 g of Barilla Spaghetti No. 5, weighed dry, barcode 8076800195057.")).toBeNull();
    // Two foods said, one combined item: still split.
    expect((await one("Banana + Doughnut", "Ate a banana and a doughnut"))!.map((p) => p.values.item)).toEqual(["Banana", "Doughnut"]);
  });

  it("dry oats never take the cooked-oatmeal row", async () => {
    const r = await lookupComponents("Rolled Oats, dry (40 g)", "I ate 40 grams of dry rolled oats.", { syncOnly: true, aliases: {} } as any, NOW);
    expect(r.components).toHaveLength(0);
    expect(r.unresolved).toHaveLength(1);
    // Said without a state, oatmeal is still the cooked reference.
    const cooked = await lookupComponents("Oatmeal (1 cup)", "I ate a cup of oatmeal", { syncOnly: true, aliases: {} } as any, NOW);
    expect(cooked.components[0].name).toMatch(/oatmeal/i);
  });

  it("a barcode typed in the message reaches the lookup even when the entry's name has no digits", async () => {
    const asked: any[] = [];
    await lookupComponents("Weetabix (37.5 g)", "I ate 37.5 g of Weetabix, barcode 5010029000023.", { aliases: {}, now: () => NOW, sourceLookup: async (asks) => { asked.push(...asks); return asks.map(() => null); } }, NOW);
    expect(asked).toHaveLength(1);
    expect(asked[0].quantityText).toContain("5010029000023");
    expect(asked[0].branded).toBe(true);
  });
});
