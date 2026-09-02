// Chat tool regressions from the 2026-09-02 error hunt (ledger D58–D68).
// Drives the REAL executeTool / processMessage against an in-memory storage.
import { describe, it, expect, beforeEach, vi } from "vitest";

const SELF = { id: "p-self", name: "Robert", type: "self", fields: {} };
const MOM = { id: "p-mom", name: "Mom", type: "person", fields: {} };
const SARAH = { id: "p-sarah", name: "Sarah", type: "person", fields: {} };
const AL = { id: "p-al", name: "Al", type: "person", fields: {} };

const db: any = {};
const today = () => new Date().toLocaleDateString("en-CA");

function reseed() {
  db.habits = [
    { id: "h-dog", name: "Walk the Dog", linkedProfiles: [SELF.id], targetPerDay: 1, checkins: [], frequency: "daily" },
  ];
  db.tasks = [
    { id: "t-aug", title: "Refill Propranolol - August", status: "done", dueDate: "2026-08-08", tags: ["health"], linkedProfiles: [SELF.id] },
    { id: "t-sep", title: "Refill Propranolol - September", status: "todo", dueDate: "2026-09-07", tags: ["health"], linkedProfiles: [SELF.id] },
    { id: "t-oct", title: "Refill Propranolol - October", status: "todo", dueDate: "2026-10-07", tags: ["health"], linkedProfiles: [SELF.id] },
    { id: "t-milk", title: "Buy milk", status: "todo", dueDate: today(), tags: [], linkedProfiles: [SELF.id] },
  ];
  db.obligations = [
    { id: "o-phone", name: "Phone Bill", amount: 60, frequency: "monthly", nextDueDate: "2026-09-15", linkedProfiles: [SELF.id], payments: [] },
    { id: "o-water", name: "Water Bill", amount: 40, frequency: "monthly", nextDueDate: "2026-09-20", linkedProfiles: [SELF.id], payments: [] },
  ];
  db.expenses = [];
  db.events = [];
  db.entries = [];
  db.trackers = [
    { id: "t-water", name: "Hydration", category: "health", unit: "oz", fields: [{ name: "ounces", type: "number", unit: "oz" }], linkedProfiles: [SELF.id] },
    { id: "t-weight", name: "Weight", category: "health", unit: "lbs", fields: [{ name: "weight", type: "number", unit: "lbs" }], linkedProfiles: [SELF.id] },
    { id: "t-sleep", name: "Sleep", category: "health", unit: "hrs", fields: [{ name: "hours", type: "number", unit: "hrs" }], linkedProfiles: [SELF.id, SARAH.id] },
  ];
  db.goals = [
    { id: "g-w", title: "Get to 170", type: "weight_loss", target: 170, current: 185, status: "active", trackerId: "t-weight", unit: "lbs" },
  ];
  db.goalUpdates = [];
  db.payments = [];
}

vi.mock("../server/storage", () => {
  const withEntries = (t: any) => ({ ...t, entries: db.entries.filter((e: any) => e.trackerId === t.id) });
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF, MOM, SARAH, AL],
    getSelfProfile: async () => SELF,
    getHabits: async () => db.habits,
    getHabit: async (id: string) => db.habits.find((h: any) => h.id === id),
    checkinHabit: async (habitId: string) => {
      const h = db.habits.find((x: any) => x.id === habitId);
      if (!h) return undefined;
      const c = { id: `c${h.checkins.length + 1}`, habitId, date: today() };
      h.checkins.push(c);
      return c;
    },
    getTasks: async () => db.tasks,
    getTask: async (id: string) => db.tasks.find((t: any) => t.id === id),
    updateTask: async (id: string, patch: any) => { const t = db.tasks.find((x: any) => x.id === id); if (!t) return undefined; Object.assign(t, patch); return t; },
    deleteTask: async (id: string) => { const n = db.tasks.length; db.tasks = db.tasks.filter((t: any) => t.id !== id); return db.tasks.length < n; },
    getObligations: async () => db.obligations,
    getObligation: async (id: string) => db.obligations.find((o: any) => o.id === id),
    getExpenses: async () => db.expenses,
    getExpense: async (id: string) => db.expenses.find((e: any) => e.id === id),
    createExpense: async (data: any) => { const row = { id: `x${db.expenses.length + 1}`, createdAt: new Date().toISOString(), ...data }; db.expenses.push(row); return row; },
    getEvents: async () => db.events,
    getEvent: async (id: string) => db.events.find((e: any) => e.id === id),
    createEvent: async (data: any) => { const row = { id: `ev${db.events.length + 1}`, ...data }; db.events.push(row); return row; },
    getTrackers: async () => db.trackers.map(withEntries),
    getTracker: async (id: string) => { const t = db.trackers.find((x: any) => x.id === id); return t ? withEntries(t) : undefined; },
    getTrackerEntry: async (id: string) => db.entries.find((e: any) => e.id === id),
    logEntry: async (data: any) => {
      const entry = { id: `e${db.entries.length + 1}`, trackerId: data.trackerId, values: data.values, profileId: data.profileId || null, timestamp: data.timestamp || new Date().toISOString(), computed: {} };
      db.entries.push(entry); return entry;
    },
    updateTrackerEntry: async (_tid: string, eid: string, patch: any) => { const e = db.entries.find((x: any) => x.id === eid); if (!e) return undefined; e.values = { ...e.values, ...(patch.values || {}) }; return e; },
    getGoals: async () => db.goals,
    updateGoal: async (id: string, patch: any) => { db.goalUpdates.push({ id, patch }); const g = db.goals.find((x: any) => x.id === id); Object.assign(g, patch); return g; },
    getIncomes: async () => [],
    getMemories: async () => [],
    getDocuments: async () => [],
    getJournalEntries: async () => [],
    getPreference: async () => null,
    createAiActionLog: async (row: any) => ({ id: "log1", ...row }),
    createLiabilityPayment: async (data: any) => { const row = { id: `pay${db.payments.length + 1}`, ...data }; db.payments.push(row); return row; },
  };
  const storage = new Proxy(impl, { get(target, prop: string) { return prop in target ? target[prop] : async () => []; } });
  return { storage };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => { throw new Error("model must not be called"); },
      stream: () => { throw new Error("model must not be called"); },
    };
  },
}));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool, processMessage } = await import("../server/ai-engine"));
});

describe("D58: a write delegated to another kind tells the envelope which row it wrote", () => {
  it("complete_task → habit check-in carries a habit verify hint", async () => {
    const res = await executeTool("complete_task", { title: "Walk the Dog", __userMessage: "mark walk the dog done" }, "u1");
    expect(res?.error).toBeUndefined();
    expect(res.resolvedAs).toBe("habit");
    expect(res._verify).toEqual({ type: "habit", id: "h-dog" });
    expect(db.habits[0].checkins).toHaveLength(1);
  });
  it("checkin_habit → task completion carries a task verify hint", async () => {
    const res = await executeTool("checkin_habit", { name: "Buy milk", __userMessage: "mark buy milk done" }, "u1");
    expect(res?.error).toBeUndefined();
    expect(res._verify).toEqual({ type: "task", id: "t-milk" });
    expect(db.tasks.find((t: any) => t.id === "t-milk").status).toBe("done");
  });
  it("a money-shaped tracker log diverted to an expense verifies as an expense", async () => {
    const res = await executeTool("log_tracker_entry", { trackerName: "Car Repair", values: { amount: 400 }, __userMessage: "log $400 car repair" }, "u1");
    expect(res?.error).toBeUndefined();
    expect(db.expenses).toHaveLength(1);
    expect(res._verify).toEqual({ type: "expense", id: db.expenses[0].id });
  });
});

describe("D59: expense attribution reads the clause that carries the amount", () => {
  it("$5 coffee stays the user's when only the $50 groceries were for Mom", async () => {
    const msg = "I spent $5 on coffee and $50 on groceries for Mom";
    const coffee = await executeTool("create_expense", { amount: 5, description: "coffee", category: "food", __userMessage: msg }, "u1");
    const groceries = await executeTool("create_expense", { amount: 50, description: "groceries", category: "food", __userMessage: msg }, "u1");
    expect(coffee.linkedProfiles || []).toEqual([]);
    expect(groceries.linkedProfiles).toEqual([MOM.id]);
  });
});

describe("D60: paying a bill by an ambiguous name asks instead of paying the first match", () => {
  it('"the bill" with two bills is a question, not a payment on Phone Bill', async () => {
    const res = await executeTool("pay_obligation", { name: "bill", __userMessage: "I paid the bill" }, "u1");
    expect(res.error).toMatch(/Multiple matches/);
    expect(res.candidates?.length).toBe(2);
    expect(db.payments).toHaveLength(0);
  });
  it("an empty name pays nothing", async () => {
    const res = await executeTool("pay_obligation", { name: "", __userMessage: "paid it" }, "u1");
    expect(res.error).toBeTruthy();
    expect(db.payments).toHaveLength(0);
  });
});

describe("D61: a duplicate tracker log is reported as a duplicate, not as a fresh write", () => {
  it("returns deduped:true with the existing entry", async () => {
    const first = await executeTool("log_tracker_entry", { trackerName: "Hydration", values: { ounces: 8 }, __userMessage: "drank 8 oz of water" }, "u1");
    expect(first.error).toBeUndefined();
    const second = await executeTool("log_tracker_entry", { trackerName: "Hydration", values: { ounces: 8 }, __userMessage: "drank 8 oz of water" }, "u1");
    expect(second.deduped).toBe(true);
    expect(db.entries).toHaveLength(1);
  });
});

describe("D62: event duplicate detection is per owner and per time", () => {
  it("Sarah's 9am dentist does not swallow the user's 3pm one", async () => {
    const a = await executeTool("create_event", { title: "Dentist appointment", date: "2026-09-10", time: "09:00", forProfile: "Sarah" }, "u1");
    expect(a.error).toBeUndefined();
    const b = await executeTool("create_event", { title: "Dentist appointment", date: "2026-09-10", time: "15:00" }, "u1");
    expect(b.error).toBeUndefined();
    expect(b.deduped).toBeUndefined();
    expect(db.events).toHaveLength(2);
    const again = await executeTool("create_event", { title: "Dentist appointment", date: "2026-09-10", time: "15:00" }, "u1");
    expect(again.deduped).toBe(true);
    expect(db.events).toHaveLength(2);
  });
});

describe("D63: two people's identical spends are two expenses", () => {
  it("Sarah's $15 lunch is not a duplicate of the user's", async () => {
    const mine = await executeTool("create_expense", { amount: 15, description: "lunch", category: "food" }, "u1");
    const hers = await executeTool("create_expense", { amount: 15, description: "lunch", category: "food", forProfile: "Sarah" }, "u1");
    expect(mine.deduped).toBeUndefined();
    expect(hers.deduped).toBeUndefined();
    expect(db.expenses).toHaveLength(2);
  });
  it("yesterday's $20 lunch is not a duplicate of today's", async () => {
    await executeTool("create_expense", { amount: 20, description: "lunch", category: "food", date: "2026-09-01" }, "u1");
    const b = await executeTool("create_expense", { amount: 20, description: "lunch", category: "food", date: "2026-09-02" }, "u1");
    expect(b.deduped).toBeUndefined();
    expect(db.expenses).toHaveLength(2);
    const c = await executeTool("create_expense", { amount: 20, description: "lunch", category: "food", date: "2026-09-02" }, "u1");
    expect(c.deduped).toBe(true);
  });
});

describe("D64: a question about a habit is not a check-in", () => {
  it('"Did I walk the dog today?" writes nothing', async () => {
    await processMessage("Did I walk the dog today?", [], "u1").catch(() => null);
    expect(db.habits[0].checkins).toHaveLength(0);
  });
  it('"done walk the dog" still checks in', async () => {
    const res = await processMessage("done walk the dog", [], "u1");
    expect(res.reply).toMatch(/Walk the Dog/i);
    expect(db.habits[0].checkins).toHaveLength(1);
  });
});

describe("D65: deleting one occurrence of a materialized series deletes one row", () => {
  it("the September refill alone", async () => {
    const res = await executeTool("delete_task", { title: "Refill Propranolol - September" }, "u1");
    expect(res.deleted).toBe(true);
    expect(res.seriesDeleted).toBeUndefined();
    expect(db.tasks.map((t: any) => t.id).sort()).toEqual(["t-aug", "t-milk", "t-oct"]);
  });
  it("naming the schedule deletes the whole series", async () => {
    const res = await executeTool("delete_task", { title: "Refill Propranolol" }, "u1");
    expect(res.seriesDeleted).toBe(true);
    expect(db.tasks.map((t: any) => t.id)).toEqual(["t-milk"]);
  });
});

describe("D66: a reading on a weight goal's tracker does not add up into the goal", () => {
  it("logging 184 lbs leaves a 'get to 170' goal active", async () => {
    const res = await executeTool("log_tracker_entry", { trackerName: "Weight", values: { weight: 184 }, __userMessage: "weight 184" }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.goalUpdates).toHaveLength(0);
    expect(db.goals[0].status).toBe("active");
  });
});

describe("D67: a bill name mention must be a whole word", () => {
  it('"Allstate insurance" is not Al\'s bill', async () => {
    const res = await executeTool("create_obligation", { name: "Allstate insurance", amount: 120, frequency: "monthly", nextDueDate: "2026-09-20" }, "u1");
    expect(res?.error).toBeUndefined();
    expect((res.linkedProfiles || []).includes(AL.id)).toBe(false);
  });
});

describe("D68: editing 'my last entry' on a shared tracker edits the user's row", () => {
  it("corrects the user's sleep, not Sarah's newer one", async () => {
    await executeTool("log_tracker_entry", { trackerName: "Sleep", values: { hours: 7 } }, "u1");
    await executeTool("log_tracker_entry", { trackerName: "Sleep", values: { hours: 9 }, forProfile: "Sarah" }, "u1");
    const res = await executeTool("update_tracker_entry", { trackerName: "Sleep", values: { hours: 8 } }, "u1");
    expect(res.error).toBeUndefined();
    const mine = db.entries.find((e: any) => !e.profileId || e.profileId === SELF.id);
    const hers = db.entries.find((e: any) => e.profileId === SARAH.id);
    expect(mine.values.hours).toBe(8);
    expect(hers.values.hours).toBe(9);
  });
});
