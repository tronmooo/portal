// "Sarah and I both played soccer" must produce TWO entries — one for each
// person — and they must be different records, not one record written twice.
//
// Reported twice (2026-09-02). The first fix told the model to log per
// participant; the user saw the same single entry again, so the missing halves
// are now written by the server after the model's turn. This file pins the two
// properties that make that safe: it fills only GAPS (never double-logs), and
// it never copies one person's body numbers onto the other.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { planSharedActivityFanout } from "@shared/shared-activity";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const SELF = { id: "p-self", name: "Poop", type: "self", fields: { weight: "200 lb" } };
const SARAH = { id: "p-sarah", name: "Sarah Miller", type: "person", fields: { weight: "130 lb" } };

type Row = Record<string, any>;
const db: { trackers: Row[]; entries: Row[] } = { trackers: [], entries: [] };

const SOCCER_FIELDS = [
  { name: "duration", type: "number", unit: "min" },
  { name: "intensity", type: "text" },
  { name: "caloriesBurned", type: "number", unit: "kcal" },
];

function reseed() {
  db.entries = [];
  db.trackers = [
    { id: "t-soccer-self", name: "Soccer", category: "fitness", unit: "min", linkedProfiles: [SELF.id], entries: [], fields: SOCCER_FIELDS },
    { id: "t-soccer-sarah", name: "Soccer", category: "fitness", unit: "min", linkedProfiles: [SARAH.id], entries: [], fields: SOCCER_FIELDS },
  ];
}

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF, SARAH],
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

const MSG = "Sarah and I both played soccer for 30 minutes this afternoon, pretty high intensity.";

let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  script = [];
  ({ processMessage } = await import("../server/ai-engine"));
});

describe("the server fills in the participant the model forgot", () => {
  it("turns one soccer entry into two — one per person, on each person's own tracker", async () => {
    // Exactly what the model did in the report: logged it once, for the user.
    script = [
      round(use("log_tracker_entry", { trackerName: "Soccer", values: { duration: 30, intensity: "high", caloriesBurned: 240, _notes: "played with Sarah this afternoon" } })),
      done("Logged."),
    ];
    const res = await processMessage(MSG, [], "u1");

    expect(db.entries).toHaveLength(2);
    const mine = db.entries.find((e) => e.trackerId === "t-soccer-self");
    const hers = db.entries.find((e) => e.trackerId === "t-soccer-sarah");
    expect(mine, "the user's own soccer entry").toBeTruthy();
    expect(hers, "Sarah's soccer entry — the one that used to go missing").toBeTruthy();
    expect(hers!.profileId).toBe(SARAH.id);

    // What they genuinely shared carries over.
    expect(hers!.values.duration).toBe(30);
    expect(hers!.values.intensity).toBe("high");

    // What belongs to one body does not. Sarah is lighter, so her burn is
    // lower — the two entries are different records, not one written twice.
    expect(hers!.values.caloriesBurned).not.toBe(240);
    expect(hers!.values.caloriesBurned).toBeLessThan(240);
    expect(hers!.values._notes).toBeUndefined();

    // And the user is told about it: a card and a checklist row, not a silent write.
    expect(res.operations?.filter((o: Row) => o.tool === "log_tracker_entry")).toHaveLength(2);
    expect(res.actions?.some((a: Row) => a.data?._ownerName === "Sarah Miller")).toBe(true);
    expect(res.reply).not.toMatch(/temporarily unavailable/);
  });

  it("adds nothing when the model already logged both people", async () => {
    script = [
      round(
        use("log_tracker_entry", { trackerName: "Soccer", values: { duration: 30, intensity: "high" } }),
        use("log_tracker_entry", { trackerName: "Soccer", forProfile: "Sarah Miller", values: { duration: 30, intensity: "high" } }),
      ),
      done(),
    ];
    await processMessage(MSG, [], "u1");
    expect(db.entries).toHaveLength(2);
  });

  it("leaves an ordinary single-person log alone", async () => {
    script = [round(use("log_tracker_entry", { trackerName: "Soccer", values: { duration: 30 } })), done()];
    await processMessage("I played soccer for 30 minutes", [], "u1");
    expect(db.entries).toHaveLength(1);
  });
});

describe("planSharedActivityFanout", () => {
  const self = { id: "p-self", name: "Poop", weightKg: 90 };
  const sarah = { id: "p-sarah", name: "Sarah Miller", weightKg: 60 };
  const resolveName = (n: string) => (/^sarah/i.test(n) ? sarah : null);

  it("plans the missing participant and scales the energy cost to their weight", () => {
    const plan = planSharedActivityFanout({
      userMessage: MSG,
      writes: [{ trackerName: "Soccer", profileId: null, values: { duration: 30, caloriesBurned: 240, steps: 3000, _notes: "with Sarah" } }],
      resolveName,
      selfProfile: self,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].forProfile).toBe("Sarah Miller");
    expect(plan[0].values.duration).toBe(30);
    expect(plan[0].values.caloriesBurned).toBe(160); // 240 × 60/90
    expect(plan[0].values.steps).toBeUndefined();
    expect(plan[0].values._notes).toBeUndefined();
  });

  it("omits the burn rather than inventing one when a weight is unknown", () => {
    const plan = planSharedActivityFanout({
      userMessage: MSG,
      writes: [{ trackerName: "Soccer", profileId: null, values: { duration: 30, caloriesBurned: 240 } }],
      resolveName: () => ({ id: "p-sarah", name: "Sarah Miller" }),
      selfProfile: { id: "p-self", name: "Poop" },
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].values.caloriesBurned).toBeUndefined();
    expect(plan[0].values.duration).toBe(30);
  });

  it("plans nothing when the turn wrote no entry for that activity", () => {
    expect(planSharedActivityFanout({
      userMessage: MSG,
      writes: [{ trackerName: "Hydration", profileId: null, values: { ounces: 24 } }],
      resolveName, selfProfile: self,
    })).toEqual([]);
    expect(planSharedActivityFanout({ userMessage: MSG, writes: [], resolveName, selfProfile: self })).toEqual([]);
  });

  it("plans nothing for a single-subject sentence or an unknown person", () => {
    const writes = [{ trackerName: "Soccer", profileId: null, values: { duration: 30 } }];
    expect(planSharedActivityFanout({ userMessage: "I played soccer for 30 minutes", writes, resolveName, selfProfile: self })).toEqual([]);
    expect(planSharedActivityFanout({ userMessage: "Mallory and I played soccer", writes, resolveName, selfProfile: self })).toEqual([]);
  });

  it("covers a shared activity between two other people, with no entry for the user", () => {
    const jane = { id: "p-jane", name: "Jane QA", weightKg: 70 };
    const plan = planSharedActivityFanout({
      userMessage: "Sarah and Jane played tennis for an hour",
      writes: [{ trackerName: "Tennis", profileId: "p-sarah", values: { duration: 60 } }],
      resolveName: (n) => (/^sarah/i.test(n) ? sarah : /^jane/i.test(n) ? jane : null),
      selfProfile: self,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0].forProfile).toBe("Jane QA");
  });
});
