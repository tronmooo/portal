// One food = one entry, through the REAL chat loop (owner, 2026-11-22: "Eat a
// banana and a doughnut" was saved as one "Banana + Doughnut" entry — "these
// two should be separate, make sure this doesn't happen again").
//
// The model is scripted to do exactly what it did in production: ONE
// log_tracker_entry whose item joins both foods and whose numbers are the
// total. Only the model and the store are fakes; processMessage, the tool
// executor and server/meal-split.ts are the real ones.
import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const SELF = { id: "p-self", name: "Robert", type: "self", fields: {} };
const db: any = { entries: [], trackers: [], modelRequests: [], script: [] };

vi.mock("../server/storage", () => {
  const withEntries = (t: any) => ({ ...t, entries: db.entries.filter((e: any) => e.trackerId === t.id) });
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF],
    getSelfProfile: async () => SELF,
    getTrackers: async () => db.trackers.map(withEntries),
    getTracker: async (id: string) => { const t = db.trackers.find((x: any) => x.id === id); return t ? withEntries(t) : undefined; },
    getTrackerEntry: async (id: string) => db.entries.find((e: any) => e.id === id),
    logEntry: async (data: any) => {
      const n = db.entries.length + 1;
      const entry = { id: `e${n}`.padEnd(8, "0") + "-0000-4000-8000-000000000000", trackerId: data.trackerId, values: data.values, profileId: data.profileId || null, timestamp: data.timestamp || new Date().toISOString(), computed: {} };
      db.entries.push(entry);
      return entry;
    },
    updateTrackerEntry: async (_tid: string, eid: string, patch: any) => {
      const e = db.entries.find((x: any) => x.id === eid);
      if (!e) return undefined;
      if (patch.values) e.values = { ...e.values, ...patch.values };
      if (patch.computed) e.computed = { ...e.computed, ...patch.computed };
      return e;
    },
    getPreference: async () => null,
    createAiActionLog: async (row: any) => ({ id: "log1", ...row }),
  };
  const storage = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (/^(create|update|delete|log|checkin|complete|set|save)/.test(prop)) return async () => undefined;
      return async () => [];
    },
  });
  return { storage };
});

const msg = (stop_reason: string, content: any[]) => ({
  id: "m", type: "message", role: "assistant", model: "x", stop_reason, usage: { input_tokens: 1, output_tokens: 1 }, content,
});
const RESPONSES: Record<string, () => any> = {
  // What the model sent in production.
  combined: () => msg("tool_use", [
    { type: "tool_use", id: "t1", name: "log_tracker_entry", input: { trackerName: "Calories", values: { item: "Banana + Doughnut", calories: 355, protein: 4, carbs: 76, fat: 13 } } },
  ]),
  // What the prompt now asks for.
  separate: () => msg("tool_use", [
    { type: "tool_use", id: "s1", name: "log_tracker_entry", input: { trackerName: "Calories", values: { item: "Banana", calories: 105, protein: 1, carbs: 27, fat: 0 } } },
    { type: "tool_use", id: "s2", name: "log_tracker_entry", input: { trackerName: "Calories", values: { item: "Doughnut", calories: 250, protein: 3, carbs: 31, fat: 13 } } },
  ]),
  oneDish: () => msg("tool_use", [
    { type: "tool_use", id: "d1", name: "log_tracker_entry", input: { trackerName: "Calories", values: { item: "Mac and Cheese", calories: 310, protein: 12, carbs: 40, fat: 11 } } },
  ]),
  summary: () => msg("end_turn", [{ type: "text", text: "Logged your banana and doughnut." }]),
};

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (req: any) => {
        if (!req?.tools) throw new Error("side model call unavailable in this test");
        db.modelRequests.push(JSON.parse(JSON.stringify(req)));
        const next = db.script.shift();
        if (!next) throw new Error("model script exhausted");
        return RESPONSES[next]();
      },
      stream: () => { throw new Error("streaming not used in this test"); },
    };
  },
}));

const foodEntries = () => db.entries.filter((e: any) => e.trackerId === "t-cal");
const items = () => foodEntries().map((e: any) => e.values.item);

let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
beforeEach(async () => {
  db.entries = [];
  db.trackers = [{
    id: "t-cal", name: "Calories", category: "nutrition", unit: "kcal", linkedProfiles: [SELF.id],
    fields: [
      { name: "calories", type: "number", unit: "kcal", isPrimary: true },
      { name: "protein", type: "number", unit: "g" }, { name: "carbs", type: "number", unit: "g" },
      { name: "fat", type: "number", unit: "g" }, { name: "item", type: "text" },
    ],
  }];
  db.modelRequests = [];
  db.script = [];
  ({ processMessage } = await import("../server/ai-engine"));
});

describe("'Eat a banana and a doughnut'", () => {
  it("a combined 'Banana + Doughnut' call is saved as two entries, each with its own card", async () => {
    db.script = ["combined", "summary"];
    const res = await processMessage("Eat a banana and a doughnut", [], "u1");
    expect(items()).toEqual(["Banana", "Doughnut"]);
    // Nothing carries the joined name or the meal total.
    expect(JSON.stringify(db.entries)).not.toContain("Banana + Doughnut");
    for (const e of foodEntries()) {
      expect(e.values.calories).toBeGreaterThan(0);
      expect(e.values.calories).toBeLessThan(355);
    }
    // One card (and one undo target) per food.
    const cards = (res.actions as any[]).filter((a) => a.data?._tool === "log_tracker_entry");
    expect(cards.map((a) => a.data.values.item)).toEqual(["Banana", "Doughnut"]);
    expect(new Set(cards.map((a) => a.data._entityId)).size).toBe(2);
    expect(String(res.reply)).not.toMatch(/nothing was saved|wasn't able/i);
    // If the model was asked for another round, it got ONE result under the id it sent.
    for (const req of db.modelRequests.slice(1)) {
      const results = req.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === "tool_result");
      expect(results.map((r: any) => r.tool_use_id)).toEqual(["t1"]);
    }
  });

  it("two separate calls are two entries with the model's own numbers", async () => {
    db.script = ["separate", "summary"];
    await processMessage("Eat a banana and a doughnut", [], "u1");
    expect(items()).toEqual(["Banana", "Doughnut"]);
  });

  it("a single dish with 'and' in its name stays one entry", async () => {
    db.script = ["oneDish", "summary"];
    await processMessage("I ate mac and cheese", [], "u1");
    expect(items()).toEqual(["Mac and Cheese"]);
  });
});
