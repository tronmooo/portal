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

import { getUserCurrentMonth } from "./timezone";

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
  if (s === "paused" || s === "cancelled" || s === "ended") return false;
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
 * The stored spelling of an income/obligation cadence. Every alias
 * toMonthlyAmount accepts folds to one word, so "bi-weekly", "fortnightly"
 * and "biweekly" are one bucket: the paycheck projection, the calendar
 * series and the monthly-total filters switch on the canonical word and an
 * alias that slipped through fell to their monthly default. Unknown → null.
 */
export const INCOME_FREQUENCIES = [
  "once", "daily", "weekly", "biweekly", "semimonthly", "monthly", "bimonthly",
  "quarterly", "semiannual", "yearly", "custom",
] as const;
export type IncomeFrequency = (typeof INCOME_FREQUENCIES)[number];

export function canonicalIncomeFrequency(raw: unknown): IncomeFrequency | null {
  const k = String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  switch (k) {
    case "once": case "one-time": case "onetime": case "single": return "once";
    case "daily": case "day": return "daily";
    case "weekly": case "week": return "weekly";
    case "biweekly": case "bi-weekly": case "fortnightly": case "every-2-weeks": case "every-other-week": return "biweekly";
    case "semimonthly": case "semi-monthly": case "twice-monthly": case "twice-a-month": return "semimonthly";
    case "monthly": case "month": return "monthly";
    case "bimonthly": case "bi-monthly": case "every-2-months": case "every-other-month": return "bimonthly";
    case "quarterly": case "quarter": case "every-3-months": return "quarterly";
    case "semiannual": case "semi-annual": case "semiannually": case "semi-annually": case "biannual": case "biannually": case "every-6-months": return "semiannual";
    case "yearly": case "annual": case "annually": case "year": return "yearly";
    case "custom": return "custom";
    default: return null;
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
 * This month's monthly-equivalent income, in the user's zone — the figure the
 * Income tile, the savings rate and the KPI strips show. A job that starts
 * next month is not this month's income: `sumMonthlyIncome` counted every
 * income regardless of its first pay day, so adding next month's paycheck
 * inflated this month's income and savings rate on every surface while the
 * Cash Flow Trend (which reads per month) left it out.
 */
export function sumMonthlyIncomeNow(
  incomes: ReadonlyArray<{ amount?: number | string | null; frequency?: string | null; date?: string | null }> | null | undefined,
  timezone: string,
): number {
  return sumMonthlyIncomeForMonth(incomes, getUserCurrentMonth(timezone));
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
    // A one-time income is not a stream: its "monthly equivalent" is $0, which
    // is right for a projection and wrong for the month it actually landed in.
    // A $750 freelance payment dated Aug 22 is $750 of August income and
    // nothing in any other month. Summed as a monthly-equivalent it counted
    // for nothing anywhere, so a month funded entirely by one-off income read
    // "In: $0" on the trend chart.
    if (canonicalIncomeFrequency(i?.frequency) === "once") {
      if (start === ym) total += Number(i?.amount) || 0;
      continue;
    }
    if (start && start > ym) continue;
    total += toMonthlyAmount(Number(i?.amount) || 0, i?.frequency);
  }
  return total;
}

// ─── Realized income: received paychecks ─────────────────────────────────────
//
// The money model has TWO income entities and only one of them was ever
// counted. `incomes` are recurring streams (a salary, a retainer) and
// `paychecks` are individual expected deposits the user marks "received".
// Every income surface — INCOME · MTD, the Cash Flow IN leg, the savings rate,
// the Cash Flow Trend — summed the streams alone, so marking a $2,000 paycheck
// received moved nothing: income read $0 and the savings rate read "—" while a
// confirmed deposit sat in the list right below. A confirmed paycheck is money
// that actually arrived; it is income for the month it arrived in.

export interface ReceivedPaycheckInput {
  confirmed?: boolean | null;
  received_date?: string | null;
  receivedDate?: string | null;
  expected_date?: string | null;
  expectedDate?: string | null;
  amount?: number | string | null;
  actual_amount?: number | string | null;
  actualAmount?: number | string | null;
}

/** The day a paycheck landed: its received date, else the day it was expected. */
export function paycheckReceivedDay(p: ReceivedPaycheckInput | null | undefined): string | null {
  const raw = p?.received_date ?? p?.receivedDate ?? p?.expected_date ?? p?.expectedDate;
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

/** What a paycheck was actually worth: the posted actual, else the expected. */
export function paycheckAmount(p: ReceivedPaycheckInput | null | undefined): number {
  const actual = Number(p?.actual_amount ?? p?.actualAmount);
  if (Number.isFinite(actual) && actual > 0) return actual;
  const expected = Number(p?.amount);
  return Number.isFinite(expected) ? expected : 0;
}

/** True for a paycheck the user has marked received. */
export function isReceivedPaycheck(p: ReceivedPaycheckInput | null | undefined): boolean {
  return p?.confirmed === true;
}

/** The paycheck money that landed in `ym` ("YYYY-MM"). Unconfirmed paychecks
 *  are expectations, not income, and are never summed here. */
export function sumReceivedPaychecksForMonth(
  paychecks: ReadonlyArray<ReceivedPaycheckInput> | null | undefined,
  ym: string,
): number {
  let total = 0;
  for (const p of paychecks || []) {
    if (!isReceivedPaycheck(p)) continue;
    const day = paycheckReceivedDay(p);
    if (!day || day.slice(0, 7) !== ym) continue;
    total += paycheckAmount(p);
  }
  return total;
}

/**
 * THE income figure for a calendar month: recurring streams that had started
 * by then, plus the paychecks that actually landed in it. Every surface that
 * shows "income this month" must use this — `sumMonthlyIncomeForMonth` alone
 * is the projection half only.
 */
export function sumMonthIncome(
  incomes: ReadonlyArray<{ amount?: number | string | null; frequency?: string | null; date?: string | null }> | null | undefined,
  paychecks: ReadonlyArray<ReceivedPaycheckInput> | null | undefined,
  ym: string,
): number {
  return sumMonthlyIncomeForMonth(incomes, ym) + sumReceivedPaychecksForMonth(paychecks, ym);
}

/** `sumMonthIncome` for the user's current month. */
export function sumMonthIncomeNow(
  incomes: ReadonlyArray<{ amount?: number | string | null; frequency?: string | null; date?: string | null }> | null | undefined,
  paychecks: ReadonlyArray<ReceivedPaycheckInput> | null | undefined,
  timezone: string,
): number {
  return sumMonthIncome(incomes, paychecks, getUserCurrentMonth(timezone));
}

// ─── Bill money still owed this month ────────────────────────────────────────
//
// Cash OUT was `this month's expenses + the monthly-equivalent of every active
// bill`. Paying a bill writes an expense (server/liability-payments.ts §4), so
// a paid bill landed in BOTH terms — paying Netflix pushed outflow UP by
// $14.99 instead of leaving it flat. The monthly-equivalent term also ignored
// WHEN a bill is due, so a bill due in October was outflow in September.
//
// The honest decomposition of a month's outflow is:
//     money already spent (expenses, bill payments among them)
//   + money still owed this month (bills whose occurrence has not been paid)
// Paying a bill moves an amount from the second term to the first and the
// total does not move. That is what these helpers compute.

/** Last calendar day of `ym` ("YYYY-MM"), as YYYY-MM-DD. */
export function monthEndDay(ym: string): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

/** Step a YYYY-MM-DD forward by one period of `frequency`. Returns null for a
 *  cadence with no next occurrence (one-off) or an unparseable date. */
export function nextOccurrenceDay(day: string, frequency?: string | null): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const y = Number(day.slice(0, 4)), m = Number(day.slice(5, 7)), d = Number(day.slice(8, 10));
  const byDays = (n: number) => {
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
  };
  const byMonths = (n: number) => {
    // Clamp to the target month's length so "the 31st" every month lands on
    // the 30th/28th rather than rolling into the next month.
    const target = new Date(Date.UTC(y, m - 1 + n, 1));
    const len = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    const dd = Math.min(d, len);
    return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  };
  switch (canonicalIncomeFrequency(frequency) ?? "monthly") {
    case "daily": return byDays(1);
    case "weekly": return byDays(7);
    case "biweekly": return byDays(14);
    case "semimonthly": return byDays(15);
    case "monthly": return byMonths(1);
    case "bimonthly": return byMonths(2);
    case "quarterly": return byMonths(3);
    case "semiannual": return byMonths(6);
    case "yearly": return byMonths(12);
    case "once": return null;
    default: return byMonths(1);
  }
}

export interface BillDueInput {
  amount?: number | string | null;
  frequency?: string | null;
  nextDueDate?: string | Date | null;
  status?: string | null;
  recurrenceEnd?: string | null;
}

/** Guards a pathological cadence (daily over a long catch-up) from looping. */
const MAX_OCCURRENCES_PER_MONTH = 62;

/**
 * The bill money still owed on or before the end of `ym`: every unpaid
 * occurrence of every active obligation, overdue ones from earlier months
 * included (still owed) and later months' excluded (not this month's money).
 *
 * Paying an occurrence advances the bill's `nextDueDate` past it, so a bill
 * settled this month drops out of this sum on its own — its expense row is
 * what carries it from then on.
 */
export function sumBillsDueThroughMonth(
  obligations: ReadonlyArray<BillDueInput> | null | undefined,
  ym: string,
): number {
  const end = monthEndDay(ym);
  let total = 0;
  for (const o of obligations || []) {
    if (!isActiveObligation(o)) continue;
    const raw = o?.nextDueDate;
    const first = typeof raw === "string" ? raw.slice(0, 10)
      : raw instanceof Date && !Number.isNaN(raw.getTime()) ? raw.toISOString().slice(0, 10) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || first > end) continue;
    const amount = Number(o?.amount);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const stop = typeof o?.recurrenceEnd === "string" && /^\d{4}-\d{2}-\d{2}/.test(o.recurrenceEnd)
      ? o.recurrenceEnd.slice(0, 10) : null;
    let day: string | null = first;
    for (let n = 0; day && day <= end && n < MAX_OCCURRENCES_PER_MONTH; n++) {
      if (stop && day > stop) break;
      total += amount;
      day = nextOccurrenceDay(day, o?.frequency);
    }
  }
  return total;
}
