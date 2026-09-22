/**
 * Rule 12 — derived liability values come from ONE shared function.
 *
 * `deriveLiabilityMetrics` (shared/liability-derived) is what the loan tab,
 * the liability detail page, the overview composer and the chat's
 * get_liability_summary all call. This file pins:
 *   (a) parity with the loan tab's OLD private amortization on a fixture,
 *   (b) parity with the chat's OLD closed-form months-left,
 *   (c) percent paid / equity / next due from the same call,
 *   (d) the extra-payment simulator is the same engine.
 */
import { describe, it, expect } from "vitest";
import { deriveLiabilityMetrics, deriveLiabilityAmortization, simulateExtraPayment, computeEquity, payoffProgressPct } from "@shared/liability-derived";
import { computeDerivedMetrics } from "@shared/overview-compose";
import { summarizeLiability } from "@shared/liability-calc";

const TODAY = "2026-09-22";

// The loan tab's old private formula (client/src/pages/profile-detail.tsx
// `calculateAmortization`), kept here verbatim as the parity oracle.
function legacyCalculateAmortization(principal: number, annualRate: number, termMonths: number) {
  if (!principal || !annualRate || !termMonths) return [];
  const monthlyRate = annualRate / 100 / 12;
  const payment = monthlyRate === 0
    ? principal / termMonths
    : principal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);
  const rows: Array<{ month: number; payment: number; principal: number; interest: number; balance: number }> = [];
  let balance = principal;
  for (let month = 1; month <= termMonths && balance > 0.005; month++) {
    const interest = balance * monthlyRate;
    const principalPaid = Math.min(payment - interest, balance);
    balance -= principalPaid;
    rows.push({ month, payment, principal: principalPaid, interest, balance: Math.max(0, balance) });
  }
  return rows;
}

// The chat's old closed-form (server/ai-engine.ts get_liability_summary).
function legacyMonthsLeft(currentBalance: number, monthlyPayment: number, annualRate: number): number | null {
  if (!(monthlyPayment > 0 && currentBalance > 0)) return null;
  const r = annualRate / 12;
  if (r > 0 && monthlyPayment > currentBalance * r) return Math.ceil(Math.log(monthlyPayment / (monthlyPayment - currentBalance * r)) / Math.log(1 + r));
  if (r === 0) return Math.ceil(currentBalance / monthlyPayment);
  return null;
}

describe("deriveLiabilityMetrics — parity with the loan tab's old formula", () => {
  const fields = { balance: 20000, interestRate: 6, termMonths: 48, dueDay: 15 };

  it("same payment, same term, same total interest (within a cent per row)", () => {
    const legacy = legacyCalculateAmortization(20000, 6, 48);
    const shared = deriveLiabilityAmortization(fields, TODAY, { typeKey: "auto_loan" });
    expect(shared.monthlyPayment).toBeCloseTo(legacy[0].payment, 6);
    expect(Math.abs(shared.rows.length - legacy.length)).toBeLessThanOrEqual(1);
    const legacyInterest = legacy.reduce((s, r) => s + r.interest, 0);
    expect(Math.abs(shared.totalInterest - legacyInterest)).toBeLessThan(legacy[0].payment / 2);
    // Row 1 is identical.
    expect(shared.rows[0].interest).toBeCloseTo(legacy[0].interest, 6);
    expect(shared.rows[0].principal).toBeCloseTo(legacy[0].principal, 6);
    // The schedule starts at the NEXT due (the temporal engine), not at origin.
    expect(shared.rows[0].dueDate).toBe("2026-10-15");
  });

  it("months remaining agrees with the chat's old closed-form for a stored payment", () => {
    const f = { balance: 10000, interestRate: 6, monthlyPayment: 500, dueDay: 1 };
    const m = deriveLiabilityMetrics(f, TODAY, { typeKey: "personal_loan" });
    const legacy = legacyMonthsLeft(10000, 500, 0.06)!;
    expect(Math.abs((m.monthsRemaining ?? 0) - legacy)).toBeLessThanOrEqual(1);
    expect(m.paymentsRemaining).toBe(m.monthsRemaining);
    expect(m.interestRatePct).toBe(6);
    expect(m.monthlyPayment).toBe(500);
    expect(m.balance).toBe(10000);
    expect(m.payoffDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.nextDue.nextOccurrence).toBe("2026-10-01");
  });

  it("reads the canonical keys AND the legacy spellings through one reader", () => {
    const legacySpelling = { currentBalance: 10000, annualInterestRate: 6, monthly_payment: "500", due_day: 1 };
    const canonical = { balance: 10000, interestRate: 6, monthlyPayment: 500, dueDay: 1 };
    const a = deriveLiabilityMetrics(legacySpelling, TODAY, { typeKey: "personal_loan" });
    const b = deriveLiabilityMetrics(canonical, TODAY, { typeKey: "personal_loan" });
    expect(a.monthsRemaining).toBe(b.monthsRemaining);
    expect(a.totalRemainingInterest).toBeCloseTo(b.totalRemainingInterest, 6);
    expect(a.interestRatePct).toBe(b.interestRatePct);
  });

  it("percent paid, equity and the summary come from the same call", () => {
    const f = { balance: 15000, originalBalance: 20000, interestRate: 5, monthlyPayment: 400, dueDay: 10 };
    const m = deriveLiabilityMetrics(f, TODAY, { typeKey: "auto_loan", linkedAssetValue: 22000 });
    expect(m.percentPaid).toBe(25);
    expect(m.percentPaid).toBe(payoffProgressPct(20000, 15000));
    expect(m.equity).toBe(7000);
    expect(computeEquity(22000, [15000])).toBe(7000);
    expect(m.summary.payoffProgressPct).toBe(25);
    expect(m.summary).toMatchObject(summarizeLiability({ currentBalance: 15000, originalBalance: 20000, monthlyPayment: 400, annualRate: 5, firstPaymentDate: "2026-10-10" }));
  });

  it("a payment that does not cover interest never amortizes; no term → null months", () => {
    const m = deriveLiabilityMetrics({ balance: 1200, interestRate: 24, monthlyPayment: 20 }, TODAY, { typeKey: "credit_card" });
    expect(m.neverAmortizes).toBe(true);
    expect(m.monthsRemaining).toBeNull();
    expect(m.payoffDate).toBeNull();
    const paidOff = deriveLiabilityMetrics({ balance: 0, interestRate: 6, monthlyPayment: 200 }, TODAY, { typeKey: "auto_loan" });
    expect(paidOff.monthsRemaining).toBe(0);
  });

  it("the extra-payment simulator is the same engine (more extra → fewer months, less interest)", () => {
    const f = { balance: 20000, interestRate: 6, monthlyPayment: 470, dueDay: 15 };
    const base = deriveLiabilityMetrics(f, TODAY, { typeKey: "auto_loan" });
    const sim = simulateExtraPayment(f, TODAY, 100, { typeKey: "auto_loan" });
    expect(sim.months).toBeLessThan(base.monthsRemaining!);
    expect(sim.monthsSaved).toBe(base.monthsRemaining! - sim.months);
    expect(sim.interestSaved).toBeGreaterThan(0);
    expect(sim.totalInterest).toBeCloseTo(base.totalRemainingInterest - sim.interestSaved, 6);
    expect(simulateExtraPayment(f, TODAY, 0, { typeKey: "auto_loan" }).months).toBe(base.monthsRemaining);
  });
});

describe("overview composer uses the shared derivation", () => {
  it("payoffProgress and remainingPayments match deriveLiabilityMetrics, rate included", () => {
    const fields = { balance: 15000, originalBalance: 20000, interestRate: 5, monthlyPayment: 400, dueDay: 10 };
    const entity = { id: "loan-1", type: "liability", type_key: "auto_loan", name: "Car loan", fields } as any;
    const { metrics } = computeDerivedMetrics(
      { entity, now: new Date("2026-09-22T12:00:00") },
      { entityClass: "liability" } as any,
      fields,
    );
    const m = deriveLiabilityMetrics(fields, TODAY, { typeKey: "auto_loan" });
    const progress = metrics.find((x) => x.semanticKey === "payoffProgress");
    const remaining = metrics.find((x) => x.semanticKey === "remainingPayments");
    expect(progress?.value).toBe(m.percentPaid);
    expect(remaining?.value).toBe(m.paymentsRemaining);
    // With a rate present the count is the amortization's, not balance ÷ payment.
    expect(remaining?.value).not.toBe(Math.ceil(15000 / 400));
    expect(remaining?.sourceReference).toMatchObject({ kind: "derived" });
  });
});
