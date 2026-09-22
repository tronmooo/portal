/**
 * Liability calculation engine — deterministic, pure functions for
 * amortization, payoff, and payment allocation.
 *
 * Shared between client and server so both compute identical numbers.
 */

import { addMonthsISO } from "./date-math";
import { normalizeAnnualRate, readAnnualRate } from "./liability-fields";

// The one APR→decimal converter lives with the canonical field readers
// (shared/liability-fields); re-exported so existing imports keep working.
export { normalizeAnnualRate };

export interface LiabilityTerms {
  /** Remaining principal balance today. Required. */
  currentBalance: number;
  /** Annual interest rate, either a decimal (0.065) or a percent (6.5). */
  annualInterestRate: number;
  /** Scheduled periodic payment amount (e.g. monthly). Optional — if omitted, we use the minimum payment computed from remainingTermMonths. */
  monthlyPayment?: number;
  /** Remaining number of months on the schedule. Optional — required only when monthlyPayment is not supplied. */
  remainingTermMonths?: number;
  /** Optional: extra principal applied to every period. */
  extraPerPeriod?: number;
  /** Optional: ISO date string of the first scheduled payment. Defaults to today. */
  firstPaymentDate?: string;
}

export interface AmortizationRow {
  paymentNumber: number;
  dueDate: string;      // YYYY-MM-DD
  payment: number;      // total payment that period (principal + interest + extra)
  principal: number;
  interest: number;
  extraPrincipal: number;
  remainingBalance: number;
  cumulativeInterest: number;
}

export interface AmortizationResult {
  rows: AmortizationRow[];
  totalInterest: number;
  totalPaid: number;
  payoffDate: string;
  payoffMonths: number;
  monthlyPayment: number;
  /** True when the payment does not cover the interest, so no payoff exists. */
  neverAmortizes?: boolean;
}

const SAFETY_MAX_PERIODS = 600; // 50 years — prevent runaways

/**
 * Resolve a liability's annual interest rate from its `fields` object as a
 * decimal (0.065). ONE precedence, starting from the canonical `interestRate`
 * key (shared/liability-fields `INTEREST_RATE_KEYS`), so the server, the
 * detail page and the chat cannot read the same record differently (Rule 11).
 */
export function resolveAnnualRate(fields: any): number {
  return readAnnualRate(fields);
}

/**
 * Share of the original debt already paid, 0..100. THE percent-paid formula:
 * the overview composer, the loan tab and the summary all call this one.
 */
export function payoffProgressPct(originalBalance: number, currentBalance: number): number {
  const orig = Number(originalBalance) || 0;
  const cur = Number(currentBalance) || 0;
  if (orig <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - cur / orig) * 100));
}

/** Minimum payment for a fully-amortizing loan. */
export function computeAmortizedPayment(balance: number, annualRate: number, months: number): number {
  const r = normalizeAnnualRate(annualRate) / 12;
  if (months <= 0) return balance;
  if (r === 0) return balance / months;
  return (balance * r) / (1 - Math.pow(1 + r, -months));
}

// Month arithmetic clamped to month end and anchored on the first payment's
// day (shared/date-math). Raw setUTCMonth overflowed: a Jan 31 first payment
// produced Mar 3 for the second and drifted the whole schedule.
function addMonthsIso(iso: string, n: number): string {
  const anchorDay = Number(iso.slice(8, 10)) || undefined;
  return addMonthsISO(iso, n, anchorDay);
}

/** Build a complete amortization schedule for the given terms. */
export function buildAmortization(terms: LiabilityTerms): AmortizationResult {
  const balance = Math.max(0, Number(terms.currentBalance) || 0);
  const annualRate = normalizeAnnualRate(terms.annualInterestRate);
  const monthlyRate = annualRate / 12;
  const extra = Math.max(0, Number(terms.extraPerPeriod) || 0);
  const firstDate =
    terms.firstPaymentDate && /^\d{4}-\d{2}-\d{2}$/.test(terms.firstPaymentDate)
      ? terms.firstPaymentDate
      : new Date().toLocaleDateString("en-CA"); // local calendar day, not UTC's

  let payment = Number(terms.monthlyPayment) || 0;
  if (!payment || payment <= 0) {
    const months = Math.max(1, Math.floor(Number(terms.remainingTermMonths) || 360));
    payment = computeAmortizedPayment(balance, annualRate, months);
  }

  const rows: AmortizationRow[] = [];
  let remaining = balance;
  let cumulativeInterest = 0;

  let neverAmortizes = false;
  for (let i = 1; i <= SAFETY_MAX_PERIODS && remaining > 0.005; i++) {
    const interest = remaining * monthlyRate;
    // A payment that doesn't cover the interest never pays the loan off. Stop
    // BEFORE emitting a row: the old check ran after the push, so such a loan
    // reported "pays off in 1 month" with a negative-principal row.
    if (payment + extra <= interest) { neverAmortizes = true; break; }
    let principal = payment - interest;
    let extraApplied = extra;

    // A residual smaller than half a payment is folded into this payment —
    // the way a lender closes a loan — instead of standing as a "month" of
    // its own. $48,629.10 at 6.49% with $912.40/mo pays off in 63 payments;
    // counting the ~$45 that would be left after the 63rd as a 64th month put
    // "64 mo" on the detail page against 63 everywhere it was worked by hand.
    const residual = remaining - (principal + extraApplied);
    if (residual > 0 && residual < payment / 2) {
      principal = remaining - extraApplied;
      if (principal < 0) { principal = remaining; extraApplied = 0; }
    }

    // Prevent over-paying on final period
    if (principal + extraApplied > remaining) {
      const needed = remaining - principal;
      if (needed < 0) {
        // Payment > interest+balance — shrink principal, no extra
        principal = remaining;
        extraApplied = 0;
      } else {
        extraApplied = Math.max(0, Math.min(extra, needed));
      }
    }

    const totalPrincipal = principal + extraApplied;
    remaining = Math.max(0, remaining - totalPrincipal);
    cumulativeInterest += interest;

    rows.push({
      paymentNumber: i,
      dueDate: addMonthsIso(firstDate, i - 1),
      payment: principal + interest + extraApplied,
      principal,
      interest,
      extraPrincipal: extraApplied,
      remainingBalance: remaining,
      cumulativeInterest,
    });

    if (remaining <= 0.005) break;
  }

  const last = rows[rows.length - 1];
  const totalPaid = rows.reduce((s, r) => s + r.payment, 0);

  return {
    neverAmortizes,
    rows,
    totalInterest: cumulativeInterest,
    totalPaid,
    payoffDate: last ? last.dueDate : firstDate,
    payoffMonths: rows.length,
    monthlyPayment: payment,
  };
}

/**
 * Allocate a one-off payment into principal vs interest vs fees, given
 * the current balance and monthly rate.
 * - Interest is computed from the balance at the time of payment.
 * - Remainder after interest and fees goes to principal.
 */
export function allocatePayment(
  paymentAmount: number,
  currentBalance: number,
  annualRate: number,
  fees: number = 0,
): { principal: number; interest: number; fees: number; remainingBalanceAfter: number } {
  const monthlyRate = normalizeAnnualRate(annualRate) / 12;
  const interestAccrued = Math.max(0, currentBalance * monthlyRate);
  const safeFees = Math.max(0, fees);
  let remaining = Math.max(0, paymentAmount - safeFees);
  const interestPaid = Math.min(interestAccrued, remaining);
  remaining -= interestPaid;
  const principalPaid = Math.min(remaining, currentBalance);
  const newBalance = Math.max(0, currentBalance - principalPaid);
  // Round every money output to cents so decimal payments (e.g. $0.17) save and
  // reduce the balance by the EXACT amount instead of drifting on float error
  // (60 - 0.17 must be 59.83, not 59.82999999).
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  return {
    principal: round2(principalPaid),
    interest: round2(interestPaid),
    fees: round2(safeFees),
    remainingBalanceAfter: round2(newBalance),
  };
}

/**
 * Summarize a liability for the Overview dashboard cards.
 */
export interface LiabilitySummary {
  currentBalance: number;
  originalBalance: number;
  monthlyPayment: number;
  annualRate: number;
  payoffProgressPct: number;   // 0..100
  interestAccrued?: number;    // based on payment history (optional)
  remainingMonths: number;
  payoffDate: string;
  totalRemainingInterest: number;
  /** Payment does not cover interest — no payoff date exists. */
  neverAmortizes?: boolean;
}

export function summarizeLiability(params: {
  currentBalance: number;
  originalBalance?: number;
  monthlyPayment?: number;
  annualRate: number;
  remainingTermMonths?: number;
  extraPerPeriod?: number;
  firstPaymentDate?: string;
}): LiabilitySummary {
  const amo = buildAmortization({
    currentBalance: params.currentBalance,
    annualInterestRate: params.annualRate,
    monthlyPayment: params.monthlyPayment,
    remainingTermMonths: params.remainingTermMonths,
    extraPerPeriod: params.extraPerPeriod,
    firstPaymentDate: params.firstPaymentDate,
  });
  const orig = Number(params.originalBalance) || 0;
  const progress = payoffProgressPct(orig, params.currentBalance);
  return {
    currentBalance: params.currentBalance,
    originalBalance: orig,
    monthlyPayment: amo.monthlyPayment,
    annualRate: normalizeAnnualRate(params.annualRate),
    payoffProgressPct: progress,
    remainingMonths: amo.payoffMonths,
    payoffDate: amo.payoffDate,
    totalRemainingInterest: amo.totalInterest,
    neverAmortizes: amo.neverAmortizes,
  };
}
