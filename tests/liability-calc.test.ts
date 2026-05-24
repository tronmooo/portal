import { describe, it, expect } from 'vitest';
import {
  normalizeAnnualRate,
  computeAmortizedPayment,
  buildAmortization,
  allocatePayment,
  summarizeLiability,
} from '../shared/liability-calc';

describe('normalizeAnnualRate', () => {
  it('returns 0 for null, undefined, and empty string', () => {
    expect(normalizeAnnualRate(null)).toBe(0);
    expect(normalizeAnnualRate(undefined)).toBe(0);
    expect(normalizeAnnualRate('')).toBe(0);
  });

  it('returns 0 for negative or non-finite numbers', () => {
    expect(normalizeAnnualRate(-1)).toBe(0);
    expect(normalizeAnnualRate(NaN)).toBe(0);
    expect(normalizeAnnualRate(Infinity)).toBe(0);
  });

  it('treats values > 1 as percentages and converts to decimal', () => {
    expect(normalizeAnnualRate(6.5)).toBeCloseTo(0.065, 10);
    expect(normalizeAnnualRate(100)).toBe(1);
  });

  it('treats values <= 1 as decimal rates', () => {
    expect(normalizeAnnualRate(0.065)).toBe(0.065);
    expect(normalizeAnnualRate(1)).toBe(1);
    expect(normalizeAnnualRate(0)).toBe(0);
  });

  it('parses strings, stripping % and whitespace', () => {
    expect(normalizeAnnualRate('6.5%')).toBeCloseTo(0.065, 10);
    expect(normalizeAnnualRate(' 7.25 % ')).toBeCloseTo(0.0725, 10);
    expect(normalizeAnnualRate('0.05')).toBe(0.05);
  });

  it('returns 0 for unparseable strings', () => {
    expect(normalizeAnnualRate('abc')).toBe(0);
  });

  // KNOWN LIMITATION: a 1% APR passed as 1 is treated as 100% decimal.
  // This test pins the documented behavior so we notice if it changes.
  it('cannot distinguish 1% from a 1.0 decimal rate (documented limitation)', () => {
    expect(normalizeAnnualRate(1)).toBe(1);
  });
});

describe('computeAmortizedPayment', () => {
  it('returns balance when months <= 0', () => {
    expect(computeAmortizedPayment(1000, 0.05, 0)).toBe(1000);
    expect(computeAmortizedPayment(1000, 0.05, -5)).toBe(1000);
  });

  it('handles zero interest as simple division', () => {
    expect(computeAmortizedPayment(1200, 0, 12)).toBe(100);
  });

  it('matches the standard amortization formula for a 30-year mortgage', () => {
    // $200,000 @ 6% for 360 months -> ~$1,199.10
    const payment = computeAmortizedPayment(200_000, 0.06, 360);
    expect(payment).toBeCloseTo(1199.1, 1);
  });

  it('accepts percent input via normalizeAnnualRate', () => {
    const fromPercent = computeAmortizedPayment(200_000, 6, 360);
    const fromDecimal = computeAmortizedPayment(200_000, 0.06, 360);
    expect(fromPercent).toBeCloseTo(fromDecimal, 8);
  });
});

describe('buildAmortization', () => {
  it('pays off a simple zero-rate loan in exactly N periods', () => {
    const r = buildAmortization({
      currentBalance: 1200,
      annualInterestRate: 0,
      monthlyPayment: 100,
      firstPaymentDate: '2026-01-15',
    });
    expect(r.rows.length).toBe(12);
    expect(r.totalInterest).toBe(0);
    expect(r.totalPaid).toBeCloseTo(1200, 8);
    expect(r.rows[r.rows.length - 1].remainingBalance).toBe(0);
    expect(r.payoffDate).toBe('2026-12-15');
  });

  it('computes payment from remainingTermMonths when not provided', () => {
    const r = buildAmortization({
      currentBalance: 200_000,
      annualInterestRate: 0.06,
      remainingTermMonths: 360,
      firstPaymentDate: '2026-01-01',
    });
    expect(r.monthlyPayment).toBeCloseTo(1199.1, 1);
    expect(r.rows.length).toBeLessThanOrEqual(360);
    expect(r.rows.length).toBeGreaterThanOrEqual(359);
  });

  it('applies extraPerPeriod to shorten the loan', () => {
    const baseline = buildAmortization({
      currentBalance: 100_000,
      annualInterestRate: 0.05,
      remainingTermMonths: 360,
      firstPaymentDate: '2026-01-01',
    });
    const withExtra = buildAmortization({
      currentBalance: 100_000,
      annualInterestRate: 0.05,
      remainingTermMonths: 360,
      extraPerPeriod: 200,
      firstPaymentDate: '2026-01-01',
    });
    expect(withExtra.rows.length).toBeLessThan(baseline.rows.length);
    expect(withExtra.totalInterest).toBeLessThan(baseline.totalInterest);
  });

  it('bails out at SAFETY_MAX_PERIODS when payment cannot cover interest', () => {
    const r = buildAmortization({
      currentBalance: 100_000,
      annualInterestRate: 0.12, // $1000/month just to cover interest
      monthlyPayment: 500,      // less than interest
      firstPaymentDate: '2026-01-01',
    });
    // Should break out of the loop on the very first iteration via the
    // payment <= interest guard, not run for 600 periods.
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].remainingBalance).toBeGreaterThan(0);
  });

  it('clamps negative currentBalance to 0 (no rows generated)', () => {
    const r = buildAmortization({
      currentBalance: -500,
      annualInterestRate: 0.05,
      monthlyPayment: 100,
      firstPaymentDate: '2026-01-01',
    });
    expect(r.rows.length).toBe(0);
    expect(r.payoffDate).toBe('2026-01-01');
    expect(r.payoffMonths).toBe(0);
  });

  it('falls back to today when firstPaymentDate is invalid', () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = buildAmortization({
      currentBalance: 1000,
      annualInterestRate: 0,
      monthlyPayment: 1000,
      firstPaymentDate: 'not-a-date',
    });
    expect(r.rows[0].dueDate).toBe(today);
  });

  it('does not over-pay on the final period', () => {
    const r = buildAmortization({
      currentBalance: 250,
      annualInterestRate: 0,
      monthlyPayment: 100,
      firstPaymentDate: '2026-01-01',
    });
    // 100 + 100 + 50 = 250. The last row should be exactly 50, not 100.
    expect(r.rows.length).toBe(3);
    expect(r.rows[2].payment).toBeCloseTo(50, 8);
    expect(r.rows[2].remainingBalance).toBe(0);
    expect(r.totalPaid).toBeCloseTo(250, 8);
  });

  it('does not over-apply extraPerPeriod on the final period', () => {
    const r = buildAmortization({
      currentBalance: 250,
      annualInterestRate: 0,
      monthlyPayment: 100,
      extraPerPeriod: 100,
      firstPaymentDate: '2026-01-01',
    });
    // Period 1: 200 -> 50 remaining; period 2: pay only 50 total.
    expect(r.rows.length).toBe(2);
    expect(r.rows[1].payment).toBeCloseTo(50, 8);
    expect(r.totalPaid).toBeCloseTo(250, 8);
  });

  it('schedule due dates advance one month at a time across year boundary', () => {
    const r = buildAmortization({
      currentBalance: 400,
      annualInterestRate: 0,
      monthlyPayment: 100,
      firstPaymentDate: '2026-11-15',
    });
    expect(r.rows.map(x => x.dueDate)).toEqual([
      '2026-11-15',
      '2026-12-15',
      '2027-01-15',
      '2027-02-15',
    ]);
  });

  it('cumulativeInterest is monotonically non-decreasing', () => {
    const r = buildAmortization({
      currentBalance: 50_000,
      annualInterestRate: 0.07,
      remainingTermMonths: 60,
      firstPaymentDate: '2026-01-01',
    });
    for (let i = 1; i < r.rows.length; i++) {
      expect(r.rows[i].cumulativeInterest).toBeGreaterThanOrEqual(r.rows[i - 1].cumulativeInterest);
    }
    expect(r.totalInterest).toBeCloseTo(r.rows[r.rows.length - 1].cumulativeInterest, 8);
  });
});

describe('allocatePayment', () => {
  it('pays interest before principal', () => {
    // Balance $1000, APR 12% (1%/mo) => $10 interest
    const r = allocatePayment(100, 1000, 0.12);
    expect(r.interest).toBeCloseTo(10, 8);
    expect(r.principal).toBeCloseTo(90, 8);
    expect(r.fees).toBe(0);
    expect(r.remainingBalanceAfter).toBeCloseTo(910, 8);
  });

  it('deducts fees first, then interest, then principal', () => {
    const r = allocatePayment(100, 1000, 0.12, 25);
    // 100 - 25 fees = 75; 75 - 10 interest = 65 principal.
    expect(r.fees).toBe(25);
    expect(r.interest).toBeCloseTo(10, 8);
    expect(r.principal).toBeCloseTo(65, 8);
    expect(r.remainingBalanceAfter).toBeCloseTo(935, 8);
  });

  it('handles payment smaller than interest accrued', () => {
    // $5 payment vs $10 interest: all goes to interest, no principal.
    const r = allocatePayment(5, 1000, 0.12);
    expect(r.interest).toBeCloseTo(5, 8);
    expect(r.principal).toBe(0);
    expect(r.remainingBalanceAfter).toBe(1000);
  });

  it('caps principal at remaining balance (no over-payment)', () => {
    const r = allocatePayment(5000, 100, 0);
    expect(r.principal).toBe(100);
    expect(r.remainingBalanceAfter).toBe(0);
  });

  it('clamps negative fees to 0', () => {
    const r = allocatePayment(100, 1000, 0, -50);
    expect(r.fees).toBe(0);
    expect(r.principal).toBe(100);
  });

  it('handles zero balance gracefully', () => {
    const r = allocatePayment(100, 0, 0.12);
    expect(r.interest).toBe(0);
    expect(r.principal).toBe(0);
    expect(r.remainingBalanceAfter).toBe(0);
  });
});

describe('summarizeLiability', () => {
  it('computes payoffProgressPct from original vs current balance', () => {
    const s = summarizeLiability({
      currentBalance: 75_000,
      originalBalance: 100_000,
      annualRate: 0.05,
      remainingTermMonths: 240,
    });
    expect(s.payoffProgressPct).toBeCloseTo(25, 6);
  });

  it('clamps progress to [0, 100]', () => {
    const over = summarizeLiability({
      currentBalance: -10,
      originalBalance: 100,
      annualRate: 0,
      monthlyPayment: 100,
    });
    expect(over.payoffProgressPct).toBe(100);

    const under = summarizeLiability({
      currentBalance: 200, // owes more than original (rare, e.g. negative amortization)
      originalBalance: 100,
      annualRate: 0,
      monthlyPayment: 100,
    });
    expect(under.payoffProgressPct).toBe(0);
  });

  it('reports 0 progress when originalBalance is missing', () => {
    const s = summarizeLiability({
      currentBalance: 50_000,
      annualRate: 0.05,
      remainingTermMonths: 120,
    });
    expect(s.payoffProgressPct).toBe(0);
  });

  it('normalizes the annualRate field on output', () => {
    const s = summarizeLiability({
      currentBalance: 10_000,
      originalBalance: 10_000,
      annualRate: 5, // percent
      remainingTermMonths: 60,
    });
    expect(s.annualRate).toBeCloseTo(0.05, 10);
  });
});
