// Pins the pure half of the Item Enrichment Layer (shared/nutrition-enrichment,
// shared/nutrition-db) on the examples the feature was specified with:
// specificity detection ("oatmeal" vs "Quaker oatmeal" vs the exact packet),
// quantity normalization that keeps the user's wording, user-stated label
// values that nothing may overwrite, component totals, portion rescaling, and
// the linked measurements one drink implies. No I/O.
import { describe, it, expect } from "vitest";
import {
  detectSpecificity,
  normalizeQuantity,
  detectUserStatedNutrition,
  splitComponentPhrases,
  componentNutrients,
  sumComponentTotals,
  applyUserProvided,
  buildEntryValuePatch,
  rescaleEnrichment,
  rescalePlainValues,
  linkedMeasurementsFor,
  decideEnrichment,
  appliesAutomatically,
  parseEnrichmentMode,
  isNutritionTrackerLike,
  summarizeEnrichment,
  overallConfidence,
  canonicalNutrientKey,
  type NutritionComponent,
  type NutritionEnrichment,
} from "../shared/nutrition-enrichment";
import { lookupNutritionDb, resolveServings, nutritionCandidates, NUTRITION_DB } from "../shared/nutrition-db";
import { detectPackageFraction, recapLine, describeSources } from "../shared/nutrition-enrichment";

const NOW = "2026-10-16T12:00:00.000Z";

function dbComponent(phrase: string, quantityText = phrase): NutritionComponent {
  const m = lookupNutritionDb(phrase);
  if (!m) throw new Error(`no db match for ${phrase}`);
  const qty = normalizeQuantity(quantityText);
  const r = resolveServings(m.item, qty, quantityText);
  return {
    name: m.item.name, brand: m.item.brand, userQuantity: quantityText, normalizedQuantity: qty, servings: r.servings,
    matchedServing: { amount: m.item.serving.amount, unit: m.item.serving.unit, grams: m.item.serving.grams ?? null, ml: m.item.serving.ml ?? null, label: m.item.serving.label },
    sourceType: m.item.sourceType, source: m.item.source, sourceItem: m.item.name,
    confidence: r.confidence === "low" ? "low" : m.item.confidence === "exact" && r.confidence !== "high" && r.confidence !== "exact" ? r.confidence : m.item.confidence,
    perServing: m.item.perServing,
    nutrients: componentNutrients(m.item.perServing, r.servings, { source: m.item.source, sourceType: m.item.sourceType, sourceItem: m.item.name, confidence: m.item.confidence, enrichedAt: NOW }),
    isBeverage: !!m.item.isBeverage,
  };
}

describe("specificity detection", () => {
  it("'oatmeal' is generic, 'Quaker oatmeal' is brand-level, the exact packet is product-level", () => {
    expect(detectSpecificity("oatmeal").level).toBe("generic");
    expect(detectSpecificity("Quaker oatmeal").level).toBe("brand");
    const exact = detectSpecificity("Quaker Instant Oatmeal Maple & Brown Sugar, 1 packet");
    expect(exact.level).toBe("product");
    expect(exact.signals).toEqual(expect.arrayContaining(["brand", "package"]));
  });
  it("finds the identifying details the spec lists", () => {
    const s = detectSpecificity("I ate 1 packet of Quaker Instant Oatmeal Honey & Almonds with 1 cup of 2% milk");
    expect(s.level).toBe("product");
    expect(s.signals).toEqual(expect.arrayContaining(["brand", "package", "volume", "percentage"]));
    expect(detectSpecificity("Chipotle chicken burrito bowl with white rice, black beans, cheese and sour cream").level).toBe("product");
    expect(detectSpecificity("2 tablespoons Jif creamy peanut butter").level).toBe("product");
    expect(detectSpecificity("I ran 3.2 miles").signals).not.toContain("brand");
  });
  it("vague wording is vague — nothing to look up", () => {
    expect(detectSpecificity("some fruit").level).toBe("vague");
    expect(detectSpecificity("I ate dinner").level).toBe("vague");
    expect(decideEnrichment("auto", detectSpecificity("some fruit"), "some fruit").attempt).toBe(false);
    expect(decideEnrichment("off", detectSpecificity("Big Mac"), "Big Mac").attempt).toBe(false);
    expect(decideEnrichment("auto", detectSpecificity("2 eggs"), "2 eggs").attempt).toBe(true);
  });
});

describe("quantity normalization keeps the user's wording", () => {
  it("'half a bottle' → 10 fl oz at medium confidence, original preserved", () => {
    const q = normalizeQuantity("half a bottle");
    expect(q.original).toBe("half a bottle");
    expect(q.ml).toBeCloseTo(10 * 29.5735, 0);
    expect(q.confidence).toBe("medium");
    expect(q.assumption).toMatch(/20 fl oz bottle/);
  });
  it("explicit units are high confidence", () => {
    expect(normalizeQuantity("12 oz")).toMatchObject({ amount: 12, unit: "oz", confidence: "high" });
    expect(normalizeQuantity("12 oz").ml).toBeCloseTo(354.9, 0);
    expect(normalizeQuantity("182 g")).toMatchObject({ grams: 182, confidence: "high" });
    expect(normalizeQuantity("about a cup").ml).toBeCloseTo(236.6, 0);
    expect(normalizeQuantity("2 slices")).toMatchObject({ count: 2, unit: "slices", confidence: "high" });
    expect(normalizeQuantity("1 packet")).toMatchObject({ count: 1, unit: "packet" });
    expect(normalizeQuantity("one scoop")).toMatchObject({ count: 1, grams: 30, confidence: "medium" });
    expect(normalizeQuantity("one can").ml).toBeCloseTo(354.9, 0);
  });
  it("portion words and sizes are assumptions, not facts", () => {
    expect(normalizeQuantity("a bowl").confidence).toBe("medium");
    expect(normalizeQuantity("one handful")).toMatchObject({ grams: 28, confidence: "medium" });
    expect(normalizeQuantity("3 bites")).toMatchObject({ count: 3, confidence: "low" });
    expect(normalizeQuantity("large banana")).toMatchObject({ count: 1, confidence: "medium" });
    expect(normalizeQuantity("a big apple").assumption).toMatch(/big/);
    expect(normalizeQuantity("").amount).toBeNull();
    // A number before the FOOD word is a count of the food (live-run regression: "2 wheat toast" counted as one).
    expect(normalizeQuantity("2 wheat toast")).toMatchObject({ count: 2, unit: null, confidence: "high" });
    expect(normalizeQuantity("3 eggs")).toMatchObject({ count: 3, unit: "eggs" });
    // An article before a brand is no quantity at all ("a Quest protein bar" dropped to medium).
    expect(normalizeQuantity("a Quest protein bar")).toMatchObject({ amount: null, count: null });
    expect(normalizeQuantity("a Coke").count).toBeNull();
  });
});

describe("user-stated nutrition is the user's data", () => {
  it("reads label values the user read aloud", () => {
    const v = detectUserStatedNutrition("I ate this protein bar. It says 210 calories and 20g protein.");
    expect(v).toEqual({ calories: 210, protein: 20 });
  });
  it("a serving size or a count is not a nutrient", () => {
    expect(detectUserStatedNutrition("I drank a 12 oz Coke")).toEqual({});
    expect(detectUserStatedNutrition("I had 3 eggs and 2 slices of toast")).toEqual({});
  });
  it("covers the long tail of nutrient words", () => {
    expect(detectUserStatedNutrition("160 mg caffeine, 860 mg sodium, 5 g fiber")).toEqual({ caffeine: 160, sodium: 860, fiber: 5 });
    expect(detectUserStatedNutrition("protein: 30, carbs 4g")).toEqual({ protein: 30, carbs: 4 });
    expect(canonicalNutrientKey("Carbohydrates")).toBe("carbs");
    expect(canonicalNutrientKey("saturated_fat")).toBe("saturatedFat");
    expect(canonicalNutrientKey("item")).toBeNull();
  });
  it("applyUserProvided replaces the total and records the key; buildEntryValuePatch writes the user's number", () => {
    const bar = dbComponent("Quest bar");
    const summed = sumComponentTotals([bar], NOW);
    const { totals, userProvided } = applyUserProvided(summed, { calories: 210, protein: 20 }, NOW);
    expect(userProvided).toEqual(["calories", "protein"]);
    expect(totals.calories).toMatchObject({ value: 210, sourceType: "user", confidence: "exact" });
    const patch = buildEntryValuePatch({ item: "protein bar", calories: 210, protein: 20 }, { totals, userProvided, userValues: { calories: 210, protein: 20 } });
    expect(patch.calories).toBe(210);
    expect(patch.protein).toBe(20);
    expect(patch.carbs).toBe(21); // the lookup fills what the user did not state
  });
});

describe("internal reference lookup", () => {
  it("every row has a positive serving and at least calories", () => {
    for (const row of NUTRITION_DB) {
      expect(row.serving.amount, row.id).toBeGreaterThan(0);
      expect(typeof row.perServing.calories, row.id).toBe("number");
      expect(row.match.length, row.id).toBeGreaterThan(0);
    }
    const ids = NUTRITION_DB.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("the most specific row wins: the exact Quaker packet over generic oatmeal; Coke over Diet Coke only when 'diet' is absent", () => {
    expect(lookupNutritionDb("Quaker Instant Oatmeal Maple & Brown Sugar")?.item.id).toBe("quaker-maple-brown-sugar");
    expect(lookupNutritionDb("oatmeal")?.item.id).toBe("oatmeal-cooked");
    expect(lookupNutritionDb("a 12 oz Coke")?.item.id).toBe("coca-cola-12oz");
    expect(lookupNutritionDb("Diet Coke")?.item.id).toBe("diet-coke-12oz");
    expect(lookupNutritionDb("Honey Nut Cheerios")?.item.id).toBe("honey-nut-cheerios");
    expect(lookupNutritionDb("Cheerios")?.item.id).toBe("cheerios-original");
    expect(lookupNutritionDb("2% milk")?.item.id).toBe("milk-2pct");
    expect(lookupNutritionDb("Fairlife 2% milk")?.item.id).toBe("fairlife-2pct");
    expect(lookupNutritionDb("Big Mac")?.item.id).toBe("mcd-big-mac");
    expect(lookupNutritionDb("medium fries")?.item.id).toBe("mcd-fries-medium");
    expect(lookupNutritionDb("Celsius Peach Vibe")?.item.id).toBe("celsius-12oz");
    expect(lookupNutritionDb("16 oz Monster")?.item.id).toBe("monster-16oz");
    expect(lookupNutritionDb("Jif creamy peanut butter")?.item.id).toBe("jif-creamy-pb");
    expect(lookupNutritionDb("two Nature Made fish oil capsules")?.item.id).toBe("nature-made-fish-oil-1200");
    // The branded row beats the generic "cereal" row it also contains.
    expect(lookupNutritionDb("Kellogg's Special K Red Berries Breakfast Cereal (2 servings)")?.item.id).toBe("special-k-red-berries");
  });
  it("unknown or uncertain products fall through (no false precision)", () => {
    expect(lookupNutritionDb("Quaker Instant Oatmeal Honey & Almonds")?.item.id).not.toBe("quaker-original");
    expect(lookupNutritionDb("Trader Joe's Chicken Shawarma Bowl")).toBeNull();
    expect(lookupNutritionDb("Bench Press")).toBeNull();
    expect(lookupNutritionDb("eggplant parm")).toBeNull();
  });
  it("servings follow the user's quantity against the matched serving", () => {
    const jif = lookupNutritionDb("Jif creamy peanut butter")!.item;
    expect(resolveServings(jif, normalizeQuantity("2 tablespoons"), "2 tablespoons Jif").servings).toBeCloseTo(1);
    expect(resolveServings(jif, normalizeQuantity("1 tbsp")).servings).toBeCloseTo(0.5);
    const coke = lookupNutritionDb("Coke")!.item;
    expect(resolveServings(coke, normalizeQuantity("12 oz")).servings).toBeCloseTo(1, 1);
    expect(resolveServings(coke, normalizeQuantity("20 oz")).servings).toBeCloseTo(1.667, 2);
    expect(resolveServings(coke, normalizeQuantity("half a bottle")).servings).toBeCloseTo(0.833, 2);
    const egg = lookupNutritionDb("eggs")!.item;
    expect(resolveServings(egg, normalizeQuantity("3 eggs")).servings).toBe(3);
    const hnc = lookupNutritionDb("Honey Nut Cheerios")!.item;
    expect(resolveServings(hnc, normalizeQuantity("1.5 cups")).servings).toBeCloseTo(1.5);
    const banana = lookupNutritionDb("banana")!.item;
    const large = resolveServings(banana, normalizeQuantity("large banana"), "large banana");
    expect(large.servings).toBeCloseTo(1.25);
    expect(large.confidence).toBe("medium");
    const oreo = lookupNutritionDb("oreos")!.item;
    expect(resolveServings(oreo, normalizeQuantity("2 cookies")).servings).toBeCloseTo(2 / 3);
    const toast = lookupNutritionDb("wheat toast")!.item;
    expect(resolveServings(toast, normalizeQuantity("2 wheat toast"), "2 wheat toast")).toMatchObject({ servings: 2, confidence: "exact" });
    const quest = lookupNutritionDb("Quest bar")!.item;
    expect(resolveServings(quest, normalizeQuantity("a Quest protein bar")).servings).toBe(1);
    expect(resolveServings(quest, normalizeQuantity("a Quest protein bar")).confidence).toBe("exact");
    // No quantity at all → one serving, the row's own confidence.
    expect(resolveServings(coke, normalizeQuantity("")).confidence).toBe("exact");
    // "2 servings" is two of the row's own serving (the Special K screenshot showed one).
    const specialK = lookupNutritionDb("Special K Red Berries")!.item;
    const two = resolveServings(specialK, normalizeQuantity("2 servings"), "2 servings");
    expect(two).toMatchObject({ servings: 2, confidence: "exact" });
    const comp = dbComponent("Kellogg's Special K Red Berries Breakfast Cereal", "2 servings");
    expect(comp.nutrients.calories.value).toBe(280);
    expect(comp.nutrients.carbs.value).toBe(68);
    expect(comp.nutrients.fat.value).toBe(1);
  });
});

describe("aliases, ambiguity and package fractions", () => {
  it("shorthand resolves to the canonical product", () => {
    expect(lookupNutritionDb("a bowl of hnc")?.item.id).toBe("honey-nut-cheerios");
    expect(lookupNutritionDb("special k berries")?.item.id).toBe("special-k-red-berries");
    expect(lookupNutritionDb("quest cookies bar")?.item.id).toBe("quest-bar");
    expect(lookupNutritionDb("zero ultra")?.item.id).toBe("monster-zero-ultra-16oz");
  });
  it("candidates are ranked and a bare line name does not pretend to be one product", () => {
    expect(nutritionCandidates("Monster")[0].item.id).toBe("monster-16oz");
    expect(nutritionCandidates("Monster").map((c) => c.item.id)).not.toContain("monster-zero-ultra-16oz");
    expect(lookupNutritionDb("Special K")).toBeNull();
  });
  it("'half the bottle' / 'the whole can' are fractions of the PACKAGE when the product knows it", () => {
    expect(detectPackageFraction("half the bottle of Gatorade")).toEqual({ fraction: 0.5, word: "bottle" });
    expect(detectPackageFraction("I drank the whole can of Monster")).toEqual({ fraction: 1, word: "can" });
    expect(detectPackageFraction("12 oz of Coke")).toBeNull();
    const gatorade = lookupNutritionDb("Gatorade")!.item;
    const half = resolveServings(gatorade, normalizeQuantity("half the bottle of Gatorade"), "half the bottle of Gatorade");
    expect(half).toMatchObject({ servings: 0.5, confidence: "exact" });
    expect(half.method).toMatch(/20 fl oz bottle/);
    const monster = lookupNutritionDb("Monster")!.item;
    expect(resolveServings(monster, normalizeQuantity("the whole can")).servings).toBe(1);
    // 4 Oreos of a 3-cookie serving — the package is known, the count still rules.
    const oreo = lookupNutritionDb("Oreos")!.item;
    expect(resolveServings(oreo, normalizeQuantity("4 oreos"), "4 oreos").servings).toBeCloseTo(4 / 3);
  });
  it("the chat line and the source line read from the record", () => {
    const comp = dbComponent("Kellogg's Special K Red Berries Breakfast Cereal", "2 servings");
    const totals = sumComponentTotals([comp], NOW);
    expect(recapLine({ components: [comp], totals })).toBe("Kellogg's Special K Red Berries (2 × 1 cup (39 g)) — 280 kcal, 6 g protein, 68 g carbs, 1 g fat");
    expect(describeSources({ components: [comp] })).toBe("manufacturer label");
  });
});

describe("components and meal totals", () => {
  it("the spec's oatmeal + milk example: two components, one calculated total, label-grade confidence", () => {
    const oats = dbComponent("Quaker Instant Oatmeal Maple & Brown Sugar", "1 packet of Quaker Instant Oatmeal Maple & Brown Sugar");
    const milk = dbComponent("2% milk", "1 cup of 2% milk");
    expect(oats.servings).toBe(1);
    expect(milk.servings).toBe(1);
    const totals = sumComponentTotals([oats, milk], NOW);
    expect(totals.calories).toMatchObject({ value: 160 + 122, sourceType: "calculated", calculatedOrDirect: "calculated" });
    expect(totals.protein!.value).toBeCloseTo(4 + 8.1, 1);
    expect(totals.sodium!.value).toBe(260 + 115);
    expect(totals.calcium!.value).toBe(293); // only the milk reports calcium → total is capped to medium
    expect(totals.calcium!.confidence).toBe("medium");
    expect(overallConfidence([oats, milk])).toBe("high");
    expect(summarizeEnrichment({ components: [oats, milk], totals })).toMatch(/2 items: .*282 kcal/);
  });
  it("'I had 3 eggs, 2 pieces of wheat toast with butter, a banana, and coffee with creamer' is six components of ONE meal", () => {
    const parts = splitComponentPhrases("3 eggs, 2 pieces of wheat toast with butter, a banana, and coffee with creamer");
    expect(parts).toEqual(["3 eggs", "2 pieces of wheat toast", "butter", "a banana", "coffee", "creamer"]);
    const comps = parts.map((p) => dbComponent(p));
    expect(comps.map((c) => c.sourceItem)).toEqual([
      "Egg, large", "Whole wheat bread", "Butter, salted", "Banana, medium", "Coffee, brewed", "Coffee creamer",
    ]);
    const totals = sumComponentTotals(comps, NOW);
    expect(totals.calories!.value).toBe(Math.round(72 * 3 + 80 * 2 + 102 + 105 + 2 + 20));
    expect(totals.caffeine!.value).toBe(95);
  });
  it("a sentence boundary ends a component: the label reading is not part of the quantity", () => {
    expect(splitComponentPhrases("a Quest protein bar. It says 210 calories and 20g protein.")).toEqual(["a Quest protein bar", "It says 210 calories", "20g protein"]);
  });
  it("a comma inside a parenthetical is not a separator (live-run regression: Gatorade and Monster went to the model)", () => {
    expect(splitComponentPhrases("Gatorade (half bottle, ~16 oz)")).toEqual(["Gatorade (half bottle, ~16 oz)"]);
    expect(splitComponentPhrases("Monster Zero Ultra (1 can, 16 oz)")).toEqual(["Monster Zero Ultra (1 can, 16 oz)"]);
    expect(splitComponentPhrases("Big Mac (1 sandwich), medium fries")).toEqual(["Big Mac (1 sandwich)", "medium fries"]);
    const gatorade = dbComponent("Gatorade (half bottle, ~16 oz)");
    expect(gatorade).toMatchObject({ servings: 0.5, confidence: "exact" });
    expect(gatorade.nutrients.calories.value).toBe(70);
    const ultra = dbComponent("Monster Zero Ultra (1 can, 16 oz)");
    expect(ultra.nutrients.caffeine.value).toBe(140);
  });
  it("a bowl of a cereal is a serving of that cereal, not a 250 g bowl (live-run regression: 897 kcal)", () => {
    const cheerios = lookupNutritionDb("Cheerios (1 bowl)")!.item;
    const bowl = resolveServings(cheerios, normalizeQuantity("1 bowl"), "Cheerios (1 bowl)");
    expect(bowl).toMatchObject({ servings: 1, confidence: "medium" });
    expect(dbComponent("Cheerios (1 bowl)").nutrients.calories.value).toBe(140);
  });
  it("a Title-Case 'with' tail still splits off the added food; a composed dish keeps its ingredient (live-run regression)", () => {
    expect(splitComponentPhrases("Wheat Toast with Butter (2 slices)")).toEqual(["Wheat Toast (2 slices)", "Butter"]);
    expect(splitComponentPhrases("Coffee with Creamer")).toEqual(["Coffee", "Creamer"]);
    expect(splitComponentPhrases("Spinach Blueberry Banana Smoothie with Greek Yogurt")).toEqual(["Spinach Blueberry Banana Smoothie with Greek Yogurt"]);
    expect(splitComponentPhrases("Grande Latte with Oat Milk")).toEqual(["Grande Latte with Oat Milk"]);
    const comps = splitComponentPhrases("Wheat Toast with Butter (2 slices)").map((p) => dbComponent(p));
    expect(comps.map((c) => [c.sourceItem, c.servings])).toEqual([["Whole wheat bread", 2], ["Butter, salted", 1]]);
    expect(sumComponentTotals(comps, NOW).calories!.value).toBe(80 * 2 + 102);
  });
  it("a product name with '&' is not split into two foods", () => {
    expect(splitComponentPhrases("Quaker Instant Oatmeal Honey & Almonds (1 packet) + 2% milk (1 cup)")).toEqual([
      "Quaker Instant Oatmeal Honey & Almonds (1 packet)", "2% milk (1 cup)",
    ]);
  });
  it("buildEntryValuePatch never writes a model estimate over an existing base estimate, but does write label values", () => {
    const coke = dbComponent("Coke", "12 oz Coke");
    const totals = sumComponentTotals([coke], NOW);
    const patch = buildEntryValuePatch({ item: "Coca-Cola", calories: 150, sugar: 40 }, { totals, userProvided: [], userValues: {} });
    expect(patch).toMatchObject({ calories: 140, sugar: 39, carbs: 39, sodium: 45, caffeine: 34 });
    const guess: NutritionComponent = { ...coke, sourceType: "model_estimate", confidence: "medium", nutrients: componentNutrients(coke.perServing, 1, { source: "AI", sourceType: "model_estimate", confidence: "medium", enrichedAt: NOW }) };
    const guessPatch = buildEntryValuePatch({ item: "Coca-Cola", calories: 150 }, { totals: sumComponentTotals([guess], NOW), userProvided: [], userValues: {} });
    expect(guessPatch.calories).toBeUndefined(); // the base estimate stands
    expect(guessPatch.sugar).toBe(39);           // a value the base lacked is filled in
  });
});

describe("linked measurements and portion edits", () => {
  function enrichmentFor(comps: NutritionComponent[]): NutritionEnrichment {
    const totals = sumComponentTotals(comps, NOW);
    return {
      version: 1, status: "applied", mode: "auto", specificity: { level: "product", signals: [] }, sourceText: "x",
      components: comps, totals, userProvided: [], userValues: {}, confidence: overallConfidence(comps), servingFactor: 1,
      linkedEntries: [{ trackerId: "h", entryId: "e", trackerName: "Hydration", nutrient: "fluidMl", value: 355, unit: "ml" }],
      summary: "", enrichedAt: NOW,
    };
  }
  it("'I drank a 12 oz Coke' links fluid and caffeine; a solid links neither", () => {
    const links = linkedMeasurementsFor(enrichmentFor([dbComponent("Coke", "12 oz Coke")]));
    expect(links.map((l) => l.nutrient)).toEqual(["fluidMl", "caffeine"]);
    expect(links[0].toFieldValue(355)).toBeCloseTo(12, 0);
    expect(links[1].value).toBe(34);
    expect(linkedMeasurementsFor(enrichmentFor([dbComponent("Big Mac")]))).toEqual([]);
    const celsius = linkedMeasurementsFor(enrichmentFor([dbComponent("Celsius Peach Vibe")]));
    expect(celsius.find((l) => l.nutrient === "caffeine")?.value).toBe(200);
  });
  it("'actually I only ate half' halves components, totals, user values and linked rows — no second entry", () => {
    const e = enrichmentFor([dbComponent("Big Mac"), dbComponent("medium fries")]);
    const withUser = { ...e, ...applyUserProvided(e.totals, { calories: 900 }, NOW), userValues: { calories: 900 } };
    const half = rescaleEnrichment(withUser, 0.5, NOW);
    expect(half.servingFactor).toBe(0.5);
    expect(half.components.map((c) => c.servings)).toEqual([0.5, 0.5]);
    expect(half.totals.protein!.value).toBeCloseTo((25 + 4) / 2, 1);
    expect(half.totals.calories).toMatchObject({ value: 450, sourceType: "user" });
    expect(half.linkedEntries[0].value).toBe(178);
    expect(half.components.length).toBe(2);
    const twice = rescaleEnrichment(half, 2, NOW);
    expect(twice.servingFactor).toBe(1);
    expect(twice.totals.sodium!.value).toBe(1050 + 260);
  });
  it("an entry without component data rescales its nutrient fields and nothing else", () => {
    expect(rescalePlainValues({ item: "Cereal", calories: 220, protein: 6, mealType: "breakfast" }, 0.5)).toEqual({ calories: 110, protein: 3 });
  });
});

describe("modes", () => {
  it("preference strings → modes; unknown is Automatic", () => {
    expect(parseEnrichmentMode(null)).toBe("auto");
    expect(parseEnrichmentMode("off")).toBe("off");
    expect(parseEnrichmentMode("ask")).toBe("ask");
    expect(parseEnrichmentMode("whatever")).toBe("auto");
  });
  it("Automatic applies medium+; Ask applies only exact; Off never", () => {
    expect(appliesAutomatically("auto", "medium")).toBe(true);
    expect(appliesAutomatically("auto", "low")).toBe(false);
    expect(appliesAutomatically("ask", "high")).toBe(false);
    expect(appliesAutomatically("ask", "exact")).toBe(true);
    expect(appliesAutomatically("off", "exact")).toBe(false);
  });
  it("recognizes the profile's nutrition tracker under its usual names only", () => {
    expect(isNutritionTrackerLike({ name: "Nutrition", category: "custom" })).toBe(true);
    expect(isNutritionTrackerLike({ name: "Calories" })).toBe(true);
    expect(isNutritionTrackerLike({ name: "Food Log" })).toBe(true);
    expect(isNutritionTrackerLike({ name: "Hydration", category: "health" })).toBe(false);
    expect(isNutritionTrackerLike({ name: "Dog Food", category: "custom" })).toBe(false);
    expect(isNutritionTrackerLike({ name: "Food", category: "custom" })).toBe(false);
    expect(isNutritionTrackerLike({ name: "Running", category: "fitness" })).toBe(false);
  });
});
