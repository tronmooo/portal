// "I walked 2 miles, ate a chicken sandwich and played soccer for 30 minutes"
// logged a calorie burn for the WALK and none for the SOCCER (user screenshot,
// 2026-09-22). The estimation layer only ran for walking/running/cycling, so
// every other physical activity reached the user with no energy number at all.
//
// This pins the fix: EVERY calorie-bearing activity is priced from the owner's
// body weight (or a labelled population default), labelled as an estimate, and
// surfaced in the reply's estimateNote.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { entryValueProvenance } from "@shared/estimation-engine";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const SELF = { id: "p-self", name: "Me", type: "self", fields: { weight: "200 lb", height: "5'10" } };
const NO_BODY = { id: "p-kid", name: "Robin", type: "person", fields: {} };

type Row = Record<string, any>;
const db: { trackers: Row[]; entries: Row[] } = { trackers: [], entries: [] };

const DURATION_FIELDS = [
  { name: "duration", type: "number", unit: "min", isPrimary: true },
  { name: "intensity", type: "text" },
  { name: "caloriesBurned", type: "number", unit: "kcal" },
];

function reseed() {
  db.entries = [];
  db.trackers = [
    { id: "t-soccer", name: "Soccer", category: "fitness", unit: "min", linkedProfiles: [SELF.id], entries: [], fields: DURATION_FIELDS },
    { id: "t-soccer-kid", name: "Soccer", category: "fitness", unit: "min", linkedProfiles: [NO_BODY.id], entries: [], fields: DURATION_FIELDS },
    { id: "t-yoga", name: "Yoga", category: "fitness", unit: "min", linkedProfiles: [SELF.id], entries: [], fields: DURATION_FIELDS },
    { id: "t-bp", name: "Blood Pressure", category: "health", unit: "mmHg", linkedProfiles: [SELF.id], entries: [], fields: [{ name: "systolic", type: "number" }, { name: "diastolic", type: "number" }] },
  ];
}

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF, NO_BODY],
    getSelfProfile: async () => SELF,
    getTrackers: async () => db.trackers.map((t) => ({ ...t, entries: db.entries.filter((e) => e.trackerId === t.id) })),
    getTracker: async (id: string) => {
      const t = db.trackers.find((x) => x.id === id);
      return t ? { ...t, entries: db.entries.filter((e) => e.trackerId === t.id) } : undefined;
    },
    getTrackerEntry: async (id: string) => db.entries.find((e) => e.id === id),
    logEntry: async (data: Row) => {
      const entry = {
        id: `e${db.entries.length + 1}`, trackerId: data.trackerId, values: data.values,
        profileId: data.profileId || null, timestamp: data.timestamp || new Date().toISOString(), computed: {},
      };
      db.entries.push(entry); return entry;
    },
    createTracker: async (data: Row) => { const t = { id: `t-new-${db.trackers.length + 1}`, entries: [], linkedProfiles: [], ...data }; db.trackers.push(t); return t; },
    updateTracker: async (id: string, patch: Row) => { const t = db.trackers.find((x) => x.id === id); if (t) Object.assign(t, patch); return t; },
    getPreference: async () => null,
    getMemories: async () => [], getHabits: async () => [], getGoals: async () => [], getTasks: async () => [],
    getExpenses: async () => [], getEvents: async () => [], getObligations: async () => [],
    getDocuments: async () => [], getJournalEntries: async () => [], getIncomes: async () => [],
  };
  return { storage: new Proxy(impl, { get: (t, p: string) => (p in t ? t[p] : async () => []) }) };
});

let script: Array<{ content: any[]; stop_reason?: string }> = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: async () => script.shift() ?? { content: [{ type: "text", text: "" }], stop_reason: "end_turn" } };
  },
}));

const use = (name: string, input: Row, id = `tu_${Math.random().toString(36).slice(2, 8)}`) => ({ type: "tool_use", id, name, input });
const round = (...calls: Row[]) => ({ content: calls, stop_reason: "tool_use" });
const done = (text = "") => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  script = [];
  ({ processMessage } = await import("../server/ai-engine"));
});

describe("every physical activity gets a calorie estimate, not just cardio", () => {
  it("prices a 30-minute soccer game from the user's own body weight", async () => {
    script = [
      round(use("log_tracker_entry", { trackerName: "Soccer", values: { activityType: "soccer", duration: 30, intensity: "moderate" } })),
      done("Logged."),
    ];
    await processMessage("I played soccer for 30 minutes", [], "u1");

    const entry = db.entries.find((e) => e.trackerId === "t-soccer");
    expect(entry, "the soccer entry").toBeTruthy();
    // MET 7 (soccer, moderate) × 3.5 × 90.7 kg / 200 × 30 min ≈ 333 kcal.
    expect(entry!.values.caloriesBurned).toBeGreaterThan(280);
    expect(entry!.values.caloriesBurned).toBeLessThan(400);
    const pv = entryValueProvenance(entry!, "caloriesBurned");
    expect(pv?.isEstimated, "an estimate is never passed off as user data").toBe(true);
    expect(pv?.method).toMatch(/MET/);
    expect(pv?.method).toMatch(/91 kg/); // the user's weight, not a default
  });

  it("falls back to the labelled population default for a profile with no weight", async () => {
    script = [
      round(use("log_tracker_entry", { trackerName: "Soccer", forProfile: "Robin", values: { activityType: "soccer", duration: 30 } })),
      done("Logged."),
    ];
    await processMessage("Robin played soccer for 30 minutes", [], "u1");

    const entry = db.entries.find((e) => e.trackerId === "t-soccer-kid");
    expect(entry, "Robin's soccer entry").toBeTruthy();
    expect(entry!.values.caloriesBurned).toBeGreaterThan(0);
    expect(entryValueProvenance(entry!, "caloriesBurned")?.method).toMatch(/population-average/);
  });

  it("covers non-sport activity shapes too — a yoga session", async () => {
    script = [
      round(use("log_tracker_entry", { trackerName: "Yoga", values: { duration: 60 } })),
      done("Logged."),
    ];
    await processMessage("did an hour of yoga", [], "u1");
    const entry = db.entries.find((e) => e.trackerId === "t-yoga");
    expect(entry!.values.caloriesBurned).toBeGreaterThan(0);
  });

  it("makes no calorie claim about a non-activity tracker", async () => {
    script = [
      round(use("log_tracker_entry", { trackerName: "Blood Pressure", values: { systolic: 118, diastolic: 76 } })),
      done("Logged."),
    ];
    await processMessage("BP was 118 over 76", [], "u1");
    const entry = db.entries.find((e) => e.trackerId === "t-bp");
    expect(entry!.values.caloriesBurned).toBeUndefined();
  });

  it("keeps a burn the user actually stated, and marks it as theirs", async () => {
    script = [
      round(use("log_tracker_entry", { trackerName: "Soccer", values: { activityType: "soccer", duration: 30, caloriesBurned: 400 } })),
      done("Logged."),
    ];
    await processMessage("played soccer for 30 minutes and burned 400 calories", [], "u1");
    const entry = db.entries.find((e) => e.trackerId === "t-soccer");
    expect(entry!.values.caloriesBurned).toBe(400);
    expect(entryValueProvenance(entry!, "caloriesBurned")).toBeNull();
  });
});
