// Pins DST-stable wall-clock arithmetic.
//
// QA report 2026-07-25: "Reminder times change from 2:00 AM to 1:00 AM after
// daylight-saving transitions."
//
// A calendar day is not 86,400,000 ms — the US fall-back day is 25 hours — so
// a series built by adding a fixed duration slides an hour on the wall clock.
// "Every day at 2 AM" is a wall-clock promise; these helpers keep it.
import { describe, it, expect } from "vitest";
import { getZonedParts, zonedTimeToUTC, addZonedDays } from "../shared/timezone";

const LA = "America/Los_Angeles";
const NY = "America/New_York";
const UTC = "UTC";
const PHX = "America/Phoenix"; // no DST

// US DST 2026: forward Sun Mar 8, back Sun Nov 1.
const localTime = (d: Date, tz: string) =>
  d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
const localDate = (d: Date, tz: string) => d.toLocaleDateString("en-CA", { timeZone: tz });

describe("addZonedDays holds the wall clock across DST", () => {
  it("keeps a 2:00 AM daily reminder at 2:00 AM through fall-back", () => {
    // Oct 30 2026, 02:00 local — two days before the Nov 1 transition.
    const start = zonedTimeToUTC("2026-10-30", 2, 0, LA);
    expect(localTime(start, LA)).toBe("02:00");
    for (let i = 0; i <= 5; i++) {
      const occ = addZonedDays(start, i, LA);
      expect(localTime(occ, LA)).toBe("02:00");
    }
    // The occurrence AFTER the transition is the one that used to drift to 1 AM.
    const after = addZonedDays(start, 3, LA);
    expect(localDate(after, LA)).toBe("2026-11-02");
    expect(localTime(after, LA)).toBe("02:00");
  });

  it("holds the wall clock through spring-forward, resolving the gap forward", () => {
    // 2026-03-08 is the spring-forward day in LA: 02:00 does not exist, the
    // clock jumps 02:00 -> 03:00. Every other day stays at 02:00, and the gap
    // day resolves FORWARD to 03:00 rather than backward to 01:00.
    const start = zonedTimeToUTC("2026-03-06", 2, 0, LA);
    const got = [0, 1, 2, 3, 4].map(i => {
      const occ = addZonedDays(start, i, LA);
      return [localDate(occ, LA), localTime(occ, LA)];
    });
    expect(got).toEqual([
      ["2026-03-06", "02:00"],
      ["2026-03-07", "02:00"],
      ["2026-03-08", "03:00"], // the skipped hour, resolved forward
      ["2026-03-09", "02:00"], // and the series recovers immediately
      ["2026-03-10", "02:00"],
    ]);
  });

  it("picks the first occurrence of an ambiguous fall-back time", () => {
    // 01:30 happens twice on 2026-11-01 in LA. The earlier (PDT) instant wins.
    const d = zonedTimeToUTC("2026-11-01", 1, 30, LA);
    expect(localTime(d, LA)).toBe("01:30");
    expect(d.toISOString()).toBe("2026-11-01T08:30:00.000Z"); // PDT, not PST
  });

  it("shows the fixed-millisecond approach really does drift", () => {
    // Pins the ROOT CAUSE so nobody reintroduces `instant + n * 86400000`.
    const start = zonedTimeToUTC("2026-10-30", 2, 0, LA);
    const naive = new Date(start.getTime() + 3 * 86_400_000);
    expect(localTime(naive, LA)).toBe("01:00"); // exactly the reported symptom
    expect(localTime(addZonedDays(start, 3, LA), LA)).toBe("02:00");
  });

  it("advances the calendar date by exactly one day each step", () => {
    const start = zonedTimeToUTC("2026-10-30", 2, 0, LA);
    expect([0, 1, 2, 3, 4].map(i => localDate(addZonedDays(start, i, LA), LA))).toEqual([
      "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03",
    ]);
  });

  it("works in a zone with no DST and in UTC", () => {
    for (const tz of [PHX, UTC]) {
      const start = zonedTimeToUTC("2026-10-30", 2, 0, tz);
      for (let i = 0; i <= 4; i++) expect(localTime(addZonedDays(start, i, tz), tz)).toBe("02:00");
    }
  });

  it("rolls extra minutes into the next day for multi-dose schedules", () => {
    // "Twice daily starting 8 PM": slot 2 is 8 AM the NEXT day.
    const start = zonedTimeToUTC("2026-07-15", 20, 0, LA);
    const slot0 = addZonedDays(start, 0, LA, 0);
    const slot1 = addZonedDays(start, 0, LA, 12 * 60);
    expect(localTime(slot0, LA)).toBe("20:00");
    expect(localDate(slot0, LA)).toBe("2026-07-15");
    expect(localTime(slot1, LA)).toBe("08:00");
    expect(localDate(slot1, LA)).toBe("2026-07-16");
  });

  it("keeps a weekly series on the same weekday and time across a transition", () => {
    const start = zonedTimeToUTC("2026-10-21", 2, 0, NY);
    const later = addZonedDays(start, 21, NY); // crosses Nov 1
    expect(localTime(later, NY)).toBe("02:00");
    expect(localDate(later, NY)).toBe("2026-11-11");
  });
});

describe("getZonedParts / zonedTimeToUTC round-trip", () => {
  it("round-trips a wall-clock time through a UTC instant", () => {
    for (const tz of [LA, NY, UTC, PHX, "Europe/London", "Asia/Tokyo", "Australia/Sydney"]) {
      const instant = zonedTimeToUTC("2026-07-15", 14, 30, tz);
      const parts = getZonedParts(instant, tz);
      expect(parts).toEqual({ date: "2026-07-15", hours: 14, minutes: 30 });
    }
  });

  it("round-trips on both sides of a transition", () => {
    for (const date of ["2026-10-31", "2026-11-02", "2026-03-07", "2026-03-09"]) {
      const parts = getZonedParts(zonedTimeToUTC(date, 2, 0, LA), LA);
      expect(parts).toEqual({ date, hours: 2, minutes: 0 });
    }
  });

  it("reads midnight as hour 0, not 24", () => {
    expect(getZonedParts(zonedTimeToUTC("2026-07-15", 0, 0, LA), LA).hours).toBe(0);
  });
});
