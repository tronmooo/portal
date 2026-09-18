// Regression coverage for the money / finance cluster of the QA pass of
// 2026-09-18 (portol.me). Bug ids match the report.
import { describe, it, expect } from "vitest";
import {
  incomeOccurrenceDaysInMonth, sumMonthlyIncomeToDate, sumMonthIncomeToDate, sumMonthIncome,
  reconcileExpectedPaychecks, latePaychecks,
} from "../shared/obligation-windows";

// The exact records on the QA screen: a $1,000 "Monthly Paycheck" stream whose
// first pay day is Sep 30, a $2,000 "Monthly Income" stream paid on the 9th,
// and the two expected-paycheck rows for Sep 9 — one received, one not.
const TODAY = "2026-09-18";
const streams = [
  { id: "i1", description: "Monthly Paycheck", amount: 1000, frequency: "monthly", date: "2026-09-30" },
  { id: "i2", description: "Monthly Income", amount: 2000, frequency: "monthly", date: "2026-09-09" },
];
const employer = { id: "p1", source: "Employer", amount: 2000, expected_date: "2026-09-09", confirmed: true, received_date: "2026-09-09" };
const projected = { id: "p2", source: "Monthly Income", amount: 2000, expected_date: "2026-09-09", confirmed: false };

describe("BUG-05 income MTD counts only money that has arrived", () => {
  it("places a stream's pay days inside the month", () => {
    expect(incomeOccurrenceDaysInMonth(streams[0], "2026-09")).toEqual(["2026-09-30"]);
    expect(incomeOccurrenceDaysInMonth(streams[0], "2026-09", TODAY)).toEqual([]);
    expect(incomeOccurrenceDaysInMonth(streams[1], "2026-09", TODAY)).toEqual(["2026-09-09"]);
    // Before the first pay day there is nothing.
    expect(incomeOccurrenceDaysInMonth(streams[0], "2026-08")).toEqual([]);
  });

  it("walks sub-monthly cadences from an old anchor without drifting", () => {
    expect(incomeOccurrenceDaysInMonth({ amount: 1, frequency: "biweekly", date: "2026-01-02" }, "2026-09"))
      .toEqual(["2026-09-11", "2026-09-25"]);
    expect(incomeOccurrenceDaysInMonth({ amount: 1, frequency: "weekly", date: "2026-09-04" }, "2026-09", TODAY))
      .toEqual(["2026-09-04", "2026-09-11", "2026-09-18"]);
    // A 31st anchor clamps to short months and springs back afterwards.
    expect(incomeOccurrenceDaysInMonth({ amount: 1, frequency: "monthly", date: "2025-01-31" }, "2026-02")).toEqual(["2026-02-28"]);
    expect(incomeOccurrenceDaysInMonth({ amount: 1, frequency: "monthly", date: "2025-01-31" }, "2026-03")).toEqual(["2026-03-31"]);
    expect(incomeOccurrenceDaysInMonth({ amount: 1, frequency: "yearly", date: "2024-09-10" }, "2026-09", TODAY)).toEqual(["2026-09-10"]);
    expect(incomeOccurrenceDaysInMonth({ amount: 1, frequency: "yearly", date: "2024-10-10" }, "2026-09")).toEqual([]);
    expect(incomeOccurrenceDaysInMonth({ amount: 1, frequency: "quarterly", date: "2026-03-05" }, "2026-09")).toEqual(["2026-09-05"]);
  });

  it("leaves a paycheck dated twelve days from now out of the month-to-date figure", () => {
    expect(sumMonthlyIncomeToDate([streams[0]], "2026-09", TODAY)).toBe(0);
    expect(sumMonthlyIncomeToDate([streams[0]], "2026-09", "2026-09-30")).toBe(1000);
  });

  it("counts a one-time income only once its date has passed", () => {
    const bonus = { amount: 750, frequency: "once", date: "2026-09-25" };
    expect(sumMonthlyIncomeToDate([bonus], "2026-09", TODAY)).toBe(0);
    expect(sumMonthlyIncomeToDate([bonus], "2026-09", "2026-09-25")).toBe(750);
    expect(sumMonthlyIncomeToDate([bonus], "2026-10", "2026-10-05")).toBe(0);
  });

  it("keeps a stream with no pay day on record at its monthly equivalent", () => {
    expect(sumMonthlyIncomeToDate([{ amount: 500, frequency: "monthly" }], "2026-09", TODAY)).toBe(500);
  });

  it("the QA screen: $2,000 received, not $3,000 expected", () => {
    // Received to date: the Sep 9 deposit once (the received paycheck and the
    // stream's Sep 9 occurrence are the same money), nothing for Sep 30.
    expect(sumMonthIncomeToDate(streams, [employer, projected], "2026-09", TODAY)).toBe(2000);
    // The projection is still available, clearly a different number.
    expect(sumMonthIncome(streams, [employer, projected], "2026-09")).toBe(5000);
  });

  it("does not net a received paycheck against a stream occurrence for a different amount or day", () => {
    const other = { ...employer, amount: 1875.4, expected_date: "2026-09-12", received_date: "2026-09-12" };
    expect(sumMonthIncomeToDate([streams[1]], [other], "2026-09", TODAY)).toBe(2000 + 1875.4);
  });
});

describe("BUG-07 a duplicate expected paycheck on the same date is matched, not Overdue", () => {
  it("treats the pending twin of a received paycheck as received", () => {
    const rows = reconcileExpectedPaychecks([employer, projected]);
    expect(rows.find(r => r.paycheck.id === "p1")).toMatchObject({ received: true, matchedTo: null });
    expect(rows.find(r => r.paycheck.id === "p2")).toMatchObject({ received: true });
    expect(rows.find(r => r.paycheck.id === "p2")!.matchedTo!.id).toBe("p1");
  });

  it("does not raise the late-paycheck alert for a matched row", () => {
    expect(latePaychecks([employer, projected], TODAY)).toEqual([]);
    expect(latePaychecks([projected], TODAY).map(p => p.id)).toEqual(["p2"]);
  });

  it("one receipt covers one twin, so two real deposits still need two receipts", () => {
    const rows = reconcileExpectedPaychecks([employer, projected, { ...projected, id: "p3" }]);
    expect(rows.filter(r => r.received)).toHaveLength(2);
    expect(latePaychecks([employer, projected, { ...projected, id: "p3" }], TODAY).map(p => p.id)).toEqual(["p3"]);
  });

  it("does not match across amounts or dates", () => {
    expect(latePaychecks([employer, { ...projected, amount: 1500 }], TODAY)).toHaveLength(1);
    expect(latePaychecks([employer, { ...projected, expected_date: "2026-09-10" }], TODAY)).toHaveLength(1);
  });
});

// ─── BUG-11 loan payments are debt payments, dated to the period they pay for ─
import { billPaymentExpenseCategory, canonicalExpenseCategory } from "../shared/category-canon";
import { payBillOccurrence } from "../server/liability-payments";

function fakeStorage(seed: any[]) {
  const profiles = new Map<string, any>(seed.map(p => [p.id, JSON.parse(JSON.stringify(p))]));
  const expenses: any[] = [];
  let payments: any[] = [];
  let paySeq = 0;
  const storage: any = {
    expenses,
    getProfile: async (id: string) => profiles.get(id),
    getProfiles: async () => Array.from(profiles.values()),
    updateProfile: async (id: string, patch: any) => {
      const p = profiles.get(id);
      if (!p) return undefined;
      const fields = { ...(p.fields || {}) };
      for (const [k, v] of Object.entries(patch.fields || {})) {
        if (v === null || v === undefined) delete fields[k]; else fields[k] = v;
      }
      const next = { ...p, ...patch, fields };
      profiles.set(id, next);
      return next;
    },
    createLiabilityPayment: async (data: any) => { const row = { id: `pay-${++paySeq}`, ...data }; payments = [row, ...payments]; return row; },
    getLiabilityPayments: async () => payments,
    createExpense: async (data: any) => { const row = { id: `exp-${expenses.length + 1}`, tags: [], linkedProfiles: [], ...data }; expenses.push(row); return row; },
    getExpenses: async () => expenses,
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
    unmarkLoanPayment: async () => 0,
  };
  return storage;
}

describe("BUG-11 a loan payment lands in Debt payments, dated to its due date", () => {
  it("names the bucket from the bill itself when nothing links it to a loan", () => {
    expect(billPaymentExpenseCategory({ name: "Dodge Ram 2025 Auto Loan payment" })).toBe("debt");
    expect(billPaymentExpenseCategory({ name: "Dodge Ram 2025 Auto Loan payment", category: "general" })).toBe("debt");
    expect(billPaymentExpenseCategory({ name: "Mortgage — Maple St", category: "housing" })).toBe("housing");
    expect(billPaymentExpenseCategory({ name: "Car payment", type_key: "auto_loan" })).toBe("debt");
    expect(billPaymentExpenseCategory({ name: "Netflix", servicesDebt: true })).toBe("debt");
    expect(billPaymentExpenseCategory({ name: "Internet Bill", category: "internet" })).toBe("utilities");
    expect(billPaymentExpenseCategory({ name: "Internet Bill" })).toBe("general");
    expect(canonicalExpenseCategory("loan")).toBe("debt");
  });

  it("an unlinked '<loan> payment' bill with no category is still a debt payment, dated to the occurrence", async () => {
    const bill = {
      id: "bill-dodge", name: "Dodge Ram 2025 Auto Loan payment", type: "liability", type_key: "bill",
      parentProfileId: "person-1",
      fields: { amount: 912.4, monthlyAmount: 912.4, frequency: "monthly", dueDate: "2026-09-30" },
    };
    const storage = fakeStorage([bill]);
    const out = await payBillOccurrence(storage, "bill-dodge", { source: "route" }, "UTC");
    expect(out.ok).toBe(true);
    expect(storage.expenses).toHaveLength(1);
    expect(storage.expenses[0].category).toBe("debt");
    // Booked on the 17th, the expense carries the bill's own date, not today's.
    expect(storage.expenses[0].date).toBe("2026-09-30");
  });

  it("an October bill paid in September is October's spend", async () => {
    const internet = {
      id: "bill-net", name: "Internet Bill", type: "liability", type_key: "internet",
      parentProfileId: "person-1",
      fields: { amount: 89.99, monthlyAmount: 89.99, frequency: "monthly", dueDate: "2026-10-12", category: "internet" },
    };
    const storage = fakeStorage([internet]);
    await payBillOccurrence(storage, "bill-net", { source: "route" }, "UTC");
    expect(storage.expenses[0].date).toBe("2026-10-12");
    expect(storage.expenses[0].category).toBe("utilities");
  });
});

// ─── BUG-13 a savings account is cash, not an investment ─────────────────────
import { accountKindOf, normalizeAccountKind, summarizeAccounts, accountKindMeta } from "../shared/finance-accounts";

describe("BUG-13 Assets → + → Savings Account is classified as cash", () => {
  // The registry type: category "investments" (so profile type "investment"),
  // type_key "savings_account", and the form's own account_type wording.
  const ally = {
    id: "acct-ally", name: "Ally Savings", type: "investment", type_key: "savings_account",
    fields: { institution: "Ally", account_type: "High-Yield Savings (HYSA)", current_balance: 12500 },
  };

  it("reads the savings kind through the registry's type_key and wording", () => {
    expect(accountKindOf(ally)).toBe("savings");
    expect(accountKindOf({ ...ally, fields: { ...ally.fields, account_type: "Traditional Savings" } })).toBe("savings");
    expect(accountKindOf({ ...ally, fields: { ...ally.fields, account_type: "Money Market" } })).toBe("savings");
    expect(accountKindOf({ ...ally, type_key: undefined, fields: { account_type: "Savings Account", current_balance: 1 } })).toBe("savings");
    expect(accountKindMeta(accountKindOf(ally)).label).toBe("Savings");
  });

  it("folds phrases, not just exact words", () => {
    expect(normalizeAccountKind("savings_account")).toBe("savings");
    expect(normalizeAccountKind("Checking Account")).toBe("checking");
    expect(normalizeAccountKind("Chase Credit Card")).toBe("credit_card");
    expect(normalizeAccountKind("Brokerage account")).toBe("investment");
    expect(normalizeAccountKind("Roth IRA")).toBe("investment");
    expect(normalizeAccountKind("Auto Loan")).toBe("loan");
    // Still what the existing tests pin.
    expect(normalizeAccountKind("HYSA")).toBe("savings");
    expect(normalizeAccountKind("")).toBe("other");
  });

  it("the first candidate that RESOLVES wins, not the first one that is set", () => {
    expect(accountKindOf({ type: "investment", type_key: "savings_account", fields: { account_type: "Other" } })).toBe("savings");
    // A real brokerage under the investment type stays an investment.
    expect(accountKindOf({ type: "investment", fields: { accountType: "Roth IRA", balance: 50000 } })).toBe("investment");
    expect(accountKindOf({ type: "investment", fields: { balance: 50000 } })).toBe("investment");
  });

  it("rolls the balance into Cash on hand, not Investments", () => {
    const brokerage = { id: "b", name: "Fidelity", type: "investment", fields: { balance: 53000 } };
    const s = summarizeAccounts([ally, brokerage]);
    expect(s.cash).toBe(12500);
    expect(s.investments).toBe(53000);
  });
});

// ─── BUG-18 money keeps its trailing zero ────────────────────────────────────
import { formatDollars } from "../shared/money";
import { formatMoney } from "../client/src/lib/format";

describe("BUG-18 amounts render with two decimals when they have cents", () => {
  it("shared formatter", () => {
    expect(formatDollars(184.1)).toBe("$184.10");
    expect(formatDollars(184)).toBe("$184");
    expect(formatDollars(1234.5)).toBe("$1,234.50");
    expect(formatDollars(-23.5)).toBe("-$23.50");
    expect(formatDollars("912.40")).toBe("$912.40");
    expect(formatDollars(null)).toBe("$0");
  });

  it("agrees with the client formatter", () => {
    for (const n of [184.1, 184, 1234.5, 0.5, 39.75, 1608307]) expect(formatDollars(n)).toBe(formatMoney(n));
  });
});

// ─── Low: net-worth headline, calendar income amount ─────────────────────────
import { netWorthChange } from "../shared/net-worth-change";
import { seriesFromIncomes } from "../shared/calendar-adapters";

describe("net-worth change on a history that started this month", () => {
  it("does not claim a monthly change; labels the delta by its baseline", () => {
    const c = netWorthChange([{ snapshotDate: "2026-09-03", netWorth: 120000 }], 1608307, "2026-09-18")!;
    expect(c.monthly).toBe(false);
    expect(c.pct).toBeNull();
    expect(c.delta).toBe(1608307 - 120000);
    expect(c.label).toBe("since Sep 3");
  });

  it("shows no change at all when the only snapshot is today's", () => {
    const c = netWorthChange([{ snapshotDate: "2026-09-18", netWorth: 119874 }], 1608307, "2026-09-18")!;
    expect(c.delta).toBeNull();
    expect(c.pct).toBeNull();
    expect(c.label).toBe("since first entry");
  });

  it("still states a real month-over-month", () => {
    const c = netWorthChange([
      { snapshotDate: "2026-08-10", netWorth: 100000 }, { snapshotDate: "2026-09-17", netWorth: 110000 },
    ], 110000, "2026-09-18")!;
    expect(c.monthly).toBe(true);
    expect(c.pct).toBeCloseTo(10, 5);
    expect(c.label).toBe("this month");
  });
});

describe("calendar income series carries its amount", () => {
  it("accepts a numeric string amount", () => {
    const [s] = seriesFromIncomes([{ id: "i", description: "Northwind Logistics", amount: "105000", frequency: "yearly", date: "2026-01-15" }]);
    expect(s.amount).toBe(105000);
    expect(seriesFromIncomes([{ id: "j", amount: 5200, frequency: "monthly", date: "2026-01-01" }])[0].amount).toBe(5200);
    expect(seriesFromIncomes([{ id: "k", amount: null, frequency: "monthly", date: "2026-01-01" }])[0].amount).toBeUndefined();
  });
});
