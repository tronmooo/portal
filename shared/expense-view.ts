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
  id?: string | null;
  description?: string | null;
  vendor?: string | null;
  category?: string | null;
  amount?: number | null;
  date?: string | null;
  createdAt?: string | null;
}

// Same-day rows order by when they were entered, newest first, so an expense
// just added lands at the top of today's rows rather than second (QA
// 2026-09-18 F-22 — the date sort compared the day only). Id is the final
// tie-break so two rows never swap between renders.
function created(e: ExpenseLike): number {
  const t = new Date(e.createdAt || "").getTime();
  return Number.isFinite(t) ? t : 0;
}
const byId = (a: ExpenseLike, b: ExpenseLike) => String(b.id || "").localeCompare(String(a.id || ""));

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
      return arr.sort((a, b) => time(a) - time(b) || created(a) - created(b) || (a.description || "").localeCompare(b.description || "") || byId(b, a));
    case "amount-desc":
      return arr.sort((a, b) => (b.amount || 0) - (a.amount || 0) || time(b) - time(a) || created(b) - created(a) || byId(a, b));
    case "amount-asc":
      return arr.sort((a, b) => (a.amount || 0) - (b.amount || 0) || time(b) - time(a) || created(b) - created(a) || byId(a, b));
    case "name-asc":
      return arr.sort((a, b) => (a.description || "").localeCompare(b.description || "") || time(b) - time(a) || byId(a, b));
    case "date-desc":
    default:
      return arr.sort((a, b) => time(b) - time(a) || created(b) - created(a) || (b.description || "").localeCompare(a.description || "") || byId(a, b));
  }
}

/**
 * An expense already logged with the same description, amount and day as the
 * one being added. "Dinner at Chili's" ($100, Aug 9) was saved twice four
 * minutes apart because nothing ever looked.
 */
export function findDuplicateExpense(
  existing: ReadonlyArray<any> | null | undefined,
  candidate: { description: string; amount: number; date?: string },
): any | null {
  const desc = candidate.description.trim().toLowerCase();
  if (!desc) return null;
  const day = String(candidate.date || "").slice(0, 10);
  for (const e of existing || []) {
    if (String(e?.description || "").trim().toLowerCase() !== desc) continue;
    if (Math.abs(Number(e?.amount) - candidate.amount) >= 0.005) continue;
    if (day && String(e?.date || "").slice(0, 10) !== day) continue;
    return e;
  }
  return null;
}
