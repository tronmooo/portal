// Loan facts every surface must agree on: when the NEXT payment is due and how
// long the payoff takes. QA 2026-09-18 (F-08, F-09, F-12): the loan detail page
// dated its schedule from the loan's ORIGIN (Mar 31 2025 — "536d overdue",
// Missed (2)) while the liability list said Oct 30 2026, and the Finance tab
// said "67 mo left" (the stored contract term) while the detail page said
// "64 mo" (the amortization). One rule, here, imported by both.

import { normalizeDateString } from "./extraction-normalize";
import { addMonthsISO } from "./date-math";
import { resolveAnnualRate, summarizeLiability, type LiabilitySummary } from "./liability-calc";
import { resolveLiabilityBalance } from "./asset-value";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v: unknown) => String(v ?? "").slice(0, 10);

/**
 * The day of the month a loan's payment falls on: an explicit `dueDay`, else
 * the day of the most deliberate stored date (next payment, due date, first
 * payment, start date). Null when nothing names a day.
 */
export function loanDueDay(fields: Record<string, any> | null | undefined): number | null {
  const f = fields || {};
  const explicit = parseInt(String(f.dueDay ?? f.due_day ?? f.paymentDueDay ?? f.payment_due_day ?? ""), 10);
  if (explicit >= 1 && explicit <= 31) return explicit;
  for (const v of [
    f.nextPaymentDate, f.nextPayment, f.next_payment, f.nextDueDate, f.next_due_date,
    f.dueDate, f.due_date, f.firstPaymentDate, f.first_payment_date,
    f.loanStartDate, f.loan_start_date, f.startDate, f.start_date,
  ]) {
    const iso = normalizeDateString(v);
    if (iso) return Number(iso.slice(8, 10));
  }
  return null;
}

/** The `day`-of-month occurrence in the month of `ym` (YYYY-MM), clamped to month end. */
function dayInMonth(ym: string, day: number): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * THE next payment date of a loan / card, derived from its payment day and
 * today — never from the origin date.
 *
 *   • a stored next date on or after today is the user's own answer and wins;
 *   • otherwise the payment day's occurrence in this month (or next month once
 *     it has passed);
 *   • a payment already made in this cycle (`lastPaidDate` after the previous
 *     occurrence) moves it one cycle further — the paired "<loan> payment"
 *     bill advances the same way, so the list and the page agree.
 *
 * Null when the loan names no payment day at all (nothing is invented).
 */
export function nextLoanDueDate(fields: Record<string, any> | null | undefined, todayISO: string): string | null {
  const f = fields || {};
  const today = clip(todayISO);
  if (!ISO_DAY.test(today)) return null;
  for (const v of [f.nextPaymentDate, f.nextPayment, f.next_payment, f.nextDueDate, f.next_due_date, f.dueDate, f.due_date]) {
    const iso = normalizeDateString(v);
    if (iso && iso >= today) return iso;
  }
  const day = loanDueDay(f);
  if (day == null) return null;
  let due = dayInMonth(today.slice(0, 7), day);
  if (due < today) due = dayInMonth(addMonthsISO(today.slice(0, 7) + "-01", 1).slice(0, 7), day);
  const lastPaid = normalizeDateString(f.lastPaidDate ?? f.last_paid_date);
  if (lastPaid) {
    const previous = dayInMonth(addMonthsISO(due.slice(0, 7) + "-01", -1).slice(0, 7), day);
    if (lastPaid > previous) due = dayInMonth(addMonthsISO(due.slice(0, 7) + "-01", 1).slice(0, 7), day);
  }
  return due;
}

/** The loan's scheduled payment, from any of the spellings the writers use. */
export function loanMonthlyPayment(fields: Record<string, any> | null | undefined): number {
  const f = fields || {};
  const finance = f.finance || {};
  const loan = f.loan || {};
  for (const v of [
    f.monthlyPayment, f.monthly_payment, f.minimumPayment, f.minimum_payment, f.min_payment,
    finance.monthlyPayment, finance.monthly_payment, loan.monthlyPayment, loan.monthly_payment,
  ]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** The contract term still stored on the loan (months), or 0. */
export function loanStoredTermMonths(fields: Record<string, any> | null | undefined): number {
  const f = fields || {};
  const n = Math.floor(Number(f.remainingTermMonths ?? f.remaining_term_months ?? f.loanTermMonths ?? f.termMonths ?? f.term_months ?? 0) || 0);
  return n > 0 ? n : 0;
}

/**
 * ONE payoff summary for a loan: the amortization of TODAY's balance starting
 * at the NEXT payment date. `remainingMonths` is what every "mo left" reads.
 */
export function loanPayoff(fields: Record<string, any> | null | undefined, todayISO: string): LiabilitySummary {
  const f = fields || {};
  const payment = loanMonthlyPayment(f);
  const term = loanStoredTermMonths(f);
  return summarizeLiability({
    currentBalance: resolveLiabilityBalance(f),
    originalBalance: Number(f.originalBalance ?? f.original_balance ?? f.originalAmount ?? f.original_amount ?? 0) || undefined,
    monthlyPayment: payment || undefined,
    annualRate: resolveAnnualRate(f),
    remainingTermMonths: term || undefined,
    firstPaymentDate: nextLoanDueDate(f, todayISO) ?? undefined,
  });
}
