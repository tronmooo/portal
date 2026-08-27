// unpayBillOccurrence — the exact inverse of payBillOccurrence.
//
// The retired "undo" was a bare payment-row delete: the occurrence stayed
// stamped paid forever, the due date stayed advanced, the debt balance stayed
// reduced, the account debit survived, and the logged expense lived on. These
// tests pin the round-trip: pay → unpay returns the liability, the account and
// the expense ledger to their pre-pay state.
import { describe, it, expect } from "vitest";
import { payBillOccurrence, unpayBillOccurrence } from "../server/liability-payments";

// Same double as tests/bill-payment-op.test.ts (kept local so each file reads
// standalone; the shape is 60 lines).
function fakeStorage(seed: any[]) {
  const profiles = new Map<string, any>(seed.map(p => [p.id, JSON.parse(JSON.stringify(p))]));
  const expenses: any[] = [];
  let payments: any[] = [];
  let paySeq = 0;
  const storage: any = {
    expenses,
    get payments() { return payments; },
    getProfile: async (id: string) => profiles.get(id),
    updateProfile: async (id: string, patch: any) => {
      const p = profiles.get(id);
      if (!p) return undefined;
      const fields = { ...(p.fields || {}) };
      for (const [k, v] of Object.entries(patch.fields || {})) {
        if (v === null || v === undefined) delete fields[k];
        else fields[k] = v;
      }
      const next = { ...p, ...patch, fields };
      profiles.set(id, next);
      return next;
    },
    createLiabilityPayment: async (data: any) => {
      const row = { id: `pay-${++paySeq}`, createdAt: new Date(2026, 0, paySeq).toISOString(), ...data };
      payments = [row, ...payments];
      return row;
    },
    getLiabilityPayments: async (_id: string) => [...payments],
    deleteLiabilityPayment: async (id: string) => {
      const before = payments.length;
      payments = payments.filter(p => p.id !== id);
      return payments.length < before;
    },
    adjustAccountBalance: async (id: string, input: any) => {
      const p = profiles.get(id);
      if (!p) return undefined;
      const f = { ...(p.fields || {}) };
      f.balance = (Number(f.balance) || 0) + (Number(input.delta) || 0);
      profiles.set(id, { ...p, fields: f });
      return profiles.get(id);
    },
    createExpense: async (data: any) => {
      const row = { id: `exp-${expenses.length + 1}`, tags: [], linkedProfiles: [], ...data };
      expenses.push(row);
      return row;
    },
    getExpenses: async () => expenses.filter(e => !e.deletedAt),
    deleteExpense: async (id: string) => {
      const e = expenses.find(x => x.id === id);
      if (!e) return false;
      e.deletedAt = new Date().toISOString();
      return true;
    },
    updateOccurrenceOverride: async (id: string, date: string, patch: any) => {
      const p = profiles.get(id);
      if (!p) return null;
      const f = { ...(p.fields || {}) };
      const occ = { ...(f.occurrences || {}) };
      const merged: any = { ...(occ[date] || {}), ...patch };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      occ[date] = merged;
      f.occurrences = occ;
      profiles.set(id, { ...p, fields: f });
      return { id, occurrences: occ };
    },
  };
  return storage;
}

const BILL = {
  id: "bill-1", name: "Internet", type: "liability", type_key: "internet",
  fields: { amount: 60, frequency: "monthly", dueDate: "2026-08-01" },
};

const CAR_LOAN = {
  id: "loan-1", name: "Car loan", type: "liability", type_key: "auto_loan",
  fields: { currentBalance: 10_000, annualInterestRate: 6, monthlyPayment: 400 },
};

const CHECKING = {
  id: "acct-1", name: "Checking", type: "account", type_key: "checking",
  fields: { accountKind: "checking", balance: 1_000 },
};

describe("unpayBillOccurrence — pay → unpay restores the pre-pay state", () => {
  it("reverses every side effect of paying a bill from an account", async () => {
    const storage = fakeStorage([BILL, CHECKING]);
    const paid = await payBillOccurrence(storage, "bill-1", {
      occurrenceDate: "2026-08-01", accountId: "acct-1", source: "route",
    }, "UTC");
    expect(paid.ok).toBe(true);
    expect((await storage.getProfile("bill-1")).fields.dueDate).toBe("2026-09-01");
    expect((await storage.getProfile("acct-1")).fields.balance).toBe(940);

    const undone = await unpayBillOccurrence(storage, "bill-1", { source: "route" }, "UTC");
    expect(undone.ok).toBe(true);
    expect(undone.deletedPaymentId).toBe(paid.payment.id);

    const bill = await storage.getProfile("bill-1");
    // Occurrence back to unpaid — no dangling paymentId.
    expect(bill.fields.occurrences["2026-08-01"].status).toBeUndefined();
    expect(bill.fields.occurrences["2026-08-01"].paymentId).toBeUndefined();
    expect(undone.occurrenceCleared).toBe(true);
    // Due date rolled back to the occurrence.
    expect(undone.dueDateRolledBack).toBe(true);
    expect(bill.fields.dueDate).toBe("2026-08-01");
    // No payments left → no lastPaidDate.
    expect(bill.fields.lastPaidDate).toBeUndefined();
    // Account credited back.
    expect(undone.accountCredited).toBe(true);
    expect((await storage.getProfile("acct-1")).fields.balance).toBe(1_000);
    // The logged expense is retracted.
    expect(undone.expenseDeleted).toBe(true);
    expect(await storage.getExpenses()).toHaveLength(0);
    // The row is gone.
    expect(await storage.getLiabilityPayments("bill-1")).toHaveLength(0);
  });

  it("restores a loan's balance from the deleted row's principal", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    const paid = await payBillOccurrence(storage, "loan-1", { amount: 400, source: "route" }, "UTC");
    expect(paid.ok).toBe(true);
    expect((await storage.getProfile("loan-1")).fields.currentBalance).toBeCloseTo(9_650, 2);

    const undone = await unpayBillOccurrence(storage, "loan-1", { paymentId: paid.payment.id, source: "ai" }, "UTC");
    expect(undone.ok).toBe(true);
    expect(undone.balanceRestored).toBe(true);
    const loan = await storage.getProfile("loan-1");
    expect(loan.fields.currentBalance).toBeCloseTo(10_000, 2);
    expect(loan.fields.remainingBalance).toBeCloseTo(10_000, 2);
    expect(loan.fields.loanBalance).toBeCloseTo(10_000, 2);
  });

  it("unpays a LEGACY payment that has no occurrence override", async () => {
    // Bills paid through the retired payObligation path have a payment row and
    // an advanced due date, but no stamp. The inverse must still work.
    const bill = JSON.parse(JSON.stringify(BILL));
    bill.fields.dueDate = "2026-09-01"; // already advanced by the legacy pay
    bill.fields.lastPaidDate = "2026-08-01";
    const storage = fakeStorage([bill]);
    await storage.createLiabilityPayment({
      liabilityProfileId: "bill-1", paymentDate: "2026-08-01", amount: 60,
      principalPortion: 60, interestPortion: 0, paymentType: "standard",
    });

    const undone = await unpayBillOccurrence(storage, "bill-1", { source: "route" }, "UTC");
    expect(undone.ok).toBe(true);
    expect(undone.occurrenceCleared).toBe(false); // nothing was stamped
    // The advance is still recognized (Sep 1 is one cycle from Aug 1) and rolled back.
    expect(undone.dueDateRolledBack).toBe(true);
    expect((await storage.getProfile("bill-1")).fields.dueDate).toBe("2026-08-01");
  });

  it("leaves the due date alone when the series was edited since the payment", async () => {
    const bill = JSON.parse(JSON.stringify(BILL));
    bill.fields.dueDate = "2026-10-15"; // user moved the series after paying
    const storage = fakeStorage([bill]);
    await storage.createLiabilityPayment({
      liabilityProfileId: "bill-1", paymentDate: "2026-08-01", amount: 60, principalPortion: 60,
    });
    const undone = await unpayBillOccurrence(storage, "bill-1", { source: "route" }, "UTC");
    expect(undone.ok).toBe(true);
    expect(undone.dueDateRolledBack).toBe(false);
    expect((await storage.getProfile("bill-1")).fields.dueDate).toBe("2026-10-15");
  });

  it("refuses when there is nothing to undo", async () => {
    const storage = fakeStorage([BILL]);
    const undone = await unpayBillOccurrence(storage, "bill-1", { source: "route" }, "UTC");
    expect(undone.ok).toBe(false);
    expect(undone.reason).toBe("no_payment");
  });
});
