// shared/loan-terms.ts — Canonical derivation of a fixed-term loan's schedule.
//
// A user describes a loan the way the paperwork does: an original amount, a
// balance, an APR, a payment, a term, a start date, a payoff date. Half of
// those imply the other half, and the app used to store only the handful of
// keys the AI tool schema happened to expose — so "a 72-month term beginning
// March 31, 2025 with an estimated payoff of February 28, 2031" landed in the
// profile as neither a term, nor a start, nor a payoff. This module takes
// whatever subset was stated and fills in the rest, once, so the detail page,
// the amortization schedule, and the calendar all read the same numbers.
//
// Two rules the date math here exists to enforce:
//
//   1. A payment due on the LAST day of the month stays on the last day.
//      Day 31 clamps to 30 in April and 28/29 in February (date-math.ts), and
//      every occurrence is indexed from the base date so a clamped month never
//      drags the series off the 31st.
//   2. Dates are computed as strings, never by round-tripping a Date through
//      another timezone. Building `new Date(y, m, 31)` on a UTC server and then
//      formatting it `en-CA` in America/Los_Angeles yields Aug 30 for Aug 31 —
//      that is exactly how a loan due the last day of the month showed a next
//      payment of "Aug 30".
//
// Pure + dependency-free apart from date-math, so the server, the client, and
// tests share one definition.

import { addMonthsISO, daysInMonth } from "./date-math";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Coerce to YYYY-MM-DD, or undefined when the value isn't a usable date. */
function iso(v: any): string | undefined {
  const s = String(v ?? "").slice(0, 10);
  if (!ISO_RE.test(s)) return undefined;
  const yr = parseInt(s.slice(0, 4), 10);
  // Reject fat-fingered years (12024) the same way the detail page does.
  return yr >= 1900 && yr <= 2100 ? s : undefined;
}

function num(v: any): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.\-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Whole months from `a` to `b` (both YYYY-MM-DD), ignoring day-of-month. */
function monthSpan(a: string, b: string): number {
  const [ay, am] = [parseInt(a.slice(0, 4), 10), parseInt(a.slice(5, 7), 10)];
  const [by, bm] = [parseInt(b.slice(0, 4), 10), parseInt(b.slice(5, 7), 10)];
  return (by - ay) * 12 + (bm - am);
}

export interface LoanTermsInput {
  /** Total contract term in months as written on the loan (72, 360). */
  termMonths?: number | string | null;
  /** Months left, when the user stated that instead of the total term. */
  remainingTermMonths?: number | string | null;
  /** YYYY-MM-DD the term begins (origination). */
  loanStartDate?: string | null;
  /** YYYY-MM-DD of the first scheduled payment. */
  firstPaymentDate?: string | null;
  /** YYYY-MM-DD of the final payment / maturity. */
  payoffDate?: string | null;
  /** YYYY-MM-DD of the next payment, when stated outright. */
  nextPaymentDate?: string | null;
  /** Day-of-month the payment is due. 31 means "last day of the month". */
  dueDay?: number | string | null;
}

export interface DerivedLoanTerms {
  termMonths?: number;
  remainingTermMonths?: number;
  loanStartDate?: string;
  firstPaymentDate?: string;
  payoffDate?: string;
  dueDay?: number;
  /** Next payment on or after today — what the calendar and the hero show. */
  nextDueDate?: string;
  dueDate?: string;
  frequency?: string;
  /** Ends the calendar series at payoff instead of recurring forever. */
  recurrenceEnd?: string;
}

/**
 * Fill in a fixed-term loan's schedule from whatever the user stated.
 *
 * Everything is optional and nothing is invented from nothing: a field comes
 * back only when it was given or is genuinely implied. `todayISO` is the
 * caller's local date (YYYY-MM-DD) and drives `remainingTermMonths` and
 * `nextDueDate` — pass the user's timezone-local today, not `new Date()`.
 */
export function deriveLoanTerms(input: LoanTermsInput, todayISO: string): DerivedLoanTerms {
  const out: DerivedLoanTerms = {};
  const today = iso(todayISO) || new Date().toLocaleDateString("en-CA");

  const loanStartDate = iso(input.loanStartDate);
  // The term starts when the loan does; if only one of the two dates was
  // stated, it stands in for the other rather than leaving a hole.
  const firstPaymentDate = iso(input.firstPaymentDate) || loanStartDate;
  if (loanStartDate) out.loanStartDate = loanStartDate;
  else if (firstPaymentDate) out.loanStartDate = firstPaymentDate;
  if (firstPaymentDate) out.firstPaymentDate = firstPaymentDate;

  // Due day: stated, else the day the first payment falls on. A first payment
  // on the last day of a 30-day month means the 31st — "last day of the month"
  // — because a 30-day anchor would silently move March/May/July to the 30th.
  let dueDay = num(input.dueDay);
  if (dueDay != null) dueDay = Math.max(1, Math.min(31, Math.round(dueDay)));
  if (dueDay == null && firstPaymentDate) {
    const d = parseInt(firstPaymentDate.slice(8, 10), 10);
    const yr = parseInt(firstPaymentDate.slice(0, 4), 10);
    const mo = parseInt(firstPaymentDate.slice(5, 7), 10) - 1;
    dueDay = d === daysInMonth(yr, mo) && d >= 28 ? 31 : d;
  }
  if (dueDay != null) out.dueDay = dueDay;

  const termMonths = num(input.termMonths);
  if (termMonths != null && termMonths > 0) out.termMonths = Math.round(termMonths);

  // Payoff: stated, else the last installment of the contract term. A 72-month
  // loan whose first payment is Mar 31 2025 makes its 72nd payment 71 months
  // later — Feb 28 2031, clamped off the 31st anchor.
  let payoffDate = iso(input.payoffDate);
  if (!payoffDate && firstPaymentDate && out.termMonths) {
    payoffDate = addMonthsISO(firstPaymentDate, out.termMonths - 1, dueDay ?? undefined);
  }
  if (payoffDate) {
    out.payoffDate = payoffDate;
    out.recurrenceEnd = payoffDate;
  }

  // Term, when only the two endpoints were given.
  if (!out.termMonths && firstPaymentDate && payoffDate) {
    const span = monthSpan(firstPaymentDate, payoffDate) + 1;
    if (span > 0) out.termMonths = span;
  }

  // Payments already behind us — every scheduled date on or before today.
  let elapsed = 0;
  if (firstPaymentDate && firstPaymentDate <= today) {
    const span = monthSpan(firstPaymentDate, today);
    // The occurrence in today's own month counts only if its clamped date has
    // already arrived.
    const thisMonth = addMonthsISO(firstPaymentDate, span, dueDay ?? undefined);
    elapsed = span + (thisMonth <= today ? 1 : 0);
  }

  // Remaining term: stated wins, then contract term minus elapsed, then the
  // months left until payoff.
  const statedRemaining = num(input.remainingTermMonths);
  if (statedRemaining != null && statedRemaining > 0) {
    out.remainingTermMonths = Math.round(statedRemaining);
  } else if (out.termMonths) {
    out.remainingTermMonths = Math.max(0, out.termMonths - elapsed);
  } else if (payoffDate && payoffDate >= today) {
    out.remainingTermMonths = Math.max(0, monthSpan(today, payoffDate) + 1);
  }

  // Next due: stated, else the first scheduled date strictly after today —
  // today's own payment is still due today, so `>= today` is the test.
  let nextDue = iso(input.nextPaymentDate);
  if (!nextDue && firstPaymentDate) {
    nextDue = firstPaymentDate >= today
      ? firstPaymentDate
      : addMonthsISO(firstPaymentDate, monthSpan(firstPaymentDate, today), dueDay ?? undefined);
    if (nextDue < today) {
      nextDue = addMonthsISO(firstPaymentDate, monthSpan(firstPaymentDate, today) + 1, dueDay ?? undefined);
    }
  }
  if (!nextDue && dueDay != null) {
    // No dates at all, just a due day: this month's, or next month's if passed.
    const span0 = addMonthsISO(today.slice(0, 8) + "01", 0, dueDay);
    nextDue = span0 >= today ? span0 : addMonthsISO(today.slice(0, 8) + "01", 1, dueDay);
  }
  // A schedule never runs past payoff.
  if (nextDue && payoffDate && nextDue > payoffDate) nextDue = undefined;
  if (nextDue) {
    out.nextDueDate = nextDue;
    out.dueDate = nextDue;
    out.frequency = "monthly";
  }

  return out;
}
