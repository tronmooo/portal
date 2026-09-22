/**
 * Rule 13 — ONE date engine. `getRecordTemporalStatus` is what Chat, Finance,
 * the Dashboard, the Calendar and Notifications call; none of them compute a
 * next-due of their own.
 *
 * The regression: on 2026-09-26 a loan due on the 25th, last paid Sep 20,
 * read "Sept 25" in chat (raw stored `dueDate`) while the loan detail page said
 * Oct 25 (shared/loan-facts `nextLoanDueDate`). Both must say Oct 25.
 */
import { describe, it, expect } from "vitest";
import { getRecordTemporalStatus, classifyDate } from "@shared/temporal-status";
import { nextLoanDueDate } from "@shared/loan-facts";
import { currentBillDueDate } from "@shared/liability-recurrence";
import { deriveScheduleFields, resolveLiabilityDueDate } from "@shared/liability-schedule";
import { lookupStoredFact } from "@shared/fact-lookup";

const TODAY = "2026-09-26";

describe("getRecordTemporalStatus — the Sept 25 regression", () => {
  const loan = { dueDay: 25, dueDate: "2026-09-25", lastPaidDate: "2026-09-20" };

  it("a loan paid this cycle is next due on the 25th of NEXT month, from the engine and from loan-facts alike", () => {
    const viaEngine = getRecordTemporalStatus({ kind: "liability", fields: loan, typeKey: "auto_loan" }, TODAY);
    expect(viaEngine.nextOccurrence).toBe("2026-10-25");
    expect(nextLoanDueDate(loan, TODAY)).toBe("2026-10-25");
    expect(viaEngine.source).toBe("loan_schedule");
    expect(viaEngine.status).toBe("upcoming");
    expect(viaEngine.dueIn).toBe(29);
    expect(viaEngine.overdueBy).toBeNull();
    expect(viaEngine.displayLabel).toBe("Due in 29d");
  });

  it("the Tier-1 chat answer for 'when is my X payment due' comes from the engine, not the raw dueDate", () => {
    const sources = {
      profiles: [{ id: "loan-1", name: "Dodge Ram Loan", type: "liability", type_key: "auto_loan", fields: loan }],
      documents: [],
      trackers: [],
      todayISO: TODAY,
    } as any;
    const out = lookupStoredFact("when is my Dodge Ram Loan due?", sources);
    expect(out.answer).toBeTruthy();
    expect(String(out.answer)).toContain("2026-10-25");
    expect(String(out.answer)).not.toContain("2026-09-25");
  });

  it("the schedule normalizer (detail page / calendar) starts at the same day", () => {
    const f = deriveScheduleFields(loan, "auto_loan", TODAY);
    expect(f.nextDueDate).toBe("2026-10-25");
    expect(f.dueDate).toBe("2026-10-25");
  });

  it("the row's type_key routes a liability the same way the explicit typeKey does", () => {
    const viaRow = getRecordTemporalStatus({ kind: "liability", fields: loan, row: { type: "liability", type_key: "auto_loan" } }, TODAY);
    expect(viaRow.nextOccurrence).toBe("2026-10-25");
  });
});

describe("getRecordTemporalStatus — bills", () => {
  it("a recurring bill answers with the occurrence still owed (F-16) and reads overdue", () => {
    // Stored date rolled forward over an unpaid September cycle.
    const bill = { frequency: "monthly", dueDate: "2026-10-15", nextDueDate: "2026-10-15", firstPaymentDate: "2026-06-15", amount: 92 };
    const r = getRecordTemporalStatus({ kind: "liability", fields: bill, typeKey: "phone_plan" }, "2026-09-20");
    expect(r.nextOccurrence).toBe(currentBillDueDate(bill, "2026-09-20"));
    expect(r.nextOccurrence).toBe("2026-09-15");
    expect(r.status).toBe("overdue");
    expect(r.overdueBy).toBe(5);
    expect(r.displayLabel).toBe("Overdue 5d");
    expect(r.source).toBe("bill_schedule");
  });

  it("a bill due today reads due_today; a moved occurrence is due on the day it moved to", () => {
    const bill = { frequency: "monthly", dueDate: "2026-09-26", nextDueDate: "2026-09-26", amount: 40 };
    expect(getRecordTemporalStatus({ kind: "liability", fields: bill, typeKey: "utility" }, TODAY)).toMatchObject({ status: "due_today", dueIn: 0, displayLabel: "Due today" });
    const moved = { ...bill, occurrences: { "2026-09-26": { movedTo: "2026-09-30" } } };
    expect(getRecordTemporalStatus({ kind: "liability", fields: moved, typeKey: "utility" }, TODAY)).toMatchObject({ status: "upcoming", nextOccurrence: "2026-09-30", dueIn: 4 });
  });

  it("Rule 14: a bill with no schedule is 'none', never last-paid + 1 month", () => {
    const bill = { frequency: "monthly", amount: 40, lastPaidDate: "2026-09-01" };
    const r = getRecordTemporalStatus({ kind: "liability", fields: bill, typeKey: "utility" }, TODAY);
    expect(r).toMatchObject({ status: "none", nextOccurrence: null, displayLabel: "Not scheduled" });
    // …and the schedule normalizer invents nothing either for a loan with only history.
    const loanOnlyHistory = { balance: 5000, monthlyPayment: 200, lastPaidDate: "2026-09-01" };
    const f = deriveScheduleFields(loanOnlyHistory, "personal_loan", TODAY);
    expect(f.dueDate).toBeUndefined();
    expect(f.nextDueDate).toBeUndefined();
    expect(getRecordTemporalStatus({ kind: "liability", fields: loanOnlyHistory, typeKey: "personal_loan" }, TODAY).status).toBe("none");
  });

  it("a one-time debt is due on its stored date", () => {
    const debt = { balance: 300, dueDate: "2026-10-01" };
    const r = getRecordTemporalStatus({ kind: "liability", fields: debt, typeKey: "medical_debt" }, TODAY);
    expect(r).toMatchObject({ nextOccurrence: "2026-10-01", source: "stored_date", status: "upcoming", dueIn: 5 });
    expect(resolveLiabilityDueDate(debt)).toBe("2026-10-01");
  });
});

describe("getRecordTemporalStatus — tasks, events, income, documents, goals, habits", () => {
  it("a task: overdue / due today / upcoming labels from one calendar-day diff", () => {
    expect(getRecordTemporalStatus({ kind: "task", row: { dueDate: "2026-09-23", status: "todo" } }, TODAY)).toMatchObject({ status: "overdue", overdueBy: 3, displayLabel: "Overdue 3d" });
    expect(getRecordTemporalStatus({ kind: "task", row: { dueDate: "2026-09-26", status: "todo" } }, TODAY)).toMatchObject({ status: "due_today", displayLabel: "Due today" });
    expect(getRecordTemporalStatus({ kind: "task", row: { dueDate: "2026-09-27", status: "todo" } }, TODAY)).toMatchObject({ status: "upcoming", dueIn: 1, displayLabel: "Due tomorrow" });
    expect(getRecordTemporalStatus({ kind: "task", row: { dueDate: "2027-01-10", status: "todo" } }, TODAY)).toMatchObject({ status: "scheduled", dueIn: 106 });
    expect(getRecordTemporalStatus({ kind: "task", row: { dueDate: "2026-09-20", status: "done" } }, TODAY).status).toBe("ended");
    expect(getRecordTemporalStatus({ kind: "task", row: { status: "todo" } }, TODAY).status).toBe("none");
  });

  it("a repeating task projects its next occurrence", () => {
    const weekly = { dueDate: "2026-09-01", status: "todo", tags: ["recur:weekly"] };
    const r = getRecordTemporalStatus({ kind: "task", row: weekly }, TODAY);
    expect(r.source).toBe("recurrence");
    expect(r.nextOccurrence).toBe("2026-09-29");
  });

  it("an event in the past is over, not overdue", () => {
    expect(getRecordTemporalStatus({ kind: "event", row: { date: "2026-09-20" } }, TODAY).status).toBe("ended");
    expect(getRecordTemporalStatus({ kind: "event", row: { date: "2026-10-02" } }, TODAY)).toMatchObject({ status: "upcoming", dueIn: 6 });
  });

  it("recurring income rolls forward from its stored date by its cadence", () => {
    const r = getRecordTemporalStatus({ kind: "income", row: { date: "2026-09-15", frequency: "monthly" } }, TODAY);
    expect(r.nextOccurrence).toBe("2026-10-15");
    expect(r.source).toBe("recurrence");
    expect(getRecordTemporalStatus({ kind: "income", row: { date: "2026-09-15", frequency: "once" } }, TODAY).status).toBe("ended");
  });

  it("a document's expiration reads as expiring / expired", () => {
    expect(getRecordTemporalStatus({ kind: "document", row: { expirationDate: "2026-10-01" } }, TODAY)).toMatchObject({ status: "upcoming", displayLabel: "Expires in 5d" });
    expect(getRecordTemporalStatus({ kind: "document", row: { expirationDate: "2026-09-01" } }, TODAY)).toMatchObject({ status: "overdue", displayLabel: "Expired 25d ago" });
  });

  it("a goal deadline and a habit's next scheduled day", () => {
    expect(getRecordTemporalStatus({ kind: "goal", row: { deadline: "2026-12-31" } }, TODAY)).toMatchObject({ status: "scheduled", nextOccurrence: "2026-12-31" });
    // 2026-09-26 is a Saturday; a Monday habit is next due on the 28th.
    expect(getRecordTemporalStatus({ kind: "habit", row: { frequency: "weekly", targetDays: [1] } }, TODAY)).toMatchObject({ nextOccurrence: "2026-09-28", source: "recurrence" });
    expect(getRecordTemporalStatus({ kind: "habit", row: { frequency: "daily" } }, TODAY)).toMatchObject({ status: "due_today" });
  });
});

describe("classifyDate", () => {
  it("uses one calendar-day diff and honours the grace window", () => {
    expect(classifyDate("2026-09-25", TODAY, "stored_date").overdueBy).toBe(1);
    expect(classifyDate("2026-07-01", TODAY, "stored_date", { graceDays: 30 }).status).toBe("ended");
    expect(classifyDate("2026-09-10", TODAY, "stored_date", { graceDays: 30 }).status).toBe("overdue");
    expect(classifyDate(null, TODAY, "stored_date").status).toBe("none");
    expect(classifyDate("2026-09-30", "not-a-day", "stored_date").status).toBe("none");
  });
});
