// Pins shared/income-schedule.ts — the income occurrence engine.
//
// Income is the positive mirror of a liability, so these tests mirror the ones
// that pin shared/liability-schedule: a series generates its dates from an
// anchor, per-occurrence exceptions override individual dates, and the
// expected-vs-received split is never blurred.

import { describe, it, expect } from "vitest";
import {
  generateIncomeSchedule,
  incomeOccurrenceDates,
  nextExpectedOccurrence,
  lastReceivedOccurrence,
  totalIncomeOccurrences,
  normalizeIncomeFrequency,
  normalizeEditScope,
  incomePeriodsPerYear,
  describeIncomeSchedule,
  semimonthlyDays,
  type Incomeish,
} from "@shared/income-schedule";

const TODAY = "2026-08-10";

const paycheck = (over: Partial<Incomeish> = {}): Incomeish => ({
  id: "inc-1",
  amount: 2400,
  frequency: "biweekly",
  startDate: "2026-08-07", // a Friday
  ...over,
});

describe("frequency normalization", () => {
  it("canonicalizes the spellings users and the AI actually send", () => {
    expect(normalizeIncomeFrequency("bi-weekly")).toBe("biweekly");
    expect(normalizeIncomeFrequency("every other week")).toBe("biweekly");
    expect(normalizeIncomeFrequency("Twice a month")).toBe("semimonthly");
    expect(normalizeIncomeFrequency("one-time")).toBe("once");
    expect(normalizeIncomeFrequency("annually")).toBe("yearly");
    expect(normalizeIncomeFrequency("every-3-weeks")).toBe("every-3-weeks");
    // Unknown tokens fall back to monthly rather than generating nothing.
    expect(normalizeIncomeFrequency("whenever")).toBe("monthly");
    expect(normalizeIncomeFrequency(null)).toBe("monthly");
  });

  it("annualizes each cadence", () => {
    expect(incomePeriodsPerYear("biweekly")).toBe(26);
    expect(incomePeriodsPerYear("semimonthly")).toBe(24);
    expect(incomePeriodsPerYear("monthly")).toBe(12);
    expect(incomePeriodsPerYear("quarterly")).toBe(4);
    // A one-time income has no annual rate — it happens once.
    expect(incomePeriodsPerYear("once")).toBe(0);
  });
});

describe("occurrence generation", () => {
  it("every other Friday stays on Fridays", () => {
    const dates = incomeOccurrenceDates(paycheck(), "2026-08-01", "2026-10-01");
    expect(dates).toEqual([
      "2026-08-07", "2026-08-21", "2026-09-04", "2026-09-18",
    ]);
    for (const d of dates) {
      expect(new Date(`${d}T00:00:00`).getDay()).toBe(5); // Friday
    }
  });

  it("monthly on the 31st clamps to short months and returns to the 31st", () => {
    const dates = incomeOccurrenceDates(
      paycheck({ frequency: "monthly", startDate: "2026-01-31" }),
      "2026-01-01", "2026-05-01",
    );
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("twice a month pays two dates each month", () => {
    const inc = paycheck({ frequency: "semimonthly", startDate: "2026-08-01" });
    expect(semimonthlyDays(inc, "2026-08-01")).toEqual([1, 16]);
    const dates = incomeOccurrenceDates(inc, "2026-08-01", "2026-09-30");
    expect(dates).toEqual(["2026-08-01", "2026-08-16", "2026-09-01", "2026-09-16"]);
  });

  it("a one-time income produces exactly one date", () => {
    const dates = incomeOccurrenceDates(
      paycheck({ frequency: "once", startDate: "2026-08-20", amount: 5000 }),
      "2026-01-01", "2027-01-01",
    );
    expect(dates).toEqual(["2026-08-20"]);
  });

  it("stops at recurrenceEnd and at a fixed count", () => {
    expect(incomeOccurrenceDates(
      paycheck({ recurrenceEnd: "2026-09-01" }), "2026-08-01", "2026-12-01",
    )).toEqual(["2026-08-07", "2026-08-21"]);

    expect(incomeOccurrenceDates(
      paycheck({ fields: { count: 3 } }), "2026-08-01", "2026-12-01",
    )).toEqual(["2026-08-07", "2026-08-21", "2026-09-04"]);
  });

  it("an income with no date at all generates nothing rather than guessing", () => {
    expect(incomeOccurrenceDates({ id: "x", amount: 100, frequency: "monthly" }, "2026-08-01", "2026-12-01"))
      .toEqual([]);
  });
});

describe("expected vs received", () => {
  it("future occurrences are expected, past unpaid ones are overdue", () => {
    const sched = generateIncomeSchedule(paycheck(), [], {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-08-31",
    });
    const byDate = Object.fromEntries(sched.map(o => [o.date, o.status]));
    expect(byDate["2026-08-07"]).toBe("overdue"); // before today, nothing received
    expect(byDate["2026-08-21"]).toBe("expected");
  });

  it("marks due_today on the day itself", () => {
    const sched = generateIncomeSchedule(
      paycheck({ frequency: "monthly", startDate: TODAY }), [],
      { todayISO: TODAY, windowStart: TODAY, windowEnd: TODAY },
    );
    expect(sched[0].status).toBe("due_today");
  });

  it("a receipt turns an occurrence into received money", () => {
    const receipts = [{ id: "r1", occurrenceDate: "2026-08-07", receivedDate: "2026-08-07", amount: 2400 }];
    const sched = generateIncomeSchedule(paycheck(), receipts, {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-08-31",
    });
    const first = sched.find(o => o.date === "2026-08-07")!;
    expect(first.status).toBe("received");
    expect(first.receivedAmount).toBe(2400);
    expect(first.receiptId).toBe("r1");
  });

  it("records an actual amount that differs from the expected one", () => {
    const receipts = [{ id: "r1", occurrenceDate: "2026-08-07", receivedDate: "2026-08-08", amount: 2380 }];
    const [first] = generateIncomeSchedule(paycheck(), receipts, {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-08-14",
    });
    expect(first.amount).toBe(2400);        // what was planned
    expect(first.receivedAmount).toBe(2380); // what actually arrived
    expect(first.receivedDate).toBe("2026-08-08");
  });
});

describe("per-occurrence exceptions", () => {
  it("skips one date without touching the rest of the series", () => {
    const inc = paycheck({ fields: { occurrences: { "2026-08-21": { status: "skipped" } } } });
    const sched = generateIncomeSchedule(inc, [], {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-09-30",
    });
    expect(sched.find(o => o.date === "2026-08-21")!.status).toBe("skipped");
    expect(sched.find(o => o.date === "2026-09-04")!.status).toBe("expected");
  });

  it("reschedules one occurrence, leaving the cadence intact", () => {
    const inc = paycheck({ fields: { occurrences: { "2026-08-21": { movedTo: "2026-08-24" } } } });
    const sched = generateIncomeSchedule(inc, [], {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-09-30",
    });
    const moved = sched.find(o => o.date === "2026-08-21")!;
    expect(moved.effectiveDate).toBe("2026-08-24");
    expect(moved.overridden).toBe(true);
    // The following occurrence is still on the original grid.
    expect(sched.find(o => o.date === "2026-09-04")).toBeTruthy();
  });

  it("re-prices a single occurrence", () => {
    const inc = paycheck({ fields: { occurrences: { "2026-08-21": { amount: 2600 } } } });
    const sched = generateIncomeSchedule(inc, [], {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-09-30",
    });
    expect(sched.find(o => o.date === "2026-08-21")!.amount).toBe(2600);
    expect(sched.find(o => o.date === "2026-09-04")!.amount).toBe(2400);
  });

  it("suppresses future dates while paused, keeping past ones visible", () => {
    const inc = paycheck({ fields: { paused: true, pausedUntil: "2026-09-10" } });
    const sched = generateIncomeSchedule(inc, [], {
      todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-09-30",
    });
    const dates = sched.map(o => o.effectiveDate);
    expect(dates).toContain("2026-08-07");     // already happened
    expect(dates).not.toContain("2026-08-21"); // inside the paused span
    expect(dates).toContain("2026-09-18");     // after the pause lifts
  });
});

describe("totals", () => {
  it("splits projected from received and never counts a skip", () => {
    const inc = paycheck({ fields: { occurrences: { "2026-09-04": { status: "skipped" } } } });
    const receipts = [{ id: "r1", occurrenceDate: "2026-08-07", receivedDate: "2026-08-07", amount: 2400 }];
    const totals = totalIncomeOccurrences(
      generateIncomeSchedule(inc, receipts, {
        todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-09-30",
      }),
    );
    // Aug 7 (received) + Aug 21 + Sep 18 expected; Sep 4 skipped entirely.
    expect(totals.projected).toBe(7200);
    expect(totals.received).toBe(2400);
    expect(totals.outstanding).toBe(4800);
    expect(totals.occurrenceCount).toBe(3);
    expect(totals.receivedCount).toBe(1);
  });

  it("counts a late unreceived paycheck as overdue, not as money in hand", () => {
    const totals = totalIncomeOccurrences(
      generateIncomeSchedule(paycheck(), [], {
        todayISO: TODAY, windowStart: "2026-08-01", windowEnd: "2026-08-14",
      }),
    );
    expect(totals.received).toBe(0);
    expect(totals.overdue).toBe(2400);
  });
});

describe("next / last", () => {
  it("finds the next unpaid occurrence and the last received one", () => {
    const receipts = [{ id: "r1", occurrenceDate: "2026-08-07", receivedDate: "2026-08-07", amount: 2400 }];
    expect(nextExpectedOccurrence(paycheck(), receipts, TODAY)!.date).toBe("2026-08-21");
    expect(lastReceivedOccurrence(paycheck(), receipts, TODAY)!.date).toBe("2026-08-07");
  });
});

describe("edit scope", () => {
  it("maps the phrasings a calendar and the AI both use", () => {
    expect(normalizeEditScope("future")).toBe("future");
    expect(normalizeEditScope("this_and_future")).toBe("future");
    expect(normalizeEditScope("all")).toBe("series");
    expect(normalizeEditScope("entire")).toBe("series");
    expect(normalizeEditScope(undefined)).toBe("occurrence");
  });
});

describe("human summaries", () => {
  it("describes a cadence the way a person would say it", () => {
    expect(describeIncomeSchedule(paycheck())).toBe("Every 2 weeks on Friday");
    expect(describeIncomeSchedule(paycheck({ frequency: "monthly", startDate: "2026-08-01" })))
      .toBe("Monthly on day 1");
    expect(describeIncomeSchedule(paycheck({ frequency: "once", startDate: "2026-08-20" })))
      .toBe("One-time on 2026-08-20");
  });
});
