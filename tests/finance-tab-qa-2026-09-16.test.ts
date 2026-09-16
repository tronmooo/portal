// Regression coverage for the Finance-tab QA pass of 2026-09-16. Item numbers
// match the report: the money on the summary cards was wrong because paid bills
// were counted twice and received paychecks were counted not at all.
import { describe, it, expect } from "vitest";
import {
  sumBillsDueThroughMonth, sumReceivedPaychecksForMonth, sumMonthIncome,
  monthEndDay, nextOccurrenceDay, sumMonthlyIncomeForMonth,
} from "../shared/obligation-windows";
import { buildCashTrend } from "../client/src/lib/cash-trend";
import { liabilityFamily, isRecurringBill } from "../shared/liability-types";
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
