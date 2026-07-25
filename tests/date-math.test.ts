import { describe, it, expect } from "vitest";
import {
  daysInMonth,
  addMonthsClamped,
  addYearsClamped,
  addMonthsISO,
  addYearsISO,
  addDaysISO,
  advanceISO,
  monthsPerCycle,
  parseISODate,
  toISODate,
} from "@shared/date-math";

describe("daysInMonth", () => {
  it("knows month lengths including December (month index 11)", () => {
    expect(daysInMonth(2026, 0)).toBe(31); // Jan
    expect(daysInMonth(2026, 3)).toBe(30); // Apr
    expect(daysInMonth(2026, 11)).toBe(31); // Dec — the month+1 rollover case
  });
  it("handles leap years", () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
  });
});

describe("addMonthsISO — the Netflix 'day 31' bug", () => {
  // Reported: a series labelled "Monthly on day 31" whose next occurrence was
  // August 1. Naive setMonth turns May 31 into July 1 (June 31 overflows).
  it("clamps May 31 + 1 month to June 30, not July 1", () => {
    expect(addMonthsISO("2026-05-31", 1)).toBe("2026-06-30");
  });

  it("does not drift: every step is anchored to the base day-of-month", () => {
    const base = "2026-05-31";
    expect(addMonthsISO(base, 0)).toBe("2026-05-31");
    expect(addMonthsISO(base, 1)).toBe("2026-06-30"); // clamped
    expect(addMonthsISO(base, 2)).toBe("2026-07-31"); // back to the 31st
    expect(addMonthsISO(base, 3)).toBe("2026-08-31"); // the reported case
    expect(addMonthsISO(base, 4)).toBe("2026-09-30"); // clamped
    expect(addMonthsISO(base, 5)).toBe("2026-10-31");
  });

  it("clamps Jan 31 into February in both leap and non-leap years", () => {
    expect(addMonthsISO("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsISO("2028-01-31", 1)).toBe("2028-02-29");
  });

  it("keeps an explicit anchor day when stepping from an already-clamped date", () => {
    // Walking a series one step at a time from June 30 must still land on the
    // 31st, which requires passing the base anchor.
    expect(addMonthsISO("2026-06-30", 1, 31)).toBe("2026-07-31");
    expect(addMonthsISO("2026-06-30", 1)).toBe("2026-07-30"); // no anchor → 30th
  });

  it("steps backwards with the same clamping", () => {
    expect(addMonthsISO("2026-03-31", -1)).toBe("2026-02-28");
  });

  it("crosses the year boundary", () => {
    expect(addMonthsISO("2026-12-31", 1)).toBe("2027-01-31");
    expect(addMonthsISO("2026-01-15", -1)).toBe("2025-12-15");
  });

  it("leaves ordinary mid-month dates alone", () => {
    expect(addMonthsISO("2026-07-15", 1)).toBe("2026-08-15");
    expect(addMonthsISO("2026-07-15", 6)).toBe("2027-01-15");
  });

  it("returns malformed input unchanged instead of producing Invalid Date", () => {
    expect(addMonthsISO("", 1)).toBe("");
    expect(addMonthsISO("not-a-date", 1)).toBe("not-a-date");
  });
});

describe("addYearsISO", () => {
  it("clamps Feb 29 to Feb 28 in a non-leap year", () => {
    expect(addYearsISO("2028-02-29", 1)).toBe("2029-02-28");
  });
  it("returns to Feb 29 on the next leap year when anchored", () => {
    expect(addYearsISO("2028-02-29", 4)).toBe("2032-02-29");
  });
  it("handles ordinary birthdays", () => {
    expect(addYearsISO("2026-07-15", 1)).toBe("2027-07-15");
  });
});

describe("addMonthsClamped / addYearsClamped (Date form)", () => {
  it("does not mutate the input date", () => {
    const d = new Date("2026-05-31T00:00:00");
    const before = d.getTime();
    addMonthsClamped(d, 1);
    expect(d.getTime()).toBe(before);
  });
  it("preserves time-of-day", () => {
    const d = new Date("2026-05-31T14:30:00");
    const out = addMonthsClamped(d, 1);
    expect(out.getHours()).toBe(14);
    expect(out.getMinutes()).toBe(30);
  });
  it("addYearsClamped matches a 12-month step", () => {
    const d = new Date("2028-02-29T00:00:00");
    expect(toISODate(addYearsClamped(d, 1))).toBe("2029-02-28");
  });
});

describe("advanceISO", () => {
  it("advances each supported frequency by one cycle", () => {
    expect(advanceISO("2026-07-15", "daily")).toBe("2026-07-16");
    expect(advanceISO("2026-07-15", "weekly")).toBe("2026-07-22");
    expect(advanceISO("2026-07-15", "biweekly")).toBe("2026-07-29");
    expect(advanceISO("2026-07-15", "monthly")).toBe("2026-08-15");
    expect(advanceISO("2026-07-15", "quarterly")).toBe("2026-10-15");
    expect(advanceISO("2026-07-15", "yearly")).toBe("2027-07-15");
  });

  it("clamps month-based frequencies", () => {
    expect(advanceISO("2026-05-31", "monthly")).toBe("2026-06-30");
    expect(advanceISO("2026-05-31", "quarterly")).toBe("2026-08-31");
    expect(advanceISO("2026-11-30", "quarterly", 31)).toBe("2027-02-28");
  });

  it("skips to weekdays / weekends", () => {
    // 2026-07-24 is a Friday.
    expect(advanceISO("2026-07-24", "weekdays")).toBe("2026-07-27"); // Monday
    expect(advanceISO("2026-07-24", "weekends")).toBe("2026-07-25"); // Saturday
  });

  it("treats unknown or absent frequencies as non-recurring", () => {
    expect(advanceISO("2026-07-15", "none")).toBe("2026-07-15");
    expect(advanceISO("2026-07-15", undefined)).toBe("2026-07-15");
    expect(advanceISO("2026-07-15", "sporadically")).toBe("2026-07-15");
  });
});

describe("monthsPerCycle", () => {
  it("maps month-based frequencies and rejects the rest", () => {
    expect(monthsPerCycle("monthly")).toBe(1);
    expect(monthsPerCycle("quarterly")).toBe(3);
    expect(monthsPerCycle("yearly")).toBe(12);
    expect(monthsPerCycle("weekly")).toBe(0);
    expect(monthsPerCycle(null)).toBe(0);
  });
});

describe("parseISODate / addDaysISO", () => {
  it("parses at local midnight and rejects malformed input", () => {
    expect(parseISODate("2026-07-15")?.getDate()).toBe(15);
    expect(parseISODate("2026-7-5")).toBeNull();
    expect(parseISODate(null)).toBeNull();
  });
  it("adds days across a month boundary", () => {
    expect(addDaysISO("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDaysISO("2026-03-01", -1)).toBe("2026-02-28");
  });
});
