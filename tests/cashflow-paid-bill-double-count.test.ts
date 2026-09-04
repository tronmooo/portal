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
import { payBillOccurrence } from "../server/liability-payments";
import { toMonthlyAmount } from "@shared/obligation-windows";
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

// ── The seam: what the pay pipeline WRITES vs what the split READS ───────────
//
// The two halves of this fix live in different files — payBillOccurrence tags
// the expense, the snapshot splits on that tag. A rename on either side would
// silently restore the double count with every unit test above still green, so
// run the REAL pay operation and feed its REAL expense through the REAL split.

/** Minimal storage double, same shape tests/bill-payment-op.test.ts uses. */
function fakeStorage(seed: any[]) {
  const profiles = new Map<string, any>(seed.map((p) => [p.id, JSON.parse(JSON.stringify(p))]));
  const expenses: any[] = [];
  let paySeq = 0;
  const storage: any = {
    expenses,
    getProfile: async (id: string) => profiles.get(id),
    updateProfile: async (id: string, patch: any) => {
      const p = profiles.get(id);
      if (!p) return undefined;
      const fields = { ...(p.fields || {}) };
      for (const [k, v] of Object.entries(patch.fields || {})) {
        if (v === null || v === undefined) delete fields[k];
        else fields[k] = v;
      }
      profiles.set(id, { ...p, ...patch, fields });
      return profiles.get(id);
    },
    createLiabilityPayment: async (data: any) => ({ id: `pay-${++paySeq}`, ...data }),
    getLiabilityPayments: async () => [],
    createExpense: async (data: any) => {
      const row = { id: `exp-${expenses.length + 1}`, tags: [], linkedProfiles: [], ...data };
      expenses.push(row);
      return row;
    },
    getExpenses: async () => expenses,
    updateOccurrenceOverride: async (id: string, date: string, patch: any) => {
      const p = profiles.get(id);
      if (!p) return null;
      const f = { ...(p.fields || {}) };
      f.occurrences = { ...(f.occurrences || {}), [date]: { ...((f.occurrences || {})[date] || {}), ...patch } };
      profiles.set(id, { ...p, fields: f });
      return { id, occurrences: f.occurrences };
    },
  };
  return storage;
}

// The user's bill: $10/month phone, category "general" (what the screenshot
// showed under Money out), due the 1st.
const PHONE_BILL = {
  id: "bill-phone", name: "Phone", type: "liability", type_key: "subscription",
  parentProfileId: "person-1",
  fields: { amount: 10, frequency: "monthly", dueDate: "2026-09-01", category: "general" },
};

describe("paying the phone bill early leaves cash flow at −$10", () => {
  it("the expense the pay pipeline writes is the one the split excludes", async () => {
    const storage = fakeStorage([PHONE_BILL]);
    // Paid on Aug 28 — EARLY, four days before it is due.
    const out = await payBillOccurrence(
      storage, "bill-phone",
      { occurrenceDate: "2026-09-01", paymentDate: "2026-08-28", source: "route" },
      "UTC",
    );
    expect(out.ok).toBe(true);
    expect(out.expenseId).toBeTruthy();

    const logged = storage.expenses;
    expect(logged).toHaveLength(1);
    expect(logged[0].amount).toBe(10);
    // The tag vocabulary is shared, so this is the actual join, not a copy.
    expect(isBillPaymentExpense(logged[0])).toBe(true);

    // Paying early does NOT retire the bill — it is still a monthly obligation.
    const bill = await storage.getProfile("bill-phone");
    expect(bill.fields.dueDate).toBe("2026-10-01");
    const recurringOut = toMonthlyAmount(bill.fields.amount, bill.fields.frequency);
    expect(recurringOut).toBe(10);

    // Now the snapshot the client reads, built the way the storage layer
    // builds it from that same expense list.
    const snapshot = {
      totalMonthlySpend: logged.reduce((s, e) => s + e.amount, 0),
      oneTimeSpend: oneTimeExpenses(logged).reduce((s, e) => s + e.amount, 0),
      billPaymentSpend: billPaymentTotal(logged),
      monthlyObligationTotal: recurringOut,
    };
    expect(snapshot.totalMonthlySpend).toBe(10); // budgets still see it
    expect(snapshot.oneTimeSpend).toBe(0);       // cash flow does not
    expect(cashOutOf(snapshot)).toBe(10);        // …once, as RECURRING
    expect(0 - cashOutOf(snapshot)).toBe(-10);   // the number on the card
  });
});
