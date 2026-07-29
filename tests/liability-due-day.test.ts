// A calendar day has no timezone. Constructing a date from local parts and then
// serializing it with toISOString() mixes two clocks: local midnight on the
// 15th is 22:00 UTC on the 14th for any host east of UTC — which is how a
// liability with a requested due day of 15 generated a payment due August 14
// (user QA 2026-07-27). routes.ts already read the local parts back; the
// storage layer did not, and the two paths disagreeing is the bug.
import { describe, it, expect } from "vitest";
import { calendarDateStr, addDays, parseLocalDate } from "../shared/timezone";

describe("calendarDateStr", () => {
  it("reads back exactly the day that was set, regardless of host offset", () => {
    expect(calendarDateStr(new Date(2026, 7, 15))).toBe("2026-08-15");
    expect(calendarDateStr(new Date(2026, 0, 1))).toBe("2026-01-01");
    expect(calendarDateStr(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  it("survives the month-end clamp the due-day generator applies", () => {
    // Day 31 in a 28-day February: setDate(0) rolls back to the last valid day.
    const candidate = new Date(2026, 1, 31);      // → Mar 3
    if (candidate.getMonth() !== 1) candidate.setDate(0);
    expect(calendarDateStr(candidate)).toBe("2026-02-28");
  });

  it("pads single-digit months and days", () => {
    expect(calendarDateStr(new Date(2026, 4, 7))).toBe("2026-05-07");
  });
});

describe("the due-day computation itself", () => {
  // Mirrors the generator: this month if the day hasn't passed, else next.
  const nextDue = (today: Date, dueDay: number): string => {
    const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
    const targetMonth = d <= dueDay ? m : m + 1;
    const candidate = new Date(y, targetMonth, dueDay);
    if (candidate.getMonth() !== ((targetMonth) % 12 + 12) % 12) candidate.setDate(0);
    return calendarDateStr(candidate);
  };

  it("a due day of 15 lands on the 15th — never the 14th", () => {
    expect(nextDue(new Date(2026, 6, 27), 15)).toBe("2026-08-15");
    expect(nextDue(new Date(2026, 7, 1), 15)).toBe("2026-08-15");
    expect(nextDue(new Date(2026, 7, 15), 15)).toBe("2026-08-15"); // today counts
  });

  it("rolls into next year from December", () => {
    expect(nextDue(new Date(2026, 11, 20), 5)).toBe("2027-01-05");
  });
});

describe("addDays no longer round-trips through UTC", () => {
  it("keeps the calendar day it computed", () => {
    expect(addDays("2026-08-15", 1)).toBe("2026-08-16");
    expect(addDays("2026-08-15", -1)).toBe("2026-08-14");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("agrees with parseLocalDate's own reading of the result", () => {
    const out = addDays("2026-08-15", 30);
    expect(calendarDateStr(parseLocalDate(out))).toBe(out);
  });
});
