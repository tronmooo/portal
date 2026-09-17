// tests/recurring-task-rollover.test.ts
//
// QA 2026-09-17: "Recurring tasks never move to their next date."
//
//   "Put out the trash" (weekly) was still due Aug 13 and showed as 35 days
//   overdue while the bell said it was due today; "Pet my dog" and "Mow the
//   lawn" were stuck the same way. "Take medication" (daily until Aug 11)
//   still read 38 days overdue. The "repeats until" label dropped its year,
//   so `runtil:2028-08-02` read "until Aug 2" as if the series had ended.
//
// A repeating task stores one row — its next due date — and only advanced it
// when the user completed the row. These tests pin the roll-forward rule the
// server now applies on every task read, plus the ONE task-count rule the
// three task surfaces share.
import { describe, it, expect } from "vitest";
import { rollForwardRecurringTask, humanSummary, parseRecurrence } from "@shared/recurrence";
import { countTasksByDay, isDoneToday } from "@shared/task-counts";

const TODAY = "2026-09-17"; // a Thursday

describe("rollForwardRecurringTask", () => {
  it("moves a missed weekly chore to its next occurrence on or after today, keeping the weekday", () => {
    // Aug 13 2026 is a Thursday; Sep 17 is the next Thursday on/after today.
    const move = rollForwardRecurringTask({ dueDate: "2026-08-13", tags: ["recur:weekly", "runtil:2027-07-29"], status: "todo" }, TODAY);
    expect(move).toEqual({ kind: "advance", dueDate: "2026-09-17", tags: ["recur:weekly", "runtil:2027-07-29"] });
  });

  it("lands on the next occurrence AFTER today when today is not on the cadence", () => {
    // Aug 19 is a Wednesday → Sep 23 is the first Wednesday on/after Sep 17.
    const move = rollForwardRecurringTask({ dueDate: "2026-08-19", tags: ["recur:weekly", "runtil:2028-08-02"], status: "todo" }, TODAY);
    expect(move).toEqual({ kind: "advance", dueDate: "2026-09-23", tags: ["recur:weekly", "runtil:2028-08-02"] });
  });

  it("does not count the missed occurrences as done", () => {
    const move = rollForwardRecurringTask({ dueDate: "2026-08-01", tags: ["recur:daily", "rdone:3", "rcount:10"], status: "todo" }, TODAY);
    expect(move).toMatchObject({ kind: "advance", dueDate: TODAY });
    expect(parseRecurrence((move as any).tags).done).toBe(3);
  });

  it("closes a series whose runtil has passed instead of leaving it overdue for ever", () => {
    const move = rollForwardRecurringTask({ dueDate: "2026-08-10", tags: ["recur:daily", "runtil:2026-08-11"], status: "todo" }, TODAY);
    expect(move).toEqual({ kind: "ended" });
  });

  it("pins a monthly series to its day of month while stepping", () => {
    const move = rollForwardRecurringTask({ dueDate: "2026-01-31", tags: ["recur:monthly"], status: "todo" }, "2026-03-01");
    expect(move).toMatchObject({ kind: "advance", dueDate: "2026-03-31" });
    expect((move as any).tags).toContain("ranchor:31");
  });

  it("leaves alone what is not a missed repeating occurrence", () => {
    // one-time, overdue: stays overdue — that is a real overdue task
    expect(rollForwardRecurringTask({ dueDate: "2026-08-13", tags: [], status: "todo" }, TODAY)).toBeNull();
    // due today or later
    expect(rollForwardRecurringTask({ dueDate: TODAY, tags: ["recur:weekly"], status: "todo" }, TODAY)).toBeNull();
    expect(rollForwardRecurringTask({ dueDate: "2026-10-01", tags: ["recur:monthly"], status: "todo" }, TODAY)).toBeNull();
    // completed rows are history
    expect(rollForwardRecurringTask({ dueDate: "2026-08-13", tags: ["recur:weekly"], status: "done" }, TODAY)).toBeNull();
    // a paused series keeps its place
    expect(rollForwardRecurringTask({ dueDate: "2026-08-13", tags: ["recur:weekly", "rpaused"], status: "todo" }, TODAY)).toBeNull();
    // undated
    expect(rollForwardRecurringTask({ dueDate: null, tags: ["recur:weekly"], status: "todo" }, TODAY)).toBeNull();
    // garbage today
    expect(rollForwardRecurringTask({ dueDate: "2026-08-13", tags: ["recur:weekly"], status: "todo" }, "")).toBeNull();
  });
});

describe("humanSummary — the until date keeps its year", () => {
  it("says which year a far-off end date is in", () => {
    const label = humanSummary(parseRecurrence(["recur:weekly", "runtil:2028-08-02"]), "2026-09-23");
    expect(label).toContain("until Aug 2, 2028");
  });
  it("still reads short inside the current year", () => {
    const y = new Date().getFullYear();
    const label = humanSummary(parseRecurrence(["recur:weekly", `runtil:${y}-12-31`]), `${y}-01-07`);
    expect(label).toContain("until Dec 31");
    expect(label).not.toContain(`Dec 31, ${y}`);
  });
});

describe("countTasksByDay — one rule for every task surface", () => {
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
  it("never counts an all-time completion as today's", () => {
    expect(isDoneToday({ status: "done", updatedAt: "2026-08-01T18:00:00Z" }, TODAY, tz)).toBe(false);
    expect(isDoneToday({ status: "todo", updatedAt: "2026-09-17T18:00:00Z" }, TODAY, tz)).toBe(false);
  });
});
