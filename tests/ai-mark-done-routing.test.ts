// End-to-end routing for "mark X done" — the exact scenario from the report.
//
// This drives the REAL executeTool dispatcher against an in-memory storage, so
// it exercises the actual decision the assistant makes, not a helper in
// isolation. The seed is the one the user specified:
//
//   Habit: Clean my room          Task: Buy groceries
//   Habit: Bathroom Visit (2/day)
//
// and the expectations are theirs too:
//
//   "Mark Clean my room done"        → habit 1/1        (was: "no such task")
//   "Mark habit Clean my room done"  → habit 1/1        (was: "no such habit")
//   "Mark Bathroom Visit done"       → 1/2, then 2/2    (one occurrence a call)
//   "Mark Buy groceries done"        → task completes
//   "Mark habit Buy groceries done"  → task UNTOUCHED   (explicit kind wins)

import { describe, it, expect, beforeEach, vi } from "vitest";

const SELF = { id: "p-self", name: "robert sennabaum", type: "self" };

type Habit = { id: string; name: string; linkedProfiles: string[]; targetPerDay: number; checkins: any[] };
type Task = { id: string; title: string; status: string; linkedProfiles: string[] };

const db: { habits: Habit[]; tasks: Task[] } = { habits: [], tasks: [] };

function reseed() {
  db.habits = [
    { id: "h-clean", name: "Clean my room", linkedProfiles: [SELF.id], targetPerDay: 1, checkins: [] },
    { id: "h-bath", name: "Bathroom Visit", linkedProfiles: [SELF.id], targetPerDay: 2, checkins: [] },
    // ORPHAN — no linked profile at all. The dashboard shows these as the
    // user's own; chat must too (user report 2026-08-17, "Daily run").
    { id: "h-run", name: "Daily run", linkedProfiles: [], targetPerDay: 1, checkins: [] },
  ];
  db.tasks = [
    { id: "t-groc", title: "Buy groceries", status: "open", linkedProfiles: [SELF.id] },
  ];
}

const today = () => new Date().toLocaleDateString("en-CA");

// A storage double with the same contract the real one exposes to the engine:
// user-scoped reads, soft-deletes already excluded, check-ins capped at
// targetPerDay (one occurrence per call).
vi.mock("../server/storage", () => ({
  storage: {
    getProfiles: async () => [SELF],
    getHabits: async () => db.habits,
    getHabit: async (id: string) => db.habits.find(h => h.id === id),
    getTasks: async () => db.tasks,
    getGoals: async () => [],
    getEvents: async () => [],
    getTrackers: async () => [],
    getExpenses: async () => [],
    getObligations: async () => [],
    getMemories: async () => [],
    getDocuments: async () => [],
    getJournalEntries: async () => [],
    checkinHabit: async (habitId: string) => {
      const h = db.habits.find(x => x.id === habitId);
      if (!h) return undefined;
      const d = today();
      if (h.checkins.filter(c => c.date === d).length >= (h.targetPerDay || 1)) return undefined;
      const c = { id: `c${h.checkins.length + 1}`, habitId, date: d };
      h.checkins.push(c);
      return c;
    },
    updateTask: async (id: string, patch: any) => {
      const t = db.tasks.find(x => x.id === id);
      if (!t) return undefined;
      Object.assign(t, patch);
      return t;
    },
  },
}));

// The engine pulls in heavy AI plumbing at import time; the tools under test
// touch none of it.
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

/** Completions recorded for a habit today. */
const progress = (id: string) => {
  const h = db.habits.find(x => x.id === id)!;
  return `${h.checkins.filter(c => c.date === today()).length}/${h.targetPerDay}`;
};

describe("'mark X done' reaches the record the dashboard shows", () => {
  it('"Mark Clean my room done" checks in the HABIT — the reported failure', async () => {
    // The model picks complete_task for "done"; the database must correct it.
    const res = await executeTool("complete_task", {
      title: "Clean my room", __userMessage: "Mark Clean my room done",
    }, "u1");

    expect(res?.error, `should not have errored: ${JSON.stringify(res)}`).toBeUndefined();
    expect(res?.resolvedAs).toBe("habit");
    expect(progress("h-clean")).toBe("1/1");
    // …and it did NOT invent a task.
    expect(db.tasks.find(t => t.title === "Clean my room")).toBeUndefined();
  });

  it('"Mark habit Clean my room done" checks in the same habit', async () => {
    const res = await executeTool("checkin_habit", {
      name: "Clean my room", __userMessage: "Mark habit clean my room done",
    }, "u1");
    expect(res?.error).toBeUndefined();
    expect(progress("h-clean")).toBe("1/1");
  });

  it("case and punctuation do not matter", async () => {
    await executeTool("checkin_habit", {
      name: "CLEAN MY ROOM", __userMessage: "mark habit CLEAN MY ROOM done",
    }, "u1");
    expect(progress("h-clean")).toBe("1/1");
  });

  it("a 2×/day habit advances ONE occurrence per call: 1/2 then 2/2", async () => {
    await executeTool("checkin_habit", {
      name: "Bathroom Visit", __userMessage: "mark habit Bathroom Visit done",
    }, "u1");
    expect(progress("h-bath")).toBe("1/2");

    await executeTool("checkin_habit", {
      name: "Bathroom Visit", __userMessage: "mark habit Bathroom Visit done again",
    }, "u1");
    expect(progress("h-bath")).toBe("2/2");
  });

  it('"Mark Buy groceries done" completes the TASK', async () => {
    const res = await executeTool("complete_task", {
      title: "Buy groceries", __userMessage: "Mark Buy groceries done",
    }, "u1");
    expect(res?.error).toBeUndefined();
    expect(db.tasks.find(t => t.id === "t-groc")?.status).toBe("done");
  });

  it('"Mark habit Buy groceries done" leaves the task ALONE', async () => {
    // The user named a kind. Acting on the same-named task anyway is the
    // failure that makes an assistant untrustworthy with data.
    const res = await executeTool("checkin_habit", {
      name: "Buy groceries", __userMessage: "Mark habit Buy groceries done",
    }, "u1");
    expect(db.tasks.find(t => t.id === "t-groc")?.status).toBe("open");
    expect(res?.error).toBeTruthy();
    expect(res?.resolvedAs).toBeUndefined();
  });

  it('"Mark Daily run done" checks in an ORPHAN habit — the second report', async () => {
    // Two things had to be true for this to work: the check-in intent gate has
    // to accept "Mark <name> done" (it used to read that as an activity report
    // and divert to a tracker), and the profile scope has to admit a habit with
    // no linkedProfiles at all.
    const res = await executeTool("checkin_habit", {
      name: "Daily run", __userMessage: "Mark Daily run done",
    }, "u1");
    expect(res?.error, `should not have errored: ${JSON.stringify(res)}`).toBeUndefined();
    expect(progress("h-run")).toBe("1/1");
  });

  it('"Mark Daily run done" also works when the model routes it as a task', async () => {
    const res = await executeTool("complete_task", {
      title: "Daily run", __userMessage: "Mark Daily run done",
    }, "u1");
    expect(res?.resolvedAs).toBe("habit");
    expect(progress("h-run")).toBe("1/1");
  });

  it("a plain activity report is still NOT a habit check-in", async () => {
    // The 2026-07-15 guard must survive: narrating an activity logs a tracker
    // entry, it does not silently move someone's streak.
    const res = await executeTool("checkin_habit", {
      name: "Daily run", __userMessage: "I ran 3 miles this morning",
    }, "u1");
    expect(res?.code).toBe("NOT_A_HABIT_CHECKIN");
    expect(progress("h-run")).toBe("0/1");
  });

  it("offers to create only when NOTHING of any kind matches", async () => {
    const res = await executeTool("complete_task", {
      title: "Wash the dragon", __userMessage: "mark wash the dragon done",
    }, "u1");
    expect(res?.error).toBeTruthy();
    // The lookup was exhaustive, and says so.
    expect(res?.checkedKinds).toBeTruthy();
    // Nothing was invented as a side effect of the failed lookup.
    expect(db.habits).toHaveLength(3);
    expect(db.tasks).toHaveLength(1);
  });

  it("a habit-only name never reports 'no such task' again", async () => {
    const res = await executeTool("complete_task", {
      title: "Bathroom Visit", __userMessage: "mark Bathroom Visit done",
    }, "u1");
    expect(res?.resolvedAs).toBe("habit");
    expect(progress("h-bath")).toBe("1/2");
  });
});
