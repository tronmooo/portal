// Habit ↔ tracker synchronisation, end to end against real storage.
//
// The QA report's reqs 9, 10 and 11:
//
//   9.  Pressing a habit in the Habits tab must create a tracker entry —
//       creating and linking the canonical tracker once if there isn't one,
//       and appending to it every day after, never creating a second.
//   10. Recording an activity must complete the habit that measures it:
//       a 2.4-mile walk closes "Walk 2 Miles — daily".
//   11. Amounts accumulate: 1.2 mi + 0.8 mi closes a 2-mile habit, and the
//       hydration behaviour that already worked must not regress.

import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { completeHabitOccurrence, autoCheckinLinkedHabits, HABIT_MIRROR_KEY } from "../server/habit-completion";
import { habitDayProgress } from "@shared/habit-progress";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import { readActivity } from "../client/src/lib/wellness-metrics";

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);
const TODAY = () => getUserToday(DEFAULT_TIMEZONE);

let storage: MemStorage;
let seq = 0;
beforeEach(() => {
  storage = new MemStorage(`user-qa-habit-${++seq}`);
});

const makeHabit = (name: string, extra: Record<string, any> = {}) =>
  run(storage, () => storage.createHabit({
    name, frequency: "daily", targetPerDay: 1, ...extra,
  } as any));

describe("QA req 9 — manual completion creates and reuses ONE tracker", () => {
  it("creates the canonical tracker on the first completion and logs into it", async () => {
    const habit = await makeHabit("Walk the Dog");
    expect((habit as any).linkedTrackerId ?? null).toBeNull();

    const res = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: habit.id, source: "habit_ui",
    }));

    expect(res.ok).toBe(true);
    expect(res.recorded).toBe(1);
    // A tracker now exists, is linked, and carries the entry.
    expect(res.tracker, "a tracker must have been resolved").toBeTruthy();
    expect(res.trackerEntries.length).toBe(1);

    const fresh = await run(storage, () => storage.getHabit(habit.id));
    expect((fresh as any).linkedTrackerId).toBe(res.tracker!.id);
  });

  it("APPENDS on later days instead of creating a new tracker each time", async () => {
    const habit = await makeHabit("Walk the Dog");
    const day1 = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: habit.id, source: "habit_ui", date: "2026-08-19",
    }));
    const day2 = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: habit.id, source: "habit_ui", date: "2026-08-20",
    }));
    const day3 = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: habit.id, source: "habit_ui", date: "2026-08-21",
    }));

    expect(day1.tracker!.id).toBe(day2.tracker!.id);
    expect(day2.tracker!.id).toBe(day3.tracker!.id);

    const trackers = await run(storage, () => storage.getTrackers());
    const walking = trackers.filter((t: any) => /walk/i.test(t.name));
    expect(walking.length, "exactly one walking tracker for three completions").toBe(1);
    expect(walking[0].entries.length).toBe(3);
  });

  it("does not manufacture a tracker for a completion-only habit", async () => {
    const habit = await makeHabit("Make my bed");
    const res = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: habit.id, source: "habit_ui",
    }));
    expect(res.ok).toBe(true);
    expect(res.recorded).toBe(1);
    expect(res.tracker ?? null).toBeNull();
    const trackers = await run(storage, () => storage.getTrackers());
    expect(trackers.length).toBe(0);
  });

  it("marks its tracker entry as the habit's mirror so aggregates can tell", async () => {
    const habit = await makeHabit("Walk the Dog");
    const res = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: habit.id, source: "habit_ui",
    }));
    expect((res.trackerEntries[0].values as any)[HABIT_MIRROR_KEY]).toBe(habit.id);
  });
});

describe("QA req 10 + 11 — tracker activity completes the matching habit", () => {
  it("a 2.4-mile walk completes 'Walk 2 Miles'", async () => {
    const habit = await makeHabit("Walk 2 Miles");
    const tracker = await run(storage, () => storage.createTracker({
      name: "Walking", category: "fitness",
      fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }],
    } as any));

    await run(storage, () => storage.logEntry({
      trackerId: tracker.id, values: { distance: 2.4 },
    } as any));

    const fresh = await run(storage, () => storage.getHabit(habit.id));
    expect(habitDayProgress(fresh as any, TODAY()).isComplete).toBe(true);
  });

  it("links the habit to the tracker on first match, so it is explicit after", async () => {
    const habit = await makeHabit("Walk 2 Miles");
    const tracker = await run(storage, () => storage.createTracker({
      name: "Walking", category: "fitness",
      fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }],
    } as any));
    await run(storage, () => storage.logEntry({
      trackerId: tracker.id, values: { distance: 2.4 },
    } as any));

    const fresh = await run(storage, () => storage.getHabit(habit.id));
    expect((fresh as any).linkedTrackerId).toBe(tracker.id);
  });

  it("1.2 then 0.8 completes it — and 1.2 alone does not", async () => {
    const habit = await makeHabit("Walk 2 Miles");
    const tracker = await run(storage, () => storage.createTracker({
      name: "Walking", category: "fitness",
      fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }],
    } as any));

    await run(storage, () => storage.logEntry({
      trackerId: tracker.id, values: { distance: 1.2 },
    } as any));
    let fresh = await run(storage, () => storage.getHabit(habit.id));
    expect(habitDayProgress(fresh as any, TODAY()).isComplete, "1.2 of 2 miles is not done").toBe(false);

    await run(storage, () => storage.logEntry({
      trackerId: tracker.id, values: { distance: 0.8 },
    } as any));
    fresh = await run(storage, () => storage.getHabit(habit.id));
    expect(habitDayProgress(fresh as any, TODAY()).isComplete, "1.2 + 0.8 = 2 is done").toBe(true);
  });

  it("does not complete a quantitative habit from an unrelated small log", async () => {
    const habit = await makeHabit("Walk 2 Miles");
    const tracker = await run(storage, () => storage.createTracker({
      name: "Walking", category: "fitness",
      fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }],
    } as any));
    await run(storage, () => storage.logEntry({
      trackerId: tracker.id, values: { distance: 0.3 },
    } as any));
    const fresh = await run(storage, () => storage.getHabit(habit.id));
    expect(habitDayProgress(fresh as any, TODAY()).isComplete).toBe(false);
  });

  it("keeps a dog walk from closing the user's own walking habit", async () => {
    // The specificity guard: "Walk the Dog" is a particular walk and must not
    // be finished by a generic Walking log.
    const dog = await makeHabit("Walk the Dog");
    const tracker = await run(storage, () => storage.createTracker({
      name: "Walking", category: "fitness",
      fields: [{ name: "distance", type: "number", unit: "mi", isPrimary: true }],
    } as any));
    await run(storage, () => storage.logEntry({
      trackerId: tracker.id, values: { distance: 3 },
    } as any));
    const fresh = await run(storage, () => storage.getHabit(dog.id));
    expect(habitDayProgress(fresh as any, TODAY()).isComplete).toBe(false);
  });
});

describe("QA req 16 — hydration keeps working", () => {
  it("32 oz then 16 oz totals 48 on the tracker", async () => {
    const tracker = await run(storage, () => storage.createTracker({
      name: "Hydration", category: "health",
      fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
    } as any));
    await run(storage, () => storage.logEntry({ trackerId: tracker.id, values: { ounces: 32 } } as any));
    await run(storage, () => storage.logEntry({ trackerId: tracker.id, values: { ounces: 16 } } as any));

    const fresh = await run(storage, () => storage.getTracker(tracker.id));
    const total = (fresh!.entries || []).reduce(
      (sum: number, e: any) => sum + Number(e.values?.ounces || 0), 0,
    );
    expect(total).toBe(48);
    expect(fresh!.entries.length, "two entries, appended — not overwritten").toBe(2);
  });

  it("64 oz of water closes a 'Drink 64 oz' habit, additively", async () => {
    const habit = await makeHabit("Drink 64 oz of water");
    const tracker = await run(storage, () => storage.createTracker({
      name: "Hydration", category: "health",
      fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
    } as any));

    for (const oz of [32, 16]) {
      await run(storage, () => storage.logEntry({ trackerId: tracker.id, values: { ounces: oz } } as any));
    }
    let fresh = await run(storage, () => storage.getHabit(habit.id));
    expect(habitDayProgress(fresh as any, TODAY()).isComplete, "48 of 64 is not done").toBe(false);

    await run(storage, () => storage.logEntry({ trackerId: tracker.id, values: { ounces: 16 } } as any));
    fresh = await run(storage, () => storage.getHabit(habit.id));
    expect(habitDayProgress(fresh as any, TODAY()).isComplete, "32+16+16 = 64 is done").toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA req 12 — one real activity is counted once
// ─────────────────────────────────────────────────────────────────────────────


describe("QA req 12 — a 48-minute walk is 48 exercise minutes, not 96", () => {
  const now = new Date("2026-08-21T15:00:00Z");
  const walkTracker = (entries: any[]) => ([{
    id: "t1",
    name: "Walking",
    category: "fitness",
    unit: "",
    fields: [{ name: "duration", type: "number", unit: "min", isPrimary: true }],
    entries,
  }] as any);

  it("does not add computed.durationMinutes on top of the stated duration", () => {
    // The reported shape: one entry carrying the same measurement twice.
    const activity = readActivity(walkTracker([
      {
        timestamp: "2026-08-21T09:00:00Z",
        values: { duration: 48 },
        computed: { durationMinutes: 48 },
      },
    ]), { now });
    expect(activity.minutes).toBe(48);
  });

  it("still uses computed values when the entry states none", () => {
    const activity = readActivity(walkTracker([
      { timestamp: "2026-08-21T09:00:00Z", values: {}, computed: { durationMinutes: 30 } },
    ]), { now });
    expect(activity.minutes).toBe(30);
  });

  it("does not double-count calories either", () => {
    const activity = readActivity(walkTracker([
      {
        timestamp: "2026-08-21T09:00:00Z",
        values: { calories: 200 },
        computed: { caloriesBurned: 200 },
      },
    ]), { now });
    expect(activity.caloriesBurned).toBe(200);
  });

  it("still sums two genuinely different walks", () => {
    const activity = readActivity(walkTracker([
      { timestamp: "2026-08-21T09:00:00Z", values: { duration: 48 } },
      { timestamp: "2026-08-21T18:00:00Z", values: { duration: 12 } },
    ]), { now });
    expect(activity.minutes).toBe(60);
  });
});
