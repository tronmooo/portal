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
  if (o.status === "paused" || o.status === "cancelled") return false;
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
