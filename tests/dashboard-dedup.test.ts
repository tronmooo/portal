// ── Executive tab de-duplication contract (8-block spec) ────────────────────
// The bug this locks down: the briefing's section filters overlapped by
// construction. `upcomingTasks` was `!dueDate || dueDate >= today` — an
// unbounded SUPERSET of both `agendaTasks` (due today) and `highPriority` — so
// a high-priority task due today rendered in three sections at once, plus the
// Today strip, plus the AI brief. Calendar·14d likewise re-rendered Birthdays,
// Appointments and Important Dates wholesale.
//
// buildBriefingModel replaces those filters with a priority cascade over a
// shared `push` that refuses a key it has already seen. These tests assert the
// property that makes the redundancy structurally impossible, plus the two
// spec overlaps that had to be resolved by hand (habits, streak chips).
import { describe, it, expect } from "vitest";
import { buildBriefingModel, HIDES_AT_ZERO, BLOCK_LABELS, type BriefingInput } from "../client/src/components/dashboard/useBriefingModel";

const TODAY = "2026-07-24";
const NOW = new Date(`${TODAY}T09:00:00Z`).getTime();
const d = (offset: number) => {
  const x = new Date(`${TODAY}T00:00:00`);
  x.setDate(x.getDate() + offset);
  return x.toLocaleDateString("en-CA");
};

const base: BriefingInput = {
  todayStr: TODAY, nowMs: NOW,
  tasks: [], habits: [], timeline: [], reminders: [], goals: [], trackers: [],
  bills: [], expiringDocs: [],
  finance: { assets: 0, liabilities: 0, monthlyIncome: 0, monthlySpend: 0, monthlyObligations: 0 },
  streaks: [], journalStreak: 0,
};

const build = (over: Partial<BriefingInput>) => buildBriefingModel({ ...base, ...over });

describe("cascade — every datum lands in exactly one block", () => {
  it("puts a high-priority task due today in Needs Attention ONLY", () => {
    // Spec block 2 owns "high priority". It previously drew in Today's Agenda,
    // Upcoming Tasks AND High Priority simultaneously.
    const model = build({
      tasks: [{ id: "t1", title: "Ship the thing", status: "todo", priority: "high", dueDate: TODAY }],
    });
    const appearances = model.items.filter(i => i.id === "t1");
    expect(appearances).toHaveLength(1);
    expect(appearances[0].bucket).toBe("attention");
    expect(model.buckets.today).toHaveLength(0);
  });

  it("puts a normal task due today in Today ONLY", () => {
    const model = build({
      tasks: [{ id: "t1", title: "Water plants", status: "todo", priority: "low", dueDate: TODAY }],
    });
    expect(model.items.filter(i => i.id === "t1")).toHaveLength(1);
    expect(model.buckets.today[0].key).toBe("task:t1");
    expect(model.buckets.attention).toHaveLength(0);
  });

  it("renders an overdue high-priority task ONCE, as critical", () => {
    const model = build({
      tasks: [{ id: "t1", title: "Late thing", status: "todo", priority: "urgent", dueDate: d(-3) }],
    });
    expect(model.items.filter(i => i.id === "t1")).toHaveLength(1);
    expect(model.buckets.attention).toHaveLength(1);
    expect(model.buckets.attention[0].severity).toBe("critical");
    expect(model.buckets.next14).toHaveLength(0);
  });

  it("renders a birthday inside 14 days ONCE (was Birthdays + Calendar·14d)", () => {
    const model = build({
      timeline: [{ id: `event-e1-${d(5)}`, sourceId: "e1", type: "event", title: "Mom's birthday 🎂", date: d(5) }],
    });
    expect(model.items.filter(i => i.id === "e1")).toHaveLength(1);
    expect(model.buckets.next14).toHaveLength(1);
  });

  it("splits bills by urgency: past due to Attention, due soon to Money", () => {
    const model = build({
      bills: [
        { id: "b1", name: "Rent", amount: 1800, status: "overdue", daysUntil: -2 },
        { id: "b2", name: "Internet", amount: 60, daysUntil: 9 },
      ],
    });
    expect(model.buckets.attention.map(i => i.key)).toEqual(["bill:b1"]);
    expect(model.buckets.money.map(i => i.key)).toEqual(["bill:b2"]);
    // Next 14 Days must NOT carry bills — block 5 owns them.
    expect(model.buckets.next14.filter(i => i.kind === "bill")).toHaveLength(0);
  });

  it("never emits a duplicate key across the whole model", () => {
    const model = build({
      tasks: [
        { id: "t1", title: "Overdue+high", status: "todo", priority: "high", dueDate: d(-1) },
        { id: "t2", title: "Due today", status: "todo", priority: "high", dueDate: TODAY },
        { id: "t3", title: "Due in a week", status: "todo", priority: "low", dueDate: d(7) },
        { id: "t4", title: "No due date", status: "todo", priority: "high" },
        { id: "t5", title: "Done", status: "done", dueDate: TODAY },
      ],
      habits: [{ id: "h1", name: "Run", checkins: [] }, { id: "h2", name: "Read", checkins: [{ date: TODAY }] }],
      timeline: [
        { id: `event-e1-${TODAY}`, sourceId: "e1", type: "event", title: "Standup", date: TODAY, time: "09:30" },
        { id: `event-e2-${d(3)}`, sourceId: "e2", type: "event", title: "Dentist appointment", date: d(3) },
        { id: `event-e3-${d(30)}`, sourceId: "e3", type: "event", title: "Trip", date: d(30) },
      ],
      bills: [
        { id: "b1", name: "Rent", amount: 1800, status: "overdue", daysUntil: -2 },
        { id: "b2", name: "Internet", amount: 60, daysUntil: 5 },
      ],
      expiringDocs: [
        { documentId: "dc1", documentName: "Passport", daysUntil: 12 },
        { documentId: "dc2", documentName: "Warranty", daysUntil: 60 },
      ],
      goals: [{ id: "g1", title: "Save $5k", status: "active", target: 5000, current: 1200 }],
      trackers: [{ id: "tr1", name: "Weight", fields: [{ name: "kg", type: "number" }], entries: [] }],
      reminders: [{ id: "r1", title: "Call bank", fireAt: `${d(-1)}T10:00:00Z` }],
    });

    const keys = model.items.map(i => i.key);
    expect(new Set(keys).size).toBe(keys.length);

    // The sum of the blocks is the whole model — nothing rendered twice,
    // nothing silently dropped.
    const bucketTotal = Object.values(model.buckets).reduce((s, b) => s + b.length, 0);
    expect(bucketTotal).toBe(model.items.length);
  });

  it("completed tasks never enter any block", () => {
    const model = build({ tasks: [{ id: "t5", title: "Done", status: "done", dueDate: TODAY }] });
    expect(model.items.filter(i => i.kind === "task")).toHaveLength(0);
  });

  it("drops timeline task/habit/obligation rows in favour of authoritative sources", () => {
    // The timeline carries its own copies of tasks and obligations. Consuming
    // them alongside /api/tasks and the finance snapshot is what made bills
    // show up in "Calendar · Next 14d" as well as "Bills & Obligations".
    const model = build({
      tasks: [{ id: "t1", title: "Real task", status: "todo", dueDate: TODAY }],
      bills: [{ id: "b1", name: "Real bill", amount: 10, daysUntil: 3 }],
      timeline: [
        { id: "task-t1", sourceId: "t1", type: "task", title: "Shadow task", date: TODAY },
        { id: "obligation-b1", sourceId: "b1", type: "obligation", title: "Shadow bill", date: d(3) },
      ],
    });
    expect(model.items.map(i => i.title).sort()).toEqual(["Real bill", "Real task"]);
  });
});

describe("the two spec overlaps, resolved", () => {
  it("habits live in Today, never in Needs Attention", () => {
    // The spec lists "habits due" under both. Needs Attention is the only red
    // on screen; filling it with a routine every morning is the noise this
    // redesign removes, and Today's progress bar needs the habits.
    const model = build({ habits: [{ id: "h1", name: "Run", checkins: [] }] });
    expect(model.buckets.attention).toHaveLength(0);
    expect(model.buckets.today.map(i => i.key)).toEqual(["habit:h1"]);
  });

  it("streak chips are aggregates, not copies of the Today habit rows", () => {
    // Block 6 shows streaks for the same habits block 3 lists. They must not be
    // pushed as items, or the dedup guarantee would be violated.
    const model = build({
      habits: [
        { id: "h1", name: "Run", currentStreak: 12, checkins: [] },
        { id: "h2", name: "Read", currentStreak: 3, checkins: [{ date: TODAY }] },
      ],
    });
    expect(model.items.filter(i => i.kind === "habit")).toHaveLength(2);
    expect(model.buckets.habits.filter(i => i.kind === "habit")).toHaveLength(0);
    expect(model.habits.streaks.map(s => s.name)).toEqual(["Run", "Read"]); // sorted by streak
    expect(model.habits.doneToday).toBe(1);
    expect(model.habits.total).toBe(2);
  });

  it("block 6 carries trackers, which are a different entity", () => {
    const model = build({
      trackers: [{ id: "tr1", name: "Weight", fields: [{ name: "kg", type: "number" }], entries: [] }],
    });
    expect(model.buckets.habits.map(i => i.key)).toEqual(["tracker:tr1"]);
    expect(model.buckets.habits[0].done).toBe(false);
  });
});

describe("render rules", () => {
  it("reports every empty hide-at-zero block in the All clear line", () => {
    const model = build({});
    expect(model.allClear).toEqual(HIDES_AT_ZERO.map(b => BLOCK_LABELS[b]));
  });

  it("drops a block from All clear once it has content", () => {
    const model = build({ goals: [{ id: "g1", title: "Save", status: "active" }] });
    expect(model.allClear).not.toContain("Open Projects");
    expect(model.counts.projects).toBe(1);
  });

  it("keeps Habits out of All clear when habits exist but no trackers do", () => {
    // The habit ROWS render in Today, so block 6 still has streak chips to show
    // even though its item bucket is empty.
    const model = build({ habits: [{ id: "h1", name: "Run", checkins: [] }] });
    expect(model.counts.habits).toBe(0);
    expect(model.allClear).not.toContain("Habits & Trackers");
  });
});

describe("Pulse and Money aggregates", () => {
  it("computes net worth and cash flow from the server snapshot figures", () => {
    const model = build({
      finance: { assets: 412_000, liabilities: 180_000, monthlyIncome: 6000, monthlySpend: 2200, monthlyObligations: 1800 },
    });
    expect(model.pulse.netWorth).toBe(232_000);
    expect(model.pulse.cashFlow).toBe(2000);
    expect(model.money.monthlyOut).toBe(4000);
    expect(model.money.balanceLine).toBe("$412k in assets against $180k owed");
  });

  it("reports wellness as today's habit completion, not an invented score", () => {
    const model = build({
      habits: [
        { id: "h1", name: "Run", checkins: [] },
        { id: "h2", name: "Read", checkins: [{ date: TODAY }] },
      ],
    });
    expect(model.pulse.wellness).toBe("1/2");
    expect(model.pulse.wellnessSub).toBe("1 left today");
  });

  it("distinguishes 'no habits yet' from 'all done today'", () => {
    expect(build({}).pulse.wellness).toBe("—");
    expect(build({}).pulse.wellnessSub).toBe("No habits yet");
    const allDone = build({ habits: [{ id: "h1", name: "Run", checkins: [{ date: TODAY }] }] });
    expect(allDone.pulse.wellnessSub).toBe("All done today");
  });

  it("takes the streak from the best of habits, trackers and journal", () => {
    const model = build({
      habits: [{ id: "h1", name: "Run", currentStreak: 4, checkins: [] }],
      streaks: [{ name: "Meditation", days: 12 }],
      journalStreak: 7,
    });
    expect(model.pulse.streak).toBe(12);
    expect(model.pulse.streakSub).toBe("Best: Meditation");
  });
});

describe("the synthesis line (block 3, replacing the standalone AI brief)", () => {
  it("leads with what is critical when anything is", () => {
    const model = build({
      tasks: [{ id: "t1", title: "File taxes", status: "todo", dueDate: d(-2) }],
    });
    expect(model.synthesis).toContain("File taxes");
  });

  it("otherwise names the next timed thing", () => {
    const model = build({
      timeline: [{ id: `event-e1-${TODAY}`, sourceId: "e1", type: "event", title: "Standup", date: TODAY, time: "14:30" }],
    });
    expect(model.synthesis).toBe("Next up: Standup at 14:30.");
  });

  it("says so plainly when the day is empty", () => {
    expect(build({}).synthesis).toBe("Nothing scheduled today — a good day to get ahead.");
  });
});

describe("robustness", () => {
  it("survives null/undefined query results without throwing", () => {
    const model = buildBriefingModel({
      ...base,
      tasks: null as any, habits: undefined as any, timeline: null as any,
      bills: undefined as any, expiringDocs: null as any, trackers: null as any,
      finance: undefined as any, streaks: null as any,
    });
    expect(model.items).toEqual([]);
    expect(model.pulse.netWorth).toBe(0);
    expect(model.counts.today).toBe(0);
  });
});
