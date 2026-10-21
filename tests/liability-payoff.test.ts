// Payoff outlook views (shared/liability-payoff.ts). What it proves:
//   * the chart series and the split are read off the SAME schedule the page
//     prints (buildAmortization), so the totals match to the cent;
//   * a long schedule is thinned for a phone but keeps today and the payoff;
//   * a record without balance / rate / payment says what is missing instead
//     of drawing a guessed 360-month loan.
import { describe, it, expect } from "vitest";
import { buildAmortization } from "../shared/liability-calc";
import { payoffMissingFields, payoffSeries, principalInterestSplit } from "../shared/liability-payoff";

const loan = () => buildAmortization({
  currentBalance: 20000, annualInterestRate: 6, monthlyPayment: 469.70, firstPaymentDate: "2026-11-01",
});

describe("payoffSeries", () => {
  it("starts at today's balance and ends at zero on the payoff date", () => {
    const amo = loan();
    const s = payoffSeries(amo, { startBalance: 20000, todayISO: "2026-10-21" });
    expect(s[0]).toMatchObject({ date: "2026-10-21", paymentNumber: 0, balance: 20000, interestPaid: 0, principalPaid: 0 });
    const last = s[s.length - 1];
    expect(last.date).toBe(amo.payoffDate);
    expect(last.balance).toBeCloseTo(0, 2);
    expect(last.interestPaid).toBeCloseTo(amo.totalInterest, 6);
    expect(last.principalPaid).toBeCloseTo(20000, 2);
    expect(s.length).toBe(amo.rows.length + 1);
  });

  it("thins a 30-year schedule to the point budget, keeping both ends", () => {
    const amo = buildAmortization({ currentBalance: 300000, annualInterestRate: 6.5, remainingTermMonths: 360, firstPaymentDate: "2026-11-01" });
    const s = payoffSeries(amo, { startBalance: 300000, maxPoints: 60 });
    expect(s.length).toBe(60);
    expect(s[0].paymentNumber).toBe(0);
    expect(s[s.length - 1].paymentNumber).toBe(amo.rows.length);
    for (let i = 1; i < s.length; i++) expect(s[i].balance).toBeLessThanOrEqual(s[i - 1].balance);
  });

  it("draws nothing when the payment never covers the interest", () => {
    const amo = buildAmortization({ currentBalance: 20000, annualInterestRate: 24, monthlyPayment: 100 });
    expect(amo.neverAmortizes).toBe(true);
    expect(payoffSeries(amo, { startBalance: 20000 })).toEqual([]);
    expect(principalInterestSplit(amo)).toBeNull();
  });
});

describe("principalInterestSplit", () => {
  it("adds up to the schedule's own totals", () => {
    const amo = loan();
    const split = principalInterestSplit(amo)!;
    expect(split.interest).toBe(amo.totalInterest);
    expect(split.principal).toBeCloseTo(20000, 2);
    expect(split.total).toBeCloseTo(amo.totalPaid, 2);
    expect(split.interestPct).toBeGreaterThan(0);
    expect(split.interestPct).toBeLessThan(20);
  });

  it("counts extra principal as principal", () => {
    const amo = buildAmortization({ currentBalance: 20000, annualInterestRate: 6, monthlyPayment: 469.70, extraPerPeriod: 200 });
    expect(principalInterestSplit(amo)!.principal).toBeCloseTo(20000, 2);
  });
});

describe("payoffMissingFields", () => {
  it("is empty for a complete loan", () => {
    expect(payoffMissingFields({ balance: 20000, rateRaw: 6, monthlyPayment: 470 })).toEqual([]);
  });
  it("accepts a stored 0% rate and a term in place of a payment", () => {
    expect(payoffMissingFields({ balance: 5000, rateRaw: 0, monthlyPayment: 0, remainingTermMonths: 24 })).toEqual([]);
    expect(payoffMissingFields({ balance: 5000, rateRaw: "6.5%", monthlyPayment: 200 })).toEqual([]);
  });
  it("names every missing input", () => {
    expect(payoffMissingFields({ balance: 0, rateRaw: null, monthlyPayment: 0 }))
      .toEqual(["balance", "interest rate", "monthly payment"]);
    expect(payoffMissingFields({ balance: 1000, rateRaw: "", monthlyPayment: 50 })).toEqual(["interest rate"]);
  });
});
