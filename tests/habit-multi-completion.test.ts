// Habits with multiple completions per day, end to end through the storage
// layer and the shared progress/stat/streak math.
//
// The behavior being pinned, in one sentence: a completion is an OCCURRENCE
// (its own row, its own timestamp), a day is "done" only when the DAILY TARGET
// is reached, and going past the target is recorded rather than refused.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";
import {
  habitDayProgress,
  habitCompletionsOn,
  habitDailyTarget,
  isHabitDoneOn,
} from "@shared/habit-schedule";
import { computeHabitStats } from "@shared/habit-stats";
import { calculateStreak } from "@shared/streak";
import { completionTimestamps } from "../server/habit-completions";
import { getUserToday, addDays } from "@shared/timezone";

const TODAY = getUserToday();
const YESTERDAY = addDays(TODAY, -1);

let store: MemStorage;
beforeEach(() => { store = new MemStorage(); });

async function makeHabit(name: string, targetPerDay = 1) {
  return store.createHabit({ name, frequency: "daily", targetPerDay } as any);
}

describe("daily target", () => {
  it("defaults existing/plain habits to 1 — backward compatibility", async () => {
    const h = await store.createHabit({ name: "Workout", frequency: "daily" } as any);
    expect(h.targetPerDay).toBe(1);
    expect(habitDailyTarget({ targetPerDay: undefined })).toBe(1);
    expect(habitDailyTarget({ targetPerDay: null })).toBe(1);
  });

  it("stores 1x, 2x, 5x and 8x targets", async () => {
    for (const n of [1, 2, 5, 8]) {
      const h = await makeHabit(`Habit ${n}`, n);
      expect(h.targetPerDay).toBe(n);
    }
  });
});

describe("recording completions", () => {
  it("marks once", async () => {
    const h = await makeHabit("Read", 1);
    await store.checkinHabit(h.id, { date: TODAY });
    const after = (await store.getHabit(h.id))!;
    expect(habitDayProgress(after, TODAY)).toMatchObject({ count: 1, target: 1, done: true, state: "complete" });
  });

  it("marks twice in ONE call and stores two separate occurrences", async () => {
    const h = await makeHabit("Medication", 2);
    await store.checkinHabit(h.id, { date: TODAY, count: 2, source: "ai_chat" });
    const after = (await store.getHabit(h.id))!;
    const occurrences = habitCompletionsOn(after, TODAY);
    expect(occurrences).toHaveLength(2);
    // Two DISTINCT rows, not one row overwritten — distinct ids and timestamps.
    expect(new Set(occurrences.map(c => c.id)).size).toBe(2);
    expect(new Set(occurrences.map(c => c.timestamp)).size).toBe(2);
    expect(occurrences.every(c => c.source === "ai_chat")).toBe(true);
  });

  it("marks another time on top of what's already there", async () => {
    const h = await makeHabit("Walk Dog", 3);
    await store.checkinHabit(h.id, { date: TODAY, count: 2 });
    await store.checkinHabit(h.id, { date: TODAY, count: 1 });
    const after = (await store.getHabit(h.id))!;
    expect(habitDayProgress(after, TODAY)).toMatchObject({ count: 3, target: 3, done: true, exceeded: false });
  });

  it("EXCEEDS the target instead of refusing — 4 walks on a target of 3 is 4/3", async () => {
    const h = await makeHabit("Walk Dog", 3);
    await store.checkinHabit(h.id, { date: TODAY, count: 4 });
    const after = (await store.getHabit(h.id))!;
    const p = habitDayProgress(after, TODAY);
    expect(p.count).toBe(4);
    expect(p.target).toBe(3);
    expect(p.exceeded).toBe(true);
    expect(p.state).toBe("exceeded");
    expect(habitCompletionsOn(after, TODAY)).toHaveLength(4);
  });

  it("progress states walk not_started → in_progress → complete → exceeded", async () => {
    const h = await makeHabit("Stretch", 3);
    expect(habitDayProgress((await store.getHabit(h.id))!, TODAY).state).toBe("not_started");
    await store.checkinHabit(h.id, { date: TODAY });
    expect(habitDayProgress((await store.getHabit(h.id))!, TODAY).state).toBe("in_progress");
    await store.checkinHabit(h.id, { date: TODAY, count: 2 });
    expect(habitDayProgress((await store.getHabit(h.id))!, TODAY).state).toBe("complete");
    await store.checkinHabit(h.id, { date: TODAY });
    expect(habitDayProgress((await store.getHabit(h.id))!, TODAY).state).toBe("exceeded");
  });

  it("records a completion at a stated time instead of 'now'", async () => {
    // "I brushed my teeth this morning and again tonight" — two occurrences
    // stamped 08:00 and 20:00, not two stamped with the time the user typed.
    const h = await makeHabit("Brush Teeth", 2);
    await store.checkinHabit(h.id, { date: "2026-08-09", at: "08:00", timezone: "UTC" });
    await store.checkinHabit(h.id, { date: "2026-08-09", at: "20:00", timezone: "UTC" });
    const after = (await store.getHabit(h.id))!;
    const stamps = habitCompletionsOn(after, "2026-08-09").map(c => c.timestamp);
    expect(stamps).toEqual([
      "2026-08-09T08:00:00.000Z",
      "2026-08-09T20:00:00.000Z",
    ]);
  });
});

describe("removing completions", () => {
  it("undoes ONE completion, keeping the earlier ones", async () => {
    const h = await makeHabit("Water", 8);
    await store.checkinHabit(h.id, { date: TODAY, count: 3 });
    const before = habitCompletionsOn((await store.getHabit(h.id))!, TODAY);
    await store.undoLastHabitCheckin(h.id, TODAY);
    const after = habitCompletionsOn((await store.getHabit(h.id))!, TODAY);
    expect(after).toHaveLength(2);
    // The NEWEST went; the first two survived with their identities intact.
    expect(after.map(c => c.id)).toEqual(before.slice(0, 2).map(c => c.id));
  });

  it("resets today's completions and leaves previous days untouched", async () => {
    const h = await makeHabit("Water", 8);
    await store.checkinHabit(h.id, { date: YESTERDAY, count: 5 });
    await store.checkinHabit(h.id, { date: TODAY, count: 3 });
    const removed = await store.resetHabitDay(h.id, TODAY);
    expect(removed).toBe(3);
    const after = (await store.getHabit(h.id))!;
    expect(habitDayProgress(after, TODAY).count).toBe(0);
    expect(habitDayProgress(after, YESTERDAY).count).toBe(5);
  });

  it("deleteHabitCheckin actually deletes (it used to be a hard-coded false)", async () => {
    const h = await makeHabit("Read", 1);
    await store.checkinHabit(h.id, { date: TODAY });
    const [c] = habitCompletionsOn((await store.getHabit(h.id))!, TODAY);
    expect(await store.deleteHabitCheckin(h.id, c.id)).toBe(true);
    expect(habitDayProgress((await store.getHabit(h.id))!, TODAY).count).toBe(0);
    expect(await store.deleteHabitCheckin(h.id, "nope")).toBe(false);
  });
});

describe("setHabitDayCount — 'I've only walked the dog twice today'", () => {
  it("trims down to the stated total, newest first", async () => {
    const h = await makeHabit("Walk Dog", 3);
    await store.checkinHabit(h.id, { date: TODAY, at: "08:00" });
    await store.checkinHabit(h.id, { date: TODAY, count: 3 });
    const before = habitCompletionsOn((await store.getHabit(h.id))!, TODAY);
    expect(before).toHaveLength(4);

    await store.setHabitDayCount(h.id, TODAY, 2);
    const after = habitCompletionsOn((await store.getHabit(h.id))!, TODAY);
    expect(after).toHaveLength(2);
    // The explicitly-timed 08:00 completion survives; the newest were dropped.
    expect(after[0].id).toBe(before[0].id);
  });

  it("tops up when the stated total is higher than what's recorded", async () => {
    const h = await makeHabit("Water", 8);
    await store.checkinHabit(h.id, { date: TODAY, count: 2 });
    await store.setHabitDayCount(h.id, TODAY, 6);
    expect(habitDayProgress((await store.getHabit(h.id))!, TODAY).count).toBe(6);
  });

  it("clears the day when the total is 0", async () => {
    const h = await makeHabit("Water", 8);
    await store.checkinHabit(h.id, { date: TODAY, count: 4 });
    await store.setHabitDayCount(h.id, TODAY, 0);
    expect(habitDayProgress((await store.getHabit(h.id))!, TODAY).count).toBe(0);
  });
});

describe("changing the target", () => {
  it("keeps completions already recorded when the target is lowered", async () => {
    const h = await makeHabit("Walk Dog", 3);
    await store.checkinHabit(h.id, { date: TODAY, count: 3 });
    await store.updateHabit(h.id, { targetPerDay: 2 });
    const after = (await store.getHabit(h.id))!;
    const p = habitDayProgress(after, TODAY);
    expect(p.count).toBe(3);
    expect(p.target).toBe(2);
    expect(p.exceeded).toBe(true);
  });

  it("re-opens the day when the target is raised", async () => {
    const h = await makeHabit("Water", 2);
    await store.checkinHabit(h.id, { date: TODAY, count: 2 });
    expect(isHabitDoneOn((await store.getHabit(h.id))!, TODAY)).toBe(true);
    await store.updateHabit(h.id, { targetPerDay: 8 });
    expect(isHabitDoneOn((await store.getHabit(h.id))!, TODAY)).toBe(false);
  });
});

describe("streaks count only days that REACHED the target", () => {
  it("2 of 3 does not make a streak day, but the data is kept", () => {
    const dates = [
      addDays(TODAY, -2), addDays(TODAY, -2), addDays(TODAY, -2), // 3/3 ✓
      addDays(TODAY, -1), addDays(TODAY, -1),                     // 2/3 ✗
      TODAY, TODAY, TODAY,                                        // 3/3 ✓
    ];
    const { current } = calculateStreak(dates, { today: TODAY, targetPerDay: 3 });
    expect(current).toBe(1); // today only — yesterday broke it at 2/3

    // Same data, target 1: every day counts.
    expect(calculateStreak(dates, { today: TODAY, targetPerDay: 1 }).current).toBe(3);
  });
});

describe("statistics", () => {
  it("reports averages, goal rate, days reached and days exceeded", async () => {
    const h = await makeHabit("Walk Dog", 3);
    await store.checkinHabit(h.id, { date: addDays(TODAY, -2), count: 4 }); // exceeded
    await store.checkinHabit(h.id, { date: addDays(TODAY, -1), count: 2 }); // partial
    await store.checkinHabit(h.id, { date: TODAY, count: 3 });              // reached

    const stats = computeHabitStats((await store.getHabit(h.id))!, { today: TODAY, days: 3 });
    expect(stats.target).toBe(3);
    expect(stats.daysConsidered).toBe(3);
    expect(stats.totalCompletions).toBe(9);
    expect(stats.averagePerDay).toBe(3);
    expect(stats.daysGoalReached).toBe(2);
    expect(stats.daysGoalExceeded).toBe(1);
    expect(stats.daysPartial).toBe(1);      // partial data retained, as required
    expect(stats.goalCompletionRate).toBe(67);
    expect(stats.completionsThisWeek).toBe(9);
    expect(stats.completionTimes).toHaveLength(9);
    expect(stats.byDate.map(d => d.count)).toEqual([4, 2, 3]);
  });

  it("handles a habit with no completions without dividing by zero", async () => {
    const h = await makeHabit("Floss", 2);
    const stats = computeHabitStats((await store.getHabit(h.id))!, { today: TODAY, days: 7 });
    expect(stats.totalCompletions).toBe(0);
    expect(stats.averagePerDay).toBe(0);
    expect(stats.goalCompletionRate).toBe(0);
    expect(stats.currentStreak).toBe(0);
  });
});

describe("completionTimestamps", () => {
  it("gives every occurrence in one call a distinct, increasing timestamp", () => {
    const ts = completionTimestamps({ date: TODAY, count: 3, now: new Date("2026-08-09T12:00:00Z") });
    expect(ts).toHaveLength(3);
    expect(new Set(ts).size).toBe(3);
    expect([...ts].sort()).toEqual(ts);
  });

  it("anchors on a stated clock time in the user's zone", () => {
    const [first] = completionTimestamps({ date: "2026-08-09", count: 1, at: "08:00", timezone: "UTC" });
    expect(new Date(first).toISOString()).toBe("2026-08-09T08:00:00.000Z");
  });
});
