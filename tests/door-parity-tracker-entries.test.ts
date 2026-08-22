// ─── Door parity: tracker entries ───────────────────────────────────────────
//
// The value rules for logging a tracker entry used to split by door: the REST
// route carried the guards (numeric coercion, sanity bounds) but no
// normalization and no implied writes beyond the storage-level habit
// auto-checkin; the chat path carried normalization, dedup and goal progress
// but no guards. server/actions/tracker-entry-service.ts +
// shared/tracker-entry-guards.ts now hold one pipeline. These tests pin it.
import { describe, it, expect } from "vitest";
import { executeTool } from "../server/ai-engine";
import {
  prepareTrackerEntryValues,
  logPreparedEntry,
} from "../server/actions/tracker-entry-service";
import { guardTrackerEntryValues } from "@shared/tracker-entry-guards";
import { MemStorage, driveDoor, withStorage, normalizeManifest, ledgerRows } from "./door-parity/harness";

let seq = 0;
const nextUser = () => `door-parity-te-${++seq}`;

async function seedWeightTracker(store: MemStorage) {
  return store.createTracker({
    name: "Weight",
    category: "health",
    fields: [{ name: "weight", type: "number", unit: "lbs" }],
  } as any);
}

/** What the REST handler runs (POST /api/trackers/:id/entries). */
async function restLog(store: MemStorage, tracker: any, values: Record<string, any>, dedupWindowMs = 15_000) {
  const prepared = await prepareTrackerEntryValues(store, tracker, values);
  if (prepared.error) return { error: prepared.error, field: prepared.field };
  return logPreparedEntry(store, tracker, { values: prepared.values }, { dedupWindowMs });
}

describe("door parity — tracker entry values", () => {
  it("chat and REST store the same normalized entry for the same input", async () => {
    for (const door of ["chat", "rest"] as const) {
      const store = new MemStorage();
      const tracker = await seedWeightTracker(store);
      const outcome = await driveDoor(store, door, "log_tracker_entry",
        { trackerName: "Weight", values: { weight: "182 lbs" } },
        async () => {
          if (door === "chat") {
            return executeTool("log_tracker_entry", { trackerName: "Weight", values: { weight: "182 lbs" } }, nextUser());
          }
          return restLog(store, tracker, { weight: "182 lbs" });
        });
      expect(outcome.ok, `${door}: ok`).toBe(true);
      const stored = await withStorage(store, () => store.getTracker(tracker.id));
      expect(stored?.entries, `${door}: one entry`).toHaveLength(1);
      // Unit suffix stripped, string coerced — identical shape either door.
      expect(stored?.entries[0].values.weight, `${door}: normalized`).toBe(182);
      expect(normalizeManifest(outcome.mutations), `${door}: manifest`).toEqual([
        { op: "create", entityType: "trackerEntry", endpoint: null, domains: ["habits", "trackers"] },
      ]);
      expect((await ledgerRows(store))[0], `${door}: ledger`).toEqual({
        tool: "log_tracker_entry", source: door, entityType: "trackerEntry", reversible: true,
      });
    }
  });

  it("the guards now apply to every door — chat can no longer log a 5,000-lb weigh-in", async () => {
    const store = new MemStorage();
    await seedWeightTracker(store);
    const chatResult = await withStorage(store, () =>
      executeTool("log_tracker_entry", { trackerName: "Weight", values: { weight: 5000 } }, nextUser()));
    expect(chatResult?.error).toMatch(/unrealistic/);
    const trackers = await withStorage(store, () => store.getTrackers());
    expect(trackers[0].entries).toHaveLength(0);
  });

  it("guards reject the classic REST failure cases identically", () => {
    const fields = [{ name: "weight", type: "number" }, { name: "calories", type: "number" }];
    expect(guardTrackerEntryValues(fields, { weight: "Chicken Sandwich" })?.error).toMatch(/expects a number/);
    expect(guardTrackerEntryValues(fields, { weight: null })?.error).toMatch(/At least one value/);
    expect(guardTrackerEntryValues(fields, { weight: -5 })?.error).toMatch(/negative/);
    expect(guardTrackerEntryValues(fields, { calories: 50000 })?.error).toMatch(/unrealistic/);
    expect(guardTrackerEntryValues(fields, { weight: 900 }, { isPetTracker: true })?.error).toMatch(/Pet weight/);
    const values: Record<string, any> = { weight: "182 lbs" };
    expect(guardTrackerEntryValues(fields, values)).toBeNull();
    expect(values.weight).toBe(182);
  });

  it("the duplicate window guards both doors; a dedupe claims no create", async () => {
    const store = new MemStorage();
    const tracker = await seedWeightTracker(store);
    const first = await restLog(store, tracker, { weight: 182 });
    expect((first as any).error).toBeUndefined();
    const fresh = await store.getTracker(tracker.id);
    const replay = await restLog(store, fresh, { weight: 182 });
    expect((replay as any).deduped).toBe(true);
    expect((await store.getTracker(tracker.id))?.entries).toHaveLength(1);
  });

  it("an entry advances its linked goal from EVERY door (previously chat-only)", async () => {
    const store = new MemStorage();
    const tracker = await store.createTracker({
      name: "Running",
      category: "fitness",
      fields: [{ name: "distance", type: "number", unit: "mi" }],
    } as any);
    const goal = await store.createGoal({
      title: "Run 20 miles", target: 20, current: 0, unit: "mi",
      trackerId: tracker.id, status: "active",
    } as any);
    const logged = await restLog(store, tracker, { distance: 5 });
    expect((logged as any).error).toBeUndefined();
    const after = (await store.getGoals()).find((g) => g.id === goal.id);
    expect(after?.current).toBe(5);
  });
});
