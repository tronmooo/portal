// ─── Item Enrichment Layer: nutrition (pure) ─────────────────────────────────
//
// The chat agent extracts WHAT the user said ("1 packet of Quaker oatmeal with
// a cup of 2% milk") and the entry is saved at once with the model's generic
// estimate. THIS module is the arithmetic and the vocabulary of the optional
// second step that refines that entry from a specific product match:
//
//   · specificity detection — is "oatmeal" vague, "Quaker oatmeal" a brand,
//     "Quaker Instant Oatmeal Maple & Brown Sugar, 1 packet" a product?
//   · quantity normalization — "half a bottle" → 10 fl oz (medium confidence),
//     keeping the user's wording beside the structured measurement;
//   · user-stated nutrition — "it says 210 calories and 20g protein" is the
//     user's data and is never overwritten by a lookup;
//   · component totals, serving-factor rescaling ("actually I only ate
//     half"), and the linked measurements (fluid, caffeine) one drink implies.
//
// Every enriched value carries provenance (source type, confidence, direct vs
// calculated) so a UI can always say where a number came from and never pass
// an estimate off as a label value. No I/O, no LLM: the server orchestrator
// (server/nutrition-enrichment.ts) does the lookups and calls in here.
//
// Pinned by tests/nutrition-enrichment.test.ts.

// ─── Nutrient vocabulary ─────────────────────────────────────────────────────

export const NUTRIENT_KEYS = [
  "calories", "protein", "carbs", "fat", "saturatedFat", "transFat", "monoFat", "polyFat",
  "fiber", "sugar", "addedSugar", "sugarAlcohol", "allulose",
  "sodium", "cholesterol", "potassium", "calcium", "iron", "magnesium", "zinc", "phosphorus", "selenium",
  "copper", "manganese", "iodine", "chromium", "molybdenum", "chloride",
  "caffeine", "alcohol", "fluidMl",
  "vitaminA", "vitaminB1", "vitaminB2", "vitaminB3", "vitaminB5", "vitaminB6", "biotin", "vitaminB12",
  "vitaminC", "vitaminD", "vitaminE", "vitaminK", "folate", "choline",
  "omega3", "omega6", "epa", "dha",
] as const;
export type NutrientKey = (typeof NUTRIENT_KEYS)[number];
export type NutrientVector = Partial<Record<NutrientKey, number>>;

/** Display unit per nutrient — one table, not a ladder. */
export const NUTRIENT_UNITS: Record<NutrientKey, string> = {
  calories: "kcal", protein: "g", carbs: "g", fat: "g", saturatedFat: "g", transFat: "g", monoFat: "g", polyFat: "g",
  fiber: "g", sugar: "g", addedSugar: "g", sugarAlcohol: "g", allulose: "g",
  sodium: "mg", cholesterol: "mg", potassium: "mg", calcium: "mg", iron: "mg",
  magnesium: "mg", zinc: "mg", phosphorus: "mg", selenium: "mcg",
  copper: "mg", manganese: "mg", iodine: "mcg", chromium: "mcg", molybdenum: "mcg", chloride: "mg",
  caffeine: "mg", alcohol: "g", fluidMl: "ml",
  vitaminA: "mcg", vitaminB1: "mg", vitaminB2: "mg", vitaminB3: "mg", vitaminB5: "mg", vitaminB6: "mg", biotin: "mcg", vitaminB12: "mcg",
  vitaminC: "mg", vitaminD: "mcg", vitaminE: "mg", vitaminK: "mcg", folate: "mcg", choline: "mg",
  omega3: "mg", omega6: "mg", epa: "mg", dha: "mg",
};

export const NUTRIENT_LABELS: Record<NutrientKey, string> = {
  calories: "Calories", protein: "Protein", carbs: "Carbs", fat: "Fat", saturatedFat: "Saturated fat",
  transFat: "Trans fat", monoFat: "Monounsaturated fat", polyFat: "Polyunsaturated fat",
  fiber: "Fiber", sugar: "Sugar", addedSugar: "Added sugar", sugarAlcohol: "Sugar alcohol", allulose: "Allulose",
  copper: "Copper", manganese: "Manganese", iodine: "Iodine", chromium: "Chromium", molybdenum: "Molybdenum", chloride: "Chloride",
  alcohol: "Alcohol", vitaminB1: "Thiamin (B1)", vitaminB2: "Riboflavin (B2)", vitaminB3: "Niacin (B3)", vitaminB5: "Pantothenic acid (B5)",
  biotin: "Biotin", choline: "Choline", omega6: "Omega-6",
  sodium: "Sodium", cholesterol: "Cholesterol",
  potassium: "Potassium", calcium: "Calcium", iron: "Iron", magnesium: "Magnesium", zinc: "Zinc",
  phosphorus: "Phosphorus", selenium: "Selenium", caffeine: "Caffeine", fluidMl: "Fluid",
  vitaminA: "Vitamin A", vitaminB6: "Vitamin B6", vitaminB12: "Vitamin B12", vitaminC: "Vitamin C", vitaminD: "Vitamin D",
  vitaminE: "Vitamin E", vitaminK: "Vitamin K", folate: "Folate", omega3: "Omega-3", epa: "EPA", dha: "DHA",
};

/**
 * Net carbohydrates: total carbs less fiber and sugar alcohols. DERIVED, never
 * stored, and only when the carbs are known — an unknown fiber is not zero
 * fiber, so with neither fiber nor sugar alcohol on record there is no net
 * figure to show (it would only repeat the total and call it something else).
 */
export function netCarbsOf(vec: NutrientVector): number | null {
  if (typeof vec.carbs !== "number") return null;
  if (typeof vec.fiber !== "number" && typeof vec.sugarAlcohol !== "number" && typeof vec.allulose !== "number") return null;
  return Math.max(0, roundNutrient(vec.carbs - (vec.fiber || 0) - (vec.sugarAlcohol || 0) - (vec.allulose || 0), "carbs"));
}

/**
 * The nutrient keys written onto the tracker entry's `values` (what the card,
 * the chart and the daily totals read). Everything else stays in the
 * provenance blob (`computed.nutrition.totals`) so one drink does not sprout
 * fourteen chips. `fluidMl` is a LINKED measurement (hydration), never a
 * nutrition value.
 */
export const ENTRY_VALUE_NUTRIENTS: readonly NutrientKey[] = [
  "calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium", "caffeine",
];

export function isNutrientKey(k: string): k is NutrientKey {
  return (NUTRIENT_KEYS as readonly string[]).includes(k);
}

/** Aliases the agent / a user may use for a nutrient value key. */
const NUTRIENT_KEY_ALIASES: Record<string, NutrientKey> = {
  calories: "calories", calorie: "calories", kcal: "calories", energy: "calories", cal: "calories",
  protein: "protein", proteins: "protein",
  carbs: "carbs", carb: "carbs", carbohydrate: "carbs", carbohydrates: "carbs",
  fat: "fat", fats: "fat", totalfat: "fat",
  totalcarbs: "carbs", totalcarbohydrate: "carbs", totalcarbohydrates: "carbs",
  saturatedfat: "saturatedFat", satfat: "saturatedFat",
  transfat: "transFat", monounsaturatedfat: "monoFat", monofat: "monoFat",
  polyunsaturatedfat: "polyFat", polyfat: "polyFat",
  fiber: "fiber", fibre: "fiber", dietaryfiber: "fiber",
  sugar: "sugar", sugars: "sugar", totalsugar: "sugar", totalsugars: "sugar",
  addedsugar: "addedSugar", addedsugars: "addedSugar",
  sugaralcohol: "sugarAlcohol", sugaralcohols: "sugarAlcohol",
  sodium: "sodium", salt: "sodium",
  cholesterol: "cholesterol",
  potassium: "potassium", calcium: "calcium", iron: "iron",
  magnesium: "magnesium", zinc: "zinc", phosphorus: "phosphorus", selenium: "selenium",
  caffeine: "caffeine",
  fluid: "fluidMl", fluidml: "fluidMl", water: "fluidMl",
  vitamina: "vitaminA", vitaminc: "vitaminC", vitamind: "vitaminD",
  vitaminb6: "vitaminB6", vitaminb12: "vitaminB12", vitamine: "vitaminE", vitamink: "vitaminK",
  folate: "folate", folicacid: "folate", vitaminb9: "folate",
  allulose: "allulose", copper: "copper", manganese: "manganese", iodine: "iodine", chromium: "chromium",
  molybdenum: "molybdenum", chloride: "chloride", alcohol: "alcohol", choline: "choline", biotin: "biotin", vitaminb7: "biotin",
  thiamin: "vitaminB1", thiamine: "vitaminB1", vitaminb1: "vitaminB1", riboflavin: "vitaminB2", vitaminb2: "vitaminB2",
  niacin: "vitaminB3", vitaminb3: "vitaminB3", pantothenicacid: "vitaminB5", vitaminb5: "vitaminB5", omega6: "omega6",
  omega3: "omega3", omega: "omega3", epa: "epa", dha: "dha",
};

export function canonicalNutrientKey(raw: string): NutrientKey | null {
  const lc = String(raw || "").toLowerCase().replace(/[\s_-]/g, "");
  return NUTRIENT_KEY_ALIASES[lc] ?? null;
}

// ─── Provenance ──────────────────────────────────────────────────────────────

/**
 * exact  — specific branded product + serving size matched
 * high   — strong match, minor details missing
 * medium — likely generic equivalent
 * low    — broad estimate from vague wording
 */
export type EnrichmentConfidence = "exact" | "high" | "medium" | "low";

export const CONFIDENCE_RANK: Record<EnrichmentConfidence, number> = { exact: 4, high: 3, medium: 2, low: 1 };

export function minConfidence(a: EnrichmentConfidence, b: EnrichmentConfidence): EnrichmentConfidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

export function confidenceFromScore(score: number): EnrichmentConfidence {
  if (score >= 0.95) return "exact";
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

export type EnrichmentSourceType =
  | "user"              // the user stated it (label read aloud, "it says 210 calories")
  | "manufacturer"      // the product's own label data
  | "restaurant"        // a restaurant / menu nutrition sheet
  | "product_database"  // a product database match (e.g. Open Food Facts)
  | "reference"         // a standard nutrition reference for a generic food
  | "model_estimate"    // an AI estimate for an item no source matched
  | "calculated"        // arithmetic over other provenanced values (a meal total)
  | "default";          // the generic fallback the base extraction already used

export interface ProvenancedNutrient {
  value: number;
  unit: string;
  /** Human-readable origin: "Coca-Cola 12 fl oz can label", "USDA reference: large egg". */
  source: string;
  sourceType: EnrichmentSourceType;
  /** The matched item this value was read from (product / reference food). */
  sourceItem?: string;
  confidence: EnrichmentConfidence;
  calculatedOrDirect: "direct" | "calculated";
  enrichedAt: string;
}

// ─── Quantity normalization ──────────────────────────────────────────────────

export type MeasureUnit = "g" | "ml" | "count";

export interface QuantityNormalization {
  /** The user's wording, verbatim. Never replaced. */
  original: string;
  /** Amount in the user's own unit (2 for "2 slices", 12 for "12 oz"). */
  amount: number | null;
  /** The user's unit as spoken: "slice", "oz", "cup", "packet"… */
  unit: string | null;
  /** Mass when the wording resolves to one. */
  grams: number | null;
  /** Volume when the wording resolves to one. */
  ml: number | null;
  /** A count of pieces/servings when that is what was said ("2 slices", "1 packet"). */
  count: number | null;
  confidence: EnrichmentConfidence;
  /** What was assumed to get here ("assumed a 20 fl oz bottle"). */
  assumption?: string;
  /**
   * The user spoke in terms of the PACKAGE: "half the bottle", "the whole
   * pizza", "a third of the bag". The fraction of one package, when the
   * matched product knows its package size this outranks the assumed
   * container above.
   */
  packageFraction?: number;
  packageWord?: string;
}

export const ML_PER_FL_OZ = 29.5735;
export const GRAMS_PER_OZ = 28.3495;

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12, half: 0.5, quarter: 0.25, third: 1 / 3, couple: 2, few: 3, several: 3,
};

/** "1/2", "½", "1.5", "two", "a" → number. */
export function parseAmountToken(tok: string): number | null {
  const t = String(tok || "").trim().toLowerCase();
  if (!t) return null;
  if (t === "½") return 0.5;
  if (t === "¼") return 0.25;
  if (t === "¾") return 0.75;
  if (t === "⅓") return 1 / 3;
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) { const d = Number(frac[2]); return d ? Number(frac[1]) / d : null; }
  const mixed = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) { const d = Number(mixed[3]); return d ? Number(mixed[1]) + Number(mixed[2]) / d : null; }
  const num = t.match(/^\d+(?:\.\d+)?$/);
  if (num) return Number(t);
  if (NUMBER_WORDS[t] != null) return NUMBER_WORDS[t];
  return null;
}

/** Volume / mass units with their canonical conversion. */
const VOLUME_ML: Record<string, number> = {
  ml: 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1,
  l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
  oz: ML_PER_FL_OZ, "fl oz": ML_PER_FL_OZ, floz: ML_PER_FL_OZ, ounce: ML_PER_FL_OZ, ounces: ML_PER_FL_OZ,
  cup: 8 * ML_PER_FL_OZ, cups: 8 * ML_PER_FL_OZ,
  tbsp: 14.79, tablespoon: 14.79, tablespoons: 14.79,
  tsp: 4.93, teaspoon: 4.93, teaspoons: 4.93,
  pint: 473.2, pints: 473.2, quart: 946.4, quarts: 946.4, gallon: 3785.4, gallons: 3785.4,
  shot: 44.4, shots: 44.4,
};
const MASS_G: Record<string, number> = {
  g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, kilograms: 1000,
  lb: 453.6, lbs: 453.6, pound: 453.6, pounds: 453.6, mg: 0.001,
};
/**
 * Container / portion words with an assumed size. These are ASSUMPTIONS, so
 * everything that leans on one is at most medium confidence and the assumption
 * is recorded on the normalization.
 */
const CONTAINER_SIZES: Record<string, { ml?: number; g?: number; label: string; confidence: EnrichmentConfidence }> = {
  can: { ml: 12 * ML_PER_FL_OZ, label: "12 fl oz can", confidence: "medium" },
  cans: { ml: 12 * ML_PER_FL_OZ, label: "12 fl oz can", confidence: "medium" },
  bottle: { ml: 20 * ML_PER_FL_OZ, label: "20 fl oz bottle", confidence: "medium" },
  bottles: { ml: 20 * ML_PER_FL_OZ, label: "20 fl oz bottle", confidence: "medium" },
  glass: { ml: 8 * ML_PER_FL_OZ, label: "8 fl oz glass", confidence: "medium" },
  glasses: { ml: 8 * ML_PER_FL_OZ, label: "8 fl oz glass", confidence: "medium" },
  mug: { ml: 12 * ML_PER_FL_OZ, label: "12 fl oz mug", confidence: "medium" },
  bowl: { ml: 1.5 * 8 * ML_PER_FL_OZ, g: 250, label: "1.5 cup bowl", confidence: "medium" },
  bowls: { ml: 1.5 * 8 * ML_PER_FL_OZ, g: 250, label: "1.5 cup bowl", confidence: "medium" },
  handful: { g: 28, label: "1 oz handful", confidence: "medium" },
  handfuls: { g: 28, label: "1 oz handful", confidence: "medium" },
  bite: { g: 15, label: "15 g bite", confidence: "low" },
  bites: { g: 15, label: "15 g bite", confidence: "low" },
  plate: { g: 350, label: "350 g plate", confidence: "low" },
  scoop: { g: 30, label: "30 g scoop", confidence: "medium" },
  scoops: { g: 30, label: "30 g scoop", confidence: "medium" },
};
/** Words that mean "one piece of the thing" — a count, not a mass or volume. */
const COUNT_WORDS = new Set([
  "slice", "slices", "piece", "pieces", "packet", "packets", "pack", "packs", "bar", "bars", "serving", "servings",
  "egg", "eggs", "tablet", "tablets", "capsule", "capsules", "softgel", "softgels", "pill", "pills", "gummy", "gummies",
  "cookie", "cookies", "stick", "sticks", "patty", "patties", "wing", "wings", "nugget", "nuggets", "taco", "tacos",
  "cup", // only when the item is a countable "cup" product (handled by caller); volume wins by default
]);
const SIZE_ADJECTIVES: Record<string, number> = { small: 0.75, medium: 1, large: 1.25, big: 1.25, huge: 1.5, extra: 1.5, xl: 1.5, jumbo: 1.5, mini: 0.5, tiny: 0.5 };

/** Round to a sensible precision for storage. */
/**
 * Storage precision. A label scaled by what was eaten is arithmetic, and the
 * answer is kept: half of 3.5 g fat is 1.75 g, seven Oreos are 373.3 kcal —
 * not 1.8 g and 373. Calories keep one decimal, grams two; milligram and
 * microgram quantities (and fluid) are whole numbers. The float noise of the
 * multiplication (5.6250000001) is trimmed first, so a half rounds up.
 */
const WHOLE_NUMBER_NUTRIENTS = new Set<string>(["sodium", "potassium", "calcium", "caffeine", "cholesterol", "fluidMl", "omega3", "omega6", "epa", "dha", "magnesium", "phosphorus", "selenium", "vitaminA", "vitaminK", "folate", "iodine", "chromium", "molybdenum", "chloride", "choline", "biotin"]);
export function roundNutrient(v: number, key?: NutrientKey): number {
  if (!isFinite(v)) return 0;
  const clean = Number(v.toPrecision(12));
  if (key && WHOLE_NUMBER_NUTRIENTS.has(key)) return Math.round(clean);
  if (key === "calories") return Math.round(clean * 10) / 10;
  return Math.round(clean * 100) / 100;
}

const AMOUNT_WORDS = "\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*/\\s*\\d+|\\d+(?:\\.\\d+)?|[½¼¾⅓]|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|half|quarter|couple|few|several";
/** One amount token, bounded so "a" never matches inside "about". */
const AMOUNT_RE = `(?<![a-z0-9])(${AMOUNT_WORDS})(?![a-z])`;

/**
 * Natural-language quantity → structured measurement. The caller passes the
 * phrase for ONE component ("half a bottle", "12 oz", "2 slices", "a cup",
 * "large banana"). Unparseable wording returns a null-measure normalization
 * with low confidence rather than a guess.
 */
const PACKAGE_UNIT_WORDS = "package|pack|box|bag|bottle|can|pint|quart|tub|jar|carton|container|pizza|sleeve|pouch|tray|cup|bar";
const PACKAGE_FRACTION_RE = new RegExp(`\\b(whole|entire|all of|most of|half|a half|quarter|a quarter|a third|third|two thirds|three quarters|\\d+/\\d+)\\s+(?:of\\s+)?(?:a|an|the|my|this|that)?\\s*(?:[a-z0-9'&.-]+\\s+){0,4}?(${PACKAGE_UNIT_WORDS})\\b`);
const FRACTION_WORD: Record<string, number> = { whole: 1, entire: 1, "all of": 1, "most of": 0.75, half: 0.5, "a half": 0.5, quarter: 0.25, "a quarter": 0.25, "a third": 1 / 3, third: 1 / 3, "two thirds": 2 / 3, "three quarters": 0.75 };

/** "half the bottle" / "the whole pizza" → the fraction of one package and the package word. */
export function detectPackageFraction(text: string): { fraction: number; word: string } | null {
  const m = String(text || "").toLowerCase().match(PACKAGE_FRACTION_RE);
  if (!m) return null;
  const f = FRACTION_WORD[m[1]] ?? (m[1].includes("/") ? Number(m[1].split("/")[0]) / Number(m[1].split("/")[1]) : NaN);
  if (!isFinite(f) || f <= 0) return null;
  return { fraction: f, word: m[2] };
}

/**
 * Spoken amounts → digits, so one set of patterns reads them all: "one and a
 * half bars" → "1.5 bars", "three quarters of one" → "0.75 of one", "two and
 * a quarter cups" → "2.25 cups". A bare "half" / "quarter" is left for the
 * "half a bottle" rule, which also knows the package it is half of.
 */
const SMALL_NUMBER: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const SPOKEN_FRACTION: Record<string, number> = { half: 0.5, quarter: 0.25, third: 1 / 3, "three quarters": 0.75, "two thirds": 2 / 3 };
const trimNumber = (n: number): string => String(Math.round(n * 10000) / 10000);
export function spokenAmountsToDigits(text: string): string {
  let t = String(text || "");
  // "one and a half", "2 and a quarter", "one and three quarters"
  t = t.replace(/(?<![a-z0-9.])(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+and\s+(?:(?:a|an|one)\s+)?(three quarters|two thirds|half|quarter|third)(?![a-z])/gi, (_m, whole: string, frac: string) => {
    const w = /^\d/.test(whole) ? Number(whole) : SMALL_NUMBER[whole.toLowerCase()];
    return trimNumber(w + SPOKEN_FRACTION[frac.toLowerCase()]);
  });
  // "three quarters", "two thirds", "one third", "a third", "one half", "one quarter"
  t = t.replace(/(?<![a-z0-9.])(three[- ]quarters?|two[- ]thirds?)(?![a-z])/gi, (m) => trimNumber(/^three/i.test(m) ? 0.75 : 2 / 3));
  t = t.replace(/(?<![a-z0-9.])(?:one|a)[- ](third|half|quarter)(?=\s+(?:of|a|an|the)\b|\s*$)/gi, (_m, f: string) => trimNumber(SPOKEN_FRACTION[f.toLowerCase()]));
  return t;
}

/** What follows a number + unit when the pair describes the PRODUCT, not how much was eaten ("42g protein shake"). */
const NUTRIENT_AFTER_RE = /^\s*(?:of\s+)?(protein|carbs?|carbohydrates?|fat|sugars?|fiber|fibre|caffeine|sodium|calories?|kcal)\b/;
/** "made two sandwiches but only ate three quarters of one": the amount that was EATEN is the one after the eating verb. */
const MADE_THEN_ATE_RE = /\b(made|cooked|prepared|baked|bought|ordered|opened|poured|got)\b.*?\b(?:only\s+)?(?:ate|had|drank|finished|eaten)\s+(.+)$/;

export function normalizeQuantity(text: string): QuantityNormalization {
  const original = String(text || "").trim();
  const base: QuantityNormalization = { original, amount: null, unit: null, grams: null, ml: null, count: null, confidence: "low" };
  if (!original) return base;
  const spoken = original.toLowerCase().replace(/\s+/g, " ");
  const pkg = detectPackageFraction(spoken);
  if (pkg) { base.packageFraction = pkg.fraction; base.packageWord = pkg.word; }
  let lc = spokenAmountsToDigits(spoken);
  const ate = lc.match(MADE_THEN_ATE_RE);
  if (ate && new RegExp(AMOUNT_RE).test(ate[2])) lc = ate[2].trim();

  // "half a bottle" / "half of the bottle" / "half the bottle"
  const fracContainer = lc.match(new RegExp(`^(half|quarter|third|a third|two thirds|three quarters|${AMOUNT_WORDS})\\s+(?:of\\s+)?(?:a|an|the)?\\s*([a-z]+)`));

  let amountToken = "";
  const resolveUnit = (amount: number, unitRaw: string, out: QuantityNormalization): QuantityNormalization => {
    const unit = unitRaw.replace(/\./g, "").replace(/\s+/g, " ").trim();
    out.amount = amount;
    out.unit = unit;
    const volKey = unit.replace(/\s/g, "") === "floz" ? "fl oz" : unit;
    if (VOLUME_ML[volKey] != null) {
      out.ml = Math.round(amount * VOLUME_ML[volKey] * 10) / 10;
      out.confidence = "high";
      return out;
    }
    if (MASS_G[unit] != null) {
      out.grams = Math.round(amount * MASS_G[unit] * 10) / 10;
      out.confidence = "high";
      return out;
    }
    const container = CONTAINER_SIZES[unit];
    if (container) {
      if (container.ml != null) out.ml = Math.round(amount * container.ml * 10) / 10;
      if (container.g != null) out.grams = Math.round(amount * container.g * 10) / 10;
      out.count = amount;
      out.confidence = container.confidence;
      out.assumption = `assumed a ${container.label}`;
      return out;
    }
    if (COUNT_WORDS.has(unit)) {
      out.count = amount;
      out.confidence = "high";
      return out;
    }
    // The word after the number is the FOOD, not a unit: "2 bananas", "3 eggs",
    // "2 wheat toast" are counts of the item itself. "a Quest bar" / "a Coke"
    // (an article, then the food) is no quantity at all — one standard serving.
    if (/^(a|an)$/.test(amountToken)) return { ...base };
    out.unit = null;
    out.count = amount;
    out.confidence = "high";
    return out;
  };
  const isMeasure = (unitRaw: string): boolean => {
    const unit = unitRaw.replace(/\./g, "").replace(/\s+/g, " ").trim();
    return VOLUME_ML[unit.replace(/\s/g, "") === "floz" ? "fl oz" : unit] != null || MASS_G[unit] != null;
  };

  const fracWord: Record<string, number> = { half: 0.5, quarter: 0.25, third: 1 / 3, "a third": 1 / 3, "two thirds": 2 / 3, "three quarters": 0.75 };
  if (fracContainer && (fracWord[fracContainer[1]] != null || parseAmountToken(fracContainer[1]) != null) && /^(of|a|an|the)\b/.test(lc.slice(fracContainer[1].length).trim())) {
    const amount = fracWord[fracContainer[1]] ?? parseAmountToken(fracContainer[1])!;
    amountToken = fracContainer[1].toLowerCase();
    return resolveUnit(amount, fracContainer[2], { ...base });
  }

  // "a 12 oz coke" / "12 oz" / "12oz" / "250-gram" / "2 cups" / "1 packet" / "3 bites"
  // Every number-and-word pair in the phrase, in order. A pair that is the
  // product's own description ("42g protein shake") is not a quantity.
  const pairs: Array<{ amount: number; token: string; unit: string; index: number; end: number }> = [];
  for (const m of lc.matchAll(new RegExp(`${AMOUNT_RE}[\\s-]*(fl\\.?\\s*oz|[a-z]+)`, "g"))) {
    const amount = parseAmountToken(m[1]);
    if (amount == null) continue;
    const end = (m.index ?? 0) + m[0].length;
    if (isMeasure(m[2]) && NUTRIENT_AFTER_RE.test(lc.slice(end))) continue;
    pairs.push({ amount, token: m[1].toLowerCase(), unit: m[2], index: m.index ?? 0, end });
  }
  if (pairs.length > 0) {
    // A weight or a volume says exactly how much, wherever it stands in the
    // phrase: "one with 30 ml of whole milk" is 30 ml, not one cup.
    const measured = pairs.find((p) => isMeasure(p.unit));
    const pick = measured || pairs[0];
    amountToken = pick.token;
    if (measured) {
      // "two 12 oz Cokes": a count standing directly before the measure multiplies it.
      const before = lc.slice(0, measured.index).match(new RegExp(`${AMOUNT_RE}\\s+$`));
      const times = before && !/^(a|an)$/.test(before[1]) ? parseAmountToken(before[1]) : null;
      return resolveUnit(times != null && times > 0 ? measured.amount * times : measured.amount, measured.unit, { ...base });
    }
    // "2 large eggs" → the adjective is not the unit.
    if (SIZE_ADJECTIVES[pick.unit] != null) {
      const out = { ...base, amount: pick.amount, unit: null, count: pick.amount, confidence: "medium" as EnrichmentConfidence };
      out.assumption = `${pick.unit} size ≈ ${SIZE_ADJECTIVES[pick.unit]}× a medium one`;
      return out;
    }
    return resolveUnit(pick.amount, pick.unit, { ...base });
  }
  // "large banana", "a big apple" — a size adjective and no number.
  const adj = Object.keys(SIZE_ADJECTIVES).find((a) => new RegExp(`\\b${a}\\b`).test(lc));
  if (adj) {
    return { ...base, amount: 1, unit: null, count: 1, confidence: "medium", assumption: `${adj} size ≈ ${SIZE_ADJECTIVES[adj]}× a medium one` };
  }
  return base;
}

/** The multiplier a size adjective implies ("large banana" → 1.25). */
export function sizeFactor(text: string): number {
  const lc = String(text || "").toLowerCase();
  for (const [adj, f] of Object.entries(SIZE_ADJECTIVES)) if (new RegExp(`\\b${adj}\\b`).test(lc)) return f;
  return 1;
}

// ─── Specificity detection ───────────────────────────────────────────────────

export type SpecificityLevel = "vague" | "generic" | "brand" | "product";

export interface Specificity {
  level: SpecificityLevel;
  /** Which details were found: brand, product, flavor, restaurant, package, serving, weight, volume, count, preparation, percentage, barcode… */
  signals: string[];
}

/** Known brands / restaurants. Not exhaustive — capitalized multi-word names are also taken as brand-ish. */
const KNOWN_BRANDS = [
  "quaker", "cheerios", "kellogg", "kelloggs", "general mills", "post", "nature valley", "kind", "clif", "rxbar", "quest",
  "chobani", "oikos", "fage", "yoplait", "dannon", "fairlife", "horizon", "lactaid", "silk", "oatly", "almond breeze",
  "coca-cola", "coca cola", "coke", "diet coke", "coke zero", "pepsi", "sprite", "dr pepper", "mountain dew", "gatorade",
  "powerade", "red bull", "monster", "celsius", "bang", "rockstar", "starbucks", "dunkin", "dunkin'", "peet's", "la croix",
  "lacroix", "bubly", "topo chico", "poland spring", "fiji", "smartwater", "vitaminwater", "bodyarmor", "liquid iv",
  "jif", "skippy", "peter pan", "justin's", "nutella", "philadelphia", "kraft", "velveeta", "sargento", "tillamook",
  "trader joe's", "trader joes", "whole foods", "kirkland", "costco", "great value", "365", "aldi",
  "mcdonald's", "mcdonalds", "big mac", "mcnuggets", "mcchicken", "quarter pounder", "burger king", "whopper", "wendy's",
  "wendys", "chick-fil-a", "chickfila", "chipotle", "taco bell", "subway", "panera", "sweetgreen", "cava", "five guys",
  "in-n-out", "shake shack", "popeyes", "kfc", "domino's", "dominos", "pizza hut", "papa john's", "little caesars",
  "jimmy john's", "jersey mike's", "qdoba", "panda express", "olive garden", "applebee's", "chili's", "cheesecake factory",
  "dutch bros", "tim hortons", "jamba", "smoothie king", "tropical smoothie",
  "oreo", "chips ahoy", "doritos", "lay's", "lays", "cheetos", "pringles", "goldfish", "ritz", "triscuit", "wheat thins",
  "snickers", "kit kat", "kitkat", "reese's", "reeses", "m&m", "m&ms", "hershey", "twix", "milky way", "haribo",
  "ben & jerry's", "ben and jerry's", "halo top", "häagen-dazs", "haagen-dazs", "breyers", "talenti",
  "nature made", "centrum", "one a day", "garden of life", "optimum nutrition", "premier protein", "fairlife core power",
  "core power", "muscle milk", "orgain", "huel", "soylent", "ensure", "boost", "vital proteins", "ag1", "athletic greens",
  "advil", "tylenol", "motrin", "aleve", "excedrin", "zyrtec", "claritin", "benadryl", "nyquil", "dayquil", "pepto",
  "tums", "mucinex", "sudafed", "allegra", "melatonin",
  "eggo", "pillsbury", "betty crocker", "hot pockets", "lean cuisine", "healthy choice", "stouffer's", "amy's",
  "ben's original", "uncle ben's", "barilla", "rao's", "prego", "campbell's", "progresso", "annie's", "kraft mac",
  "oscar mayer", "hillshire", "applegate", "boar's head", "hormel", "spam", "jimmy dean", "morningstar", "beyond", "impossible",
  "dave's killer bread", "wonder", "nature's own", "thomas'", "thomas", "bagel", "lender's", "sara lee", "pepperidge farm",
  "wheat thins", "clif bar", "larabar", "pure protein", "one bar", "built bar", "perfect bar", "barebells",
];
const RESTAURANT_WORDS = /\b(restaurant|menu|drive[- ]thru|take ?out|from (mcdonald's|chipotle|starbucks|chick-fil-a|subway|wendy's|taco bell|burger king|panera|dunkin'?|sweetgreen|cava|five guys|in-n-out|shake shack|popeyes|kfc|domino's|pizza hut))\b/i;
const PACKAGE_WORDS = /\b(packet|packets|pack|packs|can|cans|bottle|bottles|bar|bars|pouch|box|jar|carton|sleeve|single[- ]serve|tall ?boy|k-cup|pod)\b/i;
const SERVING_WORDS = /\b(serving|servings|scoop|scoops|slice|slices|piece|pieces|tablespoon|tablespoons|tbsp|teaspoon|teaspoons|tsp|cup|cups|handful|bowl|bowls|bite|bites)\b/i;
const WEIGHT_RE = /\b\d+(?:\.\d+)?\s*(g|grams?|oz|ounces?|lbs?|pounds?|kg|mg)\b/i;
const VOLUME_RE = /\b\d+(?:\.\d+)?\s*(fl\.?\s*oz|ml|l|liters?|litres?|cups?|tbsp|tsp)\b/i;
const COUNT_RE = /(^|\b)(\d+(?:\.\d+)?|½|¼|¾|one|two|three|four|five|six|a dozen|half a|half an|a couple of)\s+(?:\w+\s+){0,2}?(eggs?|slices?|pieces?|packets?|bars?|cans?|bottles?|tablets?|capsules?|softgels?|pills?|scoops?|cookies?|tacos?|wings?|nuggets?|servings?|cups?|bananas?|apples?|oranges?)\b/i;
const PREPARATION_RE = /\b(grilled|fried|baked|roasted|boiled|poached|scrambled|steamed|raw|toasted|air[- ]fried|smoked|sautéed|sauteed|breaded|crispy|hard[- ]boiled|soft[- ]boiled|over[- ]easy|sunny[- ]side)\b/i;
const PERCENT_RE = /\b\d+(?:\.\d+)?\s*%|\b(whole|skim|nonfat|non-fat|fat[- ]free|low[- ]fat|reduced[- ]fat|2 percent|1 percent|half and half)\b/i;
const BARCODE_RE = /\b\d{12,14}\b/;
const FLAVOR_RE = /\b(flavor|flavour|vanilla|chocolate|strawberry|honey|maple|brown sugar|cinnamon|peach|mango|berry|lemon|lime|cherry|grape|orange|caramel|mocha|hazelnut|original|classic|zero|diet|light|unsweetened|sweetened)\b/i;
const INGREDIENT_LIST_RE = /\bwith\b[^.]*\band\b|\b(topped|loaded)\s+with\b/i;

export function detectSpecificity(text: string): Specificity {
  const t = String(text || "").trim();
  const signals: string[] = [];
  if (!t) return { level: "vague", signals };
  const lc = t.toLowerCase();

  const brandHit = KNOWN_BRANDS.find((b) => new RegExp(`(^|[^a-z])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(lc));
  // Two or more consecutive Capitalized words that are not sentence-initial read
  // as a proper product name ("Honey Nut Cheerios", "Chicken Shawarma Bowl").
  // Two or more Capitalized words in a row, allowing a connector between them
  // ("Honey Bunches of Oats", "Ben & Jerry's"); the sentence-initial capital
  // is discounted first.
  const properName = /(?:^|\s)[A-Z][\w'&-]+(?:\s+(?:of|and|&|the|'n|n'|with|in|de|du|la|le)\s+|\s+)[A-Z][\w'&-]+/.test(t.replace(/^I\s+/, "").replace(/^[A-Z]/, (c) => c.toLowerCase()));
  if (brandHit) signals.push("brand");
  if (RESTAURANT_WORDS.test(t)) signals.push("restaurant");
  if (properName || /\b(instant|original|classic|protein|zero sugar|sugar free|lite|light)\b/i.test(t) && brandHit) signals.push("product");
  if (FLAVOR_RE.test(t) && (brandHit || properName)) signals.push("flavor");
  if (PACKAGE_WORDS.test(t)) signals.push("package");
  if (SERVING_WORDS.test(t)) signals.push("serving");
  if (WEIGHT_RE.test(t)) signals.push("weight");
  if (VOLUME_RE.test(t)) signals.push("volume");
  if (COUNT_RE.test(t)) signals.push("count");
  if (PREPARATION_RE.test(t)) signals.push("preparation");
  if (PERCENT_RE.test(t)) signals.push("percentage");
  if (BARCODE_RE.test(t)) signals.push("barcode");
  if (INGREDIENT_LIST_RE.test(t)) signals.push("ingredients");

  const uniq = Array.from(new Set(signals));
  const hasQuantity = uniq.some((s) => ["package", "serving", "weight", "volume", "count"].includes(s));
  let level: SpecificityLevel;
  if (uniq.includes("barcode") || (uniq.includes("brand") && (uniq.includes("product") || uniq.includes("flavor") || hasQuantity))) level = "product";
  else if (uniq.includes("brand") || uniq.includes("restaurant") || uniq.includes("product")) level = "brand";
  else if (/\b(some|a little|a bit of|stuff|something|food|snacks?|fruit|veggies|vegetables|dinner|lunch|breakfast)\b/i.test(t) && !hasQuantity && !PREPARATION_RE.test(t)) level = "vague";
  else level = "generic";
  return { level, signals: uniq };
}

// ─── User-stated nutrition ───────────────────────────────────────────────────

/** Nutrient names as people and labels write them; longer names first so "sugar alcohol" is not read as "sugar". */
const NUTRIENT_WORDS =
  "calories?|kcal|protein|net carbs?|total carbs?|total carbohydrates?|carbs?|carbohydrates?|total fat|saturated fat|sat fat|trans fat|" +
  "monounsaturated fat|polyunsaturated fat|fat|dietary fiber|fiber|fibre|sugar alcohols?|added sugars?|total sugars?|sugars?|sodium|salt|" +
  "cholesterol|potassium|calcium|iron|magnesium|zinc|phosphorus|selenium|copper|manganese|iodine|chromium|molybdenum|chloride|choline|biotin|" +
  "thiamine?|riboflavin|niacin|pantothenic acid|allulose|alcohol|folate|folic acid|caffeine|omega[- ]?3|omega[- ]?6|epa|dha|vitamin [a-z]\\d{0,2}";
const USER_STATED_RE = new RegExp(
  "(\\d+(?:\\.\\d+)?)\\s*(kcal|calories?|cals?|g|grams?|mg|milligrams?|mcg|ml|fl\\.?\\s*oz|oz)?\\s*(?:of\\s+)?" +
  `(${NUTRIENT_WORDS})\\b`,
  "gi",
);
// "protein 20g", "calories: 210", "210 cal", "20g of protein"
const USER_STATED_REVERSED_RE = new RegExp(
  `\\b(${NUTRIENT_WORDS})\\s*[:=]?\\s*(?:is|was|of|at)?\\s*(\\d+(?:\\.\\d+)?)\\s*(kcal|calories?|cals?|g|grams?|mg|milligrams?|mcg)?`,
  "gi",
);
/**
 * A number and a nutrient standing in front of a product noun describe the
 * PRODUCT ("a 42g protein shake", "the 30 g protein bar"), not what the user
 * read off a label: scaled as a label value, half a shake kept 42 g protein.
 */
const PRODUCT_NOUN_AFTER_RE = /^\s*(shakes?|bars?|powders?|drinks?|yogurts?|yoghurts?|milk|cereals?|cookies?|chips|bread|pasta|waters?|coffees?|pancakes?|waffles?|granola|oatmeal|smoothies?|bites?|puffs?|ice cream|pudding|bagels?|wraps?|tortillas?)\b/i;
const STATEMENT_CUE_RE = /\b(it says|label says|says|package says|box says|wrapper says|according to|per the label|listed|nutrition facts|it's|it is|it has|has|with|containing|contains)\b/i;

function nutrientFromWord(word: string): NutrientKey | null {
  const w = word.toLowerCase().replace(/\s+/g, "").replace("-", "");
  if (/^(calorie|calories|kcal)$/.test(w)) return "calories";
  if (w === "protein") return "protein";
  // Net carbs are DERIVED from the label's total, fiber and sugar alcohols
  // (netCarbsOf); a stated net figure is never stored as the total.
  if (/^netcarb/.test(w)) return null;
  if (/^(total)?carb/.test(w)) return "carbs";
  if (w === "totalfat" || w === "fat") return "fat";
  if (w === "saturatedfat" || w === "satfat") return "saturatedFat";
  if (w === "transfat") return "transFat";
  if (w === "monounsaturatedfat") return "monoFat";
  if (w === "polyunsaturatedfat") return "polyFat";
  if (w === "fiber" || w === "fibre" || w === "dietaryfiber") return "fiber";
  if (/^sugaralcohol/.test(w)) return "sugarAlcohol";
  if (/^addedsugar/.test(w)) return "addedSugar";
  if (/^(total)?sugar/.test(w)) return "sugar";
  if (w === "sodium" || w === "salt") return "sodium";
  if (w === "folicacid") return "folate";
  if (w === "omega3") return "omega3";
  if (w === "omega6") return "omega6";
  const vitamin = w.match(/^vitamin([a-z]\d{0,2})$/);
  if (vitamin) return canonicalNutrientKey(`vitamin${vitamin[1]}`);
  return canonicalNutrientKey(w);
}

/**
 * Nutrition values the user STATED in their message ("it says 210 calories
 * and 20g protein"). These are the user's data: a lookup may store a label
 * value beside them for comparison but never replaces them.
 *
 * A bare quantity of the food itself is not a nutrition value: "12 oz Coke" is
 * a serving size, "2 eggs" a count — neither matches a nutrient word, so
 * neither lands here.
 */
export function detectUserStatedNutrition(message: string): NutrientVector {
  const out: NutrientVector = {};
  const text = String(message || "");
  if (!text) return out;
  // Reject "grams of X" where X is the food ("12 oz of coffee") — the nutrient
  // word list above only matches nutrient names, so food words never match.
  for (const m of text.matchAll(USER_STATED_RE)) {
    const key = nutrientFromWord(m[3]);
    const v = Number(m[1]);
    if (!key || !isFinite(v)) continue;
    if (PRODUCT_NOUN_AFTER_RE.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    // "2 g carbs" vs "2 cups carbs"? the unit group filters to nutrient units;
    // a unitless number before "protein" ("20 protein") still counts.
    if (out[key] == null) out[key] = v;
  }
  for (const m of text.matchAll(USER_STATED_REVERSED_RE)) {
    const key = nutrientFromWord(m[1]);
    const v = Number(m[2]);
    if (!key || !isFinite(v)) continue;
    if (out[key] == null) out[key] = v;
  }
  return out;
}

/** Did the message read like a label ("it says…")? Purely informational for the summary. */
export function hasStatementCue(message: string): boolean {
  return STATEMENT_CUE_RE.test(String(message || ""));
}

// ─── Components and totals ───────────────────────────────────────────────────

export interface NutritionComponent {
  /** Display name: "Quaker Instant Oatmeal Maple & Brown Sugar". */
  name: string;
  brand?: string;
  /** The user's wording for how much ("1 packet", "a cup"). */
  userQuantity: string;
  normalizedQuantity: QuantityNormalization;
  /** How many of the matched serving this component is (0.5 = half a serving). */
  servings: number;
  /** The serving the matched source's values describe. */
  matchedServing?: { amount: number; unit: string; grams?: number | null; ml?: number | null; label: string };
  /** Which source answered: product database, manufacturer label, reference… */
  sourceType: EnrichmentSourceType;
  source: string;
  /** What the source matched this component to. */
  sourceItem?: string;
  confidence: EnrichmentConfidence;
  /** Per-serving values as the source gives them (before `servings`). */
  perServing: NutrientVector;
  /** This component's contribution (perServing × servings), with provenance. */
  nutrients: Partial<Record<NutrientKey, ProvenancedNutrient>>;
  /** True when the item is a drink — its volume feeds the linked fluid measurement. */
  isBeverage?: boolean;
  /** The user gave no quantity: the serving size is assumed (and said so). */
  servingAssumed?: boolean;
  /** The record behind the figures, so it can be opened or re-read: a USDA FoodData Central id, an Open Food Facts barcode, an internal row. */
  sourceRef?: { provider: "fdc" | "off" | "internal" | "label" | "scan"; id: string; barcode?: string; dataType?: string };
  /** Percent Daily Values as printed on a scanned label (kept as printed, never computed). */
  dailyValues?: Partial<Record<NutrientKey, number>>;
}

export interface LinkedEntryRef {
  trackerId: string;
  entryId: string;
  trackerName: string;
  /** The nutrient the linked tracker received (fluidMl → Hydration, caffeine → Caffeine). */
  nutrient: NutrientKey;
  value: number;
  unit: string;
}

export type NutritionEnrichmentStatus =
  | "pending"    // candidate recorded, lookup not run yet
  | "applied"    // values on the entry were refined from this enrichment
  | "proposed"   // lookup ran; waiting for the user ("ask" mode, or low confidence)
  | "skipped"    // nothing to refine (vague item, or the user turned it off)
  | "failed";    // lookup errored — the base entry stands untouched

export interface NutritionEnrichment {
  version: 1;
  status: NutritionEnrichmentStatus;
  mode: EnrichmentMode;
  specificity: Specificity;
  /** The text the components were read from (the entry's item, plus the message's quantities). */
  sourceText: string;
  components: NutritionComponent[];
  /** The meal total: one calculated value per nutrient present on any component. */
  totals: Partial<Record<NutrientKey, ProvenancedNutrient>>;
  /** Nutrients the user stated themselves. Never overwritten. */
  userProvided: NutrientKey[];
  /** The user's own numbers, kept verbatim beside any source value. */
  userValues: NutrientVector;
  /** The lowest component confidence — what the meal as a whole can claim. */
  confidence: EnrichmentConfidence;
  /** Multiplier applied after the fact ("actually I only ate half" → 0.5). */
  servingFactor: number;
  linkedEntries: LinkedEntryRef[];
  /** One line for the chat card: "Matched Coca-Cola 12 fl oz · 140 kcal · 39 g sugar". */
  summary: string;
  /** Why the lookup stopped, when it did ("vague wording", "no source matched"). */
  reason?: string;
  enrichedAt: string;
  /** The whole entry comes from a label the user read out: nothing it omits is filled in. */
  fromLabel?: boolean;
  /** Verified / reference / estimated, as decided when the entry was written (`verificationOf`). */
  verification?: NutritionVerification;
}

export type EnrichmentMode = "off" | "auto" | "ask";

export const NUTRITION_ENRICHMENT_PREF_KEY = "nutrition_enrichment";

/** Preference string → mode. Anything unknown is the default (automatic). */
export function parseEnrichmentMode(raw: string | null | undefined): EnrichmentMode {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "off" || v === "false" || v === "disabled") return "off";
  if (v === "ask" || v === "ask_when_uncertain" || v === "ask when uncertain") return "ask";
  return "auto";
}

export function scaleNutrients(vec: NutrientVector, factor: number): NutrientVector {
  const out: NutrientVector = {};
  for (const [k, v] of Object.entries(vec) as [NutrientKey, number][]) {
    if (typeof v !== "number" || !isFinite(v)) continue;
    out[k] = roundNutrient(v * factor, k);
  }
  return out;
}

/** Build a component's provenanced contribution from its per-serving values. */
export function componentNutrients(
  perServing: NutrientVector,
  servings: number,
  meta: { source: string; sourceType: EnrichmentSourceType; sourceItem?: string; confidence: EnrichmentConfidence; enrichedAt: string },
): Partial<Record<NutrientKey, ProvenancedNutrient>> {
  const out: Partial<Record<NutrientKey, ProvenancedNutrient>> = {};
  // 12 fl oz is 354.9 ml against a 355 ml can: one serving, not 0.9997 of one.
  const direct = Math.abs(servings - 1) < 0.01;
  for (const [k, v] of Object.entries(perServing) as [NutrientKey, number][]) {
    if (typeof v !== "number" || !isFinite(v)) continue;
    out[k] = {
      value: roundNutrient(v * servings, k),
      unit: NUTRIENT_UNITS[k],
      source: meta.source,
      sourceType: meta.sourceType,
      sourceItem: meta.sourceItem,
      confidence: meta.confidence,
      calculatedOrDirect: direct ? "direct" : "calculated",
      enrichedAt: meta.enrichedAt,
    };
  }
  return out;
}

/**
 * Sum components into meal totals. A total exists for a nutrient when ANY
 * component reports it; a component that lacks a nutrient the others report
 * caps the total's confidence (we do not know that component's share).
 */
export function sumComponentTotals(components: NutritionComponent[], enrichedAt: string): Partial<Record<NutrientKey, ProvenancedNutrient>> {
  const totals: Partial<Record<NutrientKey, ProvenancedNutrient>> = {};
  for (const key of NUTRIENT_KEYS) {
    let sum = 0;
    let any = false;
    let conf: EnrichmentConfidence = "exact";
    let missing = 0;
    for (const c of components) {
      const pv = c.nutrients[key];
      if (pv) { sum += pv.value; any = true; conf = minConfidence(conf, pv.confidence); }
      else missing++;
    }
    if (!any) continue;
    if (missing > 0 && key !== "caffeine" && key !== "fluidMl") conf = minConfidence(conf, "medium");
    totals[key] = {
      value: roundNutrient(sum, key),
      unit: NUTRIENT_UNITS[key],
      source: components.length === 1 ? (components[0].nutrients[key]?.source || "component") : `sum of ${components.length} components`,
      sourceType: components.length === 1 ? (components[0].nutrients[key]?.sourceType || "calculated") : "calculated",
      sourceItem: components.length === 1 ? components[0].sourceItem : undefined,
      confidence: conf,
      calculatedOrDirect: components.length === 1 ? (components[0].nutrients[key]?.calculatedOrDirect || "direct") : "calculated",
      enrichedAt,
    };
  }
  return totals;
}

/**
 * The user's own numbers outrank every source. They replace the total for
 * that nutrient (provenance: user) and are listed in `userProvided`.
 */
export function applyUserProvided(
  totals: Partial<Record<NutrientKey, ProvenancedNutrient>>,
  userValues: NutrientVector,
  enrichedAt: string,
): { totals: Partial<Record<NutrientKey, ProvenancedNutrient>>; userProvided: NutrientKey[] } {
  const out = { ...totals };
  const userProvided: NutrientKey[] = [];
  for (const [k, v] of Object.entries(userValues) as [NutrientKey, number][]) {
    if (typeof v !== "number" || !isFinite(v)) continue;
    userProvided.push(k);
    out[k] = {
      value: v,
      unit: NUTRIENT_UNITS[k],
      source: "stated by the user",
      sourceType: "user",
      confidence: "exact",
      calculatedOrDirect: "direct",
      enrichedAt,
    };
  }
  return { totals: out, userProvided };
}

/** The lowest confidence across components (the meal can claim no more). */
export function overallConfidence(components: NutritionComponent[]): EnrichmentConfidence {
  if (components.length === 0) return "low";
  return components.reduce<EnrichmentConfidence>((acc, c) => minConfidence(acc, c.confidence), "exact");
}

/**
 * The patch to write onto the entry's `values`: the core nutrient totals,
 * never a key the user stated (those keep the user's number), never a key the
 * base extraction already carries when enrichment has nothing better than a
 * model estimate for it (the base estimate IS a model estimate — replacing one
 * guess with another is churn, not precision).
 */
export function buildEntryValuePatch(
  existingValues: Record<string, any>,
  enrichment: Pick<NutritionEnrichment, "totals" | "userProvided" | "userValues">,
): Record<string, number> {
  const patch: Record<string, number> = {};
  for (const key of ENTRY_VALUE_NUTRIENTS) {
    const total = enrichment.totals[key];
    if (enrichment.userProvided.includes(key)) {
      const uv = enrichment.userValues[key];
      if (typeof uv === "number") patch[key] = uv;
      continue;
    }
    if (!total) continue;
    if (key === "caffeine" && total.value <= 0) continue;
    const existing = existingValues[key];
    const existingNum = typeof existing === "number" ? existing : typeof existing === "string" ? parseFloat(existing) : NaN;
    if (total.sourceType === "model_estimate" && isFinite(existingNum) && existingNum > 0) continue;
    patch[key] = total.value;
  }
  return patch;
}

/** Nutrient-keyed values currently on the entry (alias-aware). */
export function nutrientValuesOf(values: Record<string, any> | null | undefined): NutrientVector {
  const out: NutrientVector = {};
  for (const [k, v] of Object.entries(values || {})) {
    const key = canonicalNutrientKey(k);
    if (!key) continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
    if (isFinite(n)) out[key] = n;
  }
  return out;
}

/**
 * "Actually I only ate half": scale every component, recompute totals, keep
 * the user's stated values scaled too (they described the whole item), and
 * record the cumulative factor. Pure — the server writes the result.
 */
export function rescaleEnrichment(enrichment: NutritionEnrichment, factor: number, now: string): NutritionEnrichment {
  if (!isFinite(factor) || factor <= 0) return enrichment;
  const components = enrichment.components.map((c) => {
    const servings = c.servings * factor;
    return {
      ...c,
      servings,
      nutrients: componentNutrients(c.perServing, servings, { source: c.source, sourceType: c.sourceType, sourceItem: c.sourceItem, confidence: c.confidence, enrichedAt: now }),
    };
  });
  const userValues = scaleNutrients(enrichment.userValues, factor);
  const summed = sumComponentTotals(components, now);
  const { totals, userProvided } = applyUserProvided(summed, userValues, now);
  return {
    ...enrichment,
    components,
    totals,
    userProvided,
    userValues,
    servingFactor: roundNutrient(enrichment.servingFactor * factor) || enrichment.servingFactor * factor,
    linkedEntries: enrichment.linkedEntries.map((l) => ({ ...l, value: roundNutrient(l.value * factor, l.nutrient) })),
    summary: summarizeEnrichment({ ...enrichment, components, totals }),
    enrichedAt: now,
  };
}

/** Values for a plain nutrition entry (no component data) scaled by a factor. */
export function rescalePlainValues(values: Record<string, any>, factor: number): Record<string, number> {
  const patch: Record<string, number> = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!canonicalNutrientKey(k)) continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
    if (!isFinite(n)) continue;
    patch[k] = roundNutrient(n * factor, canonicalNutrientKey(k) || undefined);
  }
  return patch;
}

// ─── Linked measurements ─────────────────────────────────────────────────────

export interface LinkedMeasurement {
  nutrient: NutrientKey;
  value: number;
  unit: string;
  /** Tracker shapes / name patterns this measurement belongs on. */
  trackerPatterns: RegExp;
  /** The field written on that tracker. */
  field: string;
  /** Convert the nutrient value into the tracker's field value. */
  toFieldValue: (v: number) => number;
}

/**
 * What else one source item moves: a 12 oz Coke is 355 ml of fluid and 34 mg
 * of caffeine. Only trackers the user ALREADY has receive these (the server
 * decides); this just names them. Hydration gets volume only for beverages.
 */
export function linkedMeasurementsFor(enrichment: Pick<NutritionEnrichment, "totals" | "components">): LinkedMeasurement[] {
  const out: LinkedMeasurement[] = [];
  const anyBeverage = enrichment.components.some((c) => c.isBeverage);
  const fluid = enrichment.totals.fluidMl;
  if (anyBeverage && fluid && fluid.value > 0) {
    out.push({
      nutrient: "fluidMl", value: fluid.value, unit: "ml",
      trackerPatterns: /\b(water|hydration|fluids?)\b/i,
      field: "amount",
      toFieldValue: (ml) => Math.round((ml / ML_PER_FL_OZ) * 10) / 10,
    });
  }
  const caff = enrichment.totals.caffeine;
  if (caff && caff.value > 0) {
    out.push({
      nutrient: "caffeine", value: caff.value, unit: "mg",
      trackerPatterns: /\bcaffeine\b/i,
      field: "amount",
      toFieldValue: (mg) => Math.round(mg),
    });
  }
  return out;
}

/** The key a linked entry carries so a delete of the source finds it. */
export const LINKED_SOURCE_KEY = "_sourceEntryId";

// ─── Decision + presentation ─────────────────────────────────────────────────

export interface EnrichmentDecision {
  attempt: boolean;
  reason: string;
}

/**
 * Should the lookup run at all? Off → never. Vague wording ("some fruit") →
 * no: there is nothing a database could match, the generic estimate stands.
 * Everything else is worth a bounded, asynchronous attempt — "2 eggs" matches
 * the internal reference in microseconds and never reaches the network.
 */
export function decideEnrichment(mode: EnrichmentMode, specificity: Specificity, item: string): EnrichmentDecision {
  if (mode === "off") return { attempt: false, reason: "Enhanced Nutrition Lookup is off" };
  if (!String(item || "").trim()) return { attempt: false, reason: "no item named" };
  if (specificity.level === "vague") return { attempt: false, reason: "vague wording — generic estimate kept" };
  return { attempt: true, reason: `${specificity.level}-level item` };
}

/** Whether an enrichment of this confidence applies by itself in the given mode. */
export function appliesAutomatically(mode: EnrichmentMode, confidence: EnrichmentConfidence): boolean {
  if (mode === "off") return false;
  if (mode === "ask") return confidence === "exact";
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK.medium;
}

export function formatNutrient(key: NutrientKey, value: number): string {
  const unit = NUTRIENT_UNITS[key];
  const v = roundNutrient(value, key);
  return unit === "kcal" ? `${v} kcal` : `${v} ${unit}`;
}

export const CONFIDENCE_LABEL: Record<EnrichmentConfidence, string> = {
  exact: "exact product match", high: "close product match", medium: "generic estimate", low: "rough estimate",
};

/**
 * Verified or estimated, in one word pair. Verified: the figures are a
 * label's (the maker's, a menu's, or one the user read out) for the amount
 * the user stated. Reference: a standard reference food. Estimated: anything
 * the app or the model assumed (a serving size, a generic stand-in).
 */
export type NutritionVerification = "verified" | "reference" | "estimated";
export function verificationOf(e: Pick<NutritionEnrichment, "components" | "confidence">): NutritionVerification {
  if (e.components.length === 0) return "estimated";
  if (e.components.some((c) => c.sourceType === "model_estimate" || c.sourceType === "default" || c.confidence === "low")) return "estimated";
  const labelled = e.components.every((c) => c.sourceType === "user" || c.sourceType === "manufacturer" || c.sourceType === "restaurant" || c.sourceType === "product_database");
  if (labelled) return e.components.some((c) => c.servingAssumed) ? "estimated" : "verified";
  return e.components.some((c) => c.servingAssumed || c.confidence === "medium") ? "estimated" : "reference";
}
export const VERIFICATION_LABEL: Record<NutritionVerification, string> = {
  verified: "Verified", reference: "Reference values", estimated: "Estimated",
};

/** Source words for a card or a chat line: "manufacturer label", "restaurant menu", "product database", "standard reference", "AI estimate". */
export const SOURCE_TYPE_LABEL: Record<EnrichmentSourceType, string> = {
  user: "the label you gave", manufacturer: "manufacturer label", restaurant: "restaurant menu", product_database: "product database",
  reference: "standard reference", model_estimate: "AI estimate", calculated: "calculated", default: "generic estimate",
};

/** The sources behind an enrichment, de-duplicated, for "Source: …". */
export function describeSources(e: Pick<NutritionEnrichment, "components">): string {
  const seen = new Set<string>();
  for (const c of e.components) seen.add(SOURCE_TYPE_LABEL[c.sourceType] || c.sourceType);
  return Array.from(seen).join(" + ");
}

/**
 * One chat line for a refined entry: "Kellogg's Special K Red Berries, 2
 * servings — 280 kcal, 6 g protein, 68 g carbs, 1 g fat". The recap shows
 * this instead of the agent's placeholder numbers.
 */
export function recapLine(e: Pick<NutritionEnrichment, "components" | "totals">): string {
  const who = e.components.map((c) => `${c.sourceItem || c.name} (${componentAmount(c)}${c.servingAssumed ? ", size assumed" : ""})`).join(" + ");
  const parts: string[] = [];
  const t = e.totals;
  const g = (key: NutrientKey, word: string) => { const v = t[key]; if (v) parts.push(`${roundNutrient(v.value, key)} g ${word}`); };
  if (t.calories) parts.push(`${roundNutrient(t.calories.value, "calories")} kcal`);
  g("protein", "protein");
  g("carbs", "carbs");
  g("fat", "fat");
  // Named when the source states them and they are not nil: fiber and sugar
  // alcohols are why a label's calories differ from 4/4/9 arithmetic.
  for (const [key, word] of [["fiber", "fiber"], ["sugarAlcohol", "sugar alcohol"], ["sugar", "sugar"]] as Array<[NutrientKey, string]>) {
    const v = t[key];
    if (v && v.value > 0) parts.push(`${roundNutrient(v.value, key)} g ${word}`);
  }
  if (t.sodium && t.sodium.value > 0) parts.push(`${roundNutrient(t.sodium.value, "sodium")} mg sodium`);
  if (t.caffeine && t.caffeine.value > 0) parts.push(`${roundNutrient(t.caffeine.value, "caffeine")} mg caffeine`);
  return parts.length ? `${who} — ${parts.join(", ")}` : who;
}

/**
 * How much of a component was eaten, in the terms the user gave: the weight
 * or volume when they stated one ("225 g"), otherwise a count of the matched
 * serving ("1.5 × 1 bar (60 g)"), and for a label they read out, the
 * arithmetic that was done ("75 grams ÷ 40 grams per label").
 */
export function componentAmount(c: Pick<NutritionComponent, "servings" | "matchedServing" | "normalizedQuantity" | "sourceType" | "userQuantity">): string {
  if (c.sourceType === "user" && c.userQuantity) return c.userQuantity;
  const q = c.normalizedQuantity;
  const trim = (n: number) => String(Math.round(n * 100) / 100);
  const stated = q && q.confidence === "high" && !q.assumption;
  if (stated && q.grams != null && c.matchedServing?.grams) return `${trim(q.grams)} g`;
  if (stated && q.ml != null && c.matchedServing?.ml && /^(ml|l|fl oz|oz|floz|milliliters?|liters?)$/.test(String(q.unit || ""))) {
    return /^(ml|milliliters?)$/.test(String(q.unit)) ? `${trim(q.ml)} ml` : `${trim(q.amount ?? 0)} ${q.unit}`;
  }
  const n = Math.round(c.servings * 100) / 100;
  const unit = c.matchedServing?.label || "serving";
  return n === 1 ? unit : `${n} × ${unit}`;
}

export function summarizeEnrichment(e: Pick<NutritionEnrichment, "components" | "totals">): string {
  const names = e.components.map((c) => c.sourceItem || c.name).filter(Boolean);
  const head = names.length === 0 ? "No match" : names.length === 1 ? `Matched ${names[0]}` : `${names.length} items: ${names.join(" + ")}`;
  const parts: string[] = [];
  for (const key of ["calories", "protein", "carbs", "fat", "sugar", "sodium", "caffeine"] as NutrientKey[]) {
    const t = e.totals[key];
    if (t && (t.value > 0 || key === "calories")) parts.push(formatNutrient(key, t.value));
  }
  return parts.length ? `${head} · ${parts.join(" · ")}` : head;
}

/** Is this tracker the profile's Nutrition tracker (any of its names)? */
export function isNutritionTrackerLike(t: { name?: string | null; category?: string | null } | null | undefined): boolean {
  if (!t) return false;
  if (String(t.category || "").toLowerCase() === "nutrition") return true;
  // The WHOLE name must be one of the tracker's usual names ("Nutrition",
  // "Calories", "Food Log"): a "Dog Food" feeding tracker is not it.
  return /^\s*(daily |weekly |my )?(nutrition|nutrients?|calorie counter|calories?|caloric intake|diet|macros?|macro tracker|food log|food diary|food journal|food tracker|meal log|meal tracker|meals?|eating|nutrition tracker)\s*$/i.test(String(t.name || ""));
}

/** A dish whose "with …" names an ingredient already inside it, not a second food. */
const COMPOSED_DISH_RE = /\b(smoothie|shake|milkshake|salad|bowl|sandwich|sub|burger|cheeseburger|burrito|wrap|taco|tacos|pizza|soup|stew|chili|curry|omelet|omelette|parfait|casserole|pasta|noodles|ramen|sushi|quesadilla|nachos|latte|frappuccino)\b/i;

/** A fragment made only of preparation / state words and, at most, an amount. */
const STATE_WORD = "raw|uncooked|cooked|dry|dried|fresh|frozen|thawed|canned|roasted|grilled|baked|boiled|steamed|fried|sauteed|sautéed|poached|scrambled|plain|black|unsweetened|sweetened|unsalted|salted|skinless|boneless|peeled|unpeeled|drained|rinsed|prepared|weighed|weight|before|after|cooking|cooked|with|without|the|peel|skin|on|including|included|only|whole|flesh|edible|portion|net|gross";
const STATE_ONLY_RE = new RegExp(`^(?:(?:${STATE_WORD}|\\d+(?:\\.\\d+)?\\s*(?:g|grams?|kg|oz|ounces?|lbs?|ml|l|fl oz|cups?|tbsp|tsp)?)\\s*)+$`, "i");
/** "dry (100 g)", "raw", "cooked, drained": says how the food before it was prepared or weighed, and names no food. */
export function isStateOnlyFragment(text: string): boolean {
  return STATE_ONLY_RE.test(String(text || "").replace(/[()~,]/g, " ").replace(/\s+/g, " ").trim());
}

/**
 * The state the user weighed the food in, when it changes the numbers: raw
 * meat and dry grains are far denser than cooked. "raw" for raw / uncooked /
 * dry / "weighed before cooking"; null when nothing was said (the cooked
 * reference then stands, as the form the food is eaten in).
 */
export function rawStateOf(text: string): "raw" | null {
  const t = String(text || "").toLowerCase();
  if (/\b(dry[- ]roasted|dry rub|dry aged|dry wine|extra dry)\b/.test(t)) return null;
  return /\b(raw|uncooked|dry|pre-?cooked weight|before (?:cooking|it was cooked|i cooked)|prior to cooking|weighed raw|raw weight|dry weight)\b/.test(t) ? "raw" : null;
}

/** Split a composed item into component phrases: "eggs, toast with butter, a banana and coffee with creamer". */
export function splitComponentPhrases(text: string): string[] {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  // A parenthetical belongs to its item: "Gatorade (half bottle, ~16 oz)" is
  // one food, so its comma is not a separator. Separators are found at depth 0.
  const topLevel = (s: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && /[,;+!?]/.test(ch)) { out.push(cur); cur = ""; continue; }
      if (depth === 0 && ch === "." && !/\d/.test(s[i + 1] || "")) { out.push(cur); cur = ""; continue; }
      if (depth === 0 && /\s/.test(ch)) {
        const rest = s.slice(i + 1);
        const m = rest.match(/^(and|plus|along with)\b/i);
        // "one and a half bars" is one amount, not two foods.
        const amountJoin = /^and\s+(?:(?:a|an|one)\s+)?(half|quarter|third|three quarters|two thirds)\b/i.test(rest);
        if (m && !amountJoin) { out.push(cur); cur = ""; i += m[0].length; continue; }
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  };
  // "X with Y" keeps Y as its own component (butter on toast, creamer in coffee)
  // but "with" inside a product name ("Oatmeal with Honey & Almonds") does not
  // split: only split on " with " when what follows is a plain food word
  // phrase of ≤3 words that itself is not capitalized like a product.
  const parts = topLevel(t)
    .flatMap((p) => {
      // "toast with butter" / "oatmeal with 1 cup of 2% milk" / "Wheat Toast
      // with Butter (2 slices)" split into the base item and what was added to
      // it. A composed dish keeps its "with" (the yogurt in "Smoothie with
      // Greek Yogurt" is an ingredient, not a second food), and so does a
      // long Title-Case tail, which reads as a product name. A trailing
      // parenthetical quantity on the tail belongs to the head when the head
      // has none ("(2 slices)" counts the toast, not the butter).
      const m = p.match(/^(.*?)\s+with\s+(.{1,40}?)\s*(\([^)]*\))?$/);
      if (m) {
        const head = m[1].trim();
        const tail = m[2].trim();
        const paren = m[3] || "";
        const tailWords = tail.split(/\s+/);
        const capitalizedTail = /[A-Z]/.test(tail.slice(1)) || /^[A-Z]/.test(tail);
        const composedDish = COMPOSED_DISH_RE.test(head);
        const ok = !composedDish && (capitalizedTail ? tailWords.length <= 2 : tailWords.length <= 5);
        if (ok) {
          const headHasQty = /\d|\b(a|an|half|one|two|three)\b/i.test(head);
          return [paren && !headHasQty ? `${head} ${paren}` : head, paren && headHasQty ? `${tail} ${paren}` : tail];
        }
      }
      return [p.trim()];
    })
    .map((p) => p.replace(/^(i\s+)?(ate|had|drank|took|got|ordered|grabbed)\s+/i, "").trim())
    .filter((p) => p && !/^(a|an|the|some|also|then|too)$/i.test(p));
  // "White rice, dry" / "Chicken breast, raw, 200 g": a fragment that only
  // says how the food was prepared or weighed is part of the food before it,
  // never a second food to look up ("dry" matched nothing and the whole entry
  // was left as an estimate).
  const merged: string[] = [];
  for (const p of parts) {
    if (merged.length > 0 && isStateOnlyFragment(p)) merged[merged.length - 1] = `${merged[merged.length - 1]}, ${p}`;
    else merged.push(p);
  }
  return merged;
}
