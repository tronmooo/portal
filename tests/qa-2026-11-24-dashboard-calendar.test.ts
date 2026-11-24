// Owner report 2026-11-24 — four bugs from one session on the Dashboard and
// Calendar. Each block pins the rule that was broken:
//   1. a date that is still being typed is never saved, and never dropped;
//   2. a completed task is completed on the Calendar too, dated or not;
//   3. a warranty's START date is not an expiration;
//   4. the AI summary cannot deny what the dashboard tiles count.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { classifyDateField, scanEntityDates, isAlertDateRule, isDocumentAttentionRule, rulesFromDocuments } from "../shared/date-rules";
import { isTaskOccurrenceDone } from "../shared/task-occurrences";
import { briefingFacts, briefingContradictions, reconcileBriefing, factualBriefing, briefingFingerprint } from "../shared/dashboard-briefing";
import { isCommittableDay, dateInputState } from "../client/src/lib/date-input";
import { liveTimelineItem } from "../client/src/lib/calendar-live-item";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("3 · a warranty's start date is not an expiration", () => {
  it.each([
    "warrantyStartDate", "warranty_start_date", "warrantyStart", "warrantyBeginDate", "warrantyEffectiveDate",
    "warrantyPurchaseDate", "warrantyRegistrationDate", "warrantyFrom", "warrantyCoverageStartDate", "warrantiesStartDate",
  ])("%s is a fact about when cover began, not something to act on", (key) => {
    const cls = classifyDateField(key, "warranty");
    expect(cls.ruleType).toBe("informational");
    expect(cls.actionable).toBe(false);
  });

  it.each(["warrantyExpiration", "warrantyExpirationDate", "warrantyEndDate", "warranty_expires", "warrantyUntil", "warrantyDate", "warranty"])(
    "%s is still the warranty's expiration", (key) => {
      const cls = classifyDateField(key, "warranty");
      expect(cls.ruleType).toBe("expiration");
      expect(cls.ruleSubtype).toBe("warranty");
    });

  it("the Goodyear document: a start date in the past raises nothing; its expiration still does", () => {
    const rules = rulesFromDocuments([{
      id: "doc-goodyear", name: "Goodyear Tires Warranty", type: "warranty",
      extractedData: { warrantyStartDate: "2024-03-10", warrantyExpirationDate: "2029-03-10" },
    }]);
    // The strict read: the rule list exists and names its source fields.
    expect(Array.isArray(rules)).toBe(true);
    const fields = rules.map((r) => r.sourceField);
    expect(fields).toContain("warrantyExpirationDate");
    expect(fields).not.toContain("warrantyStartDate");
    const alerts = rules.filter((r) => isAlertDateRule(r) || isDocumentAttentionRule(r));
    expect(alerts.map((r) => r.sourceField)).toEqual(["warrantyExpirationDate"]);
  });

  it("a document holding ONLY a start date has no alert at all", () => {
    const rules = scanEntityDates({ warrantyStartDate: "2024-03-10" }, { entityType: "document", entityId: "d1", entityName: "Goodyear Tires", contextKey: "warranty" } as any);
    expect(rules.filter((r) => isAlertDateRule(r) || isDocumentAttentionRule(r))).toEqual([]);
  });
});

describe("2 · a completed task is completed on the Calendar", () => {
  it("an undated task is done when its row is done (it has one occurrence: itself)", () => {
    expect(isTaskOccurrenceDone({ status: "done", dueDate: null }, "2026-11-24")).toBe(true);
    expect(isTaskOccurrenceDone({ status: "done" }, "2026-11-24")).toBe(true);
    expect(isTaskOccurrenceDone({ status: "todo", dueDate: null }, "2026-11-24")).toBe(false);
  });
  it("a dated task is done on its stored date only (projected dates stay to do)", () => {
    expect(isTaskOccurrenceDone({ status: "done", dueDate: "2026-11-25" }, "2026-11-25")).toBe(true);
    expect(isTaskOccurrenceDone({ status: "done", dueDate: "2026-11-25T00:00:00.000Z" }, "2026-11-25")).toBe(true);
    expect(isTaskOccurrenceDone({ status: "done", dueDate: "2026-11-25" }, "2026-12-02")).toBe(false);
    expect(isTaskOccurrenceDone({ status: "todo", dueDate: "2026-11-25" }, "2026-11-25")).toBe(false);
  });
  it("the timeline asks that rule, and marks an undated task as undated", () => {
    const storage = read("server/supabase-storage.ts");
    expect(storage).toContain("completed: isTaskOccurrenceDone(task, d)");
    expect(storage).not.toMatch(/completed:\s*task\.status === "done" && d ===/);
    expect(storage).toContain("{ undated: true }");
  });
  it("the open detail follows the live timeline row, not the snapshot from the tap", () => {
    const opened = { id: "task-1", completed: false };
    const now = [{ id: "task-0", completed: false }, { id: "task-1", completed: true }];
    expect(liveTimelineItem(opened, now)?.completed).toBe(true);
    expect(liveTimelineItem(opened, [])).toBe(opened); // left the window: keep showing it
    expect(liveTimelineItem(null, now)).toBeNull();
    const view = read("client/src/components/CalendarView.tsx");
    expect(view).toContain("liveTimelineItem(detailItem, timelineItems)");
    expect(view).toContain("item={liveDetailItem}");
    expect(view).not.toMatch(/<EventDetailDialog[^>]*item=\{detailItem\}/s);
    // The toggle says which state it asks for; it does not read the item after it flipped.
    expect(view).toContain("toggleTaskMutation.mutate(!item.completed)");
  });
});

describe("1 · a date that is still being typed", () => {
  it("only a whole day in a year a person means can be saved", () => {
    // What a native date input reports while 11/25/2026 is typed.
    expect(isCommittableDay("0002-11-25")).toBe(false);
    expect(isCommittableDay("0020-11-25")).toBe(false);
    expect(isCommittableDay("0202-11-25")).toBe(false);
    expect(isCommittableDay("2026-11-25")).toBe(true);
    expect(isCommittableDay("2026-02-30")).toBe(false);
    expect(isCommittableDay("")).toBe(false);
    expect(isCommittableDay(undefined)).toBe(false);
  });
  it("half-typed is its own state: not empty, not complete", () => {
    expect(dateInputState({ value: "", validity: { badInput: true } })).toBe("partial");
    expect(dateInputState({ value: "", validity: { badInput: false } })).toBe("empty");
    expect(dateInputState({ value: "0002-11-25", validity: { badInput: false } })).toBe("partial");
    expect(dateInputState({ value: "2026-11-25", validity: { badInput: false } })).toBe("complete");
  });
  it("no date input anywhere in the client saves from its own onChange", () => {
    // `<input type="date" onChange={e => mutate(e.target.value)} />` writes
    // year 2 on the first typed year digit. A date field that saves is a
    // CommitDateInput; a form holds the value in state and saves on submit.
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "client/src"))) {
      const src = readFileSync(file, "utf8");
      const re = /type="date"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const start = src.lastIndexOf("<", m.index);
        const end = src.indexOf("/>", m.index);
        if (start < 0 || end < 0) continue;
        const tag = src.slice(start, end);
        const onChange = tag.match(/onChange=\{[\s\S]*$/)?.[0] ?? "";
        if (/\.mutate(Async)?\(|apiRequest\(/.test(onChange)) {
          offenders.push(`${file.replace(ROOT + "/", "")}:${src.slice(0, m.index).split("\n").length}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
  it("the task editors use the committing field, and the forms refuse a half-typed date", () => {
    const popup = read("client/src/components/dashboard/TaskHabitPopups.tsx");
    expect(popup).toMatch(/<CommitDateInput[^>]*onCommit=\{\(day\) => updateMutation\.mutate\(\{ id: t\.id, patch: \{ dueDate: day \} \}\)\}/);
    expect(popup).toContain('dateInputState(composerDueRef.current) === "partial"');
    const page = read("client/src/pages/tasks.tsx");
    expect(page).toContain("<CommitDateInput");
    expect(page).toContain('dateInputState(dueInputRef.current) === "partial"');
    expect(read("client/src/components/QuickCreateFab.tsx")).toContain('dateInputState(dueRef.current) === "partial"');
  });
});

describe("4 · the AI summary cannot contradict the dashboard", () => {
  const today = "2026-11-24";
  const tasks = [
    { id: "1", status: "todo", dueDate: "2026-11-20" },            // late
    { id: "2", status: "todo", dueDate: "2026-11-24" },            // today
    { id: "3", status: "todo", dueDate: "2026-11-25" },
    { id: "4", status: "todo", dueDate: "2026-11-30" },
    { id: "5", status: "todo", dueDate: "2026-12-05" },
    { id: "6", status: "in_progress" },                            // unscheduled
    { id: "7", status: "todo" },
    { id: "8", status: "done", dueDate: "2026-11-10" },
  ] as any[];
  const facts = briefingFacts({ tasks, todaysEvents: [{ title: "Dentist" }], upcomingBills: [{ daysUntil: 3 }, { daysUntil: 20 }], todayISO: today, timezone: "America/Los_Angeles" });

  it("counts what the tiles count: 7 tasks due, 1 late, 1 event today", () => {
    expect(facts.openTasks).toBe(7);
    expect(facts.overdueTasks).toBe(1);
    expect(facts.dueToday).toBe(1);
    expect(facts.unscheduledTasks).toBe(2);
    expect(facts.eventsToday).toBe(1);
    expect(facts.eventTitlesToday).toEqual(["Dentist"]);
    expect(facts.billsDueThisWeek).toBe(1);
  });
  it("a list that did not load is an error, never a zero", () => {
    expect(() => briefingFacts({ tasks: undefined as any, todaysEvents: [], upcomingBills: [], todayISO: today })).toThrow(/tasks/);
    expect(() => briefingFacts({ tasks: [], todaysEvents: undefined as any, upcomingBills: [], todayISO: today })).toThrow(/todaysEvents/);
    expect(() => briefingFacts({ tasks: [], todaysEvents: [], upcomingBills: undefined as any, todayISO: today })).toThrow(/upcomingBills/);
  });
  it("the reported paragraph is refused and replaced by the facts", () => {
    const said = "Your net worth is $525,000. There are no tasks, overdue items, or events scheduled for today. Consider reviewing your budget.";
    expect(briefingContradictions(said, facts).sort()).toEqual(["events", "overdue", "tasks"]);
    const out = reconcileBriefing(said, facts);
    expect(out.replaced).toBe(true);
    expect(out.summary).toContain("7 open tasks");
    expect(out.summary).toContain("1 late");
    expect(out.summary).toContain("1 event today: Dentist");
  });
  it.each([
    "You don't have any tasks today.",
    "Nothing is scheduled today, so enjoy the quiet.",
    "Zero overdue items — nice work.",
    "Your calendar is clear.",
  ])("also refused: %s", (said) => {
    expect(reconcileBriefing(said, facts).replaced).toBe(true);
  });
  it("a paragraph that agrees is kept as written", () => {
    const said = "You have 7 open tasks, 1 of them late, and the Dentist today. No bills are overdue, but 1 is due this week. Start with the late task.";
    // "No bills are overdue" denies overdue BILLS… and is still treated as a denial of "overdue": the safe side.
    const ok = "You have 7 open tasks, 1 of them late, and the Dentist today. One bill is due this week. Start with the late task.";
    expect(reconcileBriefing(ok, facts)).toEqual({ summary: ok, replaced: false, contradictions: [] });
    expect(reconcileBriefing(said, facts).replaced).toBe(true);
    expect(reconcileBriefing("No bills this week, but 7 tasks are open and 1 is late; the Dentist is today.", facts).replaced).toBe(false);
  });
  it("with nothing on the dashboard, saying so is not a contradiction", () => {
    const empty = briefingFacts({ tasks: [], todaysEvents: [], upcomingBills: [], todayISO: today });
    expect(reconcileBriefing("No tasks or events today.", empty).replaced).toBe(false);
    expect(factualBriefing(empty)).toBe("You have no open tasks. Nothing is on the calendar today.");
  });
  it("an empty model answer is the facts, and a cached summary dies with its facts", () => {
    expect(reconcileBriefing("", facts).summary).toBe(factualBriefing(facts));
    const after = briefingFacts({ tasks: [...tasks, { id: "9", status: "todo" }], todaysEvents: [{ title: "Dentist" }], upcomingBills: [], todayISO: today });
    expect(briefingFingerprint(after)).not.toBe(briefingFingerprint(facts));
  });
  it("the route counts with briefingFacts and never reads lists the payload does not carry", () => {
    const routes = read("server/routes.ts");
    const at = routes.indexOf('app.post("/api/ai/summary"');
    expect(at).toBeGreaterThan(0);
    const body = routes.slice(at, routes.indexOf('app.post("/api/smart-fill/analyze"', at));
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("briefingFacts({");
    expect(body).toContain("reconcileBriefing(text, facts)");
    expect(body).toContain("briefingFingerprint(facts)");
    expect(body).not.toMatch(/enhanced\?\.(tasks|events|habits)\b/);
  });
});
