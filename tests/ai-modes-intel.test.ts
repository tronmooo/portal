// Custom AI Modes, over a mocked model (owner request 2026-11-27).
//
// What is pinned here:
//  - What a mode may read is the STORED mode's access, enforced where the
//    prompt is built: a source that is off is not in the prompt at all, and
//    nothing the client sends can widen it. Journal text reaches a mode only
//    when the person switched it on.
//  - The builder only fills in the approved schema: unknown parts are dropped,
//    the journal is never switched on, and an unusable answer falls back to
//    the fixed rules.
//  - Chat writes only the mode's own memory row; analysis writes nothing and
//    drops any item that names a source that was not sent.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AI_MODES_PREF, MODE_TEMPLATES, modeFromTemplate, serializeAiModes, type AiMode } from "../shared/ai-modes";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

type Row = Record<string, any>;
const SELF = { id: "p-self", name: "Sam Rivera", type: "self", fields: { occupation: "Nurse", ssn: "123-45-6789" } };
const db: { profiles: Row[]; journal: Row[]; tasks: Row[]; expenses: Row[]; trackers: Row[]; notifications: Row[]; prefs: Record<string, string>; writes: string[]; prefWrites: string[] } =
  { profiles: [], journal: [], tasks: [], expenses: [], trackers: [], notifications: [], prefs: {}, writes: [], prefWrites: [] };

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => db.profiles,
    getJournalEntries: async () => db.journal,
    getArtifacts: async () => [],
    getTasks: async () => db.tasks,
    getEvents: async () => [],
    getExpenses: async () => db.expenses,
    getObligations: async () => [],
    getGoals: async () => [],
    getHabits: async () => [],
    getDocuments: async () => [],
    getPreference: async (key: string) => db.prefs[key] ?? null,
    getTrackers: async () => db.trackers,
    createUserNotification: async (n: Row) => { db.notifications.push(n); return { id: "n1", ...n }; },
    setPreference: async (key: string, value: string) => { db.prefWrites.push(key); db.prefs[key] = value; },
    acquireUserLock: async () => true,
    releaseUserLock: async () => undefined,
  };
  return { storage: new Proxy(impl, { get: (t, p: string) => (p in t ? t[p] : async () => { db.writes.push(p); return []; }) }) };
});

let modelReply = "";
let modelCalls: Row[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: async (req: Row) => { modelCalls.push(req); return { content: [{ type: "text", text: modelReply }], stop_reason: "end_turn" }; } };
  },
}));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const sentTo = (call: Row) => `${call.system ?? ""}\n${(call.messages || []).map((m: Row) => m.content).join("\n")}`;
const store = (modes: AiMode[]) => { db.prefs[AI_MODES_PREF] = serializeAiModes(modes); };
const coach = (access: AiMode["access"]) => ({ ...modeFromTemplate(MODE_TEMPLATES.find((t) => t.key === "life-coach")!, [], new Date()), access });
const ok = <T extends { ok: boolean }>(r: T) => { expect(r.ok, JSON.stringify(r)).toBe(true); return r as Extract<T, { ok: true }>; };

let modes: typeof import("../server/ai-modes");
beforeEach(async () => {
  db.profiles = [SELF]; db.prefs = {}; db.writes = []; db.prefWrites = []; db.trackers = []; db.notifications = [];
  db.journal = [{ id: "j1", date: daysAgo(1), mood: "low", title: "", content: "SECRETJOURNALWORD about work.", tags: [], linkedProfiles: [], createdAt: `${daysAgo(1)}T08:00:00Z` }];
  db.tasks = [{ id: "t1", title: "Book the dentist", status: "todo", dueDate: daysAgo(-3) }];
  db.expenses = [{ id: "e1", amount: 42.5, category: "groceries", description: "MARKETRECEIPT", date: daysAgo(2) }];
  modelReply = "An answer."; modelCalls = [];
  modes = await import("../server/ai-modes");
});

describe("what a mode reads is the stored mode's switch", () => {
  it("only its sources are in the prompt; the journal, money and SSN are not", async () => {
    store([coach(["profile", "tasks"])]);
    const r = ok(await modes.modeChat({ modeId: "life-coach", messages: [{ role: "user", content: "What should I do first?" }] }));
    expect(r.read).toEqual(["profile", "tasks"]);
    const sent = sentTo(modelCalls[0]);
    expect(sent).toContain("Book the dentist");
    expect(sent).toContain("Nurse");
    expect(sent).not.toContain("123-45-6789");
    expect(sent).not.toContain("SECRETJOURNALWORD");
    expect(sent).not.toContain("MARKETRECEIPT");
    // It is told who it is and the rules that do not bend.
    expect(sent).toContain('"Life Coach"');
    expect(sent).toMatch(/never guess or invent/i);
  });

  it("the journal is read only when the person switched it on", async () => {
    store([coach(["journal"])]);
    ok(await modes.modeChat({ modeId: "life-coach", messages: [{ role: "user", content: "How have I been?" }] }));
    expect(sentTo(modelCalls[0])).toContain("SECRETJOURNALWORD");
  });

  it("nothing the client sends widens what is read", async () => {
    store([coach(["tasks"])]);
    ok(await modes.modeChat({ modeId: "life-coach", access: ["journal", "finance"], messages: [{ role: "user", content: "hi" }] } as any));
    const sent = sentTo(modelCalls[0]);
    expect(sent).not.toContain("SECRETJOURNALWORD");
    expect(sent).not.toContain("MARKETRECEIPT");
  });

  it("chat writes only the mode's own memory row", async () => {
    store([coach(["tasks"])]);
    db.prefWrites = [];
    modelReply = "Start with the dentist.\nREMEMBER: [\"Sam wants to get on top of appointments\"]";
    const r = ok(await modes.modeChat({ modeId: "life-coach", messages: [{ role: "user", content: "I keep putting off appointments" }] }));
    expect(r.answer).toBe("Start with the dentist.");
    expect(r.remembered).toEqual(["Sam wants to get on top of appointments"]);
    expect(db.prefWrites).toEqual(["ai_memory:mode-life-coach"]);
    expect(db.writes.filter((m) => /^(create|update|delete|save|log|set|insert)/i.test(m))).toEqual([]);
  });

  it("with remembering off, nothing at all is written", async () => {
    store([{ ...coach(["tasks"]), remember: false }]);
    db.prefWrites = [];
    ok(await modes.modeChat({ modeId: "life-coach", messages: [{ role: "user", content: "hi" }] }));
    expect(db.prefWrites).toEqual([]);
  });
});

describe("analysis is grounded and writes nothing", () => {
  it("an item naming a source that was not sent is dropped", async () => {
    store([coach(["tasks", "finance"])]);
    db.prefWrites = [];
    modelReply = JSON.stringify({ items: [
      { title: "Groceries lead", detail: "Most spending was groceries.", sources: ["finance"] },
      { title: "From your journal", detail: "You wrote about work.", sources: ["journal"] },
    ] });
    const r = ok(await modes.modeInsights({ modeId: "life-coach", tabId: "patterns" }));
    expect(r.items.map((i) => i.title)).toEqual(["Groceries lead"]);
    expect(r.read).toEqual(["tasks", "finance"]);
    expect(db.prefWrites).toEqual([]);
  });

  it("a mode with nothing to read says so instead of asking the model", async () => {
    store([coach([])]);
    const r = await modes.modeInsights({ modeId: "life-coach", tabId: "patterns" });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(modelCalls).toHaveLength(0);
  });
});

describe("the builder fills in the approved schema only", () => {
  it("unknown parts are dropped and the journal is never switched on", async () => {
    modelReply = "Here you go:\n```json\n" + JSON.stringify({
      name: "Sleep Lab", icon: "moon", color: "blue", tagline: "Sleep and recovery", personality: "calm", instructions: "Help me sleep better.",
      access: ["health", "journal", "passwords"], suggestJournal: true,
      tabs: [{ title: "Nights", kind: "insights", focus: "How did I sleep?" }, { title: "Evil", kind: "iframe", src: "https://x" }, { title: "Chat", kind: "chat" }],
      prompts: ["How did I sleep this week?"],
    }) + "\n```";
    const r = ok(await modes.generateMode("An AI that helps me sleep better"));
    expect(r.by).toBe("ai");
    expect(r.suggestJournal).toBe(true);
    expect(r.mode.access).toEqual(["health"]);
    expect(r.mode.tabs.map((t) => t.kind)).toEqual(["insights", "chat"]);
    expect(JSON.stringify(r.mode)).not.toContain("https://x");
    expect(db.prefWrites).toEqual([]);
  });

  it("an unusable answer falls back to the fixed rules — the builder always answers", async () => {
    modelReply = "I can't do JSON today.";
    const r = ok(await modes.generateMode("An AI that manages my business and projects"));
    expect(r).toMatchObject({ by: "rules" });
    expect(r.mode.name).toBe("Business Manager");
  });

  it("a revision cannot switch the journal on, and keeps the id, date and pin", async () => {
    const m = { ...coach(["tasks"]), pinned: true };
    store([m]);
    modelReply = JSON.stringify({ ...m, id: "evil", name: "Coach+", access: ["tasks", "journal"], pinned: false });
    const r = ok(await modes.reviseMode("life-coach", "rename it and read my journal"));
    expect(r.mode).toMatchObject({ id: "life-coach", name: "Coach+", pinned: true, createdAt: m.createdAt });
    expect(r.mode.access).toEqual(["tasks"]);
    expect(db.prefWrites).toEqual([]);
  });
});

describe("check-ins run on their own, and only when due", () => {
  it("a due check-in keeps its answer in the mode's digest and sends one notification; the next run is not due", async () => {
    store([{ ...coach(["tasks"]), checkins: [{ id: "checkin-patterns", tabId: "patterns", freq: "weekly", enabled: true }] }]);
    db.prefWrites = [];
    modelReply = JSON.stringify({ items: [{ title: "The dentist keeps slipping", detail: "It has been open for a while.", sources: ["tasks"] }] });
    const now = new Date();
    expect(await modes.runDueCheckins({ now })).toEqual({ ran: 1, failed: 0 });
    expect(db.prefWrites).toEqual(["ai_mode_digest:life-coach"]);
    expect(db.notifications).toEqual([expect.objectContaining({ title: "Life Coach: Patterns", message: "The dentist keeps slipping", entityType: "ai_mode", entityId: "life-coach" })]);
    const digest = await modes.readDigest("life-coach");
    expect(digest.runs.patterns.items[0].title).toBe("The dentist keeps slipping");
    // A day later a weekly check-in is not due: no model call, no write.
    const calls = modelCalls.length;
    expect(await modes.runDueCheckins({ now: new Date(now.getTime() + 86_400_000) })).toEqual({ ran: 0, failed: 0 });
    expect(modelCalls.length).toBe(calls);
    expect(db.writes.filter((m) => /^(create|update|delete|save|log|set|insert)/i.test(m))).toEqual([]);
  });

  it("a switched-off check-in never runs", async () => {
    store([{ ...coach(["tasks"]), checkins: [{ id: "checkin-patterns", tabId: "patterns", freq: "daily", enabled: false }] }]);
    expect(await modes.runDueCheckins()).toEqual({ ran: 0, failed: 0 });
    expect(modelCalls).toHaveLength(0);
  });
});

describe("the builder's graphs are grounded in the person's trackers", () => {
  it("the model sees tracker names and fields only — never a reading — and a graph over a tracker they lack is dropped", async () => {
    db.trackers = [{ id: "t1", name: "Running", fields: [{ name: "miles", type: "number" }], entries: [{ id: "e", timestamp: new Date().toISOString(), values: { miles: 4.2, note: "PRIVATENOTE" } }], linkedProfiles: [] }];
    modelReply = JSON.stringify({
      name: "Run Coach", icon: "dumbbell", color: "orange", access: ["health"],
      tabs: [{ title: "Graphs", kind: "charts", graphs: [
        { title: "Miles", kind: "metric", source: { kind: "tracker", key: "running", field: "miles" }, calc: "total", display: "bar" },
        { title: "Swims", kind: "metric", source: { kind: "tracker", key: "Swimming" }, display: "bar" },
      ] }, { title: "Chat", kind: "chat" }],
    });
    const r = ok(await modes.generateMode("coach my running"));
    const sent = sentTo(modelCalls[0]);
    expect(sent).toContain("- Running: miles");
    expect(sent).not.toContain("4.2");
    expect(sent).not.toContain("PRIVATENOTE");
    const graphs = r.mode.tabs.find((t) => t.kind === "charts")!.graphs!;
    expect(graphs.map((g) => g.title)).toEqual(["Miles"]);
    expect(graphs[0].source).toMatchObject({ kind: "tracker", key: "Running", field: "miles" });
  });
});
