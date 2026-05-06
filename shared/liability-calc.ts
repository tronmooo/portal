/**
 * Liability calculation engine — deterministic, pure functions for
 * amortization, payoff, and payment allocation.
 *
 * Shared between client and server so both compute identical numbers.
 */

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
}

const SAFETY_MAX_PERIODS = 600; // 50 years — prevent runaways

/** Normalize an APR-ish input to a decimal rate (0.065). */
export function normalizeAnnualRate(r: number | string | undefined | null): number {
  if (r == null || r === "") return 0;
  const n = typeof r === "string" ? parseFloat(r.replace("%", "").trim()) : Number(r);
  if (!Number.isFinite(n) || n < 0) return 0;
  // If someone passed 6.5 instead of 0.065, assume percent and convert.
  return n > 1 ? n / 100 : n;
}

/** Minimum payment for a fully-amortizing loan. */
export function computeAmortizedPayment(balance: number, annualRate: number, months: number): number {
  const r = normalizeAnnualRate(annualRate) / 12;
  if (months <= 0) return balance;
  if (r === 0) return balance / months;
  return (balance * r) / (1 - Math.pow(1 + r, -months));
}

function addMonthsIso(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
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
      : new Date().toISOString().slice(0, 10);

  let payment = Number(terms.monthlyPayment) || 0;
  if (!payment || payment <= 0) {
    const months = Math.max(1, Math.floor(Number(terms.remainingTermMonths) || 360));
    payment = computeAmortizedPayment(balance, annualRate, months);
  }

  const rows: AmortizationRow[] = [];
  let remaining = balance;
  let cumulativeInterest = 0;

  for (let i = 1; i <= SAFETY_MAX_PERIODS && remaining > 0.005; i++) {
    const interest = remaining * monthlyRate;
    let principal = payment - interest;
    let extraApplied = extra;

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
    // Safety: if payment doesn't cover interest, loan never pays off
    if (payment <= interest) {
      break;
    }
  }

  const last = rows[rows.length - 1];
  const totalPaid = rows.reduce((s, r) => s + r.payment, 0);

  return {
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
  return {
    principal: principalPaid,
    interest: interestPaid,
    fees: safeFees,
    remainingBalanceAfter: newBalance,
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
  const progress = orig > 0 ? Math.max(0, Math.min(100, (1 - params.currentBalance / orig) * 100)) : 0;
  return {
    currentBalance: params.currentBalance,
    originalBalance: orig,
    monthlyPayment: amo.monthlyPayment,
    annualRate: normalizeAnnualRate(params.annualRate),
    payoffProgressPct: progress,
    remainingMonths: amo.payoffMonths,
    payoffDate: amo.payoffDate,
    totalRemainingInterest: amo.totalInterest,
  };
}
