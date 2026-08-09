// Pins TIMED TASKS in the cross-app Upcoming Dates feed.
//
// Regression source (user report 2026-07-15): "remind me to take evening
// medication" never appeared on the dashboard — the aggregator didn't consume
// the reminders endpoint at all, and the Executive briefing row read a
// nonexistent `dueDate` field because reminders only carried `fireAt`.
//
// Reminders were retired on 2026-08-09: Portol has EVENTS and TASKS, and a task
// carries its own clock time. That deletes the class of bug above — there is one
// row, with one date field, that every surface already reads — so this file
// pins the behaviour on the entity that replaced it: a timed task must show up
// in Upcoming with its hour, obey the same window, and carry its owner.
import { describe, it, expect } from "vitest";
import { aggregateUpcomingDates, CATEGORY_LABELS, CATEGORY_ICONS } from "@shared/upcoming-dates";

function dayFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA");
}

const task = (over: Record<string, any> = {}) => ({
  id: "task-1",
  title: "Take evening medication",
  status: "todo",
  priority: "medium",
  dueDate: dayFromNow(0),
  dueTime: "18:00",
  linkedProfiles: [],
  tags: [],
  ...over,
});

describe("aggregateUpcomingDates — timed tasks", () => {
  it("surfaces a timed task with its due day and hour", () => {
    const items = aggregateUpcomingDates({ tasks: [task()] });
    const t = items.find((i) => i.category === "task_due");
    expect(t, "timed task appears in the Upcoming feed").toBeTruthy();
    expect(t!.title).toBe("Take evening medication");
    expect(t!.daysUntil).toBe(0);
    expect(t!.timeframe).toBe("today");
    // The hour is the point — an all-day "Priority: medium" would be a downgrade
    // from what the reminder row used to say.
    expect(t!.subtitle).toBe("6:00 PM");
    expect(t!.icon).toBe(CATEGORY_ICONS.task_due);
    expect(CATEGORY_LABELS.task_due).toBeTruthy();
  });

  it("falls back to priority when the task has no clock time", () => {
    const items = aggregateUpcomingDates({ tasks: [task({ dueTime: undefined })] });
    expect(items.find((i) => i.category === "task_due")!.subtitle).toBe("Priority: medium");
  });

  it("excludes done, deleted, past and beyond-window tasks", () => {
    const items = aggregateUpcomingDates({
      tasks: [
        task({ id: "done", status: "done" }),
        task({ id: "deleted", deletedAt: dayFromNow(-1) }),
        task({ id: "past", dueDate: dayFromNow(-3) }),
        task({ id: "far", dueDate: dayFromNow(90) }),
        task({ id: "undated", dueDate: undefined }),
        task({ id: "keep", dueDate: dayFromNow(2) }),
      ],
    });
    const dues = items.filter((i) => i.category === "task_due");
    expect(dues.map((d) => d.sourceId)).toEqual(["keep"]);
  });

  it("marks a repeating task as recurring", () => {
    const items = aggregateUpcomingDates({ tasks: [task({ tags: ["recur:weekly"] })] });
    expect(items.find((i) => i.category === "task_due")!.recurring).toBe(true);
    const once = aggregateUpcomingDates({ tasks: [task({ id: "t2" })] });
    expect(once.find((i) => i.category === "task_due")!.recurring).toBe(false);
  });

  it("does not list the task twice when a same-named event shares the day", () => {
    // Chat used to write BOTH a reminder row and a mirrored calendar event, so
    // one instruction produced two Upcoming rows. A timed task is one row.
    const items = aggregateUpcomingDates({
      events: [{ id: "ev-1", title: "Take evening medication", date: dayFromNow(0) }],
      tasks: [task()],
    });
    const matching = items.filter((i) => i.title.toLowerCase() === "take evening medication");
    expect(matching.map((m) => m.category).sort()).toEqual(["calendar_event", "task_due"]);
  });

  it("carries the task's owner for scope filtering", () => {
    const items = aggregateUpcomingDates({ tasks: [task({ linkedProfiles: ["prof-9"] })] });
    expect(items.find((i) => i.category === "task_due")!.relatedProfileId).toBe("prof-9");
  });
});
