// tests/habit-tracker-link.test.ts
//
// The habit ↔ tracker separation (user directive 2026-08-20):
//
//   · Habits stay in Habits: their schedules are internal recurrence logic and
//     must NEVER become calendar events, tasks, or recurring calendar rules.
//   · A MEASURABLE habit links to the tracker that measures it — reusing a
//     compatible existing tracker (never duplicating; an Exercise tracker
//     absorbs a running habit) and creating one only when none exists.
//   · A completion-only habit ("make my bed") gets NO tracker.
//   · Logging a tracker entry advances the linked habit's day progress — one
//     activity record updates both.
//   · Tracking something never makes it a habit.
import { describe, it, expect, beforeEach } from "vitest";
import { detectHabitMetric, habitMetricNoun } from "@shared/habit-metric";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);
let seq = 0;
const nextUser = () => `user-habit-link-${++seq}`;

// ─────────────────────────────────────────────────────────────────────────────
// Pure detection: measurable vs completion-only
// ─────────────────────────────────────────────────────────────────────────────

describe("detectHabitMetric — what measures something, and what doesn't", () => {
  it("water habits measure hydration", () => {
    const m = detectHabitMetric("Drink Water", "create a daily habit to drink 64 oz of water");
    expect(m).not.toBeNull();
    expect(m!.candidates).toContain("Hydration");
    expect(m!.candidates).toContain("Water");
  });

  it("running habits measure running", () => {
    const m = detectHabitMetric("Run 3 Miles", "add a habit to run 3 miles 3 times a week");
    expect(m).not.toBeNull();
    expect(m!.candidates[0]).toBe("Running");
    expect(m!.category).toBe("fitness");
  });

  it("an explicit quantity makes an unknown activity measurable", () => {
    const m = detectHabitMetric("Juggle 10 minutes", "make a habit to juggle 10 minutes daily");
    expect(m).not.toBeNull();
    expect(m!.source).toBe("quantity");
  });

  it("a known medication is measurable without a stated quantity", () => {
    const m = detectHabitMetric("Take Lisinopril", "add a habit to take lisinopril every morning");
    expect(m).not.toBeNull();
    expect(m!.category).toBe("medication");
  });

  it("'make my bed' measures nothing — habit only", () => {
    expect(detectHabitMetric("Make My Bed", "create a habit to make my bed every morning")).toBeNull();
  });

  it("'call mom' measures nothing", () => {
    expect(detectHabitMetric("Call Mom", "make calling mom a weekly habit")).toBeNull();
  });

  it("'floss' measures nothing", () => {
    expect(detectHabitMetric("Floss", "add a floss every night habit")).toBeNull();
  });

  it("strips verbs, quantities and frequency words from the tracker noun", () => {
    expect(habitMetricNoun("Drink 64 oz of Water Daily")).toBe("Water");
    expect(habitMetricNoun("Practice Guitar 30 minutes every day")).toBe("Guitar");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real executor: create_habit links (or refuses to link) a tracker
// ─────────────────────────────────────────────────────────────────────────────

describe("create_habit — measurable habits link a tracker, completion-only habits don't", () => {
  let storage: MemStorage;
  let USER: string;

  beforeEach(() => {
    storage = new MemStorage();
    USER = nextUser();
  });

  const createHabit = (input: Record<string, any>, msg: string) =>
    run(storage, () => executeTool("create_habit", { ...input, __userMessage: msg }, USER)) as Promise<any>;

  it("water habit → water tracker created and linked; NO calendar entry", async () => {
    const habit = await createHabit(
      { name: "Drink Water", dailyTarget: 4 },
      "create a habit to drink 64 oz of water daily",
    );
    expect(habit.error).toBeUndefined();
    expect(habit.linkedTrackerId).toBeTruthy();
    expect(habit.__linkedTracker?.created).toBe(true);

    const trackers = await run(storage, () => storage.getTrackers());
    expect(trackers).toHaveLength(1);
    expect(trackers[0].id).toBe(habit.linkedTrackerId);
    expect(["Hydration", "Water"]).toContain(trackers[0].name);

    // The whole point: NOTHING landed on the calendar. No events, no tasks,
    // no recurring rules — the habit's "daily" stays inside the habit system.
    expect(await run(storage, () => storage.getEvents())).toHaveLength(0);
    expect(await run(storage, () => storage.getTasks())).toHaveLength(0);
  });

  it("reuses an existing compatible tracker instead of duplicating", async () => {
    const existing = await run(storage, () => storage.createTracker({
      name: "Hydration", category: "health",
      fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
    } as any));

    const habit = await createHabit(
      { name: "Drink More Water" },
      "make drinking water a daily habit",
    );
    expect(habit.linkedTrackerId).toBe(existing.id);
    expect(habit.__linkedTracker?.created).toBe(false);
    expect(await run(storage, () => storage.getTrackers())).toHaveLength(1);
  });

  it("expands an existing Exercise umbrella tracker rather than spawning Running", async () => {
    const exercise = await run(storage, () => storage.createTracker({
      name: "Exercise", category: "fitness",
      fields: [{ name: "activityType", type: "text", isPrimary: true }, { name: "duration", type: "number", unit: "min" }],
    } as any));

    const habit = await createHabit(
      { name: "Run 3 Miles" },
      "add a habit to run 3 miles 3 times every week",
    );
    expect(habit.linkedTrackerId).toBe(exercise.id);
    expect(await run(storage, () => storage.getTrackers())).toHaveLength(1);
  });

  it("completion-only habit gets NO tracker", async () => {
    const habit = await createHabit(
      { name: "Make My Bed" },
      "create a habit to make my bed every morning",
    );
    expect(habit.error).toBeUndefined();
    expect(habit.linkedTrackerId).toBeFalsy();
    expect(habit.__linkedTracker).toBeUndefined();
    expect(await run(storage, () => storage.getTrackers())).toHaveLength(0);
  });

  it("the model can veto linking with linkTracker:'none'", async () => {
    const habit = await createHabit(
      { name: "Drink Water", linkTracker: "none" },
      "make drinking water a daily habit",
    );
    expect(habit.linkedTrackerId).toBeFalsy();
    expect(await run(storage, () => storage.getTrackers())).toHaveLength(0);
  });

  it("the model's linkTracker hint reconnects to the existing tracker by identity", async () => {
    const existing = await run(storage, () => storage.createTracker({
      name: "Daily Hydration", category: "health",
      fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
    } as any));
    const habit = await createHabit(
      { name: "Water Intake", linkTracker: "Hydration" },
      "turn my water intake into a habit, every day",
    );
    expect(habit.linkedTrackerId).toBe(existing.id);
    expect(await run(storage, () => storage.getTrackers())).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One activity record updates both: tracker entry → habit progress
// ─────────────────────────────────────────────────────────────────────────────

describe("logging to a linked tracker advances the habit's day progress", () => {
  let storage: MemStorage;
  let USER: string;
  const today = getUserToday(DEFAULT_TIMEZONE);

  beforeEach(() => {
    storage = new MemStorage();
    USER = nextUser();
  });

  const setupLinkedWaterHabit = async (targetPerDay = 2) => {
    const habit = await run(storage, () => executeTool("create_habit", {
      name: "Drink Water", dailyTarget: targetPerDay,
      __userMessage: "create a habit to drink water twice daily",
    }, USER)) as any;
    expect(habit.linkedTrackerId).toBeTruthy();
    return habit;
  };

  const logWater = (oz: number) =>
    run(storage, () => executeTool("log_tracker_entry", {
      trackerName: "Hydration", values: { ounces: oz },
      __userMessage: `I drank ${oz} oz of water`,
    }, USER)) as Promise<any>;

  it("a tracker log records ONE habit completion for today", async () => {
    const habit = await setupLinkedWaterHabit(2);
    const entry = await logWater(32);
    expect(entry.error).toBeUndefined();

    const stored = await run(storage, () => storage.getHabit(habit.id));
    const todays = (stored?.checkins || []).filter((c) => c.date === today);
    expect(todays).toHaveLength(1);
    // The tool result tells the model to SAY the habit moved.
    expect(String(entry.habitProgressNote || "")).toContain("Drink Water");
  });

  it("progress caps at the day's target — extra logs never overfill", async () => {
    const habit = await setupLinkedWaterHabit(2);
    await logWater(16);
    await logWater(20);
    await logWater(24); // third log of a 2×/day habit
    const stored = await run(storage, () => storage.getHabit(habit.id));
    const todays = (stored?.checkins || []).filter((c) => c.date === today);
    expect(todays).toHaveLength(2);
  });

  it("an unlinked tracker moves no habit, and creates none", async () => {
    await setupLinkedWaterHabit(1);
    const entry = await run(storage, () => executeTool("log_tracker_entry", {
      trackerName: "Weight", values: { weight: 180 },
      __userMessage: "weight 180 lbs this morning",
    }, USER)) as any;
    expect(entry.error).toBeUndefined();
    const habits = await run(storage, () => storage.getHabits());
    expect(habits).toHaveLength(1); // still just the water habit
    expect(habits[0].checkins).toHaveLength(0);
    expect(entry.habitProgressNote).toBeUndefined();
  });

  it("tracking something is never a habit: logs alone create no habit rows", async () => {
    await run(storage, () => executeTool("log_tracker_entry", {
      trackerName: "Mood", values: { mood: "good" },
      __userMessage: "feeling pretty good today",
    }, USER));
    expect(await run(storage, () => storage.getHabits())).toHaveLength(0);
  });
});
