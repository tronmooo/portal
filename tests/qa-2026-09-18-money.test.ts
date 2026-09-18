// QA 2026-09-18 — Money: bills, obligations and the loan detail page.
// Findings F-07, F-08, F-09, F-12, F-15, F-16, F-17, F-54. In-app today was
// Fri Sep 18 2026. Each block names the finding it pins.
import { describe, it, expect } from "vitest";
import { payBillOccurrence } from "../server/liability-payments";
import { buildAmortization } from "../shared/liability-calc";
import { loanPayoff, nextLoanDueDate, loanDueDay } from "../shared/loan-facts";
import { deriveScheduleFields, generateSchedule, nextDueOccurrence } from "../shared/liability-schedule";
import { isPaymentBillOf, billsServicingDebt, isPaymentBillOfListedDebt } from "../shared/liability-types";
import { isWithinOverdueGrace, BILL_OVERDUE_GRACE_DAYS, liabilityBillStatus } from "../shared/liability-status";
import { canonicalizeRegistryFields } from "../shared/registry-fields";
import { debtPaymentLiabilityIds, withEffectiveCategories, effectiveExpenseCategory } from "../shared/expense-effective-category";
import { spendByCategory } from "../shared/budget-ledger";
import { selectUpcomingBills, UPCOMING_BILLS_EMPTY_COPY, UPCOMING_BILL_WINDOW_DAYS } from "../shared/obligation-windows";

const TODAY = "2026-09-18";

/** Storage double: profiles in a map, payments and expenses recorded. */
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
    createExpense: async (data: any) => {
      const row = { id: `exp-${expenses.length + 1}`, tags: [], linkedProfiles: [], ...data };
      expenses.push(row);
      return row;
    },
    getExpenses: async () => expenses,
    getTasks: async () => [],
    updateTask: async () => undefined,
  };
  return storage;
}

const DODGE_LOAN = {
  id: "loan-dodge", name: "Dodge Ram 2025 Auto Loan", type: "liability", type_key: "auto_loan",
  parentProfileId: "person-1",
  fields: {
    currentBalance: 48629.10, originalBalance: 54800, interestRate: 6.49, monthlyPayment: 912.40,
    remainingTermMonths: 67, firstPaymentDate: "2025-03-31", dueDay: 30, lastPaidDate: "2026-09-17",
  },
};
const DODGE_BILL = {
  id: "bill-dodge", name: "Dodge Ram 2025 Auto Loan payment", type: "liability", type_key: "bill",
  parentProfileId: "person-1",
  fields: { amount: 912.40, monthlyAmount: 912.40, frequency: "monthly", dueDate: "2026-10-30", category: "loan" },
};

describe("F-07 paying a bill today files the expense TODAY, not on the next due date", () => {
  it("Pay on a bill whose next cycle is next month: expense dated the payment date", async () => {
    const phone = {
      id: "bill-phone", name: "QA Phone Bill", type: "liability", type_key: "phone_plan",
      parentProfileId: "person-1",
      fields: { amount: 92, monthlyAmount: 92, frequency: "monthly", dueDate: "2026-10-15", category: "communication" },
    };
    const storage = fakeStorage([phone]);
    const out = await payBillOccurrence(storage, "bill-phone", { source: "route" }, "UTC");
    const today = new Date().toISOString().slice(0, 10);
    expect(out.ok).toBe(true);
    expect(out.occurrenceDate).toBe("2026-10-15");
    expect(out.payment.paymentDate).toBe(today);
    expect(storage.expenses).toHaveLength(1);
    expect(storage.expenses[0].date).toBe(today);
    expect(storage.expenses[0].amount).toBe(92);
    // The bill's own cycle bookkeeping still advanced.
    expect((await storage.getProfile("bill-phone")).fields.dueDate).toBe("2026-11-15");
  });

  it("an explicit payment date is honoured for both the row and the expense", async () => {
    const phone = {
      id: "bill-phone", name: "QA Phone Bill", type: "liability", type_key: "phone_plan",
      parentProfileId: "person-1",
      fields: { amount: 92, monthlyAmount: 92, frequency: "monthly", dueDate: "2026-10-15" },
    };
    const storage = fakeStorage([phone]);
    const out = await payBillOccurrence(storage, "bill-phone", { source: "route", paymentDate: "2026-09-18" }, "UTC");
    expect(out.payment.paymentDate).toBe("2026-09-18");
    expect(storage.expenses[0].date).toBe("2026-09-18");
  });
});

describe("F-08 one next-due rule for a loan: payment day + today, never the origin", () => {
  it("reads the payment day from dueDay, else from the stored date", () => {
    expect(loanDueDay({ dueDay: 30 })).toBe(30);
    expect(loanDueDay({ firstPaymentDate: "2025-03-31" })).toBe(31);
    expect(loanDueDay({})).toBeNull();
  });

  it("the Dodge loan is next due Oct 30 (Sep 30 was paid on Sep 17), matching the list", () => {
    expect(nextLoanDueDate(DODGE_LOAN.fields, TODAY)).toBe("2026-10-30");
    // Without a payment this cycle, the payment day's next occurrence.
    expect(nextLoanDueDate({ ...DODGE_LOAN.fields, lastPaidDate: undefined }, TODAY)).toBe("2026-09-30");
    // Never the origin date.
    expect(nextLoanDueDate({ firstPaymentDate: "2025-03-31" }, TODAY)).toBe("2026-09-30");
    // A stored future date is the user's own answer.
    expect(nextLoanDueDate({ nextPaymentDate: "2026-11-05", dueDay: 30 }, TODAY)).toBe("2026-11-05");
    // Nothing names a day: nothing is invented.
    expect(nextLoanDueDate({ currentBalance: 100 }, TODAY)).toBeNull();
  });

  it("the derived schedule starts at the next payment: no phantom missed months, next due agrees", () => {
    const f = deriveScheduleFields(DODGE_LOAN.fields, "auto_loan", TODAY);
    expect(f.dueDate).toBe("2026-10-30");
    expect(f.firstPaymentDate).toBe("2026-10-30");
    const occ = generateSchedule({ id: "loan-dodge", fields: f }, [], { todayISO: TODAY, windowStart: "2026-07-18", months: 12 });
    expect(occ.filter((o) => o.status === "overdue")).toHaveLength(0);
    expect(occ[0].date).toBe("2026-10-30");
    expect(nextDueOccurrence({ id: "loan-dodge", fields: f }, [], TODAY)?.date).toBe("2026-10-30");
  });

  it("the loan's payment history is the rows of the bill that pays it", () => {
    expect(isPaymentBillOf(DODGE_BILL, DODGE_LOAN)).toBe(true);
    expect(billsServicingDebt([DODGE_LOAN, DODGE_BILL], DODGE_LOAN).map((b) => b.id)).toEqual(["bill-dodge"]);
    // An explicit link wins over the name.
    const linked = { ...DODGE_BILL, name: "Truck payment", fields: { ...DODGE_BILL.fields, linkedLiabilityId: "loan-dodge" } };
    expect(isPaymentBillOf(linked, DODGE_LOAN)).toBe(true);
    // Netflix pays no loan; a loan is not a payment bill.
    const netflix = { id: "nf", name: "Netflix", type: "liability", type_key: "streaming", fields: {} };
    expect(isPaymentBillOf(netflix, DODGE_LOAN)).toBe(false);
    expect(isPaymentBillOf(DODGE_LOAN, DODGE_BILL)).toBe(false);
  });
});

describe("F-09 / F-12 the amortization starts at the next payment with today's balance and pays off in 63", () => {
  it("$48,629.10 at 6.49% with $912.40/mo: 63 payments, dated from the next due", () => {
    const amo = buildAmortization({
      currentBalance: 48629.10, annualInterestRate: 6.49, monthlyPayment: 912.40, firstPaymentDate: "2026-10-30",
    });
    expect(amo.rows[0].dueDate).toBe("2026-10-30");
    expect(amo.rows[0].remainingBalance).toBeCloseTo(48629.10 - (912.40 - 48629.10 * 0.0649 / 12), 2);
    expect(amo.payoffMonths).toBe(63);
    expect(amo.rows).toHaveLength(63);
    expect(amo.rows[62].remainingBalance).toBeCloseTo(0, 6);
    expect(amo.payoffDate).toBe("2031-12-30");
  });

  it("the Finance tab and the detail page read ONE payoff summary (63 mo, not the stored 67)", () => {
    const payoff = loanPayoff(DODGE_LOAN.fields, TODAY);
    expect(payoff.remainingMonths).toBe(63);
    expect(payoff.monthlyPayment).toBe(912.40);
    expect(payoff.payoffDate).toBe("2031-12-30");
    expect(payoff.payoffProgressPct).toBeCloseTo((1 - 48629.10 / 54800) * 100, 6);
  });

  it("an exact-term loan is unchanged by the final-payment fold", () => {
    const amo = buildAmortization({ currentBalance: 12000, annualInterestRate: 5, remainingTermMonths: 24 });
    expect(amo.payoffMonths).toBe(24);
  });
});

describe("F-15 a loan and its payment bill are one record on the liabilities index", () => {
  it("the lite profiles index folds the payment bill of a listed loan (by name, no subtype needed)", () => {
    const lite = [
      { id: "loan-dodge", name: "Dodge Ram 2025 Auto Loan", type: "liability" },
      { id: "bill-dodge", name: "Dodge Ram 2025 Auto Loan payment", type: "liability" },
      { id: "nf", name: "Netflix", type: "liability" },
    ];
    expect(isPaymentBillOfListedDebt(lite[1], lite)).toBe(true);
    expect(isPaymentBillOfListedDebt(lite[0], lite)).toBe(false);
    expect(isPaymentBillOfListedDebt(lite[2], lite)).toBe(false);
    // Without the loan in the list, the bill stands on its own.
    expect(isPaymentBillOfListedDebt(lite[1], [lite[1], lite[2]])).toBe(false);
  });
});

describe("F-16 a missed cycle is OVERDUE inside the grace window, never rolled forward silently", () => {
  it("the grace window", () => {
    expect(isWithinOverdueGrace("2026-09-15", TODAY)).toBe(true);
    expect(isWithinOverdueGrace(TODAY, TODAY)).toBe(false);
    expect(isWithinOverdueGrace("2026-10-15", TODAY)).toBe(false);
    expect(isWithinOverdueGrace("2026-07-01", TODAY)).toBe(false);
    expect(BILL_OVERDUE_GRACE_DAYS).toBe(30);
  });

  it("a bill created with a start date three days ago is due on that date (overdue), not next month", () => {
    const f = canonicalizeRegistryFields(
      { start_date: "2026-09-15", frequency: "monthly", amount: 92 },
      { typeKey: "phone_plan", todayISO: TODAY },
    );
    expect(f.dueDate).toBe("2026-09-15");
    expect(f.nextDueDate).toBe("2026-09-15");
    expect(f.firstPaymentDate).toBe("2026-09-15");
    expect(liabilityBillStatus(f.dueDate, TODAY)).toBe("overdue");
    // The calendar and the schedule generate from the same anchor: Sep 15 overdue, Oct 15 upcoming.
    const occ = generateSchedule({ id: "b", fields: f }, [], { todayISO: TODAY, windowStart: "2026-09-01", months: 2 });
    expect(occ.map((o) => [o.date, o.status])).toEqual([["2026-09-15", "overdue"], ["2026-10-15", "upcoming"], ["2026-11-15", "upcoming"]]);
  });

  it("a start date older than the grace window is history and rolls to the next occurrence", () => {
    const f = canonicalizeRegistryFields(
      { start_date: "2024-01-15", frequency: "monthly", amount: 92 },
      { typeKey: "phone_plan", todayISO: TODAY },
    );
    expect(f.dueDate).toBe("2026-10-15");
    expect(f.firstPaymentDate).toBe("2024-01-15");
  });
});

describe("F-17 a loan payment counts as debt, whatever category the row was stored with", () => {
  const profiles = [DODGE_LOAN, DODGE_BILL, { id: "nf", name: "Netflix", type: "liability", type_key: "streaming", fields: {} }];
  const rows = [
    { id: "e1", amount: 912.40, category: "general", tags: ["bill-payment", "liability:bill-dodge", "payment:p1"], date: "2026-08-30" },
    { id: "e2", amount: 912.40, category: "general", tags: ["bill-payment", "liability:bill-dodge", "payment:p2"], date: "2026-09-17" },
    { id: "e3", amount: 14.99, category: "general", tags: ["bill-payment", "liability:nf", "payment:p3"], date: "2026-09-10" },
    { id: "e4", amount: 40, category: "general", tags: [], date: "2026-09-11" },
  ];

  it("resolves the debt ids: the loan and the bill that pays it, not Netflix", () => {
    const ids = debtPaymentLiabilityIds(profiles);
    expect([...ids].sort()).toEqual(["bill-dodge", "loan-dodge"]);
  });

  it("the spending-by-category chart puts the two $912.40 rows under debt without a migration", () => {
    const byCat = spendByCategory(withEffectiveCategories(rows, debtPaymentLiabilityIds(profiles)));
    expect(byCat.debt).toBeCloseTo(1824.80, 2);
    expect(byCat.general).toBeCloseTo(54.99, 2);
    expect(effectiveExpenseCategory(rows[0], debtPaymentLiabilityIds(profiles))).toBe("debt");
    expect(effectiveExpenseCategory(rows[2], debtPaymentLiabilityIds(profiles))).toBe("general");
  });

  it("a new payment on the loan's bill is stored as debt", async () => {
    const storage = fakeStorage([DODGE_LOAN, DODGE_BILL]);
    const out = await payBillOccurrence(storage, "bill-dodge", { source: "route" }, "UTC");
    expect(out.ok).toBe(true);
    expect(storage.expenses[0].category).toBe("debt");
  });
});

describe("F-54 one upcoming-bills list and one empty sentence for every surface", () => {
  it("a bill due in 27 days is upcoming; overdue bills come first; nothing past the window", () => {
    const bills = [
      { id: "a", name: "QA Phone Bill", amount: 92, daysUntil: 27 },
      { id: "b", name: "Rent", amount: 1200, daysUntil: -2 },
      { id: "c", name: "Far", amount: 5, daysUntil: UPCOMING_BILL_WINDOW_DAYS + 1 },
      { id: "d", name: "Water", amount: 30, daysUntil: 3 },
    ];
    expect(selectUpcomingBills(bills).map((b) => b.id)).toEqual(["b", "d", "a"]);
    expect(selectUpcomingBills([])).toEqual([]);
    expect(UPCOMING_BILLS_EMPTY_COPY).toBe("Nothing due in the next 30 days");
  });
});
