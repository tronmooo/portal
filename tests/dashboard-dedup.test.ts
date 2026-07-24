// ── Executive tab de-duplication contract ───────────────────────────────────
// The bug this locks down: the briefing's section filters overlapped by
// construction. `upcomingTasks` was `!dueDate || dueDate >= today` — an
// unbounded SUPERSET of both `agendaTasks` (due today) and `highPriority` — so
// a high-priority task due today rendered in three sections at once, plus the
// Today strip, plus the AI brief. Calendar·14d likewise re-rendered Birthdays,
// Appointments and Important Dates wholesale.
//
// buildBriefingModel replaces those filters with a priority cascade over a
// shared `push` that refuses a key it has already seen. These tests assert the
// property that makes the redundancy structurally impossible, not the specific
// section list — so they keep holding if buckets are re-tuned later.
import { describe, it, expect } from "vitest";
import { buildBriefingModel, type BriefingInput } from "../client/src/components/dashboard/useBriefingModel";

const TODAY = "2026-07-24";
const NOW = new Date(`${TODAY}T09:00:00Z`).getTime();
const d = (offset: number) => {
  const x = new Date(`${TODAY}T00:00:00`);
  x.setDate(x.getDate() + offset);
  return x.toLocaleDateString("en-CA");
};

const base: BriefingInput = {
  todayStr: TODAY, nowMs: NOW,
  tasks: [], habits: [], timeline: [], reminders: [], goals: [],
  journal: [], notifications: [], bills: [], expiringDocs: [], activity: [],
};

const build = (over: Partial<BriefingInput>) => buildBriefingModel({ ...base, ...over });

describe("briefing model — every datum lands in exactly one bucket", () => {
  it("renders a high-priority task due today ONCE (was 3 sections + strip)", () => {
    const model = build({
      tasks: [{ id: "t1", title: "Ship the thing", status: "todo", priority: "high", dueDate: TODAY }],
    });
    const appearances = model.items.filter(i => i.id === "t1");
    expect(appearances).toHaveLength(1);
    expect(appearances[0].bucket).toBe("today");
  });

  it("renders an overdue high-priority task ONCE, in attention", () => {
    const model = build({
      tasks: [{ id: "t1", title: "Late thing", status: "todo", priority: "urgent", dueDate: d(-3) }],
    });
    expect(model.items.filter(i => i.id === "t1")).toHaveLength(1);
    expect(model.buckets.attention[0].key).toBe("task:t1");
    expect(model.buckets.open).toHaveLength(0);
    expect(model.buckets.next14).toHaveLength(0);
  });

  it("renders a birthday inside 14 days ONCE (was Birthdays + Calendar·14d)", () => {
    const model = build({
      timeline: [{ id: `event-e1-${d(5)}`, sourceId: "e1", type: "event", title: "Mom's birthday 🎂", date: d(5) }],
    });
    expect(model.items.filter(i => i.id === "e1")).toHaveLength(1);
    expect(model.buckets.next14).toHaveLength(1);
  });

  it("renders an overdue bill ONCE (was Bills + Calendar + AI brief + Attention)", () => {
    const model = build({
      bills: [{ id: "b1", name: "Rent", amount: 1800, status: "overdue", daysUntil: -2, dueDate: d(-2) }],
    });
    expect(model.items.filter(i => i.id === "b1")).toHaveLength(1);
    expect(model.buckets.attention.map(i => i.key)).toEqual(["bill:b1"]);
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
      reminders: [{ id: "r1", title: "Call bank", fireAt: `${d(-1)}T10:00:00Z` }],
      notifications: [{ id: "n1", title: "Card declined", severity: "critical" }],
      journal: [{ id: "j1", content: "Felt good today", date: TODAY }],
      activity: [{ id: "a1", description: "Added a document" }],
    });

    const keys = model.items.map(i => i.key);
    expect(new Set(keys).size).toBe(keys.length);

    // And the sum of the buckets is the whole model — nothing rendered twice,
    // nothing silently dropped.
    const bucketTotal = Object.values(model.buckets).reduce((s, b) => s + b.length, 0);
    expect(bucketTotal).toBe(model.items.length);
  });

  it("completed tasks never enter any bucket", () => {
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

describe("briefing tiles — counts and one headline, never rows", () => {
  it("counts obligations as bills-needing-action plus expiring docs", () => {
    const model = build({
      bills: [
        { id: "b1", name: "Rent", amount: 1800, status: "overdue", daysUntil: -2 },
        { id: "b2", name: "Internet", amount: 60, daysUntil: 5 },
      ],
      expiringDocs: [{ documentId: "dc1", documentName: "Passport", daysUntil: 12 }],
    });
    expect(model.tiles.obligations.value).toBe("3");
    expect(model.tiles.obligations.critical).toBe(true);
  });

  it("reports habit progress as done-of-total", () => {
    const model = build({
      habits: [
        { id: "h1", name: "Run", checkins: [] },
        { id: "h2", name: "Read", checkins: [{ date: TODAY }] },
      ],
    });
    expect(model.tiles.habits.value).toBe("1 of 2");
    expect(model.tiles.habits.sub).toBe("1 remaining today");
  });

  it("distinguishes 'no habits scheduled' from 'all habits done'", () => {
    expect(build({}).tiles.habits.value).toBe("—");
    expect(build({}).tiles.habits.sub).toBe("No habits scheduled");
    const allDone = build({ habits: [{ id: "h1", name: "Run", checkins: [{ date: TODAY }] }] });
    expect(allDone.tiles.habits.sub).toBe("All done today");
  });

  it("survives null/undefined query results without throwing", () => {
    const model = buildBriefingModel({
      ...base,
      tasks: null as any, habits: undefined as any, timeline: null as any,
      bills: undefined as any, expiringDocs: null as any,
    });
    expect(model.items).toEqual([]);
    expect(model.tiles.tasks.value).toBe("0");
  });
});
