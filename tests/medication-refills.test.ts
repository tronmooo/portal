import { describe, it, expect } from "vitest";
import { computeRefillSchedule, parseFrequencyToDosesPerDay } from "../shared/medication-refills";

// Pins the Lisinopril example: 10mg once daily, started Jan 1, 30 pills × 5
// refills → reminders ~3 days before each 30-day supply runs out, course ends
// ~July 1. (The reported bug: no reminders were ever created.)

describe("parseFrequencyToDosesPerDay", () => {
  it("reads common frequencies", () => {
    expect(parseFrequencyToDosesPerDay("once daily")).toBe(1);
    expect(parseFrequencyToDosesPerDay("twice a day")).toBe(2);
    expect(parseFrequencyToDosesPerDay("three times daily")).toBe(3);
    expect(parseFrequencyToDosesPerDay(undefined)).toBe(1);
  });
});

describe("computeRefillSchedule — Lisinopril 30 pills × 5 refills from Jan 1", () => {
  const s = computeRefillSchedule({ startDate: "2026-01-01", pillsPerFill: 30, refills: 5, dosesPerDay: 1 });

  it("computes a 30-day supply per fill", () => {
    expect(s.supplyDaysPerFill).toBe(30);
  });

  it("creates one reminder per refill, 3 days before each run-out", () => {
    expect(s.reminders.map(r => r.date)).toEqual([
      "2026-01-28", // 30 - 3
      "2026-02-27", // 60 - 3
      "2026-03-29", // 90 - 3
      "2026-04-28", // 120 - 3
      "2026-05-28", // 150 - 3
    ]);
    expect(s.reminders.map(r => r.fillNumber)).toEqual([1, 2, 3, 4, 5]);
  });

  it("ends the ~6-month course around July 1", () => {
    expect(s.courseEndDate).toBe("2026-06-30"); // 180 days after Jan 1
  });
});

describe("computeRefillSchedule — twice-daily halves the supply window", () => {
  it("30 pills at 2/day = 15-day supply", () => {
    const s = computeRefillSchedule({ startDate: "2026-01-01", pillsPerFill: 30, refills: 2, dosesPerDay: 2, leadDays: 0 });
    expect(s.supplyDaysPerFill).toBe(15);
    expect(s.reminders.map(r => r.date)).toEqual(["2026-01-16", "2026-01-31"]);
  });
});

describe("computeRefillSchedule — no refills means no reminders", () => {
  it("returns an empty reminder list", () => {
    const s = computeRefillSchedule({ startDate: "2026-01-01", pillsPerFill: 30, refills: 0 });
    expect(s.reminders).toEqual([]);
    expect(s.courseEndDate).toBe("2026-01-31");
  });
});
