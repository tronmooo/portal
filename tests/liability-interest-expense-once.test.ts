// One month's interest is ONE interest expense (L5, A4).
//
// QA 2026-11-24 (Finance tab, bug 10): two expense rows showed the same
// "Honda Civic Loan — interest & fees" charge, both dated November 20, both
// $129.09. Each was the interest expense of its own payment row: the month's
// interest had been charged on two payments.
//
//  · A caller that SPLITS the payment (the chat's add_liability_payment passes
//    the schedule's interest on every call; the amortization "mark paid" row
//    carries its interest) bypassed the once-a-month rule entirely — only the
//    engine's own split checked it.
//  · Two payments in flight together each read the ledger before the other's
//    row landed, so both charged the month's interest — from the same balance,
//    so the same amount.
//
// Drives the real payBillOccurrence (the one pay operation every door uses)
// against a ledger double with the storage's per-user lock.

import { describe, it, expect } from "vitest";
import { payBillOccurrence } from "../server/liability-payments";

const tick = () => new Promise((r) => setTimeout(r, 5));

function world() {
  let liability: any = {
    id: "liab-civic", name: "Honda Civic Loan", type: "liability", type_key: "auto_loan",
    parentProfileId: "p-self",
    fields: { currentBalance: 23_000, interestRate: 6.735, _interestRateUnit: "percent", monthlyPayment: 450, dueDay: 20, dueDate: "2026-11-20" },
  };
  const payments: any[] = [];
  const expenses: any[] = [];
  const locks = new Map<string, number>();
  let seq = 0;
  const storage: any = {
    getProfile: async (id: string) => { await tick(); return id === liability.id ? JSON.parse(JSON.stringify(liability)) : undefined; },
    updateProfile: async (_id: string, patch: any) => {
      await tick();
      liability = { ...liability, ...patch, fields: { ...liability.fields, ...(patch.fields || {}) } };
      return liability;
    },
    getLiabilityPayments: async (id: string) => { await tick(); return payments.filter((p) => p.liabilityProfileId === id).map((p) => ({ ...p })); },
    createLiabilityPayment: async (data: any) => { await tick(); const row = { id: data.id || `pay-${++seq}`, ...data }; payments.push(row); return row; },
    getLiabilityProfileLinks: async () => [],
    getExpenses: async () => { await tick(); return expenses.map((e) => ({ ...e })); },
    createExpense: async (data: any) => { await tick(); const row = { id: `exp-${++seq}`, ...data }; expenses.push(row); return row; },
    deleteExpense: async (id: string) => { const i = expenses.findIndex((e) => e.id === id); if (i >= 0) expenses.splice(i, 1); return i >= 0; },
    getTasks: async () => [],
    acquireUserLock: async (name: string, ttl: number) => {
      const until = locks.get(name);
      if (until && until > Date.now()) return false;
      locks.set(name, Date.now() + ttl);
      return true;
    },
    releaseUserLock: async (name: string) => { locks.delete(name); },
  };
  return { storage, payments, expenses, balance: () => Number(liability.fields.currentBalance) };
}

const interestExpenses = (expenses: any[]) => expenses.filter((e) => (e.tags || []).includes("loan-interest"));

describe("a loan's interest is charged, and logged as an expense, once a month", () => {
  it("a second payment that names its interest (the chat's split) is not charged the month's interest again", async () => {
    const w = world();
    const first = await payBillOccurrence(w.storage, "liab-civic", { amount: 450, paymentDate: "2026-11-20", interest: 129.09, source: "ai" }, "UTC");
    expect(first.ok).toBe(true);
    // A minute later the user says it again with a different amount — a real
    // second payment (L5), not the model's double call.
    const second = await payBillOccurrence(w.storage, "liab-civic", { amount: 300, paymentDate: "2026-11-20", interest: 129.09, source: "ai" }, "UTC");
    expect(second.ok).toBe(true);

    expect(w.payments).toHaveLength(2);
    expect(w.payments.map((p) => p.interestPortion)).toEqual([129.09, 0]);
    // The money still left: the named interest went to principal.
    expect(w.payments[1].principalPortion).toBe(300);
    const logged = interestExpenses(w.expenses);
    expect(logged).toHaveLength(1);
    expect(logged[0].amount).toBe(129.09);
    expect(w.balance()).toBeCloseTo(23_000 - (450 - 129.09) - 300, 2);
  });

  it("two payments in flight together charge the month's interest once", async () => {
    const w = world();
    const [a, b] = await Promise.all([
      payBillOccurrence(w.storage, "liab-civic", { amount: 450, paymentDate: "2026-11-20", source: "route" }, "UTC"),
      payBillOccurrence(w.storage, "liab-civic", { amount: 200, paymentDate: "2026-11-20", occurrenceDate: "2026-12-20", source: "route" }, "UTC"),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(w.payments).toHaveLength(2);
    const charged = w.payments.filter((p) => Number(p.interestPortion) > 0);
    expect(charged).toHaveLength(1);
    expect(interestExpenses(w.expenses)).toHaveLength(1);
    // Both payments moved the balance (neither planned from a stale one).
    const principal = w.payments.reduce((s, p) => s + Number(p.principalPortion), 0);
    expect(w.balance()).toBeCloseTo(23_000 - principal, 2);
  });

  it("the next month's payment is charged its own interest", async () => {
    const w = world();
    await payBillOccurrence(w.storage, "liab-civic", { amount: 450, paymentDate: "2026-11-20", source: "route" }, "UTC");
    await payBillOccurrence(w.storage, "liab-civic", { amount: 450, paymentDate: "2026-12-20", source: "route" }, "UTC");
    expect(interestExpenses(w.expenses)).toHaveLength(2);
    expect(new Set(interestExpenses(w.expenses).map((e) => e.date))).toEqual(new Set(["2026-11-20", "2026-12-20"]));
  });
});
