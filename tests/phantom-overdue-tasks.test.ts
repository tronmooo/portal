// tests/phantom-overdue-tasks.test.ts
//
// Reported 2026-08-13, on an account whose ONLY tasks were four undated ones
// (three of them already completed):
//
//   header       TASKS DUE 1
//   Tasks tile   "3 need action"  ·  "Overdue 3"
//   Tasks popup  Today (1) — one open task, no due date
//
// Nothing in the account was overdue, and nothing had a due date at all. The
// count came from the calendar timeline: a task with a NULL due_date is placed
// on its creation day so the calendar can still list it, and every urgency
// counter then read that placement as a deadline. Four days after creation the
// three finished tasks were "4 days overdue".
//
// Two defects, both fixed:
//   1. an undated row must never be bucketed by urgency (`undated` flag,
//      honoured in shared/dated-items.classify);
//   2. an undated task's `completed` flag was computed by comparing the
//      placement date against the EMPTY due date, so a task marked done still
//      arrived as not-done (server/supabase-storage.getCalendarTimeline).
//
// These tests pin the shared bucketing half — the half every surface reads.
import { describe, it, expect } from "vitest";
import { rollupOccurrences, bucketsForKinds } from "@shared/dated-items";
import type { CalendarOccurrence, OccurrenceKind, OccurrenceStatus } from "@shared/calendar-occurrences";

const TODAY = "2026-08-13";

/** The exact row shape the dashboard and calendar build from a timeline item. */
function timelineRow(
  kind: OccurrenceKind,
  date: string,
  opts: { completed?: boolean; undated?: boolean } = {},
): CalendarOccurrence {
  return {
    kind,
    date,
    effectiveDate: date,
    status: (opts.completed ? "done" : "upcoming") as OccurrenceStatus,
    undated: !!opts.undated,
  } as unknown as CalendarOccurrence;
}

describe("undated rows never count as overdue", () => {
  it("reproduces the report: three undated tasks created 4 days ago count as zero", () => {
    // The account, exactly as it stood: one open + three completed, all undated,
    // all created 2026-08-09 and therefore placed on that date.
    const rows = [
      timelineRow("task", "2026-08-09", { undated: true }),                     // delete-test-task (open)
      timelineRow("task", "2026-08-09", { undated: true, completed: true }),    // Water the plants
      timelineRow("task", "2026-08-09", { undated: true, completed: true }),    // Call the bank
      timelineRow("task", "2026-08-10", { completed: true }),                   // Buy milk (had a due date)
    ];

    const buckets = bucketsForKinds(rollupOccurrences(rows, TODAY), ["task", "habit"]);

    expect(buckets.overdue).toBe(0);
    expect(buckets.attention).toBe(0);
    expect(buckets.today).toBe(0);
  });

  it("before the fix, the same rows produced exactly the reported '3 overdue'", () => {
    // Same rows with the flag dropped and completion mis-derived — i.e. what
    // getCalendarTimeline used to emit. Kept as a guard so a regression that
    // reintroduces either defect fails loudly instead of silently.
    const asShippedBefore = [
      timelineRow("task", "2026-08-09"),
      timelineRow("task", "2026-08-09"),
      timelineRow("task", "2026-08-09"),
      timelineRow("task", "2026-08-10", { completed: true }),
    ];
    const buckets = bucketsForKinds(rollupOccurrences(asShippedBefore, TODAY), ["task", "habit"]);
    expect(buckets.overdue).toBe(3);
  });

  it("a real due date still counts — the fix must not silence genuine overdue", () => {
    const rows = [
      timelineRow("task", "2026-08-11"),                    // 2 days past due
      timelineRow("task", TODAY),                           // due today
      timelineRow("task", "2026-08-20"),                    // this month
      timelineRow("task", "2026-08-09", { undated: true }),  // no deadline — ignored
    ];
    const buckets = bucketsForKinds(rollupOccurrences(rows, TODAY), ["task", "habit"]);
    expect(buckets.overdue).toBe(1);
    expect(buckets.today).toBe(1);
    expect(buckets.next30).toBe(2);
    expect(buckets.attention).toBe(3);
  });

  it("an undated row is still part of the stream — only its urgency is dropped", () => {
    const r = rollupOccurrences([timelineRow("task", "2026-08-09", { undated: true })], TODAY);
    // It exists (the calendar can list it) but claims no bucket.
    expect(r.total).toBe(1);
    expect(r.overdue).toBe(0);
    expect(r.byKind.task).toBeUndefined();
  });

  it("undated applies to every kind, not just tasks", () => {
    const r = rollupOccurrences([
      timelineRow("event", "2026-08-01", { undated: true }),
      timelineRow("bill", "2026-08-01", { undated: true }),
    ], TODAY);
    expect(r.overdue).toBe(0);
    expect(r.attention).toBe(0);
  });
});
