// shared/expense-ledger.ts — ONE calc over the manual `expenses` ledger
// (Rules 12 & 15).
//
// The app keeps two disjoint ledgers on purpose: the manual `expenses` table
// (what the user or the bill-pay path logged) and `financial_transactions`
// (what a connected institution reported; shared/finance-calc). They are not
// merged. But every surface that reports the MANUAL ledger — the Finance
// tab, the Money overview, the dashboard KPI popups, the drill-down dialog,
// the AI snapshot, the storage stats — used to sum it with its own inline
// `reduce`, each with its own idea of the month, the owner filter and whether
// a negative row counts. This module is the single calc they all call, and
// `LEDGER_MANUAL` is the label a payload carries so a reader can tell which
// ledger a spend number came from.
//
// Pure. Amounts are SIGNED as stored (a refund row of -20 reduces the total)
// so every surface keeps reporting the number it always did; use
// shared/spending-baseline for magnitude-only analytics.
//
// Pinned by tests/expense-ledger.test.ts.

export type LedgerSource = "manual" | "connected";
export const LEDGER_MANUAL: LedgerSource = "manual";
export const LEDGER_CONNECTED: LedgerSource = "connected";

export interface LedgerExpenseLike {
  amount?: number | string | null;
  category?: string | null;
  /** YYYY-MM-DD, optionally with a time suffix. */
  date?: string | null;
  /** Profile ids the row is linked to (first entry = owner on the strict-ownership rule). */
  linkedProfiles?: readonly string[] | null;
  ownerIds?: readonly string[] | null;
  isTestData?: boolean | null;
}

export interface LedgerFilter {
  /** Inclusive YYYY-MM-DD lower bound. */
  from?: string | null;
  /** Inclusive YYYY-MM-DD upper bound. */
  to?: string | null;
  /** Keep only rows linked to (owned by) any of these profile ids. */
  ownerIds?: readonly string[] | null;
  /** Rows flagged `isTestData` are included unless this is false. */
  includeTestData?: boolean;
}

/** The signed amount of one row — `Number(amount) || 0`, exactly as every reduce did. */
export function ledgerAmount(row: LedgerExpenseLike | null | undefined): number {
  const n = Number(row?.amount);
  return Number.isFinite(n) ? n : 0;
}

/** The YYYY-MM-DD of a row, or "" when it has no date. */
export function ledgerDay(row: LedgerExpenseLike | null | undefined): string {
  return String(row?.date || "").slice(0, 10);
}

/** Does this row pass the filter? Bounds are inclusive; owner match is "any of". */
export function ledgerRowMatches(row: LedgerExpenseLike, filter: LedgerFilter = {}): boolean {
  if (!row) return false;
  if (filter.includeTestData === false && row.isTestData) return false;
  const day = ledgerDay(row);
  if (filter.from && day < String(filter.from).slice(0, 10)) return false;
  if (filter.to && day > String(filter.to).slice(0, 10)) return false;
  if (filter.ownerIds && filter.ownerIds.length > 0) {
    const owners = new Set<string>([...(row.linkedProfiles || []), ...(row.ownerIds || [])].map(String));
    if (!filter.ownerIds.some((id) => owners.has(String(id)))) return false;
  }
  return true;
}

/** The rows that pass the filter. */
export function filterLedger<T extends LedgerExpenseLike>(rows: ReadonlyArray<T> | null | undefined, filter: LedgerFilter = {}): T[] {
  return (rows || []).filter((r) => ledgerRowMatches(r, filter));
}

/** THE sum of a set of manual-ledger rows (signed), optionally filtered. */
export function sumExpenses(rows: ReadonlyArray<LedgerExpenseLike> | null | undefined, filter: LedgerFilter = {}): number {
  let total = 0;
  for (const r of rows || []) if (ledgerRowMatches(r, filter)) total += ledgerAmount(r);
  return total;
}

/** Rows dated inside `monthISO` (YYYY-MM). */
export function rowsInMonth<T extends LedgerExpenseLike>(rows: ReadonlyArray<T> | null | undefined, monthISO: string): T[] {
  const ym = String(monthISO || "").slice(0, 7);
  return (rows || []).filter((r) => ledgerDay(r).slice(0, 7) === ym);
}

/** THE month-to-date / whole-month spend for `monthISO` (YYYY-MM). */
export function monthlySpend(rows: ReadonlyArray<LedgerExpenseLike> | null | undefined, monthISO: string, filter: LedgerFilter = {}): number {
  return sumExpenses(rowsInMonth(rows, monthISO), filter);
}

export interface SpendByCategoryOptions extends LedgerFilter {
  /** Category keyer — the caller's canonical bucket (budget key, canonical expense category…). Default: the raw category or "general". */
  keyOf?: (category: string | null | undefined) => string;
}

/** Spend per category bucket, keyed by `keyOf` (default: raw category, "general" when blank). */
export function spendByCategory(rows: ReadonlyArray<LedgerExpenseLike> | null | undefined, opts: SpendByCategoryOptions = {}): Record<string, number> {
  const keyOf = opts.keyOf || ((c: string | null | undefined) => String(c || "general"));
  const out: Record<string, number> = {};
  for (const r of rows || []) {
    if (!ledgerRowMatches(r, opts)) continue;
    const k = keyOf(r.category);
    out[k] = (out[k] || 0) + ledgerAmount(r);
  }
  return out;
}

/**
 * THE savings rate: (income − spend) / income as a fraction, null when there
 * is no income to measure against. Both inputs in the same unit (minor units
 * or dollars — the ratio does not care, but they must match).
 */
export function savingsRate(incomeMinor: number, spendMinor: number): number | null {
  const income = Number(incomeMinor) || 0;
  if (income <= 0) return null;
  const spend = Number(spendMinor) || 0;
  return (income - spend) / income;
}

/** `savingsRate` as a rounded whole percent (the number the tiles print), or null. */
export function savingsRatePct(incomeMinor: number, spendMinor: number): number | null {
  const r = savingsRate(incomeMinor, spendMinor);
  return r == null ? null : Math.round(r * 100);
}
