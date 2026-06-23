import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

// Universal tracker engine: creating a tracker must NEVER fail over field shape
// or an optional column that a deployment hasn't migrated (the "Soccer/Tennis
// trackers failed to create — server schema error" report). These tests inject
// a fake Supabase client and assert createTracker:
//  - sanitizes arbitrary AI field types into the valid enum,
//  - omits metric_definition when not supplied,
//  - retries with base columns if the optional column is rejected.

function makeStorage(opts: { rejectMetricDef?: boolean }) {
  const captured: { inserts: any[] } = { inserts: [] };
  const trackersInsert = (row: any) => {
    captured.inserts.push(row);
    if (opts.rejectMetricDef && "metric_definition" in row) {
      return Promise.resolve({ error: { message: "Could not find the 'metric_definition' column of 'trackers' in the schema cache" } });
    }
    return Promise.resolve({ error: null });
  };
  const client: any = {
    from: (table: string) => ({
      insert: (row: any) => (table === "trackers" ? trackersInsert(row) : Promise.resolve({ error: null })),
      // junction-table link inserts + any other calls succeed quietly
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  };
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  storage.supabase = client;
  // Avoid touching real queries from the dedup + post-create refetch + linking.
  storage.getTrackers = async () => [];
  storage.getSelfProfile = async () => ({ id: "self-1", type: "self" });
  storage.linkProfileTo = async () => undefined;
  storage.logActivity = () => undefined;
  storage.getTracker = async () => ({
    id: captured.inserts[0]?.id, name: captured.inserts[0]?.name,
    category: captured.inserts[0]?.category, fields: captured.inserts[0]?.fields || [], entries: [],
  });
  return { storage, captured };
}

describe("SupabaseStorage.createTracker — universal, schema-error-proof", () => {
  it("sanitizes arbitrary AI field types into the valid enum (never rejects)", async () => {
    const { storage, captured } = makeStorage({});
    await storage.createTracker({
      name: "Soccer", category: "fitness",
      fields: [
        { name: "duration", type: "number" },
        { name: "sport", type: "string" },   // invalid type → coerced to text
        { name: "intensity", type: "time" }, // invalid type → coerced to text
        { name: "", type: "number" },         // empty name → dropped
        { foo: "bar" },                         // junk → dropped
      ],
    } as any);
    const inserted = captured.inserts[0];
    expect(inserted.fields).toEqual([
      { name: "duration", type: "number" },
      { name: "sport", type: "text" },
      { name: "intensity", type: "text" },
    ]);
  });

  it("omits metric_definition when not supplied", async () => {
    const { storage, captured } = makeStorage({});
    await storage.createTracker({ name: "Tennis", category: "fitness", fields: [{ name: "duration", type: "number" }] } as any);
    expect("metric_definition" in captured.inserts[0]).toBe(false);
  });

  it("retries with base columns if the optional column is rejected", async () => {
    const { storage, captured } = makeStorage({ rejectMetricDef: true });
    await storage.createTracker({
      name: "Custom", category: "custom",
      fields: [{ name: "value", type: "number" }],
      metricDefinition: { dataType: "count" },
    } as any);
    // First insert had metric_definition (rejected); second retried without it.
    expect("metric_definition" in captured.inserts[0]).toBe(true);
    expect("metric_definition" in captured.inserts[1]).toBe(false);
    expect(captured.inserts[1].name).toBe("Custom");
  });
});
