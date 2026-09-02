// The chat must be able to act on ANY request — anyone, anywhere, anything.
//
// Two pre-execution gates used to refuse a tool call because a regex read of
// the user's prose disagreed with the model's choice: the entity gate
// (checkToolAgainstIntent) and the note/journal/task gate
// (checkContentRouting). Both refused real work — the 2026-09-01 report lost
// seven tracker logs to the entity gate because one clause said "create a
// task" — and a parser cannot enumerate what a person may ask for. They no
// longer refuse anything; they only observe.
//
// What DOES still refuse is turn-scoped fact, not interpretation: replaying a
// request from an older message, and creating the same record twice in one
// turn. Those are pinned here too, because "no vetoes on intent" must not
// quietly become "no protection against fan-out".
import { describe, it, expect, beforeEach, vi } from "vitest";

// getClient() refuses to construct without a key; the SDK itself is mocked below.
process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const SELF = { id: "p-self", name: "Poop", type: "self", fields: {} };
const SARAH = { id: "p-sarah", name: "Sarah Miller", type: "person", fields: {} };
const ROBERT = { id: "p-rob", name: "Robert", type: "person", fields: {} };

type Row = Record<string, any>;
const db: { trackers: Row[]; entries: Row[]; tasks: Row[]; events: Row[]; expenses: Row[]; notes: Row[] } = {
  trackers: [], entries: [], tasks: [], events: [], expenses: [], notes: [],
};

function reseed() {
  db.entries = []; db.tasks = []; db.events = []; db.expenses = []; db.notes = [];
  db.trackers = [
    { id: "t-run", name: "Running", category: "fitness", unit: "mi", linkedProfiles: [SELF.id], entries: [],
      fields: [{ name: "distance", type: "number", unit: "mi" }, { name: "duration", type: "number", unit: "min" }] },
    { id: "t-spend", name: "Spending", category: "finance", unit: "$", linkedProfiles: [SELF.id], entries: [],
      fields: [{ name: "amount", type: "number", unit: "$" }] },
  ];
}

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF, SARAH, ROBERT],
    getSelfProfile: async () => SELF,
    getTrackers: async () => db.trackers.map((t) => ({ ...t, entries: db.entries.filter((e) => e.trackerId === t.id) })),
    getTracker: async (id: string) => {
      const t = db.trackers.find((x) => x.id === id);
      return t ? { ...t, entries: db.entries.filter((e) => e.trackerId === t.id) } : undefined;
    },
    getTrackerEntry: async (id: string) => db.entries.find((e) => e.id === id),
    logEntry: async (data: Row) => {
      const entry = { id: `e${db.entries.length + 1}`, trackerId: data.trackerId, values: data.values,
        profileId: data.profileId || null, timestamp: data.timestamp || new Date().toISOString(), computed: {} };
      db.entries.push(entry); return entry;
    },
    createTracker: async (data: Row) => { const t = { id: `t-new-${db.trackers.length + 1}`, entries: [], linkedProfiles: [], ...data }; db.trackers.push(t); return t; },
    updateTracker: async (id: string, patch: Row) => { const t = db.trackers.find((x) => x.id === id); if (t) Object.assign(t, patch); return t; },
    getTasks: async () => db.tasks,
    getTask: async (id: string) => db.tasks.find((t) => t.id === id),
    createTask: async (data: Row) => { const t = { id: `task${db.tasks.length + 1}`, ...data }; db.tasks.push(t); return t; },
    getEvents: async () => db.events,
    getEvent: async (id: string) => db.events.find((e) => e.id === id),
    createEvent: async (data: Row) => { const e = { id: `ev${db.events.length + 1}`, ...data }; db.events.push(e); return e; },
    getExpenses: async () => db.expenses,
    createExpense: async (data: Row) => { const e = { id: `exp${db.expenses.length + 1}`, ...data }; db.expenses.push(e); return e; },
    getPreference: async () => null,
    getMemories: async () => [],
    getHabits: async () => [],
    getGoals: async () => [],
    getObligations: async () => [],
    getDocuments: async () => [],
    getJournalEntries: async () => [],
    getIncomes: async () => [],
  };
  return { storage: new Proxy(impl, { get: (t, p: string) => (p in t ? t[p] : async () => []) }) };
});

/** Scripted model: each entry is one assistant response. */
let script: Array<{ content: any[]; stop_reason?: string }> = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => script.shift() ?? { content: [{ type: "text", text: "" }], stop_reason: "end_turn" },
    };
  },
}));

const use = (name: string, input: Row, id = `tu_${name}_${Math.random().toString(36).slice(2, 7)}`) =>
  ({ type: "tool_use", id, name, input });
const round = (...calls: Row[]) => ({ content: calls, stop_reason: "tool_use" });
const done = (text = "") => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  script = [];
  ({ processMessage } = await import("../server/ai-engine"));
});

/** Operations the turn reported as refused-before-execution. */
const refusals = (res: Row) =>
  (res.operations || []).filter((o: Row) => o.status === "failed" && /didn't match what you asked for|already exists/.test(String(o.error || "")));

describe("no pre-execution veto on parsed intent", () => {
  it("logs the activities AND creates the task (the 2026-09-01 seven-blocked-entries report)", async () => {
    script = [
      round(
        use("log_tracker_entry", { trackerName: "Running", values: { distance: 2, duration: 19 } }),
        use("create_task", { title: "Buy more chicken" }),
      ),
      done("Done."),
    ];
    const res = await processMessage(
      "I ran 2 miles this morning in about 19 minutes. Sarah and I played soccer for 30 minutes. " +
      "I also did 25 push-ups when we got home and create a task one time only to buy more chicken this week.",
      [], "u1",
    );
    expect(refusals(res)).toHaveLength(0);
    expect(db.entries).toHaveLength(1);
    expect(db.entries[0].values.distance).toBe(2);
    expect(db.tasks).toHaveLength(1);
    // Both calls must also be REPORTED as done. A write that lands in the
    // database while the turn reports it failed is the shape of the pushOp
    // recursion this file caught: the row was written, then the operation
    // checklist threw and the whole turn fell back to "AI is temporarily
    // unavailable". Asserting the database alone would have missed it.
    const ops = res.operations || [];
    expect(ops).toHaveLength(2);
    expect(ops.every((o: Row) => o.status === "ok")).toBe(true);
    expect(ops.map((o: Row) => o.tool)).toEqual(["log_tracker_entry", "create_task"]);
    expect(res.reply).not.toMatch(/temporarily unavailable/);
  });

  it('"remind Robert about the dentist tomorrow" can become an EVENT (the content gate used to refuse it)', async () => {
    script = [round(use("create_event", { title: "Dentist — Robert", date: "2026-09-03" })), done()];
    const res = await processMessage("remind Robert about the dentist tomorrow", [], "u1");
    expect(refusals(res)).toHaveLength(0);
    expect(db.events).toHaveLength(1);
  });

  it('"log that I paid Sarah $20 for lunch" can ALSO feed a tracker (the entity gate used to refuse it)', async () => {
    script = [
      round(
        use("create_expense", { description: "Lunch — Sarah", amount: 20 }),
        use("log_tracker_entry", { trackerName: "Spending", values: { amount: 20 } }),
      ),
      done(),
    ];
    const res = await processMessage("log that I paid Sarah $20 for lunch", [], "u1");
    expect(refusals(res)).toHaveLength(0);
    expect(db.expenses).toHaveLength(1);
    expect(db.entries).toHaveLength(1);
  });

  it("a task for one person and a tracker log for another both land in one turn", async () => {
    script = [
      round(
        use("create_task", { title: "Call the vet", forProfile: "Robert" }),
        use("create_task", { title: "Order groceries", forProfile: "Sarah Miller" }),
        use("log_tracker_entry", { trackerName: "Running", values: { distance: 3 } }),
      ),
      done(),
    ];
    const res = await processMessage(
      "create a task for Robert to call the vet, a task for Sarah to order groceries, and log 3 miles for me", [], "u1",
    );
    expect(refusals(res)).toHaveLength(0);
    expect(db.tasks).toHaveLength(2);
    expect(db.entries).toHaveLength(1);
  });
});

describe("turn-scoped protections survive — they are facts, not interpretations", () => {
  it("still refuses a SECOND create of the same record in one turn", async () => {
    script = [
      round(
        use("create_task", { title: "Buy chicken" }),
        use("create_task", { title: "buy the chicken" }),
      ),
      done(),
    ];
    await processMessage("create a task to buy chicken", [], "u1");
    expect(db.tasks).toHaveLength(1);
  });

  it("still refuses replaying a request that belongs to an EARLIER message", async () => {
    script = [round(use("create_task", { title: "Renew passport paperwork" })), done()];
    const res = await processMessage(
      "log 2 miles",
      [{ role: "user", content: "add a task to renew passport paperwork" },
       { role: "assistant", content: "Done." }],
      "u1",
    );
    expect(db.tasks).toHaveLength(0);
    // A stale replay is excluded from the checklist entirely — the user
    // never sees a failure card for a request they did not make this turn.
    expect((res.operations || []).some((o: Row) => o.status === "failed")).toBe(false);
  });
});
