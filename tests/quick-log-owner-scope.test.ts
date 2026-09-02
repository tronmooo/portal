// "ran 2 miles" must land in the USER'S Running tracker — never another
// profile's same-named one.
//
// Regression source (2026-09-01): the user had three "Running" trackers
// (their own, and one each for two people they track). The chat quick-run
// lane wrote straight to storage against the first tracker named "Running"
// — Sarah's — so the chat said "Logged: 2 mi run" while the user's own
// Running history stayed unchanged. This drives the REAL processMessage
// fast path (no model call) against an in-memory storage seeded that way.
import { describe, it, expect, beforeEach, vi } from "vitest";

const SELF = { id: "p-self", name: "Poop", type: "self", fields: {} };
const SARAH = { id: "p-sarah", name: "Sarah Miller", type: "person", fields: {} };
const JANE = { id: "p-jane", name: "Jane QA", type: "person", fields: {} };

const RUN_FIELDS = [
  { name: "distance", type: "number", unit: "mi" },
  { name: "duration", type: "number", unit: "min" },
  { name: "steps", type: "number", unit: "steps" },
  { name: "caloriesBurned", type: "number", unit: "kcal" },
];

type Tracker = { id: string; name: string; category: string; unit: string; fields: any[]; linkedProfiles: string[]; entries: any[] };
const db: { trackers: Tracker[]; entries: any[]; log: any[] } = { trackers: [], entries: [], log: [] };

function reseed() {
  db.entries = [];
  db.log = [];
  // Newest first — exactly the order that made the old lane pick Sarah's.
  db.trackers = [
    { id: "t-run-sarah", name: "Running", category: "fitness", unit: "mi", fields: RUN_FIELDS, linkedProfiles: [SARAH.id], entries: [] },
    { id: "t-run-jane", name: "Running", category: "fitness", unit: "mi", fields: RUN_FIELDS, linkedProfiles: [JANE.id], entries: [] },
    { id: "t-run-self", name: "Running", category: "fitness", unit: "mi", fields: RUN_FIELDS, linkedProfiles: [SELF.id], entries: [] },
    { id: "t-sleep-sarah", name: "Sleep", category: "health", unit: "hrs", fields: [{ name: "hours", type: "number", unit: "hrs" }], linkedProfiles: [SARAH.id], entries: [] },
  ];
}

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF, SARAH, JANE],
    getSelfProfile: async () => SELF,
    getTrackers: async () => db.trackers.map((t) => ({ ...t, entries: db.entries.filter((e) => e.trackerId === t.id) })),
    getTracker: async (id: string) => {
      const t = db.trackers.find((x) => x.id === id);
      return t ? { ...t, entries: db.entries.filter((e) => e.trackerId === t.id) } : undefined;
    },
    getTrackerEntry: async (id: string) => db.entries.find((e) => e.id === id),
    logEntry: async (data: any) => {
      const entry = {
        id: `e${db.entries.length + 1}`, trackerId: data.trackerId, values: data.values,
        profileId: data.profileId || null, forProfile: data.forProfile || null,
        timestamp: data.timestamp || new Date().toISOString(), computed: {},
      };
      db.entries.push(entry);
      return entry;
    },
    createTracker: async (data: any) => {
      const t = { id: `t-new-${db.trackers.length + 1}`, entries: [], linkedProfiles: [], ...data };
      db.trackers.push(t);
      return t;
    },
    updateTracker: async (id: string, patch: any) => {
      const t = db.trackers.find((x) => x.id === id);
      if (!t) return undefined;
      Object.assign(t, patch);
      return { ...t, entries: db.entries.filter((e) => e.trackerId === t.id) };
    },
    createAiActionLog: async (row: any) => { db.log.push(row); return { id: `log${db.log.length}`, ...row }; },
    getPreference: async () => null,
    getMemories: async () => [],
    saveMemory: async () => undefined,
    getGoals: async () => [],
    getHabits: async () => [],
    getTasks: async () => [],
    getExpenses: async () => [],
    getEvents: async () => [],
    getObligations: async () => [],
    getDocuments: async () => [],
    getJournalEntries: async () => [],
    getIncomes: async () => [],
  };
  // Anything else the engine touches on the way is a no-op list read.
  const storage = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return async () => [];
    },
  });
  return { storage };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => { throw new Error("model must not be called for a quick-log message"); },
      stream: () => { throw new Error("model must not be called for a quick-log message"); },
    };
  },
}));

let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ processMessage } = await import("../server/ai-engine"));
});

describe("quick-log lanes resolve the tracker by OWNER, not by first name match", () => {
  it('"ran 2 miles" lands in the user\'s own Running tracker (the reported failure)', async () => {
    const res = await processMessage("ran 2 miles", [], "u1");
    expect(res.reply).toMatch(/^Logged: 2 mi run/);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].trackerId).toBe("t-run-self");
    expect(db.entries[0].profileId).toBe(SELF.id);
    expect(db.entries[0].values.distance).toBe(2);
    // The reply's card and the client's cache patch point at the right row.
    expect(res.actions[0].data._trackerId).toBe("t-run-self");
    expect(res.mutations?.[0]?.tool).toBe("log_tracker_entry");
    // Nothing went to Sarah or Jane.
    expect(db.entries.some((e) => e.trackerId !== "t-run-self")).toBe(false);
  });

  it('"I ran 2 miles" takes the same lane', async () => {
    const res = await processMessage("I ran 2 miles", [], "u1");
    expect(res.reply).toMatch(/^Logged: 2 mi run/);
    expect(db.entries[0].trackerId).toBe("t-run-self");
  });

  it("a same-named tracker owned by someone else is not 'ambiguous' and never absorbs the log", async () => {
    // Only Sarah has a Sleep tracker → the user gets their OWN, not hers.
    const res = await processMessage("slept 7 hours", [], "u1");
    expect(res.reply).toMatch(/^Logged sleep: 7 hours/);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].trackerId).not.toBe("t-sleep-sarah");
    const owner = db.trackers.find((t) => t.id === db.entries[0].trackerId)!;
    expect(owner.linkedProfiles).toContain(SELF.id);
  });

  it("the write is recorded in the undo ledger like a model-path write", async () => {
    await processMessage("ran 2 miles", [], "u1");
    expect(db.log.some((r) => (r.tool || r.tool_name) === "log_tracker_entry")).toBe(true);
  });
});
