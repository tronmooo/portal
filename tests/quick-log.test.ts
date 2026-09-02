// Pins shared/quick-log.ts — the deterministic parsers behind the chat quick
// lanes and the server-written turn recap. Regression source: 2026-09-01
// report, "ran 2 miles" acknowledged in chat but absent from the Running
// history (the lane wrote to another profile's tracker).
import { describe, it, expect } from "vitest";
import {
  parseQuickRun,
  parseQuickSleep,
  parseQuickWeight,
  parseDurationMinutes,
  buildTurnRecap,
} from "@shared/quick-log";

describe("parseQuickRun", () => {
  it("accepts the reported message and its natural first-person forms", () => {
    for (const m of ["ran 2 miles", "I ran 2 miles", "i just ran 2 mi", "Ran 2 miles today.", "I ran 2 miles this morning"]) {
      expect(parseQuickRun(m), m).toEqual({ values: { distance: 2 }, label: "2 mi" });
    }
  });

  it("parses a time as minutes and km as distanceKm", () => {
    expect(parseQuickRun("ran 3.1 miles in 28:30")).toEqual({ values: { distance: 3.1, duration: 28.5 }, label: "3.1 mi" });
    expect(parseQuickRun("I ran 2 miles in 20 min")).toEqual({ values: { distance: 2, duration: 20 }, label: "2 mi" });
    expect(parseQuickRun("jogged 5 km")).toEqual({ values: { distanceKm: 5 }, label: "5 km" });
  });

  it("refuses anything that carries context a regex would drop", () => {
    for (const m of [
      "ran 2 miles with Sarah",
      "Sarah ran 2 miles",
      "ran 2 miles yesterday",
      "ran 2 miles and ate a sandwich",
      "I ran 2 miles at 7am",
      "did I run 2 miles?",
      "ran out of milk",
    ]) {
      expect(parseQuickRun(m), m).toBeNull();
    }
  });
});

describe("parseDurationMinutes", () => {
  it("handles mm:ss, h:mm:ss, minutes and hours", () => {
    expect(parseDurationMinutes("25:00")).toBe(25);
    expect(parseDurationMinutes("1:05:30")).toBe(65.5);
    expect(parseDurationMinutes("20 min")).toBe(20);
    expect(parseDurationMinutes("1.5 hours")).toBe(90);
    expect(parseDurationMinutes("soon")).toBeNull();
  });
});

describe("parseQuickSleep", () => {
  it("accepts plain sleep reports", () => {
    expect(parseQuickSleep("slept 7 hours")).toEqual({ hours: 7 });
    expect(parseQuickSleep("I slept 6.5 hrs last night")).toEqual({ hours: 6.5 });
    expect(parseQuickSleep("sleep 8")).toEqual({ hours: 8 });
  });
  it("leaves annotated reports to the model", () => {
    expect(parseQuickSleep("slept 7 hours but woke up twice")).toBeNull();
    expect(parseQuickSleep("slept 30 hours")).toBeNull();
  });
});

describe("parseQuickWeight", () => {
  it("accepts explicit weight phrasings", () => {
    expect(parseQuickWeight("weight 183")).toEqual({ weight: 183, explicit: true });
    expect(parseQuickWeight("I weigh 182.5 lbs")).toEqual({ weight: 182.5, explicit: true });
    expect(parseQuickWeight("weighed 180 pounds today")).toEqual({ weight: 180, explicit: true });
  });
  it("only takes a bare number when a weight tracker already exists", () => {
    expect(parseQuickWeight("183")).toBeNull();
    expect(parseQuickWeight("183", { allowBare: true })).toEqual({ weight: 183, explicit: false });
    expect(parseQuickWeight("183 lbs", { allowBare: true })).toEqual({ weight: 183, explicit: false });
  });
  it("rejects out-of-range values", () => {
    expect(parseQuickWeight("weight 40")).toBeNull();
    expect(parseQuickWeight("weight 900")).toBeNull();
  });
});

describe("buildTurnRecap", () => {
  it("a single successful log is one sentence with estimates labelled", () => {
    const text = buildTurnRecap([{
      status: "ok", tool: "log_tracker_entry", label: "Running", detail: "distance 2",
      estimateNote: "Derived/estimated (tell the user estimates are estimates): ≈3,137 steps, ≈20 min (estimated)",
    }]);
    expect(text).toBe("Logged: Running — distance 2 (≈3,137 steps, ≈20 min (estimated))");
  });

  it("enumerates several operations and names created trackers and failures", () => {
    const text = buildTurnRecap([
      { status: "ok", tool: "log_tracker_entry", label: "Nutrition", detail: "item Chicken Sandwich, calories 430" },
      { status: "ok", tool: "log_tracker_entry", label: "Soccer", detail: "duration 30", createdTrackerName: "Soccer" },
      { status: "failed", tool: "create_expense", label: "Coffee", error: "amount missing" },
    ]);
    expect(text).toContain("Logged 2 of 3:");
    expect(text).toContain("✅ Logged: Nutrition — item Chicken Sandwich, calories 430");
    expect(text).toContain("Created a new tracker: Soccer.");
    expect(text).toContain("⚠️ Coffee — amount missing");
  });

  it("reports a dedup honestly instead of as a second write", () => {
    const text = buildTurnRecap([{ status: "deduped", tool: "log_tracker_entry", label: "Running" }]);
    expect(text).toContain("already logged just now");
    expect(text).not.toContain("Logged:");
  });
});
