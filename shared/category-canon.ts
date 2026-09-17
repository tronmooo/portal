// shared/category-canon.ts — ONE category vocabulary.
//
// QA report 2026-07-25: "Assets, liabilities and subscriptions use
// inconsistent category names: Subscription and Subscription · Utility and
// Utilities · Liability and Other."
//
// Root cause: the same concept had two spellings live at once and BOTH were
// accepted. `ObligationCategory` declares "utilities" while the obligations
// form wrote "utility"; the expense allowlist in server/routes.ts accepted
// "utilities" AND "utility", "subscription" AND (via other paths)
// "subscriptions". Nothing normalized on write, so grouped views split one
// bucket in two and the user saw the same category listed twice.
//
// The rule from here on: canonical values are the ONLY thing stored. Aliases
// are accepted at the boundary and folded before the write. Display labels are
// derived, never stored.
//
// Pure, dependency-free. Pinned by tests/category-canon.test.ts.

// ─── Canonical vocabularies ──────────────────────────────────────────────────
// These are the exact string unions in shared/schema.ts (ExpenseCategory /
// ObligationCategory) — keep them in sync.

export const EXPENSE_CATEGORIES = [
  "general", "food", "transport", "health", "pet", "vehicle", "entertainment",
  "shopping", "utilities", "housing", "insurance", "subscription", "education",
  "personal", "travel", "debt",
] as const;
// "debt" (2026-09-17): the bill that pays a car loan carried the obligation
// category "loan", which this vocabulary had no bucket for, so every loan
// payment folded to "general" and a $912 car payment was 72–82% of the
// "General" slice of the spending chart.
// "automotive" was in this list AND aliased to "vehicle" below. A vocabulary
// that carries a word and its own alias is two buckets for one concept: the
// Edit form offered "Automotive" while Add offered "Vehicle", and an exact
// match always beat the alias, so both spellings survived in the data.
export type CanonicalExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const OBLIGATION_CATEGORIES = [
  "housing", "utilities", "insurance", "subscription", "loan", "medical",
  "education", "transportation", "communication", "general",
] as const;
export type CanonicalObligationCategory = (typeof OBLIGATION_CATEGORIES)[number];

// ─── Aliases ─────────────────────────────────────────────────────────────────
// Every spelling ever written by a form, an importer, the AI, or a migration.
// Keys are compared after lowercasing and collapsing separators, so "Utility
// Bill", "utility_bill" and "utility-bill" all reach the same entry.

const ALIASES: Record<string, string> = {
  // Utilities — the reported "Utility and Utilities" split.
  utility: "utilities",
  utilities: "utilities",
  utilitybill: "utilities",
  utilityplan: "utilities",
  electric: "utilities",
  electricity: "utilities",
  power: "utilities",
  water: "utilities",
  sewer: "utilities",
  gasbill: "utilities",
  trash: "utilities",
  internet: "utilities",
  cable: "utilities",

  // Subscriptions — the reported "Subscription and Subscription" split (one of
  // the two was the plural).
  subscription: "subscription",
  subscriptions: "subscription",
  membership: "subscription",
  memberships: "subscription",
  streaming: "subscription",
  software: "subscription",

  // "Liability" is a record TYPE, never a category. Writing it as a category is
  // what produced a "Liability" bucket sitting beside "Other".
  liability: "general",
  liabilities: "general",
  other: "general",
  misc: "general",
  miscellaneous: "general",
  uncategorized: "general",
  none: "general",
  general: "general",

  // Common singular/plural and phrasing drift on the rest.
  transportation: "transport",
  transit: "transport",
  commute: "transport",
  groceries: "food",
  grocery: "food",
  dining: "food",
  restaurant: "food",
  restaurants: "food",
  medical: "health",
  healthcare: "health",
  pharmacy: "health",
  pets: "pet",
  auto: "vehicle",
  automotive: "vehicle",
  car: "vehicle",
  rent: "housing",
  mortgage: "housing",
  home: "housing",
  entertainment: "entertainment",
  fun: "entertainment",
  // For EXPENSES there is no "communication" bucket, so a phone bill folds to
  // utilities; obligations keep their own "communication" category because an
  // exact canonical value always wins over this table.
  communication: "utilities",
  phone: "communication",
  phonebill: "communication",
  phoneplan: "communication",
  mobile: "communication",
  wireless: "communication",
  school: "education",
  tuition: "education",
  travel: "travel",
  vacation: "travel",
  trip: "travel",
  shopping: "shopping",
  retail: "shopping",
  insurance: "insurance",
  loan: "loan",
  loans: "loan",
  debt: "loan",
  credit: "loan",
};

/** Lowercase and strip separators/punctuation so spelling drift folds away. */
function key(raw: unknown): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Spellings that mean one thing for expenses and another for obligations.
// "loan" IS an obligation category (the bill's kind); as an expense it is the
// money that went to a debt. The shared table can only carry one target, so
// the expense resolver consults this first.
const EXPENSE_ALIASES: Record<string, string> = {
  loan: "debt", loans: "debt", debt: "debt", debts: "debt", credit: "debt",
  loanpayment: "debt", debtpayment: "debt", carpayment: "debt", mortgagepayment: "debt",
};

function resolve(raw: unknown, allowed: readonly string[], fallback: string, extra?: Record<string, string>): string {
  const k = key(raw);
  if (!k) return fallback;
  // An exact canonical value always wins over the alias table.
  if (allowed.includes(k)) return k;
  const own = extra?.[k];
  if (own && allowed.includes(own)) return own;
  const aliased = ALIASES[k];
  if (aliased && allowed.includes(aliased)) return aliased;
  // One more hop, for a word whose alias is itself canonical only in the OTHER
  // vocabulary: "phone" → "communication" is an obligation category but not an
  // expense one, and "communication" → "utilities" carries it the rest of the
  // way. Bounded at two hops; the table has no longer chains.
  const twice = aliased ? ALIASES[aliased] : undefined;
  if (twice && allowed.includes(twice)) return twice;
  // The alias resolved to something this vocabulary doesn't carry (e.g.
  // "transport" is an expense category but not an obligation one) — fall back
  // rather than storing a value the type union forbids.
  return fallback;
}

/**
 * Fold any expense-category spelling to its canonical form.
 * Unknown input becomes "general" — never stored verbatim.
 */
export function canonicalExpenseCategory(raw: unknown): CanonicalExpenseCategory {
  return resolve(raw, EXPENSE_CATEGORIES, "general", EXPENSE_ALIASES) as CanonicalExpenseCategory;
}

/**
 * The canonical expense category for `raw`, or null when neither the
 * vocabulary nor the alias table knows the spelling (canonicalExpenseCategory
 * answers "general" for those).
 */
export function foldExpenseCategory(raw: unknown): CanonicalExpenseCategory | null {
  const folded = resolve(raw, EXPENSE_CATEGORIES, "", EXPENSE_ALIASES);
  return folded ? (folded as CanonicalExpenseCategory) : null;
}

/** Fold any obligation/bill-category spelling to its canonical form. */
export function canonicalObligationCategory(raw: unknown): CanonicalObligationCategory {
  return resolve(raw, OBLIGATION_CATEGORIES, "general") as CanonicalObligationCategory;
}

/** True when `raw` is already canonical for expenses (no folding needed). */
export function isCanonicalExpenseCategory(raw: unknown): boolean {
  return typeof raw === "string" && (EXPENSE_CATEGORIES as readonly string[]).includes(raw);
}

/** True when `raw` is already canonical for obligations. */
export function isCanonicalObligationCategory(raw: unknown): boolean {
  return typeof raw === "string" && (OBLIGATION_CATEGORIES as readonly string[]).includes(raw);
}

/**
 * Display label for a canonical category. Labels are DERIVED — storing a
 * pretty string is how "Subscription" and "subscriptions" became two buckets.
 */
export function categoryLabel(canonical: string): string {
  const overrides: Record<string, string> = {
    utilities: "Utilities",
    subscription: "Subscription",
    transport: "Transport",
    transportation: "Transport",
    general: "General",
    pet: "Pet",
    vehicle: "Vehicle",
    communication: "Phone & Internet",
    debt: "Debt payments",
  };
  const k = key(canonical);
  if (overrides[k]) return overrides[k];
  const s = String(canonical ?? "").trim();
  if (!s) return "General";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
