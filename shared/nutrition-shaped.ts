/**
 * Food-shaped tracker-create detection — the "foods are never standalone
 * trackers" rule.
 *
 * User report (2026-06-25): logging "Spinach Blueberry Banana Smoothie with
 * Greek Yogurt and Honey" auto-created a *standalone tracker* for that one
 * smoothie instead of logging it as an entry on the profile's Nutrition
 * tracker. Specific foods/dishes/drinks are NUTRITION ENTRIES — they belong on
 * the one Nutrition/Calories tracker (with calories + macros), never as their
 * own tracker. There is exactly one nutrition tracker per profile; every food
 * the user eats is a row inside it.
 *
 * Root cause: the AI prompt told the model to log food to Nutrition, but
 * nothing in CODE enforced it, so a single stray `create_tracker("<food>")`
 * call produced a rogue tracker. This module is the enforcement: it is called
 * by server/ai-engine.ts `create_tracker` BEFORE a tracker is created, and
 * diverts food-shaped names into a Nutrition entry.
 *
 * Pure + dependency-free so the contract test can pin it, mirroring
 * shared/expense-shaped.ts.
 */

/**
 * Generic names that ARE the nutrition tracker itself — these must be allowed
 * to create the (single) Nutrition tracker, never diverted. Matched against the
 * whole, trimmed name so "Nutrition" / "Calories" / "Food Log" pass through but
 * "Chicken Salad" does not.
 */
export const GENERIC_NUTRITION_TRACKER_RE =
  /^\s*(daily |weekly |my )?(nutrition|nutrients?|calorie counter|calories?|caloric intake|diet|macros?|macro tracker|food log|food diary|food journal|food tracker|meal log|meal tracker|eating|nutrition tracker)\s*$/i;

/**
 * Unambiguous food / drink / dish words. Presence of any of these in a tracker
 * name is strong evidence the "tracker" is really a single food the user ate
 * or drank. Kept deliberately food-specific so it doesn't swallow legitimate
 * trackers ("Bench Press", "Blood Pressure", "Soccer", "Chess").
 *
 * Word boundaries (\b) keep "berry" from matching inside unrelated words; the
 * partial stems (blueberr/strawberr/raspberr) cover plural/singular.
 */
const FOOD_WORD_RE = new RegExp(
  "\\b(" +
    [
      // drinks
      "smoothie", "shake", "milkshake", "juice", "latte", "cappuccino", "espresso",
      "mocha", "frappuccino", "soda", "cola", "lemonade", "kombucha",
      // prepared dishes / forms
      "salad", "sandwich", "sub", "burger", "cheeseburger", "hamburger", "pizza",
      "burrito", "taco", "quesadilla", "nachos", "soup", "stew", "chili", "curry",
      "ramen", "noodle", "noodles", "pasta", "spaghetti", "lasagna", "risotto",
      "sushi", "bowl", "wrap", "toast", "bagel", "biscuit", "muffin", "croissant",
      "pancake", "pancakes", "waffle", "waffles", "oatmeal", "porridge", "cereal",
      "granola", "parfait", "omelet", "omelette", "frittata", "casserole", "stirfry",
      "stir-fry", "dumpling", "dumplings",
      // proteins / staples as a meal
      "yogurt", "egg", "eggs", "bacon", "sausage", "steak", "meatball", "meatballs",
      "chicken", "turkey", "salmon", "tuna", "shrimp", "tofu", "lentil", "lentils",
      // produce
      "blueberry", "blueberries", "strawberry", "strawberries", "raspberry",
      "raspberries", "blackberry", "blackberries", "berries", "berry",
      "banana", "bananas", "apple", "apples", "mango", "avocado", "spinach",
      "kale", "broccoli",
      // sweets / snacks
      "cookie", "cookies", "brownie", "brownies", "cake", "cupcake", "pie",
      "donut", "doughnut", "muffin", "candy", "chocolate", "icecream", "ice-cream",
      "popcorn", "chips", "fries", "pretzel", "pretzels",
      // meal labels as a one-off item
      "snack", "leftovers",
    ].join("|") +
    ")\\b",
  "i",
);

/** "X with Y and Z" reads like a composed dish, e.g. "...Smoothie with Greek Yogurt and Honey". */
const DISH_PHRASE_RE = /\bwith\b.+\band\b/i;

/**
 * Categories under which a food-shaped name should be diverted to Nutrition.
 * An explicit non-food category (medication, health, fitness, finance, …) is a
 * deliberate signal — e.g. "Fish Oil" under `medication` is a supplement
 * tracker, NOT a nutrition entry — so we never divert those on a stray food
 * word.
 */
const NUTRITION_LEANING_CATEGORIES = new Set(["", "nutrition", "food", "diet", "meal", "custom", "general"]);

export interface NutritionDivert {
  /** Human-readable food/drink name to store as the entry's `item` field. */
  item: string;
}

export type NutritionShapedVerdict =
  | { kind: "divert"; nutrition: NutritionDivert }
  | { kind: "allow" };

/**
 * Decide what to do with a tracker CREATE request.
 *  - "divert": a specific food/dish/drink — log it as an entry on the profile's
 *    Nutrition tracker instead of creating a standalone tracker.
 *  - "allow": not a single food (or it's the generic Nutrition tracker itself) —
 *    tracker creation may proceed.
 */
export function classifyNutritionAutoCreate(
  trackerName: string,
  category: string | null | undefined,
): NutritionShapedVerdict {
  const name = String(trackerName || "").trim();
  if (!name) return { kind: "allow" };

  const cat = String(category || "").trim().toLowerCase();

  // The single Nutrition/Calories tracker itself must always be creatable.
  if (GENERIC_NUTRITION_TRACKER_RE.test(name)) return { kind: "allow" };

  // An explicit non-food category is a deliberate signal — respect it. This is
  // what keeps "Fish Oil" (medication) or "Salmon Fishing" (lifestyle) from
  // being mistaken for a meal.
  const categoryAllowsDivert = NUTRITION_LEANING_CATEGORIES.has(cat);

  // Case 1: the model explicitly classified this as nutrition but named it
  // after a specific food rather than the generic tracker → it's an entry.
  if (cat === "nutrition" || cat === "diet" || cat === "food" || cat === "meal") {
    return { kind: "divert", nutrition: { item: cleanItemName(name) } };
  }

  // Case 2: a food-shaped name under a neutral category (custom/general/unset).
  if (categoryAllowsDivert && (FOOD_WORD_RE.test(name) || DISH_PHRASE_RE.test(name))) {
    return { kind: "divert", nutrition: { item: cleanItemName(name) } };
  }

  return { kind: "allow" };
}

/** Title-case-ish cleanup so the entry label reads like a food name. */
function cleanItemName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  // Already mixed-case (e.g. "Greek Yogurt") — leave as-is. Only normalize
  // all-lower or ALL-CAPS input.
  if (/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed)) return trimmed;
  return trimmed
    .toLowerCase()
    .split(" ")
    .map((w) => (w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * Is this name the profile's ONE nutrition tracker, under any of its usual
 * names? "Calories", "Food Log", "Macros" and "Nutrition" are the same
 * tracker — a profile has exactly one.
 *
 * Reported 2026-09-02 ("there is no calorie tracker, it should go in
 * nutrition"): log_tracker_entry already resolved these aliases onto the
 * existing Nutrition tracker, but create_tracker's duplicate check compared
 * canonical name identity only, where "Calories" and "Nutrition" are
 * different words. So a create call for "Calories" slipped past the check and
 * would stand up a second nutrition tracker beside the real one.
 */
export function isNutritionTrackerName(name: string | null | undefined): boolean {
  return GENERIC_NUTRITION_TRACKER_RE.test(String(name ?? ""));
}
