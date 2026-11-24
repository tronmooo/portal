// ─── A label the user read out, and how much of it they ate (pure) ───────────
//
// "I ate 75 grams of cereal. The label says 160 calories, 3g fat … per 40
// grams." The numbers in that message are the LABEL's, for the label's basis;
// what was eaten is the label times a factor. Before this module the stated
// numbers were stored as the amount eaten (160 kcal for 75 g of a 160-per-40 g
// cereal), or the chat model was left to do the arithmetic.
//
// The basis a label can be stated for:
//   · a weight or volume   "per 40 grams", "per 100 ml"
//   · a serving            "each serving contains…", "per serving"
//   · a whole recipe       "four equal portions of a recipe containing 800…"
//   · the whole item       "half a protein bar containing 200 calories"
// and what was eaten is read from the same message: a weight, a number of
// servings, a share of the package ("the entire bag", with "3.5 servings per
// bag"), a number of portions.
//
// Two things this module never does:
//   · fill in a nutrient the label did not state — unknown stays unknown;
//   · recompute calories from the macros. Fiber, sugar alcohols and label
//     rounding make 4/4/9 disagree with a printed figure legitimately; the
//     printed figure is the one that is scaled.
//
// No I/O, no model. Pinned by tests/nutrition-accuracy.test.ts.

import {
  GRAMS_PER_OZ,
  ML_PER_FL_OZ,
  detectPackageFraction,
  detectUserStatedNutrition,
  normalizeQuantity,
  parseAmountToken,
  roundNutrient,
  spokenAmountsToDigits,
  type NutrientKey,
  type NutrientVector,
} from "./nutrition-enrichment";

export type LabelBasisKind = "grams" | "ml" | "serving" | "recipe" | "item";

export interface StatedLabel {
  /** The label's numbers exactly as stated, for one `basis`. */
  values: NutrientVector;
  basis: { kind: LabelBasisKind; amount: number; label: string };
  /** How many of the basis were eaten (75 g of a per-40 g label = 1.875). */
  factor: number;
  /** The arithmetic in words: "75 g ÷ 40 g per label". */
  method: string;
  /** `values × factor`, unrounded beyond storage precision — what the entry records. */
  consumed: NutrientVector;
  /** The message said both what the label is for and how much was eaten. False = the stated numbers are taken as the amount eaten. */
  scaled: boolean;
}

const AMT = "\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|quarter";
const NUTRIENT_WORD_RE = /^\s*(?:of\s+)?(calories?|kcal|protein|carbs?|carbohydrates?|total|net|fat|saturated|trans|sugars?|fiber|fibre|dietary|added|sodium|salt|cholesterol|potassium|calcium|iron|caffeine|magnesium|zinc)\b/;
const PACKAGE_WORDS = "bag|box|package|pack|container|can|bottle|tub|jar|carton|pouch|sleeve|pint|tray|packet";
const PORTION_WORDS = "portions?|servings?|pieces?|slices?|helpings?|bowls?|plates?";

const amount = (tok: string): number | null => {
  const t = tok.toLowerCase().trim();
  if (t === "half") return 0.5;
  if (t === "quarter") return 0.25;
  return parseAmountToken(t);
};

function toGrams(n: number, unit: string): number | null {
  const u = unit.toLowerCase();
  if (/^(g|gram|grams)$/.test(u)) return n;
  if (/^(kg|kilogram|kilograms)$/.test(u)) return n * 1000;
  if (/^(oz|ounce|ounces)$/.test(u)) return n * GRAMS_PER_OZ;
  if (/^(lb|lbs|pound|pounds)$/.test(u)) return n * 453.6;
  return null;
}
function toMl(n: number, unit: string): number | null {
  const u = unit.toLowerCase().replace(/[.\s]/g, "");
  if (/^(ml|milliliter|milliliters|millilitre|millilitres)$/.test(u)) return n;
  if (/^(l|liter|liters|litre|litres)$/.test(u)) return n * 1000;
  if (/^(floz)$/.test(u)) return n * ML_PER_FL_OZ;
  if (/^(cup|cups)$/.test(u)) return n * 8 * ML_PER_FL_OZ;
  return null;
}

const MEASURE_RE = /(\d+(?:\.\d+)?)[\s-]*(fl\.?\s*oz|milliliters?|millilitres?|ml|liters?|litres?|l|kilograms?|kg|grams?|g|ounces?|oz|pounds?|lbs?|cups?)\b/g;

interface Measure { grams: number | null; ml: number | null; text: string; index: number; perBasis: boolean }

/** Every weight / volume in the message that is not a nutrient amount ("3g fat"). */
function measuresIn(lc: string): Measure[] {
  const out: Measure[] = [];
  for (const m of lc.matchAll(MEASURE_RE)) {
    const idx = m.index ?? 0;
    const after = lc.slice(idx + m[0].length);
    if (NUTRIENT_WORD_RE.test(after)) continue;
    const n = Number(m[1]);
    if (!isFinite(n) || n <= 0) continue;
    const before = lc.slice(Math.max(0, idx - 24), idx);
    const perBasis = /\b(per|in|for every|for each|every|each)\s+(?:a\s+|an\s+|one\s+)?$/.test(before);
    out.push({ grams: toGrams(n, m[2]), ml: toMl(n, m[2]), text: m[0].replace(/\s+/g, " "), index: idx, perBasis });
  }
  return out;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Scale a stated label by the factor, at storage precision. */
function scale(values: NutrientVector, factor: number): NutrientVector {
  const out: NutrientVector = {};
  for (const [k, v] of Object.entries(values) as [NutrientKey, number][]) {
    if (typeof v !== "number" || !isFinite(v)) continue;
    out[k] = roundNutrient(v * factor, k);
  }
  return out;
}

/**
 * The label in a message and how much of it was eaten, or null when the
 * message states no nutrition at all.
 */
export function parseStatedLabel(message: string): StatedLabel | null {
  const text = String(message || "").trim();
  if (!text) return null;
  const values = detectUserStatedNutrition(text);
  if (Object.keys(values).length === 0) return null;
  const lc = spokenAmountsToDigits(text.toLowerCase().replace(/\s+/g, " "));
  const done = (basis: StatedLabel["basis"], factor: number, method: string, scaled: boolean): StatedLabel => {
    const f = isFinite(factor) && factor > 0 ? round4(factor) : 1;
    return { values, basis, factor: f, method, consumed: scale(values, f), scaled: scaled && f > 0 };
  };

  const measures = measuresIn(lc);

  // 1. The label is for a weight or a volume: "per 40 grams", "per 100 ml".
  const per = measures.find((m) => m.perBasis);
  if (per) {
    const eaten = measures.find((m) => !m.perBasis && ((per.grams != null && m.grams != null) || (per.ml != null && m.ml != null)));
    const kind: LabelBasisKind = per.grams != null ? "grams" : "ml";
    const basisAmount = (per.grams ?? per.ml)!;
    const basis = { kind, amount: basisAmount, label: `per ${per.text}` };
    if (eaten) {
      const eatenAmount = (per.grams != null ? eaten.grams : eaten.ml)!;
      return done(basis, eatenAmount / basisAmount, `${eaten.text} ÷ ${per.text} per label`, true);
    }
    return done(basis, 1, `the label's ${per.text} (no amount eaten was stated)`, false);
  }

  // 2. A recipe divided into portions: "four equal portions of a recipe
  //    containing 800 calories … I ate one and a half portions".
  const divided = lc.match(new RegExp(`\\b(?:made|makes|make|divided|split|cut|portioned|serves|yields?)\\b[^.!?]*?(${AMT})\\s+(?:equal\\s+|even\\s+)?(?:${PORTION_WORDS})\\b`));
  if (divided) {
    const portions = amount(divided[1]);
    const ate = lc.match(new RegExp(`\\b(?:ate|had|eaten|finished|took)\\s+(?:only\\s+|about\\s+|just\\s+)?(${AMT})\\s+(?:of\\s+(?:the|those|them)\\s+)?(?:${PORTION_WORDS})?`));
    const eaten = ate ? amount(ate[1]) : null;
    if (portions && portions > 0 && eaten && eaten > 0) {
      return done({ kind: "recipe", amount: portions, label: `the whole recipe (${portions} portions)` }, eaten / portions, `${eaten} of ${portions} portions of the recipe`, true);
    }
  }

  // 3. The label is per serving.
  const perServing = /\b(each|per|a|one|every|single)\s+serving\b|\bserving\s+(?:has|contains|is|provides)\b|\bper\s+portion\b/.test(lc);
  if (perServing) {
    const basis = { kind: "serving" as const, amount: 1, label: "per serving" };
    // "3.5 servings per bag" / "the bag has 3.5 servings" + how much of the bag.
    const perPackage = lc.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s+servings?\\s+(?:per|in|to)\\s+(?:a\\s+|the\\s+|each\\s+)?(${PACKAGE_WORDS})`))
      || lc.match(new RegExp(`(?:${PACKAGE_WORDS})\\s+(?:has|contains|holds|is)\\s+(\\d+(?:\\.\\d+)?)\\s+servings?`));
    if (perPackage) {
      const n = Number(perPackage[1]);
      const share = detectPackageFraction(lc);
      if (n > 0 && share) {
        const part = share.fraction === 1 ? `the whole ${share.word}` : `${round4(share.fraction)} of the ${share.word}`;
        return done(basis, n * share.fraction, `${part} × ${n} servings`, true);
      }
    }
    // "two servings of soup", "I had 1.5 servings".
    const ate = Array.from(lc.matchAll(new RegExp(`(${AMT})\\s+servings?\\b(?!\\s+(?:per|in|to)\\b)`, "g")))
      .map((m) => ({ n: amount(m[1]), tok: m[1] }))
      .find((x) => x.n != null && !(x.tok === "a" || x.tok === "an" || x.tok === "one") );
    if (ate?.n) return done(basis, ate.n, `${ate.n} servings`, true);
    return done(basis, 1, "1 serving", true);
  }

  // 4. The label describes the whole item, and a share of it was eaten:
  //    "half a protein bar containing 200 calories", "two bars, 190 calories
  //    each". A plain count beside plain numbers ("2 eggs, 140 calories") is
  //    the user's TOTAL and is left exactly as stated.
  const each = /\b(each|apiece|a piece|per bar|per cookie|per slice|per piece|per can|per bottle|per item|per one)\b/.test(lc);
  const clause = lc.match(/^(.*?)\b(containing|that contains|which contains|that has|which has|that is|that's|with|at)\b\s*(?:about\s+|around\s+)?\d/);
  const head = (clause ? clause[1] : lc.split(/\d+(?:\.\d+)?\s*(?:kcal|calories?|cals?)\b/)[0] || "")
    .replace(/^(i\s+)?(only\s+)?(ate|had|drank|took|finished)\s+/, "").trim();
  if (head) {
    const q = normalizeQuantity(head);
    const share = q.packageFraction ?? (q.count != null ? q.count : null);
    if (share != null && share > 0 && share !== 1) {
      const fractional = share < 1 || !Number.isInteger(share);
      if (each || (clause && fractional)) {
        return done({ kind: "item", amount: 1, label: "the whole item" }, share, `${round4(share)} × the item's label`, true);
      }
    }
  }
  return done({ kind: "item", amount: 1, label: "as stated" }, 1, "as stated", false);
}

/**
 * Is this a LABEL (calories and at least two more values), as against a
 * single remark ("it's about 200 calories")? A label is a complete source for
 * the entry: nothing else is looked up and nothing it omits is filled in.
 */
export function isFullLabel(label: StatedLabel | null | undefined): label is StatedLabel {
  if (!label) return false;
  const keys = Object.keys(label.values);
  return keys.includes("calories") && keys.length >= 3;
}
