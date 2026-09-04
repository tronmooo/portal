// ── D-CASHFLOW-DOUBLE — a paid recurring bill must be counted ONCE ───────────
//
// User report (2026-09): "I created a phone bill and it said −$10. I marked the
// phone bill paid and now it says one-time $10 as well — so it's −$20, even
// though it's the same bill." Paying a recurring bill logs an expense
// (payBillOccurrence step 4) so budgets see the money leave; that expense then
// also landed in the cash-flow one-time bucket, on top of the bill's own
// monthly obligation total. Marking a bill paid made the month look twice as
// expensive.
//
// The split lives in shared/bill-payment-expense.ts and every cash-flow surface
// reads it, so these assertions guard the arithmetic all of them share.
import { describe, it, expect } from "vitest";
import {
  BILL_PAYMENT_TAG,
  isBillPaymentExpense,
  oneTimeExpenses,
  billPaymentTotal,
  oneTimeSpendOf,
  oneTimeSpendByCategoryOf,
  cashOutOf,
} from "@shared/bill-payment-expense";

// What payBillOccurrence writes when the $10 phone bill is marked paid.
const phoneBillPayment = {
  amount: 10,
  category: "general",
  description: "Phone — 2026-09-01",
  tags: [BILL_PAYMENT_TAG, "liability:phone", "payment:pay_1"],
};
// A genuine one-time purchase in the same month.
const coffee = { amount: 4, category: "food", tags: [] as string[] };

describe("bill-payment expenses are not one-time spend", () => {
  it("recognises the expense a bill payment logged", () => {
    expect(isBillPaymentExpense(phoneBillPayment)).toBe(true);
    expect(isBillPaymentExpense(coffee)).toBe(false);
    // The payment:<id> tag alone is enough — it is the ledger join key.
    expect(isBillPaymentExpense({ tags: ["payment:pay_2"] })).toBe(true);
    // Untagged and malformed expenses are ordinary spending, never dropped.
    expect(isBillPaymentExpense({})).toBe(false);
    expect(isBillPaymentExpense(null)).toBe(false);
    expect(isBillPaymentExpense({ tags: "bill-payment" as any })).toBe(false);
  });

  it("splits a month's expenses into bill payments and one-time spend", () => {
    const month = [phoneBillPayment, coffee];
    expect(billPaymentTotal(month)).toBe(10);
    expect(oneTimeExpenses(month)).toEqual([coffee]);
  });
});

describe("cash flow counts a paid recurring bill exactly once", () => {
  // The user's exact scenario: one $10/month phone bill, no income, nothing
  // else logged.
  const unpaid = {
    totalMonthlySpend: 0,
    oneTimeSpend: 0,
    billPaymentSpend: 0,
    spendByCategory: {},
    oneTimeSpendByCategory: {},
    monthlyObligationTotal: 10,
  };
  const afterPaying = {
    totalMonthlySpend: 10,           // the payment's expense — budgets see it
    oneTimeSpend: 0,                 // …but it is not one-time spending
    billPaymentSpend: 10,
    spendByCategory: { general: 10 },
    oneTimeSpendByCategory: {},
    monthlyObligationTotal: 10,
  };

  it("shows −$10 before the bill is paid", () => {
    expect(cashOutOf(unpaid)).toBe(10);
    expect(0 - cashOutOf(unpaid)).toBe(-10);
  });

  it("still shows −$10 after the bill is marked paid", () => {
    expect(oneTimeSpendOf(afterPaying)).toBe(0);
    expect(cashOutOf(afterPaying)).toBe(10);
    expect(0 - cashOutOf(afterPaying)).toBe(-10);
  });

  it("keeps the paid bill out of the money-out category list", () => {
    // The popup listed "Recurring $10" AND "General $10" for the one bill.
    expect(oneTimeSpendByCategoryOf(afterPaying)).toEqual({});
    // The whole-month map is untouched, so budgets and the Spend card still
    // see the money that actually left.
    expect(afterPaying.spendByCategory).toEqual({ general: 10 });
  });

  it("still counts genuine one-time spending on top of the bill", () => {
    const withCoffee = { ...afterPaying, totalMonthlySpend: 14, oneTimeSpend: 4, oneTimeSpendByCategory: { food: 4 } };
    expect(cashOutOf(withCoffee)).toBe(14);
  });

  it("falls back sanely for a snapshot cached before the split existed", () => {
    // No oneTimeSpend field: derive it from the bill-payment total when there
    // is one, and otherwise keep the pre-fix reading rather than showing $0.
    expect(oneTimeSpendOf({ totalMonthlySpend: 14, billPaymentSpend: 10 })).toBe(4);
    expect(oneTimeSpendOf({ totalMonthlySpend: 14 })).toBe(14);
    expect(oneTimeSpendOf(undefined)).toBe(0);
    expect(cashOutOf({ totalMonthlySpend: 14, monthlyObligationTotal: 10 })).toBe(24);
  });
});
