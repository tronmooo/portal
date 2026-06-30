// Pure, testable helpers for the Expenses page toolbar (search + sort).
//
// Extracted from finance.tsx so the ordering/search semantics can be pinned by
// unit tests — the user reported expenses showing "out of order" and wanted a
// real search/sort toolbar, so the logic that drives it must be regression-safe
// and identical wherever it's used.

export type ExpenseSort =
  | "date-desc"
  | "date-asc"
  | "amount-desc"
  | "amount-asc"
  | "name-asc";

export interface ExpenseLike {
  description?: string | null;
  vendor?: string | null;
  category?: string | null;
  amount?: number | null;
  date?: string | null;
}

/**
 * True if the expense matches a free-text query. Matches against description,
 * vendor and category, case-insensitively. An empty/whitespace query matches
 * everything.
 */
export function matchesExpenseSearch(e: ExpenseLike, query: string): boolean {
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  const hay = `${e.description || ""} ${e.vendor || ""} ${e.category || ""}`.toLowerCase();
  return hay.includes(q);
}

function time(e: ExpenseLike): number {
  const t = new Date(e.date || "").getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Returns a NEW array sorted per the chosen order. Date sorts tie-break on
 * description so equal-date rows have a stable, sensible order (this is the fix
 * for the "newest first but jumbled" report — the old code sorted by
 * description first, burying recent items).
 */
export function sortExpenses<T extends ExpenseLike>(list: readonly T[], sortBy: ExpenseSort): T[] {
  const arr = list.slice();
  switch (sortBy) {
    case "date-asc":
      return arr.sort((a, b) => time(a) - time(b) || (a.description || "").localeCompare(b.description || ""));
    case "amount-desc":
      return arr.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    case "amount-asc":
      return arr.sort((a, b) => (a.amount || 0) - (b.amount || 0));
    case "name-asc":
      return arr.sort((a, b) => (a.description || "").localeCompare(b.description || ""));
    case "date-desc":
    default:
      return arr.sort((a, b) => time(b) - time(a) || (b.description || "").localeCompare(a.description || ""));
  }
}
