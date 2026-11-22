// One food = one entry (owner, 2026-11-22: "Eat a banana and a doughnut" was
// saved as one "Banana + Doughnut" entry — "these two should be separate").
//
// The chat prompt asks the model for one log per food. This module is what
// holds when the model sends a combined item anyway: `splitSeparateFoods`
// says which foods an item names, and `shareMealValues` gives each food its
// numbers. Pure — the server applies it before the call runs
// (server/meal-split.ts), so every food gets its own entry, card and undo.

/** "X and Y" that is ONE food. Matched across the "and", so it never splits. */
const AND_DISHES = [
  "mac and cheese", "macaroni and cheese", "peanut butter and jelly", "pb and j",
  "fish and chips", "rice and beans", "beans and rice", "red beans and rice",
  "biscuits and gravy", "chips and salsa", "chips and guac", "chips and guacamole",
  "chips and queso", "chips and dip", "ham and cheese", "cookies and cream",
  "half and half", "salt and pepper", "sweet and sour", "surf and turf",
  "bread and butter", "cheese and crackers", "spaghetti and meatballs",
  "pork and beans", "franks and beans", "chicken and waffles", "shrimp and grits",
  "bangers and mash", "cream and sugar", "milk and sugar", "oil and vinegar",
  "lettuce and tomato", "egg and cheese", "sausage and peppers", "hummus and pita",
  "cheese and onion", "salt and vinegar", "sour cream and onion", "milk and cereal",
  "cereal and milk", "pasta and sauce", "meat and potatoes", "liver and onions",
];

/** A dish named by its ingredients: "bacon, egg and cheese sandwich". */
const DISH_NOUN_RE = /\b(sandwich|sub|hoagie|panini|melt|burger|burrito|wrap|taco|tacos|pizza|soup|stew|chili|curry|omelet|omelette|scramble|frittata|quiche|parfait|casserole|pasta|noodles|ramen|sushi|roll|quesadilla|nachos|salad|bowl|smoothie|shake|stir[- ]fry|skillet|hash|platter|plate|kebab|kabob|pie|bagel|toast|pho|bibimbap|risotto|lasagna)\b/i;

/** A segment that opens a NEW food: it counts or names one ("a banana", "2 eggs"). */
const STARTS_NEW_FOOD_RE = /^\s*(a|an|one|two|three|four|five|six|half|some|\d[\d./]*)\b/i;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Cut at top-level separators. Parentheses keep their commas; "&" never cuts. */
function cut(text: string): Array<{ text: string; sep: "" | "+" | "," | "and" }> {
  const out: Array<{ text: string; sep: "" | "+" | "," | "and" }> = [];
  const lower = text.toLowerCase();
  let depth = 0;
  let cur = "";
  let sep: "" | "+" | "," | "and" = "";
  const push = (next: "" | "+" | "," | "and") => { out.push({ text: cur, sep }); cur = ""; sep = next; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      if (ch === "+") { push("+"); continue; }
      if (ch === "," || ch === ";") { push(","); continue; }
      if (/\s/.test(ch)) {
        const m = lower.slice(i + 1).match(/^(and|plus)\s/);
        if (m) {
          // "mac and cheese": the words either side of this "and" are one dish.
          const before = lower.slice(0, i);
          const after = lower.slice(i + 1 + m[0].length);
          const inDish = AND_DISHES.some((d) => {
            const [l, r] = d.split(" and ");
            return m[1] === "and" && before.endsWith(l) && after.startsWith(r);
          });
          if (!inDish) { push("and"); i += m[0].length; continue; }
        }
      }
    }
    cur += ch;
  }
  out.push({ text: cur, sep });
  return out
    .map((p) => ({ text: norm(p.text.replace(/^(i\s+)?(ate|had|drank|eat|got|ordered|grabbed)\s+/i, "")), sep: p.sep }))
    .filter((p) => p.text && !/^(a|an|the|some|also|then|too|and)$/i.test(p.text));
}

/**
 * The separate foods an item names. One element means "this is one food".
 *
 *   "Banana + Doughnut"                         → Banana | Doughnut
 *   "3 eggs, 2 toast with butter and a banana"  → 3 eggs | 2 toast with butter | a banana
 *   "Mac and Cheese"                            → one
 *   "Coffee with cream and sugar"               → one   (what follows "with" was added to it)
 *   "Bacon, egg and cheese sandwich"            → one   (a dish named by its ingredients)
 *   "Gatorade (half bottle, ~16 oz)"            → one
 */
export function splitSeparateFoods(item: string): string[] {
  const whole = norm(String(item || ""));
  if (!whole) return [];
  const parts = cut(whole);
  if (parts.length < 2) return [whole];

  // A dish named by its ingredients: the last piece is "<ingredient> <dish>"
  // and nothing in the list counts or names a food of its own. Only for
  // comma/"and" lists — "+" is the list sign and always separates.
  const last = parts[parts.length - 1].text;
  const dishByIngredients =
    parts.every((p) => p.sep !== "+")
    && DISH_NOUN_RE.test(last)
    && last.split(" ").length >= 2
    && parts.every((p) => !STARTS_NEW_FOOD_RE.test(p.text))
    && parts.slice(0, -1).every((p) => !DISH_NOUN_RE.test(p.text) && !/\bwith\b/i.test(p.text));
  if (dishByIngredients) return [whole];

  // What follows "with" was added to the food before it ("smoothie with
  // banana, spinach and protein powder"), until a piece opens a new food.
  const foods: string[] = [];
  let inWithList = false;
  for (const p of parts) {
    const continues = inWithList && p.sep !== "+" && foods.length > 0 && !STARTS_NEW_FOOD_RE.test(p.text) && !/\bwith\b/i.test(p.text);
    if (continues) {
      foods[foods.length - 1] += `${p.sep === "and" ? " and" : ","} ${p.text}`;
      continue;
    }
    foods.push(p.text);
    inWithList = /\bwith\b/i.test(p.text);
  }
  return foods;
}

/** The item as an entry label: "a banana" → "Banana", "2 eggs" stays "2 eggs". */
export function foodLabel(food: string): string {
  const t = norm(food).replace(/^(a|an|some|the)\s+/i, "");
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/**
 * Give each food its numbers out of a combined total. A food the reference
 * table prices (`known[i]`) takes those values; the rest share what is left
 * of the total equally, never below zero. Keys are the total's own keys.
 */
export function shareMealValues(
  total: Record<string, number>,
  known: Array<Record<string, number> | null>,
): Array<Record<string, number>> {
  const unknownCount = known.filter((k) => !k).length;
  const out: Array<Record<string, number>> = known.map(() => ({}));
  for (const [key, sum] of Object.entries(total)) {
    if (typeof sum !== "number" || !isFinite(sum)) continue;
    const knownSum = known.reduce((s, k) => s + (k && typeof k[key] === "number" ? k[key] : 0), 0);
    const each = unknownCount > 0 ? Math.max(0, sum - knownSum) / unknownCount : 0;
    known.forEach((k, i) => {
      const v = k ? (typeof k[key] === "number" ? k[key] : 0) : each;
      out[i][key] = Math.round(v * 10) / 10;
    });
  }
  return out;
}
