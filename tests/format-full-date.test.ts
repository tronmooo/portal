// The one-day-off bug.
//
// Two cards on the liability page disagreed about the same due date: the hero
// said "Aug 29, 2026" and the Schedule & Calendar card directly beneath it said
// "Aug 30, 2026". Both read the same field. The hero's local `fmtDate` did
// `new Date("2026-08-30")`, which the spec says is UTC midnight — 5pm the
// previous day in Los Angeles. The schedule card appended "T00:00:00" and got
// local midnight.
//
// A stored "YYYY-MM-DD" is a CALENDAR day. It has no timezone, and turning it
// into an instant is what breaks it. These tests pin the parse.

import { describe, it, expect, beforeAll } from "vitest";
import { formatFullDate, formatListDate, parseLocalDate } from "../client/src/lib/format";

// The failure only reproduces west of Greenwich, which is why it survived: it
// is invisible in UTC. Vitest is configured with TZ unset, so set it here.
beforeAll(() => { process.env.TZ = "America/Los_Angeles"; });

describe("a bare YYYY-MM-DD is a calendar day, not an instant", () => {
  it("keeps the day the user typed", () => {
    // `new Date("2026-08-30").toLocaleDateString()` is "Aug 29" here. That is
    // the exact bug, and this is the exact case from the screenshot.
    expect(formatFullDate("2026-08-30")).toBe("Aug 30, 2026");
    expect(formatFullDate("2026-07-29")).toBe("Jul 29, 2026");
  });

  it("is the same day the old T00:00:00 spelling produced", () => {
    // The schedule card's version was correct; this must not change it.
    for (const iso of ["2026-01-01", "2026-08-30", "2026-12-31", "2027-03-14"]) {
      const legacy = new Date(iso + "T00:00:00")
        .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      expect(formatFullDate(iso), iso).toBe(legacy);
    }
  });

  it("does not mangle a full timestamp, which already carries a zone", () => {
    const d = parseLocalDate("2026-08-30T18:45:00Z")!;
    expect(d.toISOString()).toBe("2026-08-30T18:45:00.000Z");
  });

  it("survives a New Year boundary — the case that shifts the YEAR too", () => {
    expect(formatFullDate("2027-01-01")).toBe("Jan 1, 2027");
  });
});

describe("empty and malformed input", () => {
  it("renders an em-dash placeholder by default, so a row keeps its shape", () => {
    expect(formatFullDate(null)).toBe("—");
    expect(formatFullDate(undefined)).toBe("—");
    expect(formatFullDate("")).toBe("—");
    expect(formatFullDate("not a date")).toBe("—");
  });

  it("lets a caller ask for a different placeholder", () => {
    expect(formatFullDate(null, "Never")).toBe("Never");
    expect(formatFullDate(null, "")).toBe("");
  });

  it("accepts a Date as-is", () => {
    expect(formatFullDate(new Date(2026, 7, 30))).toBe("Aug 30, 2026");
  });
});

describe("formatListDate still routes through the same parse", () => {
  // It always did this correctly; the refactor moved the rule into
  // parseLocalDate and this pins that it kept the behaviour.
  it("is absolute and correct for a far-off calendar day", () => {
    expect(formatListDate("2027-03-14")).toBe("Mar 14, 2027");
  });

  it("returns empty string — not an em-dash — for nothing", () => {
    expect(formatListDate(null)).toBe("");
    expect(formatListDate("nonsense")).toBe("");
  });
});
