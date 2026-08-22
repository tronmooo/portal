// ─── Canonical expense-category inference ───────────────────────────────────
//
// ONE implementation of "what category is this spend?", shared by every door
// that creates an expense. Before this file the app had three divergent
// inferrers, so the same purchase landed in different buckets depending on
// which door recorded it:
//   · the chat tool's 13-branch regex chain (server/ai-engine.ts create_expense)
//   · the document auto-expense's docType map (server/ai-engine.ts upload path)
//   · the bank-CSV importer's keyword lists (server/routes.ts)
//
// This module is their merge. Where the sources disagreed, the resolution is
// recorded here and is now the canonical behavior:
//   · flights / airlines / hotels → "travel" (the CSV importer was right; the
//     chat chain filed flights under "transport", which is for getting around
//     town, not trips)
//   · streaming services (netflix, spotify, …) → "subscription" (the chat
//     chain was right; the CSV lists filed them under "entertainment")
//   · bare over-broad tokens from the CSV lists ("books", "shop") are dropped;
//     specific ones ("textbook", "store") stay.
//
// Order matters and is part of the contract: earlier rules win, so "dog food"
// is a pet expense before the food rule can see it, and a pharmacy hits
// "health" before "shopping" can claim the word "store".
//
// Inference NEVER overrides a deliberate category — callers consult it only
// when the incoming category is missing or the "general" placeholder. It
// returns null rather than guessing when nothing matches; the caller keeps
// "general".
import { canonicalExpenseCategory, type CanonicalExpenseCategory } from "./category-canon";

/** Ordered keyword rules over `description + vendor`. Exported for tests. */
export const EXPENSE_KEYWORD_RULES: ReadonlyArray<{ category: CanonicalExpenseCategory; pattern: RegExp }> = [
  { category: "pet", pattern: /vet\b|pet food|dog food|cat food|grooming|flea|treats|chewy|petco|petsmart/ },
  { category: "travel", pattern: /flight|airline|hotel|airbnb|booking\.com|expedia/ },
  { category: "food", pattern: /groceries|grocery|restaurant|food|coffee|cafe|lunch|dinner|breakfast|pizza|burger|sandwich|sushi|taco|donut|latte|bakery|diner|starbucks|mcdonald|chipotle|subway\b|whole foods|trader joe|uber eats|doordash|grubhub/ },
  { category: "transport", pattern: /uber\b|lyft|gas\b|fuel|parking|toll|transit|metro\b|bus\b|train\b/ },
  { category: "vehicle", pattern: /oil change|tire|car wash|mechanic|auto\b|vehicle|detailing|dmv\b/ },
  { category: "health", pattern: /doctor|pharmacy|cvs|walgreens|gym\b|dentist|dental|hospital|medical|prescription|copay|fitness/ },
  { category: "subscription", pattern: /netflix|spotify|hulu|disney|apple music|youtube|subscription|membership|annual fee|monthly fee/ },
  { category: "housing", pattern: /rent\b|mortgage|hoa\b/ },
  { category: "utilities", pattern: /electric|water\b|internet|phone|mobile\b|cable|utility|att\b|verizon|comcast|xfinity/ },
  { category: "shopping", pattern: /amazon|walmart|target\b|costco|clothes|shoes|electronics|best ?buy|ebay|apple store|store\b|mall\b|retail/ },
  { category: "entertainment", pattern: /movie|theater|game\b|steam\b|concert|ticket|bar\b|drinks|bowling|arcade/ },
  { category: "education", pattern: /school|tuition|textbook|course\b|udemy|coursera|university/ },
  { category: "insurance", pattern: /insurance|geico|allstate|progressive|state farm/ },
];

/** Document-class hints, from the upload pipeline's auto-expense. */
const DOCTYPE_RULES: ReadonlyArray<{ category: CanonicalExpenseCategory; tokens: string[] }> = [
  { category: "vehicle", tokens: ["vehicle", "registration", "citation", "parking", "toll", "dmv"] },
  { category: "health", tokens: ["medical", "prescription", "lab", "health", "doctor", "hospital"] },
  { category: "utilities", tokens: ["utility", "bill", "electric", "water", "gas"] },
  { category: "insurance", tokens: ["insurance"] },
];

/** A spend attributed to a typed profile inherits that type's bucket. */
const PROFILE_TYPE_CATEGORY: Record<string, CanonicalExpenseCategory> = {
  pet: "pet",
  vehicle: "vehicle",
  medical: "health",
  subscription: "subscription",
  property: "housing",
  insurance: "insurance",
};

export interface ExpenseCategoryHints {
  description?: string;
  vendor?: string;
  /** Document class ("receipt", "vehicle-registration", …) — document door. */
  docType?: string;
  /** Type of the profile the spend is attributed to ("pet", "vehicle", …). */
  profileType?: string;
}

/**
 * Infer a canonical category from whatever hints a door has, or null when
 * nothing matches (the caller keeps "general"). Precedence: what the text
 * says → what kind of document it came from → whose profile it belongs to.
 */
export function inferExpenseCategory(hints: ExpenseCategoryHints): CanonicalExpenseCategory | null {
  const text = `${hints.description || ""} ${hints.vendor || ""}`.toLowerCase();
  if (text.trim()) {
    for (const rule of EXPENSE_KEYWORD_RULES) {
      if (rule.pattern.test(text)) return rule.category;
    }
  }
  const docType = (hints.docType || "").toLowerCase();
  if (docType) {
    for (const rule of DOCTYPE_RULES) {
      if (rule.tokens.some((t) => docType.includes(t))) return rule.category;
    }
  }
  const profileType = (hints.profileType || "").toLowerCase();
  if (profileType && PROFILE_TYPE_CATEGORY[profileType]) return PROFILE_TYPE_CATEGORY[profileType];
  return null;
}

/**
 * Resolve the category an expense should be stored with: a deliberate,
 * specific incoming category wins (folded to canonical spelling); otherwise
 * inference; otherwise "general".
 */
export function resolveExpenseCategory(raw: unknown, hints: ExpenseCategoryHints): CanonicalExpenseCategory {
  if (typeof raw === "string" && raw.trim()) {
    const folded = canonicalExpenseCategory(raw);
    if (folded !== "general") return folded;
  }
  return inferExpenseCategory(hints) ?? "general";
}
