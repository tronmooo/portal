// shared/budget-ledger.ts — the rules every budget writer shares.
//
// A month's budgets are one JSON list stored under `budget:YYYY-MM`. Three
// writers used to re-implement the list edits (the Supabase storage, the
// in-memory storage and, through them, the routes, the AI tools and the
// finance importer), and each had its own gaps: "copy last month" replaced
// the destination list outright (caps already set for that month were lost),
// a month written as "2026-9" landed in a bucket no reader ever looked at, a
// category spelled "Groceries" never matched the canonical "food" the
// expenses carry, and renaming a cap onto an existing category left two caps
// for one bucket. Pure and dependency-free apart from the category canon.

import { foldExpenseCategory } from "./category-canon";

export interface BudgetEntry {
  id: string;
  category: string;
  amount: number;
  notes?: string;
  profileId?: string;
}

/** "2026-9" / " 2026-09 " → "2026-09"; anything that is not a real month → null. */
export function normalizeMonthKey(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${String(month).padStart(2, "0")}`;
}

/** The normalised month key, or a 400-style error for a value that is not a month. */
export function budgetMonthOrThrow(raw: unknown): string {
  const key = normalizeMonthKey(raw);
  if (!key) {
    const err: any = new Error(`month must be YYYY-MM (got "${String(raw ?? "")}")`);
    err.statusCode = 400;
    throw err;
  }
  return key;
}

/**
 * The bucket a budget category is stored and compared under. Spellings the
 * expense canon knows ("Groceries", "Dining", "Gas") fold to the canonical
 * expense category so the cap meets the spend the expenses are bucketed by;
 * a word the canon does not know keeps its own (trimmed, lower-cased) bucket
 * instead of being merged into "general" — folding two unknown caps into one
 * would silently overwrite the first.
 */
export function budgetCategoryKey(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return foldExpenseCategory(s) ?? s.toLowerCase();
}

const sameOwner = (a: string | null | undefined, b: string | null | undefined) => (a || null) === (b || null);

function findBucket(list: BudgetEntry[], category: string, profileId: string | null | undefined, exceptId?: string): BudgetEntry | undefined {
  const key = budgetCategoryKey(category);
  return list.find((b) => b.id !== exceptId && budgetCategoryKey(b.category) === key && sameOwner(b.profileId, profileId));
}

/**
 * Set the cap for (category, owner) in `list`, updating the entry that already
 * carries that bucket or appending a new one. Mutates `list`; returns the entry.
 */
export function upsertBudget(
  list: BudgetEntry[],
  input: { category: string; amount: number; notes?: string; profileId?: string },
  newId: () => string,
): BudgetEntry {
  const category = budgetCategoryKey(input.category);
  const existing = findBucket(list, category, input.profileId);
  if (existing) {
    existing.category = category;
    existing.amount = input.amount;
    if (input.notes) existing.notes = input.notes;
    return existing;
  }
  const entry: BudgetEntry = { id: newId(), category, amount: input.amount, notes: input.notes, profileId: input.profileId };
  list.push(entry);
  return entry;
}

/**
 * Apply an edit to one entry. Returns null when the id is not in the list;
 * throws a 409-style error when the edit would give the month two caps for
 * the same (category, owner) bucket. Mutates `list`.
 */
export function applyBudgetUpdate(
  list: BudgetEntry[],
  budgetId: string,
  updates: { amount?: number; category?: string; notes?: string | null; profileId?: string | null },
): BudgetEntry | null {
  const entry = list.find((b) => b.id === budgetId);
  if (!entry) return null;
  const nextCategory = updates.category ? budgetCategoryKey(updates.category) : budgetCategoryKey(entry.category);
  const nextOwner = updates.profileId !== undefined ? (updates.profileId || undefined) : entry.profileId;
  const clash = findBucket(list, nextCategory, nextOwner, entry.id);
  if (clash) {
    const err: any = new Error(`A ${nextCategory} budget already exists for this month; edit that one instead`);
    err.statusCode = 409;
    throw err;
  }
  if (updates.amount !== undefined) entry.amount = updates.amount;
  if (updates.category) entry.category = nextCategory;
  if (updates.notes !== undefined) entry.notes = updates.notes ?? undefined;
  if (updates.profileId !== undefined) entry.profileId = nextOwner;
  return entry;
}

/**
 * "Copy last month": every cap the destination already has is kept as it is;
 * source entries whose (category, owner) bucket the destination lacks are
 * added with fresh ids. Returns the merged list and how many were added.
 */
export function mergeBudgetsForCopy(
  destination: BudgetEntry[],
  source: BudgetEntry[],
  newId: () => string,
): { list: BudgetEntry[]; added: number } {
  const list = destination.map((b) => ({ ...b }));
  let added = 0;
  for (const b of source) {
    if (findBucket(list, b.category, b.profileId)) continue;
    list.push({ ...b, category: budgetCategoryKey(b.category), id: newId() });
    added += 1;
  }
  return { list, added };
}
