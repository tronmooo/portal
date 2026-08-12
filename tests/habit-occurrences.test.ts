// tests/habit-occurrences.test.ts
//
// A habit that must be done SEVERAL times a day, and what "done" means then.
//
// Reported 2026-08-09: "Walk the Dog — 2× daily" showed a finished checkmark
// and 100% after ONE tap. The data model was already right (targetPerDay, one
// check-in row per completion), but nothing computed PARTIAL progress, so every
// surface asked the only question it could — "is there a check-in?" — and a
// half-done day rendered as a whole one. On a medication habit that is a claim
// about a dose the user hadn't taken.
//
// The rule, everywhere:
//
//     percent = completed occurrences today ÷ required occurrences today × 100
//
// and the day is complete only when every required occurrence is in.
import { describe, it, expect, beforeEach } from "vitest";
import {
  habitDayProgress,
  habitsDayRollup,
  nextOutstandingOccurrence,
  latestCheckinOn,
  checkinAtPosition,
  totalScheduledOccurrences,
} from "@shared/habit-progress";
import { isHabitDueOn } from "@shared/habit-schedule";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import { calculateStreak } from "@shared/streak";
import { parseCompletionCount, parseOccurrencePosition, hasExplicitHabitCheckinIntent } from "@shared/habit-intent";
import { parseDurationDays, parseDailyTarget } from "@shared/ai-intent";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";

const DAY = "2026-08-12"; // a Wednesday

/** A habit with `n` completions already recorded today. */
const habitWith = (target: number, done: number, over: Record<string, any> = {}) => ({
  id: "h1",
  name: "Take medication",
  frequency: "daily",
  targetPerDay: target,
  checkins: Array.from({ length: done }, (_, i) => ({
    id: `c${i + 1}`,
    date: DAY,
    timestamp: `${DAY}T0${8 + i}:00:00.000Z`,
  })),
  ...over,
});

describe("daily progress is a fraction of the day's occurrences", () => {
  it("starts the day at 0%", () => {
    const p = habitDayProgress(habitWith(2, 0), DAY);
    expect(p).toMatchObject({ required: 2, completed: 0, percent: 0, isComplete: false, isPartial: false });
    expect(p.label).toBe("0 of 2 completed");
  });

  it("reads 50% at one of two — not done", () => {
    const p = habitDayProgress(habitWith(2, 1), DAY);
    // The bug in one assertion: this said complete.
    expect(p.isComplete).toBe(false);
    expect(p.isPartial).toBe(true);
    expect(p.percent).toBe(50);
    expect(p.label).toBe("1 of 2 completed");
  });

  it("reads 100% at two of two", () => {
    const p = habitDayProgress(habitWith(2, 2), DAY);
    expect(p).toMatchObject({ completed: 2, percent: 100, isComplete: true, isPartial: false });
  });

  it("thirds round to 33 / 67 / 100", () => {
    expect(habitDayProgress(habitWith(3, 1), DAY).percent).toBe(33);
    expect(habitDayProgress(habitWith(3, 2), DAY).percent).toBe(67);
    expect(habitDayProgress(habitWith(3, 3), DAY).percent).toBe(100);
  });

  it("quarters are 25 / 50 / 75 / 100", () => {
    expect([1, 2, 3, 4].map((n) => habitDayProgress(habitWith(4, n), DAY).percent))
      .toEqual([25, 50, 75, 100]);
  });

  it("never calls 2 of 3 done just because it rounds to 67", () => {
    // `isComplete` is decided on the counts. A rounded percent must never
    // award a day — that is how a streak gets credit for a dose not taken.
    const p = habitDayProgress(habitWith(3, 2), DAY);
    expect(p.percent).toBeGreaterThan(50);
    expect(p.isComplete).toBe(false);
  });

  it("a single-completion habit still reads 0 then 100", () => {
    expect(habitDayProgress(habitWith(1, 0), DAY).percent).toBe(0);
    expect(habitDayProgress(habitWith(1, 1), DAY)).toMatchObject({ percent: 100, isComplete: true });
  });

  it("counts extra rows without letting them push past 100%", () => {
    // Three rows on a 2× habit (target lowered later, or a double write): the
    // day is complete, the percent is 100, and the extras stay visible in
    // rawCompleted rather than being silently dropped.
    const p = habitDayProgress(habitWith(2, 3), DAY);
    expect(p).toMatchObject({ completed: 2, rawCompleted: 3, percent: 100, isComplete: true });
  });

  it("an unscheduled day is not a completed day", () => {
    const weekly = habitWith(2, 0, { frequency: "weekly", targetDays: [1] }); // Mondays
    const p = habitDayProgress(weekly, DAY); // a Wednesday
    expect(p.isScheduled).toBe(false);
    expect(p.required).toBe(0);
    expect(p.isComplete).toBe(false); // "nothing asked" ≠ "finished"
    expect(p.label).toBe("Not scheduled today");
  });
});

describe("each completion is its own record", () => {
  it("lists one occurrence slot per required completion, in order", () => {
    const p = habitDayProgress(habitWith(3, 2), DAY);
    expect(p.occurrences.map((o) => [o.position, o.done])).toEqual([[1, true], [2, true], [3, false]]);
    expect(p.occurrences[0].checkin?.id).toBe("c1");
    expect(p.occurrences[1].checkin?.id).toBe("c2");
    expect(p.occurrences[2].checkin).toBeNull();
  });

  it("orders occurrences by when they were logged, not by array order", () => {
    const scrambled = {
      ...habitWith(3, 0),
      checkins: [
        { id: "late", date: DAY, timestamp: `${DAY}T20:00:00.000Z` },
        { id: "early", date: DAY, timestamp: `${DAY}T06:00:00.000Z` },
      ],
    };
    const p = habitDayProgress(scrambled, DAY);
    expect(p.occurrences.map((o) => o.checkin?.id ?? null)).toEqual(["early", "late", null]);
  });

  it("points at the next outstanding occurrence, and at nothing when full", () => {
    expect(nextOutstandingOccurrence(habitWith(2, 1), DAY)?.position).toBe(2);
    expect(nextOutstandingOccurrence(habitWith(2, 2), DAY)).toBeNull();
  });

  it("undo targets the LAST completion, so the rest keep their positions", () => {
    expect(latestCheckinOn(habitWith(3, 2), DAY)?.id).toBe("c2");
    expect(checkinAtPosition(habitWith(3, 2), DAY, 1)?.id).toBe("c1");
    expect(checkinAtPosition(habitWith(3, 2), DAY, 3)).toBeNull();
  });

  it("only counts the day being asked about", () => {
    const across = {
      ...habitWith(2, 0),
      checkins: [
        { id: "y1", date: "2026-08-11", timestamp: "2026-08-11T08:00:00.000Z" },
        { id: "y2", date: "2026-08-11", timestamp: "2026-08-11T20:00:00.000Z" },
        { id: "t1", date: DAY, timestamp: `${DAY}T08:00:00.000Z` },
      ],
    };
    // Yesterday finished; today is half done. The count resets with the day
    // while the history stays.
    expect(habitDayProgress(across, "2026-08-11")).toMatchObject({ completed: 2, isComplete: true });
    expect(habitDayProgress(across, DAY)).toMatchObject({ completed: 1, percent: 50, isComplete: false });
  });
});

describe("three commitments that are not the same thing", () => {
  const twicePerDay = { id: "a", frequency: "daily", targetPerDay: 2, checkins: [] };
  const dailyForTwoDays = { id: "b", frequency: "daily", targetPerDay: 1, startDate: "2026-08-12", endDate: "2026-08-13", checkins: [] };
  const twicePerDayForSeven = { id: "c", frequency: "daily", targetPerDay: 2, startDate: "2026-08-12", endDate: "2026-08-18", checkins: [] };

  it("2x per day is two a day, open-ended", () => {
    expect(habitDayProgress(twicePerDay, DAY).required).toBe(2);
    expect(totalScheduledOccurrences(twicePerDay)).toBeNull(); // no end to count to
    expect(isHabitDueOn(twicePerDay, "2027-01-01")).toBe(true);
  });

  it("daily for 2 days is one a day, twice", () => {
    expect(habitDayProgress(dailyForTwoDays, DAY).required).toBe(1);
    expect(totalScheduledOccurrences(dailyForTwoDays)).toBe(2);
    expect(isHabitDueOn(dailyForTwoDays, "2026-08-13")).toBe(true);
    expect(isHabitDueOn(dailyForTwoDays, "2026-08-14")).toBe(false); // it ended
  });

  it("2x per day for 7 days is fourteen occurrences", () => {
    expect(habitDayProgress(twicePerDayForSeven, DAY).required).toBe(2);
    expect(totalScheduledOccurrences(twicePerDayForSeven)).toBe(14);
    expect(isHabitDueOn(twicePerDayForSeven, "2026-08-18")).toBe(true);
    expect(isHabitDueOn(twicePerDayForSeven, "2026-08-19")).toBe(false);
  });

  it("a bounded habit stops being due once its window closes", () => {
    // Without the window these all looked identical and the bounded ones
    // nagged forever.
    expect(habitDayProgress(twicePerDayForSeven, "2026-08-19").isScheduled).toBe(false);
    expect(habitDayProgress(twicePerDayForSeven, "2026-08-11").isScheduled).toBe(false); // before it starts
  });

  it("counts only SCHEDULED days inside the window", () => {
    const mwf = { id: "d", frequency: "custom", targetDays: [1, 3, 5], targetPerDay: 2, startDate: "2026-08-10", endDate: "2026-08-16", checkins: [] };
    // Mon 10, Wed 12, Fri 14 → 3 days × 2 = 6, not 7 days × 2.
    expect(totalScheduledOccurrences(mwf)).toBe(6);
  });
});

describe("a day counts for the streak only when every occurrence is in", () => {
  const day = (d: string, n: number) => Array.from({ length: n }, () => d);

  it("does not award a streak day for a partial day", () => {
    const dates = [...day("2026-08-10", 2), ...day("2026-08-11", 2), ...day(DAY, 1)];
    const { current } = calculateStreak(dates, { today: DAY, targetPerDay: 2 });
    // Two complete days behind it; today is half done and earns nothing yet.
    expect(current).toBe(2);
  });

  it("does not BREAK the streak while today is still open", () => {
    // The one-day grace: yesterday complete + today partial keeps the run
    // alive, so a user mid-way through their doses isn't told they lost it.
    const dates = [...day("2026-08-11", 2), ...day(DAY, 1)];
    expect(calculateStreak(dates, { today: DAY, targetPerDay: 2 }).current).toBe(1);
  });

  it("awards the day the moment the last occurrence lands", () => {
    const dates = [...day("2026-08-11", 2), ...day(DAY, 2)];
    expect(calculateStreak(dates, { today: DAY, targetPerDay: 2 }).current).toBe(2);
  });

  it("a day that never reached its target never counted", () => {
    const dates = [...day("2026-08-10", 2), ...day("2026-08-11", 1), ...day(DAY, 2)];
    // Aug 11 was one of two — the run restarts at today.
    expect(calculateStreak(dates, { today: DAY, targetPerDay: 2 }).current).toBe(1);
  });
});

describe("rolling several habits up counts occurrences, not habits", () => {
  it("halves a four-occurrence day after two completions", () => {
    const r = habitsDayRollup([habitWith(2, 1, { id: "x" }), habitWith(2, 1, { id: "y" })], DAY);
    // Two habits, one dose each: two of four, not "two of two habits touched".
    expect(r).toMatchObject({ required: 4, completed: 2, percent: 50, habitsComplete: 0, habitsPartial: 2 });
  });

  it("ignores habits not scheduled today on both sides of the ratio", () => {
    const mondayOnly = habitWith(2, 0, { id: "z", frequency: "weekly", targetDays: [1] });
    const r = habitsDayRollup([habitWith(2, 2, { id: "x" }), mondayOnly], DAY);
    expect(r).toMatchObject({ required: 2, completed: 2, percent: 100, habitsScheduled: 1 });
  });

  it("is 0% for a day with nothing scheduled rather than dividing by zero", () => {
    expect(habitsDayRollup([], DAY)).toMatchObject({ required: 0, completed: 0, percent: 0 });
  });
});

describe("the words people actually use", () => {
  it("reads an explicit count", () => {
    expect(parseCompletionCount("I took both doses")).toEqual({ count: 2 });
    expect(parseCompletionCount("I finished this habit twice today")).toEqual({ count: 2 });
    expect(parseCompletionCount("I took it once")).toEqual({ count: 1 });
    expect(parseCompletionCount("mark one completed")).toEqual({ count: 1 });
    expect(parseCompletionCount("I already did one of them")).toEqual({ count: 1 });
    expect(parseCompletionCount("I took my first dose")).toEqual({ count: 1 });
    expect(parseCompletionCount("mark my medication done again")).toEqual({ count: 1 });
  });

  it("reads 'all of them' as filling the day", () => {
    expect(parseCompletionCount("mark all of them done")).toEqual({ all: true });
    // "all day" is a time phrase, not a quantity.
    expect(parseCompletionCount("I felt sick all day")).toBeNull();
  });

  it("says nothing when the user gave no count — the caller must record ONE", () => {
    expect(parseCompletionCount("mark my medication done")).toBeNull();
    expect(parseCompletionCount("check off walk the dog")).toBeNull();
  });

  it("reads which occurrence to undo", () => {
    expect(parseOccurrencePosition("undo my first dose")).toBe(1);
    expect(parseOccurrencePosition("remove the second one")).toBe(2);
    expect(parseOccurrencePosition("undo that")).toBeNull(); // = the latest
  });

  it("treats a dose report as a habit check-in, not an activity log", () => {
    expect(hasExplicitHabitCheckinIntent("I took my first dose")).toBe(true);
    expect(hasExplicitHabitCheckinIntent("I already did one of them")).toBe(true);
    expect(hasExplicitHabitCheckinIntent("mark both done")).toBe(true);
    // Still not a check-in: a plain activity report.
    expect(hasExplicitHabitCheckinIntent("I went to the bathroom at 8:15")).toBe(false);
  });

  it("keeps 'how often' and 'how long' apart", () => {
    expect(parseDailyTarget("take it three times a day for 7 days")).toBe(3);
    expect(parseDurationDays("take it three times a day for 7 days")).toBe(7);
    // A per-day count alone bounds nothing.
    expect(parseDurationDays("walk the dog twice a day")).toBeNull();
    expect(parseDurationDays("for two weeks")).toBe(14);
    expect(parseDurationDays("for a month")).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The real executor, against real storage
// ─────────────────────────────────────────────────────────────────────────────
let seq = 0;
const nextUser = () => `user-habit-occ-${++seq}`;
const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

describe("chat check-ins fill one occurrence at a time", () => {
  let storage: MemStorage;
  let USER: string;
  let habitId: string;
  // The runner's clock is UTC; storage stamps check-ins in the app's default
  // timezone. Computing "today" locally made these assertions disagree with
  // the stored rows for the ~7 hours a day when the two dates differ — the
  // test passed all morning and failed all evening. Ask the same clock the
  // code under test uses.
  const today = getUserToday(DEFAULT_TIMEZONE);

  beforeEach(async () => {
    storage = new MemStorage();
    USER = nextUser();
    const h = await run(storage, () => storage.createHabit({
      name: "Take medication", frequency: "daily", targetPerDay: 2,
    } as any));
    habitId = h.id;
  });

  const checkin = (msg: string, extra: Record<string, any> = {}) =>
    run(storage, () => executeTool("checkin_habit", {
      name: "Take medication", __userMessage: msg, ...extra,
    }, USER)) as Promise<any>;

  it("'mark my medication done' records ONE of two and says 50%", async () => {
    const res = await checkin("mark my medication done");
    expect(res.recorded).toBe(1);
    expect(res.completed).toBe(1);
    expect(res.required).toBe(2);
    expect(res.percent).toBe(50);
    expect(res.progress.isComplete).toBe(false);
    // The reply must not be allowed to say "done".
    expect(res.message).toContain("1 of 2");
  });

  it("'done again' records the second and finishes the day", async () => {
    await checkin("mark my medication done");
    const res = await checkin("mark my medication done again");
    expect(res.completed).toBe(2);
    expect(res.percent).toBe(100);
    expect(res.progress.isComplete).toBe(true);
  });

  it("'I took both doses' records two at once", async () => {
    const res = await checkin("I took both doses");
    expect(res.recorded).toBe(2);
    expect(res.percent).toBe(100);
  });

  it("never records more than the day has left", async () => {
    await checkin("I took both doses");
    const res = await checkin("I took both doses");
    expect(res.alreadyComplete).toBe(true);
    expect(res.progress.completed).toBe(2);
    const stored = await run(storage, () => storage.getHabit(habitId));
    expect((stored?.checkins || []).filter((c) => c.date === today)).toHaveLength(2);
  });

  it("stores each completion as its own row with its own timestamp", async () => {
    await checkin("mark my medication done");
    await checkin("mark my medication done again");
    const stored = await run(storage, () => storage.getHabit(habitId));
    const todays = (stored?.checkins || []).filter((c) => c.date === today);
    expect(todays).toHaveLength(2);
    expect(new Set(todays.map((c) => c.id)).size).toBe(2);
    expect(todays.every((c) => !!c.timestamp)).toBe(true);
  });

  it("undo removes ONE completion, not the whole day", async () => {
    await checkin("I took both doses");
    const res: any = await run(storage, () => executeTool("uncomplete_habit", {
      name: "Take medication", __userMessage: "undo that",
    }, USER));
    expect(res.uncompleted).toBe(true);
    expect(res.completed).toBe(1);
    expect(res.percent).toBe(50);
    const stored = await run(storage, () => storage.getHabit(habitId));
    expect((stored?.checkins || []).filter((c) => c.date === today)).toHaveLength(1);
  });

  it("undo can name which occurrence to remove", async () => {
    await checkin("I took both doses");
    const before = await run(storage, () => storage.getHabit(habitId));
    const firstId = (before?.checkins || []).filter((c) => c.date === today)[0].id;

    const res: any = await run(storage, () => executeTool("uncomplete_habit", {
      name: "Take medication", __userMessage: "undo my first dose",
    }, USER));
    expect(res.removedCheckinId).toBe(firstId);

    const after = await run(storage, () => storage.getHabit(habitId));
    expect((after?.checkins || []).map((c) => c.id)).not.toContain(firstId);
    expect((after?.checkins || []).filter((c) => c.date === today)).toHaveLength(1);
  });

  it("refuses a day the habit isn't scheduled on instead of inventing one", async () => {
    await run(storage, () => storage.updateHabit(habitId, { endDate: "2020-01-01" } as any));
    const res = await checkin("mark my medication done");
    expect(res.code).toBe("HABIT_NOT_SCHEDULED");
  });
});
