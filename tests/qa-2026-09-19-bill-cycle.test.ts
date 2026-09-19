// QA 2026-09-18 — finding F-16, read-path half.
//
// "A missed bill cycle rolls forward silently — the calendar puts QA Phone
//  Bill and Auto Insurance on Sep 15 as 'Bill Due'; every other surface says
//  Oct 15; nothing says a cycle was missed."
//
// The CREATE half is fixed in shared/registry-fields.ts (a just-passed start
// date stays the due date). This file pins the READ half: rows ALREADY stored
// with the rolled-forward date. `currentBillDueDate` treats the stored
// `dueDate` as a cache and walks back to the cycle that is still owed, so no
// SQL is needed and nothing is ever written.
//
// In-app today for every case below is FIXED at Fri 2026-09-19.
import { describe, it, expect } from "vitest";
import {
  currentBillDueDate, readDueDate, advanceLiabilityDueDate, billRecurrenceRule,
} from "../shared/liability-recurrence";
import { retreat, advance } from "../shared/recurrence";
import { liabilityBillStatus, BILL_OVERDUE_GRACE_DAYS } from "../shared/liability-status";

const TODAY = "2026-09-19";

/** The QA row: monthly bill created from a Sep 15 start, rolled to Oct 15. */
function phoneBill(extra: Record<string, any> = {}) {
  return {
    frequency: "monthly",
    amount: 85,
    firstPaymentDate: "2026-06-15",
    dueDate: "2026-10-15",
    nextDueDate: "2026-10-15",
    ...extra,
  };
}

describe("retreat — the mirror of advance", () => {
  it("steps back one cycle, clamping and honouring the anchor day", () => {
    const monthly = billRecurrenceRule("monthly");
    monthly.anchorDay = 31;
    expect(retreat("2026-03-31", monthly)).toBe("2026-02-28");
    expect(retreat("2026-02-28", monthly)).toBe("2026-01-31");
    const weekly = billRecurrenceRule("weekly");
    expect(retreat("2026-09-23", weekly)).toBe("2026-09-16");
    const yearly = billRecurrenceRule("yearly");
    expect(retreat("2027-08-15", yearly)).toBe("2026-08-15");
  });
  it("round-trips advance for every bill cadence", () => {
    for (const freq of ["monthly", "weekly", "yearly", "quarterly", "daily", "biweekly"]) {
      const rule = billRecurrenceRule(freq);
      rule.anchorDay = 15;
      expect(retreat(advance("2026-09-15", rule), rule)).toBe("2026-09-15");
    }
  });
});

describe("currentBillDueDate — a cycle rolled forward but never paid (F-16)", () => {
  it("answers with the unpaid Sep 15 cycle, not the stored Oct 15", () => {
    const f = phoneBill();
    expect(readDueDate(f)).toBe("2026-10-15"); // what the row actually stores
    expect(currentBillDueDate(f, TODAY)).toBe("2026-09-15");
  });

  it("reads as OVERDUE, not as a future bill", () => {
    const due = currentBillDueDate(phoneBill(), TODAY);
    expect(liabilityBillStatus(due, TODAY, false)).toBe("overdue");
    // …where the uncorrected stored date reads as a bill still to come.
    expect(liabilityBillStatus(readDueDate(phoneBill()), TODAY, false)).toBe("upcoming");
  });

  it("never mutates the fields it is handed", () => {
    const f = phoneBill();
    const snapshot = JSON.stringify(f);
    currentBillDueDate(f, TODAY);
    expect(JSON.stringify(f)).toBe(snapshot);
  });

  it("is idempotent — applying it to its own answer returns the same day", () => {
    const f = phoneBill();
    const once = currentBillDueDate(f, TODAY);
    expect(currentBillDueDate(f, TODAY)).toBe(once);
    expect(currentBillDueDate({ ...f, dueDate: once, nextDueDate: once }, TODAY)).toBe(once);
  });
});

describe("currentBillDueDate — where the walk stops", () => {
  it("stays on Oct 15 once Sep 15 is marked paid", () => {
    const f = phoneBill({ occurrences: { "2026-09-15": { status: "paid", amount: 85 } } });
    expect(currentBillDueDate(f, TODAY)).toBe("2026-10-15");
  });

  it("stays on Oct 15 once Sep 15 is skipped", () => {
    const f = phoneBill({ occurrences: { "2026-09-15": { status: "skipped" } } });
    expect(currentBillDueDate(f, TODAY)).toBe("2026-10-15");
  });

  it("does not walk PAST a settled cycle to an older unpaid one", () => {
    // Aug unpaid, Sep paid: October is genuinely next.
    const f = phoneBill({ occurrences: { "2026-09-15": { status: "paid" } } });
    expect(currentBillDueDate(f, TODAY)).toBe("2026-10-15");
  });

  it("leaves a cycle older than the 30-day grace window alone", () => {
    // Yearly bill (auto insurance): the Aug 15 cycle is 35 days back — past
    // the grace window, so it is history, not a bill still owed.
    const f = {
      frequency: "yearly", amount: 1200,
      firstPaymentDate: "2021-08-15", dueDate: "2027-08-15", nextDueDate: "2027-08-15",
    };
    expect(BILL_OVERDUE_GRACE_DAYS).toBe(30);
    expect(currentBillDueDate(f, TODAY)).toBe("2027-08-15");
  });

  it("walks no further back than the grace edge on a fast cadence", () => {
    // Weekly bill, nothing paid: Aug 26 is 24 days back (inside), Aug 19 is 31
    // (outside), so Aug 26 is the earliest cycle still owed.
    const f = {
      frequency: "weekly", amount: 20,
      firstPaymentDate: "2026-01-07", dueDate: "2026-09-23", nextDueDate: "2026-09-23",
    };
    expect(currentBillDueDate(f, TODAY)).toBe("2026-08-26");
  });

  it("never walks back past the series origin", () => {
    // The series starts Oct 15 — there was no September cycle to miss.
    const f = phoneBill({ firstPaymentDate: "2026-10-15" });
    expect(currentBillDueDate(f, TODAY)).toBe("2026-10-15");
    // Registry rows spell the origin `start_date` / `startDate`.
    expect(currentBillDueDate(
      { frequency: "monthly", dueDate: "2026-10-15", start_date: "2026-10-15" }, TODAY,
    )).toBe("2026-10-15");
    expect(currentBillDueDate(
      { frequency: "monthly", dueDate: "2026-10-15", startDate: "2026-10-15" }, TODAY,
    )).toBe("2026-10-15");
  });

  it("leaves a stored date that is already past or today untouched", () => {
    expect(currentBillDueDate(phoneBill({ dueDate: "2026-09-15", nextDueDate: "2026-09-15" }), TODAY)).toBe("2026-09-15");
    expect(currentBillDueDate(phoneBill({ dueDate: TODAY, nextDueDate: TODAY }), TODAY)).toBe(TODAY);
  });

  it("leaves a one-time bill unchanged", () => {
    for (const freq of ["once", "one-time", "one_time", "single"]) {
      const f = phoneBill({ frequency: freq });
      expect(currentBillDueDate(f, TODAY)).toBe("2026-10-15");
    }
  });

  it("leaves a paused or cancelled bill unchanged", () => {
    expect(currentBillDueDate(phoneBill({ paused: true }), TODAY)).toBe("2026-10-15");
    expect(currentBillDueDate(phoneBill({ status: "paused" }), TODAY)).toBe("2026-10-15");
    expect(currentBillDueDate(phoneBill({ status: "cancelled" }), TODAY)).toBe("2026-10-15");
  });

  it("leaves an ended series unchanged", () => {
    expect(currentBillDueDate(phoneBill({ recurrenceEnd: "2026-09-30" }), TODAY)).toBe("2026-10-15");
    // A finite plan whose last occurrence is settled has nothing left to owe.
    const done = phoneBill({ count: 2, occurrences: { "2026-06-15": { status: "paid" }, "2026-07-15": { status: "paid" } } });
    expect(currentBillDueDate(done, TODAY)).toBe(readDueDate(done));
  });

  it("returns a missing or malformed stored date unchanged", () => {
    expect(currentBillDueDate({ frequency: "monthly" }, TODAY)).toBe("");
    expect(currentBillDueDate(phoneBill(), "")).toBe("2026-10-15");
    expect(currentBillDueDate(null, TODAY)).toBe("");
  });
});

describe("currentBillDueDate and advanceLiabilityDueDate stay complementary", () => {
  it("paying the corrected occurrence advances to the next cycle", () => {
    const f = phoneBill();
    const owed = currentBillDueDate(f, TODAY);
    expect(owed).toBe("2026-09-15");
    // The pay path advances FROM the settled occurrence — unchanged by F-16.
    // (payBillOccurrence only advances when the stored date IS the occurrence
    // being settled, so a row still cached on Oct 15 keeps that date and the
    // stamp alone retires the September cycle.)
    expect(advanceLiabilityDueDate({ ...f, dueDate: owed, nextDueDate: owed }, owed)).toBe("2026-10-15");
    // …and once it is stamped paid, the read rule stops offering it.
    const paid = { ...f, occurrences: { "2026-09-15": { status: "paid" } } };
    expect(currentBillDueDate(paid, TODAY)).toBe("2026-10-15");
    expect(liabilityBillStatus(currentBillDueDate(paid, TODAY), TODAY, false)).toBe("upcoming");
  });

  it("quarterly and other cadences correct on their own grid", () => {
    const q = {
      frequency: "quarterly", amount: 300,
      firstPaymentDate: "2025-12-15", dueDate: "2026-12-15", nextDueDate: "2026-12-15",
    };
    expect(currentBillDueDate(q, TODAY)).toBe("2026-09-15");
    expect(liabilityBillStatus(currentBillDueDate(q, TODAY), TODAY, false)).toBe("overdue");
  });
});
