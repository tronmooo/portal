import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

// Regression for the production skeleton-stall / 409 storm (deploy 1c13daa era).
// getTrackers() ran healOwnerSuffixedTrackerNames(), which PATCHed the tracker
// `name` column on EVERY read to strip a legacy "<Name> - <Owner>" suffix. When
// two trackers strip to the same canonical name (e.g. "Weight - Craig" and an
// existing "Weight"), the rename collided with the partial unique index
// idx_trackers_name_user (user_id, name) WHERE deleted_at IS NULL → 409. The
// failed write never healed the suffix, so every dashboard/getTrackers load
// re-fired the rejected PATCH and stalled the response.
//
// The fix makes the heal DISPLAY-ONLY: names are canonicalized in memory, the
// read path issues ZERO tracker writes. These tests inject a mock Supabase
// client that records any `.update()` against the trackers table and prove reads
// never mutate — even when two trackers canonicalize to a duplicate name.

type TrackerRow = {
  id: string;
  user_id: string;
  name: string;
  category?: string;
  fields?: any[];
  linked_profiles?: string[];
  created_at?: string;
};

function makeMockSupabase(trackerRows: TrackerRow[]) {
  const captured = { trackerUpdates: 0, updatePayloads: [] as any[], tablesUpdated: [] as string[] };

  const from = (table: string) => {
    const rows = table === "trackers" ? trackerRows : [];
    // A thenable query builder: chainable filters, awaits to { data, error }.
    const builder: any = {
      _op: "select" as "select" | "update",
      select() { return builder; },
      update(payload: any) {
        builder._op = "update";
        if (table === "trackers") {
          captured.trackerUpdates++;
          captured.updatePayloads.push(payload);
        }
        captured.tablesUpdated.push(table);
        return builder;
      },
      eq() { return builder; },
      is() { return builder; },
      gte() { return builder; },
      order() { return builder; },
      or() { return builder; },
      contains() { return builder; },
      then(resolve: (v: any) => any) {
        // Updates resolve to a no-op success; selects resolve to the rows.
        if (builder._op === "update") return resolve({ data: null, error: null });
        return resolve({ data: rows, error: null });
      },
    };
    return builder;
  };

  return { client: { from }, captured };
}

function makeStorage(trackerRows: TrackerRow[], profiles: Array<{ id: string; name: string }>) {
  // Build via the prototype to skip the real constructor (shared Supabase client).
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  const { client, captured } = makeMockSupabase(trackerRows);
  storage.supabase = client;
  // heal() reads profile names to know which owner suffix to strip.
  storage.getProfiles = async () => profiles;
  return { storage, captured };
}

describe("SupabaseStorage.getTrackers — reads never mutate trackers", () => {
  it("issues ZERO tracker PATCH/update calls on an ordinary read", async () => {
    const { storage, captured } = makeStorage(
      [
        { id: "t1", user_id: "user-1", name: "Weight - Craig", linked_profiles: ["p1"], fields: [] },
        { id: "t2", user_id: "user-1", name: "Steps", linked_profiles: ["p1"], fields: [] },
      ],
      [{ id: "p1", name: "Craig" }],
    );

    const trackers = await storage.getTrackers();

    expect(captured.trackerUpdates).toBe(0);
    expect(captured.tablesUpdated).not.toContain("trackers");
    // Display name is still canonicalized in memory.
    expect(trackers.find((t: any) => t.id === "t1").name).toBe("Weight");
    expect(trackers.find((t: any) => t.id === "t2").name).toBe("Steps");
  });

  it("does NOT write when two trackers canonicalize to a duplicate name", async () => {
    // "Weight - Craig" strips to "Weight", colliding with the existing "Weight".
    // The old code PATCHed both → 409 duplicate key on (user_id, name). The fix
    // resolves the collision in display only, with no writes.
    const { storage, captured } = makeStorage(
      [
        { id: "t1", user_id: "user-1", name: "Weight", linked_profiles: ["p1"], fields: [] },
        { id: "t2", user_id: "user-1", name: "Weight - Craig", linked_profiles: ["p1"], fields: [] },
      ],
      [{ id: "p1", name: "Craig" }],
    );

    const trackers = await storage.getTrackers();

    expect(captured.trackerUpdates).toBe(0);
    expect(captured.updatePayloads).toHaveLength(0);
    // Both display as "Weight" — a pure in-memory result, never persisted.
    expect(trackers.map((t: any) => t.name).sort()).toEqual(["Weight", "Weight"]);
  });

  it("getTracker (single read) also issues zero tracker writes", async () => {
    const row: TrackerRow = { id: "t1", user_id: "user-1", name: "Weight - Craig", linked_profiles: ["p1"], fields: [] };
    const { storage, captured } = makeStorage([row], [{ id: "p1", name: "Craig" }]);
    // getTracker uses .single(); give the builder that terminal too.
    const origFrom = storage.supabase.from;
    storage.supabase.from = (table: string) => {
      const b = origFrom(table);
      b.single = async () => (table === "trackers" ? { data: row, error: null } : { data: null, error: null });
      return b;
    };

    const tracker = await storage.getTracker("t1");

    expect(captured.trackerUpdates).toBe(0);
    expect(tracker.name).toBe("Weight");
  });
});
