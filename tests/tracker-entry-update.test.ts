import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

// Regression for "Update failed — 404: Entry not found" when editing a tracker
// entry. The live column is `entry_values` (not `values` — a SQL reserved word
// that was renamed). updateTrackerEntry used to read/write `values`, so the
// UPDATE hit a non-existent column, errored, and the route 404'd.
//
// We inject a fake Supabase client that records the UPDATE payload, so we can
// prove the method now reads/writes `entry_values` and that edits, added
// fields, and deleted fields all flow through to the persisted row.

function makeMockSupabase(existingRow: any) {
  const captured: { updatePayload: any; tables: string[] } = { updatePayload: null, tables: [] };
  const from = (table: string) => {
    captured.tables.push(table);
    const b: any = {
      _isUpdate: false,
      select() { return b; },
      update(payload: any) { b._isUpdate = true; captured.updatePayload = payload; return b; },
      eq() { return b; },
      is() { return b; },
      async maybeSingle() {
        if (b._isUpdate) {
          // Simulate the DB returning the row after the patch is applied.
          return { data: { ...existingRow, ...captured.updatePayload }, error: null };
        }
        return { data: existingRow, error: null };
      },
    };
    return b;
  };
  return { client: { from }, captured };
}

function makeStorage(existingRow: any) {
  // Build via the prototype so we skip the real constructor (which spins up a
  // shared Supabase client). Inject the mock + a stub getTracker.
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  const { client, captured } = makeMockSupabase(existingRow);
  storage.supabase = client;
  storage.getTracker = async () => ({
    id: "tracker-1", name: "Sleep", category: "sleep",
    fields: [{ name: "hours", type: "number", isPrimary: true }, { name: "quality", type: "text" }],
  });
  return { storage, captured };
}

describe("SupabaseStorage.updateTrackerEntry — the 404 fix", () => {
  const existingRow = {
    id: "entry-1",
    tracker_id: "tracker-1",
    user_id: "user-1",
    entry_values: { hours: 8, quality: "excellent", wakeTime: "5:30 AM" },
    computed: { validated: true },
    notes: "old note",
    timestamp: "2026-04-10T10:00:00.000Z",
  };

  it("writes to `entry_values` (never the non-existent `values` column)", async () => {
    const { storage, captured } = makeStorage(existingRow);
    await storage.updateTrackerEntry("tracker-1", "entry-1", { values: { hours: 7 } });
    expect(captured.updatePayload).toBeTruthy();
    expect(captured.updatePayload.entry_values).toBeDefined();
    expect("values" in captured.updatePayload).toBe(false); // the old bug wrote here
  });

  it("edits a field, adds a field, and deletes a field in one save", async () => {
    const { storage, captured } = makeStorage(existingRow);
    const result = await storage.updateTrackerEntry("tracker-1", "entry-1", {
      values: { hours: 7, quality: "good", bedtime: "11:00 PM" }, // edit + add
      valuesToDelete: ["wakeTime"],                                // delete
      notes: "updated",
    });
    // Persisted payload reflects all three operations.
    expect(captured.updatePayload.entry_values).toEqual({ hours: 7, quality: "good", bedtime: "11:00 PM" });
    expect(captured.updatePayload.entry_values.wakeTime).toBeUndefined();
    expect(captured.updatePayload.notes).toBe("updated");
    // Returned entry is in the standard shape with the merged values.
    expect(result).toBeTruthy();
    expect(result.id).toBe("entry-1");
    expect(result.values).toEqual({ hours: 7, quality: "good", bedtime: "11:00 PM" });
    expect(result.notes).toBe("updated");
  });

  it("recomputes derived data from the new values", async () => {
    const { storage, captured } = makeStorage(existingRow);
    await storage.updateTrackerEntry("tracker-1", "entry-1", { values: { hours: 6 } });
    // computed is refreshed (object present) rather than left stale/blank.
    expect(captured.updatePayload.computed).toBeDefined();
  });

  it("returns undefined (→ 404) only when the entry truly doesn't exist", async () => {
    const storage: any = Object.create(SupabaseStorage.prototype);
    storage.userId = "user-1";
    storage.supabase = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) }) };
    storage.getTracker = async () => null;
    const result = await storage.updateTrackerEntry("tracker-1", "missing", { values: { hours: 7 } });
    expect(result).toBeUndefined();
  });
});
