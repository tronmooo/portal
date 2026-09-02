// payBillOccurrence — the ONE entry-point-facing pay operation.
//
// Before it existed there were six implementations of "this bill got paid",
// each with a different side-effect subset (occurrence stamp / due-date
// advance / balance move / account debit / expense — pick some). These tests
// pin the full canonical side-effect set so no entry point can drift back to
// a partial one.
import { describe, it, expect } from "vitest";
import { payBillOccurrence } from "../server/liability-payments";

/** Storage double: profiles in a map, every write recorded. */
function fakeStorage(seed: any[]) {
  const profiles = new Map<string, any>(seed.map(p => [p.id, JSON.parse(JSON.stringify(p))]));
  const writes: any[] = [];
  const expenses: any[] = [];
  let payments: any[] = [];
  let paySeq = 0;
  const storage: any = {
    writes, expenses,
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
      writes.push(["updateProfile", id, patch]);
      return next;
    },
    createLiabilityPayment: async (data: any) => {
      const row = { id: `pay-${++paySeq}`, ...data };
      payments = [row, ...payments];
      writes.push(["createLiabilityPayment", row]);
      return row;
    },
    getLiabilityPayments: async (_id: string) => payments,
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
      writes.push(["adjustAccountBalance", id, input]);
      return profiles.get(id);
    },
    createExpense: async (data: any) => {
      const row = { id: `exp-${expenses.length + 1}`, tags: [], linkedProfiles: [], ...data };
      expenses.push(row);
      writes.push(["createExpense", row]);
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
      writes.push(["updateOccurrenceOverride", id, date, patch]);
      return { id, occurrences: occ };
    },
  };
  return storage;
}

const USAGE_BILL = {
  id: "bill-1", name: "ChatGPT", type: "liability", type_key: "subscription",
  parentProfileId: "person-1",
  fields: {
    amount: 20, frequency: "monthly", dueDate: "2026-08-01",
    billingModel: "usage_based",
    occurrences: { "2026-08-01": { charges: [{ id: "c1", kind: "usage", amount: 22 }] } },
  },
};

const CAR_LOAN = {
  id: "loan-1", name: "Car loan", type: "liability", type_key: "auto_loan",
  fields: { currentBalance: 10_000, annualInterestRate: 6, monthlyPayment: 400, dueDate: "2026-08-15" },
};

const CHECKING = {
  id: "acct-1", name: "Checking", type: "account", type_key: "checking",
  fields: { accountKind: "checking", balance: 1_000 },
};

describe("payBillOccurrence — full canonical side-effect set", () => {
  it("settles a usage bill's REAL total when no amount is given", async () => {
    // The definition says $20; August's usage says $42. The autopay cron and
    // the obligation route used to log the base price.
    const storage = fakeStorage([USAGE_BILL]);
    const out = await payBillOccurrence(storage, "bill-1", { occurrenceDate: "2026-08-01", source: "route" }, "UTC");
    expect(out.ok).toBe(true);
    expect(out.amount).toBe(42);
    expect(out.payment.amount).toBe(42);
  });

  it("stamps the occurrence, advances the due date from the OCCURRENCE date, and logs the expense", async () => {
    const storage = fakeStorage([USAGE_BILL]);
    const out = await payBillOccurrence(storage, "bill-1", {
      occurrenceDate: "2026-08-01", paymentDate: "2026-08-20", source: "route",
    }, "UTC");
    const bill = await storage.getProfile("bill-1");
    const ov = bill.fields.occurrences["2026-08-01"];
    expect(ov.status).toBe("paid");
    expect(ov.paymentId).toBe(out.payment.id);
    expect(ov.paidAmount).toBe(42);
    // Paid 19 days late: next due is Sep 1 (one cycle from the occurrence),
    // NOT Sep 20 — the today-anchored advance is the retired policy.
    expect(out.dueDateAdvanced).toBe(true);
    expect(bill.fields.dueDate).toBe("2026-09-01");
    expect(bill.fields.lastPaidDate).toBe("2026-08-20");
    // The payment is real spending: budgets see it, keyed for the inverse.
    expect(out.expenseId).toBeTruthy();
    const exp = storage.expenses[0];
    expect(exp.amount).toBe(42);
    expect(exp.tags).toContain("bill-payment");
    expect(exp.tags).toContain(`payment:${out.payment.id}`);
    expect(exp.linkedProfiles).toEqual(["person-1"]);
  });

  it("does NOT advance the series when paying a past (non-current-due) occurrence", async () => {
    const bill = JSON.parse(JSON.stringify(USAGE_BILL));
    bill.fields.dueDate = "2026-09-01"; // August already rolled past
    const storage = fakeStorage([bill]);
    const out = await payBillOccurrence(storage, "bill-1", { occurrenceDate: "2026-08-01", source: "route" }, "UTC");
    expect(out.ok).toBe(true);
    expect(out.dueDateAdvanced).toBe(false);
    expect((await storage.getProfile("bill-1")).fields.dueDate).toBe("2026-09-01");
  });

  it("honors autoLogExpense:false", async () => {
    const bill = JSON.parse(JSON.stringify(USAGE_BILL));
    bill.fields.autoLogExpense = false;
    const storage = fakeStorage([bill]);
    const out = await payBillOccurrence(storage, "bill-1", { occurrenceDate: "2026-08-01", source: "route" }, "UTC");
    expect(out.ok).toBe(true);
    expect(out.expenseId).toBeNull();
    expect(storage.expenses).toHaveLength(0);
  });

  it("moves a loan's balance under every field name — and logs NO expense", async () => {
    const storage = fakeStorage([CAR_LOAN]);
    const out = await payBillOccurrence(storage, "loan-1", {
      amount: 400, occurrenceDate: "2026-08-15", source: "ai",
    }, "UTC");
    expect(out.ok).toBe(true);
    expect(out.recurring).toBe(false);
    const loan = await storage.getProfile("loan-1");
    expect(loan.fields.currentBalance).toBeCloseTo(9_650, 2);
    expect(loan.fields.remainingBalance).toBeCloseTo(9_650, 2);
    expect(loan.fields.loanBalance).toBeCloseTo(9_650, 2);
    // The occurrence is stamped for loans too — the schedule card agrees.
    expect(loan.fields.occurrences["2026-08-15"].status).toBe("paid");
    // Principal is not consumption.
    expect(storage.expenses).toHaveLength(0);
  });

  it("debits the source account, linked to the payment row", async () => {
    const storage = fakeStorage([USAGE_BILL, CHECKING]);
    const out = await payBillOccurrence(storage, "bill-1", {
      occurrenceDate: "2026-08-01", accountId: "acct-1", source: "occurrence_route",
    }, "UTC");
    expect(out.accountAdjusted).toBe(true);
    expect((await storage.getProfile("acct-1")).fields.balance).toBe(1_000 - 42);
    const adj = storage.writes.find((w: any[]) => w[0] === "adjustAccountBalance");
    expect(adj[2].linkedRecordId).toBe(out.payment.id);
    expect((await storage.getProfile("bill-1")).fields.occurrences["2026-08-01"].accountId).toBe("acct-1");
  });

  it("reports a failed best-effort step instead of swallowing it", async () => {
    const storage = fakeStorage([USAGE_BILL]);
    storage.createExpense = async () => { throw new Error("expenses table is on fire"); };
    const out = await payBillOccurrence(storage, "bill-1", { occurrenceDate: "2026-08-01", source: "route" }, "UTC");
    expect(out.ok).toBe(true); // the ledger row exists; the pay happened
    const step = out.steps.find(s => s.step === "expense");
    expect(step?.ok).toBe(false);
    expect(step?.error).toContain("on fire");
  });

  it("aborts cleanly when the ledger write itself fails", async () => {
    const storage = fakeStorage([USAGE_BILL]);
    storage.createLiabilityPayment = async () => { throw new Error("db down"); };
    const out = await payBillOccurrence(storage, "bill-1", { occurrenceDate: "2026-08-01", source: "route" }, "UTC");
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("payment_failed");
    // Nothing else happened: no stamp, no advance, no expense.
    const bill = await storage.getProfile("bill-1");
    expect(bill.fields.occurrences["2026-08-01"].status).toBeUndefined();
    expect(bill.fields.dueDate).toBe("2026-08-01");
    expect(storage.expenses).toHaveLength(0);
  });

  it("refuses non-liability targets", async () => {
    const storage = fakeStorage([CHECKING]);
    const out = await payBillOccurrence(storage, "acct-1", { source: "route" }, "UTC");
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not_liability");
  });
});

// D91 — the due-scan cron's "Bill due: <name>" reminder task (linked to the
// bill) stayed open after the bill was paid, so a paid bill still showed as
// an overdue task on the Tasks page and the dashboard.
describe("payBillOccurrence — closes the bill's reminder tasks", () => {
  function withTasks(storage: any, tasks: any[]) {
    storage.tasks = tasks;
    storage.getTasks = async () => tasks;
    storage.updateTask = async (id: string, patch: any) => {
      const t = tasks.find(x => x.id === id);
      if (!t) return undefined;
      Object.assign(t, patch);
      storage.writes.push(["updateTask", id, patch]);
      return t;
    };
    return storage;
  }
  it("marks done the reminder due on or before the paid occurrence and leaves later / other ones alone", async () => {
    const storage = withTasks(fakeStorage([USAGE_BILL]), [
      { id: "t-old", title: "Bill due: ChatGPT", status: "todo", dueDate: "2026-07-28", linkedProfiles: ["bill-1"] },
      { id: "t-this", title: "Bill due: ChatGPT", status: "todo", dueDate: "2026-08-01", linkedProfiles: ["bill-1"] },
      { id: "t-next", title: "Bill due: ChatGPT", status: "todo", dueDate: "2026-09-01", linkedProfiles: ["bill-1"] },
      { id: "t-other", title: "Bill due: Rent", status: "todo", dueDate: "2026-08-01", linkedProfiles: ["bill-9"] },
      { id: "t-plain", title: "Call the ChatGPT people", status: "todo", dueDate: "2026-08-01", linkedProfiles: ["bill-1"] },
    ]);
    const out = await payBillOccurrence(storage, "bill-1", { occurrenceDate: "2026-08-01", source: "route" }, "UTC");
    expect(out.ok).toBe(true);
    expect(out.steps).toContainEqual({ step: "reminder_tasks", ok: true });
    const byId = Object.fromEntries(storage.tasks.map((t: any) => [t.id, t.status]));
    expect(byId).toEqual({ "t-old": "done", "t-this": "done", "t-next": "todo", "t-other": "todo", "t-plain": "todo" });
  });
  it("a storage without tasks still pays", async () => {
    const storage = fakeStorage([USAGE_BILL]);
    const out = await payBillOccurrence(storage, "bill-1", { occurrenceDate: "2026-08-01", source: "route" }, "UTC");
    expect(out.ok).toBe(true);
    expect(out.steps.some(s => s.step === "reminder_tasks")).toBe(false);
  });
});

describe("closeBillReminderTasksWhere — the due-scan's self-heal rule", () => {
  it("closes reminders whose occurrence is paid/skipped or that the schedule rolled past", async () => {
    const { closeBillReminderTasksWhere } = await import("../server/liability-payments");
    const tasks = [
      { id: "a", title: "Bill due: X", status: "todo", dueDate: "2026-08-30", linkedProfiles: ["bill-1"] }, // rolled past
      { id: "b", title: "Bill due: X", status: "todo", dueDate: "2026-09-04", linkedProfiles: ["bill-1"] }, // paid occurrence
      { id: "c", title: "Bill due: X", status: "todo", dueDate: "2026-10-04", linkedProfiles: ["bill-1"] }, // current, open
      { id: "d", title: "Bill due: X", status: "done", dueDate: "2026-08-30", linkedProfiles: ["bill-1"] },
    ];
    const updates: any[] = [];
    const storage: any = { getTasks: async () => tasks, updateTask: async (id: string, p: any) => { updates.push([id, p]); return {}; } };
    const occ: any = { "2026-09-04": { status: "paid" } };
    const due = "2026-10-04";
    const n = await closeBillReminderTasksWhere(storage, "bill-1", (day) => occ[day]?.status === "paid" || occ[day]?.status === "skipped" || (!!day && day < due));
    expect(n).toBe(2);
    expect(updates.map(u => u[0]).sort()).toEqual(["a", "b"]);
  });
});

// D100 — undoing a loan payment left the paying account short: only a
// recurring bill's occurrence stamp named the account.
import { unpayBillOccurrence, accountThatPaid } from "../server/liability-payments";
import { applyBalanceAdjustment } from "../shared/finance-accounts";
describe("unpayBillOccurrence — credits the account that paid a loan", () => {
  function storageWithLedgeredAccounts(seed: any[]) {
    const storage = fakeStorage(seed);
    storage.getProfiles = async () => [...(storage as any)._profiles?.values?.() ?? []];
    // real balance-history bookkeeping, like SupabaseStorage.adjustAccountBalance
    storage.adjustAccountBalance = async (id: string, input: any) => {
      const p = await storage.getProfile(id);
      if (!p) return undefined;
      const { fields } = applyBalanceAdjustment(p, input, "2026-09-02");
      await storage.updateProfile(id, { fields });
      storage.writes.push(["adjustAccountBalance", id, input]);
      return storage.getProfile(id);
    };
    return storage;
  }
  it("restores the checking balance and never credits twice", async () => {
    const storage = storageWithLedgeredAccounts([CAR_LOAN, CHECKING]);
    // fakeStorage keeps profiles in a closure; expose them for getProfiles
    const all = async () => [await storage.getProfile("loan-1"), await storage.getProfile("acct-1")];
    storage.getProfiles = all;
    const paid = await payBillOccurrence(storage, "loan-1", { amount: 400, accountId: "acct-1", source: "route" }, "UTC");
    expect(paid.ok).toBe(true);
    expect((await storage.getProfile("acct-1")).fields.balance).toBe(600);
    expect(await accountThatPaid(storage, paid.payment.id)).toBe("acct-1");
    const undone = await unpayBillOccurrence(storage, "loan-1", { paymentId: paid.payment.id, source: "route" }, "UTC");
    expect(undone.ok).toBe(true);
    expect(undone.accountCredited).toBe(true);
    expect((await storage.getProfile("acct-1")).fields.balance).toBe(1000);
    expect((await storage.getProfile("loan-1")).fields.currentBalance).toBe(10_000);
    // a second look-up sees the reversal and finds nothing to credit
    expect(await accountThatPaid(storage, paid.payment.id)).toBeNull();
  });
});
