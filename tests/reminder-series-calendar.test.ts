// tests/reminder-series-calendar.test.ts
//
// Regression guard for the failure reported 2026-08-09.
//
//   User: "Every Tuesday, I have to mow the lawn at 9 AM for the next year"
//   Chat: "52 weekly 'Mow the lawn' reminders set — every Tuesday at 9:00 AM,
//          starting Aug 11, 2026 through Aug 2027."
//   Calendar: Aug 18, Aug 25, and every other Tuesday — empty.
//
// All 52 reminder ROWS were written. But `create_reminder` mirrored only
// occurrence #1 onto the calendar, and `getCalendarTimeline` reads events,
// tasks, obligations and profiles — never the reminders table. So 51 of the 52
// occurrences the reply promised existed nowhere the user could see them.
//
// The fix mirrors the SERIES: one recurring calendar event ending on the last
// occurrence, which both timelines already expand per date. These tests run the
// REAL executor against the real in-memory storage and read the REAL calendar
// timeline, so they fail if either end of that contract drifts — and they pin
// the lifecycle rules a series mirror brings with it (deleting or moving ONE
// occurrence must not take the other 51 with it).
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";
import { deleteReminderMirrors, syncReminderMirrors, isSeriesMirror } from "../server/reminder-mirror";

// The chat layer's creation-dedup cache is module-level and keyed by user id,
// so every test gets its own user — otherwise test #2 would be told the mirror
// it is about to write was "already created" by test #1.
let seq = 0;
const nextUser = () => `user-reminder-series-${++seq}`;
const TZ = "America/Los_Angeles"; // MemStorage's default zone

/** Tuesdays 9 AM local, starting 2026-08-11 — the reported request. */
const MOW = { title: "Mow the lawn", fireAt: "2026-08-11T09:00:00", recurrence: "weekly", count: 52 };

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

/** The calendar dates a title occupies in a window, as the Calendar page sees them. */
async function calendarDates(storage: MemStorage, title: string, start: string, end: string) {
  const items = await run(storage, () => storage.getCalendarTimeline(start, end));
  return items.filter(i => i.title === title).map(i => i.date).sort();
}

describe("a repeating reminder is visible on every date it fires", () => {
  let storage: MemStorage;
  let USER: string;
  beforeEach(() => { storage = new MemStorage(); USER = nextUser(); });

  it("writes one reminder row per occurrence", async () => {
    await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));
    const rows = await run(storage, () => storage.listReminders());
    expect(rows.filter(r => r.title === "Mow the lawn")).toHaveLength(52);
  });

  it("puts EVERY Tuesday on the calendar, not just the first", async () => {
    await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));

    // The bug in one assertion: this returned ["2026-08-11"] alone.
    const august = await calendarDates(storage, "Mow the lawn", "2026-08-01", "2026-08-31");
    expect(august).toEqual(["2026-08-11", "2026-08-18", "2026-08-25"]);

    // ...and it keeps going for the full year the user asked for.
    const nextJuly = await calendarDates(storage, "Mow the lawn", "2027-07-01", "2027-07-31");
    expect(nextJuly.length).toBeGreaterThan(0);
    expect(nextJuly.every(d => new Date(d + "T00:00:00").getDay() === 2)).toBe(true);
  });

  it("stops at the end of the series instead of repeating forever", async () => {
    await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));
    // 52 weekly occurrences from 2026-08-11 end on 2027-08-03.
    const after = await calendarDates(storage, "Mow the lawn", "2027-08-04", "2027-12-31");
    expect(after).toEqual([]);
  });

  it("carries the 9 AM the user asked for onto each occurrence", async () => {
    await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));
    const items = await run(storage, () => storage.getCalendarTimeline("2026-08-01", "2026-08-31"));
    const mow = items.filter(i => i.title === "Mow the lawn");
    expect(mow.length).toBe(3);
    expect(mow.every(i => i.time === "09:00")).toBe(true);
  });

  it("spends ONE calendar row on the series, not 52", async () => {
    await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));
    const events = await run(storage, () => storage.getEvents());
    const mirrors = events.filter(e => e.title === "Mow the lawn");
    expect(mirrors).toHaveLength(1);
    expect(isSeriesMirror(mirrors[0])).toBe(true);
    expect(mirrors[0].recurrence).toBe("weekly");
    expect(mirrors[0].recurrenceEnd).toBe("2027-08-03");
  });

  it("reports the real occurrence count back to the model", async () => {
    const res: any = await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));
    expect(res.occurrences).toBe(52);
    expect(res.through).toBe("2027-08-03");
    expect(res.message).toContain("52");
  });

  it("leaves a one-off reminder exactly as it was", async () => {
    await run(storage, () => executeTool("create_reminder", {
      title: "Call the plumber", fireAt: "2026-08-12T17:00:00",
    }, USER));
    const events = await run(storage, () => storage.getEvents());
    const mirror = events.find(e => e.title === "Call the plumber");
    expect(mirror?.recurrence).toBe("none");
    expect(mirror?.recurrenceEnd).toBeUndefined();
    expect(await calendarDates(storage, "Call the plumber", "2026-08-01", "2026-12-31")).toEqual(["2026-08-12"]);
  });

  it("falls back to per-occurrence rows for a cadence the calendar has no pattern for", async () => {
    // "quarterly" is a reminder cadence with no RecurrencePattern equivalent —
    // it must still land on all four dates rather than silently on one.
    await run(storage, () => executeTool("create_reminder", {
      title: "Change the furnace filter", fireAt: "2026-08-11T09:00:00", recurrence: "quarterly", count: 4,
    }, USER));
    const dates = await calendarDates(storage, "Change the furnace filter", "2026-01-01", "2027-12-31");
    expect(dates).toEqual(["2026-08-11", "2026-11-11", "2027-02-11", "2027-05-11"]);
  });
});

describe("editing one occurrence of a series leaves the rest alone", () => {
  let storage: MemStorage;
  let USER: string;
  beforeEach(() => { storage = new MemStorage(); USER = nextUser(); });

  it("deleting one occurrence hides only that date", async () => {
    await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));
    const rows = await run(storage, () => storage.listReminders());
    const aug18 = rows.find(r => r.fireAt.startsWith("2026-08-18"))!;
    expect(aug18).toBeTruthy();

    await run(storage, () => storage.deleteReminder(aug18.id));
    await run(storage, () => deleteReminderMirrors(storage as any, aug18, TZ));

    // Aug 18 gone; Aug 11 and Aug 25 untouched. Deleting the mirror row
    // outright would have taken all 52 with it.
    expect(await calendarDates(storage, "Mow the lawn", "2026-08-01", "2026-08-31"))
      .toEqual(["2026-08-11", "2026-08-25"]);
  });

  it("moving one occurrence does not drag the series off its schedule", async () => {
    await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));
    const rows = await run(storage, () => storage.listReminders());
    const aug18 = rows.find(r => r.fireAt.startsWith("2026-08-18"))!;
    const moved = { title: aug18.title, fireAt: "2026-08-19T09:00:00.000Z" };

    await run(storage, () => syncReminderMirrors(storage as any, aug18, moved, TZ));

    const dates = await calendarDates(storage, "Mow the lawn", "2026-08-01", "2026-08-31");
    expect(dates).toContain("2026-08-11");
    expect(dates).toContain("2026-08-25");
    expect(dates).not.toContain("2026-08-18");
    expect(dates).toContain("2026-08-19"); // re-mirrored on its own
  });

  it("deleting the whole reminder clears the whole series from the calendar", async () => {
    await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));
    await run(storage, () => executeTool("delete_reminder", { title: "Mow the lawn" }, USER));

    expect(await run(storage, () => storage.listReminders())).toHaveLength(0);
    expect(await calendarDates(storage, "Mow the lawn", "2026-08-01", "2027-12-31")).toEqual([]);
    // No all-skipped husk of an event left behind either.
    const events = await run(storage, () => storage.getEvents());
    expect(events.filter(e => e.title === "Mow the lawn")).toHaveLength(0);
  });

  it("never touches a real calendar event that happens to share the name", async () => {
    await run(storage, () => executeTool("create_reminder", { ...MOW }, USER));
    const own = await run(storage, () => storage.createEvent({
      title: "Mow the lawn", date: "2026-09-05", allDay: true, recurrence: "none",
      category: "personal", source: "manual", linkedProfiles: [], linkedDocuments: [], tags: [],
    } as any));

    await run(storage, () => executeTool("delete_reminder", { title: "Mow the lawn" }, USER));

    const events = await run(storage, () => storage.getEvents());
    expect(events.map(e => e.id)).toContain(own.id);
  });
});
