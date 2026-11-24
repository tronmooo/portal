// One food = one entry (shared/food-split.ts). A chat call that logs several
// foods as one item ("Banana + Doughnut") is turned into one call per food
// BEFORE it runs, so each food gets its own entry, its own card and its own
// undo — the model's combined call is never written.
//
// Numbers: a food the internal reference prices takes those values; the rest
// share what is left of the model's total. The in-turn enrichment then
// refines each saved entry on its own, exactly as for a single-food log.
import { splitSeparateFoods, foodLabel, shareMealValues } from "@shared/food-split";
import { isNutritionTrackerName } from "@shared/nutrition-shaped";
import { canonicalNutrientKey, sumComponentTotals, detectUserStatedNutrition } from "@shared/nutrition-enrichment";
import { lookupComponents } from "./nutrition-enrichment";
import { repeatedMealInputs } from "./nutrition-edits";

const ITEM_KEYS = ["item", "food", "meal", "name", "description"] as const;

/** The reference table's numbers for one food, or null when it cannot price all of it. */
async function referenceValues(food: string, message: string): Promise<Record<string, number> | null> {
  try {
    const now = new Date().toISOString();
    const found = await lookupComponents(food, message, { syncOnly: true, aliases: {}, now: () => now }, now);
    if (found.components.length === 0 || found.unresolved.length > 0) return null;
    const totals = sumComponentTotals(found.components, now);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(totals)) if (v && typeof v.value === "number") out[k] = v.value;
    return typeof out.calories === "number" ? out : null;
  } catch {
    return null;
  }
}

/**
 * The inputs to run instead of this `log_tracker_entry` input: one per food,
 * or null when the call is not a several-foods nutrition log (run it as is).
 */
export async function splitCombinedFoodLog(
  input: Record<string, any> | null | undefined,
  userMessage: string,
  /** For "the same breakfast as yesterday": the person's own food entries, loaded only when a call asks to repeat. */
  repeat?: { entries: (forProfile?: string) => Promise<Array<{ values?: Record<string, any> | null; timestamp?: string | null }>>; timezone: string; today: string },
): Promise<Array<Record<string, any>> | null> {
  if (input?.repeatFrom && repeat && isNutritionTrackerName(String(input.trackerName || ""))) {
    const out = repeatedMealInputs(input, await repeat.entries(input.forProfile), { timezone: repeat.timezone, today: repeat.today });
    // Nothing to copy: the call runs as it is and the executor says why.
    return "inputs" in out ? out.inputs : [{ ...input, __repeatError: out.error }];
  }
  const values = input?.values;
  if (!input || !values || typeof values !== "object") return null;
  if (!isNutritionTrackerName(String(input.trackerName || ""))) return null;
  const itemKey = ITEM_KEYS.find((k) => typeof values[k] === "string" && values[k].trim());
  if (!itemKey) return null;
  const foods = splitSeparateFoods(String(values[itemKey]));
  if (foods.length < 2) return null;
  // The user's own words decide how many foods there are. A single food the
  // agent named database-style ("Salmon, Atlantic, farmed, raw (120 g)",
  // "Barilla Spaghetti No. 5, weighed dry") has commas and is still one food:
  // split, it became three entries with the same figures (746 kcal for 120 g).
  const said = String(userMessage || "").trim().replace(/[.!?]+$/, "")
    // A barcode or UPC the user appends identifies the food; it is not another one.
    .replace(/[,;]?\s*\(?\b(?:barcode|upc|ean)\b[\s:#]*[\d -]{8,}\)?/gi, " ");
  if (said && splitSeparateFoods(said).length < 2) return null;
  // Numbers the user read off a label belong to what they named as a whole;
  // they cannot be divided between foods by guesswork.
  if (Object.keys(detectUserStatedNutrition(userMessage || "")).length > 0) return null;

  // The combined call's numbers, under the keys the model used.
  const totalKeys = Object.keys(values).filter((k) => typeof values[k] === "number" && isFinite(values[k]) && canonicalNutrientKey(k));
  const total: Record<string, number> = {};
  for (const k of totalKeys) total[k] = values[k];
  const known = await Promise.all(foods.map(async (food) => {
    const ref = await referenceValues(food, userMessage || "");
    if (!ref) return null;
    const mapped: Record<string, number> = {};
    for (const k of totalKeys) {
      const canon = canonicalNutrientKey(k)!;
      if (typeof ref[canon] === "number") mapped[k] = ref[canon];
    }
    return mapped;
  }));
  const shares = shareMealValues(total, known);

  const rest: Record<string, any> = {};
  for (const [k, v] of Object.entries(values)) if (!totalKeys.includes(k) && k !== itemKey) rest[k] = v;
  return foods.map((food, i) => ({
    ...input,
    values: { ...rest, [itemKey]: foodLabel(food), ...shares[i] },
  }));
}
