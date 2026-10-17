// ─── Item Enrichment Layer: the server side ──────────────────────────────────
//
// Order of operations, always:
//   1. the chat agent extracts what the user said and the base Nutrition entry
//      is SAVED (ai-engine log_tracker_entry) — nothing here runs before that;
//   2. the entry's result carries a small candidate (entry id, item,
//      specificity) which the client posts back to /enrich AFTER the reply is
//      on screen — so the chat turn pays nothing for this layer;
//   3. this module identifies the item(s) through a lookup ladder —
//        user-stated label values → internal reference (shared/nutrition-db)
//        → product database (Open Food Facts) → a bounded model estimate —
//      computes components and a meal total with per-value provenance, and
//      refines the entry; the user's own numbers are never replaced.
//
// Anything that fails here fails SILENTLY for the user: the base entry stands
// exactly as the agent saved it. The lookups are optional, bounded and
// individually swallowed.

import type { IStorage } from "./storage";
import type { Tracker, TrackerEntry } from "@shared/schema";
import {
  ENTRY_VALUE_NUTRIENTS,
  LINKED_SOURCE_KEY,
  NUTRIENT_KEYS,
  NUTRIENT_UNITS,
  NUTRITION_ENRICHMENT_PREF_KEY,
  appliesAutomatically,
  applyUserProvided,
  buildEntryValuePatch,
  canonicalNutrientKey,
  componentNutrients,
  decideEnrichment,
  detectSpecificity,
  detectUserStatedNutrition,
  isNutritionTrackerLike,
  linkedMeasurementsFor,
  normalizeQuantity,
  overallConfidence,
  parseEnrichmentMode,
  rescaleEnrichment,
  rescalePlainValues,
  roundNutrient,
  splitComponentPhrases,
  summarizeEnrichment,
  sumComponentTotals,
  type EnrichmentConfidence,
  type EnrichmentMode,
  type EnrichmentSourceType,
  type LinkedEntryRef,
  type NutrientKey,
  type NutrientVector,
  type NutritionComponent,
  type NutritionEnrichment,
  type QuantityNormalization,
  type Specificity,
} from "@shared/nutrition-enrichment";
import { NUTRITION_DB, lookupNutritionDb, resolveServings, type NutritionDbItem } from "@shared/nutrition-db";
import { ITEM_ENRICHMENT_PREF_KEY } from "@shared/item-identity";
import { getAnthropicClient } from "./anthropic-client";
import { logger } from "./logger";

// ─── Candidate (what the chat turn emits) ───────────────────────────────────

/** Attached to a log_tracker_entry result for the client to post back. */
export interface NutritionEnrichmentCandidate {
  entryId: string;
  trackerId: string;
  trackerName: string;
  item: string;
  specificity: Specificity;
  /** The user's own words, so quantities and brands can be read from them. */
  message?: string;
}

/**
 * Decide, at log time and without I/O, whether this entry is worth a lookup.
 * Pure string work (microseconds): the preference is read later by the
 * endpoint, so the chat turn never waits on a preference query for this.
 */
export function planEnrichmentCandidate(
  entry: { id: string; values?: Record<string, any> | null } | null | undefined,
  tracker: { id: string; name: string; category?: string | null } | null | undefined,
  userMessage: string | null | undefined,
): NutritionEnrichmentCandidate | null {
  if (!entry || !tracker || !isNutritionTrackerLike(tracker)) return null;
  const item = itemTextOf(entry.values);
  const message = String(userMessage || "").trim().slice(0, 600);
  // The ENTRY must name the food: a Nutrition row with no item is not a
  // product to look up, whatever the message around it said.
  const text = item;
  if (!text) return null;
  const specificity = detectSpecificity(`${item} ${message}`.trim());
  const decision = decideEnrichment("auto", specificity, text);
  if (!decision.attempt) return null;
  return { entryId: entry.id, trackerId: tracker.id, trackerName: tracker.name, item, specificity, message: message || undefined };
}

/**
 * The preference both enrichment layers read: `item_enrichment` (Enhanced
 * Item Lookup: off | auto | ask), falling back to the nutrition-only key it
 * generalizes. Unset is Automatic.
 */
const modeMemo = new Map<string, { mode: EnrichmentMode; at: number }>();
const MODE_MEMO_MS = 5 * 60_000;
/** Forget a memoized mode (the preference route calls this on a write). */
export function forgetEnrichmentMode(userKey: string): void { modeMemo.delete(userKey); }

export async function readEnrichmentMode(storage: IStorage): Promise<EnrichmentMode> {
  const key = String((storage as any).userId || "");
  const hit = key ? modeMemo.get(key) : undefined;
  if (hit && Date.now() - hit.at < MODE_MEMO_MS) return hit.mode;
  const item = await storage.getPreference(ITEM_ENRICHMENT_PREF_KEY).catch(() => null);
  const mode = item != null && String(item).trim()
    ? parseEnrichmentMode(item)
    : parseEnrichmentMode(await storage.getPreference(NUTRITION_ENRICHMENT_PREF_KEY).catch(() => null));
  if (key) modeMemo.set(key, { mode, at: Date.now() });
  return mode;
}

/** The food the entry names, from whichever text field the agent used. */
export function itemTextOf(values: Record<string, any> | null | undefined): string {
  const v = values || {};
  for (const k of ["item", "food", "meal", "name", "description"]) {
    const s = v[k];
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return "";
}

// ─── Lookup providers (injectable) ───────────────────────────────────────────

export interface ExternalProductMatch {
  name: string;
  brand?: string;
  serving: { amount: number; unit: string; grams?: number | null; ml?: number | null; label: string };
  /** The package the product is sold in, when the source states it ("473 ml", "27.5 oz (780 g)"). */
  package?: { grams?: number; ml?: number; label: string };
  perServing: NutrientVector;
  source: string;
  sourceType: EnrichmentSourceType;
  confidence: EnrichmentConfidence;
  isBeverage?: boolean;
  /** Words of the product name, for a sanity check against the phrase. */
  unitWords?: string[];
}

export interface ModelComponentEstimate {
  name: string;
  brand?: string;
  quantityText?: string;
  servings?: number;
  serving?: { amount?: number; unit?: string; grams?: number | null; ml?: number | null; label?: string };
  nutrients: NutrientVector;
  isBeverage?: boolean;
  confidence?: EnrichmentConfidence | string;
  basis?: string;
}

/** A shorthand the user has confirmed: "fairlife choc" → a reference row or a product the database answered once. */
export type LearnedAlias = { kind: "db"; id: string } | { kind: "external"; match: ExternalProductMatch };
export const PRODUCT_ALIASES_PREF_KEY = "product_aliases";
const MAX_LEARNED_ALIASES = 300;

/** The alias key of a phrase: lower-case words, quantities and parentheticals removed. */
export function aliasKey(phrase: string): string {
  return String(phrase || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(fl\.?\s*oz|oz|ml|l|g|kg|lb|lbs|cups?|cup|tbsp|tsp|servings?|slices?|pieces?|packets?|cans?|bottles?|bars?|scoops?)\b/g, " ")
    .replace(/\b(a|an|the|of|my|some|one|two|three|half|whole|i|ate|had|drank|took)\b/g, " ")
    .replace(/[^a-z0-9&'%+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function loadLearnedAliases(storage: IStorage): Promise<Record<string, LearnedAlias>> {
  try {
    const raw = await storage.getPreference(PRODUCT_ALIASES_PREF_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

/** Remember that `phrase` means `target`, so the next mention resolves without a lookup. */
export async function learnAlias(storage: IStorage, phrase: string, target: LearnedAlias): Promise<void> {
  const key = aliasKey(phrase);
  if (!key || key.split(" ").length > 8) return;
  const all = await loadLearnedAliases(storage);
  all[key] = target;
  const keys = Object.keys(all);
  if (keys.length > MAX_LEARNED_ALIASES) for (const k of keys.slice(0, keys.length - MAX_LEARNED_ALIASES)) delete all[k];
  try { await storage.setPreference(PRODUCT_ALIASES_PREF_KEY, JSON.stringify(all)); } catch { /* best effort */ }
}

export interface EnrichmentDeps {
  /** Product database lookup for a branded phrase. Null when nothing matched. `strict` when the phrase carries no known brand, only a proper name. */
  productLookup?: (phrase: string, opts?: { strict?: boolean }) => Promise<ExternalProductMatch | null>;
  /** Shorthand the user confirmed earlier (loadLearnedAliases). */
  aliases?: Record<string, LearnedAlias>;
  /**
   * The synchronous pass inside the chat turn: deterministic tables only, no
   * generic fallback for a branded phrase (that phrase waits for the product
   * sources in the asynchronous pass), no network, no model.
   */
  syncOnly?: boolean;
  /** Model estimate for the phrases nothing else matched. */
  modelEstimate?: (input: { item: string; message: string; phrases: string[] }) => Promise<ModelComponentEstimate[] | null>;
  now?: () => string;
  /** Hard ceiling for the whole lookup, ms. */
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 12_000;

// ─── Open Food Facts ─────────────────────────────────────────────────────────

const OFF_FIELDS = "code,product_name,brands,serving_size,serving_quantity,quantity,nutriments,categories_tags";

function tokens(s: string): string[] {
  return String(s || "").toLowerCase().replace(/[^a-z0-9%&' ]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));
}
const STOP = new Set(["a", "an", "the", "of", "with", "and", "or", "in", "on", "my", "i", "ate", "had", "drank", "some", "one", "two", "cup", "cups", "oz", "packet", "can", "bottle", "glass", "slice", "slices"]);

/** Nutriments → per-serving vector. Prefers *_serving; falls back to *_100g × serving grams. */
export function nutrientsFromOffNutriments(n: Record<string, any> | null | undefined, servingQty: number | null): NutrientVector | null {
  if (!n || typeof n !== "object") return null;
  const factor = servingQty && servingQty > 0 ? servingQty / 100 : null;
  const pick = (key: string, mult = 1): number | undefined => {
    const perServing = n[`${key}_serving`];
    if (typeof perServing === "number" && isFinite(perServing)) return perServing * mult;
    const per100 = n[`${key}_100g`];
    if (factor != null && typeof per100 === "number" && isFinite(per100)) return per100 * factor * mult;
    return undefined;
  };
  const out: NutrientVector = {};
  const set = (k: NutrientKey, v: number | undefined) => { if (v != null && isFinite(v)) out[k] = roundNutrient(v, k); };
  set("calories", pick("energy-kcal"));
  if (out.calories == null) {
    const kj = pick("energy");
    if (kj != null && n["energy_unit"] === "kJ") set("calories", kj / 4.184);
  }
  set("protein", pick("proteins"));
  set("carbs", pick("carbohydrates"));
  set("fat", pick("fat"));
  set("saturatedFat", pick("saturated-fat"));
  set("fiber", pick("fiber"));
  set("sugar", pick("sugars"));
  set("addedSugar", pick("added-sugars"));
  set("sodium", pick("sodium", 1000));
  set("cholesterol", pick("cholesterol", 1000));
  set("potassium", pick("potassium", 1000));
  set("calcium", pick("calcium", 1000));
  set("iron", pick("iron", 1000));
  set("caffeine", pick("caffeine", 1000));
  if (out.calories == null && out.protein == null && out.carbs == null && out.fat == null) return null;
  return out;
}

/** "473 ml" / "27.5 oz (780 g)" / "1 L" / "14.3 oz" → the package in ml and/or grams. */
export function parsePackageQuantity(q: string): { grams?: number; ml?: number; label: string } | null {
  const t = String(q || "").toLowerCase().trim();
  if (!t) return null;
  const out: { grams?: number; ml?: number; label: string } = { label: q.trim() };
  let ozGrams: number | undefined;
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(ml|l|cl|fl\.?\s*oz|g|kg|oz|lb|lbs)\b/g)) {
    const n = parseFloat(m[1].replace(",", "."));
    const u = m[2].replace(/\s|\./g, "");
    if (!isFinite(n)) continue;
    if (u === "ml" && out.ml == null) out.ml = n;
    else if (u === "l" && out.ml == null) out.ml = n * 1000;
    else if (u === "cl" && out.ml == null) out.ml = n * 10;
    else if (u === "floz" && out.ml == null) out.ml = n * 29.5735;
    else if (u === "g" && out.grams == null) out.grams = n;
    else if (u === "kg" && out.grams == null) out.grams = n * 1000;
    else if ((u === "lb" || u === "lbs") && out.grams == null) out.grams = n * 453.6;
    else if (u === "oz" && ozGrams == null) ozGrams = n * 28.3495; // a bare oz on a package is weight — unless a gram figure follows
  }
  if (out.grams == null && out.ml == null && ozGrams != null) out.grams = Math.round(ozGrams * 10) / 10;
  return out.grams != null || out.ml != null ? out : null;
}

/**
 * Open Food Facts product search for a branded phrase. Free, no key; label
 * data contributed per product. Bounded to one request with a short timeout.
 * Disabled with NUTRITION_LOOKUP_DISABLE=1.
 */
export async function openFoodFactsLookup(phrase: string, opts: { timeoutMs?: number; strict?: boolean } = {}): Promise<ExternalProductMatch | null> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  if (process.env.NUTRITION_LOOKUP_DISABLE === "1") return null;
  const q = String(phrase || "").trim();
  if (!q) return null;
  const url = `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=10&fields=${OFF_FIELDS}`;
  let data: any;
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Portol/1.0 (nutrition enrichment; https://portol.me)", Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    data = await resp.json();
  } catch {
    return null;
  }
  const products: any[] = Array.isArray(data?.products) ? data.products : [];
  const qTok = tokens(q);
  if (qTok.length === 0) return null;
  let best: { p: any; score: number } | null = null;
  for (const p of products) {
    const name = String(p?.product_name || "").trim();
    if (!name) continue;
    const brands = String(p?.brands || "");
    const pTok = new Set([...tokens(name), ...tokens(brands)]);
    const hit = qTok.filter((t) => pTok.has(t)).length;
    const coverage = hit / qTok.length;                 // how much of the user's phrase the product explains
    const precision = hit / Math.max(1, new Set(tokens(name)).size); // how much of the product name the phrase explains
    const score = coverage * 0.7 + precision * 0.3;
    const hasNutrients = !!nutrientsFromOffNutriments(p?.nutriments, Number(p?.serving_quantity) || null);
    if (!hasNutrients) continue;
    if (!best || score > best.score) best = { p, score };
  }
  // A phrase with a KNOWN brand can take a looser name match; one that is
  // only a proper name must be covered almost entirely by the product's own
  // name, or "Peanut Butter Sandwich" would become somebody's crackers.
  const minScore = opts.strict ? 0.75 : 0.6;
  if (!best || best.score < minScore) return null;
  if (opts.strict) {
    const pTok = new Set([...tokens(best.p.product_name), ...tokens(best.p.brands || "")]);
    const coverage = qTok.filter((t) => pTok.has(t)).length / qTok.length;
    if (coverage < 0.8) return null;
  }
  const p = best.p;
  const servingQty = Number(p.serving_quantity) || null;
  const perServing = nutrientsFromOffNutriments(p.nutriments, servingQty);
  if (!perServing) return null;
  const servingSize = String(p.serving_size || "").trim();
  const isBeverage = /\b(ml|fl oz|cl)\b/i.test(servingSize)
    || (Array.isArray(p.categories_tags) && p.categories_tags.some((c: string) => /beverage|drink|soda|juice|water|milk|coffee|tea|energy/i.test(String(c))));
  const servingMl = isBeverage && servingQty ? servingQty : null;
  const servingG = !isBeverage && servingQty ? servingQty : null;
  if (isBeverage && servingMl) perServing.fluidMl = Math.round(servingMl);
  const label = servingSize || (servingQty ? `${servingQty} ${isBeverage ? "ml" : "g"}` : "1 serving");
  const pkg = parsePackageQuantity(String(p.quantity || ""));
  const brand = String(p.brands || "").split(",")[0].trim() || undefined;
  const fullCoverage = qTok.every((t) => new Set([...tokens(p.product_name), ...tokens(p.brands || "")]).has(t));
  const confidence: EnrichmentConfidence = fullCoverage && servingQty ? "exact" : servingQty ? "high" : "medium";
  return {
    name: brand && !new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(p.product_name) ? `${brand} ${p.product_name}` : String(p.product_name),
    brand,
    serving: { amount: 1, unit: "serving", grams: servingG, ml: servingMl, label },
    ...(pkg ? { package: pkg } : {}),
    perServing,
    source: `Open Food Facts product ${p.code || ""}`.trim(),
    sourceType: "product_database",
    confidence,
    isBeverage,
  };
}

// ─── Model estimate (Haiku, bounded) ─────────────────────────────────────────

const MODEL_ESTIMATE_SYSTEM = `You are a nutrition reference. You receive food/drink phrases a person logged and return nutrition per component as JSON.
Rules:
- Return ONLY a JSON object: {"components":[{"name":string,"brand":string|null,"quantityText":string,"servings":number,"serving":{"amount":number,"unit":string,"grams":number|null,"ml":number|null,"label":string},"nutrients":{"calories":number,"protein":number,"carbs":number,"fat":number,"saturatedFat":number|null,"fiber":number|null,"sugar":number|null,"addedSugar":number|null,"sodium":number|null,"cholesterol":number|null,"potassium":number|null,"calcium":number|null,"iron":number|null,"caffeine":number|null,"fluidMl":number|null},"isBeverage":boolean,"confidence":"high"|"medium"|"low","basis":string}]}
- One component per phrase given, in the same order. Never add a phrase that was not given.
- "nutrients" are PER SERVING as described by "serving"; "servings" is how many servings the person's quantity is (the phrase's wording decides; unstated = 1).
- Use the standard nutrition reference for generic foods (medium confidence). Use a branded product's actual label ONLY when you are certain of it (high confidence); otherwise use the closest generic food and say so in "basis" (medium). Vague wording ("some fruit") is low confidence.
- Grams: protein/carbs/fat/fiber/sugar. Milligrams: sodium/cholesterol/potassium/calcium/iron/caffeine. Calories in kcal. fluidMl only for drinks (the volume drunk per serving).
- Do not invent precision. Round sensibly. Unknown → null.`;

export async function modelEstimateComponents(
  input: { item: string; message: string; phrases: string[] },
  timeoutMs = 9000,
): Promise<ModelComponentEstimate[] | null> {
  if (process.env.NUTRITION_LOOKUP_DISABLE === "1") return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (input.phrases.length === 0) return null;
  const client = getAnthropicClient("standard");
  const model = process.env.NUTRITION_ESTIMATE_MODEL || "claude-haiku-4-5-20251001";
  const user = `Logged item: ${JSON.stringify(input.item)}\nUser's message (for quantities/brands only): ${JSON.stringify(input.message || "")}\nPhrases to estimate (one component each):\n${input.phrases.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;
  try {
    const resp = await client.messages.create(
      { model, max_tokens: 1400, system: MODEL_ESTIMATE_SYSTEM, messages: [{ role: "user", content: user }] },
      { timeout: timeoutMs, maxRetries: 0 },
    );
    const text = resp.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json);
    const comps = Array.isArray(parsed?.components) ? parsed.components : null;
    if (!comps) return null;
    return comps
      .filter((c: any) => c && typeof c === "object" && c.nutrients && typeof c.nutrients === "object")
      .map((c: any) => ({
        name: String(c.name || "").trim(),
        brand: c.brand ? String(c.brand) : undefined,
        quantityText: c.quantityText ? String(c.quantityText) : undefined,
        servings: Number(c.servings) > 0 ? Number(c.servings) : 1,
        serving: c.serving && typeof c.serving === "object" ? c.serving : undefined,
        nutrients: cleanVector(c.nutrients),
        isBeverage: !!c.isBeverage,
        confidence: String(c.confidence || "medium"),
        basis: c.basis ? String(c.basis) : undefined,
      }));
  } catch (e: any) {
    logger.warn("nutrition-enrichment", `model estimate unavailable: ${e?.message || e}`);
    return null;
  }
}

function cleanVector(raw: Record<string, any>): NutrientVector {
  const out: NutrientVector = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const key = canonicalNutrientKey(k);
    if (!key) continue;
    const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
    if (isFinite(n) && n >= 0) out[key] = roundNutrient(n, key);
  }
  return out;
}

// ─── The lookup ──────────────────────────────────────────────────────────────

interface Phrase {
  text: string;
  /** The message segment with the same food, when it carries a quantity the item text lacks. */
  quantityText: string;
}

/**
 * Pair each component phrase of the item with the user's wording for how
 * much. "Oatmeal + 2% milk" as the item, "1 packet of Quaker oatmeal with 1
 * cup of 2% milk" as the message → "1 packet …" and "1 cup of 2% milk".
 */
export function componentPhrases(item: string, message: string): Phrase[] {
  const itemParts = splitComponentPhrases(item);
  const msgParts = splitComponentPhrases(message);
  const parts = itemParts.length > 0 ? itemParts : msgParts;
  return parts.map((text) => {
    const own = normalizeQuantity(text);
    if (own.amount != null || own.count != null || own.ml != null || own.grams != null) return { text, quantityText: text };
    const tk = new Set(tokens(text));
    let best: { seg: string; overlap: number } | null = null;
    for (const seg of msgParts) {
      const overlap = tokens(seg).filter((t) => tk.has(t)).length;
      if (overlap > 0 && (!best || overlap > best.overlap)) best = { seg, overlap };
    }
    const q = best ? normalizeQuantity(best.seg) : null;
    const quantityText = q && (q.amount != null || q.count != null || q.ml != null || q.grams != null) ? best!.seg : text;
    return { text, quantityText };
  });
}

function componentFromDb(match: NutritionDbItem, phrase: Phrase, now: string): NutritionComponent {
  const qty = normalizeQuantity(phrase.quantityText);
  const resolved = resolveServings(match, qty, phrase.quantityText);
  const confidence = minConf(match.confidence, resolved.confidence);
  return {
    name: match.name,
    brand: match.brand,
    userQuantity: phrase.quantityText,
    normalizedQuantity: qty,
    servings: round3(resolved.servings),
    matchedServing: { amount: match.serving.amount, unit: match.serving.unit, grams: match.serving.grams ?? null, ml: match.serving.ml ?? null, label: match.serving.label },
    sourceType: match.sourceType,
    source: `${match.source} · ${resolved.method}`,
    sourceItem: match.name,
    confidence,
    perServing: match.perServing,
    nutrients: componentNutrients(match.perServing, resolved.servings, { source: match.source, sourceType: match.sourceType, sourceItem: match.name, confidence, enrichedAt: now }),
    isBeverage: !!match.isBeverage,
  };
}

function componentFromExternal(m: ExternalProductMatch, phrase: Phrase, now: string): NutritionComponent {
  const qty = normalizeQuantity(phrase.quantityText);
  // Reuse the db serving resolver by shaping the match like a db row.
  const asRow: NutritionDbItem = {
    id: "external", name: m.name, brand: m.brand, kind: "branded", serving: { amount: m.serving.amount, unit: m.serving.unit, grams: m.serving.grams ?? undefined, ml: m.serving.ml ?? undefined, label: m.serving.label },
    perServing: m.perServing, sourceType: m.sourceType, source: m.source, confidence: m.confidence, isBeverage: m.isBeverage, match: [], unitWords: m.unitWords,
    package: m.package,
  };
  const resolved = resolveServings(asRow, qty, phrase.quantityText);
  const confidence = minConf(m.confidence, resolved.confidence);
  return {
    name: m.name,
    brand: m.brand,
    userQuantity: phrase.quantityText,
    normalizedQuantity: qty,
    servings: round3(resolved.servings),
    matchedServing: { ...m.serving, grams: m.serving.grams ?? null, ml: m.serving.ml ?? null },
    sourceType: m.sourceType,
    source: `${m.source} · ${resolved.method}`,
    sourceItem: m.name,
    confidence,
    perServing: m.perServing,
    nutrients: componentNutrients(m.perServing, resolved.servings, { source: m.source, sourceType: m.sourceType, sourceItem: m.name, confidence, enrichedAt: now }),
    isBeverage: !!m.isBeverage,
  };
}

function componentFromModel(est: ModelComponentEstimate, phrase: Phrase, now: string): NutritionComponent {
  const qty = normalizeQuantity(est.quantityText || phrase.quantityText);
  // A model estimate is at most a generic equivalent — never "exact".
  const said = String(est.confidence || "medium").toLowerCase();
  const confidence: EnrichmentConfidence = said === "low" ? "low" : "medium";
  const servings = est.servings && est.servings > 0 ? est.servings : 1;
  const s = est.serving || {};
  const basis = est.basis ? ` (${est.basis})` : "";
  return {
    name: est.name || phrase.text,
    brand: est.brand,
    userQuantity: phrase.quantityText,
    normalizedQuantity: qty,
    servings: round3(servings),
    matchedServing: { amount: Number(s.amount) || 1, unit: String(s.unit || "serving"), grams: s.grams ?? null, ml: s.ml ?? null, label: String(s.label || "1 serving") },
    sourceType: "model_estimate",
    source: `AI estimate${basis}`,
    sourceItem: est.name || undefined,
    confidence,
    perServing: est.nutrients,
    nutrients: componentNutrients(est.nutrients, servings, { source: `AI estimate${basis}`, sourceType: "model_estimate", sourceItem: est.name || undefined, confidence, enrichedAt: now }),
    isBeverage: !!est.isBeverage,
  };
}

const minConf = (a: EnrichmentConfidence, b: EnrichmentConfidence): EnrichmentConfidence => {
  const rank = { exact: 4, high: 3, medium: 2, low: 1 } as const;
  return rank[a] <= rank[b] ? a : b;
};
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface LookupResult {
  components: NutritionComponent[];
  unresolved: string[];
  usedNetwork: boolean;
}

/**
 * Resolve every component phrase through the ladder. Phrases the internal
 * reference answers never reach the network; branded leftovers try the
 * product database; whatever remains gets ONE model call for all of them.
 */
export async function lookupComponents(
  item: string,
  message: string,
  deps: EnrichmentDeps,
  now: string,
): Promise<LookupResult> {
  const phrases = componentPhrases(item, message);
  const components: Array<NutritionComponent | null> = phrases.map(() => null);
  let usedNetwork = false;

  // 0. shorthand the user confirmed before ("fairlife choc", "quest cookies bar")
  const aliases = deps.aliases || {};
  phrases.forEach((ph, i) => {
    const learned = aliases[aliasKey(ph.text)] || aliases[aliasKey(ph.quantityText)];
    if (!learned) return;
    if (learned.kind === "db") {
      const row = NUTRITION_DB.find((r) => r.id === learned.id);
      if (row) components[i] = componentFromDb(row, ph, now);
    } else if (learned.match) {
      components[i] = componentFromExternal(learned.match, ph, now);
    }
  });

  // 1. internal reference. A GENERIC row that matches a BRANDED phrase is a
  // fallback, not an answer: "Kellogg's Special K Red Berries Breakfast
  // Cereal" contains "cereal", and the cereal average is not that product.
  // Such a match waits until the product sources below have had their turn
  // (and in the synchronous pass it waits for the asynchronous one).
  const fallback: Array<NutritionComponent | null> = phrases.map(() => null);
  phrases.forEach((ph, i) => {
    if (components[i]) return;
    const m = lookupNutritionDb(ph.text) || lookupNutritionDb(ph.quantityText);
    if (!m) return;
    const spec = detectSpecificity(ph.text);
    const branded = spec.level === "brand" || spec.level === "product";
    if (m.item.kind === "generic" && branded) fallback[i] = componentFromDb(m.item, ph, now);
    else components[i] = componentFromDb(m.item, ph, now);
  });
  if (deps.syncOnly) {
    const unresolved = phrases.filter((_, i) => !components[i]).map((p) => p.text);
    return { components: components.filter((c): c is NutritionComponent => !!c), unresolved, usedNetwork: false };
  }

  // 2. product database for branded leftovers
  const deadline = Date.now() + (deps.deadlineMs ?? DEFAULT_DEADLINE_MS);
  if (deps.productLookup) {
    const jobs = phrases.map(async (ph, i) => {
      if (components[i]) return;
      const spec = detectSpecificity(ph.text);
      if (spec.level !== "brand" && spec.level !== "product") return;
      if (Date.now() > deadline) return;
      try {
        const m = await deps.productLookup!(ph.text, { strict: !spec.signals.includes("brand") });
        if (m) { components[i] = componentFromExternal(m, ph, now); usedNetwork = true; }
      } catch { /* optional source */ }
    });
    await Promise.all(jobs);
  }

  // 3. one model call for everything still open
  const openIdx = components.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
  if (openIdx.length > 0 && deps.modelEstimate && Date.now() < deadline) {
    try {
      const ests = await deps.modelEstimate({ item, message, phrases: openIdx.map((i) => phrases[i].quantityText || phrases[i].text) });
      if (ests) {
        usedNetwork = true;
        openIdx.forEach((i, k) => {
          const est = ests[k];
          if (est && est.name) components[i] = componentFromModel(est, phrases[i], now);
        });
      }
    } catch { /* optional source */ }
  }

  // 4. the generic row, for a branded phrase no product source could answer
  phrases.forEach((_, i) => { if (!components[i] && fallback[i]) components[i] = fallback[i]; });

  const unresolved = phrases.filter((_, i) => !components[i]).map((p) => p.text);
  return { components: components.filter((c): c is NutritionComponent => !!c), unresolved, usedNetwork };
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export interface EnrichOptions {
  entryId: string;
  trackerId?: string;
  /** The entry and tracker the caller already holds (the in-turn pass): skips two reads. */
  entry?: any;
  tracker?: Tracker;
  /** The user's chat message, for quantities/brands and user-stated values. */
  message?: string;
  /** Override the stored preference (tests, explicit UI actions). */
  mode?: EnrichmentMode;
  /**
   * auto    — apply when confidence allows, else store as a proposal
   * preview — look up and store as a proposal, never touch values
   * force   — apply whatever matched (the user pressed "Use exact match")
   * reject  — the user chose the generic estimate: drop the proposal
   */
  intent?: "auto" | "preview" | "force" | "reject";
  deps?: EnrichmentDeps;
  /** The in-turn pass: deterministic tables only, applies only exact/high, never a proposal. */
  sync?: boolean;
}

export interface EnrichOutcome {
  status: NutritionEnrichment["status"];
  reason?: string;
  /** Sync pass: a product source or the model could still improve this entry — keep the asynchronous candidate. */
  needsMore?: boolean;
  enrichment?: NutritionEnrichment;
  entry?: TrackerEntry;
  trackerId?: string;
  trackerName?: string;
  linkedEntries?: LinkedEntryRef[];
  ms: number;
}

const defaultDeps = (): EnrichmentDeps => ({
  productLookup: (phrase, opts) => openFoodFactsLookup(phrase, { strict: opts?.strict }),
  modelEstimate: (input) => modelEstimateComponents(input),
  now: () => new Date().toISOString(),
});

async function resolveTracker(storage: IStorage, entry: any, trackerId?: string): Promise<Tracker | undefined> {
  const id = trackerId || entry?.trackerId;
  if (id) {
    const t = await storage.getTracker(id);
    if (t) return t;
  }
  const all = await storage.getTrackers();
  return all.find((t) => (t.entries || []).some((e: any) => e?.id === entry?.id));
}

/**
 * Refine one saved Nutrition entry. Idempotent: an entry already enriched is
 * returned as-is unless `intent` is force/reject. Never throws for a lookup
 * failure — the outcome says what happened and the base entry stands.
 */
export async function enrichNutritionEntry(storage: IStorage, opts: EnrichOptions): Promise<EnrichOutcome> {
  const started = Date.now();
  const deps: EnrichmentDeps = opts.sync
    ? { now: () => new Date().toISOString(), syncOnly: true, aliases: {}, ...(opts.deps || {}) }
    : { ...defaultDeps(), ...(opts.deps || {}) };
  const now = deps.now!();
  const done = (o: Omit<EnrichOutcome, "ms">): EnrichOutcome => ({ ...o, ms: Date.now() - started });

  const entry: any = opts.entry && opts.entry.id === opts.entryId ? opts.entry : await storage.getTrackerEntry(opts.entryId);
  if (!entry) return done({ status: "failed", reason: "entry not found" });
  const tracker = opts.tracker && opts.tracker.id === (opts.trackerId || entry.trackerId || opts.tracker.id) ? opts.tracker : await resolveTracker(storage, entry, opts.trackerId);
  if (!tracker) return done({ status: "failed", reason: "tracker not found" });
  if (!isNutritionTrackerLike(tracker)) return done({ status: "skipped", reason: "not a nutrition tracker", trackerId: tracker.id, trackerName: tracker.name });

  const mode: EnrichmentMode = opts.mode ?? await readEnrichmentMode(storage);
  const intent = opts.intent ?? "auto";
  const existing: NutritionEnrichment | undefined = entry.computed?.nutrition;

  if (mode === "off" && intent === "auto") return done({ status: "skipped", reason: "Enhanced Nutrition Lookup is off", trackerId: tracker.id, trackerName: tracker.name });

  // Shorthand the user confirmed before is the first source (one read; the
  // synchronous pass skips it to stay I/O-free beyond the entry itself).
  if (!opts.sync && deps.aliases === undefined) deps.aliases = await loadLearnedAliases(storage);

  // The user decided on a stored proposal.
  if (existing && (intent === "force" || intent === "reject")) {
    if (intent === "reject") {
      const skipped: NutritionEnrichment = { ...existing, status: "skipped", reason: "user kept the generic estimate", enrichedAt: now };
      const updated = await storage.updateTrackerEntry(tracker.id, entry.id, { computed: { nutrition: skipped } } as any);
      return done({ status: "skipped", reason: skipped.reason, enrichment: skipped, entry: updated, trackerId: tracker.id, trackerName: tracker.name });
    }
    if (existing.components.length > 0) {
      try {
        const applied = await applyEnrichment(storage, tracker, entry, { ...existing, status: "applied", reason: undefined, enrichedAt: now }, now);
        // The user confirmed this is the product: remember the wording, so the
        // next mention resolves offline.
        for (const c of existing.components) {
          if (c.sourceType !== "manufacturer" && c.sourceType !== "restaurant" && c.sourceType !== "product_database") continue;
          const row = NUTRITION_DB.find((r) => r.name === c.sourceItem);
          const target: LearnedAlias | null = row ? { kind: "db", id: row.id } : c.sourceType === "product_database" && c.matchedServing
            ? { kind: "external", match: { name: c.sourceItem || c.name, brand: c.brand, serving: { amount: c.matchedServing.amount, unit: c.matchedServing.unit, grams: c.matchedServing.grams, ml: c.matchedServing.ml, label: c.matchedServing.label }, perServing: c.perServing, source: c.source.split(" · ")[0], sourceType: c.sourceType, confidence: c.confidence, isBeverage: c.isBeverage } }
            : null;
          if (target) await learnAlias(storage, c.userQuantity || c.name, target);
        }
        return done({ status: "applied", enrichment: applied.enrichment, entry: applied.entry, linkedEntries: applied.enrichment.linkedEntries, trackerId: tracker.id, trackerName: tracker.name });
      } catch (e: any) {
        logger.warn("nutrition-enrichment", `write refused for ${tracker.name}/${entry.id.slice(0, 8)}: ${e?.message || e}`);
        return done({ status: "failed", reason: `could not write the refined values: ${String(e?.message || e).slice(0, 160)}`, enrichment: existing, trackerId: tracker.id, trackerName: tracker.name });
      }
    }
  }
  if (existing?.status === "applied" && intent === "auto") {
    return done({ status: "applied", enrichment: existing, entry, trackerId: tracker.id, trackerName: tracker.name, reason: "already enriched" });
  }

  const item = itemTextOf(entry.values);
  const message = String(opts.message || "").trim();
  const text = item || message;
  const specificity = detectSpecificity(`${item} ${message}`.trim());
  const decision = decideEnrichment(mode === "off" ? "auto" : mode, specificity, text);
  if (!decision.attempt) return done({ status: "skipped", reason: decision.reason, trackerId: tracker.id, trackerName: tracker.name });

  const userValues = detectUserStatedNutrition(message);

  let lookup: LookupResult;
  try {
    lookup = await lookupComponents(item || message, message, deps, now);
  } catch (e: any) {
    logger.warn("nutrition-enrichment", `lookup failed for entry ${entry.id}: ${e?.message || e}`);
    return done({ status: "failed", reason: "lookup failed", trackerId: tracker.id, trackerName: tracker.name });
  }
  if (lookup.components.length === 0) {
    return done({ status: "skipped", reason: `no source matched "${text.slice(0, 80)}"`, needsMore: !!opts.sync, trackerId: tracker.id, trackerName: tracker.name });
  }
  if (lookup.unresolved.length > 0) {
    // A partial meal total would under-count. Keep the base estimate.
    return done({ status: "skipped", reason: `could not identify: ${lookup.unresolved.join(", ")}`, needsMore: !!opts.sync, trackerId: tracker.id, trackerName: tracker.name });
  }

  const summed = sumComponentTotals(lookup.components, now);
  const { totals, userProvided } = applyUserProvided(summed, userValues, now);
  const confidence = overallConfidence(lookup.components);
  // A LOW-confidence match is a rough generic estimate — exactly what the
  // base entry already carries. Showing it as a proposal under the saved
  // numbers is a second guess competing with the first (the Special K
  // screenshot), so it is dropped unless the user explicitly asks for it.
  if (confidence === "low" && intent !== "force") {
    return done({ status: "skipped", reason: "only a rough generic estimate matched — the saved estimate stands", trackerId: tracker.id, trackerName: tracker.name });
  }
  const enrichment: NutritionEnrichment = {
    version: 1,
    status: "proposed",
    mode,
    specificity,
    sourceText: text,
    components: lookup.components,
    totals,
    userProvided,
    userValues,
    confidence,
    servingFactor: 1,
    linkedEntries: [],
    summary: summarizeEnrichment({ components: lookup.components, totals }),
    enrichedAt: now,
  };

  // The in-turn pass writes only what a label or a menu states (exact/high)
  // and never leaves a proposal behind; anything less waits for the full pass.
  if (opts.sync && (confidence === "medium" || !appliesAutomatically(mode, confidence))) {
    return done({ status: "skipped", reason: `sync pass: ${confidence} — left for the full lookup`, needsMore: true, trackerId: tracker.id, trackerName: tracker.name });
  }
  const shouldApply = intent === "force" || (intent === "auto" && appliesAutomatically(mode, confidence));
  if (!shouldApply) {
    enrichment.reason = intent === "preview" ? "preview" : mode === "ask" ? "waiting for the user" : `confidence ${confidence} — kept the generic estimate`;
    const updated = await storage.updateTrackerEntry(tracker.id, entry.id, { computed: { nutrition: enrichment } } as any);
    return done({ status: "proposed", reason: enrichment.reason, enrichment, entry: updated, trackerId: tracker.id, trackerName: tracker.name });
  }

  let applied: Awaited<ReturnType<typeof applyEnrichment>>;
  try {
    applied = await applyEnrichment(storage, tracker, entry, { ...enrichment, status: "applied" }, now);
  } catch (e: any) {
    // A refused write (the value guard, a collision) leaves the base entry as
    // the agent saved it; the caller learns why instead of a bare 500.
    logger.warn("nutrition-enrichment", `write refused for ${tracker.name}/${entry.id.slice(0, 8)}: ${e?.message || e}`);
    return done({ status: "failed", reason: `could not write the refined values: ${String(e?.message || e).slice(0, 160)}`, enrichment, trackerId: tracker.id, trackerName: tracker.name });
  }
  logger.info("nutrition-enrichment", `applied to ${tracker.name}/${entry.id.slice(0, 8)}: ${applied.enrichment.summary} [${confidence}${lookup.usedNetwork ? ", network" : ", internal"}] in ${Date.now() - started}ms`);
  return done({ status: "applied", enrichment: applied.enrichment, entry: applied.entry, linkedEntries: applied.enrichment.linkedEntries, trackerId: tracker.id, trackerName: tracker.name });
}

/** Make sure every nutrient the patch writes is a first-class field on the tracker. */
async function ensureNutrientFields(storage: IStorage, tracker: Tracker, keys: string[]): Promise<Tracker> {
  const have = new Set((tracker.fields || []).map((f: any) => String(f.name).toLowerCase()));
  const missing = keys.filter((k) => !have.has(k.toLowerCase()));
  if (missing.length === 0) return tracker;
  const fields = [
    ...(tracker.fields || []),
    ...missing.map((k) => ({ name: k, type: "number" as const, unit: NUTRIENT_UNITS[k as NutrientKey] || undefined })),
  ];
  try {
    const updated = await storage.updateTracker(tracker.id, { fields } as any);
    return updated || tracker;
  } catch {
    return tracker;
  }
}

/**
 * The estimation-engine-shaped provenance (shared/estimation-engine
 * `Enrichment`) the tracker UIs already read for the `≈` marker: label-grade
 * values are measured facts; generic/model values are estimates.
 */
function provenanceForUi(e: NutritionEnrichment): Record<string, any> {
  const calculated: Record<string, any> = {};
  const estimated: Record<string, any> = {};
  const score = { exact: 0.98, high: 0.85, medium: 0.6, low: 0.4 } as const;
  for (const [k, t] of Object.entries(e.totals)) {
    if (!t || !(ENTRY_VALUE_NUTRIENTS as readonly string[]).includes(k)) continue;
    const method = `${t.source}${t.calculatedOrDirect === "calculated" ? " (calculated)" : ""}`;
    if (t.sourceType === "user") continue; // the user's number is not provenance we add
    if (t.confidence === "exact" || t.confidence === "high") {
      calculated[k] = { value: t.value, source: "document", confidence: score[t.confidence], method, isEstimated: false };
    } else {
      estimated[k] = { value: t.value, source: "estimated", confidence: score[t.confidence], method, isEstimated: true };
    }
  }
  return { activityType: "nutrition", canonical: {}, calculated, estimated, assumptions: e.components.flatMap((c) => c.normalizedQuantity.assumption ? [{ field: c.name, assumption: c.normalizedQuantity.assumption, valueUsed: c.userQuantity, confidence: score[c.confidence] }] : []) };
}

async function applyEnrichment(
  storage: IStorage,
  tracker: Tracker,
  entry: any,
  enrichment: NutritionEnrichment,
  now: string,
): Promise<{ enrichment: NutritionEnrichment; entry: TrackerEntry | undefined }> {
  const patch = buildEntryValuePatch(entry.values || {}, enrichment);
  // Always carry `calories` so the normalizer's lone-number fallback can never
  // fold a single new key (caffeine) onto the primary field.
  if (patch.calories == null) {
    const own = Number(entry.values?.calories);
    const cal = isFinite(own) && own > 0 ? own : enrichment.totals.calories?.value;
    if (typeof cal === "number") patch.calories = cal;
  }
  const t = await ensureNutrientFields(storage, tracker, Object.keys(patch));
  const linked = await writeLinkedEntries(storage, t, entry, enrichment, now);
  const final: NutritionEnrichment = { ...enrichment, linkedEntries: linked, enrichedAt: now };
  const computed: Record<string, any> = { nutrition: final, enrichment: provenanceForUi(final) };
  const updated = await storage.updateTrackerEntry(t.id, entry.id, { ...(Object.keys(patch).length > 0 ? { values: patch } : {}), computed } as any);
  return { enrichment: final, entry: updated };
}

/**
 * One source item, several trackers: a 12 oz Coke is fluid on Hydration and
 * caffeine on a Caffeine tracker, when the user HAS those trackers (none is
 * created for this). Each linked row names its source entry, so deleting or
 * rescaling the Coke carries them along, and a row the agent already wrote
 * for the same drink in the same minute is left alone rather than doubled.
 */
async function writeLinkedEntries(storage: IStorage, tracker: Tracker, entry: any, enrichment: NutritionEnrichment, now: string): Promise<LinkedEntryRef[]> {
  const measurements = linkedMeasurementsFor(enrichment);
  if (measurements.length === 0) return enrichment.linkedEntries || [];
  const refs: LinkedEntryRef[] = [...(enrichment.linkedEntries || [])];
  let trackers: Tracker[];
  try { trackers = await storage.getTrackers(); } catch { return refs; }
  const ownerId: string | undefined = entry.profileId || (tracker.linkedProfiles || [])[0];
  const ts = Date.parse(String(entry.timestamp || now)) || Date.now();
  for (const m of measurements) {
    if (refs.some((r) => r.nutrient === m.nutrient)) continue; // already linked (re-apply)
    const target = trackers.find((t) => t.id !== tracker.id
      && m.trackerPatterns.test(String(t.name || ""))
      && !isNutritionTrackerLike(t)
      && (!ownerId || !(t.linkedProfiles || []).length || (t.linkedProfiles || []).includes(ownerId)));
    if (!target) continue;
    const field = (target.fields || []).find((f: any) => f.type === "number" && (f as any).isPrimary)?.name
      || (target.fields || []).find((f: any) => f.type === "number")?.name
      || m.field;
    const value = m.toFieldValue(m.value);
    const dup = (target.entries || []).find((e: any) => {
      const dt = Math.abs((Date.parse(String(e.timestamp)) || 0) - ts);
      if (dt > 3 * 60_000) return false;
      if (e.values?.[LINKED_SOURCE_KEY] === entry.id) return true;
      const v = Number(e.values?.[field]);
      return isFinite(v) && Math.abs(v - value) <= Math.max(0.5, value * 0.05);
    });
    if (dup) {
      if (dup.values?.[LINKED_SOURCE_KEY] === entry.id) refs.push({ trackerId: target.id, entryId: dup.id, trackerName: target.name, nutrient: m.nutrient, value: m.value, unit: m.unit });
      continue;
    }
    try {
      const row = await storage.logEntry({
        trackerId: target.id,
        values: { [field]: value, [LINKED_SOURCE_KEY]: entry.id, _sourceItem: enrichment.components.map((c) => c.name).join(" + ") },
        profileId: ownerId,
        forProfile: ownerId,
        timestamp: entry.timestamp,
      } as any);
      if (row) refs.push({ trackerId: target.id, entryId: row.id, trackerName: target.name, nutrient: m.nutrient, value: m.value, unit: m.unit });
    } catch (e: any) {
      logger.warn("nutrition-enrichment", `linked ${target.name} entry failed: ${e?.message || e}`);
    }
  }
  return refs;
}

// ─── Edit: serving factor ────────────────────────────────────────────────────

/**
 * "Actually I only ate half" / "Edit serving size": scale the entry's
 * nutrient values, its components and totals, and every linked measurement by
 * one factor. One entry, edited in place — never a duplicate row.
 */
export async function rescaleNutritionEntry(
  storage: IStorage,
  opts: { entryId: string; trackerId?: string; factor: number; now?: () => string },
): Promise<{ ok: boolean; reason?: string; entry?: TrackerEntry; factor: number; linkedUpdated: number }> {
  const factor = Number(opts.factor);
  if (!isFinite(factor) || factor <= 0 || factor > 100) return { ok: false, reason: "factor must be a positive number", factor, linkedUpdated: 0 };
  const now = (opts.now || (() => new Date().toISOString()))();
  const entry: any = await storage.getTrackerEntry(opts.entryId);
  if (!entry) return { ok: false, reason: "entry not found", factor, linkedUpdated: 0 };
  const tracker = await resolveTracker(storage, entry, opts.trackerId);
  if (!tracker) return { ok: false, reason: "tracker not found", factor, linkedUpdated: 0 };

  const existing: NutritionEnrichment | undefined = entry.computed?.nutrition;
  let linkedUpdated = 0;
  if (existing && existing.components.length > 0 && existing.status === "applied") {
    const scaled = rescaleEnrichment(existing, factor, now);
    const patch: Record<string, number> = {};
    for (const key of ENTRY_VALUE_NUTRIENTS) {
      const t = scaled.totals[key];
      if (t && (key !== "caffeine" || t.value > 0)) patch[key] = t.value;
    }
    for (const ref of scaled.linkedEntries) {
      try {
        const row: any = await storage.getTrackerEntry(ref.entryId);
        if (!row) continue;
        const field = Object.keys(row.values || {}).find((k) => !k.startsWith("_") && typeof row.values[k] === "number");
        if (!field) continue;
        const updated = await storage.updateTrackerEntry(ref.trackerId, ref.entryId, { values: { [field]: roundNutrient(Number(row.values[field]) * factor, ref.nutrient) } });
        if (updated) linkedUpdated++;
      } catch { /* best effort */ }
    }
    const updated = await storage.updateTrackerEntry(tracker.id, entry.id, { values: patch, computed: { nutrition: scaled, enrichment: provenanceForUi(scaled) } } as any);
    return { ok: !!updated, entry: updated, factor, linkedUpdated };
  }
  // No component data: scale the nutrient fields the entry has.
  const patch = rescalePlainValues(entry.values || {}, factor);
  if (Object.keys(patch).length === 0) return { ok: false, reason: "entry has no nutrient values to scale", factor, linkedUpdated };
  const prior = typeof entry.computed?.servingFactor === "number" ? entry.computed.servingFactor : 1;
  const updated = await storage.updateTrackerEntry(tracker.id, entry.id, { values: patch, computed: { servingFactor: round3(prior * factor) } } as any);
  return { ok: !!updated, entry: updated, factor, linkedUpdated };
}

/**
 * A user edit of a nutrient field on an enriched entry makes that value the
 * user's: the enrichment's total for it becomes user-provided so a later
 * re-enrichment cannot put the lookup's number back.
 */
export function markUserEditedNutrients(existing: NutritionEnrichment | undefined, patchValues: Record<string, any> | undefined, now: string): NutritionEnrichment | undefined {
  if (!existing || !patchValues) return undefined;
  const edited: NutrientVector = {};
  for (const [k, v] of Object.entries(patchValues)) {
    const key = canonicalNutrientKey(k);
    const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
    if (key && isFinite(n) && existing.totals[key] && existing.totals[key]!.value !== n) edited[key] = n;
  }
  if (Object.keys(edited).length === 0) return undefined;
  const { totals, userProvided } = applyUserProvided(existing.totals, { ...existing.userValues, ...edited }, now);
  return { ...existing, totals, userProvided, userValues: { ...existing.userValues, ...edited }, summary: summarizeEnrichment({ components: existing.components, totals }), enrichedAt: now };
}

// ─── Delete cascade ──────────────────────────────────────────────────────────

/**
 * Deleting the source item deletes every measurement derived from it (the
 * Hydration and Caffeine rows a Coke produced). Best effort; the source delete
 * is the contract and has already happened when this runs.
 */
export async function removeLinkedEntries(storage: IStorage, sourceEntryId: string): Promise<string[]> {
  const removed: string[] = [];
  let trackers: Tracker[];
  try { trackers = await storage.getTrackers(); } catch { return removed; }
  for (const t of trackers) {
    for (const e of t.entries || []) {
      if ((e as any)?.values?.[LINKED_SOURCE_KEY] !== sourceEntryId) continue;
      try {
        if (await storage.deleteTrackerEntry(t.id, e.id)) removed.push(e.id);
      } catch { /* best effort */ }
    }
  }
  return removed;
}

export { NUTRIENT_KEYS };
