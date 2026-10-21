// ── Payoff outlook: chart-ready views of an amortization schedule ────────────
// The liability detail page draws "balance over time until payoff" and
// "interest vs principal" for an amortizing loan. Neither is a new calculation:
// both are read off the AmortizationResult that shared/liability-calc
// `buildAmortization` already produces for the page (the same schedule behind
// the Payoff KPI, the Cost-of-borrowing card and the amortization table), so a
// chart can never disagree with the numbers printed beside it.
//
// Also decides WHETHER a payoff can be drawn: balance, rate and a payment (or a
// remaining term to derive one from) must be on the record. Without them
// buildAmortization would assume a 360-month term, which is a guess, not the
// user's loan. Pure; pinned by tests/liability-payoff.test.ts.
import type { AmortizationResult } from "./liability-calc";

export interface PayoffInputs {
  balance: number;
  /** The rate as stored (readInterestRateRaw) — null/"" when the record has none. A stored 0 is a real 0% loan. */
  rateRaw: number | string | null | undefined;
  monthlyPayment: number;
  remainingTermMonths?: number | null;
}

export type PayoffMissing = "balance" | "interest rate" | "monthly payment";

/** What the record lacks before a payoff can be drawn; [] when it is complete. */
export function payoffMissingFields(i: PayoffInputs): PayoffMissing[] {
  const missing: PayoffMissing[] = [];
  if (!(Number(i.balance) > 0)) missing.push("balance");
  const rate = i.rateRaw;
  const rateNum = typeof rate === "string" ? parseFloat(rate.replace(/[^0-9.\-]/g, "")) : Number(rate);
  if (rate == null || rate === "" || !Number.isFinite(rateNum) || rateNum < 0) missing.push("interest rate");
  if (!(Number(i.monthlyPayment) > 0) && !(Number(i.remainingTermMonths) > 0)) missing.push("monthly payment");
  return missing;
}

export interface PayoffPoint {
  /** YYYY-MM-DD. Point 0 is the balance today, dated the day before the first payment's row. */
  date: string;
  /** Payments made by this point (0 at the start). */
  paymentNumber: number;
  balance: number;
  /** Interest paid from today up to this point. */
  interestPaid: number;
  /** Principal paid from today up to this point (including extra principal). */
  principalPaid: number;
}

/**
 * Balance after every payment, starting from today's balance, thinned to at
 * most `maxPoints` (always keeping the start and the payoff) so a 30-year
 * mortgage is 60 points on a phone, not 360.
 */
export function payoffSeries(
  amo: AmortizationResult,
  opts: { startBalance: number; todayISO?: string; maxPoints?: number },
): PayoffPoint[] {
  const rows = amo.rows;
  if (rows.length === 0 || amo.neverAmortizes) return [];
  const start: PayoffPoint = {
    date: opts.todayISO ?? rows[0].dueDate,
    paymentNumber: 0,
    balance: Math.max(0, Number(opts.startBalance) || 0),
    interestPaid: 0,
    principalPaid: 0,
  };
  const all: PayoffPoint[] = [start];
  let principalPaid = 0;
  for (const r of rows) {
    principalPaid += r.principal + r.extraPrincipal;
    all.push({
      date: r.dueDate,
      paymentNumber: r.paymentNumber,
      balance: r.remainingBalance,
      interestPaid: r.cumulativeInterest,
      principalPaid,
    });
  }
  const max = Math.max(2, Math.floor(opts.maxPoints ?? 60));
  if (all.length <= max) return all;
  const step = (all.length - 1) / (max - 1);
  const out: PayoffPoint[] = [];
  for (let k = 0; k < max; k++) out.push(all[Math.round(k * step)]);
  out[out.length - 1] = all[all.length - 1];
  return out;
}

export interface PrincipalInterestSplit {
  principal: number;
  interest: number;
  total: number;
  /** 0..100 share of the remaining payments that is interest. */
  interestPct: number;
}

/** Of everything still to be paid, how much retires principal and how much is interest. */
export function principalInterestSplit(amo: AmortizationResult): PrincipalInterestSplit | null {
  if (amo.rows.length === 0 || amo.neverAmortizes) return null;
  const principal = amo.rows.reduce((s, r) => s + r.principal + r.extraPrincipal, 0);
  const interest = amo.totalInterest;
  const total = principal + interest;
  if (!(total > 0)) return null;
  return { principal, interest, total, interestPct: (interest / total) * 100 };
}
