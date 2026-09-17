// The Wellness readout: what the tab actually reads back.
//
// The reported symptoms this locks down:
//   * Nutrition ×3, Hydration ×2, HDL ×3, BMI ×3 — duplicates merge to one
//     series each.
//   * HbA1c 179 %, HDL 170, BMI 47 beside 26.4 — impossible stored values are
//     dropped on read, so an average can't be poisoned by one bad row.
//   * "Video games" / "Bathroom visits" on a health page — non-metrics vanish.
//   * A score of 60 nobody could explain — the score names its parts and counts
//     only connected sources.
//   * "hasn't been logged in 24 days" — the brief only describes data that is
//     there.
import { describe, it, expect } from "vitest";
import {
  collectMetrics, todaySignals, labPanels, activityHistory, wellnessScore,
  weeklyBrief, sourceState, mergedDuplicates, resolveWellnessSubject, belongsToSubject, bodyVitals,
} from "../shared/wellness-readout";

const NOW = new Date("2026-09-16T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();

const tracker = (over: any): any => ({
  id: over.id || `t-${over.name}`, name: over.name, category: over.category || "health",
  unit: over.unit || "", fields: over.fields || [{ name: "value", type: "number" }],
  entries: over.entries || [], linkedProfiles: [],
});
const entry = (values: any, at: string) => ({ id: `e-${at}-${JSON.stringify(values)}`, values, timestamp: at });

describe("duplicate trackers merge into one metric", () => {
  const trackers = [
    tracker({ name: "HDL", entries: [entry({ value: 52 }, daysAgo(200))] }),
    tracker({ name: "HDL Cholesterol", entries: [entry({ value: 55 }, daysAgo(100))] }),
    tracker({ name: "Lipid Panel — HDL", entries: [entry({ value: 58 }, daysAgo(10))] }),
  ];

  it("produces ONE series ordered by time", () => {
    const m = collectMetrics(trackers, { now: NOW });
    expect([...m.keys()]).toEqual(["hdl"]);
    expect(m.get("hdl")!.readings.map((r) => r.value)).toEqual([52, 55, 58]);
    expect(m.get("hdl")!.latest!.value).toBe(58);
  });

  it("reports which trackers were merged, so the collapse is visible", () => {
    const dupes = mergedDuplicates(collectMetrics(trackers, { now: NOW }));
    expect(dupes).toHaveLength(1);
    expect(dupes[0].label).toBe("HDL");
    expect(dupes[0].sources).toHaveLength(3);
  });
});

describe("impossible stored values are dropped on read", () => {
  it("ignores an HbA1c of 179 and keeps the real reading", () => {
    const m = collectMetrics([
      tracker({ name: "HbA1c", entries: [entry({ value: 5.4 }, daysAgo(30)), entry({ value: 179 }, daysAgo(2))] }),
    ], { now: NOW });
    expect(m.get("hba1c")!.readings.map((r) => r.value)).toEqual([5.4]);
  });

  it("ignores a BMI of 47 logged beside a BMI of 26.4", () => {
    const m = collectMetrics([
      tracker({ name: "BMI", entries: [entry({ value: 26.4 }, daysAgo(3))] }),
      tracker({ name: "Body Mass Index", entries: [entry({ value: 470 }, daysAgo(1))] }),
    ], { now: NOW });
    expect(m.get("bmi")!.latest!.value).toBe(26.4);
  });

  it("does not let a future-dated row become 'latest'", () => {
    const m = collectMetrics([
      tracker({ name: "Weight", entries: [entry({ value: 184.6 }, daysAgo(1)), entry({ value: 200 }, daysAgo(-40))] }),
    ], { now: NOW });
    expect(m.get("weight")!.latest!.value).toBe(184.6);
  });
});

describe("non-metrics do not appear on a health page", () => {
  it("drops Video games, Bathroom visits and Guitar", () => {
    const m = collectMetrics([
      tracker({ name: "Video games", category: "gaming", entries: [entry({ hours: 3 }, daysAgo(1))] }),
      tracker({ name: "Bathroom visits", category: "custom", entries: [entry({ count: 6 }, daysAgo(1))] }),
      tracker({ name: "Guitar practice", category: "hobby", entries: [entry({ minutes: 45 }, daysAgo(1))] }),
    ], { now: NOW });
    expect([...m.keys()]).toEqual([]);
  });
});

describe("Today's three signals", () => {
  const trackers = [
    tracker({ name: "Sleep", unit: "h", entries: [
      entry({ value: 7.6 }, daysAgo(10)), entry({ value: 7.4 }, daysAgo(5)), entry({ value: 6.6 }, daysAgo(1)),
    ] }),
    // Activity and recovery are TODAY's readings; sleep is last night's.
    tracker({ name: "Steps", entries: [entry({ steps: 9100 }, daysAgo(0))] }),
    tracker({ name: "Resting Heart Rate", entries: [entry({ value: 52 }, daysAgo(9)), entry({ value: 56 }, daysAgo(0))] }),
  ];

  it("fills sleep, activity and recovery from whatever is connected", () => {
    const s = todaySignals(collectMetrics(trackers, { now: NOW }));
    expect(s.map((x) => x.key)).toEqual(["sleep", "activity", "recovery"]);
    expect(s[0].value).toBe(6.6);
    expect(s[0].avg30).toBeCloseTo(7.5, 5); // the baseline the tile compares against
    expect(s[1].value).toBe(9100);
    expect(s[2].caption).toBe("Resting heart rate");
  });

  it("never presents an old reading as today's (QA 2026-09-17: sleep from Aug 22 shown as last night)", () => {
    const s = todaySignals(collectMetrics([
      tracker({ name: "Sleep", unit: "h", entries: [entry({ value: 6.75 }, daysAgo(25))] }),
      tracker({ name: "Steps", entries: [entry({ steps: 3137 }, daysAgo(2))] }),
    ], { now: NOW }));
    expect(s[0].value).toBeNull();
    expect(s[0].lastAt).toBe(daysAgo(25)); // the tile can say "last logged Aug 22"
    expect(s[1].value).toBeNull();
    expect(s[1].lastAt).toBe(daysAgo(2));
    const score = wellnessScore(collectMetrics([
      tracker({ name: "Sleep", unit: "h", entries: [entry({ value: 6.75 }, daysAgo(25))] }),
      tracker({ name: "Steps", entries: [entry({ steps: 3137 }, daysAgo(2))] }),
    ], { now: NOW }));
    expect(score.value).toBeNull(); // not 70 from three-week-old numbers
    expect(score.components.map((c) => c.detail)).toEqual([
      "No sleep recorded last night", "No activity recorded today", "No recovery source connected",
    ]);
  });

  it("says a signal has no source instead of showing a zero", () => {
    const s = todaySignals(collectMetrics([], { now: NOW }));
    expect(s.every((x) => x.value === null)).toBe(true);
  });
});

describe("labs group by panel with reference ranges", () => {
  const trackers = [
    tracker({ name: "LDL", entries: [entry({ value: 128 }, daysAgo(200)), entry({ value: 138 }, daysAgo(20))] }),
    tracker({ name: "HDL", entries: [entry({ value: 58 }, daysAgo(20))] }),
    tracker({ name: "TSH", entries: [entry({ value: 2.1 }, daysAgo(20))] }),
    tracker({ name: "Pushups", category: "fitness", entries: [entry({ reps: 40 }, daysAgo(1))] }),
  ];

  it("puts each value in its panel and flags the out-of-range ones", () => {
    const panels = labPanels(collectMetrics(trackers, { now: NOW }));
    const lipids = panels.find((p) => p.panel === "lipids")!;
    expect(lipids.rows.map((r) => r.metricId)).toEqual(["ldl", "hdl"]); // flagged first
    expect(lipids.rows[0].flag).toBe("high");
    expect(lipids.rows[0].reference).toBe("< 100 mg/dL");
    expect(lipids.outOfRange).toBe(1);
    expect(panels.find((p) => p.panel === "thyroid")!.rows[0].flag).toBe("normal");
  });

  it("carries the trend across reports (128 → 138)", () => {
    const panels = labPanels(collectMetrics(trackers, { now: NOW }));
    const ldl = panels.find((p) => p.panel === "lipids")!.rows.find((r) => r.metricId === "ldl")!;
    expect(ldl.previous).toBe(128);
    expect(ldl.value).toBe(138);
  });

  it("does not file a workout as a lab", () => {
    const panels = labPanels(collectMetrics(trackers, { now: NOW }));
    expect(panels.some((p) => p.rows.some((r) => /push/i.test(r.label)))).toBe(false);
  });
});

describe("activity history", () => {
  it("groups workouts by type with sessions and totals", () => {
    const groups = activityHistory([
      tracker({ name: "Running", category: "fitness", fields: [{ name: "distance", type: "number" }], entries: [
        entry({ distance: 3.1 }, daysAgo(6)), entry({ distance: 4 }, daysAgo(2)),
      ] }),
      tracker({ name: "Pushups", category: "fitness", fields: [{ name: "reps", type: "number" }], entries: [entry({ reps: 40 }, daysAgo(3))] }),
      tracker({ name: "Coffee", category: "custom", entries: [entry({ cups: 2 }, daysAgo(1))] }),
    ], { now: NOW });
    expect(groups.map((g) => g.type)).toEqual(["Running", "Pushups"]);
    expect(groups[0].sessions).toBe(2);
    expect(groups[0].distance).toBe(7.1);
    expect(groups[1].reps).toBe(40);
  });
});

describe("the score shows its working", () => {
  it("weights only the components that have a source", () => {
    const m = collectMetrics([
      tracker({ name: "Sleep", entries: [entry({ value: 7.5 }, daysAgo(1))] }),
    ], { now: NOW });
    const score = wellnessScore(m);
    expect(score.value).toBe(100);           // sleep alone, renormalised to 100%
    const sleep = score.components.find((c) => c.key === "sleep")!;
    expect(sleep.weight).toBe(1);
    expect(score.components.filter((c) => c.score == null).map((c) => c.key)).toEqual(["activity", "recovery"]);
  });

  it("is null, not 60, when nothing is connected", () => {
    expect(wellnessScore(collectMetrics([], { now: NOW })).value).toBeNull();
  });

  it("splits 40/30/30 when all three are connected", () => {
    const m = collectMetrics([
      tracker({ name: "Sleep", entries: [entry({ value: 8 }, daysAgo(1))] }),
      tracker({ name: "Steps", entries: [entry({ steps: 8000 }, daysAgo(0))] }),
      tracker({ name: "Resting HR", entries: [entry({ value: 55 }, daysAgo(0))] }),
    ], { now: NOW });
    const score = wellnessScore(m);
    expect(score.components.map((c) => Math.round(c.weight * 100))).toEqual([40, 30, 30]);
    expect(score.value).toBe(100);
  });
});

describe("the weekly brief only describes data that exists", () => {
  const trackers = [
    tracker({ name: "Sleep", entries: [
      entry({ value: 8 }, daysAgo(25)), entry({ value: 8 }, daysAgo(20)), entry({ value: 8 }, daysAgo(12)),
      entry({ value: 7 }, daysAgo(4)), entry({ value: 7 }, daysAgo(2)),
    ] }),
    tracker({ name: "Running", category: "fitness", fields: [{ name: "distance", type: "number" }], entries: [
      entry({ distance: 3 }, daysAgo(5)), entry({ distance: 3 }, daysAgo(2)),
    ] }),
    tracker({ name: "LDL", entries: [entry({ value: 138 }, daysAgo(20))] }),
  ];

  it("compares this week against the user's own 30-day baseline", () => {
    const metrics = collectMetrics(trackers, { now: NOW });
    const lines = weeklyBrief({
      metrics, workouts: activityHistory(trackers, { now: NOW }),
      labs: labPanels(metrics), now: NOW,
    });
    expect(lines[0]).toMatch(/Sleep is 4\d min down this week/);
    expect(lines.join(" ")).toMatch(/trained 2 times/);
    expect(lines.join(" ")).toMatch(/LDL/);
  });

  it("never mentions missing logs, streaks or goals", () => {
    const metrics = collectMetrics(trackers, { now: NOW });
    const text = weeklyBrief({ metrics, workouts: [], labs: [], now: NOW }).join(" ");
    expect(text).not.toMatch(/log|streak|goal|missed|haven't|hasn't/i);
  });

  it("says nothing at all when nothing is connected", () => {
    expect(weeklyBrief({ metrics: new Map(), workouts: [], labs: [], now: NOW })).toEqual([]);
  });
});

describe("source state drives the one honest nudge", () => {
  it("reports which feeds are live", () => {
    const s = sourceState(collectMetrics([
      tracker({ name: "Sleep", entries: [entry({ value: 7 }, daysAgo(1))] }),
      tracker({ name: "HDL", entries: [entry({ value: 58 }, daysAgo(1))] }),
    ], { now: NOW }));
    expect(s).toEqual({ sleep: true, activity: false, recovery: false, labs: true, body: false });
  });
});

describe("one subject — health data never blends", () => {
  const profiles = [
    { id: "me", type: "self", name: "Me" },
    { id: "linda", type: "person", name: "Linda" },
    { id: "car", type: "vehicle", name: "Civic" },
  ];

  it("reads me when no one is selected", () => {
    const { subject, isSelf } = resolveWellnessSubject(profiles, []);
    expect(subject!.id).toBe("me");
    expect(isSelf).toBe(true);
  });

  it("reads the selected person, not a blend of everyone", () => {
    const { subject, isSelf } = resolveWellnessSubject(profiles, ["linda"]);
    expect(subject!.id).toBe("linda");
    expect(isSelf).toBe(false);
  });

  it("keeps one person's readings out of another's page", () => {
    const linda = resolveWellnessSubject(profiles, ["linda"]);
    expect(belongsToSubject(["linda"], linda.subject, linda.isSelf)).toBe(true);
    expect(belongsToSubject(["me"], linda.subject, linda.isSelf)).toBe(false);
    // An unlinked record predates profile linking and belongs to "me" only.
    expect(belongsToSubject([], linda.subject, linda.isSelf)).toBe(false);
    const me = resolveWellnessSubject(profiles, []);
    expect(belongsToSubject([], me.subject, me.isSelf)).toBe(true);
  });

  it("stops two heights from becoming one body", () => {
    const trackers = [
      { ...tracker({ name: "Height", entries: [entry({ value: 70 }, daysAgo(5))] }), linkedProfiles: ["me"] },
      { ...tracker({ id: "t-h2", name: "Height", entries: [entry({ value: 67 }, daysAgo(4))] }), linkedProfiles: ["linda"] },
    ];
    const me = resolveWellnessSubject(profiles, []);
    const mine = trackers.filter((t) => belongsToSubject(t.linkedProfiles, me.subject, me.isSelf));
    const m = collectMetrics(mine as any, { now: NOW });
    expect(m.get("height")!.readings.map((r) => r.value)).toEqual([70]);
  });
});

describe("activity history is workouts, not anything with a clock", () => {
  const trackers = [
    tracker({ name: "Guitar practice", category: "hobby", fields: [{ name: "minutes", type: "number" }], entries: [entry({ minutes: 45 }, daysAgo(1))] }),
    tracker({ name: "Studying", category: "education", fields: [{ name: "minutes", type: "number" }], entries: [entry({ minutes: 90 }, daysAgo(2))] }),
    tracker({ name: "Steps", category: "fitness", fields: [{ name: "steps", type: "number" }], entries: [entry({ steps: 9100 }, daysAgo(1))] }),
    tracker({ name: "Running", category: "fitness", fields: [{ name: "distance", type: "number" }], entries: [entry({ distance: 4 }, daysAgo(2))] }),
    tracker({ name: "Bench Press", category: "fitness", fields: [{ name: "weight", type: "number" }, { name: "reps", type: "number" }], entries: [entry({ weight: 185, reps: 5 }, daysAgo(4))] }),
  ];

  it("does not call a minutes field a workout", () => {
    const types = activityHistory(trackers, { now: NOW }).map((g) => g.type);
    expect(types).not.toContain("Guitar practice");
    expect(types).not.toContain("Studying");
  });

  it("keeps a measured signal out of the workout list", () => {
    // Steps is a Today signal; it is not a thing you trained at.
    expect(activityHistory(trackers, { now: NOW }).map((g) => g.type)).not.toContain("Steps");
  });

  it("still keeps the real workouts", () => {
    expect(activityHistory(trackers, { now: NOW }).map((g) => g.type).sort()).toEqual(["Bench Press", "Running"]);
  });

  it("keeps them out of the weekly brief too", () => {
    const metrics = collectMetrics(trackers, { now: NOW });
    const text = weeklyBrief({ metrics, workouts: activityHistory(trackers, { now: NOW }), labs: [], now: NOW }).join(" ");
    expect(text).not.toMatch(/guitar|studying|steps/i);
  });
});

describe("body & vitals are shown, not just collected", () => {
  const trackers = [
    tracker({ name: "Weight", unit: "lbs", entries: [entry({ value: 186.2 }, daysAgo(14)), entry({ value: 184.6 }, daysAgo(2))] }),
    tracker({ name: "BMI", entries: [entry({ value: 26.4 }, daysAgo(5))] }),
    tracker({ name: "Blood Pressure", category: "vitals",
      fields: [{ name: "systolic", type: "number" }, { name: "diastolic", type: "number" }],
      entries: [entry({ systolic: 118, diastolic: 76 }, daysAgo(30)), entry({ systolic: 82 }, daysAgo(1))] }),
    tracker({ name: "HDL", entries: [entry({ value: 58 }, daysAgo(20))] }),
  ];

  it("surfaces weight, BMI and blood pressure", () => {
    const rows = bodyVitals(collectMetrics(trackers, { now: NOW })).flatMap((p) => p.rows);
    expect(rows.map((r) => r.metricId).sort()).toEqual(["bmi", "bp_diastolic", "bp_systolic", "weight"]);
    expect(rows.find((r) => r.metricId === "weight")!.value).toBe(184.6);
    expect(rows.find((r) => r.metricId === "weight")!.previous).toBe(186.2);
  });

  it("flags a systolic of 82 as low instead of printing '82/—'", () => {
    const sys = bodyVitals(collectMetrics(trackers, { now: NOW })).flatMap((p) => p.rows).find((r) => r.metricId === "bp_systolic")!;
    expect(sys.value).toBe(82);
    expect(sys.flag).toBe("low");
    // The diastolic keeps its OWN reading and date rather than being blanked.
    const dia = bodyVitals(collectMetrics(trackers, { now: NOW })).flatMap((p) => p.rows).find((r) => r.metricId === "bp_diastolic")!;
    expect(dia.value).toBe(76);
  });

  it("does not put a lab value in the body section, or vice versa", () => {
    const m = collectMetrics(trackers, { now: NOW });
    expect(bodyVitals(m).flatMap((p) => p.rows).some((r) => r.metricId === "hdl")).toBe(false);
    expect(labPanels(m).flatMap((p) => p.rows).some((r) => r.metricId === "weight")).toBe(false);
  });
});
