// ─── Internal nutrition reference (pure) ─────────────────────────────────────
//
// The first stop of the enrichment lookup ladder and the only one that never
// touches the network: a curated table of generic reference foods (standard
// nutrition references), common branded products (manufacturer labels) and
// restaurant menu items (published menu nutrition). "2 eggs" or "a 12 oz Coke"
// resolve here in microseconds, so the external lookups are reserved for the
// items that need them ("Trader Joe's Chicken Shawarma Bowl").
//
// Values are per the stated serving. Only values read from a label or a
// standard reference belong here — an item whose label is uncertain is left
// OUT so the lookup falls through to a source (or stays a labelled estimate)
// rather than carrying false precision. Confidence per row:
//   exact  — a specific branded product's label, stable across the line
//   high   — a manufacturer / restaurant figure that is revised from time to time
//   medium — a generic reference food standing in for whatever the user had
//
// Pinned by tests/nutrition-enrichment.test.ts.

import {
  GRAMS_PER_OZ,
  ML_PER_FL_OZ,
  sizeFactor,
  type EnrichmentConfidence,
  type EnrichmentSourceType,
  type NutrientVector,
  type QuantityNormalization,
} from "./nutrition-enrichment";

export interface NutritionDbServing {
  amount: number;
  /** The serving's own unit as a label word: "can", "packet", "egg", "cup", "slice", "bar", "softgel"… */
  unit: string;
  grams?: number;
  ml?: number;
  label: string;
}

export interface NutritionDbItem {
  id: string;
  name: string;
  brand?: string;
  kind: "generic" | "branded" | "restaurant" | "supplement";
  serving: NutritionDbServing;
  perServing: NutrientVector;
  sourceType: EnrichmentSourceType;
  source: string;
  confidence: EnrichmentConfidence;
  isBeverage?: boolean;
  /** Alternatives; each inner list is a set of words that must ALL appear. */
  match: string[][];
  /** Words whose presence rules the row out ("diet" for regular Coke). */
  exclude?: string[];
  /** Words that name one unit of this serving's `unit` ("slice", "slices"). */
  unitWords?: string[];
}

const FL = ML_PER_FL_OZ;

const beverage = (ml: number) => ({ fluidMl: Math.round(ml) });

export const NUTRITION_DB: readonly NutritionDbItem[] = [
  // ── Generic reference foods ────────────────────────────────────────────────
  {
    id: "egg-large", name: "Egg, large", kind: "generic",
    serving: { amount: 1, unit: "egg", grams: 50, label: "1 large egg (50 g)" },
    perServing: { calories: 72, protein: 6.3, carbs: 0.4, fat: 4.8, saturatedFat: 1.6, fiber: 0, sugar: 0.2, sodium: 71, cholesterol: 186, potassium: 69, calcium: 28, iron: 0.9 },
    sourceType: "reference", source: "standard nutrition reference: large egg", confidence: "high",
    match: [["egg"], ["eggs"]], exclude: ["eggo", "eggplant", "egg white", "egg whites", "eggnog", "mcmuffin"], unitWords: ["egg", "eggs"],
  },
  {
    id: "egg-whites", name: "Egg whites", kind: "generic",
    serving: { amount: 1, unit: "egg white", grams: 33, label: "1 large egg white (33 g)" },
    perServing: { calories: 17, protein: 3.6, carbs: 0.2, fat: 0.1, sodium: 55, potassium: 54 },
    sourceType: "reference", source: "standard nutrition reference: egg white", confidence: "high",
    match: [["egg", "white"], ["egg", "whites"]], unitWords: ["egg white", "egg whites", "white", "whites"],
  },
  {
    id: "banana-medium", name: "Banana, medium", kind: "generic",
    serving: { amount: 1, unit: "banana", grams: 118, label: "1 medium banana (118 g)" },
    perServing: { calories: 105, protein: 1.3, carbs: 27, fat: 0.4, fiber: 3.1, sugar: 14.4, sodium: 1, potassium: 422, calcium: 6, iron: 0.3, vitaminC: 10 },
    sourceType: "reference", source: "standard nutrition reference: medium banana", confidence: "high",
    match: [["banana"], ["bananas"]], exclude: ["bread", "smoothie", "split", "chips"], unitWords: ["banana", "bananas"],
  },
  {
    id: "apple-medium", name: "Apple, medium", kind: "generic",
    serving: { amount: 1, unit: "apple", grams: 182, label: "1 medium apple (182 g)" },
    perServing: { calories: 95, protein: 0.5, carbs: 25, fat: 0.3, fiber: 4.4, sugar: 19, sodium: 2, potassium: 195, calcium: 11, iron: 0.2, vitaminC: 8.4 },
    sourceType: "reference", source: "standard nutrition reference: medium apple", confidence: "high",
    match: [["apple"], ["apples"]], exclude: ["juice", "sauce", "pie", "cider", "cinnamon", "crisp", "applebee"], unitWords: ["apple", "apples"],
  },
  {
    id: "orange-medium", name: "Orange, medium", kind: "generic",
    serving: { amount: 1, unit: "orange", grams: 131, label: "1 medium orange (131 g)" },
    perServing: { calories: 62, protein: 1.2, carbs: 15.4, fat: 0.2, fiber: 3.1, sugar: 12.2, sodium: 0, potassium: 237, calcium: 52, iron: 0.1, vitaminC: 70 },
    sourceType: "reference", source: "standard nutrition reference: medium orange", confidence: "high",
    match: [["orange"], ["oranges"]], exclude: ["juice", "chicken", "soda", "crush"], unitWords: ["orange", "oranges"],
  },
  {
    id: "avocado-half", name: "Avocado", kind: "generic",
    serving: { amount: 0.5, unit: "avocado", grams: 68, label: "½ avocado (68 g)" },
    perServing: { calories: 114, protein: 1.3, carbs: 6, fat: 10.5, saturatedFat: 1.5, fiber: 4.6, sugar: 0.5, sodium: 5, potassium: 345 },
    sourceType: "reference", source: "standard nutrition reference: avocado", confidence: "medium",
    match: [["avocado"]], exclude: ["toast", "oil"], unitWords: ["avocado", "avocados"],
  },
  {
    id: "almonds", name: "Almonds", kind: "generic",
    serving: { amount: 1, unit: "oz", grams: 28, label: "1 oz almonds (28 g, ~23 nuts)" },
    perServing: { calories: 164, protein: 6, carbs: 6.1, fat: 14.2, saturatedFat: 1.1, fiber: 3.5, sugar: 1.2, sodium: 0, potassium: 208, calcium: 76, iron: 1.1 },
    sourceType: "reference", source: "standard nutrition reference: almonds", confidence: "high",
    match: [["almonds"]], exclude: ["milk", "butter", "breeze", "honey"],
  },
  {
    id: "milk-2pct", name: "Milk, 2% reduced fat", kind: "generic", isBeverage: true,
    serving: { amount: 1, unit: "cup", grams: 244, ml: 240, label: "1 cup (240 ml)" },
    perServing: { calories: 122, protein: 8.1, carbs: 11.7, fat: 4.8, saturatedFat: 3.1, fiber: 0, sugar: 12.3, sodium: 115, cholesterol: 20, potassium: 366, calcium: 293, iron: 0.1, vitaminD: 2.9, ...beverage(240) },
    sourceType: "reference", source: "standard nutrition reference: 2% milk", confidence: "high",
    match: [["2%", "milk"], ["2", "percent", "milk"], ["reduced", "fat", "milk"], ["2%"]], exclude: ["fairlife", "almond", "oat", "soy", "coconut", "chocolate"], unitWords: ["cup", "cups"],
  },
  {
    id: "milk-whole", name: "Milk, whole", kind: "generic", isBeverage: true,
    serving: { amount: 1, unit: "cup", grams: 244, ml: 240, label: "1 cup (240 ml)" },
    perServing: { calories: 149, protein: 7.7, carbs: 11.7, fat: 7.9, saturatedFat: 4.6, fiber: 0, sugar: 12.3, sodium: 105, cholesterol: 24, potassium: 322, calcium: 276, vitaminD: 3.2, ...beverage(240) },
    sourceType: "reference", source: "standard nutrition reference: whole milk", confidence: "high",
    match: [["whole", "milk"]], exclude: ["fairlife", "almond", "oat", "soy", "chocolate"], unitWords: ["cup", "cups"],
  },
  {
    id: "milk-skim", name: "Milk, skim (fat free)", kind: "generic", isBeverage: true,
    serving: { amount: 1, unit: "cup", grams: 245, ml: 240, label: "1 cup (240 ml)" },
    perServing: { calories: 83, protein: 8.3, carbs: 12.2, fat: 0.2, saturatedFat: 0.1, fiber: 0, sugar: 12.5, sodium: 103, cholesterol: 5, potassium: 382, calcium: 299, vitaminD: 2.9, ...beverage(240) },
    sourceType: "reference", source: "standard nutrition reference: skim milk", confidence: "high",
    match: [["skim", "milk"], ["nonfat", "milk"], ["fat", "free", "milk"], ["non-fat", "milk"]], exclude: ["fairlife", "almond", "oat", "soy"], unitWords: ["cup", "cups"],
  },
  {
    id: "milk-generic", name: "Milk", kind: "generic", isBeverage: true,
    serving: { amount: 1, unit: "cup", grams: 244, ml: 240, label: "1 cup (240 ml)" },
    perServing: { calories: 122, protein: 8.1, carbs: 11.7, fat: 4.8, saturatedFat: 3.1, sugar: 12.3, sodium: 115, calcium: 293, ...beverage(240) },
    sourceType: "reference", source: "standard nutrition reference: milk (2% assumed)", confidence: "medium",
    match: [["milk"]], exclude: ["fairlife", "almond", "oat", "soy", "coconut", "chocolate", "shake", "milkshake", "2%", "whole", "skim", "nonfat", "muscle", "latte"], unitWords: ["cup", "cups"],
  },
  {
    id: "oatmeal-cooked", name: "Oatmeal, cooked", kind: "generic",
    serving: { amount: 1, unit: "cup", grams: 234, label: "1 cup cooked (234 g)" },
    perServing: { calories: 166, protein: 5.9, carbs: 28, fat: 3.6, saturatedFat: 0.7, fiber: 4, sugar: 0.6, sodium: 9, potassium: 164, calcium: 21, iron: 2.1 },
    sourceType: "reference", source: "standard nutrition reference: cooked oatmeal", confidence: "medium",
    match: [["oatmeal"], ["oats"], ["porridge"]], exclude: ["quaker", "cookie", "cookies", "raisin", "overnight", "bar", "cereal", "bunches", "granola", "crunch"], unitWords: ["cup", "cups", "bowl", "bowls"],
  },
  {
    id: "bread-wheat-slice", name: "Whole wheat bread", kind: "generic",
    serving: { amount: 1, unit: "slice", grams: 32, label: "1 slice (32 g)" },
    perServing: { calories: 80, protein: 4, carbs: 14, fat: 1, saturatedFat: 0.2, fiber: 2, sugar: 1.5, sodium: 150, potassium: 70, calcium: 40, iron: 0.9 },
    sourceType: "reference", source: "standard nutrition reference: whole wheat bread", confidence: "medium",
    match: [["wheat", "toast"], ["wheat", "bread"], ["whole", "wheat"], ["whole", "grain", "toast"], ["whole", "grain", "bread"]], exclude: ["thins", "cheerios", "shredded"], unitWords: ["slice", "slices", "piece", "pieces"],
  },
  {
    id: "bread-white-slice", name: "White bread", kind: "generic",
    serving: { amount: 1, unit: "slice", grams: 29, label: "1 slice (29 g)" },
    perServing: { calories: 75, protein: 2.6, carbs: 14, fat: 1, saturatedFat: 0.2, fiber: 0.8, sugar: 1.6, sodium: 147, calcium: 40, iron: 1 },
    sourceType: "reference", source: "standard nutrition reference: white bread", confidence: "medium",
    match: [["toast"], ["bread"], ["white", "toast"], ["white", "bread"]], exclude: ["wheat", "whole", "grain", "banana", "garlic", "french", "pita", "naan", "avocado", "sourdough", "rye", "dave's", "killer"], unitWords: ["slice", "slices", "piece", "pieces"],
  },
  {
    id: "butter", name: "Butter, salted", kind: "generic",
    serving: { amount: 1, unit: "tbsp", grams: 14, label: "1 tbsp (14 g)" },
    perServing: { calories: 102, protein: 0.1, carbs: 0, fat: 11.5, saturatedFat: 7.3, fiber: 0, sugar: 0, sodium: 91, cholesterol: 31 },
    sourceType: "reference", source: "standard nutrition reference: butter", confidence: "medium",
    match: [["butter"]], exclude: ["peanut", "almond", "cashew", "apple", "jif", "skippy", "cookie", "buttermilk", "butternut"], unitWords: ["tbsp", "tablespoon", "tablespoons", "pat", "pats"],
  },
  {
    id: "coffee-black", name: "Coffee, brewed", kind: "generic", isBeverage: true,
    serving: { amount: 8, unit: "fl oz", ml: 237, label: "8 fl oz (237 ml)" },
    perServing: { calories: 2, protein: 0.3, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 5, potassium: 116, caffeine: 95, ...beverage(237) },
    sourceType: "reference", source: "standard nutrition reference: brewed coffee", confidence: "high",
    match: [["coffee"]], exclude: ["creamer", "latte", "cappuccino", "mocha", "frappuccino", "starbucks", "dunkin", "cold brew", "espresso", "cake", "ice cream"], unitWords: ["cup", "cups", "mug", "mugs"],
  },
  {
    id: "cold-brew", name: "Cold brew coffee", kind: "generic", isBeverage: true,
    serving: { amount: 12, unit: "fl oz", ml: 355, label: "12 fl oz (355 ml)" },
    perServing: { calories: 5, protein: 0.3, carbs: 0, fat: 0, sodium: 10, caffeine: 200, ...beverage(355) },
    sourceType: "reference", source: "standard nutrition reference: cold brew coffee", confidence: "medium",
    match: [["cold", "brew"]], exclude: ["starbucks"],
  },
  {
    id: "espresso", name: "Espresso", kind: "generic", isBeverage: true,
    serving: { amount: 1, unit: "shot", ml: 30, label: "1 shot (1 fl oz)" },
    perServing: { calories: 3, protein: 0.1, carbs: 0.5, fat: 0.1, sodium: 4, caffeine: 64, ...beverage(30) },
    sourceType: "reference", source: "standard nutrition reference: espresso", confidence: "high",
    match: [["espresso"]], exclude: ["martini", "starbucks", "latte"], unitWords: ["shot", "shots"],
  },
  {
    id: "coffee-creamer", name: "Coffee creamer", kind: "generic",
    serving: { amount: 1, unit: "tbsp", ml: 15, grams: 15, label: "1 tbsp (15 ml)" },
    perServing: { calories: 20, protein: 0, carbs: 2, fat: 1, saturatedFat: 0.5, sugar: 1, sodium: 5 },
    sourceType: "reference", source: "standard nutrition reference: flavored coffee creamer", confidence: "medium",
    match: [["creamer"], ["half", "and", "half"], ["half", "&", "half"]], unitWords: ["tbsp", "tablespoon", "tablespoons", "splash", "splashes"],
  },
  {
    id: "tea-brewed", name: "Tea, brewed", kind: "generic", isBeverage: true,
    serving: { amount: 8, unit: "fl oz", ml: 237, label: "8 fl oz (237 ml)" },
    perServing: { calories: 2, protein: 0, carbs: 0.7, fat: 0, sugar: 0, sodium: 7, caffeine: 40, ...beverage(237) },
    sourceType: "reference", source: "standard nutrition reference: brewed tea", confidence: "medium",
    match: [["tea"]], exclude: ["sweet tea", "boba", "bubble", "matcha", "latte", "iced tea", "arizona", "chai"], unitWords: ["cup", "cups", "mug", "mugs"],
  },
  {
    id: "water", name: "Water", kind: "generic", isBeverage: true,
    serving: { amount: 8, unit: "fl oz", ml: 237, label: "8 fl oz (237 ml)" },
    perServing: { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, sodium: 0, ...beverage(237) },
    sourceType: "reference", source: "water", confidence: "exact",
    match: [["water"]], exclude: ["vitaminwater", "smartwater", "coconut", "sparkling", "tonic", "melon", "flavored", "watermelon"], unitWords: ["glass", "glasses", "cup", "cups", "bottle", "bottles"],
  },
  {
    id: "rice-white-cooked", name: "White rice, cooked", kind: "generic",
    serving: { amount: 1, unit: "cup", grams: 158, label: "1 cup cooked (158 g)" },
    perServing: { calories: 205, protein: 4.3, carbs: 44.5, fat: 0.4, saturatedFat: 0.1, fiber: 0.6, sugar: 0.1, sodium: 2, potassium: 55, calcium: 16, iron: 1.9 },
    sourceType: "reference", source: "standard nutrition reference: cooked white rice", confidence: "medium",
    match: [["rice"], ["white", "rice"]], exclude: ["brown", "fried", "chipotle", "krispies", "cake", "cakes", "pudding", "wild", "cauliflower", "jasmine", "basmati", "sushi"], unitWords: ["cup", "cups", "bowl", "bowls", "scoop", "scoops"],
  },
  {
    id: "rice-brown-cooked", name: "Brown rice, cooked", kind: "generic",
    serving: { amount: 1, unit: "cup", grams: 195, label: "1 cup cooked (195 g)" },
    perServing: { calories: 216, protein: 5, carbs: 44.8, fat: 1.8, saturatedFat: 0.4, fiber: 3.5, sugar: 0.7, sodium: 10, potassium: 84, calcium: 20, iron: 0.8 },
    sourceType: "reference", source: "standard nutrition reference: cooked brown rice", confidence: "medium",
    match: [["brown", "rice"]], exclude: ["chipotle", "fried"], unitWords: ["cup", "cups", "bowl", "bowls", "scoop", "scoops"],
  },
  {
    id: "chicken-breast", name: "Chicken breast, cooked", kind: "generic",
    serving: { amount: 3, unit: "oz", grams: 85, label: "3 oz cooked (85 g)" },
    perServing: { calories: 140, protein: 26, carbs: 0, fat: 3, saturatedFat: 0.9, fiber: 0, sugar: 0, sodium: 63, cholesterol: 73, potassium: 220, iron: 0.4 },
    sourceType: "reference", source: "standard nutrition reference: cooked chicken breast", confidence: "medium",
    match: [["chicken", "breast"], ["grilled", "chicken"]], exclude: ["sandwich", "chipotle", "nuggets", "mcnuggets", "wings", "fried", "burrito", "bowl", "salad", "soup", "shawarma", "tenders"],
  },
  {
    id: "peanut-butter", name: "Peanut butter", kind: "generic",
    serving: { amount: 2, unit: "tbsp", grams: 32, label: "2 tbsp (32 g)" },
    perServing: { calories: 190, protein: 7, carbs: 7, fat: 16, saturatedFat: 3, fiber: 2, sugar: 3, sodium: 140, potassium: 200 },
    sourceType: "reference", source: "standard nutrition reference: peanut butter", confidence: "medium",
    match: [["peanut", "butter"]], exclude: ["jif", "skippy", "cup", "cups", "reese", "cookie", "sandwich", "pb&j", "jelly"], unitWords: ["tbsp", "tablespoon", "tablespoons"],
  },
  {
    id: "greek-yogurt-plain", name: "Greek yogurt, plain nonfat", kind: "generic",
    serving: { amount: 1, unit: "container", grams: 170, label: "6 oz container (170 g)" },
    perServing: { calories: 100, protein: 17, carbs: 6, fat: 0.7, saturatedFat: 0.3, fiber: 0, sugar: 6, sodium: 61, calcium: 187, potassium: 240 },
    sourceType: "reference", source: "standard nutrition reference: plain nonfat Greek yogurt", confidence: "medium",
    match: [["greek", "yogurt"], ["greek", "yoghurt"]], exclude: ["chobani", "oikos", "fage", "smoothie", "parfait"], unitWords: ["container", "containers", "cup", "cups"],
  },
  {
    id: "cereal-generic", name: "Cereal", kind: "generic",
    serving: { amount: 1, unit: "cup", grams: 30, label: "1 cup (≈30 g)" },
    perServing: { calories: 110, protein: 2, carbs: 24, fat: 1, fiber: 2, sugar: 9, sodium: 160 },
    sourceType: "reference", source: "standard nutrition reference: ready-to-eat cereal (average)", confidence: "low",
    match: [["cereal"]], exclude: ["cheerios", "bar", "bars", "oatmeal"], unitWords: ["cup", "cups", "bowl", "bowls"],
  },
  {
    id: "pizza-cheese-slice", name: "Cheese pizza", kind: "generic",
    serving: { amount: 1, unit: "slice", grams: 107, label: "1 slice (⅛ of 14-inch)" },
    perServing: { calories: 285, protein: 12, carbs: 36, fat: 10, saturatedFat: 4.5, fiber: 2.5, sugar: 3.8, sodium: 640, calcium: 200 },
    sourceType: "reference", source: "standard nutrition reference: cheese pizza, regular crust", confidence: "medium",
    match: [["pizza"]], exclude: ["domino", "pizza hut", "papa john", "little caesars", "pepperoni", "roll", "rolls", "bagel", "cauliflower"], unitWords: ["slice", "slices", "piece", "pieces"],
  },
  {
    id: "beer-regular", name: "Beer, regular", kind: "generic", isBeverage: true,
    serving: { amount: 12, unit: "fl oz", ml: 355, label: "12 fl oz (355 ml)" },
    perServing: { calories: 153, protein: 1.6, carbs: 12.6, fat: 0, sugar: 0, sodium: 14, potassium: 96, ...beverage(355) },
    sourceType: "reference", source: "standard nutrition reference: regular beer", confidence: "medium",
    match: [["beer"], ["beers"]], exclude: ["light", "lite", "root", "ginger", "non-alcoholic"], unitWords: ["can", "cans", "bottle", "bottles", "beer", "beers", "pint", "pints"],
  },
  {
    id: "wine-red", name: "Wine, red", kind: "generic", isBeverage: true,
    serving: { amount: 5, unit: "fl oz", ml: 148, label: "5 fl oz (148 ml)" },
    perServing: { calories: 125, protein: 0.1, carbs: 3.8, fat: 0, sugar: 0.9, sodium: 6, potassium: 187, ...beverage(148) },
    sourceType: "reference", source: "standard nutrition reference: red wine", confidence: "medium",
    match: [["wine"], ["red", "wine"], ["white", "wine"]], exclude: ["cooler", "vinegar"], unitWords: ["glass", "glasses"],
  },
  {
    id: "protein-shake-generic", name: "Protein shake", kind: "generic", isBeverage: true,
    serving: { amount: 1, unit: "shake", ml: 330, label: "1 shake" },
    perServing: { calories: 200, protein: 25, carbs: 8, fat: 5, sugar: 3, sodium: 200, ...beverage(330) },
    sourceType: "reference", source: "standard nutrition reference: protein shake (average)", confidence: "low",
    match: [["protein", "shake"]], exclude: ["premier", "fairlife", "core power", "muscle milk", "orgain", "ensure", "boost"], unitWords: ["shake", "shakes", "scoop", "scoops"],
  },

  // ── Branded products (manufacturer labels) ─────────────────────────────────
  {
    id: "coca-cola-12oz", name: "Coca-Cola Classic", brand: "Coca-Cola", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 355, label: "12 fl oz can (355 ml)" },
    perServing: { calories: 140, protein: 0, carbs: 39, fat: 0, sugar: 39, addedSugar: 39, sodium: 45, caffeine: 34, ...beverage(355) },
    sourceType: "manufacturer", source: "Coca-Cola Classic 12 fl oz label", confidence: "exact",
    match: [["coke"], ["coca-cola"], ["coca", "cola"], ["cocacola"]], exclude: ["diet", "zero", "cherry", "vanilla", "rum", "jack"], unitWords: ["can", "cans", "coke", "cokes"],
  },
  {
    id: "diet-coke-12oz", name: "Diet Coke", brand: "Coca-Cola", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 355, label: "12 fl oz can (355 ml)" },
    perServing: { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, sodium: 40, caffeine: 46, ...beverage(355) },
    sourceType: "manufacturer", source: "Diet Coke 12 fl oz label", confidence: "exact",
    match: [["diet", "coke"], ["diet", "coca-cola"], ["diet", "coca", "cola"]], unitWords: ["can", "cans"],
  },
  {
    id: "coke-zero-12oz", name: "Coca-Cola Zero Sugar", brand: "Coca-Cola", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 355, label: "12 fl oz can (355 ml)" },
    perServing: { calories: 0, protein: 0, carbs: 0, fat: 0, sugar: 0, sodium: 40, caffeine: 34, ...beverage(355) },
    sourceType: "manufacturer", source: "Coca-Cola Zero Sugar 12 fl oz label", confidence: "exact",
    match: [["coke", "zero"], ["coca-cola", "zero"], ["coca", "cola", "zero"], ["zero", "sugar", "coke"]], unitWords: ["can", "cans"],
  },
  {
    id: "pepsi-12oz", name: "Pepsi", brand: "Pepsi", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 355, label: "12 fl oz can (355 ml)" },
    perServing: { calories: 150, protein: 0, carbs: 41, fat: 0, sugar: 41, addedSugar: 41, sodium: 30, caffeine: 38, ...beverage(355) },
    sourceType: "manufacturer", source: "Pepsi 12 fl oz label", confidence: "exact",
    match: [["pepsi"]], exclude: ["diet", "zero", "max"], unitWords: ["can", "cans"],
  },
  {
    id: "sprite-12oz", name: "Sprite", brand: "Coca-Cola", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 355, label: "12 fl oz can (355 ml)" },
    perServing: { calories: 140, protein: 0, carbs: 38, fat: 0, sugar: 38, addedSugar: 38, sodium: 65, caffeine: 0, ...beverage(355) },
    sourceType: "manufacturer", source: "Sprite 12 fl oz label", confidence: "exact",
    match: [["sprite"]], exclude: ["zero", "diet"], unitWords: ["can", "cans"],
  },
  {
    id: "dr-pepper-12oz", name: "Dr Pepper", brand: "Dr Pepper", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 355, label: "12 fl oz can (355 ml)" },
    perServing: { calories: 150, protein: 0, carbs: 40, fat: 0, sugar: 40, addedSugar: 40, sodium: 55, caffeine: 41, ...beverage(355) },
    sourceType: "manufacturer", source: "Dr Pepper 12 fl oz label", confidence: "exact",
    match: [["dr", "pepper"], ["dr.", "pepper"]], exclude: ["diet", "zero"], unitWords: ["can", "cans"],
  },
  {
    id: "mountain-dew-12oz", name: "Mountain Dew", brand: "Mountain Dew", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 355, label: "12 fl oz can (355 ml)" },
    perServing: { calories: 170, protein: 0, carbs: 46, fat: 0, sugar: 46, addedSugar: 46, sodium: 60, caffeine: 54, ...beverage(355) },
    sourceType: "manufacturer", source: "Mountain Dew 12 fl oz label", confidence: "exact",
    match: [["mountain", "dew"], ["mtn", "dew"]], exclude: ["diet", "zero"], unitWords: ["can", "cans"],
  },
  {
    id: "monster-16oz", name: "Monster Energy (original)", brand: "Monster", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 473, label: "16 fl oz can (473 ml)" },
    perServing: { calories: 210, protein: 0, carbs: 54, fat: 0, sugar: 54, addedSugar: 54, sodium: 370, caffeine: 160, ...beverage(473) },
    sourceType: "manufacturer", source: "Monster Energy 16 fl oz label", confidence: "exact",
    match: [["monster"]], exclude: ["zero", "ultra", "rehab", "java", "sugar free", "sugar-free"], unitWords: ["can", "cans", "monster", "monsters"],
  },
  {
    id: "monster-zero-ultra-16oz", name: "Monster Zero Ultra", brand: "Monster", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 473, label: "16 fl oz can (473 ml)" },
    perServing: { calories: 10, protein: 0, carbs: 2, fat: 0, sugar: 0, sodium: 370, caffeine: 140, ...beverage(473) },
    sourceType: "manufacturer", source: "Monster Zero Ultra 16 fl oz label", confidence: "exact",
    match: [["monster", "ultra"], ["monster", "zero"], ["zero", "ultra"]], unitWords: ["can", "cans"],
  },
  {
    id: "red-bull-8oz", name: "Red Bull Energy Drink", brand: "Red Bull", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 250, label: "8.4 fl oz can (250 ml)" },
    perServing: { calories: 110, protein: 0, carbs: 28, fat: 0, sugar: 27, addedSugar: 27, sodium: 105, caffeine: 80, ...beverage(250) },
    sourceType: "manufacturer", source: "Red Bull 8.4 fl oz label", confidence: "exact",
    match: [["red", "bull"], ["redbull"]], exclude: ["sugar free", "sugarfree", "sugar-free", "zero"], unitWords: ["can", "cans"],
  },
  {
    id: "celsius-12oz", name: "Celsius Energy Drink", brand: "Celsius", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "can", ml: 355, label: "12 fl oz can (355 ml)" },
    perServing: { calories: 10, protein: 0, carbs: 2, fat: 0, sugar: 0, sodium: 0, caffeine: 200, vitaminC: 60, ...beverage(355) },
    sourceType: "manufacturer", source: "Celsius 12 fl oz label (all Originals flavors)", confidence: "exact",
    match: [["celsius"]], exclude: ["heat", "essentials", "on-the-go", "powder"], unitWords: ["can", "cans"],
  },
  {
    id: "gatorade-20oz", name: "Gatorade Thirst Quencher", brand: "Gatorade", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "bottle", ml: 591, label: "20 fl oz bottle (591 ml)" },
    perServing: { calories: 140, protein: 0, carbs: 36, fat: 0, sugar: 34, addedSugar: 34, sodium: 270, potassium: 80, ...beverage(591) },
    sourceType: "manufacturer", source: "Gatorade Thirst Quencher 20 fl oz label", confidence: "exact",
    match: [["gatorade"]], exclude: ["zero", "g2", "fit", "protein"], unitWords: ["bottle", "bottles"],
  },
  {
    id: "starbucks-grande-latte", name: "Starbucks Caffè Latte, grande (2% milk)", brand: "Starbucks", kind: "restaurant", isBeverage: true,
    serving: { amount: 1, unit: "grande", ml: 473, label: "grande, 16 fl oz" },
    perServing: { calories: 190, protein: 13, carbs: 19, fat: 7, saturatedFat: 4.5, fiber: 0, sugar: 18, sodium: 170, caffeine: 150, calcium: 440, ...beverage(473) },
    sourceType: "restaurant", source: "Starbucks menu nutrition: grande Caffè Latte (2%)", confidence: "high",
    match: [["grande", "latte"], ["starbucks", "latte"]], exclude: ["oat", "almond", "soy", "pumpkin", "chai", "matcha", "iced", "venti", "tall", "short"],
  },
  {
    id: "jif-creamy-pb", name: "Jif Creamy Peanut Butter", brand: "Jif", kind: "branded",
    serving: { amount: 2, unit: "tbsp", grams: 33, label: "2 tbsp (33 g)" },
    perServing: { calories: 190, protein: 7, carbs: 8, fat: 16, saturatedFat: 3, fiber: 2, sugar: 3, addedSugar: 2, sodium: 140, potassium: 190 },
    sourceType: "manufacturer", source: "Jif Creamy Peanut Butter label", confidence: "exact",
    match: [["jif"]], exclude: ["natural", "reduced", "crunchy", "extra", "whips", "power"], unitWords: ["tbsp", "tablespoon", "tablespoons"],
  },
  {
    id: "honey-nut-cheerios", name: "Honey Nut Cheerios", brand: "General Mills", kind: "branded",
    serving: { amount: 1, unit: "cup", grams: 37, label: "1 cup (37 g)" },
    perServing: { calories: 140, protein: 3, carbs: 30, fat: 2, saturatedFat: 0, fiber: 3, sugar: 12, addedSugar: 12, sodium: 210, calcium: 130, iron: 12.6 },
    sourceType: "manufacturer", source: "Honey Nut Cheerios label (1 cup serving)", confidence: "exact",
    match: [["honey", "nut", "cheerios"], ["honey", "nut", "cheerio"], ["hnc"]], unitWords: ["cup", "cups", "bowl", "bowls"],
  },
  {
    id: "special-k-red-berries", name: "Kellogg's Special K Red Berries", brand: "Kellogg's", kind: "branded",
    serving: { amount: 1, unit: "cup", grams: 39, label: "1 cup (39 g)" },
    perServing: { calories: 140, protein: 3, carbs: 34, fat: 0.5 },
    sourceType: "manufacturer", source: "Kellogg's Special K Red Berries label (1 cup, 39 g)", confidence: "exact",
    match: [["special", "k", "red", "berries"], ["special", "k", "berries"], ["special", "k", "strawberr"]], unitWords: ["cup", "cups", "bowl", "bowls"],
  },
  {
    id: "cheerios-original", name: "Cheerios (original)", brand: "General Mills", kind: "branded",
    serving: { amount: 1.5, unit: "cup", grams: 39, label: "1½ cups (39 g)" },
    perServing: { calories: 140, protein: 5, carbs: 29, fat: 2.5, saturatedFat: 0.5, fiber: 4, sugar: 2, addedSugar: 2, sodium: 190, calcium: 130, iron: 12.6 },
    sourceType: "manufacturer", source: "Cheerios label (1½ cup serving)", confidence: "exact",
    match: [["cheerios"]], exclude: ["honey", "nut", "frosted", "chocolate", "apple", "multigrain", "oat crunch"], unitWords: ["cup", "cups", "bowl", "bowls"],
  },
  {
    id: "fairlife-2pct", name: "Fairlife 2% Ultra-Filtered Milk", brand: "Fairlife", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "cup", ml: 240, grams: 240, label: "1 cup (240 ml)" },
    perServing: { calories: 120, protein: 13, carbs: 6, fat: 4.5, saturatedFat: 3, fiber: 0, sugar: 6, addedSugar: 0, sodium: 120, cholesterol: 20, potassium: 400, calcium: 380, vitaminD: 5, ...beverage(240) },
    sourceType: "manufacturer", source: "Fairlife 2% Ultra-Filtered Milk label", confidence: "exact",
    match: [["fairlife", "2%"], ["fairlife", "2", "percent"], ["fairlife", "reduced", "fat"], ["fairlife", "milk"], ["fairlife"]], exclude: ["whole", "skim", "fat free", "chocolate", "core power", "nutrition plan"], unitWords: ["cup", "cups", "glass", "glasses"],
  },
  {
    id: "core-power-26", name: "Fairlife Core Power 26g Protein Shake", brand: "Fairlife", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "bottle", ml: 414, label: "14 fl oz bottle (414 ml)" },
    perServing: { calories: 170, protein: 26, carbs: 7, fat: 4.5, saturatedFat: 3, sugar: 5, addedSugar: 0, sodium: 220, calcium: 650, ...beverage(414) },
    sourceType: "manufacturer", source: "Core Power 26g label", confidence: "high",
    match: [["core", "power"]], exclude: ["elite", "42"], unitWords: ["bottle", "bottles"],
  },
  {
    id: "premier-protein-shake", name: "Premier Protein Shake", brand: "Premier Protein", kind: "branded", isBeverage: true,
    serving: { amount: 1, unit: "shake", ml: 325, label: "11 fl oz carton (325 ml)" },
    perServing: { calories: 160, protein: 30, carbs: 4, fat: 3, saturatedFat: 1, fiber: 1, sugar: 1, addedSugar: 0, sodium: 230, potassium: 500, calcium: 650, ...beverage(325) },
    sourceType: "manufacturer", source: "Premier Protein 30g shake label", confidence: "high",
    match: [["premier", "protein"], ["premier", "shake"]], exclude: ["cafe", "café", "clear", "powder"], unitWords: ["shake", "shakes", "carton", "cartons", "bottle", "bottles"],
  },
  {
    id: "quaker-maple-brown-sugar", name: "Quaker Instant Oatmeal Maple & Brown Sugar", brand: "Quaker", kind: "branded",
    serving: { amount: 1, unit: "packet", grams: 43, label: "1 packet (43 g)" },
    perServing: { calories: 160, protein: 4, carbs: 33, fat: 2, saturatedFat: 0.5, fiber: 3, sugar: 12, addedSugar: 12, sodium: 260, iron: 7.2 },
    sourceType: "manufacturer", source: "Quaker Instant Oatmeal Maple & Brown Sugar label", confidence: "exact",
    match: [["quaker", "maple"], ["maple", "brown", "sugar", "oatmeal"], ["maple", "brown", "sugar", "instant"]], exclude: ["lower sugar", "protein", "select starts"], unitWords: ["packet", "packets", "pack", "packs", "pouch", "pouches"],
  },
  {
    id: "quaker-apples-cinnamon", name: "Quaker Instant Oatmeal Apples & Cinnamon", brand: "Quaker", kind: "branded",
    serving: { amount: 1, unit: "packet", grams: 35, label: "1 packet (35 g)" },
    perServing: { calories: 130, protein: 3, carbs: 27, fat: 1.5, saturatedFat: 0, fiber: 3, sugar: 11, addedSugar: 10, sodium: 160 },
    sourceType: "manufacturer", source: "Quaker Instant Oatmeal Apples & Cinnamon label", confidence: "high",
    match: [["quaker", "apple"], ["quaker", "apples"], ["apples", "cinnamon", "oatmeal"], ["apple", "cinnamon", "oatmeal"]], unitWords: ["packet", "packets", "pack", "packs"],
  },
  {
    id: "quaker-original", name: "Quaker Instant Oatmeal Original", brand: "Quaker", kind: "branded",
    serving: { amount: 1, unit: "packet", grams: 28, label: "1 packet (28 g)" },
    perServing: { calories: 100, protein: 4, carbs: 19, fat: 2, saturatedFat: 0.5, fiber: 3, sugar: 0, addedSugar: 0, sodium: 75, iron: 7.2 },
    sourceType: "manufacturer", source: "Quaker Instant Oatmeal Original label", confidence: "high",
    match: [["quaker", "original"], ["quaker", "plain"], ["quaker", "instant", "oatmeal"], ["quaker", "oatmeal"]], exclude: ["maple", "brown sugar", "apple", "cinnamon", "honey", "almond", "almonds", "peach", "strawberr", "raisin", "protein", "chocolate", "blueberr", "banana"], unitWords: ["packet", "packets", "pack", "packs"],
  },
  {
    id: "oikos-triple-zero", name: "Oikos Triple Zero Greek Yogurt", brand: "Oikos", kind: "branded",
    serving: { amount: 1, unit: "container", grams: 150, label: "5.3 oz container (150 g)" },
    perServing: { calories: 90, protein: 15, carbs: 7, fat: 0, saturatedFat: 0, fiber: 0, sugar: 6, addedSugar: 0, sodium: 65, calcium: 180, potassium: 190 },
    sourceType: "manufacturer", source: "Oikos Triple Zero label", confidence: "high",
    match: [["oikos", "triple", "zero"], ["triple", "zero"], ["oikos"]], unitWords: ["container", "containers", "cup", "cups"],
  },
  {
    id: "clif-chocolate-chip", name: "Clif Bar Chocolate Chip", brand: "Clif", kind: "branded",
    serving: { amount: 1, unit: "bar", grams: 68, label: "1 bar (68 g)" },
    perServing: { calories: 250, protein: 10, carbs: 45, fat: 5, saturatedFat: 1.5, fiber: 5, sugar: 17, addedSugar: 16, sodium: 150, potassium: 200 },
    sourceType: "manufacturer", source: "Clif Bar Chocolate Chip label", confidence: "high",
    match: [["clif", "bar"], ["clif"]], exclude: ["builder", "builders", "kid", "zbar", "nut butter", "thins", "bloks"], unitWords: ["bar", "bars"],
  },
  {
    id: "quest-bar", name: "Quest Protein Bar", brand: "Quest", kind: "branded",
    serving: { amount: 1, unit: "bar", grams: 60, label: "1 bar (60 g)" },
    perServing: { calories: 190, protein: 21, carbs: 21, fat: 9, saturatedFat: 3, fiber: 14, sugar: 1, addedSugar: 0, sodium: 240, potassium: 130 },
    sourceType: "manufacturer", source: "Quest Bar label (Chocolate Chip Cookie Dough)", confidence: "high",
    match: [["quest", "bar"], ["quest", "protein"]], exclude: ["chips", "cookie", "pizza", "hero", "mini"], unitWords: ["bar", "bars"],
  },
  {
    id: "rxbar", name: "RXBAR", brand: "RXBAR", kind: "branded",
    serving: { amount: 1, unit: "bar", grams: 52, label: "1 bar (52 g)" },
    perServing: { calories: 210, protein: 12, carbs: 24, fat: 9, saturatedFat: 2, fiber: 5, sugar: 13, addedSugar: 0, sodium: 140 },
    sourceType: "manufacturer", source: "RXBAR label (Chocolate Sea Salt)", confidence: "high",
    match: [["rxbar"], ["rx", "bar"]], exclude: ["kids", "minis", "a.m."], unitWords: ["bar", "bars"],
  },
  {
    id: "kind-dark-choc-nuts", name: "KIND Dark Chocolate Nuts & Sea Salt", brand: "KIND", kind: "branded",
    serving: { amount: 1, unit: "bar", grams: 40, label: "1 bar (40 g)" },
    perServing: { calories: 180, protein: 6, carbs: 16, fat: 15, saturatedFat: 3.5, fiber: 7, sugar: 5, addedSugar: 4, sodium: 140 },
    sourceType: "manufacturer", source: "KIND Dark Chocolate Nuts & Sea Salt label", confidence: "high",
    match: [["kind", "bar"], ["kind", "dark", "chocolate"]], exclude: ["minis", "breakfast", "protein", "frozen", "clusters"], unitWords: ["bar", "bars"],
  },
  {
    id: "nature-valley-oats-honey", name: "Nature Valley Crunchy Oats 'n Honey", brand: "Nature Valley", kind: "branded",
    serving: { amount: 2, unit: "bar", grams: 42, label: "1 pouch, 2 bars (42 g)" },
    perServing: { calories: 190, protein: 3, carbs: 29, fat: 7, saturatedFat: 1, fiber: 2, sugar: 11, addedSugar: 11, sodium: 160 },
    sourceType: "manufacturer", source: "Nature Valley Crunchy Oats 'n Honey label", confidence: "high",
    match: [["nature", "valley"]], exclude: ["protein", "sweet", "salty", "biscuit", "soft"], unitWords: ["bar", "bars"],
  },
  {
    id: "oreo", name: "Oreo", brand: "Nabisco", kind: "branded",
    serving: { amount: 3, unit: "cookie", grams: 34, label: "3 cookies (34 g)" },
    perServing: { calories: 160, protein: 1, carbs: 25, fat: 7, saturatedFat: 2, fiber: 1, sugar: 14, addedSugar: 14, sodium: 135 },
    sourceType: "manufacturer", source: "Oreo label (3 cookies)", confidence: "high",
    match: [["oreo"], ["oreos"]], exclude: ["double", "thins", "golden", "mega", "mcflurry", "blizzard", "shake"], unitWords: ["cookie", "cookies", "oreo", "oreos"],
  },
  {
    id: "snickers", name: "Snickers bar", brand: "Mars", kind: "branded",
    serving: { amount: 1, unit: "bar", grams: 52.7, label: "1 bar (1.86 oz, 52.7 g)" },
    perServing: { calories: 250, protein: 4, carbs: 33, fat: 12, saturatedFat: 4.5, fiber: 1, sugar: 27, addedSugar: 26, sodium: 120 },
    sourceType: "manufacturer", source: "Snickers 1.86 oz label", confidence: "exact",
    match: [["snickers"]], exclude: ["fun size", "mini", "minis", "ice cream", "king size", "almond"], unitWords: ["bar", "bars"],
  },
  {
    id: "reeses-cups", name: "Reese's Peanut Butter Cups", brand: "Hershey's", kind: "branded",
    serving: { amount: 2, unit: "cup", grams: 42, label: "1 package, 2 cups (42 g)" },
    perServing: { calories: 210, protein: 5, carbs: 24, fat: 13, saturatedFat: 4.5, fiber: 1, sugar: 22, addedSugar: 21, sodium: 150 },
    sourceType: "manufacturer", source: "Reese's Peanut Butter Cups label (2 cups)", confidence: "high",
    match: [["reese"], ["reese's"], ["reeses"]], exclude: ["pieces", "puffs", "big cup", "miniatures", "minis", "sticks", "fast break"], unitWords: ["cup", "cups"],
  },
  {
    id: "lays-classic", name: "Lay's Classic Potato Chips", brand: "Lay's", kind: "branded",
    serving: { amount: 1, unit: "oz", grams: 28, label: "1 oz (28 g, about 15 chips)" },
    perServing: { calories: 160, protein: 2, carbs: 15, fat: 10, saturatedFat: 1.5, fiber: 1, sugar: 0.5, addedSugar: 0, sodium: 170, potassium: 350 },
    sourceType: "manufacturer", source: "Lay's Classic label", confidence: "exact",
    match: [["lay's"], ["lays"]], exclude: ["baked", "wavy", "kettle", "bbq", "barbecue", "sour cream", "stax", "poppables"],
  },
  {
    id: "doritos-nacho", name: "Doritos Nacho Cheese", brand: "Doritos", kind: "branded",
    serving: { amount: 1, unit: "oz", grams: 28, label: "1 oz (28 g, about 12 chips)" },
    perServing: { calories: 150, protein: 2, carbs: 18, fat: 8, saturatedFat: 1, fiber: 1, sugar: 1, addedSugar: 0, sodium: 210 },
    sourceType: "manufacturer", source: "Doritos Nacho Cheese label", confidence: "exact",
    match: [["doritos"]], exclude: ["cool ranch", "spicy", "flamin", "sweet chili", "baked"],
  },

  // ── Restaurant menu items ──────────────────────────────────────────────────
  {
    id: "mcd-big-mac", name: "Big Mac", brand: "McDonald's", kind: "restaurant",
    serving: { amount: 1, unit: "sandwich", grams: 219, label: "1 Big Mac" },
    perServing: { calories: 590, protein: 25, carbs: 46, fat: 34, saturatedFat: 11, fiber: 3, sugar: 9, addedSugar: 7, sodium: 1050, cholesterol: 85, calcium: 250, iron: 4.5 },
    sourceType: "restaurant", source: "McDonald's US menu nutrition: Big Mac", confidence: "high",
    match: [["big", "mac"], ["bigmac"]], exclude: ["meal", "combo"],
  },
  {
    id: "mcd-fries-small", name: "McDonald's French Fries, small", brand: "McDonald's", kind: "restaurant",
    serving: { amount: 1, unit: "small fries", grams: 71, label: "small fries (71 g)" },
    perServing: { calories: 230, protein: 3, carbs: 31, fat: 11, saturatedFat: 1.5, fiber: 3, sugar: 0, sodium: 190, potassium: 420 },
    sourceType: "restaurant", source: "McDonald's US menu nutrition: small fries", confidence: "high",
    match: [["small", "fries"], ["small", "fry"]],
  },
  {
    id: "mcd-fries-medium", name: "McDonald's French Fries, medium", brand: "McDonald's", kind: "restaurant",
    serving: { amount: 1, unit: "medium fries", grams: 111, label: "medium fries (111 g)" },
    perServing: { calories: 320, protein: 4, carbs: 43, fat: 15, saturatedFat: 2, fiber: 4, sugar: 0, sodium: 260, potassium: 650 },
    sourceType: "restaurant", source: "McDonald's US menu nutrition: medium fries", confidence: "high",
    match: [["medium", "fries"], ["medium", "fry"], ["mcdonald's", "fries"], ["mcdonalds", "fries"]], exclude: ["small", "large"],
  },
  {
    id: "mcd-fries-large", name: "McDonald's French Fries, large", brand: "McDonald's", kind: "restaurant",
    serving: { amount: 1, unit: "large fries", grams: 150, label: "large fries (150 g)" },
    perServing: { calories: 480, protein: 6, carbs: 65, fat: 23, saturatedFat: 3, fiber: 6, sugar: 0, sodium: 400, potassium: 900 },
    sourceType: "restaurant", source: "McDonald's US menu nutrition: large fries", confidence: "high",
    match: [["large", "fries"], ["large", "fry"]],
  },
  {
    id: "mcd-cheeseburger", name: "McDonald's Cheeseburger", brand: "McDonald's", kind: "restaurant",
    serving: { amount: 1, unit: "sandwich", grams: 119, label: "1 cheeseburger" },
    perServing: { calories: 300, protein: 15, carbs: 32, fat: 13, saturatedFat: 6, fiber: 2, sugar: 7, sodium: 720, cholesterol: 40 },
    sourceType: "restaurant", source: "McDonald's US menu nutrition: Cheeseburger", confidence: "high",
    match: [["mcdonald's", "cheeseburger"], ["mcdonalds", "cheeseburger"], ["mcdouble"]],
  },
  {
    id: "mcd-qpc", name: "Quarter Pounder with Cheese", brand: "McDonald's", kind: "restaurant",
    serving: { amount: 1, unit: "sandwich", grams: 202, label: "1 Quarter Pounder with Cheese" },
    perServing: { calories: 520, protein: 30, carbs: 42, fat: 26, saturatedFat: 12, fiber: 2, sugar: 10, sodium: 1140, cholesterol: 95 },
    sourceType: "restaurant", source: "McDonald's US menu nutrition: Quarter Pounder with Cheese", confidence: "high",
    match: [["quarter", "pounder"]], exclude: ["deluxe", "double", "bacon"],
  },
  {
    id: "mcd-mcchicken", name: "McChicken", brand: "McDonald's", kind: "restaurant",
    serving: { amount: 1, unit: "sandwich", grams: 143, label: "1 McChicken" },
    perServing: { calories: 400, protein: 14, carbs: 39, fat: 21, saturatedFat: 3.5, fiber: 2, sugar: 5, sodium: 560, cholesterol: 35 },
    sourceType: "restaurant", source: "McDonald's US menu nutrition: McChicken", confidence: "high",
    match: [["mcchicken"]], exclude: ["spicy", "deluxe"],
  },
  {
    id: "mcd-nuggets-10", name: "Chicken McNuggets", brand: "McDonald's", kind: "restaurant",
    serving: { amount: 10, unit: "piece", grams: 162, label: "10 piece McNuggets" },
    perServing: { calories: 410, protein: 23, carbs: 25, fat: 24, saturatedFat: 4, fiber: 1, sugar: 0, sodium: 750, cholesterol: 65 },
    sourceType: "restaurant", source: "McDonald's US menu nutrition: 10 pc McNuggets", confidence: "high",
    match: [["mcnuggets"], ["mcnugget"], ["chicken", "nuggets", "mcdonald's"], ["chicken", "nuggets", "mcdonalds"]], unitWords: ["piece", "pieces", "pc", "nugget", "nuggets", "mcnugget", "mcnuggets"],
  },
  // Chipotle components (published per-ingredient nutrition)
  { id: "chipotle-chicken", name: "Chipotle chicken", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 180, protein: 32, carbs: 0, fat: 7, saturatedFat: 2.5, fiber: 0, sugar: 0, sodium: 310, cholesterol: 125 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: chicken", confidence: "high", match: [["chipotle", "chicken"]] },
  { id: "chipotle-steak", name: "Chipotle steak", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 150, protein: 21, carbs: 1, fat: 6, saturatedFat: 2.5, fiber: 0, sugar: 0, sodium: 330, cholesterol: 80 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: steak", confidence: "high", match: [["chipotle", "steak"]] },
  { id: "chipotle-carnitas", name: "Chipotle carnitas", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 210, protein: 23, carbs: 0, fat: 12, saturatedFat: 7, fiber: 0, sugar: 0, sodium: 450, cholesterol: 65 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: carnitas", confidence: "high", match: [["chipotle", "carnitas"]] },
  { id: "chipotle-barbacoa", name: "Chipotle barbacoa", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 170, protein: 24, carbs: 2, fat: 7, saturatedFat: 2.5, fiber: 1, sugar: 0, sodium: 530, cholesterol: 65 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: barbacoa", confidence: "high", match: [["chipotle", "barbacoa"]] },
  { id: "chipotle-sofritas", name: "Chipotle sofritas", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 150, protein: 8, carbs: 9, fat: 10, saturatedFat: 1.5, fiber: 4, sugar: 5, sodium: 560, cholesterol: 0 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: sofritas", confidence: "high", match: [["chipotle", "sofritas"], ["sofritas"]] },
  { id: "chipotle-white-rice", name: "Chipotle cilantro-lime white rice", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 210, protein: 4, carbs: 40, fat: 4, saturatedFat: 0, fiber: 1, sugar: 0, sodium: 350 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: white rice", confidence: "high", match: [["chipotle", "white", "rice"], ["cilantro", "lime", "rice"]] },
  { id: "chipotle-brown-rice", name: "Chipotle cilantro-lime brown rice", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 210, protein: 4, carbs: 36, fat: 6, saturatedFat: 1, fiber: 3, sugar: 0, sodium: 190 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: brown rice", confidence: "high", match: [["chipotle", "brown", "rice"]] },
  { id: "chipotle-black-beans", name: "Chipotle black beans", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 130, protein: 8, carbs: 22, fat: 1.5, saturatedFat: 0, fiber: 7, sugar: 2, sodium: 210 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: black beans", confidence: "high", match: [["chipotle", "black", "beans"]] },
  { id: "chipotle-pinto-beans", name: "Chipotle pinto beans", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 130, protein: 8, carbs: 21, fat: 1.5, saturatedFat: 0, fiber: 8, sugar: 1, sodium: 210 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: pinto beans", confidence: "high", match: [["chipotle", "pinto", "beans"]] },
  { id: "chipotle-cheese", name: "Chipotle cheese", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 28, label: "1 serving (1 oz)" }, perServing: { calories: 110, protein: 6, carbs: 1, fat: 8, saturatedFat: 5, fiber: 0, sugar: 0, sodium: 190, cholesterol: 30, calcium: 200 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: cheese", confidence: "high", match: [["chipotle", "cheese"]], exclude: ["queso"] },
  { id: "chipotle-sour-cream", name: "Chipotle sour cream", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 57, label: "1 serving (2 oz)" }, perServing: { calories: 110, protein: 2, carbs: 2, fat: 9, saturatedFat: 7, fiber: 0, sugar: 2, sodium: 30, cholesterol: 40 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: sour cream", confidence: "high", match: [["chipotle", "sour", "cream"]] },
  { id: "chipotle-guac", name: "Chipotle guacamole", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 230, protein: 2, carbs: 8, fat: 22, saturatedFat: 3.5, fiber: 6, sugar: 1, sodium: 370 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: guacamole", confidence: "high", match: [["chipotle", "guac"], ["chipotle", "guacamole"]] },
  { id: "chipotle-salsa-tomato", name: "Chipotle fresh tomato salsa", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 113, label: "1 serving (4 oz)" }, perServing: { calories: 25, protein: 0, carbs: 4, fat: 0, fiber: 1, sugar: 1, sodium: 550 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: fresh tomato salsa", confidence: "high", match: [["chipotle", "tomato", "salsa"], ["chipotle", "pico"], ["chipotle", "mild", "salsa"]] },
  { id: "chipotle-lettuce", name: "Chipotle romaine lettuce", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 28, label: "1 serving (1 oz)" }, perServing: { calories: 5, protein: 0, carbs: 1, fat: 0, fiber: 1, sugar: 0, sodium: 0 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: lettuce", confidence: "high", match: [["chipotle", "lettuce"]] },
  { id: "chipotle-fajita-veg", name: "Chipotle fajita vegetables", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 57, label: "1 serving (2 oz)" }, perServing: { calories: 20, protein: 1, carbs: 5, fat: 0, fiber: 1, sugar: 2, sodium: 150 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: fajita veggies", confidence: "high", match: [["chipotle", "fajita"], ["chipotle", "veggies"], ["chipotle", "peppers"]] },
  { id: "chipotle-tortilla", name: "Chipotle flour tortilla (burrito)", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "tortilla", grams: 113, label: "1 burrito tortilla" }, perServing: { calories: 320, protein: 8, carbs: 50, fat: 9, saturatedFat: 0.5, fiber: 3, sugar: 0, sodium: 600 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: flour tortilla", confidence: "high", match: [["chipotle", "tortilla"]] },
  { id: "chipotle-chips", name: "Chipotle chips", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "bag", grams: 113, label: "1 bag (4 oz)" }, perServing: { calories: 540, protein: 7, carbs: 73, fat: 25, saturatedFat: 3.5, fiber: 7, sugar: 1, sodium: 390 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: chips", confidence: "high", match: [["chipotle", "chips"]] },
  { id: "chipotle-queso", name: "Chipotle queso blanco", brand: "Chipotle", kind: "restaurant", serving: { amount: 1, unit: "serving", grams: 57, label: "1 serving (2 oz)" }, perServing: { calories: 120, protein: 5, carbs: 4, fat: 9, saturatedFat: 6, fiber: 0, sugar: 1, sodium: 400 }, sourceType: "restaurant", source: "Chipotle nutrition calculator: queso blanco", confidence: "high", match: [["chipotle", "queso"]] },

  // ── Supplements ────────────────────────────────────────────────────────────
  {
    id: "nature-made-fish-oil-1200", name: "Nature Made Fish Oil 1200 mg", brand: "Nature Made", kind: "supplement",
    serving: { amount: 2, unit: "softgel", label: "2 softgels" },
    perServing: { calories: 25, fat: 2.5, omega3: 720 },
    sourceType: "manufacturer", source: "Nature Made Fish Oil 1200 mg label (360 mg omega-3 per softgel)", confidence: "high",
    match: [["nature", "made", "fish", "oil"]], exclude: ["burp-less", "burpless", "1000", "mini", "extra strength"], unitWords: ["softgel", "softgels", "capsule", "capsules", "pill", "pills"],
  },
];

// ─── Matching ────────────────────────────────────────────────────────────────

export interface NutritionDbMatch {
  item: NutritionDbItem;
  /** How many of the row's required words matched — ties broken toward branded rows. */
  score: number;
}

function normalizeQuery(q: string): string {
  return ` ${String(q || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9%&'.\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function hasWord(hay: string, word: string): boolean {
  const w = word.toLowerCase();
  // Stems ("strawberr") match prefixes; whole words match on boundaries.
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/[a-z]$/.test(w) && w.length >= 7 && !NUTRITION_WORD_WHOLE.has(w)) {
    return new RegExp(`(^|[^a-z0-9])${esc}`).test(hay);
  }
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(hay);
}
/** Words that must match whole even though they are long (a stem match would over-reach). */
const NUTRITION_WORD_WHOLE = new Set(["chicken", "oatmeal", "cheerios", "gatorade", "monster", "celsius", "snickers", "doritos", "premier", "protein", "creamer", "espresso", "chipotle", "tortilla", "lettuce", "cheese", "guacamole", "sofritas", "barbacoa", "carnitas", "mcnuggets", "mcnugget", "mcchicken", "pounder", "fairlife", "mcdonald's", "mcdonalds", "bananas", "oranges", "almonds", "butter", "coffee", "pepper", "mountain", "sandwich", "original", "instant", "reduced", "quarter", "percent", "nonfat", "whites", "yogurt", "yoghurt", "triple", "nature", "valley", "cookies", "porridge"]);

/**
 * Best internal match for a component phrase, or null. A row matches when
 * every word of one of its alternatives is present and none of its exclusions
 * is. Among matches, the most specific row (most required words, then branded
 * over generic) wins, so "Quaker maple brown sugar oatmeal" beats "oatmeal".
 */
export function lookupNutritionDb(phrase: string): NutritionDbMatch | null {
  const hay = normalizeQuery(phrase);
  if (hay.trim().length === 0) return null;
  let best: NutritionDbMatch | null = null;
  for (const item of NUTRITION_DB) {
    if (item.exclude?.some((x) => hasWord(hay, x))) continue;
    let bestAlt = 0;
    for (const alt of item.match) {
      if (alt.every((w) => hasWord(hay, w))) bestAlt = Math.max(bestAlt, alt.length);
    }
    if (bestAlt === 0) continue;
    const kindBonus = item.kind === "generic" ? 0 : 0.5;
    const score = bestAlt + kindBonus;
    if (!best || score > best.score) best = { item, score };
  }
  return best;
}

// ─── Servings ────────────────────────────────────────────────────────────────

/** Spellings of one unit word collapse to one key: tablespoons → tbsp, ounces → fl oz. */
export function canonUnitWord(u: string): string {
  const w = String(u || "").toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (/^(tbsp|tablespoon|tablespoons)$/.test(w)) return "tbsp";
  if (/^(tsp|teaspoon|teaspoons)$/.test(w)) return "tsp";
  if (/^(cup|cups)$/.test(w)) return "cup";
  if (/^(oz|ounce|ounces|fl oz|floz|fluid ounce|fluid ounces)$/.test(w)) return "fl oz";
  if (/^(packet|packets|pack|packs|pouch|pouches)$/.test(w)) return "packet";
  if (/^(can|cans)$/.test(w)) return "can";
  if (/^(bottle|bottles)$/.test(w)) return "bottle";
  if (/^(bar|bars)$/.test(w)) return "bar";
  if (/^(slice|slices)$/.test(w)) return "slice";
  if (/^(piece|pieces|pc|pcs)$/.test(w)) return "piece";
  if (/^(softgel|softgels|capsule|capsules|pill|pills|tablet|tablets)$/.test(w)) return "softgel";
  if (/^(shot|shots)$/.test(w)) return "shot";
  if (/^(container|containers)$/.test(w)) return "container";
  if (/^(cookie|cookies)$/.test(w)) return "cookie";
  if (/^(egg|eggs)$/.test(w)) return "egg";
  if (/^(glass|glasses)$/.test(w)) return "glass";
  if (/^(shake|shakes)$/.test(w)) return "shake";
  if (/^(serving|servings|portion|portions)$/.test(w)) return "serving";
  return w.replace(/s$/, "");
}

export interface ServingResolution {
  servings: number;
  confidence: EnrichmentConfidence;
  /** Why this many servings ("12 fl oz ÷ 355 ml can", "2 slices ÷ 1 per serving"). */
  method: string;
}

/**
 * How many of the row's servings the user's quantity is. Volume and mass are
 * compared directly when the row knows its serving in those terms; counts use
 * the row's unit words ("2 slices" of a per-slice row = 2 servings; "2 cookies"
 * of a 3-cookie row = ⅔). A quantity the row cannot interpret is one serving
 * at reduced confidence — never a silent guess at the user's number.
 */
export function resolveServings(item: NutritionDbItem, qty: QuantityNormalization, phrase?: string): ServingResolution {
  const r = resolveServingsRaw(item, qty, phrase);
  // Unit rounding (12 fl oz vs a 355 ml can) must not turn one serving into 0.9997.
  const servings = Math.abs(r.servings - 1) < 0.01 ? 1 : Math.round(r.servings * 1000) / 1000;
  return { ...r, servings };
}

function resolveServingsRaw(item: NutritionDbItem, qty: QuantityNormalization, phrase?: string): ServingResolution {
  const s = item.serving;
  // "large banana" scales a generic reference; "Big Mac" / "Grande latte" are
  // product names whose size IS the row.
  const size = item.kind === "generic" ? sizeFactor(phrase || qty.original) : 1;
  const unit = (qty.unit || "").toLowerCase();
  const isOunceWord = /^(oz|ounce|ounces)$/.test(unit);
  // An explicit number + unit ("12 oz", "2 tablespoons", "182 g") matched to
  // the row's serving is the serving size the spec calls exact.
  const explicit: EnrichmentConfidence = qty.confidence === "high" ? "exact" : qty.confidence;

  // The user's unit IS the row's serving unit ("2 tablespoons" of a 2-tbsp
  // row, "1 packet" of a per-packet row, "12 oz" of a 12 fl oz row): compare
  // amounts directly before any mass/volume conversion.
  if (qty.amount != null && unit) {
    const servingUnit = canonUnitWord(s.unit);
    const userUnit = canonUnitWord(unit);
    // "2 servings" is two of the row's own serving, whatever that serving is.
    if (userUnit === "serving") {
      return { servings: qty.amount * size, confidence: "exact", method: `${qty.amount} × ${s.label}` };
    }
    const unitWords = new Set([servingUnit, ...(item.unitWords || []).map(canonUnitWord)]);
    if (userUnit === servingUnit || (unitWords.has(userUnit) && servingUnit === userUnit)) {
      return { servings: (qty.amount / s.amount) * size, confidence: "exact", method: `${qty.amount} ${unit} ÷ ${s.amount} ${s.unit} per serving` };
    }
    if (userUnit === "fl oz" && item.isBeverage && s.ml) {
      const ml = qty.amount * ML_PER_FL_OZ;
      return { servings: ml / s.ml, confidence: "exact", method: `${qty.amount} fl oz (${Math.round(ml)} ml) ÷ ${s.ml} ml serving` };
    }
  }

  // Solid foods measured in ounces are mass, not volume.
  if (!item.isBeverage && isOunceWord && qty.amount != null && s.grams) {
    const grams = qty.amount * GRAMS_PER_OZ;
    return { servings: grams / s.grams, confidence: "exact", method: `${qty.amount} oz (${Math.round(grams)} g) ÷ ${s.grams} g serving` };
  }
  if (qty.ml != null && s.ml) {
    return { servings: qty.ml / s.ml, confidence: explicit, method: `${Math.round(qty.ml)} ml ÷ ${s.ml} ml serving${qty.assumption ? ` (${qty.assumption})` : ""}` };
  }
  if (qty.grams != null && s.grams) {
    return { servings: qty.grams / s.grams, confidence: explicit, method: `${Math.round(qty.grams)} g ÷ ${s.grams} g serving${qty.assumption ? ` (${qty.assumption})` : ""}` };
  }
  if (qty.count != null) {
    const unitWords = new Set([s.unit.toLowerCase(), ...(item.unitWords || []).map((w) => w.toLowerCase())]);
    if (unit && unitWords.has(unit)) {
      return { servings: (qty.count / s.amount) * size, confidence: "exact", method: `${qty.count} ${unit} ÷ ${s.amount} per serving` };
    }
    if (!unit) {
      // "2 eggs" / "large banana": the count is of the item itself. A size
      // word is an assumption, so it costs confidence.
      const conf: EnrichmentConfidence = size === 1 ? "exact" : "medium";
      return { servings: (qty.count / s.amount) * size, confidence: conf, method: `${qty.count} × ${s.label}${size !== 1 ? ` × ${size} (size)` : ""}` };
    }
    // "a bowl of Cheerios": a container word the row does not list — the
    // container's assumed volume/mass could not be applied above.
    return { servings: 1 * size, confidence: "medium", method: `assumed 1 serving (${s.label}) for "${qty.original}"` };
  }
  // No quantity wording at all ("a Coke", "Big Mac"): the standard serving.
  return { servings: 1 * size, confidence: size === 1 ? "exact" : "medium", method: `1 serving (${s.label})` };
}
