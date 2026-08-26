// tests/habit-completion-pipeline.test.ts
//
// The exact scenario from the 2026-08-20 report, end to end.
//
// What happened: with a "Walk the Dog" habit (2× daily) already on the
// dashboard, the user said "I just walked the dog" in chat. The reply logged a
// tracker entry and then told them to say "mark off my Walk the Dog habit" to
// count it — and the dashboard stayed at 0 of 2. Two defects in one screenshot:
// a completion the app refused to infer, and habit state that lived in more
// than one place.
//
// The rules pinned here:
//   · a past-tense report of doing an EXISTING habit completes today's
//     occurrence, with no permission asked;
//   · a plan / question / negation / someone else's action never does;
//   · chat, the Habits page and the tracker all write ONE occurrence through
//     ONE pipeline (server/habit-completion.ts), so repeating a completion
//     never stacks and the count is the same whoever asks;
//   · completing a habit writes its linked tracker record, and logging that
//     tracker completes the habit — in both directions, exactly once.
import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyCompletionReport,
  matchHabitForCompletionReport,
  hasThirdPersonSubject,
  isHardCompletionVeto,
} from "@shared/habit-completion-intent";
import { habitDayProgress } from "@shared/habit-progress";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import { MemStorage, requestStorageContext } from "../server/storage";
import { completeHabitOccurrence } from "../server/habit-completion";
import { executeTool } from "../server/ai-engine";

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);
let seq = 0;
const nextUser = () => `user-habit-pipeline-${++seq}`;
const TODAY = () => getUserToday(DEFAULT_TIMEZONE);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Reading the sentence
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyCompletionReport — what counts as 'I did it'", () => {
  it("accepts the user's own examples of a completion", () => {
    for (const msg of [
      "I walked the dog.",
      "Just walked the dog.",
      "Took the dog for his walk.",
      "Finished walking the dog.",
      "Got his walk done.",
      "I already did the dog walk.",
    ]) {
      expect(classifyCompletionReport(msg), msg).not.toBe("none");
    }
  });

  it("refuses plans, questions, reminders, negations and other people", () => {
    for (const msg of [
      "I might walk the dog later.",
      "Remind me to walk the dog.",
      "Did I walk the dog?",
      "I need to walk the dog tonight",
      "I forgot to walk the dog",
      "I didn't walk the dog",
      "John walked the dog.",
      "He walked the dog",
      "Create a habit to walk the dog every day",
    ]) {
      expect(classifyCompletionReport(msg), msg).toBe("none");
    }
  });

  it("treats a polite command as an instruction, not a question", () => {
    // "Can you mark off my run?" is how people actually ask. Refusing it as a
    // question would be the old bug wearing different clothes.
    for (const msg of [
      "Can you mark off my run?",
      "Could you check in my meditation?",
      "please mark off my walk",
      "mark off my run?",
    ]) {
      expect(isHardCompletionVeto(msg), msg).toBe(false);
    }
  });

  it("still vetoes a real question, a denial, and a reminder request", () => {
    for (const msg of [
      "Did I walk the dog?",
      "Have I done my habits today?",
      "I didn't walk the dog",
      "don't mark it off",
      "remind me to walk the dog",
    ]) {
      expect(isHardCompletionVeto(msg), msg).toBe(true);
    }
  });

  it("knows a proper name in subject position from a dropped 'I'", () => {
    expect(hasThirdPersonSubject("John walked the dog")).toBe(true);
    expect(hasThirdPersonSubject("Just walked the dog")).toBe(false);
    expect(hasThirdPersonSubject("Took the dog out")).toBe(false);
    expect(hasThirdPersonSubject("I walked the dog")).toBe(false);
  });
});

describe("matchHabitForCompletionReport — which habit, if any", () => {
  const habits = [
    { id: "h1", name: "Walk the Dog" },
    { id: "h2", name: "Drink Water" },
  ];

  it("matches when the message names the whole habit", () => {
    const hit = matchHabitForCompletionReport(habits, "I walked the dog");
    expect(hit?.habit.id).toBe("h1");
    expect(hit?.match).toBe("full");
  });

  it("does NOT map a vague activity onto a habit it only half-matches", () => {
    // The user's own counter-example: this is a walk, but it is not the
    // dog-walking habit, and guessing would fake a completion.
    expect(matchHabitForCompletionReport(habits, "I walked for twenty minutes")).toBeNull();
  });

  it("allows a unique partial only when the sentence says it's finished", () => {
    const hit = matchHabitForCompletionReport(habits, "Got his walk done");
    expect(hit?.habit.id).toBe("h1");
    expect(hit?.match).toBe("unique-partial");
  });

  it("declines when two DIFFERENT habits are equally plausible", () => {
    const ambiguous = [{ id: "a", name: "Morning Walk" }, { id: "b", name: "Evening Walk" }];
    expect(matchHabitForCompletionReport(ambiguous, "got my walk done")).toBeNull();
  });

  it("still completes when the tie is between duplicate rows of the SAME habit", () => {
    // Real data (this user's account) has two rows both called "Walk the Dog".
    // That is invisible to them, so refusing on ambiguity would just look like
    // the feature not working.
    const dupes = [{ id: "a", name: "Walk the Dog" }, { id: "b", name: "Walk the Dog" }];
    const hit = matchHabitForCompletionReport(dupes, "I walked the dog");
    expect(hit).not.toBeNull();
    // A `prefer` predicate picks the row that still has an occurrence left.
    const preferred = matchHabitForCompletionReport(dupes, "I walked the dog", undefined, {
      prefer: (h) => h.id === "b",
    });
    expect(preferred?.habit.id).toBe("b");
  });

  it("never matches a message that isn't a completion at all", () => {
    expect(matchHabitForCompletionReport(habits, "Did I walk the dog?")).toBeNull();
    expect(matchHabitForCompletionReport(habits, "remind me to walk the dog")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The scenario, step by step (the 13 checks from the report)
// ─────────────────────────────────────────────────────────────────────────────

describe("walk the dog — chat, dashboard and tracker agree", () => {
  let storage: MemStorage;
  let USER: string;
  let walkId: string;
  let waterId: string;

  beforeEach(async () => {
    storage = new MemStorage();
    USER = nextUser();
    const walk = await run(storage, () => executeTool("create_habit", {
      name: "Walk the Dog", dailyTarget: 2,
      __userMessage: "create a habit to walk the dog twice a day",
    }, USER)) as any;
    walkId = walk.id;
    const water = await run(storage, () => executeTool("create_habit", {
      name: "Drink Water",
      __userMessage: "add a daily habit to drink 64 oz of water",
    }, USER)) as any;
    waterId = water.id;
  });

  const progressOf = async (id: string) =>
    habitDayProgress((await run(storage, () => storage.getHabit(id))) as any, TODAY());

  const say = (msg: string, tool: string, input: Record<string, any>) =>
    run(storage, () => executeTool(tool, { ...input, __userMessage: msg }, USER)) as Promise<any>;

  it("1–4: starts at 0, and 'I walked the dog' completes it without being asked", async () => {
    expect((await progressOf(walkId)).completed).toBe(0);

    // The routing the model actually took in the screenshot: an activity report
    // goes to log_tracker_entry. That must NOT leave the habit behind.
    const entry = await say("I just walked the dog", "log_tracker_entry", {
      trackerName: "Walk the Dog", values: { activityType: "walking" },
    });
    expect(entry.error).toBeUndefined();

    const after = await progressOf(walkId);
    expect(after.completed).toBe(1);
    expect(after.required).toBe(2);
    expect(after.label).toBe("1 of 2 completed");
    // And the reply is told to report it rather than ask for a command.
    expect(String(entry.habitProgressNote || "")).toContain("Walk the Dog");
    expect(String(entry.habitProgressNote || "")).toContain("NEVER ask");
  });

  it("2–4 via checkin_habit: the same sentence is accepted, not refused", async () => {
    // Before: this exact message returned NOT_A_HABIT_CHECKIN.
    const res = await say("I just walked the dog", "checkin_habit", { name: "Walk the Dog" });
    expect(res.error).toBeUndefined();
    expect(res.source).toBe("chat_inferred");
    expect(res.completed).toBe(1);
    expect(res.required).toBe(2);
  });

  it("5–6: the completion is on the habit record and in its tracker", async () => {
    await say("I walked the dog", "checkin_habit", { name: "Walk the Dog" });
    const habit = await run(storage, () => storage.getHabit(walkId));
    expect((habit?.checkins || []).filter(c => c.date === TODAY())).toHaveLength(1);

    // The habit's linked tracker carries the record too.
    const tracker = await run(storage, () => storage.getTracker(String((habit as any)?.linkedTrackerId)));
    expect(tracker).toBeTruthy();
    expect((tracker?.entries || []).length).toBeGreaterThan(0);
  });

  it("7: it survives a reload — the state is stored, not rendered", async () => {
    await say("I walked the dog", "checkin_habit", { name: "Walk the Dog" });
    // A fresh read of storage is what a page refresh does.
    const reread = await run(storage, () => storage.getHabits());
    const walk = reread.find(h => h.id === walkId)!;
    expect(habitDayProgress(walk as any, TODAY()).completed).toBe(1);
  });

  it("8–10: marking the other habit by hand updates it and its tracker", async () => {
    const res = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: waterId, source: "habit_ui",
    }));
    expect(res.ok).toBe(true);
    expect(res.recorded).toBe(1);
    expect(res.progress.isComplete).toBe(true);
    // Manual completion writes the tracker record — the reverse direction.
    expect(res.tracker).toBeTruthy();
    expect(res.trackerEntries.length).toBe(1);
  });

  it("11–12: saying it again records nothing — no duplicate anywhere", async () => {
    await say("I walked the dog", "checkin_habit", { name: "Walk the Dog" });
    const before = await progressOf(walkId);
    const trackerId = String(((await run(storage, () => storage.getHabit(walkId))) as any)?.linkedTrackerId);
    const entriesBefore = (await run(storage, () => storage.getTracker(trackerId)))?.entries.length ?? 0;

    // Second identical report → fills the SECOND of two occurrences, not a
    // duplicate of the first…
    const second = await say("I walked the dog again", "checkin_habit", { name: "Walk the Dog" });
    expect(second.completed).toBe(2);

    // …and a third finds the day full and records nothing at all.
    const third = await say("I walked the dog", "checkin_habit", { name: "Walk the Dog" });
    expect(third.alreadyComplete).toBe(true);
    expect(String(third.message)).toContain("no duplicate");

    const after = await progressOf(walkId);
    expect(after.completed).toBe(2);
    expect(after.rawCompleted).toBe(2); // no extra check-in rows
    expect(before.completed).toBe(1);

    const entriesAfter = (await run(storage, () => storage.getTracker(trackerId)))?.entries.length ?? 0;
    // One more entry for the genuine second completion, none for the third.
    expect(entriesAfter).toBe(entriesBefore + 1);
  });

  it("13: logging the linked tracker completes the habit (reverse direction)", async () => {
    const habit = await run(storage, () => storage.getHabit(waterId));
    const trackerId = String((habit as any)?.linkedTrackerId);
    expect(trackerId).toBeTruthy();

    await run(storage, () => storage.logEntry({ trackerId, values: { ounces: 32 } } as any));

    const after = await progressOf(waterId);
    expect(after.completed).toBe(1);
    expect(after.isComplete).toBe(true);
  });

  it("a manual check-in and a chat report do not double-count each other", async () => {
    // Chat first…
    await say("I walked the dog", "checkin_habit", { name: "Walk the Dog" });
    // …then the dashboard tap, same occurrence's day.
    const manual = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: walkId, source: "habit_ui",
    }));
    expect(manual.recorded).toBe(1); // the SECOND of two, not a repeat of the first
    expect(manual.progress.completed).toBe(2);

    const third = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: walkId, source: "habit_ui",
    }));
    expect(third.recorded).toBe(0);
    expect(third.alreadyComplete).toBe(true);
    expect(third.trackerEntries).toHaveLength(0);
  });

  it("refuses to infer a completion from a plan or a question", async () => {
    for (const msg of ["I might walk the dog later", "Did I walk the dog?", "remind me to walk the dog"]) {
      const res = await say(msg, "checkin_habit", { name: "Walk the Dog" });
      expect(res.code, msg).toBe("NOT_A_HABIT_CHECKIN");
    }
    expect((await progressOf(walkId)).completed).toBe(0);
  });

  it("does not complete a habit from a half-matching activity", async () => {
    const entry = await say("I walked for twenty minutes", "log_tracker_entry", {
      trackerName: "Walking", values: { duration: 20 },
    });
    expect(entry.error).toBeUndefined();
    expect((await progressOf(walkId)).completed).toBe(0);
  });

  it("never touches another profile's habit from an unqualified report", async () => {
    const joe = await run(storage, () => storage.createProfile({ type: "person", name: "Joe" } as any));
    const joeHabit = await run(storage, () => storage.createHabit({
      name: "Feed the Fish", frequency: "daily", targetPerDay: 1, linkedProfiles: [joe.id],
    } as any));
    const res = await say("I fed the fish", "checkin_habit", { name: "Feed the Fish" });
    expect(res.error).toBeTruthy();
    const stored = await run(storage, () => storage.getHabit(joeHabit.id));
    expect(stored?.checkins || []).toHaveLength(0);
  });

  it("a habit completion never creates a calendar event or task", async () => {
    await say("I walked the dog", "checkin_habit", { name: "Walk the Dog" });
    await run(storage, () => completeHabitOccurrence(storage, { habitId: waterId, source: "habit_ui" }));
    expect(await run(storage, () => storage.getEvents())).toHaveLength(0);
    expect(await run(storage, () => storage.getTasks())).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The pipeline's own guarantees
// ─────────────────────────────────────────────────────────────────────────────

describe("completeHabitOccurrence — one pipeline, every source", () => {
  let storage: MemStorage;

  beforeEach(() => { storage = new MemStorage(); });

  const makeHabit = (over: Record<string, any> = {}) =>
    run(storage, () => storage.createHabit({
      name: "Stretch", frequency: "daily", targetPerDay: 1, ...over,
    } as any));

  it("reports a missing habit instead of throwing", async () => {
    const res = await run(storage, () => completeHabitOccurrence(storage, { habitId: "nope", source: "api" }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not_found");
  });

  it("refuses a day the habit isn't scheduled on", async () => {
    // Sundays only; ask for a day that is not a Sunday.
    const h = await makeHabit({ frequency: "custom", targetDays: [0] });
    const res = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: h.id, date: "2026-08-19", source: "api", // a Wednesday
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("not_scheduled");
  });

  it("records every source identically", async () => {
    for (const source of ["chat_inferred", "chat_explicit", "habit_ui", "tracker", "api"] as const) {
      const h = await makeHabit({ name: `Stretch ${source}` });
      const res = await run(storage, () => completeHabitOccurrence(storage, { habitId: h.id, source }));
      expect(res.ok, source).toBe(true);
      expect(res.recorded, source).toBe(1);
      expect(res.progress.isComplete, source).toBe(true);
      expect(res.source, source).toBe(source);
    }
  });

  it("clamps a multi-completion request to what the day still needs", async () => {
    const h = await makeHabit({ targetPerDay: 2 });
    const res = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: h.id, count: 5, source: "chat_explicit",
    }));
    expect(res.recorded).toBe(2);
    expect(res.progress.completed).toBe(2);
  });

  it("a manual completion of an UNLINKED habit creates a tracker and logs to it", async () => {
    // User directive 2026-08-20: "If you're inside the Habits tab and manually
    // press/check Walk the Dog, that action itself should create a tracker
    // entry too. Manual habit completion = habit completion + tracker entry."
    const h = await makeHabit({ name: "Brush Teeth" });
    expect((h as any).linkedTrackerId).toBeFalsy();
    expect(await run(storage, () => storage.getTrackers())).toHaveLength(0);

    const res = await run(storage, () => completeHabitOccurrence(storage, { habitId: h.id, source: "habit_ui" }));
    expect(res.recorded).toBe(1);
    expect(res.tracker).toBeTruthy();
    expect(res.trackerEntries).toHaveLength(1);

    // The tracker now exists, is linked to the habit, and holds the entry.
    const trackers = await run(storage, () => storage.getTrackers());
    expect(trackers).toHaveLength(1);
    expect(trackers[0].entries).toHaveLength(1);
    const stored = await run(storage, () => storage.getHabit(h.id));
    expect((stored as any).linkedTrackerId).toBe(trackers[0].id);
  });

  it("a manual completion APPENDS to a compatible existing tracker rather than making a second one", async () => {
    const existing = await run(storage, () => storage.createTracker({
      name: "Hydration", category: "health",
      fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
    } as any));
    const h = await makeHabit({ name: "Drink Water" });

    const res = await run(storage, () => completeHabitOccurrence(storage, { habitId: h.id, source: "habit_ui" }));
    expect(res.tracker?.id).toBe(existing.id);
    expect(await run(storage, () => storage.getTrackers())).toHaveLength(1);
    expect((await run(storage, () => storage.getTracker(existing.id)))?.entries).toHaveLength(1);
  });

  it("repeated manual completions never double up the tracker entry", async () => {
    const h = await makeHabit({ name: "Brush Teeth", targetPerDay: 2 });
    await run(storage, () => completeHabitOccurrence(storage, { habitId: h.id, source: "habit_ui" }));
    await run(storage, () => completeHabitOccurrence(storage, { habitId: h.id, source: "habit_ui" }));
    const third = await run(storage, () => completeHabitOccurrence(storage, { habitId: h.id, source: "habit_ui" }));
    expect(third.recorded).toBe(0);

    const trackers = await run(storage, () => storage.getTrackers());
    expect(trackers).toHaveLength(1);
    // Two completions, two entries — the third attempt wrote nothing.
    expect(trackers[0].entries).toHaveLength(2);
  });

  it("ensureTracker:false completes the habit alone", async () => {
    const h = await makeHabit({ name: "Make My Bed" });
    const res = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: h.id, source: "api", ensureTracker: false,
    }));
    expect(res.recorded).toBe(1);
    expect(await run(storage, () => storage.getTrackers())).toHaveLength(0);
  });

  it("a tracker-sourced completion writes no mirror entry (the entry IS the record)", async () => {
    const tracker = await run(storage, () => storage.createTracker({
      name: "Stretching", category: "fitness", fields: [{ name: "minutes", type: "number" }],
    } as any));
    const h = await makeHabit({ linkedTrackerId: tracker.id } as any);
    const res = await run(storage, () => completeHabitOccurrence(storage, {
      habitId: h.id, source: "tracker", skipTrackerWrite: true,
    }));
    expect(res.recorded).toBe(1);
    expect(res.trackerEntries).toHaveLength(0);
  });
});
