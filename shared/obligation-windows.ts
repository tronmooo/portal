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

import { getUserCurrentMonth, getUserToday } from "./timezone";

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

// ─── Income received TO DATE (QA 2026-09-18 BUG-05) ──────────────────────────
//
// `sumMonthIncome` is the month's EXPECTED income: every stream's monthly
// equivalent plus the paychecks that landed. INCOME · MTD, the Cash Flow IN
// leg and the savings rate were reading that figure, so a "Monthly Paycheck"
// whose first pay day is the 30th counted in full on the 18th, while spend is
// actuals only — cash flow read ~$3,000 too optimistic and the alerts panel
// congratulated the user on a 51% savings rate funded by money that had not
// arrived. Month-to-date income is what has actually been received:
//   • a received paycheck (confirmed) — in the month it landed;
//   • a recurring stream's occurrences whose pay day is on or before today;
//   • a one-time income dated on or before today.
// The projection stays available as `sumMonthIncome` for a clearly labelled
// "expected this month" figure.

export interface IncomeStreamInput {
  id?: string | null;
  amount?: number | string | null;
  frequency?: string | null;
  /** First pay day (YYYY-MM-DD). */
  date?: string | null;
  description?: string | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}/;

/** Whole days from `a` to `b` (both YYYY-MM-DD); negative when b is earlier. */
function daysBetween(a: string, b: string): number {
  const ms = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10)))
    - Date.UTC(Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10)));
  return Math.round(ms / MS_PER_DAY);
}

/** Period length for a day-based cadence, or null for a month-based one. */
function periodDays(frequency?: string | null): number | null {
  switch (canonicalIncomeFrequency(frequency) ?? "monthly") {
    case "daily": return 1;
    case "weekly": return 7;
    case "biweekly": return 14;
    case "semimonthly": return 15;
    default: return null;
  }
}

/** Period length in months for a month-based cadence (1 for unknown/custom). */
function periodMonths(frequency?: string | null): number {
  switch (canonicalIncomeFrequency(frequency) ?? "monthly") {
    case "bimonthly": return 2;
    case "quarterly": return 3;
    case "semiannual": return 6;
    case "yearly": return 12;
    default: return 1;
  }
}

/**
 * The pay days of a recurring stream that fall inside `ym`, on or before
 * `throughDay` when given. The anchor is the stream's first pay day; earlier
 * months produce nothing. Jumps straight to the first occurrence on or after
 * the month start instead of stepping day by day from a years-old anchor.
 */
export function incomeOccurrenceDaysInMonth(
  income: IncomeStreamInput | null | undefined,
  ym: string,
  throughDay?: string | null,
): string[] {
  const anchorRaw = income?.date;
  if (typeof anchorRaw !== "string" || !DAY_RE.test(anchorRaw)) return [];
  const anchor = anchorRaw.slice(0, 10);
  if (!/^\d{4}-\d{2}$/.test(ym)) return [];
  const monthStart = `${ym}-01`;
  const end = monthEndDay(ym);
  const last = throughDay && DAY_RE.test(throughDay) && throughDay.slice(0, 10) < end ? throughDay.slice(0, 10) : end;
  if (anchor > last) return [];
  const freq = canonicalIncomeFrequency(income?.frequency) ?? "monthly";
  if (freq === "once") return anchor >= monthStart && anchor <= last ? [anchor] : [];

  let day: string | null;
  const pd = periodDays(freq);
  if (pd != null) {
    const gap = daysBetween(anchor, monthStart);
    const n = gap <= 0 ? 0 : Math.ceil(gap / pd);
    // Jump n periods in one go rather than stepping from the anchor.
    const t = new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 1, Number(anchor.slice(8, 10)) + n * pd));
    day = t.toISOString().slice(0, 10);
  } else {
    const pm = periodMonths(freq);
    const monthsGap = (Number(ym.slice(0, 4)) - Number(anchor.slice(0, 4))) * 12 + (Number(ym.slice(5, 7)) - Number(anchor.slice(5, 7)));
    const n = monthsGap <= 0 ? 0 : Math.ceil(monthsGap / pm);
    day = anchor;
    for (let i = 0; i < n; i++) day = nextOccurrenceDay(day!, freq);
    // A monthly stream anchored on the 31st clamps to short months and the
    // clamp must not drift: re-derive from the anchor's own day-of-month.
    if (day && n > 0) {
      const target = new Date(Date.UTC(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 1 + n * pm, 1));
      const len = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      const dd = Math.min(Number(anchor.slice(8, 10)), len);
      day = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
  }
  const out: string[] = [];
  for (let i = 0; day && day <= last && i < MAX_OCCURRENCES_PER_MONTH; i++) {
    if (day >= monthStart) out.push(day);
    day = nextOccurrenceDay(day, freq);
  }
  return out;
}

/**
 * Recurring-stream income that has actually been paid out in `ym` on or
 * before `throughDay`: the face amount of every occurrence that has fallen
 * due, plus one-time incomes dated on or before that day. A stream with no
 * pay day on record cannot be placed inside the month, so it keeps its
 * monthly equivalent (the pre-existing behaviour) rather than vanishing.
 */
export function sumMonthlyIncomeToDate(
  incomes: ReadonlyArray<IncomeStreamInput> | null | undefined,
  ym: string,
  throughDay: string,
): number {
  let total = 0;
  for (const i of incomes || []) {
    const amount = Number(i?.amount) || 0;
    if (!amount) continue;
    const hasDay = typeof i?.date === "string" && DAY_RE.test(i.date);
    if (!hasDay) {
      const start = typeof i?.date === "string" && /^\d{4}-\d{2}/.test(i.date) ? i.date.slice(0, 7) : null;
      if (canonicalIncomeFrequency(i?.frequency) === "once") {
        if (start === ym && ym <= throughDay.slice(0, 7)) total += amount;
        continue;
      }
      if (start && start > ym) continue;
      total += toMonthlyAmount(amount, i?.frequency);
      continue;
    }
    total += amount * incomeOccurrenceDaysInMonth(i, ym, throughDay).length;
  }
  return total;
}

/** Two amounts within a cent of each other are one amount. */
const SAME_AMOUNT_TOLERANCE = 0.005;

/**
 * A recurring stream's occurrence that a received paycheck already covers:
 * same pay day, same amount. Counting both would book one deposit twice
 * (the "Monthly Income" stream's Sep 9 occurrence AND the received "Employer"
 * paycheck for Sep 9, $2,000).
 */
function occurrenceCoveredByPaycheck(day: string, amount: number, received: ReadonlyArray<ReceivedPaycheckInput>): boolean {
  return received.some((p) => paycheckReceivedDay(p) === day && Math.abs(paycheckAmount(p) - amount) <= SAME_AMOUNT_TOLERANCE);
}

/**
 * THE month-to-date income figure: paychecks received in `ym` plus the
 * recurring / one-time income whose pay day has arrived, with an occurrence a
 * received paycheck already covers counted once. INCOME · MTD, Cash Flow IN
 * and the savings rate read this; `sumMonthIncome` is the projection.
 */
export function sumMonthIncomeToDate(
  incomes: ReadonlyArray<IncomeStreamInput> | null | undefined,
  paychecks: ReadonlyArray<ReceivedPaycheckInput> | null | undefined,
  ym: string,
  throughDay: string,
): number {
  const received = (paychecks || []).filter((p) => isReceivedPaycheck(p) && (paycheckReceivedDay(p) || "").slice(0, 7) === ym);
  let total = 0;
  for (const p of received) total += paycheckAmount(p);
  for (const i of incomes || []) {
    const amount = Number(i?.amount) || 0;
    if (!amount) continue;
    if (!(typeof i?.date === "string" && DAY_RE.test(i.date))) {
      total += sumMonthlyIncomeToDate([i], ym, throughDay);
      continue;
    }
    for (const day of incomeOccurrenceDaysInMonth(i, ym, throughDay)) {
      if (occurrenceCoveredByPaycheck(day, amount, received)) continue;
      total += amount;
    }
  }
  return total;
}

/** `sumMonthIncomeToDate` for the user's current month, through today. */
export function sumMonthIncomeToDateNow(
  incomes: ReadonlyArray<IncomeStreamInput> | null | undefined,
  paychecks: ReadonlyArray<ReceivedPaycheckInput> | null | undefined,
  timezone: string,
): number {
  return sumMonthIncomeToDate(incomes, paychecks, getUserCurrentMonth(timezone), getUserToday(timezone));
}

// ─── Expected-paycheck reconciliation (QA 2026-09-18 BUG-07) ─────────────────
//
// Two expected-paycheck rows for one deposit — "Employer · Sep 9 · $2,000 ·
// Received" and "Monthly Income · Sep 9 · $2,000 · Overdue" — are one paycheck
// logged twice (the AI's projection and the user's own row). The unreceived
// twin sat in the list as Overdue and fed the "past its date and not marked
// received" alert while the money was demonstrably in. A pending row whose
// date and amount match a received one is treated as received (matched).

export interface ExpectedPaycheckRow extends ReceivedPaycheckInput {
  id?: string | null;
  source?: string | null;
}

export interface ReconciledPaycheck<T extends ExpectedPaycheckRow = ExpectedPaycheckRow> {
  paycheck: T;
  /** True when the row is confirmed OR covered by a confirmed twin. */
  received: boolean;
  /** The confirmed row that covers this pending one, when matched. */
  matchedTo: T | null;
}

/** The day a paycheck is (or was) expected: its expected date, else the received date. */
function paycheckExpectedDay(p: ReceivedPaycheckInput | null | undefined): string | null {
  const raw = p?.expected_date ?? p?.expectedDate ?? p?.received_date ?? p?.receivedDate;
  return typeof raw === "string" && DAY_RE.test(raw) ? raw.slice(0, 10) : null;
}

/**
 * Pair each pending expected paycheck with a confirmed one on the same
 * expected day for the same amount. Each confirmed row covers at most one
 * pending twin, so two genuinely separate deposits still need two receipts.
 */
export function reconcileExpectedPaychecks<T extends ExpectedPaycheckRow>(
  paychecks: ReadonlyArray<T> | null | undefined,
): ReconciledPaycheck<T>[] {
  const rows = paychecks || [];
  const confirmed = rows.filter((p) => isReceivedPaycheck(p));
  const claimed = new Set<T>();
  return rows.map((p) => {
    if (isReceivedPaycheck(p)) return { paycheck: p, received: true, matchedTo: null };
    const day = paycheckExpectedDay(p);
    const amount = paycheckAmount(p);
    const twin = day
      ? confirmed.find((c) => !claimed.has(c) && paycheckExpectedDay(c) === day && Math.abs(paycheckAmount(c) - amount) <= SAME_AMOUNT_TOLERANCE)
      : undefined;
    if (twin) { claimed.add(twin); return { paycheck: p, received: true, matchedTo: twin }; }
    return { paycheck: p, received: false, matchedTo: null };
  });
}

/**
 * Expected paychecks that are genuinely late: past their date, not marked
 * received, and not covered by a received twin. Feeds the Finance alert.
 */
export function latePaychecks<T extends ExpectedPaycheckRow>(
  paychecks: ReadonlyArray<T> | null | undefined,
  todayISO: string,
): T[] {
  return reconcileExpectedPaychecks(paychecks)
    .filter((r) => !r.received && (paycheckExpectedDay(r.paycheck) || "") < todayISO.slice(0, 10))
    .map((r) => r.paycheck);
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
