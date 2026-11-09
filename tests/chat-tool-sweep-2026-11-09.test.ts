// Defects found by sending one command per chat tool to the deployed app
// (scripts/verify-all-chat-tools.ts, 2026-11-09). Each test drives the REAL
// engine — processMessage's deterministic lanes or executeTool — against an
// in-memory store; the model is never called.
import { describe, it, expect, beforeEach, vi } from "vitest";

const SELF = { id: "p-self", name: "Robert", type: "self", fields: {} };
const ALICE = { id: "p-alice", name: "Alice Park", type: "person", fields: {} };

const db = {
  checkins: [] as Array<{ habitId: string }>,
  documents: [] as any[],
  habits: [] as any[],
  tasks: [] as any[],
  obligations: [] as any[],
  goals: [] as any[],
  events: [] as any[],
  trackers: [] as any[],
  journal: [] as any[],
  paychecks: [] as any[],
  budgets: [] as any[],
  artifacts: [] as any[],
  modelCalls: 0,
  modelRequests: [] as string[],
};

function reseed() {
  db.checkins = [];
  db.modelCalls = 0;
  db.modelRequests = [];
  db.documents = [
    { id: "d-warranty", name: "Fridge Warranty 2026", type: "warranty", mimeType: "application/pdf", linkedProfiles: [ALICE.id], extractedData: {}, tags: [], createdAt: "2026-11-01T00:00:00Z" },
  ];
  db.habits = [
    { id: "h-stretch", name: "Morning Stretch", frequency: "daily", linkedProfiles: [SELF.id], checkins: [], currentStreak: 0, longestStreak: 0, createdAt: "2026-10-01T00:00:00Z" },
  ];
  db.tasks = [
    { id: "t1", title: "File the tax docs", status: "todo", priority: "medium", dueDate: "2026-11-13", linkedProfiles: [SELF.id] },
    { id: "t2", title: "Buy milk", status: "in_progress", priority: "low", linkedProfiles: [SELF.id] },
    { id: "t3", title: "Renew passport", status: "done", priority: "high", linkedProfiles: [SELF.id] },
  ];
  db.obligations = [{ id: "o1", name: "Internet", amount: 42, frequency: "monthly", nextDueDate: "2026-11-15", status: "active", linkedProfiles: [] }];
  db.goals = [{ id: "g1", title: "Emergency fund", current: 250, target: 1000, unit: "$", status: "active", linkedProfiles: [] }];
  db.events = [{ id: "e1", title: "Dentist", date: "2026-11-10", time: "15:00", linkedProfiles: [] }];
  db.trackers = [{ id: "tr1", name: "Weight", category: "health", unit: "lbs", fields: [], linkedProfiles: [], entries: [{ id: "en1", timestamp: "2026-11-08T12:00:00Z", values: { weight: 181 } }] }];
  db.journal = [{ id: "j1", date: "2026-11-09", mood: "good", content: "Productive morning.", linkedProfiles: [] }];
  db.paychecks = [
    { id: "11111111-1111-4111-8111-111111111111", source: "Acme Corp", amount: 2000, expected_date: "2026-11-20", confirmed: false },
    { id: "22222222-2222-4222-8222-222222222222", source: "Side Gig", amount: 300, expected_date: "2026-11-25", confirmed: false },
  ];
  db.budgets = [{ id: "b-edu", category: "education", amount: 123 }, { id: "b-food", category: "food", amount: 400 }];
  db.artifacts = [
    { id: "a-pack", type: "checklist", title: "Packing", content: "passport\ncharger", items: [], tags: [], linkedProfiles: [] },
    // A note of the user's own whose title happens to name another profile.
    { id: "a-note", type: "note", title: "Alice Park birthday ideas", content: "A scarf.", tags: [], linkedProfiles: [SELF.id], createdAt: "2026-11-01T00:00:00Z" },
  ];
}

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/New_York",
    getProfiles: async () => [SELF, ALICE],
    getSelfProfile: async () => SELF,
    getDocuments: async () => db.documents,
    getHabits: async () => db.habits,
    getHabit: async (id: string) => db.habits.find((h) => h.id === id),
    checkinHabit: async (habitId: string) => { db.checkins.push({ habitId }); return db.habits.find((h) => h.id === habitId); },
    getTasks: async () => db.tasks,
    getObligations: async () => db.obligations,
    getGoals: async () => db.goals,
    getEvents: async () => db.events,
    getTrackers: async () => db.trackers,
    getJournalEntries: async () => db.journal,
    getPreference: async () => null,
    getPaychecks: async () => db.paychecks,
    getDomains: async () => [{ id: "dom1", name: "Garden", description: "Plants", fields: [] }],
    getArtifacts: async () => db.artifacts,
    // Production's matcher: the WHOLE query must be a substring of a field.
    search: async (q: string) => db.artifacts
      .filter((a) => `${a.title} ${a.content}`.toLowerCase().includes(q.toLowerCase()))
      .map((a) => ({ _type: "artifact", ...a })),
    deleteArtifact: async (id: string) => { db.artifacts = db.artifacts.filter((a) => a.id !== id); return true; },
    // The database column is a uuid: anything else is a Postgres error.
    confirmPaycheck: async (id: string, actual?: number) => {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`invalid input syntax for type uuid: "${id}"`);
      const p = db.paychecks.find((x) => x.id === id);
      if (!p) return null;
      p.confirmed = true; p.actual_amount = actual ?? p.amount;
      return p;
    },
    getBudgets: async () => db.budgets,
    updateBudget: async (_month: string, id: string, updates: any) => {
      const b = db.budgets.find((x) => x.id === id);
      if (!b) return false;
      Object.assign(b, updates);
      return true;
    },
  };
  const storage = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      // Any other write would be a write the message did not ask for.
      if (/^(create|update|delete|log|checkin|complete|set|save)/.test(prop)) {
        return async (...args: any[]) => { db.checkins.push({ habitId: `${prop}:${JSON.stringify(args).slice(0, 80)}` }); return undefined; };
      }
      return async () => [];
    },
  });
  return { storage };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (req: any) => { db.modelCalls++; db.modelRequests.push(JSON.stringify(req ?? "")); throw new Error("model unavailable in this test"); },
      stream: (req: any) => { db.modelCalls++; db.modelRequests.push(JSON.stringify(req ?? "")); throw new Error("model unavailable in this test"); },
    };
  },
}));

let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ processMessage, executeTool } = await import("../server/ai-engine"));
});

describe("\"show me <person>'s dashboard\" scopes the dashboard — it does not open a document", () => {
  it("returns the scope directive for the named person (the reported failure)", async () => {
    // Alice has a linked document. The document lane ran first and answered
    // "Here's your Fridge Warranty 2026." on the strength of that link alone.
    const res = await processMessage("Show me Alice Park's dashboard only", [], "u1");
    expect(res.documentPreview).toBeUndefined();
    expect(res.reply).not.toMatch(/warranty/i);
    const scope = (res.results as any[]).map((r) => r?.scope).find(Boolean);
    expect(scope).toEqual({ mode: "selected", profileId: ALICE.id, profileName: ALICE.name });
    expect(db.modelCalls).toBe(0);
  });

  it("a document linked to the person is not a match for something else of theirs", async () => {
    const res = await processMessage("open Alice's vaccination card", [], "u1");
    expect(res.documentPreview?.id).toBeUndefined();
  });

  it("still opens the person's document when the request names it", async () => {
    const res = await processMessage("open Alice's fridge warranty", [], "u1");
    expect(res.documentPreview?.id).toBe("d-warranty");
    expect(db.modelCalls).toBe(0);
  });

  it("still opens the person's documents when the request names only the person", async () => {
    const res = await processMessage("open Alice's documents", [], "u1");
    expect(res.documentPreview?.id).toBe("d-warranty");
  });
});

describe("ticking an item on a checklist never checks in a habit", () => {
  it("leaves the habit alone when the sentence shares a word with it (the reported failure)", async () => {
    // "Stretch" is in the habit's name and in the list item. The lane matched
    // on that one word and wrote a check-in.
    const res = await processMessage("Check off stretch bands on the Gym Packing checklist", [], "u1");
    expect(db.checkins).toEqual([]);
    expect(String(res.reply)).not.toMatch(/checked in/i);
  });

  it("the same for 'mark off … on my list'", async () => {
    await processMessage("mark off stretch bands on my morning shopping list", [], "u1");
    expect(db.checkins).toEqual([]);
  });

  it("still checks in the habit when the message is about the habit", async () => {
    const res = await processMessage("mark off my morning stretch", [], "u1");
    expect(String(res.reply)).toMatch(/Morning Stretch/);
    expect((res.actions as any[]).map((a) => a.type)).toEqual(["checkin_habit"]);
    expect(db.modelCalls).toBe(0);
  });
});

describe("generate_table builds every data source its schema offers", () => {
  it("has rows for each advertised source", async () => {
    const { TOOL_DEFINITIONS } = await import("../server/ai-engine");
    const tool = (TOOL_DEFINITIONS as any[]).find((t) => t.name === "generate_table");
    const sources: string[] = tool.input_schema.properties.dataSource.enum;
    expect(sources.length).toBeGreaterThanOrEqual(9);
    for (const dataSource of sources.filter((s) => s !== "expenses")) {
      const out = await executeTool("generate_table", { title: `My ${dataSource}`, dataSource, columns: [] }, "u1");
      const spec = out?.table ?? out;
      expect(out?.error, `${dataSource}: ${out?.error}`).toBeUndefined();
      expect(Array.isArray(spec?.rows) && spec.rows.length > 0, `${dataSource} rows`).toBe(true);
      // Every column shows a real field of the row.
      for (const c of spec.columns) expect(Object.keys(spec.rows[0]), `${dataSource}.${c.key}`).toContain(c.key);
    }
  });

  it("a task table asked for with the model's own words still finds the tasks (the reported failure)", async () => {
    const out = await executeTool("generate_table", {
      title: "My tasks", dataSource: "tasks",
      columns: [{ key: "title", label: "Title" }, { key: "due_date", label: "Due Date" }],
      filters: { status: "pending" },
    }, "u1");
    const spec = out?.table ?? out;
    expect(out?.error).toBeUndefined();
    expect(spec.rows.map((r: any) => r.title)).toEqual(["File the tax docs", "Buy milk"]);
    expect(spec.columns.map((c: any) => c.key)).toEqual(["title", "dueDate"]);
    const done = await executeTool("generate_table", { title: "Done", dataSource: "tasks", columns: [], filters: { status: "completed" } }, "u1");
    expect((done?.table ?? done).rows.map((r: any) => r.title)).toEqual(["Renew passport"]);
  });
});

describe("tools that are named by what the user calls the record", () => {
  it("confirms a paycheck by its source — the model has no id to give (the reported failure)", async () => {
    // What the model sent in production: the employer's name as the id.
    const out = await executeTool("confirm_paycheck_received", { paycheck_id: "Acme Corp" }, "u1");
    expect(out?.error).toBeUndefined();
    expect(out.result.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(db.paychecks[0].confirmed).toBe(true);
    expect(db.paychecks[1].confirmed).toBe(false);
  });

  it("confirms by source, still accepts a real id, and says so when nothing matches", async () => {
    const bySource = await executeTool("confirm_paycheck_received", { source: "side gig", actual_amount: 310 }, "u1");
    expect(bySource.result.actual_amount).toBe(310);
    const byId = await executeTool("confirm_paycheck_received", { paycheck_id: "11111111-1111-4111-8111-111111111111" }, "u1");
    expect(byId.result.confirmed).toBe(true);
    const none = await executeTool("confirm_paycheck_received", { source: "Nobody Inc" }, "u1");
    expect(String(none.error)).toMatch(/No expected paycheck/);
    const again = await executeTool("confirm_paycheck_received", { source: "Side Gig" }, "u1");
    expect(String(again.error)).toMatch(/already marked received/);
  });

  it("updates a budget named by its category (the reported failure)", async () => {
    const out = await executeTool("update_budget", { budgetId: "Education", amount: 150 }, "u1");
    expect(out?.error).toBeUndefined();
    expect(out.budgetId).toBe("b-edu");
    expect(db.budgets.find((b) => b.id === "b-edu")).toEqual({ id: "b-edu", category: "education", amount: 150 });
    const byId = await executeTool("update_budget", { budgetId: "b-food", amount: 450 }, "u1");
    expect(byId.success).toBe(true);
    const none = await executeTool("update_budget", { budgetId: "travel", amount: 5 }, "u1");
    expect(String(none.error)).toMatch(/No budget matching "travel"/);
  });
});

describe("a journal entry's recap names the entry, not the tool", () => {
  it("uses the entry's own words", async () => {
    const { opRawLabel } = await import("../server/ai-engine");
    const { buildTurnRecap } = await import("../shared/quick-log");
    const label = opRawLabel({ name: "journal_entry", input: { content: "Felt great today,\n productive morning", mood: "great" } });
    expect(label).toBe("Felt great today, productive morning");
    // The line the user read was "Journaled: journal_entry".
    expect(buildTurnRecap([{ status: "ok", tool: "journal_entry", label }])).toBe("Journaled: Felt great today, productive morning");
    expect(opRawLabel({ name: "journal_entry", input: { content: "x".repeat(200) } }).length).toBeLessThanOrEqual(60);
    expect(opRawLabel({ name: "create_task", input: { title: "Buy milk", content: "ignored" } })).toBe("Buy milk");
  });
});

describe("the model is told what its snapshot leaves out", () => {
  it("names every stored kind the snapshot does not list, and says to call the tool", async () => {
    // Right after creating one, the assistant answered "no journal entry for
    // today", "you have no notes", "no such checklist / paycheck / domain" —
    // it read the snapshot's silence as absence and never called the tool.
    const hadKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    try {
      await processMessage("Delete my journal entry for today", [], "u1");
    } finally {
      if (hadKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = hadKey;
    }
    const withSnapshot = db.modelRequests.find((r) => r.includes("Profile Name Index"));
    expect(withSnapshot, "the request that carries the data snapshot").toBeTruthy();
    const note = withSnapshot!.slice(withSnapshot!.indexOf("NOT LISTED IN THIS SNAPSHOT"));
    expect(withSnapshot).toContain("NOT LISTED IN THIS SNAPSHOT");
    for (const kind of ["journal text", "notes", "artifacts", "received paychecks", "budgets"]) {
      expect(note.slice(0, 700), kind).toContain(kind);
    }
    // What it CAN list cheaply, it lists: the prompt note alone still left
    // "no journal entry for today" / "no such paycheck / domain" in production.
    expect(withSnapshot).toContain("Journal: entries exist on 2026-11-09");
    expect(withSnapshot).toContain("Expected paychecks (not yet received): Acme Corp: $2000 expected 2026-11-20");
    expect(withSnapshot).toContain("Custom domains (1): Garden");
    // The journal's text stays out of the snapshot.
    expect(withSnapshot).not.toContain("Productive morning.");
    expect(note.slice(0, 700)).toMatch(/call its tool/);
  });
});

describe("the search tool finds a record named with its kind", () => {
  it("finds the checklist titled Packing when asked for the Packing checklist (the reported failure)", async () => {
    const out = await executeTool("search", { query: "Packing checklist" }, "u1");
    expect(out.map((r: any) => r.id)).toContain("a-pack");
  });

  it("finds custom domains and expected paychecks, which the corpus leaves out", async () => {
    const domain = await executeTool("search", { query: "Garden domain" }, "u1");
    expect(domain.map((r: any) => `${r._type}:${r.name}`)).toContain("domain:Garden");
    const pay = await executeTool("search", { query: "Acme" }, "u1");
    expect(pay.map((r: any) => `${r._type}:${r.source}`)).toContain("paycheck:Acme Corp");
  });

  it("still returns nothing for something that is not there", async () => {
    expect(await executeTool("search", { query: "Zeppelin checklist" }, "u1")).toEqual([]);
  });
});

describe("a note is not hidden by a profile guessed from its title", () => {
  it("deletes the user's own note whose title names someone else (the reported failure)", async () => {
    const out = await executeTool("delete_note", { title: "Alice Park birthday ideas" }, "u1");
    expect(out?.error).toBeUndefined();
    expect(out.id).toBe("a-note");
  });
});
