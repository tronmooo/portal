// shared/obligation-windows.ts — Canonical obligation timing constants.
//
// Two long-standing bugs lived here:
//   1. getStats() used a 7-day window for upcoming obligations while
//      getDashboardEnhanced() used 30 days, so the dashboard KPI count
//      permanently differed from the popup. (Audit finding 1.1.)
//   2. Monthly conversion used 4.33 / 2.17 truncated multipliers in some
//      places and 52/12 / 26/12 in others, giving cents-level drift between
//      tiles. (Audit finding 1.2.)
//
// All callers — server storage, server routes, client dashboard, finance
// page — MUST import from this module. Inline 4.33/2.17 or hardcoded
// 7/30 day constants are bugs.

export const UPCOMING_BILL_WINDOW_DAYS = 30;
export const MS_PER_DAY = 86_400_000;

export interface UpcomingBillCheckInput {
  nextDueDate?: string | Date | null;
  status?: string | null;
}

/**
 * A paused or cancelled obligation costs nothing this month: it belongs in
 * neither the upcoming-bill list nor the monthly-obligations total. ONE rule
 * for both, so the KPI tile and the popup never disagree.
 */
export function isActiveObligation(
  o: { status?: string | null; nextDueDate?: string | Date | null; recurrenceEnd?: string | null } | null | undefined,
): boolean {
  const s = o?.status;
  if (s === "paused" || s === "cancelled") return false;
  // A finite series whose next occurrence falls after its end date has no
  // occurrence left: the calendar already drew nothing for it, but the bills
  // list and the monthly total still counted it.
  const end = typeof o?.recurrenceEnd === "string" ? o.recurrenceEnd.slice(0, 10) : "";
  const next = typeof o?.nextDueDate === "string" ? o.nextDueDate.slice(0, 10) : o?.nextDueDate instanceof Date ? o.nextDueDate.toISOString().slice(0, 10) : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(end) && /^\d{4}-\d{2}-\d{2}$/.test(next) && next > end) return false;
  return true;
}

/**
 * Returns true if the obligation belongs in the upcoming-bill window: due
 * within UPCOMING_BILL_WINDOW_DAYS (overdue bills included — they are still
 * owed) and not paused or cancelled.
 *
 * The status rule and the ceil() day rounding are the ones the dashboard
 * popup (getDashboardEnhanced.upcomingBills) has always used. getStats()
 * had neither, so the KPI tile counted paused bills the popup did not list.
 */
export function isUpcomingBill(o: UpcomingBillCheckInput, now: Date = new Date()): boolean {
  if (!o?.nextDueDate) return false;
  if (!isActiveObligation(o)) return false;
  const due = new Date(o.nextDueDate);
  if (Number.isNaN(due.getTime())) return false;
  const daysUntil = Math.ceil((due.getTime() - now.getTime()) / MS_PER_DAY);
  return daysUntil <= UPCOMING_BILL_WINDOW_DAYS;
}

/**
 * Convert an obligation/expense amount to monthly equivalent using EXACT
 * fractional multipliers (not the truncated 4.33 / 2.17).
 *
 * Supported frequencies: weekly, biweekly, monthly, quarterly, annual, yearly,
 * semiannual, semi-annual, daily, custom (defaults to monthly).
 */
export function toMonthlyAmount(amount: number | string, frequency?: string | null): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0) return 0;
  const freq = String(frequency || "monthly").toLowerCase();
  switch (freq) {
    case "weekly":
    case "week":
      return n * (52 / 12);
    case "biweekly":
    case "bi-weekly":
    case "fortnightly":
    case "every-2-weeks":
      return n * (26 / 12);
    case "monthly":
    case "month":
      return n;
    case "quarterly":
    case "quarter":
    case "every-3-months":
      return n / 3;
    case "semiannual":
    case "semi-annual":
    case "semiannually":
    case "semi-annually":
    case "biannual":
    case "biannually":
    case "every-6-months":
      return n / 6;
    case "bimonthly":
    case "bi-monthly":
    case "every-2-months":
    case "every-other-month":
      return n / 2;
    case "semimonthly":
    case "semi-monthly":
    case "twice-monthly":
    case "twice-a-month":
      return n * 2;
    case "once":
    case "one-time":
    case "one_time":
    case "onetime":
    case "single":
      // A one-off is not a recurring monthly cost.
      return 0;
    case "annual":
    case "annually":
    case "yearly":
    case "year":
      return n / 12;
    case "daily":
    case "day":
      return n * (365 / 12);
    default:
      // Unknown / custom — treat as already monthly.
      return n;
  }
}

/**
 * The monthly-equivalent total of a set of incomes. ONE definition: the hero
 * cash-flow tile, the executive overview and the Cash Flow popup used to add
 * incomes at face value while the Finance tab converted them with
 * toMonthlyAmount — a $2,600 biweekly paycheck read as $2,600 on one tile and
 * $5,633 on the next, and the two cash-flow figures on one screen disagreed.
 */
export function sumMonthlyIncome(incomes: ReadonlyArray<{ amount?: number | string | null; frequency?: string | null }> | null | undefined): number {
  let total = 0;
  for (const i of incomes || []) total += toMonthlyAmount(Number(i?.amount) || 0, i?.frequency);
  return total;
}

/**
 * The monthly-equivalent income that existed in a given calendar month
 * (`ym` = "YYYY-MM"). An income's `date` is its first pay day, so a paycheck
 * first dated Aug 28 is not inflow for April; an income without a date counts
 * in every month. The Cash Flow Trend used to paint today's income across all
 * six months, so the months before a job started showed a full paycheck.
 */
export function sumMonthlyIncomeForMonth(
  incomes: ReadonlyArray<{ amount?: number | string | null; frequency?: string | null; date?: string | null }> | null | undefined,
  ym: string,
): number {
  let total = 0;
  for (const i of incomes || []) {
    const start = typeof i?.date === "string" && /^\d{4}-\d{2}/.test(i.date) ? i.date.slice(0, 7) : null;
    if (start && start > ym) continue;
    total += toMonthlyAmount(Number(i?.amount) || 0, i?.frequency);
  }
  return total;
}
