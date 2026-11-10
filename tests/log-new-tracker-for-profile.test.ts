// Logging to a tracker that doesn't exist yet must CREATE it — even when the
// call names a profile.
//
// Regression source (2026-11-10, user report): "log sleep / headache / walking"
// came back in chat as three red ✗ lines — "I couldn't find a tracker named
// 'Sleep' for any profile. Which tracker did you mean? Available: Driving,
// Weight, …". log_tracker_entry refused any explicitly-profiled log whose
// tracker didn't exist yet, instead of auto-creating it like the unprofiled
// path does. This drives the REAL executeTool against in-memory storage.
import { describe, it, expect, beforeEach, vi } from "vitest";

const SELF = { id: "p-self", name: "Me", type: "self", fields: {} };
const BOB = { id: "p-bob", name: "Bob", type: "person", fields: {} };

const db: { trackers: any[]; entries: any[] } = { trackers: [], entries: [] };

function reseed() {
  db.entries = [];
  db.trackers = [
    { id: "t-drive", name: "Driving", category: "custom", unit: "mi", fields: [{ name: "distance", type: "number", unit: "mi" }], linkedProfiles: [SELF.id] },
    { id: "t-weight", name: "Weight", category: "health", unit: "lbs", fields: [{ name: "weight", type: "number", unit: "lbs" }], linkedProfiles: [SELF.id] },
  ];
}

vi.mock("../server/storage", () => {
  const withEntries = (t: any) => ({ ...t, entries: db.entries.filter((e) => e.trackerId === t.id) });
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF, BOB],
    getSelfProfile: async () => SELF,
    getTrackers: async () => db.trackers.map(withEntries),
    getTracker: async (id: string) => {
      const t = db.trackers.find((x) => x.id === id);
      return t ? withEntries(t) : undefined;
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
      const t = { id: `t-new-${db.trackers.length + 1}`, linkedProfiles: [], ...data };
      db.trackers.push(t);
      return withEntries(t);
    },
    updateTracker: async (id: string, patch: any) => {
      const t = db.trackers.find((x) => x.id === id);
      if (!t) return undefined;
      Object.assign(t, patch);
      return withEntries(t);
    },
    getPreference: async () => null,
  };
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
      create: async () => { throw new Error("model must not be called"); },
      stream: () => { throw new Error("model must not be called"); },
    };
  },
}));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

describe("log_tracker_entry with a named profile and a brand-new tracker", () => {
  for (const [trackerName, values] of [
    ["Sleep", { hours: 7 }],
    ["Headache", { severity: 4 }],
    ["Walking", { distance: 2 }],
  ] as const) {
    it(`creates "${trackerName}" for the named profile instead of refusing`, async () => {
      const res = await executeTool("log_tracker_entry", {
        trackerName, values: { ...values }, forProfile: "Me", __userMessage: `log ${trackerName.toLowerCase()}`,
      }, "u1");
      expect(typeof res).toBe("object");
      expect(res.error).toBeUndefined();
      expect(JSON.stringify(res)).not.toMatch(/couldn't find a tracker/i);
      const created = db.trackers.find((t) => t.name.toLowerCase() === trackerName.toLowerCase());
      expect(created).toBeDefined();
      expect(db.entries).toHaveLength(1);
      expect(db.entries[0].trackerId).toBe(created.id);
    });
  }

  it("a new tracker for another named profile is owned by that profile", async () => {
    const res = await executeTool("log_tracker_entry", {
      trackerName: "Sleep", values: { hours: 9 }, forProfile: "Bob", __userMessage: "Bob slept 9 hours",
    }, "u1");
    expect(res.error).toBeUndefined();
    const created = db.trackers.find((t) => t.name === "Sleep");
    expect(created).toBeDefined();
    expect(created.linkedProfiles).toContain(BOB.id);
    expect(created.linkedProfiles).not.toContain(SELF.id);
  });

  it("a named profile that doesn't exist is still refused (nothing lands on Self)", async () => {
    const res = await executeTool("log_tracker_entry", {
      trackerName: "Sleep", values: { hours: 7 }, forProfile: "Nobody", __userMessage: "Nobody slept 7 hours",
    }, "u1");
    expect(res.error).toMatch(/couldn't find a profile named 'Nobody'/);
    expect(db.entries).toHaveLength(0);
  });
});
