// uncompleteHabitOccurrence — the inverse of the habit completion pipeline.
//
// Before it existed, every un-check path called storage.deleteHabitCheckin
// directly: the mirrored tracker entry survived (medication adherence kept
// counting the un-taken dose, and countMirrorEntries then suppressed the
// mirror on a later re-check-in), and one backend clobbered the all-time
// longest streak. These tests pin the round-trip.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  completeHabitOccurrence,
  uncompleteHabitOccurrence,
  HABIT_MIRROR_KEY,
} from "../server/habit-completion";
import { removeTrackerEntry } from "../server/tracker-entries";

const TODAY = new Date().toISOString().slice(0, 10);

/** Fake satisfying HabitCompletionStorage + what removeTrackerEntry needs. */
function fakeStorage(habitSeed: Partial<any> = {}) {
  let checkinSeq = 0;
  let entrySeq = 0;
  const habit: any = {
    id: "habit-1", name: "Vitamins", targetPerDay: 1, currentStreak: 3,
    longestStreak: 30, checkins: [], linkedTrackerId: "tracker-1",
    linkedProfiles: ["self-1"],
    ...habitSeed,
  };
  const tracker: any = { id: "tracker-1", name: "Vitamins", category: "health", fields: [{ name: "completions", type: "number" }], entries: [], linkedProfiles: ["self-1"] };
  const storage: any = {
    habit, tracker,
    getHabit: async (id: string) => (id === habit.id ? { ...habit, checkins: [...habit.checkins] } : undefined),
    getHabits: async () => [habit],
    checkinHabit: async (habitId: string, date?: string) => {
      if (habitId !== habit.id) return undefined;
      const c = { id: `chk-${++checkinSeq}`, date: date || TODAY, timestamp: new Date(Date.now() + checkinSeq).toISOString() };
      habit.checkins.push(c);
      habit.currentStreak += 1;
      habit.longestStreak = Math.max(habit.longestStreak, habit.currentStreak);
      return c;
    },
    deleteHabitCheckin: async (habitId: string, checkinId: string) => {
      if (habitId !== habit.id) return false;
      const before = habit.checkins.length;
      habit.checkins = habit.checkins.filter((c: any) => c.id !== checkinId);
      if (habit.checkins.length < before) { habit.currentStreak = Math.max(0, habit.currentStreak - 1); return true; }
      return false;
    },
    updateHabit: async (_id: string, patch: any) => Object.assign(habit, patch),
    getTracker: async (id: string) => (id === tracker.id ? { ...tracker, entries: [...tracker.entries] } : undefined),
    getTrackers: async () => [tracker],
    createTracker: async (data: any) => ({ id: "tracker-x", entries: [], ...data }),
    updateTracker: async (_id: string, patch: any) => Object.assign(tracker, patch),
    logEntry: async (data: any) => {
      const e = { id: `ent-${++entrySeq}`, values: data.values, notes: data.notes, timestamp: data.timestamp || new Date().toISOString() };
      tracker.entries.push(e);
      return e;
    },
    getTrackerEntry: async (id: string) => tracker.entries.find((e: any) => e.id === id),
    deleteTrackerEntry: async (trackerId: string, entryId: string) => {
      if (trackerId !== tracker.id) return false;
      const before = tracker.entries.length;
      tracker.entries = tracker.entries.filter((e: any) => e.id !== entryId);
      return tracker.entries.length < before;
    },
    getProfiles: async () => [{ id: "self-1", type: "self" }],
  };
  return storage;
}

describe("uncompleteHabitOccurrence — complete → uncomplete round-trip", () => {
  it("removes the check-in AND its mirrored tracker entry", async () => {
    const storage = fakeStorage();
    const done = await completeHabitOccurrence(storage, { habitId: "habit-1", source: "habit_ui" });
    expect(done.ok).toBe(true);
    expect(storage.habit.checkins).toHaveLength(1);
    expect(storage.tracker.entries).toHaveLength(1);
    expect(storage.tracker.entries[0].values[HABIT_MIRROR_KEY]).toBe("habit-1");

    const undone = await uncompleteHabitOccurrence(storage, { habitId: "habit-1", source: "habit_ui" });
    expect(undone.ok).toBe(true);
    expect(undone.removedCheckinId).toBeTruthy();
    expect(undone.removedTrackerEntryIds).toHaveLength(1);
    expect(storage.habit.checkins).toHaveLength(0);
    // The mirror is gone too — adherence stops counting the un-taken dose.
    expect(storage.tracker.entries).toHaveLength(0);
    expect(undone.progress.completed).toBe(0);
  });

  it("targets a specific check-in by id and by position", async () => {
    const storage = fakeStorage({ targetPerDay: 3 });
    await completeHabitOccurrence(storage, { habitId: "habit-1", source: "habit_ui", count: 3 });
    expect(storage.habit.checkins).toHaveLength(3);
    const first = storage.habit.checkins[0];

    const byPosition = await uncompleteHabitOccurrence(storage, { habitId: "habit-1", source: "chat_explicit", position: 1 });
    expect(byPosition.ok).toBe(true);
    expect(byPosition.removedCheckinId).toBe(first.id);
    // The other completions are untouched.
    expect(storage.habit.checkins).toHaveLength(2);
    expect(byPosition.progress.completed).toBe(2);

    const second = storage.habit.checkins[0];
    const byId = await uncompleteHabitOccurrence(storage, { habitId: "habit-1", source: "habit_ui", checkinId: second.id });
    expect(byId.ok).toBe(true);
    expect(byId.removedCheckinId).toBe(second.id);
  });

  it("refuses honestly when there is nothing to remove", async () => {
    const storage = fakeStorage();
    const undone = await uncompleteHabitOccurrence(storage, { habitId: "habit-1", source: "habit_ui" });
    expect(undone.ok).toBe(false);
    expect(undone.reason).toBe("no_checkin");

    const missing = await uncompleteHabitOccurrence(storage, { habitId: "nope", source: "habit_ui" });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("not_found");
  });

  it("deleting the tracker entry retracts the paired check-in (the other direction)", async () => {
    const storage = fakeStorage();
    await completeHabitOccurrence(storage, { habitId: "habit-1", source: "habit_ui" });
    const mirror = storage.tracker.entries[0];

    const removed = await removeTrackerEntry(storage, { trackerId: "tracker-1", entryId: mirror.id });
    expect(removed.ok).toBe(true);
    expect(removed.habitId).toBe("habit-1");
    expect(removed.removedHabitCheckinId).toBeTruthy();
    expect(storage.habit.checkins).toHaveLength(0);
    expect(storage.tracker.entries).toHaveLength(0);
  });

  it("a two-dose day loses exactly one record per removal", async () => {
    const storage = fakeStorage({ targetPerDay: 2 });
    await completeHabitOccurrence(storage, { habitId: "habit-1", source: "habit_ui", count: 2 });
    expect(storage.habit.checkins).toHaveLength(2);
    expect(storage.tracker.entries).toHaveLength(2);

    const removed = await removeTrackerEntry(storage, { trackerId: "tracker-1", entryId: storage.tracker.entries[1].id });
    expect(removed.ok).toBe(true);
    // One entry + one check-in gone; the other pair intact (the mirror sweep
    // is suppressed on this path so it cannot take a second entry).
    expect(storage.tracker.entries).toHaveLength(1);
    expect(storage.habit.checkins).toHaveLength(1);
  });

  it("SupabaseStorage.deleteHabitCheckin preserves the all-time longest streak (source guard)", () => {
    // The un-Math.max'd write is what let un-checking today destroy a year-old
    // record. Not runnable without a database, so pin the source.
    const src = readFileSync(resolve(__dirname, "../server/supabase-storage.ts"), "utf8");
    const fn = src.slice(src.indexOf("async deleteHabitCheckin"));
    const body = fn.slice(0, fn.indexOf("async updateHabit"));
    expect(body).toMatch(/longest_streak:\s*Math\.max\(/);
  });

  it("the AI un-check path has no all-profiles fallback (source guard)", () => {
    // checkin_habit removed the cross-profile fallback deliberately (the
    // Rex-hijack fix); undo must obey the same scope.
    const src = readFileSync(resolve(__dirname, "../server/ai-engine.ts"), "utf8");
    const tool = src.slice(src.indexOf('case "uncomplete_habit"'));
    const body = tool.slice(0, tool.indexOf('case "complete_event"'));
    expect(body).toContain("uncompleteHabitOccurrence");
    expect(body).not.toMatch(/\?\?\s*matchHabitByName\(habits/);
    expect(body).not.toContain("storage.deleteHabitCheckin");
  });
});
