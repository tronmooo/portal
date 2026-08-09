// tests/timed-tasks.test.ts
//
// Regression guard for the failure reported 2026-08-09, and for the model
// change it forced.
//
//   User: "Every Tuesday, I have to mow the lawn at 9 AM for the next year"
//   Chat: "52 weekly 'Mow the lawn' reminders set — through Aug 2027."
//   Tasks → Recurring: (0). Calendar, every Tuesday after the first: empty.
//
// Mowing the lawn is something you DO. It was filed as a "reminder" — a third
// entity that existed only because tasks had no clock time — which meant 52
// notification-only rows that could not be checked off, never reached the
// Recurring list, and touched the calendar only through a mirrored event for
// occurrence #1.
//
// Portol now has exactly two scheduled entities: EVENTS (things that happen)
// and TASKS (things you do). A task carries `dueTime`, so anything with a clock
// time is a task, on the calendar at that hour. These tests run the REAL
// executor against the real in-memory storage and read the REAL calendar
// timeline, so they fail if either end of that contract drifts.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool, TOOL_DEFINITIONS } from "../server/ai-engine";
import { taskOccurrenceDates } from "@shared/task-occurrences";
import { parseRecurrence } from "@shared/recurrence";
import { normalizeClockTime } from "@shared/timezone";

// The chat layer's creation-dedup cache is module-level and keyed by user id,
// so every test gets its own user — otherwise the second test would be told the
// task it is about to write was "already created" by the first.
let seq = 0;
const nextUser = () => `user-timed-task-${++seq}`;

/** The reported request, as the model should now express it. */
const MOW = {
  title: "Mow the lawn",
  dueDate: "2026-08-11",     // the next Tuesday
  dueTime: "09:00",
  recurrence: "weekly",
  recurrenceEnd: "2027-08-10",
};

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

/** The dates a title occupies on the calendar, as the Calendar page sees them. */
async function calendarDates(storage: MemStorage, title: string, start: string, end: string) {
  const items = await run(storage, () => storage.getCalendarTimeline(start, end));
  return items.filter(i => i.title === title).map(i => i.date).sort();
}

describe("there is no reminder entity — only events and tasks", () => {
  it("offers no reminder tools to the model", () => {
    const names = TOOL_DEFINITIONS.map((t: any) => t.name);
    expect(names).not.toContain("create_reminder");
    expect(names).not.toContain("update_reminder");
    expect(names).not.toContain("delete_reminder");
    expect(names).toContain("create_task");
    expect(names).toContain("create_event");
  });

  it("tells the model a clock time belongs on a task", () => {
    const createTask: any = TOOL_DEFINITIONS.find((t: any) => t.name === "create_task");
    expect(createTask.input_schema.properties.dueTime).toBeTruthy();
    expect(createTask.description).toMatch(/remind me/i);
  });
});

describe("a repeating timed task lands on every date it is due", () => {
  let storage: MemStorage;
  let USER: string;
  beforeEach(() => { storage = new MemStorage(); USER = nextUser(); });

  it("writes ONE task, not 52 rows", async () => {
    await run(storage, () => executeTool("create_task", { ...MOW }, USER));
    const tasks = await run(storage, () => storage.getTasks());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Mow the lawn", dueDate: "2026-08-11", dueTime: "09:00" });
  });

  it("files it as a recurring task with the end the user asked for", async () => {
    await run(storage, () => executeTool("create_task", { ...MOW }, USER));
    const [task] = await run(storage, () => storage.getTasks());
    // This is what the Tasks → Recurring tab reads. It said (0) before.
    const rule = parseRecurrence(task.tags);
    expect(rule.freq).toBe("weekly");
    expect(rule.until).toBe("2027-08-10");
  });

  it("puts EVERY Tuesday on the calendar, not just the first", async () => {
    await run(storage, () => executeTool("create_task", { ...MOW }, USER));

    // The bug in one assertion: this returned ["2026-08-11"] alone.
    expect(await calendarDates(storage, "Mow the lawn", "2026-08-01", "2026-08-31"))
      .toEqual(["2026-08-11", "2026-08-18", "2026-08-25"]);

    // ...and it keeps going for the full year the user asked for.
    const nextJuly = await calendarDates(storage, "Mow the lawn", "2027-07-01", "2027-07-31");
    expect(nextJuly.length).toBeGreaterThan(0);
    expect(nextJuly.every(d => new Date(d + "T00:00:00").getDay() === 2)).toBe(true);
  });

  it("carries the 9 AM onto every occurrence", async () => {
    await run(storage, () => executeTool("create_task", { ...MOW }, USER));
    const items = await run(storage, () => storage.getCalendarTimeline("2026-08-01", "2026-08-31"));
    const mow = items.filter(i => i.title === "Mow the lawn");
    expect(mow).toHaveLength(3);
    expect(mow.every(i => i.time === "09:00")).toBe(true);
    expect(mow.every(i => i.allDay === false)).toBe(true);
  });

  it("stops at the end of the series instead of repeating forever", async () => {
    await run(storage, () => executeTool("create_task", { ...MOW }, USER));
    expect(await calendarDates(storage, "Mow the lawn", "2027-08-11", "2027-12-31")).toEqual([]);
  });

  it("leaves no companion calendar event to fall out of sync with", async () => {
    await run(storage, () => executeTool("create_task", { ...MOW }, USER));
    expect(await run(storage, () => storage.getEvents())).toHaveLength(0);
  });

  it("keeps an untimed task all-day rather than parking it at midnight", async () => {
    await run(storage, () => executeTool("create_task", { title: "Buy milk", dueDate: "2026-08-11" }, USER));
    const items = await run(storage, () => storage.getCalendarTimeline("2026-08-01", "2026-08-31"));
    const milk = items.find(i => i.title === "Buy milk")!;
    expect(milk.allDay).toBe(true);
    expect(milk.time).toBeUndefined();
  });

  it("still treats a one-time job as one-time, even with a time on it", async () => {
    await run(storage, () => executeTool("create_task", {
      title: "Call the dentist", dueDate: "2026-08-12", dueTime: "10:00",
    }, USER));
    expect(await calendarDates(storage, "Call the dentist", "2026-08-01", "2026-12-31"))
      .toEqual(["2026-08-12"]);
  });
});

describe("legacy reminder tool names still answer, as tasks", () => {
  let storage: MemStorage;
  let USER: string;
  beforeEach(() => { storage = new MemStorage(); USER = nextUser(); });

  it("translates a create_reminder call into a timed task", async () => {
    // A turn already in flight, a replayed transcript, or a bulk plan drafted a
    // moment before the change can still name the old tool. Erroring would lose
    // the user's request; the request IS a timed task.
    await run(storage, () => executeTool("create_reminder", {
      title: "Take meds", fireAt: "2026-08-11T08:00:00", recurrence: "daily", count: 10,
    }, USER));
    const tasks = await run(storage, () => storage.getTasks());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Take meds", dueDate: "2026-08-11", dueTime: "08:00" });
    const rule = parseRecurrence(tasks[0].tags);
    expect(rule.freq).toBe("daily");
    expect(rule.count).toBe(10);
  });

  it("translates delete_reminder into deleting the task", async () => {
    await run(storage, () => executeTool("create_task", {
      title: "Take meds", dueDate: "2026-08-11", dueTime: "08:00",
    }, USER));
    await run(storage, () => executeTool("delete_reminder", { title: "Take meds" }, USER));
    expect(await run(storage, () => storage.getTasks())).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The occurrence projection itself (pure — no storage)
// ─────────────────────────────────────────────────────────────────────────────
describe("taskOccurrenceDates", () => {
  const weekly = (over: Record<string, any> = {}) => ({
    dueDate: "2026-08-11", tags: ["recur:weekly"], status: "todo", ...over,
  });

  it("yields a one-time task exactly once, and only inside the window", () => {
    const one = { dueDate: "2026-08-11", tags: [], status: "todo" };
    expect(taskOccurrenceDates(one, "2026-08-01", "2026-08-31")).toEqual(["2026-08-11"]);
    expect(taskOccurrenceDates(one, "2026-09-01", "2026-09-30")).toEqual([]);
  });

  it("honours runtil:", () => {
    const dates = taskOccurrenceDates(weekly({ tags: ["recur:weekly", "runtil:2026-08-25"] }), "2026-08-01", "2026-12-31");
    expect(dates).toEqual(["2026-08-11", "2026-08-18", "2026-08-25"]);
  });

  it("honours rcount: net of what is already done", () => {
    const dates = taskOccurrenceDates(weekly({ tags: ["recur:weekly", "rcount:4", "rdone:1"] }), "2026-08-01", "2026-12-31");
    expect(dates).toEqual(["2026-08-11", "2026-08-18", "2026-08-25"]);
  });

  it("clamps a monthly series to the month end instead of drifting off its day", () => {
    const dates = taskOccurrenceDates(
      { dueDate: "2027-01-31", tags: ["recur:monthly", "ranchor:31"], status: "todo" },
      "2027-01-01", "2027-04-30",
    );
    expect(dates).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  });

  it("walks weekdays without landing on a weekend", () => {
    const dates = taskOccurrenceDates(
      { dueDate: "2026-08-11", tags: ["recur:weekdays"], status: "todo" },
      "2026-08-11", "2026-08-19",
    );
    expect(dates).toEqual([
      "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14",
      "2026-08-17", "2026-08-18", "2026-08-19",
    ]);
  });

  it("costs the same for an old series as a new one — no cap exhaustion", () => {
    // A daily task started five years ago must still show up this month. The
    // equivalent event expansion once walked from the base date and ran out of
    // iterations before reaching the window, so the series vanished entirely.
    const dates = taskOccurrenceDates(
      { dueDate: "2021-08-11", tags: ["recur:daily"], status: "todo" },
      "2026-08-01", "2026-08-05",
    );
    expect(dates).toEqual(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]);
  });

  it("hides a paused series' future dates but keeps its history", () => {
    const dates = taskOccurrenceDates(
      weekly({ tags: ["recur:weekly", "rpaused"] }),
      "2026-08-01", "2026-09-30",
      { todayISO: "2026-08-20" },
    );
    expect(dates).toEqual(["2026-08-11", "2026-08-18"]);
  });
});

describe("normalizeClockTime", () => {
  it("accepts every shape a clock time reaches a task in", () => {
    expect(normalizeClockTime("09:00")).toBe("09:00");
    expect(normalizeClockTime("9:00")).toBe("09:00");
    expect(normalizeClockTime("9am")).toBe("09:00");
    expect(normalizeClockTime("9 AM")).toBe("09:00");
    expect(normalizeClockTime("9:30 PM")).toBe("21:30");
    expect(normalizeClockTime("12 a.m.")).toBe("00:00");
    expect(normalizeClockTime("12pm")).toBe("12:00");
    expect(normalizeClockTime("17:51:00")).toBe("17:51");
    expect(normalizeClockTime("2026-08-11T09:00:00")).toBe("09:00");
    expect(normalizeClockTime("2026-08-11 09:00")).toBe("09:00");
  });

  it("returns null for anything that is not a time, rather than guessing midnight", () => {
    expect(normalizeClockTime("")).toBeNull();
    expect(normalizeClockTime(undefined)).toBeNull();
    expect(normalizeClockTime("banana")).toBeNull();
    expect(normalizeClockTime("25:00")).toBeNull();
    expect(normalizeClockTime("09:60")).toBeNull();
    expect(normalizeClockTime("13pm")).toBeNull();
    expect(normalizeClockTime("2026-08-11")).toBeNull();
  });
});
