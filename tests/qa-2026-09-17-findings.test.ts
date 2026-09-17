// tests/qa-2026-09-17-findings.test.ts
//
// QA 2026-09-17 ("different screens calculate the same number different
// ways, and a few background processes create bad or duplicate data").
// The task/habit half lives in tests/recurring-task-rollover.test.ts; this
// file pins the wellness, tracker-write and money rules:
//
//   • a habit check-in mirrors the MEASUREMENT into its tracker (Morning
//     Water → ounces), not a bare completion count;
//   • a personal record (weight, water, a meal) never fans out onto the
//     other person named in the sentence;
//   • a workout's reps × sets are multiplied, not added ("24 reps" for 8×4);
//   • ONE month-over-month net-worth rule with a real 30-day baseline;
//   • a dose logged without the adherence word still counts as taken;
//   • a blood pressure summary is both numbers.
import { describe, it, expect } from "vitest";
import { impliedMirrorValues } from "../server/habit-completion";
import { isPersonalRecordTracker, planSharedActivityFanout } from "@shared/shared-activity";
import { activityHistory } from "@shared/wellness-readout";
import { netWorthChange } from "@shared/net-worth-change";
import { computeMissedDoses, hasDoseEvidence } from "@shared/medication-doses";
import { summarizeTrackerToday } from "@shared/tracker-summary";
import { sanitizeTrackerEntryValues } from "../server/tracker-entry-guard";
import { documentExpirationDate } from "@shared/date-rules";
import { normalizeTrackerEntry } from "../server/tracker-normalize";
import { countTasksByDay, isDoneToday } from "@shared/task-counts";
import { humanSummary, parseRecurrence } from "@shared/recurrence";

describe("habit → tracker mirror carries the measurement", () => {
  const hydration = { fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }] };
  it("uses the value the check-in supplied", () => {
    expect(impliedMirrorValues({ name: "Morning Water", targetPerDay: 1 }, hydration, 20)).toEqual({ ounces: 20 });
    expect(impliedMirrorValues({ name: "Morning Water", targetPerDay: 1 }, hydration, "12")).toEqual({ ounces: 12 });
  });
  it("derives one share of the day's amount from the habit name", () => {
    expect(impliedMirrorValues({ name: "Drink 64 oz of water", targetPerDay: 4 }, hydration)).toEqual({ ounces: 16 });
    expect(impliedMirrorValues({ name: "Walk 10,000 steps", targetPerDay: 1 }, { fields: [{ name: "steps", type: "number", isPrimary: true }] })).toEqual({ steps: 10000 });
  });
  it("records a plain completion when nothing measurable is known", () => {
    expect(impliedMirrorValues({ name: "Make my bed", targetPerDay: 1 }, hydration)).toBeNull();
    expect(impliedMirrorValues({ name: "Drink 64 oz", targetPerDay: 1 }, { fields: [{ name: "completions", type: "number" }] })).toBeNull();
  });
});

describe("shared-activity fan-out skips personal records", () => {
  it("knows a weigh-in, a glass of water or a meal is one person's", () => {
    for (const n of ["Weight", "Hydration", "Water", "Nutrition", "Blood Pressure", "Vitamin D", "Sleep"]) expect(isPersonalRecordTracker(n)).toBe(true);
    for (const n of ["Soccer", "Running", "Hiking", "Tennis"]) expect(isPersonalRecordTracker(n)).toBe(false);
  });
  it("does not copy the Weight / Hydration rows onto Sarah", () => {
    const self = { id: "self", name: "Me" };
    const sarah = { id: "sarah", name: "Sarah Miller" };
    const planned = planSharedActivityFanout({
      userMessage: "Sarah and I had breakfast together, I drank 20 oz of water and weighed 175",
      writes: [
        { trackerName: "Hydration", profileId: null, values: { ounces: 20 } },
        { trackerName: "Weight", profileId: null, values: { weight: 175 } },
        { trackerName: "Nutrition", profileId: null, values: { calories: 500 } },
      ],
      resolveName: (n) => (/sarah/i.test(n) ? sarah : null),
      selfProfile: self,
    });
    expect(planned).toEqual([]);
  });
});

describe("workout history multiplies reps by sets", () => {
  it("8 reps × 4 sets is 32 reps and 4 sets, not 12 'reps'", () => {
    const now = new Date("2026-09-17T12:00:00Z");
    const groups = activityHistory([
      { id: "bp", name: "Bench Press", category: "fitness", fields: [{ name: "reps", type: "number" }, { name: "sets", type: "number" }],
        entries: [
          { id: "e1", values: { reps: 8, sets: 4, weight: 135 }, timestamp: "2026-09-15T10:00:00Z" },
          { id: "e2", values: { reps: 10, sets: 3 }, timestamp: "2026-09-16T10:00:00Z" },
        ] } as any,
    ], { now });
    expect(groups).toHaveLength(1);
    expect(groups[0].sessions).toBe(2);
    expect(groups[0].reps).toBe(8 * 4 + 10 * 3);
    expect(groups[0].sets).toBe(7);
  });
});

describe("netWorthChange — one month-over-month rule", () => {
  const today = "2026-09-17";
  it("measures against the snapshot on or before 30 days ago, never the oldest row", () => {
    const c = netWorthChange([
      { snapshotDate: "2026-06-01", netWorth: 9_400 },     // the first, half-populated total
      { snapshotDate: "2026-08-15", netWorth: 118_000 },   // ≤ Aug 18 → the baseline
      { snapshotDate: "2026-08-20", netWorth: 119_000 },
      { snapshotDate: "2026-09-16", netWorth: 121_000 },
    ], 122_000, today)!;
    expect(c.monthly).toBe(true);
    expect(c.baselineDate).toBe("2026-08-15");
    expect(c.delta).toBe(4_000);
    expect(c.pct).toBeCloseTo((4_000 / 118_000) * 100, 6);
  });
  it("states no percentage when the history is younger than a month", () => {
    const c = netWorthChange([
      { snapshotDate: "2026-09-10", netWorth: 9_400 },
      { snapshotDate: "2026-09-16", netWorth: 121_000 },
    ], 122_000, today)!;
    expect(c.monthly).toBe(false);
    expect(c.pct).toBeNull();
    expect(c.delta).toBe(122_000 - 9_400);
  });
  it("refuses a % on a trivial or sign-flipping baseline", () => {
    expect(netWorthChange([{ snapshotDate: "2026-08-01", netWorth: 0 }], 5_000, today)!.pct).toBeNull();
    expect(netWorthChange([{ snapshotDate: "2026-08-01", netWorth: -2_000 }], 5_000, today)!.pct).toBeNull();
    expect(netWorthChange([], 5_000, today)).toBeNull();
    expect(netWorthChange([{ snapshotDate: "2026-08-01", netWorth: 100 }], null, today)).toBeNull();
  });
  it("accepts the server's snake_case rows too", () => {
    expect(netWorthChange([{ snapshot_date: "2026-08-01", net_worth: 100 }], 150, today)!.pct).toBeCloseTo(50, 6);
  });
});

describe("a dose logged without the adherence word is a dose", () => {
  it("recognises dose evidence", () => {
    expect(hasDoseEvidence({ dosage: "2000 IU" })).toBe(true);
    expect(hasDoseEvidence({ taken: true })).toBe(true);
    expect(hasDoseEvidence({ completions: 1, _habitId: "h1" })).toBe(true);
    expect(hasDoseEvidence({ notes: "felt fine" })).toBe(false);
    expect(hasDoseEvidence(null)).toBe(false);
  });
  it("counts them as taken in the weekly gap math", () => {
    const now = Date.UTC(2026, 8, 17, 12);
    const day = 86400000;
    const t: any = {
      id: "vd", name: "Vitamin D daily", category: "medication", createdAt: new Date(now - 30 * day).toISOString(),
      fields: [{ name: "dosage", type: "text" }, { name: "adherence", type: "select" }],
      entries: [0, 1, 2, 3, 4, 5].map((d) => ({ id: `e${d}`, values: { dosage: "2000 IU" }, timestamp: new Date(now - d * day - 3600000).toISOString() })),
    };
    const res = computeMissedDoses(t, { days: 7, now });
    expect(res.taken).toBe(6);
    expect(res.unlogged_gap).toBe(1);
  });
});

describe("a blood pressure summary is both numbers", () => {
  it("reads 122/78, not 122", () => {
    const s = summarizeTrackerToday({
      id: "bp", name: "Blood Pressure", category: "health", unit: "mmHg",
      fields: [{ name: "systolic", type: "number", isPrimary: true, unit: "mmHg" }, { name: "diastolic", type: "number", unit: "mmHg" }],
      entries: [{ id: "e1", values: { systolic: 122, diastolic: 78 }, timestamp: "2026-09-17T08:00:00Z" }],
    } as any, { now: Date.UTC(2026, 8, 17, 12), todayKey: "2026-09-17" });
    expect(s.shape).toBe("dual");
    expect(s.line).toBe("122/78 mmHg");
  });
});

describe("countTasksByDay — one rule for every task surface", () => {
  const TODAY = "2026-09-17";
  const tz = "America/Los_Angeles";
  const tasks = [
    { status: "todo", dueDate: "2026-09-10" },                     // overdue
    { status: "todo", dueDate: "2026-09-17" },                     // today
    { status: "todo", dueDate: "2026-10-01" },                     // upcoming
    { status: "todo", dueDate: null },                             // undated
    { status: "done", dueDate: "2026-09-17", updatedAt: "2026-09-17T18:00:00Z" }, // done today (11am PT)
    { status: "done", dueDate: "2026-08-01", updatedAt: "2026-08-01T18:00:00Z" }, // done last month
    { status: "done", updatedAt: "2026-09-18T05:00:00Z" },         // 10pm PT Sep 17 → still today
  ];
  it("buckets by due day and counts completions on today's calendar day", () => {
    expect(countTasksByDay(tasks, TODAY, tz)).toEqual({ overdue: 1, dueToday: 1, upcoming: 1, undated: 1, doneToday: 2, doneAll: 3 });
  });
  it("never counts an all-time completion as today's (the popup's 13/55)", () => {
    expect(isDoneToday({ status: "done", updatedAt: "2026-08-01T18:00:00Z" }, TODAY, tz)).toBe(false);
    expect(isDoneToday({ status: "todo", updatedAt: "2026-09-17T18:00:00Z" }, TODAY, tz)).toBe(false);
  });
});

describe("humanSummary — the until date keeps its year", () => {
  it("says which year a far-off end date is in", () => {
    expect(humanSummary(parseRecurrence(["recur:weekly", "runtil:2028-08-02"]), "2026-09-23", new Date("2026-09-17T12:00:00Z"))).toContain("until Aug 2, 2028");
  });
});

describe("a supplement dose is not a blood level", () => {
  it("accepts 2000 IU on a Vitamin D medication tracker", () => {
    const fields = [{ name: "dosage", type: "number", unit: "IU" }, { name: "adherence", type: "select" }];
    const r = sanitizeTrackerEntryValues(fields as any, { dosage: 2000 }, { name: "Vitamin D", category: "medication", unit: "IU" });
    expect(r.error).toBeUndefined();
    expect(r.values.dosage).toBe(2000);
  });
  it("still refuses an impossible Vitamin D LAB value", () => {
    const r = sanitizeTrackerEntryValues([{ name: "value", type: "number", unit: "ng/mL" }] as any, { value: 2000 }, { name: "Vitamin D", category: "health", unit: "ng/mL" });
    expect(r.error).toMatch(/outside the possible range/);
  });
});

describe("a document's expiration date is derived from what was extracted", () => {
  it("fills the field that was declared and never written", () => {
    const doc = { id: "d1", name: "Homeowners Policy", type: "insurance", linkedProfiles: ["self"], extractedData: { policyNumber: "HO-1", expirationDate: "2026-09-25", effectiveDate: "2025-09-25" }, createdAt: "2026-09-01T00:00:00Z" };
    expect(documentExpirationDate(doc)).toBe("2026-09-25");
  });
  it("is empty when nothing on the document expires", () => {
    expect(documentExpirationDate({ id: "d2", name: "Receipt", type: "receipt", linkedProfiles: [], extractedData: { total: 12.5, date: "2026-09-10" }, createdAt: "2026-09-10T00:00:00Z" })).toBeUndefined();
    expect(documentExpirationDate(null)).toBeUndefined();
  });
});

describe("an entry with no values is refused on a tracker that has fields", () => {
  it("refuses {} on Weight but allows it on a field-less occurrence tracker", () => {
    expect(sanitizeTrackerEntryValues([{ name: "weight", type: "number" }] as any, {}, { name: "Weight", category: "health" }).error).toMatch(/At least one value/);
    expect(sanitizeTrackerEntryValues([], {}, { name: "Meditation", category: "wellness" }).error).toBeUndefined();
  });
});

describe("a count is not a calorie", () => {
  const nutrition: any = { name: "Nutrition", category: "nutrition", fields: [{ name: "calories", type: "number", unit: "kcal", isPrimary: true }, { name: "protein", type: "number", unit: "g" }] };
  it("keeps {count: 2} off the calories field", () => {
    const { values } = normalizeTrackerEntry(nutrition, { count: 2 });
    expect(values.calories).toBeUndefined();
  });
  it("still lands an amount on the primary field", () => {
    const hydration: any = { name: "Hydration", category: "health", fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }] };
    expect(normalizeTrackerEntry(hydration, { amount: 24 }).values.ounces).toBe(24);
    expect(normalizeTrackerEntry(nutrition, { amount: 640 }).values.calories).toBe(640);
  });
});
