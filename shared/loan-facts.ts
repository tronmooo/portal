// Loan facts every surface must agree on: when the NEXT payment is due and how
// long the payoff takes. QA 2026-09-18 (F-08, F-09, F-12): the loan detail page
// dated its schedule from the loan's ORIGIN (Mar 31 2025 — "536d overdue",
// Missed (2)) while the liability list said Oct 30 2026, and the Finance tab
// said "67 mo left" (the stored contract term) while the detail page said
// "64 mo" (the amortization). One rule, here, imported by both.

import { normalizeDateString } from "./extraction-normalize";
import { addMonthsISO } from "./date-math";
import { resolveAnnualRate, summarizeLiability, type LiabilitySummary } from "./liability-calc";
import { readBalance, readMonthlyPayment, readOriginalBalance } from "./liability-fields";

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
 *
 * Rule 14 note — payment history is not a schedule. The `lastPaidDate` step
 * above is a MODIFIER of a schedule the loan already names (its payment day):
 * it only decides whether THIS cycle's occurrence is already settled and the
 * next one is what is owed. It never manufactures a due date from a payment
 * date: with no `dueDay` and no stored date, a loan with a `lastPaidDate` still
 * returns null. (The old "last paid + 1 month" fallback in
 * shared/liability-schedule was exactly that inference, and is gone.)
 */
/**
 * Does the latest payment belong to an occurrence at or before `previousDue`?
 * A payment made late (the Nov 15 instalment paid on Nov 27, or moved to the
 * 24th) is dated inside the NEXT cycle, but it settled the earlier one: the
 * occurrence stamp that names its date says which. Without this the late
 * payment read as "December is already paid", the next due date jumped two
 * months and Auto Pay skipped a cycle.
 */
export function lastPaymentSettledEarlierCycle(fields: Record<string, any> | null | undefined, lastPaidISO: string, previousDue: string): boolean {
  const occ = (fields || {}).occurrences;
  if (!occ || typeof occ !== "object") return false;
  return Object.entries(occ as Record<string, any>).some(([key, stamp]) =>
    ISO_DAY.test(key) && key <= previousDue && stamp && stamp.status === "paid" && clip(stamp.paymentDate) === lastPaidISO);
}

/**
 * Does the latest payment cover the cycle that follows `previousDue`?
 *
 * It does when it was made after the previous due day — unless the records
 * say otherwise:
 *   • it settled an EARLIER occurrence (a late or delayed payment), or
 *   • it was an extra-principal payment. An extra $1,000 on the 5th is not
 *     the month's instalment: the instalment is still due on the 15th (it
 *     used to read "next due: next month", and Auto Pay skipped the cycle).
 * A regular payment made the same day as an extra one still counts: its
 * occurrence stamp carries that date.
 */
export function lastPaymentCoversCycle(fields: Record<string, any> | null | undefined, lastPaidISO: string | null | undefined, previousDue: string): boolean {
  const f = fields || {};
  const lastPaid = clip(lastPaidISO);
  if (!ISO_DAY.test(lastPaid) || !(lastPaid > previousDue)) return false;
  if (lastPaymentSettledEarlierCycle(f, lastPaid, previousDue)) return false;
  if (clip(f.lastExtraPrincipalDate) === lastPaid) {
    const occ = f.occurrences && typeof f.occurrences === "object" ? f.occurrences as Record<string, any> : {};
    const regularSameDay = Object.entries(occ).some(([key, stamp]) =>
      ISO_DAY.test(key) && key > previousDue && stamp && stamp.status === "paid" && clip(stamp.paymentDate) === lastPaid);
    if (!regularSameDay) return false;
  }
  return true;
}

/** The earliest occurrence the user moved to another day that is still open and not past. */
function movedOpenOccurrence(fields: Record<string, any>, today: string): string | null {
  const occ = fields.occurrences;
  if (!occ || typeof occ !== "object") return null;
  const days = Object.values(occ as Record<string, any>)
    .filter((st) => st && ISO_DAY.test(clip(st.movedTo)) && !["paid", "skipped", "missed"].includes(String(st.status || "")))
    .map((st) => clip(st.movedTo))
    .filter((d) => d >= today)
    .sort();
  return days[0] ?? null;
}

export function nextLoanDueDate(fields: Record<string, any> | null | undefined, todayISO: string): string | null {
  const today = clip(todayISO);
  if (!ISO_DAY.test(today)) return null;
  const regular = regularLoanDueDate(fields, today);
  // One payment moved to another day is due on THAT day (the series keeps its
  // own day for every other month).
  const moved = movedOpenOccurrence(fields || {}, today);
  return moved && (!regular || moved < regular) ? moved : regular;
}

function regularLoanDueDate(fields: Record<string, any> | null | undefined, today: string): string | null {
  const f = fields || {};
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
    if (lastPaymentCoversCycle(f, lastPaid, previous)) {
      due = dayInMonth(addMonthsISO(due.slice(0, 7) + "-01", 1).slice(0, 7), day);
    }
  }
  return due;
}

/** The loan's scheduled payment — the ONE reader (shared/liability-fields). */
export function loanMonthlyPayment(fields: Record<string, any> | null | undefined): number {
  return readMonthlyPayment(fields);
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
export function loanPayoff(
  fields: Record<string, any> | null | undefined,
  todayISO: string,
  opts: { extraPerPeriod?: number; nextDueISO?: string | null } = {},
): LiabilitySummary {
  const f = fields || {};
  const payment = loanMonthlyPayment(f);
  const term = loanStoredTermMonths(f);
  return summarizeLiability({
    currentBalance: readBalance(f),
    originalBalance: readOriginalBalance(f) || undefined,
    monthlyPayment: payment || undefined,
    annualRate: resolveAnnualRate(f),
    remainingTermMonths: term || undefined,
    extraPerPeriod: opts.extraPerPeriod || undefined,
    firstPaymentDate: (opts.nextDueISO === undefined ? nextLoanDueDate(f, todayISO) : opts.nextDueISO) ?? undefined,
  });
}
