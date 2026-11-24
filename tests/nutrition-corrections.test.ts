// Corrections to food already logged (owner's test sheet, 2026-11-24, part 5):
// "Actually, I only ate half of that protein bar", "I drank a protein shake
// yesterday, not today", "Remove the cheese from my lunch", "I had the same
// breakfast as yesterday". Each changes or reuses an entry that exists; none
// may leave a second entry behind or re-estimate what is already on record.
//
// The store is the in-memory one; the operations are the real ones the chat
// tools call (server/nutrition-edits.ts, server/nutrition-enrichment.ts).
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import { enrichNutritionEntry, rescaleNutritionEntry } from "../server/nutrition-enrichment";
import { findNutritionEntry, mealOfEntry, removeNutritionComponent, repeatedMealInputs, resolveRepeatDate } from "../server/nutrition-edits";
import { splitCombinedFoodLog } from "../server/meal-split";
import { validateToolInput } from "../server/ai-engine";
import type { NutritionEnrichment } from "../shared/nutrition-enrichment";

const TZ = "America/Los_Angeles";
const NOW = "2026-11-24T20:00:00.000Z";
const FIELDS = [
  { name: "calories", type: "number" as const, unit: "kcal", isPrimary: true },
  { name: "protein", type: "number" as const, unit: "g" },
  { name: "carbs", type: "number" as const, unit: "g" },
  { name: "fat", type: "number" as const, unit: "g" },
  { name: "item", type: "text" as const },
  { name: "mealType", type: "text" as const },
];
const offline = { now: () => NOW, aliases: {}, productLookup: async () => null, modelEstimate: async () => null };

let storage: MemStorage;
let trackerId: string;
beforeEach(async () => {
  storage = new MemStorage();
  trackerId = (await storage.createTracker({ name: "Nutrition", category: "nutrition", fields: FIELDS })).id;
});
const entries = async () => (await storage.getTracker(trackerId))!.entries as any[];
async function log(values: Record<string, any>, timestamp: string, message?: string) {
  const e = await storage.logEntry({ trackerId, values, timestamp } as any);
  if (message) await enrichNutritionEntry(storage, { entryId: e!.id, trackerId, message, mode: "auto", deps: offline });
  return (await storage.getTrackerEntry(e!.id))! as any;
}

describe("which entry a correction is about", () => {
  it("a food word picks the most recent entry naming it; a meal word picks that meal", async () => {
    await log({ item: "Quest Protein Bar", calories: 190 }, "2026-11-23T16:00:00.000Z");
    const bar = await log({ item: "Quest Protein Bar", calories: 190 }, "2026-11-24T16:00:00.000Z");
    const lunch = await log({ item: "Turkey Sandwich", calories: 400, mealType: "lunch" }, "2026-11-24T19:30:00.000Z");
    const coffee = await log({ item: "Black Coffee", calories: 2 }, "2026-11-24T19:45:00.000Z");
    const all = await entries();
    expect(findNutritionEntry(all, "that protein bar", { timezone: TZ })!.id).toBe(bar.id);
    // 11:45 am with no meal stated is lunch-time: the newest entry of that meal.
    expect(findNutritionEntry(all, "lunch", { timezone: TZ })!.id).toBe(coffee.id);
    expect(findNutritionEntry(all, "my lunch", { timezone: TZ, containing: "sandwich" })!.id).toBe(lunch.id);
    expect(findNutritionEntry(all, "pizza", { timezone: TZ })).toBeUndefined();
  });

  it("an entry with no stated meal belongs to the meal its local time falls in", () => {
    expect(mealOfEntry({ values: {}, timestamp: "2026-11-24T15:30:00.000Z" }, TZ)).toBe("breakfast"); // 7:30 am PST
    expect(mealOfEntry({ values: {}, timestamp: "2026-11-24T20:30:00.000Z" }, TZ)).toBe("lunch");     // 12:30 pm
    expect(mealOfEntry({ values: { mealType: "dinner" }, timestamp: "2026-11-24T15:30:00.000Z" }, TZ)).toBe("dinner");
  });
});

describe("'actually I only ate half of that protein bar' rescales the one entry", () => {
  it("a label the user read out is halved with its components; still one entry", async () => {
    const bar = await log({ item: "Protein Bar", calories: 1 }, NOW, "I ate a protein bar containing 200 calories, 20g protein, 24g total carbs and 8g fat.");
    expect(bar.values).toMatchObject({ calories: 200, protein: 20, carbs: 24, fat: 8 });
    const out = await rescaleNutritionEntry(storage, { entryId: bar.id, trackerId, factor: 0.5 });
    expect(out.ok).toBe(true);
    const after = (await storage.getTrackerEntry(bar.id))! as any;
    expect(after.values).toMatchObject({ calories: 100, protein: 10, carbs: 12, fat: 4 });
    expect((await entries()).length).toBe(1);
  });
});

describe("'remove the cheese from my lunch' subtracts the ingredient's own figures", () => {
  it("re-sums what is left, renames the item, and leaves one entry", async () => {
    const lunch = await log({ item: "Chicken (100 g) with Olive Oil (15 g)", calories: 1, mealType: "lunch" }, NOW, "I ate 100 grams of chicken with 15 grams of olive oil.");
    expect(lunch.values.calories).toBeCloseTo(297.2, 1);
    const out = await removeNutritionComponent(storage, { trackerId, entry: lunch, name: "olive oil", now: NOW });
    expect(out).toMatchObject({ ok: true, removed: "Olive oil" });
    const after = (await storage.getTrackerEntry(lunch.id))! as any;
    expect(after.values).toMatchObject({ item: "Chicken (100 g)", calories: 165, protein: 31, fat: 3.6 });
    expect((after.computed.nutrition as NutritionEnrichment).components.map((c) => c.name)).toEqual(["Chicken breast, cooked"]);
    expect((await entries()).length).toBe(1);
  });

  it("an entry saved as one estimate has nothing to subtract, and says so instead of guessing", async () => {
    const sandwich = await log({ item: "Turkey Sandwich with Cheese", calories: 450, protein: 28, carbs: 40, fat: 18 }, NOW);
    const out = await removeNutritionComponent(storage, { trackerId, entry: sandwich, name: "cheese", now: NOW });
    expect(out.ok).toBe(false);
    expect(out.needsValues).toBe(true);
    // Nothing was written.
    expect(((await storage.getTrackerEntry(sandwich.id))! as any).values).toMatchObject({ item: "Turkey Sandwich with Cheese", calories: 450 });
  });
});

describe("'I drank a protein shake yesterday, not today' moves the entry", () => {
  it("the corrected day is parsed like a log's, and the entry keeps its values", async () => {
    const shake = await log({ item: "Protein Shake", calories: 160, protein: 30 }, NOW);
    const v = validateToolInput("update_tracker_entry", { trackerName: "Nutrition", values: {}, match: "shake", at: "2026-11-23" });
    expect(v.valid).toBe(true);
    const at = String((v.normalized as any).at);
    // A bare date is that calendar day in the user's zone, never the evening before.
    expect(new Date(at).toLocaleDateString("en-CA", { timeZone: TZ })).toBe("2026-11-23");
    const moved = await storage.updateTrackerEntry(trackerId, shake.id, { timestamp: at });
    expect(String((moved as any).timestamp)).toBe(at);
    expect((moved as any).values).toMatchObject({ item: "Protein Shake", calories: 160, protein: 30 });
    expect((await entries()).length).toBe(1);
  });
});

describe("'I had the same breakfast as yesterday' copies the entries, one per food", () => {
  const today = "2026-11-24";
  async function yesterdayAndToday() {
    await log({ item: "3 Eggs", calories: 216, protein: 18.9, carbs: 1.2, fat: 14.4 }, "2026-11-23T15:30:00.000Z"); // 7:30 am PST
    await log({ item: "Wheat Toast", calories: 80, protein: 4, carbs: 14, fat: 1, mealType: "breakfast" }, "2026-11-23T15:35:00.000Z");
    await log({ item: "Turkey Sandwich", calories: 400, mealType: "lunch" }, "2026-11-23T20:30:00.000Z");
    return entries();
  }

  it("yesterday's breakfast → one log per food with the same numbers; lunch is not copied", async () => {
    const all = await yesterdayAndToday();
    const out = repeatedMealInputs({ trackerName: "Nutrition", values: {}, repeatFrom: "yesterday", repeatMeal: "breakfast" }, all, { timezone: TZ, today });
    if (!("inputs" in out)) throw new Error(out.error);
    expect(out.inputs.map((i) => i.values.item)).toEqual(["3 Eggs", "Wheat Toast"]);
    expect(out.inputs[0].values).toMatchObject({ calories: 216, protein: 18.9, carbs: 1.2, fat: 14.4, mealType: "breakfast" });
    expect(out.inputs.every((i) => i.repeatFrom === undefined && i.trackerName === "Nutrition")).toBe(true);
  });

  it("the chat's expansion step turns the one call into those logs", async () => {
    const all = await yesterdayAndToday();
    const parts = await splitCombinedFoodLog(
      { trackerName: "Nutrition", values: {}, repeatFrom: "yesterday", repeatMeal: "breakfast" },
      "I had the same breakfast as yesterday",
      { entries: async () => all, timezone: TZ, today },
    );
    expect(parts!.map((p) => p.values.item)).toEqual(["3 Eggs", "Wheat Toast"]);
    for (const p of parts!) expect(validateToolInput("log_tracker_entry", p).valid).toBe(true);
  });

  it("a day with nothing to copy is an error the model must relay, never an invented meal", async () => {
    const all = await yesterdayAndToday();
    const parts = await splitCombinedFoodLog(
      { trackerName: "Nutrition", values: {}, repeatFrom: "2026-11-20", repeatMeal: "breakfast" },
      "same breakfast as Friday",
      { entries: async () => all, timezone: TZ, today },
    );
    expect(parts).toHaveLength(1);
    const v = validateToolInput("log_tracker_entry", parts![0]);
    expect(v.valid).toBe(false);
    expect(v.errors.join(" ")).toContain("Nothing was logged for breakfast on 2026-11-20");
  });

  it("repeat dates resolve in the user's calendar", () => {
    expect(resolveRepeatDate("yesterday", today)).toBe("2026-11-23");
    expect(resolveRepeatDate("2 days ago", today)).toBe("2026-11-22");
    expect(resolveRepeatDate("2026-11-01", today)).toBe("2026-11-01");
    expect(resolveRepeatDate("whenever", today)).toBeNull();
  });
});

// "Actually it was cod, not salmon" / "it was weighed dry": the same entry, a
// different food, looked up afresh at the amount on record.
import { replaceNutritionFood } from "../server/nutrition-edits";
import { normalizeQuantity } from "../shared/nutrition-enrichment";

describe("'actually it was X, not Y' replaces the food on the same entry", () => {
  const fromDb = (name: string, per100: Record<string, number>) => async (asks: any[]) => asks.map((a) => {
    const q = normalizeQuantity(a.quantityText);
    const grams = q.grams ?? 100;
    return {
      name, userQuantity: a.quantityText, normalizedQuantity: q, servings: grams / 100,
      matchedServing: { amount: 100, unit: "g", grams: 100, ml: null, label: "100 g" }, sourceType: "reference" as const, source: "USDA FoodData Central (test)", sourceItem: name, confidence: "high" as const,
      perServing: per100,
      nutrients: Object.fromEntries(Object.entries(per100).map(([k, v]) => [k, { value: Math.round(v * grams) / 100, unit: "g", source: "USDA", sourceType: "reference", confidence: "high", calculatedOrDirect: "calculated", enrichedAt: NOW }])) as any,
    };
  });

  it("the new food's figures for the amount already on record; nothing of the old food is left", async () => {
    const salmon = await storage.logEntry({ trackerId, values: { item: "Baked Atlantic Salmon (170 g)", calories: 1 }, timestamp: NOW } as any);
    await enrichNutritionEntry(storage, { entryId: salmon!.id, trackerId, message: "I ate 170 grams of baked farmed Atlantic salmon.", mode: "auto", deps: { ...offline, sourceLookup: fromDb("Fish, salmon, Atlantic, farmed, cooked, dry heat", { calories: 206, protein: 22.1, carbs: 0, fat: 12.35, caffeine: 5 }) } });
    const before = (await storage.getTrackerEntry(salmon!.id))! as any;
    expect(before.values).toMatchObject({ calories: 350.2, caffeine: 9 });
    const out = await replaceNutritionFood(storage, { trackerId, entry: before, newItem: "baked Atlantic cod", deps: { ...offline, sourceLookup: fromDb("Fish, cod, Atlantic, cooked, dry heat", { calories: 105, protein: 22.83, carbs: 0, fat: 0.86 }) } });
    expect(out.ok).toBe(true);
    const after = (await storage.getTrackerEntry(salmon!.id))! as any;
    // 170 g carried over from the entry: 105 × 1.7.
    expect(after.values).toMatchObject({ item: "Baked Atlantic cod", calories: 178.5, protein: 38.81, fat: 1.46 });
    expect("caffeine" in after.values).toBe(false);
    expect(after.computed.nutrition.components.map((c: any) => c.name)).toEqual(["Fish, cod, Atlantic, cooked, dry heat"]);
    expect((await entries()).length).toBe(1);
  });

  it("when no source knows the new food the entry is put back untouched and the caller is told to supply figures", async () => {
    const salmon = await storage.logEntry({ trackerId, values: { item: "Baked Salmon (170 g)", calories: 350, protein: 37 }, timestamp: NOW } as any);
    const out = await replaceNutritionFood(storage, { trackerId, entry: (await storage.getTrackerEntry(salmon!.id))!, newItem: "grilled snoek", deps: { ...offline, sourceLookup: async (asks: any[]) => asks.map(() => null) } });
    expect(out).toMatchObject({ ok: false, needsValues: true });
    expect(((await storage.getTrackerEntry(salmon!.id))! as any).values).toMatchObject({ item: "Baked Salmon (170 g)", calories: 350, protein: 37 });
  });
});
