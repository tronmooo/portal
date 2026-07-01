import { describe, it, expect } from "vitest";
import {
  normalizeBillFrequency, billRecurrenceRule, readDueDate, advanceLiabilityDueDate,
} from "../shared/liability-recurrence";

describe("normalizeBillFrequency", () => {
  it("maps common labels to recur tokens", () => {
    expect(normalizeBillFrequency("Monthly")).toBe("monthly");
    expect(normalizeBillFrequency("annual")).toBe("yearly");
    expect(normalizeBillFrequency("Weekly")).toBe("weekly");
    expect(normalizeBillFrequency("quarterly")).toBe("every-3-months");
  });
  it("defaults blank to monthly", () => {
    expect(normalizeBillFrequency("")).toBe("monthly");
    expect(normalizeBillFrequency(undefined)).toBe("monthly");
  });
});

describe("billRecurrenceRule", () => {
  it("builds a monthly rule", () => {
    expect(billRecurrenceRule("monthly")).toMatchObject({ unit: "month", interval: 1 });
  });
  it("builds a quarterly rule", () => {
    expect(billRecurrenceRule("quarterly")).toMatchObject({ unit: "month", interval: 3 });
  });
});

describe("readDueDate", () => {
  it("reads any known due-date field", () => {
    expect(readDueDate({ dueDate: "2026-07-15" })).toBe("2026-07-15");
    expect(readDueDate({ nextDueDate: "2026-08-01" })).toBe("2026-08-01");
    expect(readDueDate({ renewalDate: "2026-09-09T00:00:00Z" })).toBe("2026-09-09");
    expect(readDueDate({})).toBe("");
  });
});

describe("advanceLiabilityDueDate", () => {
  it("advances a future monthly due date by one month", () => {
    const next = advanceLiabilityDueDate({ dueDate: "2026-07-15", frequency: "monthly" }, "2026-07-01");
    expect(next).toBe("2026-08-15");
  });
  it("rolls a stale past due date forward past today", () => {
    // A bill last due Jan 10 but scanned in July should land on a future date.
    const next = advanceLiabilityDueDate({ dueDate: "2026-01-10", frequency: "monthly" }, "2026-07-01");
    expect(next >= "2026-07-01").toBe(true);
  });
  it("defaults missing frequency to monthly and missing date to today", () => {
    const next = advanceLiabilityDueDate({}, "2026-07-01");
    expect(next).toBe("2026-08-01");
  });
});
