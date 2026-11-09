// 2026-11-09 report: "BP 124/78 with a resting heart rate of 59, and I had 2
// eggs and toast for breakfast" logged everything but left a duplicate
// "Heart Rate 42c7" tracker next to "Heart Rate".
//
// Three things combined:
//   1. the Blood Pressure call and the model's own Heart Rate call ran in
//      PARALLEL (different scheduling keys), yet the BP call also logs a Heart
//      Rate entry (the pulse split-out / dropped-HR rescue);
//   2. that rescue fired even though the message already had its own Heart
//      Rate call, so the reading was written twice;
//   3. the duplicate-key backstop in createTracker re-read trackers through the
//      request memo, never saw the race winner, and suffixed the name.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

const SELF = { id: "p-self", name: "Robert", type: "self", fields: {} };
const db: any = {};

function reseed() {
  db.entries = [];
  db.trackers = [
    { id: "t-bp", name: "Blood Pressure", category: "health", unit: "mmHg", fields: [{ name: "systolic", type: "number" }, { name: "diastolic", type: "number" }], linkedProfiles: [SELF.id] },
    { id: "t-hr", name: "Heart Rate", category: "health", unit: "bpm", fields: [{ name: "bpm", type: "number", unit: "bpm" }], linkedProfiles: [SELF.id] },
  ];
}

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
      const entry = { id: `e${db.entries.length + 1}`, trackerId: data.trackerId, values: data.values, profileId: data.profileId || null, timestamp: data.timestamp || new Date().toISOString(), computed: {} };
      db.entries.push(entry); return entry;
    },
    updateTrackerEntry: async (_tid: string, eid: string, patch: any) => { const e = db.entries.find((x: any) => x.id === eid); if (!e) return undefined; e.values = { ...e.values, ...(patch.values || {}) }; return e; },
    getPreference: async () => null,
    createAiActionLog: async (row: any) => ({ id: "log1", ...row }),
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

const MSG = "BP 124/78 with a resting heart rate of 59, and I had 2 eggs and toast for breakfast";
const hrEntries = () => db.entries.filter((e: any) => e.trackerId === "t-hr");
const bpEntries = () => db.entries.filter((e: any) => e.trackerId === "t-bp");

let ai: typeof import("../server/ai-engine");
beforeEach(async () => {
  reseed();
  ai = await import("../server/ai-engine");
});

describe("BP + heart rate in one message", () => {
  it("Blood Pressure and Heart Rate calls never run concurrently", () => {
    const key = (trackerName: string) => ai.toolInterferenceKey({ id: Math.random().toString(36), name: "log_tracker_entry", input: { trackerName } });
    expect(key("Blood Pressure")).toBe(key("Heart Rate"));
    expect(key("BP")).toBe(key("Resting Heart Rate"));
    expect(key("Pulse")).toBe(key("Blood Pressure"));
    // …but unrelated trackers still run in parallel with them.
    expect(key("Blood Pressure")).not.toBe(key("Nutrition"));
    expect(key("Heart Rate")).not.toBe(key("Weight"));
  });

  it("recognises a separate Heart Rate call in the batch", () => {
    expect(ai.callsLogHeartRateSeparately([
      { name: "log_tracker_entry", input: { trackerName: "Blood Pressure", values: { systolic: 124, diastolic: 78 } } },
      { name: "log_tracker_entry", input: { trackerName: "Heart Rate", values: { bpm: 59 } } },
    ])).toBe(true);
    expect(ai.callsLogHeartRateSeparately([
      { name: "log_tracker_entry", input: { trackerName: "Blood Pressure", values: { systolic: 124, diastolic: 78 } } },
      { name: "log_tracker_entry", input: { trackerName: "Nutrition", values: { item: "2 eggs and toast" } } },
    ])).toBe(false);
  });

  it("the model's two calls log the heart rate exactly once, on the existing tracker", async () => {
    const ctx = { __userMessage: MSG, __heartRateLoggedSeparately: true };
    const bp = await ai.executeTool("log_tracker_entry", { trackerName: "Blood Pressure", values: { systolic: 124, diastolic: 78 }, ...ctx }, "u1");
    // The BP call leaves the pulse to the Heart Rate call — it writes nothing there.
    expect(hrEntries()).toHaveLength(0);
    const hr = await ai.executeTool("log_tracker_entry", { trackerName: "Heart Rate", values: { bpm: 59 }, ...ctx }, "u1");
    expect(bp.error).toBeUndefined();
    expect(hr.error).toBeUndefined();
    expect(bpEntries()).toHaveLength(1);
    expect(hrEntries()).toHaveLength(1);
    expect(hrEntries()[0].values.bpm).toBe(59);
    expect(db.trackers).toHaveLength(2);
  });

  it("a BP call alone still rescues the heart rate from the message", async () => {
    const bp = await ai.executeTool("log_tracker_entry", { trackerName: "Blood Pressure", values: { systolic: 124, diastolic: 78 }, __userMessage: MSG }, "u1");
    expect(bp.error).toBeUndefined();
    expect(hrEntries()).toHaveLength(1);
    expect(hrEntries()[0].values.bpm).toBe(59);
  });
});

describe("createTracker duplicate-key backstop reads past the request memo", () => {
  it("reuses the tracker a concurrent create just committed instead of suffixing", async () => {
    const rows: any[] = [];
    const inserts: any[] = [];
    const client: any = {
      from: (table: string) => ({
        insert: (row: any) => {
          if (table !== "trackers") return Promise.resolve({ error: null });
          inserts.push(row);
          if (inserts.length === 1) {
            // A concurrent request committed "Heart Rate" after our pre-check.
            rows.push({ id: "winner", name: "Heart Rate", linkedProfiles: [SELF.id], fields: [] });
            return Promise.resolve({ error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_trackers_name_owner"' } });
          }
          return Promise.resolve({ error: null });
        },
      }),
    };
    const storage: any = Object.create(SupabaseStorage.prototype);
    storage.userId = "user-1";
    storage.supabase = client;
    storage.memoEnabled = true;
    storage.memoCache = new Map();
    storage._getTrackersImpl = async () => rows.map((r) => ({ ...r }));
    storage.resolveOwnersAndValidate = async () => [SELF.id];
    storage.getProfile = async () => SELF;
    storage.linkProfileTo = async () => undefined;
    storage.logActivity = () => undefined;
    storage.getTracker = async (id: string) => ({ id, name: inserts[inserts.length - 1]?.name, fields: [], entries: [] });

    const t = await storage.createTracker({ name: "Heart Rate", category: "health", fields: [{ name: "bpm", type: "number" }], linkedProfiles: [SELF.id] });
    expect(t.id).toBe("winner");
    expect(inserts).toHaveLength(1);
    expect(inserts.some((r) => /^Heart Rate \w{4}$/.test(r.name))).toBe(false);
  });
});
