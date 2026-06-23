import { describe, it, expect } from "vitest";
import { normalizeTrackerEntry, parseClockTime } from "../server/tracker-normalize";

// Regression for the reported bug: "I slept from 11 PM to 5:30 AM" logged
// "5:30 AM" into the Sleep tracker's hours field (a clock time, not a
// duration) and dropped quality. Root cause: the normalizer force-mapped any
// stray field onto the lone numeric field, and never computed sleep duration.

const sleepTracker = {
  name: "Sleep",
  category: "health",
  unit: "hr",
  fields: [
    { name: "hours", type: "number", unit: "hr", isPrimary: true },
    { name: "quality", type: "text" },
  ],
} as any;

const tempTracker = {
  name: "Body Temperature",
  category: "health",
  unit: "F",
  fields: [{ name: "value", type: "number", unit: "F" }],
} as any;

describe("parseClockTime", () => {
  it("parses 12-hour and 24-hour clock strings", () => {
    expect(parseClockTime("11:00 PM")).toBe(23 * 60);
    expect(parseClockTime("5:30 AM")).toBe(5 * 60 + 30);
    expect(parseClockTime("12:00 AM")).toBe(0);
    expect(parseClockTime("12:00 PM")).toBe(12 * 60);
    expect(parseClockTime("23:00")).toBe(23 * 60);
    expect(parseClockTime("not a time")).toBeNull();
    expect(parseClockTime("6.5")).toBeNull(); // a decimal duration is not a clock time
    expect(parseClockTime(23)).toBe(23 * 60); // bare 24h hour as a number
  });
});

describe("normalizeTrackerEntry — sleep duration (the reported bug)", () => {
  it("computes hours from a bedtime/waketime range and keeps secondaries", () => {
    const { values } = normalizeTrackerEntry(sleepTracker, {
      bedtime: "11:00 PM", wakeTime: "5:30 AM", quality: "fair",
    });
    expect(values.hours).toBe(6.5);          // 11pm → 5:30am = 6.5h, not "5:30 AM"
    expect(values.quality).toBe("fair");      // secondary characteristic preserved
    expect(values.bedtime).toBe("11:00 PM");
    expect(values.wakeTime).toBe("5:30 AM");
  });

  it("never leaves a clock time sitting in the numeric hours field", () => {
    // AI mistakenly puts the wake time directly in hours.
    const { values } = normalizeTrackerEntry(sleepTracker, { hours: "5:30 AM" });
    expect(values.hours).toBeUndefined();     // not the corrupted "5:30 AM"
    expect(values.wakeTime).toBe("5:30 AM");  // moved out of the headline field
  });

  it("honors an explicit numeric hours value", () => {
    const { values } = normalizeTrackerEntry(sleepTracker, { hours: 6.5, quality: "fair" });
    expect(values.hours).toBe(6.5);
    expect(values.quality).toBe("fair");
  });
});

describe("normalizeTrackerEntry — generic value maps to the primary field", () => {
  const hydration = {
    name: "Hydration", category: "health", unit: "oz",
    fields: [
      { name: "ounces", type: "number", unit: "oz", isPrimary: true },
      { name: "glasses", type: "number" },
    ],
  } as any;

  it("maps a generic 'amount' onto the primary numeric field (the 0 oz bug)", () => {
    // "drank 24 ounces" → AI logs {amount:24}; must land on ounces, not a stray.
    const { values } = normalizeTrackerEntry(hydration, { amount: 24 });
    expect(values.ounces).toBe(24);
    expect(values.amount).toBeUndefined();
  });

  it("strips a unit suffix while mapping ('24 oz' → 24 on ounces)", () => {
    const { values } = normalizeTrackerEntry(hydration, { amount: "24 oz" });
    expect(values.ounces).toBe(24);
  });

  it("does not hijack a non-numeric generic value", () => {
    const { values } = normalizeTrackerEntry(hydration, { amount: "a lot" });
    expect(values.ounces).toBeUndefined();
    expect(values.amount).toBe("a lot");
  });
});

describe("normalizeTrackerEntry — single-numeric mapping is value-aware", () => {
  it("still maps a numeric stray onto the lone numeric field", () => {
    const { values } = normalizeTrackerEntry(tempTracker, { temperature: "99°F" });
    expect(values.value).toBe(99);
  });

  it("does NOT map a NON-numeric stray onto the lone numeric field", () => {
    // Previously "mood: happy" would clobber value="happy"; now it's preserved.
    const { values } = normalizeTrackerEntry(tempTracker, { mood: "happy" });
    expect(values.value).toBeUndefined();
    expect(values.mood).toBe("happy");
  });
});
