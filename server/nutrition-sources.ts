// ─── Food databases: the universal part of the lookup ladder ─────────────────
//
// The internal table (shared/nutrition-db.ts) answers a few hundred foods
// instantly. Everything else — any generic food, any branded product, any
// barcode — is looked up here, in sources that publish their figures:
//
//   · USDA FoodData Central (Foundation / SR Legacy / Survey for generic
//     foods; Branded for packaged products, with the label's own per-serving
//     values);
//   · Open Food Facts (packaged products worldwide; by name or by barcode).
//
// Division of labour (Nutrition rule N2): a model may CHOOSE which database
// record the user's words mean, and read a vague amount ("a bowl") as grams,
// flagged as assumed. Every figure is the record's, and every multiplication
// is done here. A record is never invented: no candidate fits → null, and the
// ladder moves on to a labelled estimate.
//
// Network use is bounded (timeouts, one search + at most one detail request
// per food, a small in-process cache) and every failure is a null, never a
// throw: the saved entry stands.
//
// Pinned by tests/nutrition-sources.test.ts (recorded responses).

import {
  GRAMS_PER_OZ,
  ML_PER_FL_OZ,
  canonicalNutrientKey,
  componentNutrients,
  normalizeQuantity,
  roundNutrient,
  type EnrichmentConfidence,
  type NutrientKey,
  type NutrientVector,
  type NutritionComponent,
  type QuantityNormalization,
} from "@shared/nutrition-enrichment";
import { weighedWithInedible } from "@shared/nutrition-db";
import { getAnthropicClient } from "./anthropic-client";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SourcePortion { label: string; grams: number }

export interface SourceCandidate {
  provider: "fdc" | "off";
  /** fdcId, or the product's barcode. */
  id: string;
  name: string;
  brand?: string;
  /** FDC: Foundation | SR Legacy | Survey (FNDDS) | Branded. */
  dataType?: string;
  /** Values per 100 g (or per 100 ml for a drink). */
  per100?: NutrientVector;
  per100Unit?: "g" | "ml";
  /** The label's serving, when the source states one. */
  serving?: { grams?: number; ml?: number; label: string };
  /** The label's own per-serving values, as printed (never back-calculated). */
  perServing?: NutrientVector;
  package?: { grams?: number; ml?: number; label: string };
  /** Household measures with their gram weight ("1 cup, diced" = 135 g). */
  portions?: SourcePortion[];
  barcode?: string;
  isBeverage?: boolean;
}

export interface SourceAsk {
  /** The food as the entry names it. */
  phrase: string;
  /** The user's words for how much. */
  quantityText: string;
  /** The phrase names a known brand: a packaged product. */
  branded: boolean;
  /** No known brand, but it reads like a product name: reference records and products are both considered. */
  maybeBranded?: boolean;
}

/** What a chooser decided for one ask. */
export interface SourcePick {
  /** Index into the ask's candidates, or null: none of them is this food. */
  pick: number | null;
  /** The user's amount read as grams (or ml for a drink) when they gave no weight: an ASSUMPTION. */
  assumedAmount?: number | null;
  /** Share of a stated weight that is eaten, when it includes peel / bone / shell. */
  edibleFraction?: number | null;
}

export interface SourceDeps {
  fetchJson?: (url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }) => Promise<any | null>;
  /** Choose among candidates. Null result = use the deterministic scorer. */
  choose?: (asks: Array<{ ask: SourceAsk; candidates: SourceCandidate[] }>) => Promise<SourcePick[] | null>;
  now?: () => string;
  /** Hard ceiling for the whole resolution, ms. */
  deadlineMs?: number;
}

// ─── Fetch, bounded and cached ───────────────────────────────────────────────

const cache = new Map<string, { at: number; value: any }>();
const CACHE_MS = 60 * 60_000;
const CACHE_MAX = 400;

async function defaultFetchJson(url: string, init: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<any | null> {
  if (process.env.NUTRITION_LOOKUP_DISABLE === "1") return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  // The databases drop a request now and then (an empty body, a 5xx): one
  // retry or two, then give up quietly. A 4xx is an answer and is not retried.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt));
    const release = await gate();
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Portol/1.0 (nutrition lookup; https://portol.me)", Accept: "application/json", ...(init.headers || {}) },
        signal: AbortSignal.timeout(init.timeoutMs ?? 6000),
      });
      if (resp.status === 429) { logger.warn("nutrition-sources", `rate limited by ${new URL(url).host}`); return null; }
      if (resp.status >= 400 && resp.status < 500) return null;
      if (!resp.ok) continue;
      const body = await resp.text();
      if (!body.trim()) continue;
      const value = JSON.parse(body);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(url, { at: Date.now(), value });
      return value;
    } catch { /* retry */ } finally { release(); }
  }
  return null;
}

/** At most three database requests in flight: a burst of parallel searches is what gets dropped. */
let inFlight = 0;
const waiting: Array<() => void> = [];
async function gate(): Promise<() => void> {
  if (inFlight >= 3) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  return () => { inFlight--; waiting.shift()?.(); };
}

// ─── USDA FoodData Central ───────────────────────────────────────────────────

/** FDC nutrient id → our key, with the factor from FDC's unit to ours. */
const FDC_NUTRIENTS: Record<number, [NutrientKey, number]> = {
  1008: ["calories", 1], 2047: ["calories", 1], 2048: ["calories", 1],
  1003: ["protein", 1], 1005: ["carbs", 1], 1004: ["fat", 1],
  1258: ["saturatedFat", 1], 1257: ["transFat", 1], 1292: ["monoFat", 1], 1293: ["polyFat", 1],
  1079: ["fiber", 1], 2000: ["sugar", 1], 1063: ["sugar", 1], 1235: ["addedSugar", 1], 1086: ["sugarAlcohol", 1],
  1093: ["sodium", 1], 1253: ["cholesterol", 1], 1092: ["potassium", 1], 1087: ["calcium", 1], 1089: ["iron", 1],
  1090: ["magnesium", 1], 1095: ["zinc", 1], 1091: ["phosphorus", 1], 1103: ["selenium", 1],
  1098: ["copper", 1], 1101: ["manganese", 1], 1100: ["iodine", 1], 1096: ["chromium", 1], 1102: ["molybdenum", 1],
  1057: ["caffeine", 1], 1018: ["alcohol", 1],
  1106: ["vitaminA", 1], 1165: ["vitaminB1", 1], 1166: ["vitaminB2", 1], 1167: ["vitaminB3", 1], 1170: ["vitaminB5", 1],
  1175: ["vitaminB6", 1], 1176: ["biotin", 1], 1178: ["vitaminB12", 1], 1162: ["vitaminC", 1], 1114: ["vitaminD", 1],
  1109: ["vitaminE", 1], 1185: ["vitaminK", 1], 1177: ["folate", 1], 1190: ["folate", 1], 1180: ["choline", 1],
  1278: ["epa", 1000], 1272: ["dha", 1000],
};
/** Energy ids in order of preference: kcal, then the Atwater figures Foundation foods carry. */
const FDC_ENERGY_ORDER = [1008, 2048, 2047];

function fdcVector(rows: any[]): NutrientVector {
  const out: NutrientVector = {};
  const energy: Record<number, number> = {};
  for (const r of rows || []) {
    const id = Number(r?.nutrientId ?? r?.nutrient?.id);
    const value = Number(r?.value ?? r?.amount);
    if (!isFinite(id) || !isFinite(value) || value < 0) continue;
    if (FDC_ENERGY_ORDER.includes(id)) { energy[id] = value; continue; }
    const map = FDC_NUTRIENTS[id];
    if (!map) continue;
    const [key, factor] = map;
    // The first id listed for a key wins (2000 "Total Sugars" before 1063).
    if (out[key] == null) out[key] = roundNutrient(value * factor, key);
  }
  for (const id of FDC_ENERGY_ORDER) if (energy[id] != null) { out.calories = roundNutrient(energy[id], "calories"); break; }
  return out;
}

/** The names a USDA FoodData Central key may be stored under (the first one set wins). */
export const FDC_KEY_NAMES = ["FDC_API_KEY", "USDA_FDC_API_KEY", "USDA_API_KEY", "FOODDATA_CENTRAL_API_KEY", "FDC_KEY", "DATA_GOV_API_KEY"] as const;
export const fdcKey = (): string | undefined => FDC_KEY_NAMES.map((n) => process.env[n]?.trim()).find((v) => !!v);
const fdcHeaders = (): Record<string, string> => ({ "X-Api-Key": fdcKey() || "DEMO_KEY" });
const FDC = "https://api.nal.usda.gov/fdc/v1";

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

function fdcCandidate(f: any): SourceCandidate | null {
  const per100 = fdcVector(f?.foodNutrients || []);
  if (per100.calories == null && per100.protein == null && per100.carbs == null && per100.fat == null) return null;
  const branded = String(f?.dataType) === "Branded";
  const unit = String(f?.servingSizeUnit || "").toLowerCase();
  const isMl = /^(ml|mlt)$/.test(unit);
  const size = Number(f?.servingSize);
  const household = String(f?.householdServingFullText || "").trim();
  const brand = String(f?.brandName || f?.brandOwner || "").trim();
  const pkg = parsePackage(String(f?.packageWeight || ""));
  return {
    provider: "fdc",
    id: String(f.fdcId),
    name: branded ? titleCase(String(f.description || "")) : String(f.description || ""),
    brand: brand ? titleCase(brand) : undefined,
    dataType: String(f?.dataType || ""),
    per100,
    per100Unit: isMl ? "ml" : "g",
    serving: branded && isFinite(size) && size > 0
      ? { ...(isMl ? { ml: round2(size) } : { grams: round2(size) }), label: household ? `${household.toLowerCase()} (${round2(size)} ${isMl ? "ml" : "g"})` : `${round2(size)} ${isMl ? "ml" : "g"}` }
      : undefined,
    package: pkg || undefined,
    barcode: f?.gtinUpc ? String(f.gtinUpc) : undefined,
    isBeverage: isMl,
  };
}

export async function fdcSearch(query: string, kind: "generic" | "branded", deps: SourceDeps = {}): Promise<SourceCandidate[]> {
  // USDA is OPTIONAL. With no key configured it is not asked at all (the
  // shared demo key allows ten requests an hour: every miss was wasted time).
  if (!deps.fetchJson && !fdcKey()) return [];
  // (A phrase that may be either is searched both ways by the caller.)
  const q = String(query || "").trim();
  if (!q) return [];
  const types = kind === "branded" ? "Branded" : "Foundation,SR%20Legacy,Survey%20%28FNDDS%29";
  const url = `${FDC}/foods/search?query=${encodeURIComponent(q)}&dataType=${types}&pageSize=${kind === "branded" ? 12 : 20}`;
  const data = await (deps.fetchJson || defaultFetchJson)(url, { headers: fdcHeaders(), timeoutMs: 6000 });
  const foods: any[] = Array.isArray(data?.foods) ? data.foods : [];
  return foods.map(fdcCandidate).filter((c): c is SourceCandidate => !!c);
}

/** The record's household measures and, for a branded product, the label's own per-serving figures. */
export async function fdcDetail(c: SourceCandidate, deps: SourceDeps = {}): Promise<SourceCandidate> {
  if (c.provider !== "fdc") return c;
  const d = await (deps.fetchJson || defaultFetchJson)(`${FDC}/food/${encodeURIComponent(c.id)}`, { headers: fdcHeaders(), timeoutMs: 5000 });
  if (!d) return c;
  const portions: SourcePortion[] = [];
  for (const p of d.foodPortions || []) {
    const grams = Number(p?.gramWeight);
    if (!isFinite(grams) || grams <= 0) continue;
    const amount = Number(p?.amount) || 1;
    const unitName = String(p?.measureUnit?.name || "").toLowerCase();
    const text = String(p?.portionDescription || "").trim()
      || [amount, unitName && unitName !== "undetermined" ? unitName : "", String(p?.modifier || "").trim()].filter(Boolean).join(" ").trim();
    if (!text || /quantity not specified/i.test(text)) continue;
    // "3 oz" = 85 g is a conversion, not a household measure of this food.
    portions.push({ label: text, grams: round2(grams) });
  }
  let perServing: NutrientVector | undefined;
  const ln = d.labelNutrients;
  if (ln && typeof ln === "object") {
    const v: NutrientVector = {};
    const put = (k: NutrientKey, x: any) => { const n = Number(x?.value); if (isFinite(n) && n >= 0) v[k] = roundNutrient(n, k); };
    put("calories", ln.calories); put("fat", ln.fat); put("saturatedFat", ln.saturatedFat); put("transFat", ln.transFat);
    put("cholesterol", ln.cholesterol); put("sodium", ln.sodium); put("carbs", ln.carbohydrates); put("fiber", ln.fiber);
    put("sugar", ln.sugars); put("addedSugar", ln.addedSugar); put("protein", ln.protein); put("calcium", ln.calcium);
    put("iron", ln.iron); put("potassium", ln.potassium);
    if (v.calories != null) perServing = v;
  }
  return { ...c, portions: portions.length ? portions : c.portions, perServing: perServing || c.perServing };
}

// ─── Open Food Facts ─────────────────────────────────────────────────────────

const OFF_FIELDS = "code,product_name,brands,serving_size,serving_quantity,serving_quantity_unit,quantity,nutriments,categories_tags";

/** Open Food Facts nutriments (grams per 100 g, or per serving) → our vector. */
export function offVector(n: Record<string, any> | null | undefined, basis: "100g" | "serving"): NutrientVector | null {
  if (!n || typeof n !== "object") return null;
  const pick = (key: string, mult = 1): number | undefined => {
    const v = n[`${key}_${basis}`];
    return typeof v === "number" && isFinite(v) && v >= 0 ? v * mult : undefined;
  };
  const out: NutrientVector = {};
  const set = (k: NutrientKey, v: number | undefined) => { if (v != null) out[k] = roundNutrient(v, k); };
  set("calories", pick("energy-kcal"));
  if (out.calories == null) { const kj = pick("energy-kj") ?? (n.energy_unit === "kJ" ? pick("energy") : undefined); if (kj != null) set("calories", kj / 4.184); }
  set("protein", pick("proteins")); set("carbs", pick("carbohydrates")); set("fat", pick("fat"));
  set("saturatedFat", pick("saturated-fat")); set("transFat", pick("trans-fat"));
  set("monoFat", pick("monounsaturated-fat")); set("polyFat", pick("polyunsaturated-fat"));
  set("fiber", pick("fiber")); set("sugar", pick("sugars")); set("addedSugar", pick("added-sugars")); set("sugarAlcohol", pick("polyols"));
  set("allulose", pick("allulose"));
  set("sodium", pick("sodium", 1000)); set("cholesterol", pick("cholesterol", 1000)); set("potassium", pick("potassium", 1000));
  set("calcium", pick("calcium", 1000)); set("iron", pick("iron", 1000)); set("magnesium", pick("magnesium", 1000));
  set("zinc", pick("zinc", 1000)); set("phosphorus", pick("phosphorus", 1000)); set("selenium", pick("selenium", 1e6));
  set("copper", pick("copper", 1000)); set("manganese", pick("manganese", 1000)); set("iodine", pick("iodine", 1e6));
  set("vitaminA", pick("vitamin-a", 1e6)); set("vitaminB1", pick("vitamin-b1", 1000)); set("vitaminB2", pick("vitamin-b2", 1000));
  set("vitaminB3", pick("vitamin-pp", 1000)); set("vitaminB5", pick("pantothenic-acid", 1000)); set("vitaminB6", pick("vitamin-b6", 1000));
  set("biotin", pick("biotin", 1e6)); set("vitaminB12", pick("vitamin-b12", 1e6)); set("vitaminC", pick("vitamin-c", 1000));
  set("vitaminD", pick("vitamin-d", 1e6)); set("vitaminE", pick("vitamin-e", 1000)); set("vitaminK", pick("vitamin-k", 1e6));
  set("folate", pick("vitamin-b9", 1e6)); set("caffeine", pick("caffeine", 1000)); set("alcohol", pick("alcohol"));
  if (out.calories == null && out.protein == null && out.carbs == null && out.fat == null) return null;
  return out;
}

function offCandidate(p: any): SourceCandidate | null {
  const name = String(p?.product_name || "").trim();
  if (!name) return null;
  const per100 = offVector(p?.nutriments, "100g") || undefined;
  const perServing = offVector(p?.nutriments, "serving") || undefined;
  if (!per100 && !perServing) return null;
  const servingText = String(p?.serving_size || "").trim();
  const servingQty = Number(p?.serving_quantity);
  const unit = String(p?.serving_quantity_unit || "").toLowerCase();
  const isBeverage = unit === "ml" || /\b(ml|cl|fl\.? ?oz|l)\b/i.test(servingText)
    || (Array.isArray(p?.categories_tags) && p.categories_tags.some((c: string) => /beverage|drink|soda|juice|water|milk|coffee|tea|energy/i.test(String(c))));
  const brand = String(p?.brands || "").split(",")[0].trim() || undefined;
  return {
    provider: "off",
    id: String(p?.code || ""),
    name,
    brand,
    dataType: "Open Food Facts",
    per100,
    per100Unit: isBeverage ? "ml" : "g",
    serving: isFinite(servingQty) && servingQty > 0 ? { ...(isBeverage ? { ml: servingQty } : { grams: servingQty }), label: servingText || `${servingQty} ${isBeverage ? "ml" : "g"}` } : undefined,
    perServing: isFinite(servingQty) && servingQty > 0 ? perServing : undefined,
    package: parsePackage(String(p?.quantity || "")) || undefined,
    barcode: p?.code ? String(p.code) : undefined,
    isBeverage,
  };
}

export async function offSearch(query: string, deps: SourceDeps = {}): Promise<SourceCandidate[]> {
  const q = String(query || "").trim();
  if (!q) return [];
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=12&fields=${OFF_FIELDS}`;
  const data = await (deps.fetchJson || defaultFetchJson)(url, { timeoutMs: 6000 });
  const products: any[] = Array.isArray(data?.products) ? data.products : [];
  return products.map(offCandidate).filter((c): c is SourceCandidate => !!c);
}

/** A UPC / EAN as people give it: 8, 12, 13 or 14 digits, spaces and dashes allowed. */
export function barcodeIn(text: string): string | null {
  // Not part of a longer number or a decimal; a full stop ending the sentence is fine.
  const m = String(text || "").match(/(?<![\d.])(\d[\d -]{6,18}\d)(?!\d|\.\d)/g) || [];
  for (const raw of m) {
    const digits = raw.replace(/[ -]/g, "");
    if ([8, 12, 13, 14].includes(digits.length) && isValidGtin(digits)) return digits;
  }
  return null;
}

/** GTIN check digit (UPC-A, EAN-8/13, GTIN-14): a phone number or an amount does not pass. */
export function isValidGtin(digits: string): boolean {
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return false;
  const body = digits.slice(0, -1).split("").reverse().map(Number);
  const sum = body.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** One product by its barcode: Open Food Facts first, then USDA's branded records. */
export async function barcodeLookup(code: string, deps: SourceDeps = {}): Promise<SourceCandidate | null> {
  const digits = String(code || "").replace(/\D/g, "");
  if (!isValidGtin(digits)) return null;
  const get = deps.fetchJson || defaultFetchJson;
  const off = await get(`https://world.openfoodfacts.org/api/v2/product/${digits}.json?fields=${OFF_FIELDS}`, { timeoutMs: 6000 });
  if (off?.status === 1 && off.product) {
    const c = offCandidate({ ...off.product, code: digits });
    if (c) return c;
  }
  // USDA stores GTINs zero-padded to 14 and as printed; the search matches either.
  const data = await get(`${FDC}/foods/search?query=${digits}&dataType=Branded&pageSize=5`, { headers: fdcHeaders(), timeoutMs: 6000 });
  const hit = (Array.isArray(data?.foods) ? data.foods : []).find((f: any) => String(f?.gtinUpc || "").replace(/^0+/, "") === digits.replace(/^0+/, ""));
  if (!hit) return null;
  const c = fdcCandidate(hit);
  return c ? fdcDetail(c, deps) : null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

function parsePackage(q: string): { grams?: number; ml?: number; label: string } | null {
  const t = String(q || "").toLowerCase().trim();
  if (!t) return null;
  const out: { grams?: number; ml?: number; label: string } = { label: q.trim() };
  let oz: number | undefined;
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(ml|l|cl|fl\.?\s*oz|g|kg|oz|lbs?)\b/g)) {
    const n = parseFloat(m[1].replace(",", "."));
    const u = m[2].replace(/[\s.]/g, "");
    if (!isFinite(n)) continue;
    if (u === "ml" && out.ml == null) out.ml = n;
    else if (u === "l" && out.ml == null) out.ml = n * 1000;
    else if (u === "cl" && out.ml == null) out.ml = n * 10;
    else if (u === "floz" && out.ml == null) out.ml = round2(n * ML_PER_FL_OZ);
    else if (u === "g" && out.grams == null) out.grams = n;
    else if (u === "kg" && out.grams == null) out.grams = n * 1000;
    else if (/^lbs?$/.test(u) && out.grams == null) out.grams = round2(n * 453.6);
    else if (u === "oz" && oz == null) oz = n * GRAMS_PER_OZ;
  }
  if (out.grams == null && out.ml == null && oz != null) out.grams = round2(oz);
  return out.grams != null || out.ml != null ? out : null;
}

const STOP = new Set([
  "a", "an", "the", "of", "with", "and", "or", "in", "on", "my", "i", "ate", "had", "drank", "some", "one", "two", "three", "half",
  "cup", "cups", "oz", "ounce", "ounces", "g", "gram", "grams", "ml", "tbsp", "tsp", "tablespoon", "teaspoon", "serving", "servings",
  "piece", "pieces", "slice", "slices", "bowl", "plate", "glass", "can", "bottle", "packet", "bar", "bars", "large", "medium", "small",
  "about", "around", "for", "from", "at", "to", "weighed", "before", "after", "cooking", "including", "whole", "container",
]);
const stem = (w: string) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("es") && !/[aeiou]es$/.test(w) ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
export function foodTokens(s: string): string[] {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9%&' ]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t) && !/^\d+(\.\d+)?$/.test(t)).map(stem);
}

/** How well a candidate's name explains the phrase, 0–1. The fallback when no chooser is available. */
export function scoreCandidate(phrase: string, c: SourceCandidate): number {
  const q = Array.from(new Set(foodTokens(phrase)));
  if (q.length === 0) return 0;
  const nameTok = foodTokens(c.name);
  const have = new Set([...nameTok, ...foodTokens(c.brand || "")]);
  const hit = q.filter((t) => have.has(t)).length;
  const coverage = hit / q.length;
  const precision = hit / Math.max(1, new Set(nameTok).size);
  let score = coverage * 0.6 + precision * 0.4;
  // A plain reference record over a survey composite, and never a variant the
  // user did not name ("fat added", "with breadsticks", baby food).
  if (c.dataType === "Foundation" || c.dataType === "SR Legacy") score += 0.04;
  const extra = c.name.toLowerCase();
  if (!/\b(with|added|and)\b/.test(phrase.toLowerCase()) && /\b(fat added|with [a-z]+|babyfood|baby food|ns as to)\b/.test(extra)) score -= 0.15;
  // The state the user named must be the record's: raw is not cooked.
  const p = phrase.toLowerCase();
  const n = c.name.toLowerCase();
  const wantsRaw = /\b(raw|uncooked|dry|before cooking)\b/.test(p);
  const isRaw = /\braw\b|\bdry\b|\buncooked\b|\bunprepared\b/.test(n);
  const isCooked = /\b(cooked|roasted|grilled|baked|boiled|fried|braised|stewed|steamed|broiled|prepared)\b/.test(n);
  if (wantsRaw && isCooked) score -= 0.3;
  if (!wantsRaw && /\b(cooked|roasted|grilled|baked|boiled|fried|steamed)\b/.test(p) && isRaw) score -= 0.3;
  return Math.max(0, Math.min(1, score));
}

// ─── Amount → servings of the record ─────────────────────────────────────────

export interface AmountResolution {
  /** Grams (or ml) eaten. */
  amount: number;
  unit: "g" | "ml";
  method: string;
  assumed: boolean;
  /** Use the label's per-serving values times this, instead of per-100 arithmetic. */
  labelServings?: number;
}

const HOUSEHOLD_ML: Record<string, number> = { cup: 8 * ML_PER_FL_OZ, tbsp: 14.79, tsp: 4.93, "fl oz": ML_PER_FL_OZ };
const unitStem = (u: string) => {
  const w = String(u || "").toLowerCase().replace(/\./g, "").trim();
  if (/^(tbsp|tablespoons?)$/.test(w)) return "tbsp";
  if (/^(tsp|teaspoons?)$/.test(w)) return "tsp";
  if (/^cups?$/.test(w)) return "cup";
  if (/^(fl oz|floz|fluid ounces?)$/.test(w)) return "fl oz";
  return stem(w);
};

function portionFor(c: SourceCandidate, unit: string | null, phrase: string): SourcePortion | null {
  const portions = c.portions || [];
  if (portions.length === 0) return null;
  const real = portions.filter((p) => !/^\s*\d+(\.\d+)?\s*(oz|g|gram|grams|lb)\b/i.test(p.label));
  if (unit) {
    const u = unitStem(unit);
    const words = (p: SourcePortion) => p.label.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).map(unitStem);
    return real.find((p) => words(p).includes(u)) || null;
  }
  // A bare count ("2 samosas", "an apple"): the measure that is one of the thing.
  const nameTok = new Set(foodTokens(phrase));
  const one = (p: SourcePortion) => /^\s*1(\.0)?\b/.test(p.label) || !/^\s*\d/.test(p.label);
  return real.find((p) => one(p) && foodTokens(p.label).some((t) => nameTok.has(t)))
    || real.find((p) => one(p) && /\b(medium|each|whole|piece|item|unit|regular|sandwich|serving|bar|slice)\b/i.test(p.label))
    || null;
}

/**
 * How much of the record the user's wording is. A stated weight or volume is
 * used as given; a household measure or a count goes through the record's
 * own measures; only when the record has none does the chooser's reading
 * (`assumedAmount`) apply, and the result is marked assumed.
 */
export function resolveAmount(c: SourceCandidate, q: QuantityNormalization, phrase: string, pick: SourcePick = { pick: 0 }): AmountResolution | null {
  const perUnit = c.per100Unit || "g";
  const unit = String(q.unit || "").toLowerCase();
  const isHousehold = /^(cups?|tbsp|tablespoons?|tsp|teaspoons?)$/.test(unit);
  const count = q.count ?? (q.amount != null && !q.grams && !q.ml ? q.amount : null);
  const servingAmount = c.serving ? (perUnit === "ml" ? c.serving.ml ?? c.serving.grams : c.serving.grams ?? c.serving.ml) : undefined;

  // "half the bag" / "the whole container", when the record knows its package.
  if (q.packageFraction != null && c.package) {
    const pkg = perUnit === "ml" ? c.package.ml ?? c.package.grams : c.package.grams ?? c.package.ml;
    if (pkg) return { amount: pkg * q.packageFraction, unit: perUnit, method: `${Math.round(q.packageFraction * 100)}% of ${c.package.label}`, assumed: false };
  }
  // A weight.
  if (q.grams != null && !q.assumption) {
    let grams = q.grams;
    let note = "";
    if (weighedWithInedible(phrase) && pick.edibleFraction && pick.edibleFraction > 0.2 && pick.edibleFraction < 1) {
      grams = q.grams * pick.edibleFraction;
      note = ` with inedible part ≈ ${Math.round(grams)} g edible (${Math.round(pick.edibleFraction * 100)}%, estimated)`;
    }
    // Solid ounces of a drink sold by volume are read as fluid ounces by the caller's normalizer.
    return { amount: grams, unit: "g", method: `${round2(q.grams)} g${note}`, assumed: !!note, ...(servingAmount && perUnit === "g" && c.perServing ? { labelServings: grams / servingAmount } : {}) };
  }
  // A household measure the label's serving is stated in: "1 tbsp" of a product
  // whose serving is "2 tbsp (37 g)" is half a serving.
  if (isHousehold && q.amount != null && servingAmount && c.serving) {
    const m = c.serving.label.toLowerCase().match(/(\d+(?:\.\d+)?|\d+\s*\/\s*\d+)\s*(cups?|tbsp|tablespoons?|tsp|teaspoons?)\b/);
    if (m && unitStem(m[2]) === unitStem(unit)) {
      const per = leadingCount(m[1]);
      return { amount: servingAmount * q.amount / per, unit: perUnit, method: `${q.amount} ${unit} ÷ ${per} ${unitStem(unit)} per serving (${c.serving.label})`, assumed: false, labelServings: q.amount / per };
    }
  }
  // A household measure of a food that lists it ("1 cup" of cooked quinoa = 185 g).
  if (isHousehold && q.amount != null) {
    const p = portionFor(c, unit, phrase);
    if (p) return { amount: p.grams * q.amount / leadingCount(p.label), unit: "g", method: `${q.amount} ${unit} × ${round2(p.grams / leadingCount(p.label))} g per ${unitStem(unit)} (${p.label})`, assumed: false };
  }
  // A volume.
  if (q.ml != null && !q.assumption) {
    if (perUnit === "ml") return { amount: q.ml, unit: "ml", method: `${round2(q.ml)} ml`, assumed: false, ...(servingAmount && c.perServing ? { labelServings: q.ml / servingAmount } : {}) };
    // A per-100 g record measured by volume: through its cup measure when it has one.
    const cup = portionFor(c, "cup", phrase);
    if (cup) {
      const gPerMl = cup.grams / leadingCount(cup.label) / HOUSEHOLD_ML.cup;
      return { amount: q.ml * gPerMl, unit: "g", method: `${round2(q.ml)} ml × ${round2(gPerMl)} g/ml (${cup.label})`, assumed: false };
    }
    if (pick.assumedAmount && pick.assumedAmount > 0) return { amount: pick.assumedAmount, unit: "g", method: `${round2(q.ml)} ml read as about ${Math.round(pick.assumedAmount)} g`, assumed: true };
    return { amount: q.ml, unit: "g", method: `${round2(q.ml)} ml taken as ${round2(q.ml)} g (density not on record)`, assumed: true };
  }
  // "2 servings" / a count of a labelled product.
  if (count != null && servingAmount && (/^servings?$|^portions?$/.test(unit) || !unit || c.dataType === "Branded" || c.provider === "off")) {
    const perPiece = pieceShare(c, unit, phrase);
    return { amount: servingAmount * count * perPiece, unit: perUnit, method: `${round2(count * perPiece)} × ${c.serving!.label}`, assumed: false, labelServings: count * perPiece };
  }
  // A count of a generic food: its own measure for one of it.
  if (count != null) {
    const p = portionFor(c, unit && !isHousehold ? unit : null, phrase) || (unit ? portionFor(c, null, phrase) : null);
    if (p) return { amount: p.grams * count / leadingCount(p.label), unit: "g", method: `${count} × ${p.label} (${round2(p.grams / leadingCount(p.label))} g each)`, assumed: false };
  }
  // The record cannot say how big "a bowl" or "one" is: the chooser's reading, labelled as an assumption.
  if (pick.assumedAmount && pick.assumedAmount > 0) {
    return { amount: pick.assumedAmount, unit: perUnit, method: `"${q.original.slice(0, 40)}" read as about ${Math.round(pick.assumedAmount)} ${perUnit}`, assumed: true };
  }
  if (servingAmount) return { amount: servingAmount, unit: perUnit, method: `assumed 1 serving (${c.serving!.label})`, assumed: true, labelServings: 1 };
  const first = portionFor(c, null, phrase);
  if (first) return { amount: first.grams / leadingCount(first.label), unit: "g", method: `assumed ${first.label}`, assumed: true };
  return null;
}

const leadingCount = (label: string): number => {
  const m = String(label).match(/^\s*(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?/);
  if (!m) return 1;
  const n = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  return isFinite(n) && n > 0 ? n : 1;
};

/** "7 cookies" of a product whose serving is "3 cookies (34 g)": each cookie is a third of a serving. */
function pieceShare(c: SourceCandidate, unit: string, phrase: string): number {
  if (/^servings?$|^portions?$/.test(unit)) return 1;
  const label = String(c.serving?.label || "").toLowerCase();
  const m = label.match(/(\d+(?:\.\d+)?)\s+([a-z]+)/);
  if (!m || !(Number(m[1]) > 0)) return 1;
  const noun = unitStem(m[2]);
  // "7 cookies" (unit given) or "2 Kodiak waffles" (the noun is in the food's name).
  if (unit ? noun === unitStem(unit) : foodTokens(phrase).includes(stem(m[2]))) return 1 / Number(m[1]);
  return 1;
}

// ─── The chooser (a model reads; it never supplies a figure) ─────────────────

const CHOOSE_SYSTEM = `You match foods a person logged to records from food databases. You never supply nutrition figures.
For each numbered ask you get the person's words and a list of candidate records. Return ONLY JSON:
{"picks":[{"ask":1,"pick":<candidate number or null>,"assumedAmount":<number or null>,"edibleFraction":<number or null>}]}
Rules:
- pick the candidate that IS the food the person described: same food, same form (raw vs cooked, dry vs prepared, drained, with or without skin), same variety (zero sugar vs regular, whole vs reduced fat, flavor) and, for a product, the same brand and product line. Prefer a plain single-ingredient reference record for a plain food. When the person did not say raw or cooked, choose the form the food is normally eaten in.
- null when no candidate is that food (a different brand, a different dish, a different form). A wrong record is worse than none.
- A plain food the person did not attribute to a brand (salmon, quinoa, an egg) is a reference record (Foundation, SR Legacy, Survey), never a packaged product that happens to share its name.
- When the same product is offered by USDA (Branded) and by Open Food Facts, pick the USDA record: it is the manufacturer's own label. Pick an Open Food Facts record only when it is clearly the product and its calories are plausible for that kind of food.
- assumedAmount: ONLY when the person gave no weight or volume and the amount is a loose one ("a bowl", "a plate", "one", "a handful", "a large one"): your best reading of that amount in grams (ml for a drink). Otherwise null. Never fill it when a weight or volume was stated.
- edibleFraction: ONLY when the person says the stated weight includes peel, skin, bone, shell or pit: the typical edible share (0-1). Otherwise null.`;

export async function modelChoose(asks: Array<{ ask: SourceAsk; candidates: SourceCandidate[] }>, timeoutMs = 7000): Promise<SourcePick[] | null> {
  if (process.env.NUTRITION_LOOKUP_DISABLE === "1" || !process.env.ANTHROPIC_API_KEY) return null;
  if (asks.length === 0) return [];
  const describe = (c: SourceCandidate, i: number) =>
    `${i + 1}. ${c.brand ? `[${c.brand}] ` : ""}${c.name}${c.dataType ? ` — ${c.dataType}` : ""}${c.serving ? ` — serving ${c.serving.label}` : ""}${c.per100?.calories != null ? ` — ${Math.round(c.per100.calories)} kcal/100${c.per100Unit || "g"}` : ""}`;
  const user = asks.map((a, i) => `ASK ${i + 1}\nFood: ${JSON.stringify(a.ask.phrase)}\nTheir words for how much: ${JSON.stringify(a.ask.quantityText)}\nCandidates:\n${a.candidates.map(describe).join("\n")}`).join("\n\n");
  try {
    const client = getAnthropicClient("standard");
    const resp = await client.messages.create(
      { model: process.env.NUTRITION_ESTIMATE_MODEL || "claude-haiku-4-5-20251001", max_tokens: 600, system: CHOOSE_SYSTEM, messages: [{ role: "user", content: user }] },
      { timeout: timeoutMs, maxRetries: 0 },
    );
    const text = resp.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const picks: any[] = Array.isArray(parsed?.picks) ? parsed.picks : [];
    return asks.map((a, i) => {
      const p = picks.find((x) => Number(x?.ask) === i + 1);
      const n = Number(p?.pick);
      const num = (v: any) => (typeof v === "number" && isFinite(v) && v > 0 ? v : null);
      return { pick: p && isFinite(n) && n >= 1 && n <= a.candidates.length ? n - 1 : null, assumedAmount: num(p?.assumedAmount), edibleFraction: num(p?.edibleFraction) };
    });
  } catch (e: any) {
    logger.warn("nutrition-sources", `chooser unavailable: ${e?.message || e}`);
    return null;
  }
}

/** No chooser: take the best-scoring record, only when its name clearly explains the phrase. */
export function scoreChoose(ask: SourceAsk, candidates: SourceCandidate[]): SourcePick {
  let best = -1;
  let bestScore = 0;
  candidates.forEach((c, i) => { const s = scoreCandidate(ask.phrase, c); if (s > bestScore) { best = i; bestScore = s; } });
  return { pick: best >= 0 && bestScore >= (ask.branded ? 0.7 : 0.62) ? best : null };
}

// ─── Resolution ──────────────────────────────────────────────────────────────

const SOURCE_NAME = (c: SourceCandidate) =>
  c.provider === "off" ? `Open Food Facts product ${c.id}` : `USDA FoodData Central ${c.dataType || ""} #${c.id}`.replace(/\s+/g, " ");

/** The component a chosen record and the user's amount make. Null when the amount cannot be read against it. */
export function componentFromSource(c: SourceCandidate, ask: SourceAsk, pick: SourcePick, now: string, opts: { chosenByModel?: boolean; byBarcode?: boolean } = {}): NutritionComponent | null {
  const q = normalizeQuantity(ask.quantityText || ask.phrase);
  const amount = resolveAmount(c, q, `${ask.phrase} ${ask.quantityText}`, pick);
  if (!amount) return null;
  const labelled = c.dataType === "Branded" || c.provider === "off";
  // The label's printed per-serving values are used whenever the amount is a
  // number of label servings: per-100 figures are back-calculated from the
  // label and carry its rounding twice.
  const useLabel = !!c.perServing && amount.labelServings != null && !!c.serving;
  let perServing: NutrientVector;
  let servings: number;
  let serving: NutritionComponent["matchedServing"];
  if (useLabel) {
    perServing = c.perServing!;
    servings = amount.labelServings!;
    serving = { amount: 1, unit: "serving", grams: c.serving!.grams ?? null, ml: c.serving!.ml ?? null, label: c.serving!.label };
  } else if (c.per100) {
    // A record measured per 100 g cannot price a volume, and the reverse.
    if (amount.unit !== (c.per100Unit || "g")) return null;
    perServing = c.per100;
    servings = amount.amount / 100;
    serving = { amount: 100, unit: c.per100Unit || "g", grams: c.per100Unit === "ml" ? null : 100, ml: c.per100Unit === "ml" ? 100 : null, label: `100 ${c.per100Unit || "g"}` };
  } else return null;
  if (!isFinite(servings) || servings <= 0) return null;

  const confidence: EnrichmentConfidence = amount.assumed ? "medium" : opts.byBarcode ? "exact" : opts.chosenByModel || labelled ? "high" : "medium";
  const sourceType = labelled ? "product_database" : "reference";
  const source = `${SOURCE_NAME(c)}${opts.byBarcode ? " (barcode match)" : ""} · ${amount.method}`;
  const name = c.brand && !new RegExp(c.brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(c.name) ? `${c.brand} ${c.name}` : c.name;
  const perWithFluid: NutrientVector = c.isBeverage && serving?.ml ? { ...perServing, fluidMl: Math.round(serving.ml) } : perServing;
  return {
    name,
    brand: c.brand,
    userQuantity: ask.quantityText || ask.phrase,
    normalizedQuantity: q,
    servings: Math.round(servings * 1e6) / 1e6,
    matchedServing: serving,
    sourceType,
    source,
    sourceItem: name,
    confidence,
    perServing: perWithFluid,
    nutrients: componentNutrients(perWithFluid, servings, { source, sourceType, sourceItem: name, confidence, enrichedAt: now }),
    isBeverage: !!c.isBeverage,
    servingAssumed: amount.assumed,
    sourceRef: { provider: c.provider, id: c.id, ...(c.barcode ? { barcode: c.barcode } : {}), ...(c.dataType ? { dataType: c.dataType } : {}) },
  };
}

/**
 * Resolve each ask against the databases: search, choose, read the amount,
 * compute. One search per ask (two for a branded phrase: both databases), one
 * chooser call for all asks together, at most one detail request per chosen
 * record. Returns a component or null per ask, in order.
 */
export async function resolveFromSources(asks: SourceAsk[], deps: SourceDeps = {}): Promise<Array<NutritionComponent | null>> {
  const now = (deps.now || (() => new Date().toISOString()))();
  const deadline = Date.now() + (deps.deadlineMs ?? 12_000);
  const out: Array<NutritionComponent | null> = asks.map(() => null);
  if (asks.length === 0) return out;

  // A barcode names the product outright.
  await Promise.all(asks.map(async (ask, i) => {
    const code = barcodeIn(`${ask.phrase} ${ask.quantityText}`);
    if (!code) return;
    const c = await barcodeLookup(code, deps);
    if (c) out[i] = componentFromSource(c, { ...ask, quantityText: ask.quantityText.replace(code, " ") }, { pick: 0 }, now, { byBarcode: true });
  }));

  const open = asks.map((_, i) => i).filter((i) => !out[i]);
  if (open.length === 0 || Date.now() > deadline) return out;
  const searched = await Promise.all(open.map(async (i) => {
    const ask = asks[i];
    const query = searchQuery(ask.phrase);
    // A restaurant's own items are published in USDA's reference set under
    // the restaurant's name ("McDONALD'S, Egg McMUFFIN"). Only a record that
    // carries that name is the restaurant's food; anything else (a frozen
    // retail "burrito bowl") is refused before the chooser sees it.
    const restaurant = restaurantIn(ask.phrase);
    const lists = restaurant
      ? (await Promise.all([fdcSearch(query, "generic", deps), fdcSearch(query, "branded", deps)]))
          .map((list) => list.filter((c) => `${c.brand || ""} ${c.name}`.toLowerCase().replace(/[^a-z ]/g, "").includes(restaurant)))
      : ask.branded
      ? await Promise.all([fdcSearch(query, "branded", deps), offSearch(query, deps)])
      : ask.maybeBranded
      // A capitalised name with no known brand ("Baked Farmed Atlantic Salmon",
      // "Kodiak Power Cakes") may be a plain food or a product: both are offered,
      // reference records first, and the chooser is told to prefer the plain one.
      ? await Promise.all([fdcSearch(query, "generic", deps), fdcSearch(query, "branded", deps)])
      : [await fdcSearch(query, "generic", deps)];
    // Best few by name fit, so the chooser reads a short list.
    // Name fit first; on a tie the manufacturer-submitted USDA record is listed
    // before a crowd-sourced one, and a plain reference record before a product.
    const rank = (c: SourceCandidate) => (c.provider === "fdc" ? (c.dataType === "Branded" ? 1 : 0) : 2);
    // No known brand in the words, and a reference record fits the name: the
    // packaged products are not offered at all ("Baked Atlantic Cod" was
    // matched to a retail fillet with a different fat content).
    const all = lists.flat();
    const isReference = (c: SourceCandidate) => c.provider === "fdc" && c.dataType !== "Branded";
    const pool = ask.maybeBranded && all.some((c) => isReference(c) && scoreCandidate(ask.phrase, c) >= 0.55) ? all.filter(isReference) : all;
    const candidates = pool
      .map((c) => ({ c, s: scoreCandidate(ask.phrase, c) }))
      .sort((a, b) => b.s - a.s || rank(a.c) - rank(b.c))
      .slice(0, 12)
      .map((x) => x.c);
    return { i, ask, candidates };
  }));
  const withCandidates = searched.filter((s) => s.candidates.length > 0);
  if (withCandidates.length === 0 || Date.now() > deadline) return out;

  let picks: SourcePick[] | null = null;
  try { picks = await (deps.choose || modelChoose)(withCandidates.map((s) => ({ ask: s.ask, candidates: s.candidates }))); } catch { picks = null; }
  const chosenByModel = !!picks;
  await Promise.all(withCandidates.map(async (s, k) => {
    const pick = picks ? picks[k] : scoreChoose(s.ask, s.candidates);
    if (!pick || pick.pick == null) return;
    let c = s.candidates[pick.pick];
    if (!c) return;
    // Household measures and the printed label live on the record's detail.
    if (c.provider === "fdc" && Date.now() < deadline) c = await fdcDetail(c, deps);
    out[s.i] = componentFromSource(c, s.ask, pick, now, { chosenByModel });
  }));
  return out;
}

/** Restaurants and chains: their food is not a packaged product, and a retail product that shares a word with the order is not it. */
const RESTAURANT_RE = /\b(mcdonald'?s|chipotle|starbucks|subway|wendy'?s|burger king|taco bell|chick-?fil-?a|panera|dunkin'?|kfc|popeyes|domino'?s|pizza hut|five guys|in-?n-?out|shake shack|panda express|olive garden|sweetgreen|cava|qdoba|jimmy john'?s|jersey mike'?s|arby'?s|sonic|dairy queen|little caesars|papa john'?s|applebee'?s|chili'?s|ihop|denny'?s|cheesecake factory|tim hortons|dutch bros|jamba|wingstop|culver'?s|whataburger|jack in the box|carl'?s jr|hardee'?s|del taco|el pollo loco|red lobster|outback|texas roadhouse|buffalo wild wings|zaxby'?s|raising cane'?s|bojangles|white castle|krispy kreme|cinnabon|auntie anne'?s|baskin-?robbins|cold stone|nando'?s|pret|greggs|tim horton'?s|wagamama)\b/i;
/** The restaurant a phrase names, lower-cased without punctuation, or null. */
export function restaurantIn(phrase: string): string | null {
  const m = String(phrase || "").match(RESTAURANT_RE);
  return m ? m[1].toLowerCase().replace(/[^a-z ]/g, "") : null;
}

/** The words to search a database with: the food, without amounts, verbs and filler. */
export function searchQuery(phrase: string): string {
  return String(phrase || "")
    .replace(/\([^)]*\)/g, (m) => (/\d/.test(m) ? " " : ` ${m.slice(1, -1)} `))
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:-\s*)?(fl\.?\s*oz|oz|ounces?|ml|l|g|grams?|kg|lbs?|pounds?|cups?|tbsp|tsp|tablespoons?|teaspoons?|servings?|slices?|pieces?)\b/gi, " ")
    .replace(/\bhalf\s+(?=(?:a|an|of|the)\b)/gi, " ")
    .replace(/\b(i|ate|had|drank|about|around|approximately|roughly|some|a|an|the|of|my|one|two|three|four|five|six|weighed|before cooking|including the peel)\b/gi, " ")
    .replace(/(?<![a-z])\d+(?:[.,]\d+)?(?![a-z%])/gi, " ")
    .replace(/[^\p{L}\p{N}%&' -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export { canonicalNutrientKey };
