// Regression coverage for the Finance-tab QA pass of 2026-09-16. Item numbers
// match the report: the money on the summary cards was wrong because paid bills
// were counted twice and received paychecks were counted not at all.
import { describe, it, expect } from "vitest";
import {
  sumBillsDueThroughMonth, sumReceivedPaychecksForMonth, sumMonthIncome,
  monthEndDay, nextOccurrenceDay, sumMonthlyIncomeForMonth,
} from "../shared/obligation-windows";
import { buildCashTrend } from "../client/src/lib/cash-trend";
import { payBillOccurrence, unpayBillOccurrence } from "../server/liability-payments";
import { liabilityFamily, isRecurringBill, normalizeLiabilityName } from "../shared/liability-types";
import { EXPENSE_CATEGORIES, canonicalExpenseCategory, categoryLabel } from "../shared/category-canon";
import { findDuplicateExpense } from "../shared/expense-view";
import { summarizeLiabilityDebt } from "../shared/finance-accounts";
import { monthKeyLabel } from "../client/src/lib/dates";

const bill = (over: Record<string, any> = {}) => ({
  amount: 100, frequency: "monthly", status: "active", nextDueDate: "2026-09-12", ...over,
});

describe("#1 paid bills are not counted twice", () => {
  it("counts a bill due this month once", () => {
    expect(sumBillsDueThroughMonth([bill({ amount: 89.99 })], "2026-09")).toBe(89.99);
  });

  it("drops a bill once its payment advanced the due date into next month", () => {
    // This is what paying does: the occurrence is stamped and nextDueDate moves
    // on. From then on the money is carried by the expense the payment wrote.
    expect(sumBillsDueThroughMonth([bill({ nextDueDate: "2026-10-12" })], "2026-09")).toBe(0);
  });

  it("keeps an overdue bill from an earlier month — arrears plus this cycle", () => {
    // Due Aug 12 and never paid: August is still owed and September's cycle
    // falls due before month end, so both are money that has to go out.
    expect(sumBillsDueThroughMonth([bill({ nextDueDate: "2026-08-12" })], "2026-09")).toBe(200);
  });

  it("never pulls next month's bills into this month", () => {
    const bills = [bill({ nextDueDate: "2026-10-01" }), bill({ nextDueDate: "2026-09-30" })];
    expect(sumBillsDueThroughMonth(bills, "2026-09")).toBe(100);
  });

  it("ignores paused and cancelled bills", () => {
    expect(sumBillsDueThroughMonth([bill({ status: "paused" }), bill({ status: "cancelled" })], "2026-09")).toBe(0);
  });

  it("counts every remaining occurrence of a sub-monthly bill", () => {
    // Weekly, first due Sep 7 → Sep 7/14/21/28 all land before month end.
    expect(sumBillsDueThroughMonth([bill({ amount: 25, frequency: "weekly", nextDueDate: "2026-09-07" })], "2026-09")).toBe(100);
  });

  it("stops at a series' recurrence end", () => {
    expect(sumBillsDueThroughMonth(
      [bill({ amount: 25, frequency: "weekly", nextDueDate: "2026-09-07", recurrenceEnd: "2026-09-15" })],
      "2026-09",
    )).toBe(50);
  });
});

describe("month arithmetic behind the bill window", () => {
  it("knows each month's last day", () => {
    expect(monthEndDay("2026-09")).toBe("2026-09-30");
    expect(monthEndDay("2026-02")).toBe("2026-02-28");
    expect(monthEndDay("2024-02")).toBe("2024-02-29");
  });

  it("clamps a 31st to short months instead of rolling over", () => {
    expect(nextOccurrenceDay("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextOccurrenceDay("2026-09-30", "monthly")).toBe("2026-10-30");
  });

  it("has no next occurrence for a one-off", () => {
    expect(nextOccurrenceDay("2026-09-30", "once")).toBeNull();
  });
});

describe("#2 received paychecks are income", () => {
  const pc = (over: Record<string, any> = {}) => ({
    source: "Employer", amount: 2000, expected_date: "2026-09-09",
    confirmed: true, received_date: "2026-09-09", ...over,
  });

  it("counts a paycheck the user marked received", () => {
    expect(sumReceivedPaychecksForMonth([pc()], "2026-09")).toBe(2000);
  });

  it("does not count one that has not been received", () => {
    expect(sumReceivedPaychecksForMonth([pc({ confirmed: false })], "2026-09")).toBe(0);
  });

  it("prefers the posted actual over the expected amount", () => {
    expect(sumReceivedPaychecksForMonth([pc({ actual_amount: 1875.4 })], "2026-09")).toBe(1875.4);
  });

  it("books it in the month it landed, not the month it was expected", () => {
    const late = pc({ expected_date: "2026-08-28", received_date: "2026-09-02" });
    expect(sumReceivedPaychecksForMonth([late], "2026-08")).toBe(0);
    expect(sumReceivedPaychecksForMonth([late], "2026-09")).toBe(2000);
  });

  it("adds to the recurring streams rather than replacing them", () => {
    const streams = [{ amount: 500, frequency: "monthly", date: "2026-01-01" }];
    expect(sumMonthlyIncomeForMonth(streams, "2026-09")).toBe(500);
    expect(sumMonthIncome(streams, [pc()], "2026-09")).toBe(2500);
  });
});

describe("#3 the Cash Flow Trend plots the same numbers as the card", () => {
  const expenses = [
    { date: "2026-08-09", amount: 100 },
    { date: "2026-09-04", amount: 115 },
  ];
  const paychecks = [
    { confirmed: true, received_date: "2026-08-14", amount: 2175 },
    { confirmed: true, received_date: "2026-09-09", amount: 2000 },
  ];

  it("draws an In bar for a month whose income was paychecks", () => {
    const trend = buildCashTrend(expenses, [], "2026-09-16", "America/Los_Angeles", { paychecks });
    const aug = trend.find(p => p.month === "Aug")!;
    expect(aug.inflow).toBe(2175);
    expect(aug.net).toBe(2075);
  });

  it("adds the bills still owed to the current month's Out, as the card does", () => {
    const trend = buildCashTrend(expenses, [], "2026-09-16", "America/Los_Angeles", {
      paychecks, pendingOutflowThisMonth: 1306,
    });
    const sep = trend[trend.length - 1];
    expect(sep.month).toBe("Sep");
    expect(sep.outflow).toBe(115 + 1306);
    expect(sep.net).toBe(2000 - 1421);
    // …and only the current month gets it.
    expect(trend.find(p => p.month === "Aug")!.outflow).toBe(100);
  });

  it("still accepts the old positional month count", () => {
    expect(buildCashTrend([], [], "2026-09-16", "UTC", 3)).toHaveLength(3);
  });
});

describe("#5 an insurance premium is a recurring bill, so paying it logs an expense", () => {
  it("classifies insurance and rent as recurring, not as a balance to pay down", () => {
    for (const key of ["insurance", "auto_insurance", "renters_insurance", "rent", "hoa"]) {
      expect(liabilityFamily(key)).toBe("recurring");
      expect(isRecurringBill(key)).toBe(true);
    }
  });

  it("leaves real debt alone", () => {
    expect(liabilityFamily("auto_loan")).toBe("amortizing");
    expect(liabilityFamily("credit_card")).toBe("revolving");
  });
});

describe("#11 one expense vocabulary", () => {
  it("has no word that is also its own alias", () => {
    // "automotive" used to sit in the canonical list AND alias to "vehicle",
    // so Edit offered "Automotive" and Add offered "Vehicle" for one concept.
    expect(EXPENSE_CATEGORIES).not.toContain("automotive");
    expect(canonicalExpenseCategory("automotive")).toBe("vehicle");
    expect(canonicalExpenseCategory("Automotive")).toBe("vehicle");
  });

  it("folds the spellings the filter used to offer but no form could produce", () => {
    expect(canonicalExpenseCategory("phone")).toBe("utilities");
    expect(canonicalExpenseCategory("personal")).toBe("personal");
    expect(canonicalExpenseCategory("vehicle")).toBe("vehicle");
  });

  it("every canonical category has a label", () => {
    for (const c of EXPENSE_CATEGORIES) expect(categoryLabel(c)).toBeTruthy();
  });
});

describe("#14 a second identical expense is caught", () => {
  const logged = [{ id: "a", description: "Dinner at Chili's", amount: 100, date: "2026-08-09" }];

  it("matches on description, amount and day, ignoring case and padding", () => {
    expect(findDuplicateExpense(logged, { description: "  dinner at chili's ", amount: 100, date: "2026-08-09" })?.id).toBe("a");
  });

  it("lets a different amount, day or description through", () => {
    expect(findDuplicateExpense(logged, { description: "Dinner at Chili's", amount: 100, date: "2026-08-10" })).toBeNull();
    expect(findDuplicateExpense(logged, { description: "Dinner at Chili's", amount: 60, date: "2026-08-09" })).toBeNull();
    expect(findDuplicateExpense(logged, { description: "Lunch", amount: 100, date: "2026-08-09" })).toBeNull();
  });
});

describe("#17 debt tracked as a liability shows up in the Accounts rollup", () => {
  const loan = { id: "l1", type: "liability", type_key: "auto_loan", name: "Dodge", fields: { currentBalance: 49275 } };
  const card = { id: "c1", type: "liability", type_key: "credit_card", name: "Visa", fields: { currentBalance: 1522 } };
  const netflix = { id: "n1", type: "liability", type_key: "streaming", name: "Netflix", fields: { monthlyAmount: 14.99 } };

  it("counts loans and cards that are not account profiles", () => {
    expect(summarizeLiabilityDebt([loan, card])).toEqual({ loanDebt: 49275, creditDebt: 1522 });
  });

  it("leaves recurring service bills out — they are not a balance", () => {
    expect(summarizeLiabilityDebt([netflix])).toEqual({ loanDebt: 0, creditDebt: 0 });
  });

  it("skips account profiles, which summarizeAccounts already counted", () => {
    expect(summarizeLiabilityDebt([{ id: "a1", type: "account", fields: { kind: "loan", balance: 500 } }]))
      .toEqual({ loanDebt: 0, creditDebt: 0 });
  });
});

describe("#19 a month key reads as its own month in every zone", () => {
  it("does not slip back a day into the previous month", () => {
    // `new Date("2026-09-01")` is UTC midnight = Aug 31 west of Greenwich, so
    // the Cash Flow heading read "August 2026" all through September.
    expect(monthKeyLabel("2026-09")).toMatch(/September 2026/);
    expect(monthKeyLabel("2026-01")).toMatch(/January 2026/);
  });
});

describe("#4 a bill named for a loan pays that loan", () => {
  it("pairs '<loan> payment' with '<loan>'", () => {
    expect(normalizeLiabilityName("Dodge Ram 2025 Auto Loan payment")).toBe("dodge ram 2025 auto loan");
    expect(normalizeLiabilityName("Dodge Ram 2025 Auto Loan")).toBe("dodge ram 2025 auto loan");
    expect(normalizeLiabilityName("Phone Bill Payments")).toBe("phone");
  });

  it("leaves a name that isn't a payment bill alone", () => {
    expect(normalizeLiabilityName("Netflix")).toBe("netflix");
  });

  // Revised 2026-09-22 (duplicate-liability report). This used to pin
  // "Internet Bill" → "internet bill" while "Phone Bill Payments" → "phone",
  // and that asymmetry WAS a duplicate factory: "Phone Bill" and "Phone Bill
  // Payments" normalized differently, so identity never recognised them as one
  // liability and both records were kept. A trailing "bill"/"payment" says what
  // KIND of record a name is, not WHICH liability, so every spelling of one
  // obligation now folds to the same key.
  it("folds every 'bill'/'payment' spelling of one obligation to one key", () => {
    const key = normalizeLiabilityName("Phone");
    for (const spelling of ["Phone Bill", "Phone Bill Payments", "Phone payment", "Phone Bills"]) {
      expect(normalizeLiabilityName(spelling)).toBe(key);
    }
    expect(normalizeLiabilityName("Internet Bill")).toBe("internet");
  });

  it("never normalizes a name away entirely", () => {
    expect(normalizeLiabilityName("Bill")).toBe("bill");
    expect(normalizeLiabilityName("Payment")).toBe("payment");
  });
});


// ─── End-to-end through the real pay operation ──────────────────────────────
// The exact records the QA pass was run against: a Dodge Ram auto loan at
// 6.49% with $49,275 owed, and the separate "<loan> payment" bill beside it
// that carries no linkedLiabilityId (none of the bills in the field do).

function fakeStorage(seed: any[]) {
  const profiles = new Map<string, any>(seed.map(p => [p.id, JSON.parse(JSON.stringify(p))]));
  const expenses: any[] = [];
  let payments: any[] = [];
  let paySeq = 0;
  const storage: any = {
    expenses,
    get payments() { return payments; },
    getProfile: async (id: string) => profiles.get(id),
    getProfiles: async () => Array.from(profiles.values()),
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
      const row = { id: `pay-${++paySeq}`, ...data };
      payments = [row, ...payments];
      return row;
    },
    getLiabilityPayments: async () => payments,
    deleteLiabilityPayment: async (id: string) => {
      const before = payments.length;
      payments = payments.filter(p => p.id !== id);
      return payments.length < before;
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
    unmarkLoanPayment: async () => 0,
  };
  return storage;
}

const DODGE_LOAN = {
  id: "loan-dodge", name: "Dodge Ram 2025 Auto Loan", type: "liability", type_key: "auto_loan",
  parentProfileId: "person-1",
  fields: { currentBalance: 49275, annualInterestRate: 6.49, monthlyPayment: 912.4 },
};
const DODGE_BILL = {
  id: "bill-dodge", name: "Dodge Ram 2025 Auto Loan payment", type: "liability", type_key: "bill",
  parentProfileId: "person-1",
  fields: { amount: 912.4, monthlyAmount: 912.4, frequency: "monthly", dueDate: "2026-09-30", category: "loan" },
};

describe("#4 paying the loan bill moves the loan", () => {
  it("reduces the balance and splits the payment at the loan's own rate", async () => {
    const storage = fakeStorage([DODGE_LOAN, DODGE_BILL]);
    const out = await payBillOccurrence(storage, "bill-dodge", { source: "route" }, "America/Los_Angeles");
    expect(out.ok).toBe(true);
    expect(out.amount).toBe(912.4);

    // 6.49% on $49,275 for one month is $266.53; the rest is principal. The
    // payment used to be booked as 100% principal / 0% interest.
    const expectedInterest = Math.round(49275 * (0.0649 / 12) * 100) / 100;
    expect(out.interest).toBeCloseTo(expectedInterest, 2);
    expect(out.interest).toBeGreaterThan(0);
    expect(out.principal).toBeCloseTo(912.4 - expectedInterest, 2);

    // …and the loan itself moved, which is the whole complaint.
    const loan = await storage.getProfile("loan-dodge");
    expect(Number(loan.fields.currentBalance)).toBeCloseTo(49275 - (912.4 - expectedInterest), 2);
    expect(Number(loan.fields.currentBalance)).toBeLessThan(49275);

    // The pairing is recorded, so it is explicit from here on.
    const bill = await storage.getProfile("bill-dodge");
    expect(bill.fields.linkedLiabilityId).toBe("loan-dodge");

    // Still a bill: it logs an expense and advances its own due date.
    expect(storage.expenses).toHaveLength(1);
    expect(storage.expenses[0].amount).toBe(912.4);
    expect(bill.fields.dueDate).toBe("2026-10-30");
  });

  it("undoing the payment puts the loan balance back", async () => {
    const storage = fakeStorage([DODGE_LOAN, DODGE_BILL]);
    await payBillOccurrence(storage, "bill-dodge", { source: "route" }, "America/Los_Angeles");
    const undone = await unpayBillOccurrence(storage, "bill-dodge", { source: "route" }, "America/Los_Angeles");
    expect(undone.ok).toBe(true);
    expect(undone.balanceRestored).toBe(true);
    expect(undone.expenseDeleted).toBe(true);
    const loan = await storage.getProfile("loan-dodge");
    expect(Number(loan.fields.currentBalance)).toBeCloseTo(49275, 2);
    const bill = await storage.getProfile("bill-dodge");
    expect(bill.fields.dueDate).toBe("2026-09-30");
  });

  it("leaves an ordinary bill alone — nothing to pair, nothing to move", async () => {
    const netflix = {
      id: "bill-netflix", name: "Netflix", type: "liability", type_key: "streaming",
      parentProfileId: "person-1",
      fields: { amount: 14.99, monthlyAmount: 14.99, frequency: "monthly", dueDate: "2026-09-22" },
    };
    const storage = fakeStorage([DODGE_LOAN, netflix]);
    const out = await payBillOccurrence(storage, "bill-netflix", { source: "route" }, "America/Los_Angeles");
    expect(out.ok).toBe(true);
    expect(out.interest).toBe(0);
    expect(out.principal).toBe(14.99);
    expect(Number((await storage.getProfile("loan-dodge")).fields.currentBalance)).toBe(49275);
    expect((await storage.getProfile("bill-netflix")).fields.linkedLiabilityId).toBeUndefined();
  });

  it("survives a storage with no getProfiles at all", async () => {
    // Resolving the debt is an enrichment; a storage double that lacks the
    // method throws synchronously, and that must not fail the payment.
    const storage = fakeStorage([DODGE_BILL]);
    delete storage.getProfiles;
    const out = await payBillOccurrence(storage, "bill-dodge", { source: "route" }, "America/Los_Angeles");
    expect(out.ok).toBe(true);
    expect(out.amount).toBe(912.4);
  });
});

describe("#6 one date rule: the payment AND its expense are dated the day the money moved", () => {
  // Superseded 2026-09-18 (F-07, tests/qa-2026-09-18-money.test.ts): dating
  // the expense to the occurrence filed a payment made today as NEXT month's
  // spend, so Spend MTD and cash flow never moved. The expense is dated the
  // payment date; a catch-up that belongs to an earlier month is dated by its
  // caller (the autopay cron passes the due day).
  it("a late catch-up paid today: cash today, expense today", async () => {
    const internet = {
      id: "bill-net", name: "Internet Bill", type: "liability", type_key: "internet",
      parentProfileId: "person-1",
      fields: { amount: 89.99, monthlyAmount: 89.99, frequency: "monthly", dueDate: "2026-09-12" },
    };
    const storage = fakeStorage([internet]);
    const out = await payBillOccurrence(storage, "bill-net", { source: "route" }, "UTC");
    const today = new Date().toISOString().slice(0, 10);
    expect(out.occurrenceDate).toBe("2026-09-12");
    expect(out.payment.paymentDate).toBe(today);           // the cash date
    expect(storage.expenses[0].date).toBe(today);          // the same date
    expect(storage.expenses[0].description).toContain("2026-09-12"); // the period it settled
  });

  it("paying next month's bill early is money that left today", async () => {
    const netflix = {
      id: "bill-nf", name: "Netflix", type: "liability", type_key: "streaming",
      parentProfileId: "person-1",
      fields: { amount: 14.99, monthlyAmount: 14.99, frequency: "monthly", dueDate: "2099-01-22" },
    };
    const storage = fakeStorage([netflix]);
    const out = await payBillOccurrence(storage, "bill-nf", { source: "route" }, "UTC");
    const today = new Date().toISOString().slice(0, 10);
    expect(out.payment.paymentDate).toBe(today);
    expect(storage.expenses[0].date).toBe(today);
  });
});

describe("#8 a loan payment is a debt payment, not 'General' spending", () => {
  it("logs the serviced-debt bill under the debt bucket", async () => {
    const storage = fakeStorage([DODGE_LOAN, { ...DODGE_BILL, fields: { ...DODGE_BILL.fields, category: "loan" } }]);
    await payBillOccurrence(storage, "bill-dodge", { source: "route" }, "America/Los_Angeles");
    expect(storage.expenses[0].category).toBe("debt");
  });

  it("folds the obligation spelling 'loan' to the expense bucket 'debt'", () => {
    expect(canonicalExpenseCategory("loan")).toBe("debt");
    expect(canonicalExpenseCategory("Car payment")).toBe("debt");
    expect(categoryLabel("debt")).toBe("Debt payments");
    expect(EXPENSE_CATEGORIES).toContain("debt");
  });
});

describe("#2 (round 2) a one-time income counts in the month it landed", () => {
  const august = [
    { description: "Freelance", amount: 750, frequency: "once", date: "2026-08-22" },
    { description: "DoorDash", amount: 175, frequency: "once", date: "2026-08-22" },
    { description: "Paycheck", amount: 1250, frequency: "once", date: "2026-08-10" },
  ];

  it("is the whole amount in its own month", () => {
    // These three were $0 in every month: the monthly-equivalent of a
    // one-off is nothing, so August read "In: $0" against $2,175 of income.
    expect(sumMonthlyIncomeForMonth(august, "2026-08")).toBe(2175);
  });

  it("is nothing in any other month", () => {
    expect(sumMonthlyIncomeForMonth(august, "2026-09")).toBe(0);
    expect(sumMonthlyIncomeForMonth(august, "2026-07")).toBe(0);
  });

  it("still projects a recurring stream from its start month on", () => {
    const salary = [{ description: "Salary", amount: 3000, frequency: "monthly", date: "2026-08-01" }];
    expect(sumMonthlyIncomeForMonth(salary, "2026-07")).toBe(0);
    expect(sumMonthlyIncomeForMonth(salary, "2026-08")).toBe(3000);
    expect(sumMonthlyIncomeForMonth(salary, "2026-09")).toBe(3000);
  });

  it("shows up on the trend chart", () => {
    const trend = buildCashTrend([{ date: "2026-08-09", amount: 2825 }], august, "2026-09-17", "America/Los_Angeles");
    const aug = trend.find(p => p.month === "Aug")!;
    expect(aug.inflow).toBe(2175);
    expect(aug.net).toBe(-650);
  });
});

describe("#7 last-paid never moves backwards", () => {
  it("keeps September after the August cycle is settled later", async () => {
    // Auto Insurance: the Sep 15 cycle was already paid, then Aug 15 was paid
    // afterwards, and last-paid rewrote itself to August.
    const bill = {
      id: "bill-ins", name: "Auto Insurance", type: "liability", type_key: "bill",
      parentProfileId: "person-1",
      fields: {
        amount: 186.42, monthlyAmount: 186.42, frequency: "monthly",
        dueDate: "2026-10-15", lastPaidDate: "2026-09-15",
        occurrences: { "2026-09-15": { status: "paid", paymentId: "old", amount: 186.42 } },
      },
    };
    const storage = fakeStorage([bill]);
    await payBillOccurrence(storage, "bill-ins", {
      occurrenceDate: "2026-08-15", paymentDate: "2026-08-15", source: "route",
    }, "UTC");
    const after = await storage.getProfile("bill-ins");
    expect(after.fields.lastPaidDate).toBe("2026-09-15");
  });
});

describe("#5 (round 2) the snapshot counts only what the list shows", () => {
  it("leaves synthetic QA rows out of Spend unless asked to include them", async () => {
    // A "QA Test …" expense raised Spend by $500 while never appearing in the
    // list — the list applied shared/test-data's patterns, the snapshot didn't.
    const { MemStorage } = await import("../server/storage");
    const s = new MemStorage();
    const ym = new Date().toISOString().slice(0, 7);
    await s.createExpense({ description: "Groceries", amount: 40, category: "food", date: `${ym}-03`, linkedProfiles: [], tags: [] } as any);
    await s.createExpense({ description: "QA Test Coffee", amount: 500, category: "food", date: `${ym}-04`, linkedProfiles: [], tags: [] } as any);
    const hidden: any = await s.getDashboardEnhanced();
    expect(hidden.financeSnapshot.totalMonthlySpend).toBe(40);
    const shown: any = await s.getDashboardEnhanced(undefined, undefined, { includeTestData: true });
    expect(shown.financeSnapshot.totalMonthlySpend).toBe(540);
  });
});
