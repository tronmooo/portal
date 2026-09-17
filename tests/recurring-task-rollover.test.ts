// Recurring tasks that were never ticked off move to their current occurrence.
//
// A series is ONE row at its next due date, and only completing it stepped
// that date. Skip a week and the row stayed put: "Put out the trash" read
// "35 days overdue" from Aug 13 five weeks later while the calendar, which
// projects the rule, had it on today. These pin the rollover that carries the
// row forward, the sweep of the retired reminder cron's leftovers, and the
// "until" label that used to drop the year.
import { describe, it, expect } from "vitest";
import { rollForwardRecurringTask, humanSummary, parseRecurrence } from "../shared/recurrence";
import { isLegacyReminderTask } from "../shared/legacy-reminder-tasks";
import { MemStorage } from "../server/storage";

const TODAY = "2026-09-17"; // a Thursday

describe("rollForwardRecurringTask", () => {
  it("carries a skipped weekly chore to its latest occurrence on or before today, keeping the weekday", () => {
    // Aug 13 2026 is a Thursday, like today: five missed Thursdays land on today.
    const roll = rollForwardRecurringTask(
      { dueDate: "2026-08-13", tags: ["migrated:reminder", "recur:weekly", "runtil:2027-07-29"], status: "todo" },
      TODAY,
    );
    expect(roll).toEqual({ dueDate: "2026-09-17", tags: ["migrated:reminder", "recur:weekly", "runtil:2027-07-29"] });
  });

  it("stops at the last occurrence BEFORE today rather than skipping ahead", () => {
    // Aug 19 is a Wednesday: the latest Wednesday on or before Thu Sep 17 is Sep 16.
    const roll = rollForwardRecurringTask({ dueDate: "2026-08-19", tags: ["recur:weekly"], status: "todo" }, TODAY);
    expect(roll).toEqual({ dueDate: "2026-09-16", tags: ["recur:weekly"] });
  });

  it("does not count the missed occurrences as done", () => {
    const roll = rollForwardRecurringTask({ dueDate: "2026-09-01", tags: ["recur:daily", "rdone:3"], status: "todo" }, TODAY);
    expect(roll).toEqual({ dueDate: TODAY, tags: ["recur:daily", "rdone:3"] });
  });

  it("pins a monthly series to its anchor day so the step cannot drift", () => {
    const roll = rollForwardRecurringTask({ dueDate: "2026-05-31", tags: ["recur:monthly"], status: "todo" }, TODAY);
    expect(roll).toEqual({ dueDate: "2026-08-31", tags: ["recur:monthly", "ranchor:31"] });
  });

  it("leaves a one-time task, a done row, a paused series and a current row alone", () => {
    expect(rollForwardRecurringTask({ dueDate: "2026-08-13", tags: [], status: "todo" }, TODAY)).toBeNull();
    expect(rollForwardRecurringTask({ dueDate: "2026-08-13", tags: ["recur:weekly"], status: "done" }, TODAY)).toBeNull();
    expect(rollForwardRecurringTask({ dueDate: "2026-08-13", tags: ["recur:weekly", "rpaused"], status: "todo" }, TODAY)).toBeNull();
    expect(rollForwardRecurringTask({ dueDate: TODAY, tags: ["recur:daily"], status: "todo" }, TODAY)).toBeNull();
    expect(rollForwardRecurringTask({ dueDate: "2026-09-20", tags: ["recur:daily"], status: "todo" }, TODAY)).toBeNull();
    expect(rollForwardRecurringTask({ dueDate: undefined, tags: ["recur:daily"], status: "todo" }, TODAY)).toBeNull();
  });

  it("does not move a weekly chore whose next occurrence is still ahead", () => {
    // Due Mon Sep 14, missed; the next Monday is Sep 21 — still overdue three days, not a month.
    expect(rollForwardRecurringTask({ dueDate: "2026-09-14", tags: ["recur:weekly"], status: "todo" }, TODAY)).toBeNull();
  });

  it("retires a series whose end date is behind today", () => {
    // "Take medication" daily until Aug 11 sat open reading "38 days overdue".
    expect(rollForwardRecurringTask(
      { dueDate: "2026-08-11", tags: ["recur:daily", "runtil:2026-08-11"], status: "todo" }, TODAY,
    )).toEqual({ ended: true });
  });

  it("never steps past a `runtil:` that is still ahead", () => {
    const roll = rollForwardRecurringTask({ dueDate: "2026-09-01", tags: ["recur:daily", "runtil:2026-09-10"], status: "todo" }, "2026-09-05");
    expect(roll).toEqual({ dueDate: "2026-09-05", tags: ["recur:daily", "runtil:2026-09-10"] });
  });

  it("holds an `rcount:` series on its final occurrence", () => {
    expect(rollForwardRecurringTask({ dueDate: "2026-09-01", tags: ["recur:daily", "rcount:4", "rdone:3"], status: "todo" }, TODAY)).toBeNull();
  });

  it("ignores a malformed today", () => {
    expect(rollForwardRecurringTask({ dueDate: "2026-08-13", tags: ["recur:weekly"], status: "todo" }, "today")).toBeNull();
  });
});

describe("humanSummary — the until date keeps its year when it is not this year's", () => {
  const now = new Date("2026-09-17T12:00:00");
  it("says the year for a series that runs into another year", () => {
    expect(humanSummary(parseRecurrence(["recur:weekly", "runtil:2028-08-02"]), "2026-09-16", now))
      .toBe("Repeats weekly on Wednesday until Aug 2, 2028");
  });
  it("keeps the short form inside the current year", () => {
    expect(humanSummary(parseRecurrence(["recur:daily", "runtil:2026-12-31"]), TODAY, now))
      .toBe("Repeats daily until Dec 31");
  });
});

describe("isLegacyReminderTask — the retired reminder cron's fingerprint", () => {
  const legacy = { title: "Reminder: Take medication (morning)", status: "todo", dueDate: null, tags: ["reminder"], source: "reminder" };
  it("matches an open, undated, reminder-sourced `Reminder:` task", () => {
    expect(isLegacyReminderTask(legacy)).toBe(true);
  });
  it("leaves a typed task, a dated one, a done one and a differently sourced one alone", () => {
    expect(isLegacyReminderTask({ ...legacy, source: "manual" })).toBe(false);
    expect(isLegacyReminderTask({ ...legacy, dueDate: "2026-09-08" })).toBe(false);
    expect(isLegacyReminderTask({ ...legacy, status: "done" })).toBe(false);
    expect(isLegacyReminderTask({ ...legacy, tags: [] })).toBe(false);
    expect(isLegacyReminderTask({ ...legacy, title: "Take medication" })).toBe(false);
  });
});

describe("MemStorage.repairRecurringTasks / removeLegacyReminderTasks", () => {
  it("moves the skipped series, trashes the ended one, and reports both", async () => {
    const s = new MemStorage();
    const trash = await s.createTask({ title: "Put out the trash", dueDate: "2026-08-13", tags: ["recur:weekly"] } as any);
    const meds = await s.createTask({ title: "Take medication", dueDate: "2026-08-11", tags: ["recur:daily", "runtil:2026-08-11"] } as any);
    const oneOff = await s.createTask({ title: "Call John", dueDate: "2026-08-20", tags: [] } as any);
    expect(await s.repairRecurringTasks(TODAY)).toEqual({ advanced: 1, ended: 1 });
    expect((await s.getTask(trash.id))?.dueDate).toBe(TODAY);
    expect(await s.getTask(meds.id)).toBeUndefined();
    expect((await s.getTask(oneOff.id))?.dueDate).toBe("2026-08-20");
    // Idempotent: a second pass on the same day changes nothing.
    expect(await s.repairRecurringTasks(TODAY)).toEqual({ advanced: 0, ended: 0 });
  });

  it("retires only the legacy reminder rows", async () => {
    const s = new MemStorage();
    const legacy = await s.createTask({ title: "Reminder: Take medication", tags: ["reminder"], source: "reminder" } as any);
    const typed = await s.createTask({ title: "Reminder: Sarah's dentist", dueDate: "2026-09-08", tags: [] } as any);
    expect(await s.removeLegacyReminderTasks()).toBe(1);
    expect(await s.getTask(legacy.id)).toBeUndefined();
    expect(await s.getTask(typed.id)).toBeDefined();
  });
});
