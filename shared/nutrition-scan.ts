// ─── A scanned nutrition label, and how much of it was eaten (pure) ──────────
//
// A photo of a Nutrition Facts panel (or a product found by its barcode) is
// read into one shape, `ScannedLabel`: what the label says, per serving, with
// its serving size, servings per container and % Daily Values as printed.
// Reading the picture is a model's job (server/nutrition-label-scan.ts);
// everything after that is here and is arithmetic:
//
//   · `sanitizeScannedLabel` keeps only what a label can say — canonical
//     nutrient keys, plain non-negative numbers. "<1 g", "trace" and a value
//     the reader was unsure of are dropped, never turned into 0 (rule N3).
//   · `consumedFromScan` reads how much the user ate ("2 servings", "half the
//     bag", "40 g", "3 cookies") against the label's own serving and returns
//     the factor; with no amount stated it is one serving, marked assumed.
//
// Calories are the label's printed calories times the factor (rule N4).
//
// Pinned by tests/nutrition-scan.test.ts.

import {
  NUTRIENT_KEYS,
  canonicalNutrientKey,
  normalizeQuantity,
  roundNutrient,
  spokenAmountsToDigits,
  type NutrientKey,
  type NutrientVector,
} from "./nutrition-enrichment";

export interface ScannedServing {
  /** As printed: "2/3 cup (55g)", "1 bar (60 g)", "8 fl oz (240 mL)". */
  text: string;
  grams?: number;
  ml?: number;
  /** The household part of the serving: 2 (cookies), 0.667 (cup). */
  householdAmount?: number;
  householdUnit?: string;
}

export interface ScannedLabel {
  productName?: string;
  brand?: string;
  /** UPC / EAN when one is printed in the picture or the product came from a barcode. */
  barcode?: string;
  serving: ScannedServing;
  servingsPerContainer?: number;
  /** Per serving, as printed. */
  perServing: NutrientVector;
  /** The label's second column, when it prints one ("per container"). */
  perContainer?: NutrientVector;
  /** % Daily Value per serving, as printed. */
  dailyValues?: Partial<Record<NutrientKey, number>>;
  /** Where it came from: a photo the user took, or a database record found by barcode. */
  origin: "photo" | "barcode";
  /** The database record, for a barcode match ("Open Food Facts product 3017620422003"). */
  sourceName?: string;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return isFinite(v) && v >= 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  // "<1", "less than 1", "trace", "0*" are not numbers a label committed to.
  if (!t || /^(<|less|trace|tr\b|n\/?a|--?$)/i.test(t)) return undefined;
  const m = t.match(/^(\d+(?:[.,]\d+)?)\s*(?:k?cal|g|mg|mcg|µg|ug|ml|%|iu)?\s*$/i);
  return m ? Number(m[1].replace(",", ".")) : undefined;
};

function vector(raw: unknown): NutrientVector {
  const out: NutrientVector = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const key = canonicalNutrientKey(k);
    const n = num(v);
    if (!key || key === "fluidMl" || n == null) continue;
    if (out[key] == null) out[key] = roundNutrient(n, key);
  }
  return out;
}

const text = (v: unknown, max = 120): string | undefined => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
  return s || undefined;
};

/** What a reader returned, cut down to what a label can say. Null when it is not a usable nutrition label. */
export function sanitizeScannedLabel(raw: any, origin: ScannedLabel["origin"] = "photo"): ScannedLabel | null {
  if (!raw || typeof raw !== "object") return null;
  const perServing = vector(raw.perServing ?? raw.nutrients);
  if (perServing.calories == null && Object.keys(perServing).length < 2) return null;
  const s = raw.serving && typeof raw.serving === "object" ? raw.serving : {};
  const serving: ScannedServing = { text: text(s.text ?? raw.servingSize, 80) || "1 serving" };
  const grams = num(s.grams);
  const ml = num(s.ml);
  if (grams) serving.grams = grams;
  if (ml) serving.ml = ml;
  const hh = num(s.householdAmount);
  const hu = text(s.householdUnit, 30)?.toLowerCase();
  if (hh && hu) { serving.householdAmount = hh; serving.householdUnit = hu; }
  // The printed text is the fallback for anything the reader left out: "2/3 cup (55g)".
  if (!serving.grams && !serving.ml) {
    const g = serving.text.match(/(\d+(?:[.,]\d+)?)\s*g\b/i);
    const m = serving.text.match(/(\d+(?:[.,]\d+)?)\s*ml\b/i);
    if (g) serving.grams = Number(g[1].replace(",", "."));
    else if (m) serving.ml = Number(m[1].replace(",", "."));
  }
  if (!serving.householdAmount) {
    const h = spokenAmountsToDigits(serving.text.toLowerCase()).match(/^\s*(?:about\s+)?(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?)\s+([a-z][a-z .]*?)(?:\s*\(|$)/);
    if (h) {
      const a = h[1].includes("/")
        ? h[1].trim().split(/\s+/).reduce((sum, part) => sum + (part.includes("/") ? Number(part.split("/")[0]) / Number(part.split("/")[1]) : Number(part)), 0)
        : Number(h[1]);
      if (isFinite(a) && a > 0) { serving.householdAmount = Math.round(a * 1000) / 1000; serving.householdUnit = h[2].trim(); }
    }
  }
  const spc = num(raw.servingsPerContainer);
  const dv: Partial<Record<NutrientKey, number>> = {};
  for (const [k, v] of Object.entries((raw.dailyValues && typeof raw.dailyValues === "object" ? raw.dailyValues : {}) as Record<string, unknown>)) {
    const key = canonicalNutrientKey(k);
    const n = num(v);
    if (key && n != null && n <= 2000) dv[key] = Math.round(n * 10) / 10;
  }
  const perContainer = vector(raw.perContainer);
  const barcode = typeof raw.barcode === "string" ? raw.barcode.replace(/\D/g, "") : "";
  return {
    productName: text(raw.productName),
    brand: text(raw.brand, 60),
    ...(barcode.length >= 8 && barcode.length <= 14 ? { barcode } : {}),
    serving,
    ...(spc && spc > 0 && spc < 1000 ? { servingsPerContainer: spc } : {}),
    perServing,
    ...(Object.keys(perContainer).length ? { perContainer } : {}),
    ...(Object.keys(dv).length ? { dailyValues: dv } : {}),
    origin,
    ...(text(raw.sourceName, 120) ? { sourceName: text(raw.sourceName, 120) } : {}),
  };
}

export interface ScanConsumption {
  /** Label servings eaten. */
  servings: number;
  /** The arithmetic in words. */
  method: string;
  /** The user did not say how much: one serving was taken. */
  assumed: boolean;
}

const unitWord = (u: string) => {
  const w = String(u || "").toLowerCase().replace(/[.]/g, "").trim();
  if (/^(tbsp|tablespoons?)$/.test(w)) return "tbsp";
  if (/^(tsp|teaspoons?)$/.test(w)) return "tsp";
  if (/^(fl oz|floz|fluid ounces?)$/.test(w)) return "fl oz";
  return w.replace(/(es|s)$/, "");
};
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * How many label servings the user's words are. Read against the label's own
 * serving: a weight against its grams, a count against its household unit,
 * a share of the package against its servings per container.
 */
export function consumedFromScan(label: ScannedLabel, said: string | null | undefined): ScanConsumption {
  const words = spokenAmountsToDigits(String(said || "").toLowerCase().replace(/\s+/g, " ").trim());
  const one: ScanConsumption = { servings: 1, method: `1 serving (${label.serving.text}) — no amount was stated`, assumed: true };
  if (!words) return one;
  const q = normalizeQuantity(words);
  const spc = label.servingsPerContainer;

  // "the whole bag", "half the container", "two bags", "the entire thing".
  const whole = /\b(whole|entire|all of (?:it|the)|the full|everything)\b/.test(words) && !/\bservings?\b/.test(words);
  if (spc && (q.packageFraction != null || whole)) {
    const f = q.packageFraction ?? 1;
    return { servings: r4(f * spc), method: `${f === 1 ? "the whole package" : `${r4(f)} of the package`} × ${spc} servings`, assumed: false };
  }
  const containers = words.match(/(\d+(?:\.\d+)?)\s+(?:whole\s+|full\s+)?(?:containers?|packages?|bags?|boxes|box|cans?|bottles?|tubs?|cartons?|pouches|pouch|packs?)\b/);
  if (spc && containers) return { servings: r4(Number(containers[1]) * spc), method: `${containers[1]} package(s) × ${spc} servings`, assumed: false };

  const servings = words.match(/(\d+(?:\.\d+)?)\s+servings?\b/);
  if (servings) return { servings: r4(Number(servings[1])), method: `${servings[1]} servings`, assumed: false };
  if (/\b(half|1\/2)\s+(?:a\s+|of\s+a\s+)?serving\b/.test(words)) return { servings: 0.5, method: "0.5 servings", assumed: false };

  if (q.grams != null && !q.assumption && label.serving.grams) {
    return { servings: r4(q.grams / label.serving.grams), method: `${r4(q.grams)} g ÷ ${label.serving.grams} g per serving`, assumed: false };
  }
  if (q.ml != null && !q.assumption && label.serving.ml && /^(ml|l|fl oz|floz|oz|ounces?|milliliters?|liters?)$/.test(String(q.unit || ""))) {
    return { servings: r4(q.ml / label.serving.ml), method: `${r4(q.ml)} ml ÷ ${label.serving.ml} ml per serving`, assumed: false };
  }
  // A weight of a product whose serving is only stated by volume (or the reverse) cannot be converted.
  const hu = label.serving.householdUnit ? unitWord(label.serving.householdUnit.split(" ")[0]) : "";
  const ha = label.serving.householdAmount;
  const amount = q.amount ?? q.count;
  if (hu && ha && amount != null) {
    const said1 = q.unit ? unitWord(q.unit) : "";
    const nounInWords = new RegExp(`\\b${hu}(?:e?s)?\\b`).test(words);
    if (said1 === hu || (!said1 && nounInWords) || (said1 && label.serving.householdUnit!.split(" ").map(unitWord).includes(said1))) {
      return { servings: r4(amount / ha), method: `${r4(amount)} ${hu} ÷ ${ha} ${hu} per serving`, assumed: false };
    }
  }
  // A bare count of a product whose serving is one piece ("2" of "1 bar").
  if (amount != null && !q.unit && q.count != null && (!ha || ha === 1)) {
    return { servings: r4(amount), method: `${r4(amount)} × ${label.serving.text}`, assumed: false };
  }
  if (q.packageFraction != null && !spc) {
    return { servings: r4(q.packageFraction), method: `${r4(q.packageFraction)} of one serving (the label does not say how many servings the package holds)`, assumed: true };
  }
  return one;
}

/** The label's values for the amount eaten: per-serving figures times the servings, at storage precision. */
export function scaledScanValues(label: ScannedLabel, servings: number): NutrientVector {
  const out: NutrientVector = {};
  for (const k of NUTRIENT_KEYS) {
    const v = label.perServing[k];
    if (typeof v === "number") out[k] = roundNutrient(v * servings, k);
  }
  return out;
}

/** The entry's name for a scanned product. */
export function scanItemName(label: ScannedLabel): string {
  const name = label.productName || "Scanned food";
  return label.brand && !name.toLowerCase().includes(label.brand.toLowerCase()) ? `${label.brand} ${name}` : name;
}

/** Does this chat message, sent with a picture, ask for the pictured food to be logged? */
export function asksToLogPicturedFood(message: string | null | undefined): boolean {
  const t = String(message || "").toLowerCase();
  if (!t.trim()) return false;
  return /\b(i|we)\s+(just\s+)?(ate|had|drank|eat|finished|consumed)\b|\b(log|track|add|record)\b[^.]{0,40}\b(this|it|that|food|snack|meal|nutrition|calories|label|serving)\b|\bnutrition (label|facts)\b|\b(servings?|calories)\b/.test(t);
}
