// shared/spending-baseline.ts — Canonical spending-analysis primitives.
//
// Before this module existed, server/insights-engine.ts and
// server/weekly-review.ts each carried an independent copy of the
// category-breakdown / baseline / anomaly math with subtly different
// definitions. This module is the single implementation of that math.
// Callers keep their own thresholds and window sizes as parameters — the
// goal is one implementation, not identical windows.
//
// Canonical definitions (and the deltas they introduce vs the old copies):
//   * Amounts are Math.abs(Number(amount)) — magnitude of spend.
//     (insights-engine previously summed raw signed amounts; the schema
//     enforces positive amounts so this is a defensive-only change.)
//   * Missing/empty categories bucket under "uncategorized".
//     (insights-engine previously keyed on the raw value, which could
//     produce an "undefined" bucket for malformed rows.)
//   * Month windows compare YYYY-MM date-string prefixes — timezone-stable,
//     matching the insights-engine bug fix for UTC month rollover.
//     (weekly-review previously Date-parsed every expense and compared
//     against a server-local month start, which mis-bucketed expenses near
//     month boundaries on non-UTC servers.)
//   * A "week" is exactly days / 7 and a "month" is 365/12 days.
//     (weekly-review previously divided a 90-day category total by a
//     hardcoded 13 weeks ≈ 91 days, understating weekly baselines ~1.1%.)

import { MS_PER_DAY } from "./obligation-windows";

/** Minimal structural type — both Expense rows and loose storage rows fit. */
export interface ExpenseLike {
  amount?: number | string | null;
  category?: string | null;
  /** YYYY-MM-DD, optionally with a time suffix. */
  date?: string | null;
}

export const UNCATEGORIZED = "uncategorized";

/** Canonical spend magnitude for a single expense row. */
export function expenseAmount(e: ExpenseLike): number {
  const n = Math.abs(Number(e?.amount ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Canonical category key for a single expense row. */
export function expenseCategory(e: ExpenseLike): string {
  return String(e?.category || UNCATEGORIZED);
}

/**
 * A time window over expense rows. All bounds are inclusive; multiple bounds
 * are ANDed together.
 */
export interface SpendingWindow {
  /** Lower bound via Date parsing — rows with unparseable dates are excluded. */
  since?: Date;
  /** Lower bound as a YYYY-MM-DD string (lexicographic compare, no parsing). */
  sinceDateStr?: string;
  /** Restrict to one calendar month via the YYYY-MM prefix of the date string. */
  month?: string;
}

export function inWindow(e: ExpenseLike, window?: SpendingWindow): boolean {
  if (!window) return true;
  const dateStr = String(e?.date || "");
  if (window.month !== undefined && dateStr.slice(0, 7) !== window.month) return false;
  if (window.sinceDateStr !== undefined && dateStr.slice(0, 10) < window.sinceDateStr) return false;
  if (window.since !== undefined) {
    const t = new Date(dateStr).getTime();
    if (Number.isNaN(t) || t < window.since.getTime()) return false;
  }
  return true;
}

export function filterByWindow<T extends ExpenseLike>(expenses: T[], window?: SpendingWindow): T[] {
  return window ? expenses.filter((e) => inWindow(e, window)) : expenses;
}

/** Total spend (canonical magnitude) across the window. */
export function totalSpend(expenses: ExpenseLike[], window?: SpendingWindow): number {
  let sum = 0;
  for (const e of expenses) {
    if (inWindow(e, window)) sum += expenseAmount(e);
  }
  return sum;
}

/** Per-category spend totals across the window. */
export function sumByCategory(expenses: ExpenseLike[], window?: SpendingWindow): Record<string, number> {
  const byCat: Record<string, number> = {};
  for (const e of expenses) {
    if (!inWindow(e, window)) continue;
    const cat = expenseCategory(e);
    byCat[cat] = (byCat[cat] || 0) + expenseAmount(e);
  }
  return byCat;
}

/** Category totals sorted descending — [category, amount] pairs. */
export function topCategories(byCat: Record<string, number>, limit?: number): Array<[string, number]> {
  const sorted = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}

export type PeriodBucket = "week" | "month";

/** Canonical bucket count: week = exactly 7 days, month = 365/12 days. */
export function bucketsInDays(days: number, bucket: PeriodBucket): number {
  return bucket === "week" ? days / 7 : days / (365 / 12);
}

/**
 * Average spend per week/month over expenses spanning `days` days.
 * Pass a `window` to filter; the caller is responsible for `days` matching
 * the window's span.
 */
export function periodAverage(
  expenses: ExpenseLike[],
  days: number,
  bucket: PeriodBucket,
  window?: SpendingWindow,
): number {
  const buckets = bucketsInDays(days, bucket);
  return buckets > 0 ? totalSpend(expenses, window) / buckets : 0;
}

/**
 * Per-category baseline: average spend per `bucket` over the trailing
 * `lookbackDays` ending at `now`. Insertion order follows first occurrence
 * of each category in `expenses`.
 */
export function computeBaseline(
  expenses: ExpenseLike[],
  lookbackDays: number,
  bucket: PeriodBucket = "week",
  now: Date = new Date(),
): Record<string, number> {
  const buckets = bucketsInDays(lookbackDays, bucket);
  if (buckets <= 0) return {};
  const since = new Date(now.getTime() - lookbackDays * MS_PER_DAY);
  const totals = sumByCategory(expenses, { since });
  const out: Record<string, number> = {};
  for (const [cat, total] of Object.entries(totals)) out[cat] = total / buckets;
  return out;
}

export interface CategoryAnomalyThresholds {
  /** Ignore categories whose baseline is below this (low-signal). */
  minBaseline: number;
  /** Current spend must exceed baseline * ratio ... */
  ratio: number;
  /** ... AND exceed the baseline by at least this absolute amount. */
  minAbsDelta: number;
  /** Percentage delta above which an anomaly is "high" severity. */
  highPctDelta: number;
}

export interface CategoryAnomaly {
  category: string;
  current: number;
  baseline: number;
  /** Percentage delta of current vs baseline, e.g. 65 = 65% above baseline. */
  pctDelta: number;
  severity: "medium" | "high";
}

/**
 * Flag categories whose current-period spend is anomalously above baseline.
 * `current` and `baseline` must be expressed per the SAME period (e.g. both
 * weekly). Iterates baseline categories, so categories with current spend but
 * no baseline history are never flagged (no history → no anomaly signal).
 */
export function detectCategoryAnomalies(
  current: Record<string, number>,
  baseline: Record<string, number>,
  thresholds: CategoryAnomalyThresholds,
): CategoryAnomaly[] {
  const out: CategoryAnomaly[] = [];
  for (const [cat, base] of Object.entries(baseline)) {
    if (base < thresholds.minBaseline) continue;
    const cur = current[cat] || 0;
    if (cur > base * thresholds.ratio && cur - base > thresholds.minAbsDelta) {
      const pctDelta = base > 0 ? ((cur - base) / base) * 100 : 0;
      out.push({
        category: cat,
        current: cur,
        baseline: base,
        pctDelta,
        severity: pctDelta > thresholds.highPctDelta ? "high" : "medium",
      });
    }
  }
  return out;
}

/**
 * Current calendar month as "YYYY-MM" in the given IANA timezone.
 * Omit `timezone` for the server's local month.
 */
export function currentMonthYM(timezone?: string, now: Date = new Date()): string {
  return now
    .toLocaleDateString("en-CA", timezone ? { timeZone: timezone } : undefined)
    .slice(0, 7);
}

/** The "YYYY-MM" month immediately before the given "YYYY-MM" month. */
export function previousMonthYM(ym: string): string {
  const [y, m] = ym.split("-").map((s) => parseInt(s, 10));
  // m is 1-based; Date months are 0-based, so m - 2 is the previous month.
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
