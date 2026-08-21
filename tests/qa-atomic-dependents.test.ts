// QA req 6 — a record and its dependents move together, or neither moves.
//
// The reported corruption: moving the dentist appointment from September 8 to
// September 10 moved its "two days before" reminder while the appointment
// update failed, leaving a reminder for an appointment two days after it.

import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { updateEventWithDependents } from "../server/update-with-dependents";
import { parseDependentOffsetMinutes } from "@shared/conversation-context";

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

let storage: MemStorage;
let seq = 0;
beforeEach(() => {
  storage = new MemStorage(`user-qa-atomic-${++seq}`);
});

async function dentistWithReminder() {
  const event = await run(storage, () => storage.createEvent({
    title: "Dentist appointment", date: "2026-09-08", time: "14:00", category: "health",
  } as any));
  const reminder = await run(storage, () => storage.createTask({
    title: "Dentist appointment reminder",
    dueDate: "2026-09-06",
    dueTime: "14:00",
    reminderForEventId: event.id,
    reminderOffsetMinutes: 2880, // two days
  } as any));
  return { event, reminder };
}

describe("parseDependentOffsetMinutes", () => {
  it("reads the offset the user stated", () => {
    expect(parseDependentOffsetMinutes("Remind me two days before")).toBe(2880);
    expect(parseDependentOffsetMinutes("remind me 3 days before")).toBe(4320);
    expect(parseDependentOffsetMinutes("remind me an hour before")).toBe(60);
    expect(parseDependentOffsetMinutes("remind me 30 minutes before")).toBe(30);
    expect(parseDependentOffsetMinutes("the day before")).toBe(1440);
  });

  it("returns null when no offset was stated", () => {
    expect(parseDependentOffsetMinutes("Remind me about the dentist")).toBeNull();
    expect(parseDependentOffsetMinutes("Sarah has a dentist appointment")).toBeNull();
  });
});

describe("moving the event moves its reminders", () => {
  it("September 8 → September 10 moves the reminder from the 6th to the 8th", async () => {
    const { event, reminder } = await dentistWithReminder();

    const res = await run(storage, () =>
      updateEventWithDependents(storage as any, event.id, { date: "2026-09-10" }));

    expect(res.ok).toBe(true);
    expect(res.event!.date).toBe("2026-09-10");
    expect(res.dependents).toHaveLength(1);

    const movedReminder = await run(storage, () => storage.getTask(reminder.id));
    expect(movedReminder!.dueDate).toBe("2026-09-08");
  });

  it("leaves unrelated tasks alone", async () => {
    const { event } = await dentistWithReminder();
    const unrelated = await run(storage, () => storage.createTask({
      title: "Buy groceries", dueDate: "2026-09-06",
    } as any));

    await run(storage, () => updateEventWithDependents(storage as any, event.id, { date: "2026-09-10" }));

    const fresh = await run(storage, () => storage.getTask(unrelated.id));
    expect(fresh!.dueDate).toBe("2026-09-06");
  });
});

describe("a failed primary commits NOTHING", () => {
  it("does not move the reminder when the event update does not persist", async () => {
    const { event, reminder } = await dentistWithReminder();

    // The reported failure mode: the event write does not land.
    const failing = {
      getTasks: () => run(storage, () => storage.getTasks()),
      updateTask: (id: string, d: any) => run(storage, () => storage.updateTask(id, d)),
      updateEvent: async () => undefined, // did not persist
    };

    const res = await updateEventWithDependents(failing as any, event.id, { date: "2026-09-10" });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/did not persist|nothing was changed/i);
    expect(res.dependents).toHaveLength(0);

    // THE assertion this module exists for.
    const untouched = await run(storage, () => storage.getTask(reminder.id));
    expect(untouched!.dueDate, "the reminder must not have moved").toBe("2026-09-06");
  });

  it("rejects an invalid date before writing anything", async () => {
    const { event, reminder } = await dentistWithReminder();

    const res = await run(storage, () =>
      updateEventWithDependents(storage as any, event.id, { date: "not-a-date" }));

    expect(res.ok).toBe(false);
    const freshEvent = await run(storage, () => storage.getEvent(event.id));
    expect(freshEvent!.date).toBe("2026-09-08");
    const freshReminder = await run(storage, () => storage.getTask(reminder.id));
    expect(freshReminder!.dueDate).toBe("2026-09-06");
  });

  it("rolls dependents back when one of them fails mid-way", async () => {
    const event = await run(storage, () => storage.createEvent({
      title: "Dentist appointment", date: "2026-09-08", time: "14:00", category: "health",
    } as any));
    const good = await run(storage, () => storage.createTask({
      title: "Reminder A", dueDate: "2026-09-06", dueTime: "14:00",
      reminderForEventId: event.id, reminderOffsetMinutes: 2880,
    } as any));
    const bad = await run(storage, () => storage.createTask({
      title: "Reminder B", dueDate: "2026-09-07", dueTime: "14:00",
      reminderForEventId: event.id, reminderOffsetMinutes: 1440,
    } as any));

    const partial = {
      getTasks: () => run(storage, () => storage.getTasks()),
      updateEvent: (id: string, d: any) => run(storage, () => storage.updateEvent(id, d)),
      updateTask: async (id: string, d: any) => {
        if (id === bad.id) return undefined; // this one does not persist
        return run(storage, () => storage.updateTask(id, d));
      },
    };

    const res = await updateEventWithDependents(partial as any, event.id, { date: "2026-09-10" });

    expect(res.ok).toBe(false);
    expect(res.rolledBack).toBe(true);
    // The one that DID move is put back, so the reminders stay consistent
    // with each other rather than half-moved.
    const freshGood = await run(storage, () => storage.getTask(good.id));
    expect(freshGood!.dueDate).toBe("2026-09-06");
  });
});
