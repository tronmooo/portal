// ── QA 2026-09-18 — dashboard / hub cluster regressions (pure logic) ─────────
// BUG-15 relative time · BUG-16 activity units · BUG-09 blood-pressure verdict
// · BUG-21 quick-add due phrases · BUG-29 notification labels & severity ·
// BUG-10 one task-count rule.
import { describe, it, expect } from "vitest";
import { relativeTime, relativeTimeShort, elapsedDays, withVerb } from "../shared/relative-time";
import { describeTrackerEntry } from "../shared/activity-description";
import { bloodPressureVerdict, flagAgainstReference, getCanonicalMetric, formatReference } from "../shared/wellness-canon";
import { collectMetrics, bodyVitals } from "../shared/wellness-readout";
import { parseQuickTaskText } from "../shared/quick-add";
import { countTasksByDay } from "../shared/task-counts";
import { buildNotifications, fieldSentenceLabel, expiredRuleSeverity } from "../server/notification-service";
import { shortAgo } from "../shared/tracker-summary";

// A fixed "now": Friday 2026-09-18 10:30 local.
const NOW = new Date(2026, 8, 18, 10, 30, 0);
const TODAY = "2026-09-18";

describe("BUG-15 — relative time reads calendar days and never says 0m for the future", () => {
  it("(a) a date-only value equal to today is 'today', not '14h ago'", () => {
    expect(relativeTime("2026-09-18", { now: NOW })).toBe("today");
    expect(relativeTimeShort("2026-09-18", NOW)).toBe("today");
    // The JSON spelling of the same bare date (UTC midnight) is the same day.
    expect(relativeTime("2026-09-18T00:00:00.000Z", { now: NOW })).toBe("today");
  });
  it("an instant seconds old is 'just now'; minutes and hours count", () => {
    expect(relativeTime(new Date(NOW.getTime() - 20_000), { now: NOW })).toBe("just now");
    expect(relativeTimeShort(new Date(NOW.getTime() - 21 * 60_000), NOW)).toBe("21m ago");
    expect(relativeTime(new Date(NOW.getTime() - 3 * 3600_000), { now: NOW })).toBe("3 hours ago");
  });
  it("(b) future dates read 'in …', never '0m' or 'just now'", () => {
    expect(relativeTime("2026-10-15", { now: NOW })).toBe("in 4 weeks");
    expect(relativeTime("2027-05-12", { now: NOW })).toBe("in 8 months");
    expect(relativeTime("2026-09-19", { now: NOW })).toBe("tomorrow");
    expect(relativeTimeShort("2026-09-21", NOW)).toBe("in 3d");
    expect(relativeTime(new Date(NOW.getTime() + 5 * 60_000), { now: NOW })).toBe("in 5 minutes");
    for (const v of ["2026-10-15", "2027-05-12", new Date(NOW.getTime() + 90_000)]) {
      const s = relativeTime(v, { now: NOW });
      expect(s).not.toMatch(/0m|just now|ago/);
    }
  });
  it("(c) Sep 1 → Sep 18 is 17 days, not 16", () => {
    expect(elapsedDays("2026-09-01", NOW)).toBe(17);
    expect(relativeTime("2026-09-01", { now: NOW })).toBe("17 days ago");
    expect(relativeTimeShort("2026-09-01", NOW)).toBe("17d ago");
  });
  it("'Last: … ago' and 'Stale Nd' derive from the same elapsed-days number", () => {
    const fortySevenDaysAgo = new Date(2026, 8, 18 - 47, 9, 0);
    expect(elapsedDays(fortySevenDaysAgo, NOW)).toBe(47);
    // 47 days is "2 months" by calendar arithmetic (Aug 2 → Sep 18), and the
    // tracker-summary helper is the same function, so the two agree.
    expect(shortAgo(fortySevenDaysAgo, NOW.getTime())).toBe(relativeTimeShort(fortySevenDaysAgo, NOW));
    expect(shortAgo(fortySevenDaysAgo, NOW.getTime())).toBe("2mo ago");
  });
  it("keeps the compact spellings the tracker cards use", () => {
    expect(shortAgo(NOW.getTime() - 30_000, NOW.getTime())).toBe("just now");
    expect(shortAgo(NOW.getTime() - 4 * 60_000, NOW.getTime())).toBe("4m ago");
    expect(shortAgo(NOW.getTime() - 3 * 3600_000, NOW.getTime())).toBe("3h ago");
    expect(shortAgo(NOW.getTime() - 2 * 86400_000, NOW.getTime())).toBe("2d ago");
  });
  it("withVerb gives one label format for completions", () => {
    expect(withVerb("Completed", new Date(NOW.getTime() - 21 * 60_000), { now: NOW, style: "short" })).toBe("Completed 21m ago");
    expect(withVerb("Completed", "2026-09-17", { now: NOW })).toBe("Completed yesterday");
  });
  it("garbage renders as nothing rather than NaN", () => {
    expect(relativeTime("not a date")).toBe("");
    expect(relativeTime(null)).toBe("");
    expect(elapsedDays(undefined)).toBeNull();
  });
});

describe("BUG-16 — activity rows carry a real unit, never the field name or 'value'", () => {
  it("Weight 181.2 → '181.2 lbs'", () => {
    const t = { name: "Weight", category: "health", fields: [{ name: "weight", type: "number", unit: "lbs" }] };
    expect(describeTrackerEntry(t, { weight: 181.2 })).toBe("Weight: 181.2 lbs");
  });
  it("unit from the canonical table when the field declares none", () => {
    const t = { name: "Weight", category: "health", fields: [{ name: "weight", type: "number" }] };
    expect(describeTrackerEntry(t, { weight: 181.2 })).toBe("Weight: 181.2 lbs");
    const hr = { name: "Heart Rate", category: "vitals", fields: [{ name: "value", type: "number" }], unit: "bpm" };
    expect(describeTrackerEntry(hr, { value: 60 })).toBe("Heart Rate: 60 bpm");
  });
  it("a lab value with a declared unit; a unit-less BMI stands alone", () => {
    const tg = { name: "Triglycerides", category: "lipid panel", fields: [{ name: "value", type: "number", unit: "mg/dL" }] };
    expect(describeTrackerEntry(tg, { value: 140 })).toBe("Triglycerides: 140 mg/dL");
    const bmi = { name: "BMI", category: "health", fields: [{ name: "value", type: "number" }] };
    expect(describeTrackerEntry(bmi, { value: 28 })).toBe("BMI: 28");
    expect(describeTrackerEntry(bmi, { value: 28 })).not.toMatch(/value/);
  });
  it("blood pressure fields carry mmHg, not their own names", () => {
    const bp = { name: "Blood Pressure", category: "vitals", fields: [{ name: "systolic", type: "number" }, { name: "diastolic", type: "number" }] };
    const line = describeTrackerEntry(bp, { systolic: 121, diastolic: 76 });
    expect(line).toContain("121 mmHg");
    expect(line).toContain("76 mmHg");
    // The field name is never the unit.
    expect(line).not.toMatch(/121 systolic|76 diastolic/);
  });
  it("declared units win; nothing logged reads 'Logged X'", () => {
    const run = { name: "Run", category: "fitness", fields: [{ name: "distance", type: "number", unit: "mi" }, { name: "durationMinutes", type: "number", unit: "min" }] };
    expect(describeTrackerEntry(run, { distance: 3.1, durationMinutes: 28 })).toBe("Run: 3.1 mi, 28 min");
    expect(describeTrackerEntry({ name: "Mood", category: "mental", fields: [] }, {})).toBe("Logged Mood");
  });
});

describe("BUG-09 — one blood-pressure verdict for the Trackers card and the Wellness tab", () => {
  const sys = getCanonicalMetric("bp_systolic")!;
  const dia = getCanonicalMetric("bp_diastolic")!;
  it("121/76 is Elevated on both paths (AHA: 120–129 elevated), never 'normal' vs 'High'", () => {
    const v = bloodPressureVerdict(121, 76)!;
    expect(v.label).toBe("Elevated");
    expect(v.flag).toBe("elevated");
    expect(v.summary).toMatch(/elevated/i);
    expect(v.summary).not.toMatch(/normal range/);
    // The Wellness tab's lab-row flag for the same systolic value.
    expect(flagAgainstReference(sys, 121)).toBe("elevated");
    expect(flagAgainstReference(dia, 76)).toBe("normal");
  });
  it("the readout (Wellness tab) and the verdict (Trackers card) agree on a logged reading", () => {
    const trackers: any[] = [{
      id: "bp", name: "Blood Pressure", category: "vitals",
      fields: [{ name: "systolic", type: "number" }, { name: "diastolic", type: "number" }],
      entries: [{ id: "e1", values: { systolic: 121, diastolic: 76 }, timestamp: NOW.toISOString() }],
    }];
    const rows = bodyVitals(collectMetrics(trackers, { now: NOW })).flatMap((p) => p.rows);
    const sysRow = rows.find((r) => r.metricId === "bp_systolic")!;
    const diaRow = rows.find((r) => r.metricId === "bp_diastolic")!;
    const verdict = bloodPressureVerdict(sysRow.value, diaRow.value)!;
    expect(sysRow.flag).toBe(verdict.systolicFlag);
    expect(diaRow.flag).toBe(verdict.diastolicFlag);
    expect(verdict.label).toBe("Elevated");
  });
  it("the whole AHA table", () => {
    expect(bloodPressureVerdict(118, 76)!.label).toBe("In range");
    expect(bloodPressureVerdict(119, 79)!.label).toBe("In range");
    expect(bloodPressureVerdict(120, 79)!.label).toBe("Elevated");
    expect(bloodPressureVerdict(129, 79)!.label).toBe("Elevated");
    expect(bloodPressureVerdict(130, 79)!.label).toBe("High");
    expect(bloodPressureVerdict(125, 80)!.label).toBe("High");
    expect(bloodPressureVerdict(145, 95)!.label).toBe("High");
    expect(bloodPressureVerdict(181, 90)!.label).toBe("Crisis");
    expect(bloodPressureVerdict(85, 55)!.label).toBe("Low");
    expect(bloodPressureVerdict(null, null)).toBeNull();
  });
  it("the printed reference matches the band ('90–119 mmHg')", () => {
    expect(formatReference(sys)).toBe("90–119 mmHg");
  });
});

describe("BUG-21 — quick-add reads a trailing due phrase", () => {
  it("'before December' → Nov 30 of the upcoming December, title stripped", () => {
    expect(parseQuickTaskText("Renew passport before December", TODAY)).toEqual({ title: "Renew passport", dueDate: "2026-11-30" });
  });
  it("'by December' → Dec 1; 'before Dec 1' → Nov 30; 'by Dec 15' → Dec 15", () => {
    expect(parseQuickTaskText("Book flights by December", TODAY).dueDate).toBe("2026-12-01");
    expect(parseQuickTaskText("Renew passport before Dec 1", TODAY).dueDate).toBe("2026-11-30");
    expect(parseQuickTaskText("Pay deposit by Dec 15th", TODAY).dueDate).toBe("2026-12-15");
    expect(parseQuickTaskText("Taxes due April 15", TODAY).dueDate).toBe("2027-04-15");
  });
  it("a month already past this year rolls to next year; an explicit year is kept", () => {
    expect(parseQuickTaskText("Plant bulbs before March", TODAY).dueDate).toBe("2027-02-28");
    expect(parseQuickTaskText("Archive files by January 2028", TODAY).dueDate).toBe("2028-01-01");
  });
  it("today / tomorrow / in N days / weekdays", () => {
    expect(parseQuickTaskText("Call mom tomorrow", TODAY)).toEqual({ title: "Call mom", dueDate: "2026-09-19" });
    expect(parseQuickTaskText("Submit report today", TODAY).dueDate).toBe("2026-09-18");
    expect(parseQuickTaskText("Return library books in 3 days", TODAY).dueDate).toBe("2026-09-21");
    expect(parseQuickTaskText("Dentist in 2 weeks", TODAY).dueDate).toBe("2026-10-02");
    // Sep 18 2026 is a Friday: "on Monday" is Sep 21, "next Friday" is Sep 25.
    expect(parseQuickTaskText("Mow the lawn on Monday", TODAY).dueDate).toBe("2026-09-21");
    expect(parseQuickTaskText("Mow the lawn next Friday", TODAY).dueDate).toBe("2026-09-25");
  });
  it("no phrase → title untouched and no date", () => {
    expect(parseQuickTaskText("Pet my dog", TODAY)).toEqual({ title: "Pet my dog" });
    expect(parseQuickTaskText("Buy 12 eggs", TODAY)).toEqual({ title: "Buy 12 eggs" });
  });
  it("an undated task is never counted as due today", () => {
    const c = countTasksByDay([{ status: "todo", dueDate: null }, { status: "todo", dueDate: TODAY }], TODAY);
    expect(c.dueToday).toBe(1);
    expect(c.undated).toBe(1);
  });
});

describe("BUG-10 — the hub chip and the Tasks card count from one rule", () => {
  it("remaining = open tasks of every date bucket; late = overdue only", () => {
    const tasks = [
      { status: "todo", dueDate: "2026-09-10" },   // overdue
      { status: "todo", dueDate: "2026-09-17" },   // overdue
      { status: "todo", dueDate: TODAY },          // today
      { status: "todo", dueDate: "2026-10-01" },   // upcoming
      { status: "todo", dueDate: null },           // undated
      { status: "done", dueDate: "2026-09-10", completedAt: `${TODAY}T08:00:00` },
    ];
    const c = countTasksByDay(tasks, TODAY);
    const remaining = c.overdue + c.dueToday + c.upcoming + c.undated;
    expect(remaining).toBe(5);
    expect(c.overdue).toBe(2);
    // The card's own rule, written the way ExecutiveBriefing writes it.
    expect(tasks.filter((t) => t.status !== "done").length).toBe(remaining);
  });
});

describe("BUG-29 — bell messages use the human label, name the date once, and rank by real severity", () => {
  function stubStorage(overrides: Record<string, any> = {}): any {
    const prefs = new Map<string, string>();
    return {
      getDocuments: async () => [],
      getProfiles: async () => [],
      getTasks: async () => [],
      getObligations: async () => [],
      getHabits: async () => [],
      getEvents: async () => [],
      listUserNotifications: async () => [],
      getPreference: async (k: string) => prefs.get(k) ?? null,
      setPreference: async (k: string, v: string) => { prefs.set(k, v); },
      ...overrides,
    };
  }
  it("fieldSentenceLabel humanises the key", () => {
    expect(fieldSentenceLabel("expirationDate")).toBe("Expiration date");
    expect(fieldSentenceLabel("coverage.renewal_date")).toBe("Renewal date");
  });
  it("an expired insurance policy is critical; an expired gym membership is a warning; an overdue chore is a warning", () => {
    expect(expiredRuleSeverity({ isDocument: true, documentType: "insurance", name: "Homeowners Insurance Policy Declaration" })).toBe("critical");
    expect(expiredRuleSeverity({ isDocument: true, documentType: "other", name: "Gym membership card" })).toBe("warning");
    expect(expiredRuleSeverity({ isDocument: false, name: "Honda Civic", fieldKey: "registrationExpiration" })).toBe("critical");
  });
  it("the document message reads 'Expiration date expired N days ago (Jun 1, 2026)' — no field key, date once", async () => {
    const storage = stubStorage({
      getDocuments: async () => [{
        id: "doc-1", name: "Homeowners Insurance Policy Declaration", type: "insurance",
        extractedData: { expirationDate: "2026-06-01" }, linkedProfiles: [], tags: [], createdAt: "2026-01-01T00:00:00Z",
      }],
      getTasks: async () => [{ id: "t1", title: "Pet my dog", status: "todo", priority: "medium", dueDate: "2026-09-10" }],
    });
    const list = await buildNotifications(storage, "America/New_York");
    const doc = list.find((n) => n.type === "document_expiring")!;
    expect(doc).toBeTruthy();
    expect(doc.message).not.toMatch(/expirationDate/);
    expect(doc.message).toMatch(/^Expiration date expired \d+ days ago \(Jun 1, 2026\)$/);
    expect(doc.message.match(/2026/g)!.length).toBe(1);
    expect(doc.message).not.toMatch(/2026-06-01/);
    expect(doc.severity).toBe("critical");
    const task = list.find((n) => n.type === "task_overdue")!;
    expect(task.title).toBe("Overdue: Pet my dog");
    expect(task.severity).toBe("warning");
  });
});
