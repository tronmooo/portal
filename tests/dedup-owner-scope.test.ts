// tests/dedup-owner-scope.test.ts — ownership is part of a record's identity.
//
// "Sarah Miller and I both ran two miles" produces the same numbers twice, and
// those are TWO entries — one per person — not one logged twice. The same rule
// holds for expenses ("we each spent $12 on lunch"), events (two people's
// dentist appointments on the same day), and tasks (Sarah's "Call the dentist"
// is not Self's). The duplicate guards used to match on value alone; these
// tests pin the owner-scoped keys so the fix (commits a96453a / 1e9cad7 for
// trackers, and the expense/event/task fixes alongside this file) can't
// silently regress.
//
// Drives the REAL executeTool dispatcher against an in-memory storage double,
// same pattern as tests/ai-mark-done-routing.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";

const SELF = { id: "p-self", name: "Robert", type: "self" };
const SARAH = { id: "p-sarah", name: "Sarah Miller", type: "person" };
const BOB = { id: "p-bob", name: "Bob Smith", type: "person" };

type Entry = { id: string; values: Record<string, any>; profileId?: string | null; timestamp: string };
type Tracker = { id: string; name: string; linkedProfiles: string[]; fields: any[]; unit?: string; entries: Entry[] };

const db: {
  trackers: Tracker[];
  expenses: any[];
  events: any[];
  tasks: any[];
} = { trackers: [], expenses: [], events: [], tasks: [] };

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

function reseed() {
  db.trackers = [
    // ONE shared Running tracker both people resolve to — the exact shape of
    // the 2026-08-24 regression: both logs land on the same tracker, and the
    // 2-minute near-identical-entry window must tell the two people apart.
    {
      id: "tr-run",
      name: "Running",
      linkedProfiles: [SELF.id, SARAH.id],
      fields: [{ name: "distance", type: "number", unit: "mi" }],
      unit: "mi",
      entries: [],
    },
  ];
  db.expenses = [];
  db.events = [];
  db.tasks = [];
}

vi.mock("../server/storage", () => ({
  storage: {
    getProfiles: async () => [SELF, SARAH, BOB],
    getProfile: async (id: string) => [SELF, SARAH, BOB].find(p => p.id === id),
    getTrackers: async () => db.trackers,
    getTracker: async (id: string) => db.trackers.find(t => t.id === id),
    updateTracker: async (id: string, patch: any) => {
      const t = db.trackers.find(x => x.id === id);
      if (!t) return undefined;
      Object.assign(t, patch);
      return t;
    },
    logEntry: async (data: any) => {
      const t = db.trackers.find(x => x.id === data.trackerId);
      if (!t) return undefined;
      const entry: Entry = {
        id: nextId("e"),
        values: data.values,
        profileId: data.profileId ?? null,
        timestamp: data.timestamp || new Date().toISOString(),
      };
      t.entries.push(entry);
      return entry;
    },
    getExpenses: async () => db.expenses,
    createExpense: async (data: any) => {
      const row = { id: nextId("x"), createdAt: new Date().toISOString(), linkedProfiles: [], ...data };
      db.expenses.push(row);
      return row;
    },
    getEvents: async () => db.events,
    createEvent: async (data: any) => {
      const row = { id: nextId("ev"), linkedProfiles: [], ...data };
      db.events.push(row);
      return row;
    },
    getTasks: async () => db.tasks,
    createTask: async (data: any) => {
      const row = { id: nextId("t"), status: "open", linkedProfiles: [], ...data };
      db.tasks.push(row);
      return row;
    },
    linkProfileTo: async () => undefined,
    getHabits: async () => [],
    getGoals: async () => [],
    getObligations: async () => [],
    getMemories: async () => [],
    getDocuments: async () => [],
    getJournalEntries: async () => [],
    getNotes: async () => [],
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

// The engine keeps a per-user in-memory creation lock that outlives each test
// (module state). Every test uses its own userId so one test's lock can never
// mask what another test is measuring.
let userSeq = 0;
const freshUser = () => `u-${++userSeq}`;

describe("tracker entries — the 2-minute window is per person (commit 1e9cad7)", () => {
  it('"Sarah and I both ran two miles": identical values, two owners, TWO entries', async () => {
    const msg = "Sarah Miller and I both ran two miles";
    const r1 = await executeTool("log_tracker_entry", {
      trackerName: "Running", values: { distance: 2 }, forProfile: "Robert", __userMessage: msg,
    }, freshUser());
    expect(r1?.error, JSON.stringify(r1)).toBeUndefined();

    const r2 = await executeTool("log_tracker_entry", {
      trackerName: "Running", values: { distance: 2 }, forProfile: "Sarah Miller", __userMessage: msg,
    }, freshUser());
    expect(r2?.error, JSON.stringify(r2)).toBeUndefined();

    const entries = db.trackers[0].entries;
    expect(entries).toHaveLength(2);
    const owners = entries.map(e => e.profileId).sort();
    expect(owners).toEqual([SARAH.id, SELF.id].sort());
    for (const e of entries) expect(e.values.distance).toBe(2);
  });

  it("the SAME person logging identical values twice is still deduped", async () => {
    // The run enrichment fills ESTIMATED steps/duration/calories that shift as
    // history accrues; the dedup window must compare explicit values only, or
    // the drifting estimates make every repeat look like a new entry.
    const u = freshUser();
    await executeTool("log_tracker_entry", {
      trackerName: "Running", values: { distance: 2 }, forProfile: "Sarah Miller", __userMessage: "Sarah ran 2 miles",
    }, u);
    const r2 = await executeTool("log_tracker_entry", {
      trackerName: "Running", values: { distance: 2 }, forProfile: "Sarah Miller", __userMessage: "Sarah ran 2 miles",
    }, u);
    expect(r2?.error).toBeUndefined();
    expect(db.trackers[0].entries).toHaveLength(1);
  });
});

describe("expenses — dedup key includes the owner", () => {
  it('"Sarah and I each spent $12 on lunch": two owners, TWO expenses', async () => {
    const msg = "Sarah and I each spent $12 on lunch";
    const r1 = await executeTool("create_expense", {
      description: "Lunch", amount: 12, __userMessage: msg,
    }, freshUser());
    expect(r1?.error, JSON.stringify(r1)).toBeUndefined();

    const r2 = await executeTool("create_expense", {
      description: "Lunch", amount: 12, forProfile: "Sarah Miller", __userMessage: msg,
    }, freshUser());
    expect(r2?.error, JSON.stringify(r2)).toBeUndefined();
    expect(r2?.deduped).toBeUndefined();

    expect(db.expenses).toHaveLength(2);
    const owners = db.expenses.map(e => (e.linkedProfiles || []).join(","));
    expect(owners).toContain("");
    expect(owners).toContain(SARAH.id);
  });

  it("the SAME owner's identical expense within the window is still deduped", async () => {
    await executeTool("create_expense", {
      description: "Lunch", amount: 12, forProfile: "Sarah Miller", __userMessage: "Sarah spent $12 on lunch",
    }, freshUser());
    // A different request (fresh user bypasses the in-memory lock) hits the
    // 2-minute database window — same value, same owner → deduped.
    const r2 = await executeTool("create_expense", {
      description: "Lunch", amount: 12, forProfile: "Sarah Miller", __userMessage: "Sarah spent $12 on lunch",
    }, freshUser());
    expect(r2?.deduped).toBe(true);
    expect(db.expenses).toHaveLength(1);
  });
});

describe("events — same title + date for two people is two events", () => {
  it("Sarah's and Bob's dentist appointments on the same Tuesday both exist", async () => {
    const msg = "Sarah's and Bob's dentist appointments are both on Tuesday";
    const r1 = await executeTool("create_event", {
      title: "Dentist appointment", date: "2026-08-25", forProfile: "Sarah Miller", __userMessage: msg,
    }, freshUser());
    expect(r1?.error, JSON.stringify(r1)).toBeUndefined();

    const r2 = await executeTool("create_event", {
      title: "Dentist appointment", date: "2026-08-25", forProfile: "Bob Smith", __userMessage: msg,
    }, freshUser());
    expect(r2?.error, JSON.stringify(r2)).toBeUndefined();

    expect(db.events).toHaveLength(2);
    const owners = db.events.map(e => (e.linkedProfiles || [])[0]).sort();
    expect(owners).toEqual([BOB.id, SARAH.id].sort());
  });

  it("the SAME person's identical event is still deduped", async () => {
    await executeTool("create_event", {
      title: "Team picnic", date: "2026-08-30", forProfile: "Sarah Miller", __userMessage: "Sarah's team picnic Aug 30",
    }, freshUser());
    const r2 = await executeTool("create_event", {
      title: "Team picnic", date: "2026-08-30", forProfile: "Sarah Miller", __userMessage: "Sarah's team picnic Aug 30",
    }, freshUser());
    expect(r2?.error).toBeUndefined();
    expect(db.events).toHaveLength(1);
  });
});

describe("tasks — an unowned task is Self's, not a wildcard", () => {
  it("a task for Sarah is NOT swallowed by Self's unowned task of the same name", async () => {
    db.tasks.push({ id: "t-dentist", title: "Call the dentist", status: "open", linkedProfiles: [] });
    const res = await executeTool("create_task", {
      title: "Call the dentist", forProfile: "Sarah Miller", __userMessage: "Add a task for Sarah to call the dentist",
    }, freshUser());
    expect(res?.error, JSON.stringify(res)).toBeUndefined();
    expect(res?.deduped).toBeUndefined();
    expect(db.tasks).toHaveLength(2);
  });

  it("an unowned duplicate of an unowned task is still deduped", async () => {
    db.tasks.push({ id: "t-dentist", title: "Call the dentist", status: "open", linkedProfiles: [] });
    const res = await executeTool("create_task", {
      title: "Call the dentist", __userMessage: "Remind me to call the dentist",
    }, freshUser());
    expect(res?.deduped).toBe(true);
    expect(db.tasks).toHaveLength(1);
  });

  it("a duplicate FOR the same person is still deduped", async () => {
    db.tasks.push({ id: "t-groom", title: "Get Max groomed", status: "open", linkedProfiles: [SARAH.id] });
    const res = await executeTool("create_task", {
      title: "Get Max groomed", forProfile: "Sarah Miller", __userMessage: "Add a task for Sarah to get Max groomed",
    }, freshUser());
    expect(res?.deduped).toBe(true);
    expect(db.tasks).toHaveLength(1);
  });
});
