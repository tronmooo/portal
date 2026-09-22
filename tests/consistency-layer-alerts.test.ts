// Consistency layer — alert severity, consolidation, priority ranking, outliers (req. tests 21, 23).
import { describe, expect, it } from "vitest";
import { alertSeverity, consolidateAlerts, buildAlert, thingsThatNeedYou, suggestionFor, detectOutliers, sanitizedTotal, rollingWellness } from "../shared/domain";

describe("21. Serious expired items receive higher alert priority", () => {
  it("an expired home-insurance policy on a high-value property is critical and outranks a reminder", () => {
    const alerts = consolidateAlerts([
      { kind: "reminder", entityKey: "task:1", subject: "Water the plants", daysUntil: 0 },
      { kind: "insurance_expired", entityKey: "document:ins", subject: "Home insurance", daysUntil: -113, protectedValue: 650000 },
      { kind: "insurance_expired", entityKey: "document:ins", subject: "Home insurance", daysUntil: -113 }, // duplicate row from another system
      { kind: "task_due", entityKey: "task:2", subject: "Mow the lawn", daysUntil: 3 },
    ]);
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toMatchObject({ entityKey: "document:ins", severity: "critical", count: 2, title: "Home insurance expired 113 days ago" });
    expect(alerts[0].actions.map((a) => a.label)).toEqual(["Upload renewal", "Update policy", "Mark resolved"]);
    expect(alertSeverity({ kind: "reminder", entityKey: "x", subject: "y", daysUntil: 0 })).toBe("informational");
    expect(buildAlert({ kind: "task_overdue", entityKey: "t", subject: "Mow the lawn", daysUntil: -2 }).title).toBe("Mow the lawn is overdue by 2 days");
  });
});

describe("22b. Chat attention list ranks meaningful items", () => {
  it("habits never crowd out an expired policy or a missed payment, and suggestions read naturally", () => {
    const top = thingsThatNeedYou([
      { key: "habit:bathroom", kind: "habit", title: "Bathroom", outstanding: true },
      { key: "habit:water", kind: "habit", title: "Drink water", outstanding: true },
      { key: "habit:floss", kind: "habit", title: "Floss", outstanding: true },
      { key: "doc:ins", kind: "insurance", title: "Home insurance", daysUntil: -113, protectedValue: 650000 },
      { key: "pay:loan", kind: "payment", title: "Auto loan", daysUntil: -3, amount: 912.4 },
      { key: "task:lawn", kind: "task", title: "Mow the lawn", daysUntil: -1 },
    ], 3);
    expect(top.map((t) => t.key)).toEqual(["doc:ins", "pay:loan", "task:lawn"]);
    expect(suggestionFor({ key: "h", kind: "habit", title: "Bathroom", outstanding: true })).toBe("Log bathroom visit");
    expect(suggestionFor({ key: "h", kind: "habit", title: "Drink water", outstanding: true })).toBe("Log Drink water");
    expect(suggestionFor({ key: "h", kind: "habit", title: "Drink water", outstanding: true })).not.toMatch(/^Mark /);
    expect(suggestionFor({ key: "p", kind: "payment", title: "auto loan" })).toBe("Record the auto loan payment");
  });
});

describe("23. Outlier tracker data is flagged", () => {
  it("Core Workout: 4 sessions, 610 minutes triggers a sanity check", () => {
    const entries = [
      { value: 45, unit: "min", timestamp: "2026-09-19T07:00:00Z" },
      { value: 50, unit: "min", timestamp: "2026-09-20T07:00:00Z" },
      { value: 40, unit: "min", timestamp: "2026-09-21T07:00:00Z" },
      { value: 475, unit: "min", timestamp: "2026-09-22T07:00:00Z" },
    ];
    const flags = detectOutliers(entries, { measurement: "duration" });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ index: 3, reason: "implausible_duration" });
    const agg = sanitizedTotal(entries, { measurement: "duration" });
    expect(agg.suspicious).toBe(true);
    expect(agg.total).toBe(135);
    expect(agg.rawTotal).toBe(610);
  });
  it("unit mismatches, duplicates and unusual frequency are flagged too", () => {
    const flags = detectOutliers([
      { value: 30, unit: "min", timestamp: "2026-09-22T07:00:00Z" },
      { value: 30, unit: "min", timestamp: "2026-09-22T07:00:00Z" },
      { value: 3, unit: "mi", timestamp: "2026-09-22T08:00:00Z" },
    ], { measurement: "duration", unit: "min" });
    expect(flags.map((f) => f.reason)).toEqual(["duplicate_entry", "unit_mismatch"]);
  });
});

describe("21b. Wellness does not reset into uselessness every morning", () => {
  it("shows a rolling 7-day score with its basis instead of a blank", () => {
    const daily = [{ date: "2026-09-19", score: 80 }, { date: "2026-09-20", score: 84 }, { date: "2026-09-21", score: 82 }];
    expect(rollingWellness(daily, { todayISO: "2026-09-22" })).toMatchObject({ score: 82, basis: "rolling", label: "Based on last 7 days", daysUsed: 3 });
    expect(rollingWellness(daily, { todayISO: "2026-10-15" })).toMatchObject({ basis: "last_known", stale: true, score: 82 });
    expect(rollingWellness([], { todayISO: "2026-09-22" })).toMatchObject({ score: null, basis: "none" });
  });
});
