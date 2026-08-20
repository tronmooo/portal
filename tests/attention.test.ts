// tests/attention.test.ts — the Executive tab's attention model.
//
// Every case below is a bug from the 2026-07-29 report, pinned so it can't come
// back. The screenshots showed 22 "items needing attention" of which 6 were the
// same three records counted twice, 8 were month-old medication reminders, and
// 7 were routine morning habits.

import { describe, it, expect } from "vitest";
import {
  computeAttention,
  normalizeReminderTitle,
  DEFAULT_ATTENTION_CONFIG,
} from "../shared/attention";

const TODAY = "2026-07-29";
const NOW = new Date("2026-07-29T09:58:00");

/** Days before/after TODAY as a YYYY-MM-DD string. */
function day(offset: number): string {
  const d = new Date(`${TODAY}T12:00:00`);
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("en-CA");
}

function run(input: any, cfg?: any) {
  return computeAttention({ now: NOW, today: TODAY, ...input }, cfg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplication — the headline bug
// ─────────────────────────────────────────────────────────────────────────────
describe("one record, one row", () => {
  it("collapses an overdue task and the notification derived from it", () => {
    // notification-service.ts synthesizes this alert FROM the same task row.
    const { items } = run({
      tasks: [{ id: "t1", title: "[QA-TASK] chat-created", status: "todo", dueDate: day(-1) }],
      notifications: [{
        id: "task-overdue-t1", type: "task_overdue", severity: "critical",
        title: "Overdue: [QA-TASK] chat-created", message: "Was due 1 day ago",
        entityId: "t1", entityType: "task", dueDate: day(-1),
      }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("task");
    // The task's own wording wins, not the alert's "Overdue: " restatement.
    expect(items[0].title).toBe("[QA-TASK] chat-created");
  });

  it("collapses an overdue bill and its alert, across the bill/obligation naming split", () => {
    // The panel keyed bills as `bill-<id>` while notifications say
    // entityType "obligation" — same row, two strings, hence two cards.
    const { items } = run({
      bills: [{ id: "b1", name: "Electric bill", amount: 140, daysUntil: -3, status: "overdue" }],
      notifications: [{
        id: "bill-overdue-b1", type: "bill_due", severity: "critical",
        title: "Overdue bill: Electric bill", message: "$140.00 was due 3 days ago",
        entityId: "b1", entityType: "obligation", dueDate: day(-3),
      }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("bill");
    expect(items[0].reason).toBe("$140 overdue");
  });

  it("reproduces the reported screen: 3 records, 3 rows — not 6", () => {
    const { items } = run({
      tasks: [{ id: "t1", title: "[QA-TASK] chat-created", status: "todo", dueDate: day(-1) }],
      bills: [
        { id: "b1", name: "Verizon Phone Bill payment", amount: 86.5, daysUntil: -3, status: "overdue" },
        { id: "b2", name: "Electric bill", amount: 140, daysUntil: -3, status: "overdue" },
      ],
      notifications: [
        { id: "n1", severity: "critical", title: "Overdue: [QA-TASK] chat-created", entityId: "t1", entityType: "task" },
        { id: "n2", severity: "critical", title: "Overdue bill: Electric bill", entityId: "b2", entityType: "obligation" },
        { id: "n3", severity: "critical", title: "Overdue bill: Verizon Phone Bill payment", entityId: "b1", entityType: "obligation" },
      ],
    });
    expect(items).toHaveLength(3);
    expect(items.filter(i => i.kind === "alert")).toHaveLength(0);
  });

  it("keeps an alert that has no other representation", () => {
    // Profile-field expirations and custom/AI-raised items are only ever
    // notifications — dropping every alert would lose them.
    const { items } = run({
      notifications: [
        { id: "custom:1", type: "custom", severity: "critical", title: "Two profiles share one VIN", message: "Resolve the conflict" },
        { id: "profile-exp-p1-license", type: "document_expiring", severity: "critical", title: "License expiring", entityId: "p1", entityType: "profile" },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items.every(i => i.kind === "alert")).toBe(true);
  });

  it("one document with two expiring fields is one row", () => {
    const { items } = run({
      documents: [
        { documentId: "d1", documentName: "Passport", fieldName: "expiration_date", daysUntil: 9 },
        { documentId: "d1", documentName: "Passport", fieldName: "valid_until", daysUntil: 20 },
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe("Expires in 9d");  // the soonest field wins
  });

  it("drops a notification the user already dismissed", () => {
    // The old panel filtered on `n.dismissed`, which buildNotifications never
    // sets, and never read the preference — so dismissals never stuck.
    const { items } = run({
      notifications: [{ id: "custom:1", severity: "critical", title: "Old news" }],
      dismissedNotificationIds: ["custom:1"],
    });
    expect(items).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Timed tasks — what reminders became
//
// The Reminders block was removed on 2026-08-09 with the entity. Everything it
// did — surfacing a scheduled dose or chore, windowed so a month-old one stops
// claiming to be live — is now the Tasks block reading a task's `dueDate` and
// `dueTime`. `normalizeReminderTitle` outlives the entity because the rows the
// AI wrote before the change are still in the database.
// ─────────────────────────────────────────────────────────────────────────────
describe("timed tasks", () => {
  it("says the hour a timed task is due", () => {
    const { items } = run({
      tasks: [{ id: "t1", title: "Take Amoxicillin 500mg", dueDate: "2026-07-29", dueTime: "08:00", priority: "medium" }],
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("task");
    expect(items[0].reason).toBe("Due today \u00B7 8:00 AM");
  });

  it("leaves an all-day task without a phantom time", () => {
    const { items } = run({
      tasks: [{ id: "t1", title: "Buy milk", dueDate: "2026-07-29", priority: "medium" }],
    });
    expect(items[0].reason).toBe("Due today");
  });

  it("still reads the hour on an overdue one", () => {
    const { items } = run({
      tasks: [{ id: "t1", title: "Call the dentist", dueDate: "2026-07-28", dueTime: "17:30", priority: "medium" }],
    });
    expect(items[0].reason).toContain("5:30 PM");
    expect(items[0].tier).toBe("immediate");
  });

  it("normalizeReminderTitle strips only a trailing dose qualifier", () => {
    expect(normalizeReminderTitle("Take Amoxicillin 500mg (Morning Dose)")).toBe("take amoxicillin 500mg");
    expect(normalizeReminderTitle("Take Amoxicillin 500mg (Evening Dose)")).toBe("take amoxicillin 500mg");
    // A parenthetical that isn't a dose is part of the identity.
    expect(normalizeReminderTitle("Pay rent (Oak St)")).toBe("pay rent (oak st)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Habits
// ─────────────────────────────────────────────────────────────────────────────
describe("habits", () => {
  const daily = (id: string, name: string, extra: any = {}) =>
    ({ id, name, frequency: "daily", targetPerDay: 1, checkins: [], ...extra });

  it("rolls seven routine habits into one card", () => {
    const { items } = run({
      habits: ["Brush teeth", "POOP", "Drink Water", "Take Lisinopril", "Stretch Every Morning", "Drink 80 oz of Water", "Take Creatine"]
        .map((n, i) => daily(`h${i}`, n)),
    });
    expect(items).toHaveLength(1);
    expect(items[0].count).toBe(7);
    expect(items[0].title).toBe("7 habits still due today");
    expect(items[0].children).toHaveLength(7);
  });

  it("promotes a habit whose streak breaks today", () => {
    const { items } = run({
      habits: [daily("h1", "Stretch", { currentStreak: 12 }), daily("h2", "Brush teeth")],
    });
    const promoted = items.find(i => i.title === "Stretch")!;
    expect(promoted.tier).toBe("immediate");
    expect(promoted.reason).toBe("12-day streak breaks today");
    // The remaining routine habit still rolls up separately.
    expect(items.find(i => i.key === "habits:today")?.count).toBe(1);
  });

  it("does not count a weekly habit on a day it isn't scheduled", () => {
    // 2026-07-29 is a Wednesday (3). In production NOTHING applied the
    // frequency rule, so a Monday-only habit was reported as due every day.
    const { items } = run({
      habits: [{ id: "h1", name: "Weigh in", frequency: "weekly", targetDays: [1], targetPerDay: 1, checkins: [] }],
    });
    expect(items).toHaveLength(0);
  });

  it("respects targetPerDay before calling a habit done", () => {
    const partly = { id: "h1", name: "Brush teeth", frequency: "daily", targetPerDay: 3, checkins: [{ date: TODAY }] };
    expect(run({ habits: [partly] }).items).toHaveLength(1);
    const finished = { ...partly, checkins: [{ date: TODAY }, { date: TODAY }, { date: TODAY }] };
    expect(run({ habits: [finished] }).items).toHaveLength(0);
  });

  it("never outranks a real deadline", () => {
    const { items } = run({
      habits: [daily("h1", "Brush teeth")],
      bills: [{ id: "b1", name: "Electric bill", amount: 140, daysUntil: -3 }],
    });
    expect(items[0].kind).toBe("bill");
  });

  it("can be switched off entirely", () => {
    const { items } = run({ habits: [daily("h1", "Brush teeth")] }, { includeHabits: false });
    expect(items).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tiers and the threshold
// ─────────────────────────────────────────────────────────────────────────────
describe("tiers and threshold", () => {
  it("tiers by proximity", () => {
    const { items } = run({
      bills: [
        { id: "b1", name: "Overdue", amount: 100, daysUntil: -2 },
        { id: "b2", name: "This week", amount: 100, daysUntil: 4 },
        { id: "b3", name: "Later", amount: 500, daysUntil: 20 },
      ],
    });
    const byName = Object.fromEntries(items.map(i => [i.title, i.tier]));
    expect(byName).toEqual({ Overdue: "immediate", "This week": "soon", Later: "upcoming" });
  });

  it("suppresses a small bill 20 days out but keeps a large one", () => {
    const { items, suppressed } = run({
      bills: [
        { id: "b1", name: "Netflix", amount: 9, daysUntil: 20 },
        { id: "b2", name: "Rent", amount: 2500, daysUntil: 20 },
      ],
    });
    expect(items.map(i => i.title)).toEqual(["Rent"]);
    expect(suppressed).toBe(1);
  });

  it("keeps a passport 20 days out but not a warranty card", () => {
    const { items } = run({
      documents: [
        { documentId: "d1", documentName: "Passport", daysUntil: 20 },
        { documentId: "d2", documentName: "Blender warranty", daysUntil: 20 },
      ],
    });
    expect(items.map(i => i.title)).toEqual(["Passport"]);
  });

  it("minTier trims the feed to what's urgent", () => {
    const input = {
      bills: [
        { id: "b1", name: "Overdue", amount: 100, daysUntil: -2 },
        { id: "b2", name: "This week", amount: 100, daysUntil: 4 },
      ],
    };
    expect(run(input, { minTier: "immediate" }).items.map(i => i.title)).toEqual(["Overdue"]);
    expect(run(input, { minTier: "soon" }).items).toHaveLength(2);
  });

  it("honors the per-kind day windows", () => {
    expect(run({ documents: [{ documentId: "d1", documentName: "Passport", daysUntil: 40 }] }).items).toHaveLength(0);
    expect(run({ documents: [{ documentId: "d1", documentName: "Passport", daysUntil: 40 }] }, { docsWithinDays: 60 }).items).toHaveLength(1);
  });

  it("ranks overdue above due-today above due-later", () => {
    const { items } = run({
      tasks: [
        { id: "t1", title: "Later", status: "todo", dueDate: day(3) },
        { id: "t2", title: "Overdue", status: "todo", dueDate: day(-5) },
        { id: "t3", title: "Today", status: "todo", dueDate: TODAY },
      ],
    });
    expect(items.map(i => i.title)).toEqual(["Overdue", "Today", "Later"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Counts, events, and the shape of the result
// ─────────────────────────────────────────────────────────────────────────────
describe("counts and the rest", () => {
  it("counts what it actually returns, with no per-group cap", () => {
    // The old headline summed arrays that had already been sliced to 10/12/6/8,
    // so 14 overdue tasks were reported as 10.
    const tasks = Array.from({ length: 14 }, (_, i) => ({
      id: `t${i}`, title: `Task ${i}`, status: "todo", dueDate: day(-1),
    }));
    const { items, counts } = run({ tasks });
    expect(items).toHaveLength(14);
    expect(counts.immediate).toBe(14);
    expect(counts.immediate + counts.soon + counts.upcoming).toBe(items.length);
  });

  it("shows a timed event still ahead today, and hides one that has passed", () => {
    const { items } = run({
      events: [
        { id: "e1", type: "event", title: "Dentist", date: TODAY, time: "15:00" },
        { id: "e2", type: "event", title: "Standup", date: TODAY, time: "09:00" },
        { id: "e3", type: "event", title: "Some all-day thing", date: TODAY, allDay: true },
      ],
    });
    expect(items.map(i => i.title)).toEqual(["Dentist"]);
  });

  it("collapses a recurring series to one row", () => {
    // getCalendarTimeline emits one row per occurrence: "Lawn Care" filled the
    // whole Important Dates list with its next seven dates.
    const { items } = run({
      events: [0, 7, 14, 21, 28, 35, 42].map(off => ({
        id: `event-lawn-${day(off)}`, sourceId: "lawn", type: "event",
        title: "Lawn Care", date: day(off), time: "17:00",
      })),
    });
    expect(items).toHaveLength(1);
  });

  it("leaves undated tasks alone — a backlog is not an alert", () => {
    const { items } = run({ tasks: [{ id: "t1", title: "Someday", status: "todo" }] });
    expect(items).toHaveLength(0);
  });

  it("ignores completed tasks and goals", () => {
    const { items } = run({
      tasks: [{ id: "t1", title: "Done", status: "done", dueDate: day(-5) }],
      goals: [{ id: "g1", title: "Done", status: "completed", deadline: day(-5), target: 10, current: 2 }],
    });
    expect(items).toHaveLength(0);
  });

  it("every item can be acted on and links to its source", () => {
    const { items } = run({
      tasks: [{ id: "t1", title: "T", status: "todo", dueDate: day(-1) }],
      bills: [{ id: "b1", name: "B", amount: 100, daysUntil: -1 }],
      documents: [{ documentId: "d1", documentName: "Passport", daysUntil: 2 }],
      habits: [{ id: "h1", name: "H", frequency: "daily", targetPerDay: 1, checkins: [] }],
      reminders: [{ id: "r1", title: "R", fireAt: "2026-07-29T08:00:00" }],
    });
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.href, i.title).toMatch(/^\//);
      expect(i.sourceKey, i.title).toMatch(/^[a-z]+:/);
      expect(i.reason, i.title).toBeTruthy();
    }
    expect(items.find(i => i.kind === "document")!.href).toBe("/documents/d1");
  });

  it("returns an empty, honest result when nothing needs attention", () => {
    const { items, counts, suppressed } = run({});
    expect(items).toEqual([]);
    expect(suppressed).toBe(0);
    expect(counts).toEqual({ immediate: 0, soon: 0, upcoming: 0 });
  });

  it("ships defaults that match the shipped config", () => {
    expect(DEFAULT_ATTENTION_CONFIG.minTier).toBe("upcoming");
  });
});

describe("one expiration, one row on Immediate Attention", () => {
  const today = "2026-08-20";
  const soon = "2026-08-25";

  it("does not raise the alert as well as the date", () => {
    // Rows are identified per DATE now — one record can carry a passport and a
    // licence — but the notifications pass only knows entity ids. Claiming the
    // row's own key alone left the record unclaimed, so notification-service's
    // "Expiring soon" for the SAME licence came back as a second row.
    const items = computeAttention({
      now: new Date(`${today}T09:00:00`), today,
      documents: [{
        documentId: "doc-1", ruleId: "document:doc-1:expirationdate:expiration",
        documentName: "Driver License", fieldName: "expiration_date",
        expirationDate: soon, daysUntil: 5, href: "#/documents/doc-1",
      }],
      notifications: [{
        id: "n-1", entityType: "document", entityId: "doc-1", severity: "warning",
        title: "Driver License expiring soon", dueDate: soon,
      }],
    } as any).items;
    expect(items.filter((i: any) => /driver license/i.test(i.title))).toHaveLength(1);
  });

  it("still shows two different dates on one record", () => {
    const items = computeAttention({
      now: new Date(`${today}T09:00:00`), today,
      documents: [
        { documentId: "p-1", ruleId: "profile:p-1:passportexpiration:expiration",
          documentName: "Jane — Passport Expiration", fieldName: "passportExpiration",
          expirationDate: soon, daysUntil: 5, href: "#/profiles/p-1" },
        { documentId: "p-1", ruleId: "profile:p-1:driverslicenseexpiration:expiration",
          documentName: "Jane — Driver's License Expiration", fieldName: "driversLicenseExpiration",
          expirationDate: "2026-08-27", daysUntil: 7, href: "#/profiles/p-1" },
      ],
    } as any).items;
    expect(items.filter((i: any) => i.kind === "document")).toHaveLength(2);
    // …and each links to the record it actually lives on.
    for (const i of items.filter((x: any) => x.kind === "document")) {
      expect(i.href).toBe("/profiles/p-1");
    }
  });
});
