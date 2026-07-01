import { describe, it, expect } from "vitest";
import {
  normalizeAnnualRate,
  computeAmortizedPayment,
  buildAmortization,
  allocatePayment,
  summarizeLiability,
} from "../shared/liability-calc";

// All money math should be deterministic + cross-platform. These tests pin
// the contract before we open it up to refactors.
//
// Pattern: most assertions use toBeCloseTo with 4-6 digits of precision to
// tolerate IEEE-754 drift but still catch real bugs.

describe("normalizeAnnualRate", () => {
  it("returns 0 for null/undefined/empty", () => {
    expect(normalizeAnnualRate(null)).toBe(0);
    expect(normalizeAnnualRate(undefined)).toBe(0);
    expect(normalizeAnnualRate("")).toBe(0);
  });

  it("returns 0 for NaN / non-numeric strings", () => {
    expect(normalizeAnnualRate("abc")).toBe(0);
    expect(normalizeAnnualRate(NaN)).toBe(0);
  });

  it("clamps negative rates to 0", () => {
    expect(normalizeAnnualRate(-0.05)).toBe(0);
    expect(normalizeAnnualRate("-2.5")).toBe(0);
  });

  it("keeps decimals <= 1 as-is", () => {
    expect(normalizeAnnualRate(0.065)).toBeCloseTo(0.065, 10);
    expect(normalizeAnnualRate(1)).toBe(1); // boundary — treated as decimal
    expect(normalizeAnnualRate(0)).toBe(0);
  });

  it("treats values >1 as percent and converts to decimal", () => {
    expect(normalizeAnnualRate(6.5)).toBeCloseTo(0.065, 10);
    expect(normalizeAnnualRate(25)).toBeCloseTo(0.25, 10);
    expect(normalizeAnnualRate(100)).toBeCloseTo(1.0, 10);
  });

  it("parses string inputs with % and whitespace", () => {
    expect(normalizeAnnualRate("6.5%")).toBeCloseTo(0.065, 10);
    expect(normalizeAnnualRate("  4.25 %  ")).toBeCloseTo(0.0425, 10);
    expect(normalizeAnnualRate("0.05")).toBeCloseTo(0.05, 10);
  });
});

describe("computeAmortizedPayment", () => {
  it("zero-rate loan splits balance evenly across months", () => {
    expect(computeAmortizedPayment(12000, 0, 12)).toBeCloseTo(1000, 6);
    expect(computeAmortizedPayment(10000, 0, 60)).toBeCloseTo(10000 / 60, 6);
  });

  it("matches a textbook mortgage example (200k, 6.5%, 360mo)", () => {
    // Canonical answer ≈ $1264.14
    const pmt = computeAmortizedPayment(200000, 0.065, 360);
    expect(pmt).toBeCloseTo(1264.14, 1);
  });

  it("accepts a percent-style rate (gets normalized)", () => {
    const decimal = computeAmortizedPayment(100000, 0.05, 240);
    const percent = computeAmortizedPayment(100000, 5, 240);
    expect(percent).toBeCloseTo(decimal, 6);
  });

  it("returns balance if months <= 0 (degenerate)", () => {
    expect(computeAmortizedPayment(5000, 0.05, 0)).toBe(5000);
    expect(computeAmortizedPayment(5000, 0.05, -3)).toBe(5000);
  });

  it("payment * months covers principal + interest above principal", () => {
    const balance = 50000;
    const months = 60;
    const pmt = computeAmortizedPayment(balance, 0.07, months);
    expect(pmt * months).toBeGreaterThan(balance);
  });
});

describe("buildAmortization", () => {
  it("zero-rate loan: 12 equal payments, no interest, balance to zero", () => {
    const res = buildAmortization({
      currentBalance: 12000,
      annualInterestRate: 0,
      remainingTermMonths: 12,
      firstPaymentDate: "2026-01-01",
    });
    expect(res.rows).toHaveLength(12);
    expect(res.totalInterest).toBeCloseTo(0, 6);
    expect(res.rows[res.rows.length - 1].remainingBalance).toBeCloseTo(0, 6);
    // Every payment is the same
    const first = res.rows[0].payment;
    for (const r of res.rows) expect(r.payment).toBeCloseTo(first, 6);
  });

  it("standard 30-year mortgage finishes in 360 rows", () => {
    const res = buildAmortization({
      currentBalance: 200000,
      annualInterestRate: 0.065,
      remainingTermMonths: 360,
      firstPaymentDate: "2026-01-01",
    });
    expect(res.payoffMonths).toBe(360);
    expect(res.rows[res.rows.length - 1].remainingBalance).toBeLessThan(0.01);
    // Total interest on a 200k/6.5%/30yr mortgage is ≈ $255,089
    expect(res.totalInterest).toBeGreaterThan(250_000);
    expect(res.totalInterest).toBeLessThan(260_000);
  });

  it("invariant: principal + interest + extra ≈ payment for every row", () => {
    const res = buildAmortization({
      currentBalance: 25000,
      annualInterestRate: 0.0599,
      remainingTermMonths: 60,
      extraPerPeriod: 50,
      firstPaymentDate: "2026-01-15",
    });
    for (const r of res.rows) {
      expect(r.principal + r.interest + r.extraPrincipal).toBeCloseTo(r.payment, 6);
    }
  });

  it("invariant: cumulativeInterest is non-decreasing and matches sum of interest", () => {
    const res = buildAmortization({
      currentBalance: 50000,
      annualInterestRate: 0.075,
      remainingTermMonths: 120,
      firstPaymentDate: "2026-01-01",
    });
    let sum = 0;
    for (const r of res.rows) {
      sum += r.interest;
      expect(r.cumulativeInterest).toBeCloseTo(sum, 4);
    }
    expect(res.totalInterest).toBeCloseTo(sum, 4);
  });

  it("invariant: remainingBalance decreases monotonically and ends at 0", () => {
    const res = buildAmortization({
      currentBalance: 18500,
      annualInterestRate: 0.0425,
      remainingTermMonths: 48,
      firstPaymentDate: "2026-01-01",
    });
    let prev = 18500;
    for (const r of res.rows) {
      expect(r.remainingBalance).toBeLessThanOrEqual(prev + 1e-6);
      prev = r.remainingBalance;
    }
    expect(prev).toBeLessThan(0.01);
  });

  it("extraPerPeriod accelerates payoff vs no extra", () => {
    const base = buildAmortization({
      currentBalance: 100000,
      annualInterestRate: 0.06,
      remainingTermMonths: 360,
    });
    const accel = buildAmortization({
      currentBalance: 100000,
      annualInterestRate: 0.06,
      remainingTermMonths: 360,
      extraPerPeriod: 200,
    });
    expect(accel.payoffMonths).toBeLessThan(base.payoffMonths);
    expect(accel.totalInterest).toBeLessThan(base.totalInterest);
  });

  it("safety cap: payment that never covers interest stops at SAFETY_MAX_PERIODS or earlier", () => {
    // $1 payment on a $50k loan at 12% — payment < monthly interest
    const res = buildAmortization({
      currentBalance: 50000,
      annualInterestRate: 0.12,
      monthlyPayment: 1,
      firstPaymentDate: "2026-01-01",
    });
    // The early-break "payment <= interest" kicks in after the first row.
    // What matters: we do NOT exceed the 600-row cap and do NOT hang.
    expect(res.rows.length).toBeLessThanOrEqual(600);
  });

  it("over-payment on final period clips to remaining balance (no negative balance)", () => {
    // Tiny balance, huge payment → must finish in 1 row with balance=0
    const res = buildAmortization({
      currentBalance: 100,
      annualInterestRate: 0.05,
      monthlyPayment: 10_000,
      firstPaymentDate: "2026-01-01",
    });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].remainingBalance).toBeCloseTo(0, 6);
    // Principal should not exceed the original balance
    expect(res.rows[0].principal).toBeLessThanOrEqual(100 + 1e-6);
  });

  it("month-end boundary: starts in Jan, dues march forward across year boundary", () => {
    const res = buildAmortization({
      currentBalance: 10000,
      annualInterestRate: 0.05,
      remainingTermMonths: 14,
      firstPaymentDate: "2026-01-31",
    });
    // setUTCMonth on Jan 31 + 1 month = March 3 in JS — pin that behavior
    // so a refactor to e.g. "set day to min(31, daysInMonth)" is a deliberate
    // breaking change, not silent.
    expect(res.rows[0].dueDate).toBe("2026-01-31");
    // Just assert we advance monotonically without throwing.
    let prev = res.rows[0].dueDate;
    for (let i = 1; i < res.rows.length; i++) {
      expect(res.rows[i].dueDate > prev).toBe(true);
      prev = res.rows[i].dueDate;
    }
  });

  it("invalid firstPaymentDate format falls back to today (string YYYY-MM-DD)", () => {
    const res = buildAmortization({
      currentBalance: 1000,
      annualInterestRate: 0,
      remainingTermMonths: 2,
      firstPaymentDate: "not-a-date",
    });
    expect(res.rows[0].dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses explicit monthlyPayment when supplied (ignoring remainingTermMonths)", () => {
    const res = buildAmortization({
      currentBalance: 12000,
      annualInterestRate: 0,
      monthlyPayment: 500,
      remainingTermMonths: 999, // should be ignored
      firstPaymentDate: "2026-01-01",
    });
    expect(res.monthlyPayment).toBe(500);
    expect(res.payoffMonths).toBe(24);
  });

  it("zero balance returns empty schedule, payoffDate = firstDate", () => {
    const res = buildAmortization({
      currentBalance: 0,
      annualInterestRate: 0.05,
      remainingTermMonths: 12,
      firstPaymentDate: "2026-01-01",
    });
    expect(res.rows).toHaveLength(0);
    expect(res.payoffMonths).toBe(0);
    expect(res.totalInterest).toBe(0);
    expect(res.payoffDate).toBe("2026-01-01");
  });

  it("negative balance coerced to 0", () => {
    const res = buildAmortization({
      currentBalance: -500,
      annualInterestRate: 0.05,
      remainingTermMonths: 12,
    });
    expect(res.rows).toHaveLength(0);
  });
});

describe("allocatePayment", () => {
  it("zero rate: full payment goes to principal", () => {
    const res = allocatePayment(500, 10000, 0);
    expect(res.interest).toBe(0);
    expect(res.principal).toBe(500);
    expect(res.fees).toBe(0);
    expect(res.remainingBalanceAfter).toBe(9500);
  });

  it("partial payment: interest is taken first, principal gets the remainder", () => {
    // 10000 balance @ 6% annual = $50/mo interest. Pay $200 → 50 interest + 150 principal.
    const res = allocatePayment(200, 10000, 0.06);
    expect(res.interest).toBeCloseTo(50, 6);
    expect(res.principal).toBeCloseTo(150, 6);
    expect(res.remainingBalanceAfter).toBeCloseTo(9850, 6);
  });

  it("fees come off the top before interest", () => {
    const res = allocatePayment(200, 10000, 0.06, /* fees */ 25);
    expect(res.fees).toBe(25);
    // 175 left after fees → 50 interest + 125 principal
    expect(res.interest).toBeCloseTo(50, 6);
    expect(res.principal).toBeCloseTo(125, 6);
    expect(res.remainingBalanceAfter).toBeCloseTo(9875, 6);
  });

  it("payment smaller than interest accrued: principal stays at 0", () => {
    // 10000 @ 12% = $100/mo interest. Pay only $40.
    const res = allocatePayment(40, 10000, 0.12);
    expect(res.interest).toBeCloseTo(40, 6);
    expect(res.principal).toBe(0);
    expect(res.remainingBalanceAfter).toBe(10000);
  });

  it("payment greater than balance + interest: principal clipped to balance, no negative", () => {
    const res = allocatePayment(50_000, 1000, 0.06);
    expect(res.principal).toBeLessThanOrEqual(1000);
    expect(res.remainingBalanceAfter).toBe(0);
  });

  it("negative fees and negative payments are floored at 0", () => {
    const res = allocatePayment(-100, 1000, 0.05, -10);
    expect(res.fees).toBe(0);
    expect(res.principal).toBe(0);
    expect(res.interest).toBe(0);
    expect(res.remainingBalanceAfter).toBe(1000);
  });

  it("accepts percent-style rate (>1 treated as percent)", () => {
    const a = allocatePayment(200, 10000, 0.06);
    const b = allocatePayment(200, 10000, 6); // 6%
    expect(b.interest).toBeCloseTo(a.interest, 6);
    expect(b.principal).toBeCloseTo(a.principal, 6);
  });

  it("decimal payments reduce the balance by the EXACT cents (user report: $0.17)", () => {
    // 0% rate so the whole payment is principal — the balance must drop by
    // exactly the decimal amount, not a float-drifted approximation.
    expect(allocatePayment(0.17, 60, 0).remainingBalanceAfter).toBe(59.83);
    expect(allocatePayment(12.34, 100, 0).remainingBalanceAfter).toBe(87.66);
    expect(allocatePayment(1234.56, 5000, 0).principal).toBe(1234.56);
    expect(allocatePayment(0.17, 60, 0).principal).toBe(0.17);
  });
});

describe("summarizeLiability", () => {
  it("computes progress percent from original vs current balance", () => {
    const s = summarizeLiability({
      currentBalance: 75000,
      originalBalance: 100000,
      annualRate: 0.05,
      remainingTermMonths: 240,
    });
    expect(s.payoffProgressPct).toBeCloseTo(25, 6);
  });

  it("progress is 0 when originalBalance missing or zero", () => {
    expect(
      summarizeLiability({
        currentBalance: 5000,
        annualRate: 0.05,
        remainingTermMonths: 60,
      }).payoffProgressPct,
    ).toBe(0);
  });

  it("progress is clamped to [0, 100]", () => {
    // currentBalance > originalBalance (e.g. capitalized interest)
    const over = summarizeLiability({
      currentBalance: 150,
      originalBalance: 100,
      annualRate: 0,
      remainingTermMonths: 12,
    });
    expect(over.payoffProgressPct).toBe(0);

    // Negative current balance — refunded loan
    const neg = summarizeLiability({
      currentBalance: -50,
      originalBalance: 100,
      annualRate: 0,
      remainingTermMonths: 12,
    });
    expect(neg.payoffProgressPct).toBe(100);
  });

  it("exposes normalized rate (percent input → decimal)", () => {
    const s = summarizeLiability({
      currentBalance: 10000,
      annualRate: 6.5, // percent
      remainingTermMonths: 60,
    });
    expect(s.annualRate).toBeCloseTo(0.065, 10);
  });

  it("monthlyPayment reflects supplied payment when given", () => {
    const s = summarizeLiability({
      currentBalance: 12000,
      annualRate: 0,
      monthlyPayment: 1000,
    });
    expect(s.monthlyPayment).toBe(1000);
    expect(s.remainingMonths).toBe(12);
  });
});
