// Consistency layer — health classification (req. tests 14, 15).
import { describe, expect, it } from "vitest";
import { classifyReading, classifyBloodPressureReading, restingHeartRate, referenceRangeFor, contextTrend, readingFromTrackerEntry } from "../shared/domain";

describe("14. Health readings use correct reference ranges", () => {
  it("diastolic 76 is Normal against '< 80', even when the pair reads Elevated", () => {
    const bp = classifyBloodPressureReading(121, 76);
    expect(bp.diastolic.label).toBe("Normal");
    expect(bp.diastolic.reference?.high).toBe(79);
    expect(bp.systolic.label).toBe("Elevated");
    expect(bp.overallLabel).toBe("Elevated");
  });
  it("the displayed range and the classification come from one source, and a special label carries its rule", () => {
    const ref = referenceRangeFor("heart_rate");
    expect(ref?.text).toBe("60–100 bpm");
    const v = classifyReading({ value: 58, timestamp: "2026-09-22T07:00:00Z", measurementType: "heart_rate", activityContext: "resting" });
    expect(v.reference?.text).toBe("60–100 bpm");
    expect(v.label).toBe("Athletic");
    expect(v.concern).toBe(false);
    expect(v.rule).toMatch(/trained heart/);
    expect(classifyReading({ value: 75, timestamp: "", measurementType: "heart_rate", activityContext: "resting" }).label).toBe("Normal");
    expect(classifyReading({ value: 110, timestamp: "", measurementType: "heart_rate", activityContext: "resting" })).toMatchObject({ label: "High", concern: true });
  });
});

describe("15. Workout heart rate is not mixed with resting heart rate", () => {
  const readings = [
    { value: 58, timestamp: "2026-09-22T07:00:00Z", measurementType: "heart_rate", activityContext: "resting" as const },
    { value: 171, timestamp: "2026-09-22T18:00:00Z", measurementType: "heart_rate", activityContext: "workout" as const },
    { value: 62, timestamp: "2026-09-21T07:00:00Z", measurementType: "heart_rate", note: "morning" },
  ];
  it("resting metrics exclude the 171 bpm workout peak", () => {
    const r = restingHeartRate(readings);
    expect(r.average).toBe(60);
    expect(r.countExcluded).toBe(1);
    expect(r.verdict?.label).toBe("Athletic");
  });
  it("a workout reading is labelled by context, not judged against the resting range", () => {
    const v = classifyReading(readings[1]);
    expect(v.label).toBe("Workout");
    expect(v.concern).toBe(false);
  });
  it("context is stored with every reading built from a tracker entry", () => {
    const r = readingFromTrackerEntry("heart_rate", { values: { bpm: 165, context: "during run" }, timestamp: "2026-09-22T18:00:00Z" }, "bpm", "bpm");
    expect(r?.activityContext).toBe("workout");
    const rest = readingFromTrackerEntry("heart_rate", { values: { bpm: 60 }, timestamp: "2026-09-22T07:00:00Z" }, "bpm");
    expect(rest?.activityContext).toBe("general");
  });
  it("trends compare equivalent measurements", () => {
    const t = contextTrend(readings, "heart_rate", "resting", "2026-09-22");
    expect(t.later).toBe(58);
    expect(t.earlier).toBeNull(); // the 62 has no explicit context → general, not resting
  });
});
