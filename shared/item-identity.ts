// ─── Item Identity Layer (pure) ──────────────────────────────────────────────
//
// The nutrition enrichment (shared/nutrition-enrichment) refines a food from a
// product match. This module is the same idea for EVERY item a person names in
// chat — a medication, a supplement, a pet food, a vehicle, a device, an
// appliance, a subscription plan, an account, a consumable — and answers the
// three questions the server orchestrator (server/item-enrichment.ts) asks:
//
//   1. What KIND of item is this, from the words and where it was logged?
//   2. How SPECIFIC is the mention?  "my car" (generic) · "Honda" (category)
//      · "Honda CR-V" (model) · "2021 Honda CR-V EX AWD" (exact)
//   3. Which ATTRIBUTES does identity materially change for that kind?
//      Only those are ever enriched (ITEM_ATTRIBUTE_POLICY) — MPG and tank
//      size for a vehicle, strength and active ingredient for a medication,
//      never a field that does not change how the thing is tracked.
//
// Plus the one domain where the arithmetic is deterministic enough to live
// here: over-the-counter medication identity and dose. A product family is
// identified from the brand ("Advil" → ibuprofen); a strength is taken only
// when the user stated it or the product has exactly one common strength —
// an ambiguous one ("Tylenol": 325/500/650 mg) is preserved as ambiguous,
// never guessed.
//
// Save-first stays the rule: nothing here is needed to save the entry.
// Pinned by tests/item-identity.test.ts.

import type { EnrichmentConfidence, EnrichmentMode, EnrichmentSourceType } from "./nutrition-enrichment";
import { CONFIDENCE_RANK, minConfidence } from "./nutrition-enrichment";

export type { EnrichmentConfidence, EnrichmentMode, EnrichmentSourceType };

// ─── Kinds ───────────────────────────────────────────────────────────────────

export type ItemKind =
  | "food" | "beverage"
  | "medication" | "supplement"
  | "pet_food"
  | "vehicle" | "device" | "wearable" | "appliance"
  | "subscription" | "account"
  | "consumable"
  | "other";

export interface ItemContext {
  trackerName?: string | null;
  trackerCategory?: string | null;
  profileType?: string | null;
  obligationCategory?: string | null;
}

const MEDICATION_WORDS = /\b(advil|motrin|ibuprofen|tylenol|acetaminophen|aleve|naproxen|aspirin|excedrin|benadryl|diphenhydramine|zyrtec|cetirizine|claritin|loratadine|allegra|fexofenadine|pepcid|famotidine|prilosec|omeprazole|nexium|tums|mucinex|sudafed|nyquil|dayquil|pepto|imodium|dramamine|melatonin|lisinopril|metformin|atorvastatin|amlodipine|prednisone|amoxicillin|gabapentin|adderall|ozempic|insulin|zoloft|lexapro|prozac|xanax|ambien|pill|pills|tablet|tablets|capsule|capsules|\d+\s*mg)\b/i;
const SUPPLEMENT_WORDS = /\b(fish oil|omega[- ]?3|multivitamin|vitamin [a-z]\d?|vitamin|creatine|magnesium|zinc|probiotic|biotin|collagen|glucosamine|turmeric|ashwagandha|supplement|softgel|softgels|gummy|gummies|whey|protein powder|electrolyte|nature made|centrum|one a day|garden of life|optimum nutrition|thorne|now foods|nordic naturals)\b/i;
const PET_FOOD_WORDS = /\b(purina|pro plan|royal canin|hill'?s|science diet|blue buffalo|iams|pedigree|kibble|dog food|cat food|wet food|dry food|fancy feast|orijen|acana|taste of the wild|wellness core|merrick|nutro|friskies)\b/i;
const VEHICLE_WORDS = /\b(honda|toyota|ford|chevy|chevrolet|tesla|bmw|audi|mercedes|lexus|subaru|mazda|nissan|hyundai|kia|jeep|ram|gmc|dodge|volkswagen|vw|volvo|porsche|rivian|lucid|acura|infiniti|cadillac|buick|lincoln|chrysler|mini|fiat|mitsubishi|genesis|polestar|civic|accord|cr-v|crv|camry|corolla|rav4|tacoma|tundra|f-150|f150|silverado|model [3sxy]|mustang|wrangler|outback|forester|car|truck|suv|sedan|minivan|motorcycle|vehicle|mpg|awd|4wd)\b/i;
const WEARABLE_WORDS = /\b(garmin|forerunner|fenix|venu|fitbit|whoop|oura|apple watch|galaxy watch|pixel watch|polar|coros|smartwatch|fitness tracker)\b/i;
const DEVICE_WORDS = /\b(macbook|imac|mac mini|ipad|iphone|airpods|pixel|galaxy|surface|thinkpad|dell|hp|lenovo|asus|acer|chromebook|laptop|desktop|monitor|tablet|phone|smartphone|camera|playstation|ps5|xbox|nintendo|switch|kindle|gpu|rtx|ssd|tb\b|gb\b|m[1-4]\s*(pro|max|ultra)?\b)\b/i;
const APPLIANCE_WORDS = /\b(dyson|roomba|irobot|shark|bissell|vacuum|kitchenaid|vitamix|ninja|instant pot|keurig|nespresso|breville|cuisinart|whirlpool|samsung|lg|ge|bosch|miele|frigidaire|maytag|washer|dryer|dishwasher|refrigerator|fridge|microwave|oven|air fryer|blender|espresso machine|water heater|furnace|hvac|thermostat|nest|ecobee|air purifier|humidifier|dehumidifier|generator|mower|lawn mower|grill|traeger|weber)\b/i;
const CONSUMABLE_WORDS = /\b(filter|filters|merv|cartridge|cartridges|toner|ink|batteries|battery pack|light ?bulb|bulbs|blade|blades|razor|contact lenses|contacts|toothbrush head|brush head|wiper blades|oil filter|air filter|water filter|bag of|bags)\b/i;
const SUBSCRIPTION_WORDS = /\b(netflix|hulu|disney\+|disney plus|hbo|max|spotify|apple music|apple tv|apple one|icloud|youtube premium|youtube tv|amazon prime|prime video|paramount\+|peacock|audible|kindle unlimited|xbox game pass|playstation plus|nintendo online|adobe|creative cloud|microsoft 365|office 365|google one|dropbox|chatgpt|claude pro|notion|canva|peloton|strava|headspace|calm|duolingo|nyt|new york times|wsj|substack|patreon|gym membership|planet fitness|equinox|subscription|plan|premium|standard plan|basic plan|family plan|tier)\b/i;
const ACCOUNT_WORDS = /\b(chase|sapphire|freedom|amex|american express|platinum card|gold card|capital one|venture|quicksilver|savor|citi|double cash|discover it|wells fargo|bank of america|bofa|us bank|ally|marcus|sofi|fidelity|vanguard|schwab|robinhood|coinbase|credit card|checking|savings|brokerage|401k|401\(k\)|ira|roth|hysa|money market|cd\b|visa|mastercard)\b/i;
const FOOD_WORDS = /\b(ate|eat|eating|meal|breakfast|lunch|dinner|snack|calories|protein|carbs|oatmeal|cereal|sandwich|salad|pizza|burger|chicken|eggs?|toast|banana|apple|yogurt|bar)\b/i;
const BEVERAGE_WORDS = /\b(drank|drink|coffee|latte|tea|coke|pepsi|soda|juice|water|beer|wine|monster|red bull|celsius|gatorade|smoothie|shake|milk)\b/i;

/** Which kind of item the words (and where they landed) describe. */
export function inferItemKind(text: string, ctx: ItemContext = {}): ItemKind {
  const t = String(text || "");
  const cat = String(ctx.trackerCategory || "").toLowerCase();
  const tn = String(ctx.trackerName || "").toLowerCase();
  const pt = String(ctx.profileType || "").toLowerCase();
  const oc = String(ctx.obligationCategory || "").toLowerCase();

  // Where it was logged is the strongest signal.
  if (pt === "vehicle") return "vehicle";
  if (pt === "subscription" || oc === "subscription" || oc === "streaming" || oc === "software") return "subscription";
  if (pt === "account") return "account";
  if (cat === "nutrition") return BEVERAGE_WORDS.test(t) && !FOOD_WORDS.test(t) ? "beverage" : "food";
  if (cat === "medication" || /\b(medication|medications|meds?|prescription|rx)\b/.test(tn)) {
    return SUPPLEMENT_WORDS.test(t) || SUPPLEMENT_WORDS.test(tn) ? "supplement" : "medication";
  }
  if (/\b(supplement|supplements|vitamins?)\b/.test(tn)) return "supplement";
  if (/\b(dog|cat|pet|puppy|kitten)\b.*\b(food|feeding|meals?|kibble)\b|\b(feeding|kibble)\b/.test(tn) || pt === "pet" && PET_FOOD_WORDS.test(t)) return "pet_food";

  // Then the words themselves, most specific vocabularies first.
  if (PET_FOOD_WORDS.test(t)) return "pet_food";
  if (WEARABLE_WORDS.test(t)) return "wearable";
  if (SUPPLEMENT_WORDS.test(t)) return "supplement";
  if (MEDICATION_WORDS.test(t)) return "medication";
  if (CONSUMABLE_WORDS.test(t)) return "consumable";
  if (ACCOUNT_WORDS.test(t)) return "account";
  if (SUBSCRIPTION_WORDS.test(t)) return "subscription";
  if (VEHICLE_WORDS.test(t)) return "vehicle";
  if (APPLIANCE_WORDS.test(t)) return "appliance";
  if (DEVICE_WORDS.test(t)) return "device";
  if (pt === "asset") return "device";
  if (BEVERAGE_WORDS.test(t) && !FOOD_WORDS.test(t)) return "beverage";
  if (FOOD_WORDS.test(t)) return "food";
  return "other";
}

// ─── Specificity ─────────────────────────────────────────────────────────────

/**
 * generic  — "my car", "pain medicine", "a protein bar"
 * category — a brand or family: "Honda", "Advil", "Purina"
 * model    — brand + product line: "Honda CR-V", "Dyson V15", "Netflix"
 * exact    — enough to pin one SKU/configuration: "2021 Honda CR-V EX AWD",
 *            "Advil 200 mg", "MacBook Air M3 15-inch", "Netflix Premium",
 *            "20x25x1 MERV 13"
 */
export type ItemSpecificityLevel = "generic" | "category" | "model" | "exact";

export interface ItemSpecificity {
  level: ItemSpecificityLevel;
  signals: string[];
}

export const SPECIFICITY_RANK: Record<ItemSpecificityLevel, number> = { generic: 0, category: 1, model: 2, exact: 3 };

const YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)\b/;
const TRIM_RE = /\b(ex|ex-l|lx|sport|touring|limited|platinum|premium|se|sel|le|xle|xse|trd|sr5|lariat|xlt|raptor|denali|rubicon|sahara|long range|performance|plaid|standard range|awd|4wd|fwd|rwd|hybrid|plug-in|phev|turbo|v6|v8|crew cab|supercrew)\b/i;
const SIZE_CAPACITY_RE = /\b\d+(?:\.\d+)?\s*(?:-|\s)?(?:inch|in\b|"|gb|tb|mah|wh|kwh|oz|ml|lb|lbs|kg|gal|gallon|liter|l\b|qt|ft|cc|hp|watt|w\b|kw|mg|mcg|iu|ct|count|pack|tablets?|capsules?|softgels?)\b/i;
const STRENGTH_RE = /\b\d+(?:\.\d+)?\s*(mg|mcg|g|iu|ml|%)\b/i;
const DIMENSIONS_RE = /\b\d+\s*x\s*\d+(?:\s*x\s*\d+)?\b/i;
// A product GRADE ("MERV 13", "SEER 16"), not a model number: "V15" and "M3"
// name a model line and stay at model level unless a size/variant joins them.
const RATING_RE = /\bmerv\s*\d+|\bseer\s*\d+|\bclass\s*[a-z0-9]+|\bgen(?:eration)?\s*\d+/i;
const PLAN_TIER_RE = /\b(premium|standard|basic|plus|pro|max|ultimate|family|student|ad-free|with ads|individual|duo|annual plan|monthly plan|tier)\b/i;
const CARD_PRODUCT_RE = /\b(sapphire (preferred|reserve)|freedom (unlimited|flex)|platinum card|gold card|venture x|venture|quicksilver|savor ?one|double cash|discover it|blue cash|delta skymiles|amex everyday|prime visa|apple card|bilt)\b/i;
const FLAVOR_VARIANT_RE = /\b(salmon|chicken|lamb|beef|turkey|sensitive (skin|stomach)|weight management|large breed|small breed|puppy|kitten|senior|adult|indoor|grain[- ]free|high protein|original|unscented|extra strength|regular strength|pm\b|children'?s|infant|liqui-gels|gelcaps|chewable|extended release|xr|er\b|24hr|12hr)\b/i;
const MODEL_TOKEN_RE = /\b(cr-v|crv|hr-v|civic|accord|pilot|odyssey|camry|corolla|rav4|highlander|tacoma|tundra|prius|4runner|sienna|f-150|f150|explorer|escape|bronco|mustang|silverado|equinox|tahoe|suburban|model [3sxy]|cybertruck|outback|forester|crosstrek|wrangler|grand cherokee|cx-5|cx-50|mazda3|rogue|altima|elantra|tucson|santa fe|sorento|telluride|sportage|macbook (air|pro)|imac|mac mini|ipad (pro|air|mini)|iphone \d+|pixel \d+|galaxy s\d+|surface (pro|laptop)|thinkpad [a-z]\d+|forerunner \d+|fenix \d+|venu \d+|charge \d+|versa \d+|v\d{1,2}(?: detect| absolute)?|roomba [a-z]?\d+|airpods( pro| max)?|apple watch( ultra| series \d+)?|kindle (paperwhite|oasis|scribe)|ps5|xbox series [sx]|switch( oled| 2)?|pro plan|science diet|royal canin|blue buffalo|fish oil|multivitamin|sapphire|freedom|venture|quicksilver|netflix|hulu|spotify|disney\+|hbo max|youtube premium|apple music|prime|audible|peloton)\b/i;
const BRAND_RE = new RegExp([
  VEHICLE_WORDS.source, WEARABLE_WORDS.source, DEVICE_WORDS.source, APPLIANCE_WORDS.source, SUBSCRIPTION_WORDS.source,
  ACCOUNT_WORDS.source, PET_FOOD_WORDS.source, SUPPLEMENT_WORDS.source, MEDICATION_WORDS.source,
].map((s) => s.replace(/^\\b\(|\)\\b$/g, "")).join("|"), "i");
const GENERIC_ONLY_RE = /^\s*(my|a|an|the|some|our)?\s*(car|truck|vehicle|suv|phone|laptop|computer|tv|television|vacuum|watch|pain (medicine|meds|reliever|killer)|medicine|meds|medication|pill|pills|vitamins?|supplement|dog food|cat food|pet food|food|subscription|credit card|bank account|account|filter|streaming service)\s*$/i;

/** How precisely the mention pins down the item. */
export function classifyItemSpecificity(text: string, kind: ItemKind = "other"): ItemSpecificity {
  const t = String(text || "").trim();
  const signals = new Set<string>();
  if (!t) return { level: "generic", signals: [] };
  if (GENERIC_ONLY_RE.test(t)) return { level: "generic", signals: [] };

  if (YEAR_RE.test(t) && (kind === "vehicle" || kind === "device" || VEHICLE_WORDS.test(t))) signals.add("year");
  if (TRIM_RE.test(t) && (kind === "vehicle" || VEHICLE_WORDS.test(t))) signals.add("trim");
  if (SIZE_CAPACITY_RE.test(t)) signals.add("size");
  if (STRENGTH_RE.test(t) && (kind === "medication" || kind === "supplement")) signals.add("strength");
  if (DIMENSIONS_RE.test(t)) signals.add("dimensions");
  if (RATING_RE.test(t)) signals.add("rating");
  if (PLAN_TIER_RE.test(t) && (kind === "subscription")) signals.add("plan");
  if (CARD_PRODUCT_RE.test(t)) signals.add("product");
  if (FLAVOR_VARIANT_RE.test(t) && (kind === "pet_food" || kind === "medication" || kind === "supplement" || kind === "consumable")) signals.add("variant");
  if (MODEL_TOKEN_RE.test(t)) signals.add("model");
  // Title-Case runs of two+ words read as a proper product name.
  if (/(?:^|\s)[A-Z][\w'&+-]+(?:\s+[A-Z][\w'&+-]+)+/.test(t.replace(/^I\s+/, ""))) signals.add("proper_name");
  if (BRAND_RE.test(t)) signals.add("brand");
  // A count is a quantity, not identity, but it is a signal the server uses for dose math.
  if (/\b(\d+|one|two|three|four|five|six|a couple of|half)\s+(tablets?|capsules?|softgels?|pills?|gummies|scoops?|cups?|cans?|bottles?|bars?|packets?)\b/i.test(t)) signals.add("count");

  const s = Array.from(signals);
  const has = (x: string) => signals.has(x);
  const exactSignal = has("year") && (has("model") || has("trim")) || (has("trim") && has("model")) || has("strength") || has("plan") || has("product")
    || has("dimensions") || (has("rating") && (has("model") || has("brand") || has("dimensions"))) || (has("size") && (has("model") || has("brand")))
    || (has("variant") && (has("model") || has("brand")));
  if (exactSignal) return { level: "exact", signals: s };
  if (has("model") || (has("brand") && has("proper_name")) || (has("proper_name") && kind !== "food" && kind !== "beverage" && kind !== "other")) return { level: "model", signals: s };
  if (has("brand") || has("proper_name")) return { level: "category", signals: s };
  return { level: "generic", signals: s };
}

// ─── Attribute policy: what identity materially changes ──────────────────────

export type TrackingEffect =
  | "quantity" | "measurement" | "dosage" | "price" | "value" | "lifespan" | "expiration" | "maintenance"
  | "compatibility" | "performance" | "safety" | "recurring_cost" | "energy" | "calories" | "specifications"
  | "replacement_timing" | "calculations" | "recommendations";

export interface AttributeSpec {
  key: string;
  label: string;
  unit?: string;
  type: "number" | "text" | "boolean" | "list";
  /** Why identity matters for this attribute — the user-facing justification. */
  effect: TrackingEffect;
}

/**
 * The attributes the layer may fill per kind. Nothing outside this list is
 * ever written, however much a source knows — a field that does not change
 * how the item is tracked is noise, not enrichment.
 */
export const ITEM_ATTRIBUTE_POLICY: Record<ItemKind, AttributeSpec[]> = {
  food: [],       // handled by shared/nutrition-enrichment
  beverage: [],   // handled by shared/nutrition-enrichment
  medication: [
    { key: "activeIngredient", label: "Active ingredient", type: "text", effect: "safety" },
    { key: "strengthMg", label: "Strength", unit: "mg", type: "number", effect: "dosage" },
    { key: "form", label: "Form", type: "text", effect: "dosage" },
    { key: "doseUnit", label: "Dose unit", type: "text", effect: "dosage" },
    { key: "unitCount", label: "Units taken", type: "number", effect: "quantity" },
    { key: "totalDoseMg", label: "Total dose", unit: "mg", type: "number", effect: "dosage" },
    { key: "maxDailyMg", label: "Max per day (OTC label)", unit: "mg", type: "number", effect: "safety" },
    { key: "doseIntervalHours", label: "Dose interval", unit: "h", type: "number", effect: "safety" },
    { key: "strengthAmbiguous", label: "Strength ambiguous", type: "boolean", effect: "dosage" },
  ],
  supplement: [
    { key: "servingSize", label: "Serving size", type: "text", effect: "dosage" },
    { key: "unitCount", label: "Units taken", type: "number", effect: "quantity" },
    { key: "omega3Mg", label: "Omega-3", unit: "mg", type: "number", effect: "dosage" },
    { key: "epaMg", label: "EPA", unit: "mg", type: "number", effect: "dosage" },
    { key: "dhaMg", label: "DHA", unit: "mg", type: "number", effect: "dosage" },
    { key: "vitaminDIu", label: "Vitamin D", unit: "IU", type: "number", effect: "dosage" },
    { key: "capsuleCount", label: "Capsules per bottle", type: "number", effect: "replacement_timing" },
    { key: "daysSupply", label: "Days of supply", unit: "days", type: "number", effect: "replacement_timing" },
  ],
  pet_food: [
    { key: "kcalPerCup", label: "Calories per cup", unit: "kcal", type: "number", effect: "calories" },
    { key: "kcalPerKg", label: "Calories per kg", unit: "kcal", type: "number", effect: "calories" },
    { key: "feedingGuidance", label: "Feeding guidance", type: "text", effect: "recommendations" },
    { key: "bagSizeLb", label: "Bag size", unit: "lb", type: "number", effect: "replacement_timing" },
    { key: "lifeStage", label: "Life stage", type: "text", effect: "recommendations" },
    { key: "primaryProtein", label: "Primary protein", type: "text", effect: "safety" },
    { key: "proteinPct", label: "Crude protein", unit: "%", type: "number", effect: "specifications" },
    { key: "fatPct", label: "Crude fat", unit: "%", type: "number", effect: "specifications" },
  ],
  vehicle: [
    { key: "mpgCity", label: "MPG city", unit: "mpg", type: "number", effect: "calculations" },
    { key: "mpgHighway", label: "MPG highway", unit: "mpg", type: "number", effect: "calculations" },
    { key: "mpgCombined", label: "MPG combined", unit: "mpg", type: "number", effect: "calculations" },
    { key: "fuelTankGallons", label: "Fuel tank", unit: "gal", type: "number", effect: "calculations" },
    { key: "fuelType", label: "Fuel type", type: "text", effect: "recurring_cost" },
    { key: "batteryKwh", label: "Battery", unit: "kWh", type: "number", effect: "energy" },
    { key: "rangeMiles", label: "Range", unit: "mi", type: "number", effect: "performance" },
    { key: "chargingKwMax", label: "Max charging", unit: "kW", type: "number", effect: "energy" },
    { key: "oilChangeIntervalMiles", label: "Oil change interval", unit: "mi", type: "number", effect: "maintenance" },
    { key: "tireRotationIntervalMiles", label: "Tire rotation interval", unit: "mi", type: "number", effect: "maintenance" },
    { key: "drivetrain", label: "Drivetrain", type: "text", effect: "specifications" },
    { key: "engine", label: "Engine", type: "text", effect: "specifications" },
    { key: "bodyStyle", label: "Body style", type: "text", effect: "specifications" },
    { key: "seats", label: "Seats", type: "number", effect: "specifications" },
    { key: "towingCapacityLbs", label: "Towing capacity", unit: "lb", type: "number", effect: "performance" },
  ],
  device: [
    { key: "modelIdentifier", label: "Model", type: "text", effect: "compatibility" },
    { key: "releaseYear", label: "Release year", type: "number", effect: "value" },
    { key: "storageGb", label: "Storage", unit: "GB", type: "number", effect: "specifications" },
    { key: "ramGb", label: "Memory", unit: "GB", type: "number", effect: "specifications" },
    { key: "screenInches", label: "Screen", unit: "in", type: "number", effect: "specifications" },
    { key: "batteryWh", label: "Battery", unit: "Wh", type: "number", effect: "lifespan" },
    { key: "batteryLifeHours", label: "Battery life (rated)", unit: "h", type: "number", effect: "performance" },
    { key: "chargerWatts", label: "Charger", unit: "W", type: "number", effect: "compatibility" },
    { key: "warrantyMonths", label: "Standard warranty", unit: "months", type: "number", effect: "expiration" },
    { key: "weightLbs", label: "Weight", unit: "lb", type: "number", effect: "specifications" },
  ],
  wearable: [
    { key: "modelIdentifier", label: "Model", type: "text", effect: "compatibility" },
    { key: "supportedMetrics", label: "Supported metrics", type: "list", effect: "measurement" },
    { key: "hasGps", label: "GPS", type: "boolean", effect: "measurement" },
    { key: "hasHeartRate", label: "Heart rate", type: "boolean", effect: "measurement" },
    { key: "batteryLifeDays", label: "Battery life (rated)", unit: "days", type: "number", effect: "performance" },
    { key: "waterResistance", label: "Water resistance", type: "text", effect: "safety" },
    { key: "warrantyMonths", label: "Standard warranty", unit: "months", type: "number", effect: "expiration" },
  ],
  appliance: [
    { key: "modelIdentifier", label: "Model", type: "text", effect: "compatibility" },
    { key: "warrantyMonths", label: "Standard warranty", unit: "months", type: "number", effect: "expiration" },
    { key: "filterReplacementIntervalDays", label: "Filter replacement", unit: "days", type: "number", effect: "replacement_timing" },
    { key: "filterPartNumber", label: "Filter / part", type: "text", effect: "compatibility" },
    { key: "batteryRunTimeMinutes", label: "Run time", unit: "min", type: "number", effect: "performance" },
    { key: "powerWatts", label: "Power", unit: "W", type: "number", effect: "energy" },
    { key: "annualEnergyKwh", label: "Annual energy", unit: "kWh", type: "number", effect: "energy" },
    { key: "capacity", label: "Capacity", type: "text", effect: "specifications" },
    { key: "compatibleParts", label: "Compatible parts", type: "list", effect: "compatibility" },
  ],
  subscription: [
    { key: "planTier", label: "Plan", type: "text", effect: "recurring_cost" },
    { key: "price", label: "Price", unit: "USD", type: "number", effect: "recurring_cost" },
    { key: "billingFrequency", label: "Billing", type: "text", effect: "recurring_cost" },
    { key: "annualCost", label: "Annual cost", unit: "USD", type: "number", effect: "calculations" },
    { key: "planFeatures", label: "Plan features", type: "list", effect: "recommendations" },
  ],
  account: [
    { key: "accountType", label: "Account type", type: "text", effect: "calculations" },
    { key: "issuer", label: "Issuer", type: "text", effect: "specifications" },
    { key: "annualFee", label: "Annual fee", unit: "USD", type: "number", effect: "recurring_cost" },
    { key: "aprRange", label: "APR (variable)", type: "text", effect: "calculations" },
    { key: "rewardsSummary", label: "Rewards", type: "text", effect: "recommendations" },
    { key: "foreignTransactionFee", label: "Foreign transaction fee", type: "text", effect: "recurring_cost" },
  ],
  consumable: [
    { key: "dimensions", label: "Dimensions", type: "text", effect: "compatibility" },
    { key: "rating", label: "Rating", type: "text", effect: "performance" },
    { key: "replacementIntervalDays", label: "Replacement interval", unit: "days", type: "number", effect: "replacement_timing" },
    { key: "packCount", label: "Pack count", type: "number", effect: "replacement_timing" },
    { key: "compatibleWith", label: "Compatible with", type: "list", effect: "compatibility" },
  ],
  other: [],
};

export function attributeSpec(kind: ItemKind, key: string): AttributeSpec | undefined {
  return ITEM_ATTRIBUTE_POLICY[kind]?.find((a) => a.key === key);
}

// ─── Provenanced attributes ──────────────────────────────────────────────────

export interface ProvenancedAttribute {
  value: string | number | boolean | string[];
  unit?: string;
  label: string;
  /** Where the value came from, in words ("ibuprofen OTC label", "model knowledge, 2021 CR-V EX"). */
  source: string;
  sourceType: EnrichmentSourceType;
  confidence: EnrichmentConfidence;
  calculatedOrDirect: "direct" | "calculated";
  /** Why this attribute is worth tracking for this kind of item. */
  effect: TrackingEffect;
  enrichedAt: string;
}

export type ItemEnrichmentStatus = "pending" | "applied" | "proposed" | "skipped" | "failed";

export interface ItemIdentity {
  /** Best display name for the identified item. */
  name: string;
  brand?: string;
  model?: string;
  variant?: string;
  /** The product family when the exact product is not pinned ("ibuprofen"). */
  family?: string;
}

export interface ItemEnrichment {
  version: 1;
  kind: ItemKind;
  status: ItemEnrichmentStatus;
  mode: EnrichmentMode;
  specificity: ItemSpecificity;
  sourceText: string;
  identity: ItemIdentity;
  attributes: Record<string, ProvenancedAttribute>;
  /** Attribute keys the user supplied themselves — never overwritten. */
  userProvided: string[];
  /** Attribute keys written onto the record (the rest live here only). */
  applied: string[];
  confidence: EnrichmentConfidence;
  summary: string;
  reason?: string;
  enrichedAt: string;
}

/** The lowest attribute confidence — what the identification as a whole can claim. */
export function overallItemConfidence(attrs: Record<string, ProvenancedAttribute>): EnrichmentConfidence {
  const list = Object.values(attrs);
  if (list.length === 0) return "low";
  return list.reduce<EnrichmentConfidence>((acc, a) => minConfidence(acc, a.confidence), "exact");
}

export function formatAttribute(a: ProvenancedAttribute): string {
  const v = Array.isArray(a.value) ? a.value.join(", ") : typeof a.value === "boolean" ? (a.value ? "yes" : "no") : String(a.value);
  return a.unit && typeof a.value === "number" ? `${v} ${a.unit}` : v;
}

export function summarizeItemEnrichment(e: Pick<ItemEnrichment, "identity" | "attributes">): string {
  const head = e.identity.name || e.identity.family || "Unidentified";
  const parts = Object.values(e.attributes).slice(0, 5).map((a) => `${a.label}: ${formatAttribute(a)}`);
  return parts.length ? `${head} · ${parts.join(" · ")}` : head;
}

// ─── Decision ────────────────────────────────────────────────────────────────

export interface ItemEnrichmentDecision { attempt: boolean; reason: string }

/**
 * Generic wording has nothing to identify. A category ("Advil", "Honda")
 * identifies a product FAMILY, which is worth recording for medications and
 * supplements (active ingredient) but says nothing reliable about a car's
 * specs. Model and exact mentions are always worth a bounded attempt — when
 * the kind has attributes identity can change at all.
 */
export function decideItemEnrichment(mode: EnrichmentMode, kind: ItemKind, specificity: ItemSpecificity): ItemEnrichmentDecision {
  if (mode === "off") return { attempt: false, reason: "Enhanced Item Lookup is off" };
  if (ITEM_ATTRIBUTE_POLICY[kind].length === 0) return { attempt: false, reason: `nothing identity changes for a ${kind.replace("_", " ")}` };
  if (specificity.level === "generic") return { attempt: false, reason: "generic wording — nothing to identify" };
  if (specificity.level === "category" && kind !== "medication" && kind !== "supplement" && kind !== "subscription") {
    return { attempt: false, reason: "a brand alone does not pin the item" };
  }
  return { attempt: true, reason: `${specificity.level}-level ${kind.replace("_", " ")}` };
}

/** Whether an identification of this confidence writes onto the record by itself. */
export function itemAppliesAutomatically(mode: EnrichmentMode, confidence: EnrichmentConfidence): boolean {
  if (mode === "off") return false;
  if (mode === "ask") return confidence === "exact";
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK.high;
}

// ─── Medications (OTC families with deterministic identity) ──────────────────

export interface MedicationProduct {
  id: string;
  brand: string;
  aliases: string[];
  genericName: string;
  /** Common strengths per unit, in mg. More than one → the strength is ambiguous unless stated. */
  strengthsMg: number[];
  form: string;
  doseUnit: string;
  /** OTC label ceiling per 24 h for the generic, in mg (adult), when well known. */
  maxDailyMg?: number;
  doseIntervalHours?: number;
  /** Words that mean a different product line (strength or ingredient). */
  variants?: Array<{ match: RegExp; genericName?: string; strengthsMg: number[]; note: string }>;
  sourceNote: string;
}

export const MEDICATION_DB: readonly MedicationProduct[] = [
  { id: "advil", brand: "Advil", aliases: ["advil", "motrin", "ibuprofen"], genericName: "ibuprofen", strengthsMg: [200], form: "tablet", doseUnit: "tablet", maxDailyMg: 1200, doseIntervalHours: 4,
    variants: [
      { match: /\b(dual action)\b/i, genericName: "ibuprofen 125 mg + acetaminophen 250 mg", strengthsMg: [125], note: "Advil Dual Action combines ibuprofen 125 mg with acetaminophen 250 mg per tablet" },
      { match: /\b(children'?s|junior)\b/i, strengthsMg: [100], note: "Children's Advil is 100 mg per 5 mL / chewable" },
      { match: /\b(pm)\b/i, genericName: "ibuprofen 200 mg + diphenhydramine 38 mg", strengthsMg: [200], note: "Advil PM adds diphenhydramine citrate 38 mg" },
    ],
    sourceNote: "OTC ibuprofen label: 200 mg per tablet; adults 1–2 tablets every 4–6 h, max 6 tablets/24 h unless directed" },
  { id: "tylenol", brand: "Tylenol", aliases: ["tylenol", "acetaminophen", "paracetamol"], genericName: "acetaminophen", strengthsMg: [325, 500, 650], form: "tablet", doseUnit: "tablet", maxDailyMg: 3000, doseIntervalHours: 6,
    variants: [
      { match: /\b(extra strength)\b/i, strengthsMg: [500], note: "Tylenol Extra Strength is 500 mg" },
      { match: /\b(regular strength)\b/i, strengthsMg: [325], note: "Tylenol Regular Strength is 325 mg" },
      { match: /\b(8 ?hr|8-hour|arthritis)\b/i, strengthsMg: [650], note: "Tylenol 8 HR / Arthritis Pain is 650 mg extended release" },
      { match: /\b(pm)\b/i, genericName: "acetaminophen 500 mg + diphenhydramine 25 mg", strengthsMg: [500], note: "Tylenol PM adds diphenhydramine 25 mg" },
    ],
    sourceNote: "OTC acetaminophen labels: 325 / 500 / 650 mg products; adult max 3,000 mg/24 h on current OTC labeling" },
  { id: "aleve", brand: "Aleve", aliases: ["aleve", "naproxen sodium", "naproxen"], genericName: "naproxen sodium", strengthsMg: [220], form: "tablet", doseUnit: "tablet", maxDailyMg: 660, doseIntervalHours: 8,
    sourceNote: "OTC Aleve label: 220 mg naproxen sodium per tablet; 1 tablet every 8–12 h, max 3/24 h" },
  { id: "aspirin", brand: "Aspirin", aliases: ["aspirin", "bayer"], genericName: "aspirin", strengthsMg: [81, 325], form: "tablet", doseUnit: "tablet", maxDailyMg: 4000, doseIntervalHours: 4,
    variants: [
      { match: /\b(low[- ]dose|baby|81)\b/i, strengthsMg: [81], note: "Low-dose aspirin is 81 mg" },
      { match: /\b(regular|325)\b/i, strengthsMg: [325], note: "Regular strength aspirin is 325 mg" },
    ],
    sourceNote: "OTC aspirin: 81 mg low-dose or 325 mg regular strength" },
  { id: "excedrin", brand: "Excedrin", aliases: ["excedrin"], genericName: "acetaminophen 250 mg + aspirin 250 mg + caffeine 65 mg", strengthsMg: [250], form: "tablet", doseUnit: "tablet", doseIntervalHours: 6,
    sourceNote: "Excedrin Extra Strength / Migraine: acetaminophen 250 mg, aspirin 250 mg, caffeine 65 mg per tablet" },
  { id: "benadryl", brand: "Benadryl", aliases: ["benadryl", "diphenhydramine"], genericName: "diphenhydramine", strengthsMg: [25], form: "tablet", doseUnit: "tablet", maxDailyMg: 300, doseIntervalHours: 4,
    sourceNote: "OTC Benadryl Allergy: 25 mg diphenhydramine per tablet" },
  { id: "zyrtec", brand: "Zyrtec", aliases: ["zyrtec", "cetirizine"], genericName: "cetirizine", strengthsMg: [10], form: "tablet", doseUnit: "tablet", maxDailyMg: 10, doseIntervalHours: 24,
    sourceNote: "OTC Zyrtec: 10 mg cetirizine once daily" },
  { id: "claritin", brand: "Claritin", aliases: ["claritin", "loratadine"], genericName: "loratadine", strengthsMg: [10], form: "tablet", doseUnit: "tablet", maxDailyMg: 10, doseIntervalHours: 24,
    variants: [{ match: /\b(claritin[- ]d)\b/i, genericName: "loratadine 5 mg + pseudoephedrine 120 mg (12 h) or 10 mg + 240 mg (24 h)", strengthsMg: [5, 10], note: "Claritin-D comes in 12-hour and 24-hour strengths" }],
    sourceNote: "OTC Claritin: 10 mg loratadine once daily" },
  { id: "allegra", brand: "Allegra", aliases: ["allegra", "fexofenadine"], genericName: "fexofenadine", strengthsMg: [60, 180], form: "tablet", doseUnit: "tablet", maxDailyMg: 180, doseIntervalHours: 24,
    variants: [
      { match: /\b(24 ?hr|24-hour|180)\b/i, strengthsMg: [180], note: "Allegra 24HR is 180 mg" },
      { match: /\b(12 ?hr|12-hour|60)\b/i, strengthsMg: [60], note: "Allegra 12HR is 60 mg" },
    ],
    sourceNote: "OTC Allegra: 180 mg (24 h) or 60 mg (12 h) fexofenadine" },
  { id: "pepcid", brand: "Pepcid", aliases: ["pepcid", "famotidine"], genericName: "famotidine", strengthsMg: [10, 20], form: "tablet", doseUnit: "tablet", maxDailyMg: 40, doseIntervalHours: 12,
    variants: [
      { match: /\b(ac maximum|maximum strength|max)\b/i, strengthsMg: [20], note: "Pepcid AC Maximum Strength is 20 mg" },
      { match: /\b(original|ac\b)/i, strengthsMg: [10], note: "Pepcid AC Original is 10 mg" },
    ],
    sourceNote: "OTC Pepcid AC: 10 mg original or 20 mg maximum strength" },
  { id: "prilosec", brand: "Prilosec", aliases: ["prilosec", "omeprazole"], genericName: "omeprazole", strengthsMg: [20], form: "delayed-release tablet", doseUnit: "tablet", maxDailyMg: 20, doseIntervalHours: 24,
    sourceNote: "OTC Prilosec: 20 mg omeprazole once daily (14-day course)" },
  { id: "tums", brand: "Tums", aliases: ["tums", "calcium carbonate antacid"], genericName: "calcium carbonate", strengthsMg: [500, 750, 1000], form: "chewable tablet", doseUnit: "tablet",
    variants: [
      { match: /\b(ultra|1000)\b/i, strengthsMg: [1000], note: "Tums Ultra Strength is 1000 mg" },
      { match: /\b(extra|e-x|750)\b/i, strengthsMg: [750], note: "Tums Extra Strength is 750 mg" },
      { match: /\b(regular|500)\b/i, strengthsMg: [500], note: "Tums Regular Strength is 500 mg" },
    ],
    sourceNote: "OTC Tums: 500 / 750 / 1000 mg calcium carbonate" },
  { id: "mucinex", brand: "Mucinex", aliases: ["mucinex", "guaifenesin"], genericName: "guaifenesin", strengthsMg: [600, 1200], form: "extended-release tablet", doseUnit: "tablet", maxDailyMg: 2400, doseIntervalHours: 12,
    variants: [{ match: /\b(maximum strength|max)\b/i, strengthsMg: [1200], note: "Mucinex Maximum Strength is 1200 mg" }],
    sourceNote: "OTC Mucinex: 600 mg or 1200 mg (maximum strength) guaifenesin ER" },
  { id: "sudafed", brand: "Sudafed", aliases: ["sudafed", "pseudoephedrine"], genericName: "pseudoephedrine", strengthsMg: [30, 120, 240], form: "tablet", doseUnit: "tablet", maxDailyMg: 240,
    variants: [{ match: /\b(pe)\b/i, genericName: "phenylephrine", strengthsMg: [10], note: "Sudafed PE is phenylephrine 10 mg, a different ingredient" }],
    sourceNote: "Sudafed (pseudoephedrine): 30 mg, 120 mg (12 h), 240 mg (24 h); Sudafed PE is phenylephrine 10 mg" },
  { id: "melatonin", brand: "Melatonin", aliases: ["melatonin"], genericName: "melatonin", strengthsMg: [1, 3, 5, 10], form: "tablet", doseUnit: "tablet",
    sourceNote: "Melatonin supplements come in 1–10 mg; the strength must be stated" },
];

const NUMBER_WORD: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, "a couple of": 2, couple: 2, half: 0.5 };

export interface DoseParse {
  /** Units taken ("two tablets" → 2), when stated. */
  count: number | null;
  /** Strength per unit the user stated ("200 mg" → 200), when stated. */
  statedStrengthMg: number | null;
  /** "tablet", "capsule", "softgel", "gummy"… when stated. */
  form: string | null;
}

/** "two Advil 200 mg tablets" → { count: 2, statedStrengthMg: 200, form: "tablet" }. */
export function parseDoseText(text: string): DoseParse {
  const t = String(text || "").toLowerCase();
  let count: number | null = null;
  // The strength ("200 mg") is not a count: take it out before counting units,
  // so "two Advil 200 mg tablets" counts two, not two hundred.
  const noStrength = t.replace(/\b\d+(?:\.\d+)?\s*(mg|milligrams?|mcg|micrograms?|g|grams?|iu|ml)\b/g, " ");
  const m = noStrength.match(/\b(\d+(?:\.\d+)?|a couple of|couple|one|two|three|four|five|six|a|an|half)\s+(?:[a-z0-9'&-]+\s+){0,5}?(tablets?|tabs?|caps?|capsules?|softgels?|pills?|gummies|gummy|chewables?|doses?|caplets?|gelcaps?|liqui-gels)\b/);
  if (m) {
    const n = NUMBER_WORD[m[1]] ?? parseFloat(m[1]);
    if (isFinite(n)) count = n;
  }
  const s = t.match(/\b(\d+(?:\.\d+)?)\s*(mg|milligrams?)\b/);
  const statedStrengthMg = s ? parseFloat(s[1]) : null;
  const f = t.match(/\b(tablets?|capsules?|softgels?|gummies|gummy|chewables?|caplets?|gelcaps?|liqui-gels|liquid|drops|spray|patch)\b/);
  const form = f ? f[1].replace(/s$/, "").replace("gummie", "gummy") : null;
  return { count, statedStrengthMg: statedStrengthMg != null && isFinite(statedStrengthMg) ? statedStrengthMg : null, form };
}

export interface MedicationIdentification {
  product: MedicationProduct;
  genericName: string;
  /** The strength used, or null when ambiguous and unstated. */
  strengthMg: number | null;
  strengthAmbiguous: boolean;
  /** Where the strength came from: the user, the product's single strength, or nowhere. */
  strengthSource: "user" | "product" | "none";
  variantNote?: string;
  dose: DoseParse;
  /** count × strength when both are known. */
  totalDoseMg: number | null;
}

/**
 * Identify an OTC medication from the user's words. The brand pins the
 * family; the strength is the user's when stated, the product's when it has
 * exactly one, and left ambiguous otherwise — "I took Advil" is ibuprofen,
 * strength unknown; "two Advil 200 mg tablets" is 400 mg.
 */
export function identifyMedication(text: string): MedicationIdentification | null {
  const t = String(text || "").toLowerCase();
  if (!t) return null;
  let best: MedicationProduct | null = null;
  let bestLen = 0;
  for (const p of MEDICATION_DB) {
    for (const alias of p.aliases) {
      if (new RegExp(`(^|[^a-z])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(t) && alias.length > bestLen) {
        best = p; bestLen = alias.length;
      }
    }
  }
  if (!best) return null;
  const dose = parseDoseText(t);
  if (dose.count == null) {
    for (const alias of best.aliases) {
      const m = t.match(new RegExp(`\\b(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|a couple of|couple|half)\\s+(?:[a-z'-]+\\s+)?${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?\\b`));
      if (m) { const n = NUMBER_WORD[m[1]] ?? parseFloat(m[1]); if (isFinite(n)) { dose.count = n; break; } }
    }
  }
  let genericName = best.genericName;
  let strengths = best.strengthsMg;
  let variantNote: string | undefined;
  for (const v of best.variants || []) {
    if (v.match.test(t)) { strengths = v.strengthsMg; if (v.genericName) genericName = v.genericName; variantNote = v.note; break; }
  }
  let strengthMg: number | null = null;
  let strengthSource: MedicationIdentification["strengthSource"] = "none";
  if (dose.statedStrengthMg != null) { strengthMg = dose.statedStrengthMg; strengthSource = "user"; }
  else if (strengths.length === 1) { strengthMg = strengths[0]; strengthSource = "product"; }
  const strengthAmbiguous = strengthMg == null;
  const totalDoseMg = strengthMg != null && dose.count != null ? Math.round(strengthMg * dose.count * 100) / 100 : null;
  return { product: best, genericName, strengthMg, strengthAmbiguous, strengthSource, variantNote, dose, totalDoseMg };
}

/** Turn a medication identification into provenanced attributes (policy-filtered). */
export function medicationAttributes(id: MedicationIdentification, now: string): Record<string, ProvenancedAttribute> {
  const out: Record<string, ProvenancedAttribute> = {};
  const src = `${id.product.brand} — ${id.product.sourceNote}${id.variantNote ? `; ${id.variantNote}` : ""}`;
  const put = (key: string, value: ProvenancedAttribute["value"], confidence: EnrichmentConfidence, sourceType: EnrichmentSourceType, calc: "direct" | "calculated" = "direct") => {
    const spec = attributeSpec("medication", key);
    if (!spec) return;
    out[key] = { value, unit: spec.unit, label: spec.label, source: src, sourceType, confidence, calculatedOrDirect: calc, effect: spec.effect, enrichedAt: now };
  };
  put("activeIngredient", id.genericName, "exact", "manufacturer");
  put("form", id.dose.form || id.product.form, id.dose.form ? "exact" : "high", id.dose.form ? "user" : "manufacturer");
  put("doseUnit", id.product.doseUnit, "high", "manufacturer");
  if (id.strengthMg != null) put("strengthMg", id.strengthMg, "exact", id.strengthSource === "user" ? "user" : "manufacturer");
  put("strengthAmbiguous", id.strengthAmbiguous, "exact", "calculated", "calculated");
  if (id.dose.count != null) put("unitCount", id.dose.count, "exact", "user");
  if (id.totalDoseMg != null) put("totalDoseMg", id.totalDoseMg, "exact", "calculated", "calculated");
  if (id.product.maxDailyMg != null && !id.variantNote) put("maxDailyMg", id.product.maxDailyMg, "high", "manufacturer");
  if (id.product.doseIntervalHours != null && !id.variantNote) put("doseIntervalHours", id.product.doseIntervalHours, "high", "manufacturer");
  return out;
}

// ─── Record fields that are the user's ───────────────────────────────────────

/**
 * Attribute keys already present on the record with a real value are the
 * user's (or an earlier source's) and are never overwritten. Spelling
 * variants count ("mpg" vs "mpgCombined" are different keys; "trim" is).
 */
export function userProvidedAttributeKeys(kind: ItemKind, existing: Record<string, any> | null | undefined): string[] {
  const out: string[] = [];
  const ex = existing || {};
  for (const spec of ITEM_ATTRIBUTE_POLICY[kind]) {
    const v = ex[spec.key];
    if (v !== undefined && v !== null && String(v).trim() !== "") out.push(spec.key);
  }
  return out;
}

/** The record patch: every applied attribute not the user's, as plain values. */
export function buildAttributePatch(kind: ItemKind, attrs: Record<string, ProvenancedAttribute>, userProvided: string[], minConf: EnrichmentConfidence = "high"): Record<string, any> {
  const patch: Record<string, any> = {};
  for (const [key, a] of Object.entries(attrs)) {
    if (userProvided.includes(key)) continue;
    if (!attributeSpec(kind, key)) continue;
    if (CONFIDENCE_RANK[a.confidence] < CONFIDENCE_RANK[minConf]) continue;
    patch[key] = a.value;
  }
  return patch;
}

/** Hidden provenance key on a profile's or obligation's fields. */
export const ITEM_ENRICHMENT_FIELD_KEY = "_itemEnrichment";
export const ITEM_ENRICHMENT_PREF_KEY = "item_enrichment";
