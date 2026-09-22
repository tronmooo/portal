// shared/liability-derived.ts — ONE derivation of every liability number a
// page shows (Rule 12).
//
// Months remaining, payments remaining, percent paid, equity, payoff date and
// next due used to be recomputed by hand on the loan tab (its own amortization
// loop and closed-form term), by the chat's get_liability_summary (a
// closed-form months-left), by the overview composer (balance ÷ payment) and
// by the detail page (shared/liability-calc). The detail page's engine is the
// right one; this module puts a single entry point over it —
// `deriveLiabilityMetrics(fields, todayISO)` — and everything else calls that.
//
// Inputs come from the canonical readers (shared/liability-fields), the
// schedule from shared/loan-facts `loanPayoff` (amortization of TODAY's
// balance from the NEXT payment), the next due from the temporal engine
// (shared/temporal-status). Pure. Pinned by tests/liability-derived.test.ts.

import { buildAmortization, payoffProgressPct, type AmortizationResult, type LiabilitySummary } from "./liability-calc";
import { loanPayoff, loanStoredTermMonths } from "./loan-facts";
import { readBalance, readInterestRatePct, readMonthlyPayment, readOriginalBalance } from "./liability-fields";
import { getRecordTemporalStatus, type RecordTemporalStatus } from "./temporal-status";

export { payoffProgressPct };

export interface LiabilityMetrics {
  balance: number;
  monthlyPayment: number;
  /** Annual rate as a percent (6.49 = 6.49%). */
  interestRatePct: number;
  originalBalance: number;
  /** Months until payoff on the current payment, or null when unknown / never. */
  monthsRemaining: number | null;
  /** Scheduled payments left — the monthly count; null when unknown. */
  paymentsRemaining: number | null;
  /** 0..100 share of the original debt already paid; null without an original balance. */
  percentPaid: number | null;
  /** Linked asset value minus balance; null unless an asset value was given. */
  equity: number | null;
  /** YYYY-MM-DD of the final payment, or null. */
  payoffDate: string | null;
  totalRemainingInterest: number;
  /** The payment does not cover the interest, so no payoff exists. */
  neverAmortizes: boolean;
  /** THE next due (shared/temporal-status). */
  nextDue: RecordTemporalStatus;
  /** The underlying summary, for callers that need the raw engine output. */
  summary: LiabilitySummary;
}

export interface DeriveOptions {
  /** Subtype (`type_key`) — decides bill vs loan routing for `nextDue`. */
  typeKey?: string | null;
  /** The profile row, when available (carries `type_key` / `type`). */
  row?: any;
  /** Value of the asset this debt is secured by, for `equity`. */
  linkedAssetValue?: number | null;
  /** Extra principal applied every period (payoff simulator). */
  extraPerPeriod?: number;
}

/** Equity after debt: asset value minus every balance secured against it. */
export function computeEquity(assetValue: number, debtBalances: ReadonlyArray<number>): number {
  const debt = debtBalances.reduce((s, b) => s + (Number(b) || 0), 0);
  return (Number(assetValue) || 0) - debt;
}

/**
 * Every derived liability figure, from one call. Callers pass the profile's
 * `fields` and the user's `todayISO` (shared/timezone `getUserToday`).
 */
export function deriveLiabilityMetrics(
  fields: Record<string, any> | null | undefined,
  todayISO: string,
  opts: DeriveOptions = {},
): LiabilityMetrics {
  const f = fields || {};
  const nextDue = getRecordTemporalStatus({ kind: "liability", fields: f, row: opts.row, typeKey: opts.typeKey }, todayISO);
  const balance = readBalance(f);
  const monthlyPayment = readMonthlyPayment(f);
  const interestRatePct = readInterestRatePct(f);
  const originalBalance = readOriginalBalance(f);
  // The schedule starts at the temporal engine's next due — the same day the
  // header chip shows — never at the loan's origin.
  const summary = loanPayoff(f, todayISO, { extraPerPeriod: opts.extraPerPeriod, nextDueISO: nextDue.nextOccurrence });
  const hasSchedule = balance > 0 && summary.monthlyPayment > 0 && !summary.neverAmortizes && summary.remainingMonths > 0;
  const storedTerm = loanStoredTermMonths(f);
  const monthsRemaining = balance <= 0 ? 0 : hasSchedule ? summary.remainingMonths : storedTerm > 0 ? storedTerm : null;
  const linked = opts.linkedAssetValue;
  return {
    balance,
    monthlyPayment,
    interestRatePct,
    originalBalance,
    monthsRemaining,
    paymentsRemaining: monthsRemaining,
    percentPaid: originalBalance > 0 ? payoffProgressPct(originalBalance, balance) : null,
    equity: linked != null && Number.isFinite(Number(linked)) ? computeEquity(Number(linked), [balance]) : null,
    payoffDate: hasSchedule ? summary.payoffDate : null,
    totalRemainingInterest: hasSchedule ? summary.totalRemainingInterest : 0,
    neverAmortizes: !!summary.neverAmortizes,
    nextDue,
    summary,
  };
}

/**
 * The full amortization table behind `deriveLiabilityMetrics` — same terms,
 * same start date — for pages that chart or list the rows.
 */
export function deriveLiabilityAmortization(
  fields: Record<string, any> | null | undefined,
  todayISO: string,
  opts: DeriveOptions = {},
): AmortizationResult {
  const f = fields || {};
  const nextDue = getRecordTemporalStatus({ kind: "liability", fields: f, row: opts.row, typeKey: opts.typeKey }, todayISO);
  const payment = readMonthlyPayment(f);
  const term = loanStoredTermMonths(f);
  return buildAmortization({
    currentBalance: readBalance(f),
    annualInterestRate: readInterestRatePct(f),
    monthlyPayment: payment || undefined,
    remainingTermMonths: term || undefined,
    extraPerPeriod: opts.extraPerPeriod || undefined,
    firstPaymentDate: nextDue.nextOccurrence ?? undefined,
  });
}

export interface ExtraPaymentSimulation {
  months: number;
  totalInterest: number;
  payoffDate: string | null;
  monthsSaved: number;
  interestSaved: number;
}

/**
 * "What if I paid $X more each month?" — the base schedule and the schedule
 * with `extra` applied, from the same engine, so the simulator on the loan
 * tab and the one on the detail page can never disagree.
 */
export function simulateExtraPayment(
  fields: Record<string, any> | null | undefined,
  todayISO: string,
  extra: number,
  opts: Omit<DeriveOptions, "extraPerPeriod"> = {},
): ExtraPaymentSimulation {
  const base = deriveLiabilityMetrics(fields, todayISO, opts);
  const withExtra = deriveLiabilityMetrics(fields, todayISO, { ...opts, extraPerPeriod: Math.max(0, Number(extra) || 0) });
  const baseMonths = base.monthsRemaining ?? 0;
  const months = withExtra.monthsRemaining ?? 0;
  return {
    months,
    totalInterest: withExtra.totalRemainingInterest,
    payoffDate: withExtra.payoffDate,
    monthsSaved: Math.max(0, baseMonths - months),
    interestSaved: Math.max(0, base.totalRemainingInterest - withExtra.totalRemainingInterest),
  };
}
