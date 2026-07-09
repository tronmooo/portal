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

// BUG-20260709-tracker-dupkey — the trackers table has a UNIQUE (user_id, name)
// index, so creating a same-named tracker for a SECOND profile threw a raw
// duplicate-key error ("Bill ate a chicken sandwich and ran 2 miles" → both
// entries failed because a "Calories"/"Running" tracker already existed for
// Self). createTracker must disambiguate the name per profile and never let a
// name collision hard-fail a log.
function makeStorageDup(opts: {
  existing: Array<{ name: string; linkedProfiles: string[] }>;
  profiles?: Record<string, { id: string; name: string }>;
  enforceUnique?: boolean; // simulate the DB UNIQUE(user_id,name) constraint
}) {
  const captured: { inserts: any[] } = { inserts: [] };
  const committedNames = new Set(opts.existing.map((t) => t.name.toLowerCase()));
  const client: any = {
    from: (table: string) => ({
      insert: (row: any) => {
        if (table !== "trackers") return Promise.resolve({ error: null });
        captured.inserts.push(row);
        if (opts.enforceUnique && committedNames.has(String(row.name).toLowerCase())) {
          return Promise.resolve({ error: { code: "23505", message: `duplicate key value violates unique constraint "idx_trackers_name_user"` } });
        }
        committedNames.add(String(row.name).toLowerCase());
        return Promise.resolve({ error: null });
      },
    }),
  };
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  storage.supabase = client;
  storage.getTrackers = async () => opts.existing.map((t, i) => ({ id: `ex-${i}`, name: t.name, linkedProfiles: t.linkedProfiles, fields: [] }));
  storage.getSelfProfile = async () => ({ id: "self-1", type: "self" });
  storage.getProfile = async (id: string) => opts.profiles?.[id] ?? null;
  storage.linkProfileTo = async () => undefined;
  storage.logActivity = () => undefined;
  storage.getTracker = async () => ({ id: "new", name: captured.inserts[captured.inserts.length - 1]?.name, fields: [], entries: [] });
  return { storage, captured };
}

describe("createTracker — per-profile name disambiguation (dup-key fix)", () => {
  it("suffixes the profile name when the bare name is taken by another profile", async () => {
    const { storage, captured } = makeStorageDup({
      existing: [{ name: "Calories", linkedProfiles: ["self-1"] }],
      profiles: { "bill-1": { id: "bill-1", name: "Bill" } },
      enforceUnique: true,
    });
    const t = await storage.createTracker({ name: "Calories", category: "nutrition", fields: [{ name: "value", type: "number" }], linkedProfiles: ["bill-1"] } as any);
    // Must NOT insert the bare "Calories" (would violate the unique index).
    expect(captured.inserts.every((r) => r.name !== "Calories")).toBe(true);
    expect(captured.inserts[captured.inserts.length - 1].name).toBe("Calories - Bill");
    expect(t.name).toBe("Calories - Bill");
  });

  it("reuses the existing tracker when the SAME profile already has that name", async () => {
    const { storage, captured } = makeStorageDup({
      existing: [{ name: "Calories", linkedProfiles: ["bill-1"] }],
      profiles: { "bill-1": { id: "bill-1", name: "Bill" } },
    });
    const t = await storage.createTracker({ name: "Calories", category: "nutrition", fields: [], linkedProfiles: ["bill-1"] } as any);
    expect(captured.inserts.length).toBe(0); // dedup → no insert
    expect(t.name).toBe("Calories");
  });

  it("reuses the per-profile tracker when the bare name is passed but 'Name - Profile' exists", async () => {
    const { storage, captured } = makeStorageDup({
      existing: [
        { name: "Calories", linkedProfiles: ["self-1"] },
        { name: "Calories - Bob", linkedProfiles: ["bob-1"] },
      ],
      profiles: { "bob-1": { id: "bob-1", name: "Bob" } },
      enforceUnique: true,
    });
    const t = await storage.createTracker({ name: "Calories", category: "nutrition", fields: [], linkedProfiles: ["bob-1"] } as any);
    expect(captured.inserts.length).toBe(0); // reused, nothing inserted
    expect(t.name).toBe("Calories - Bob");
  });

  it("backstops a residual collision with a unique suffix instead of throwing", async () => {
    // getTrackers is stubbed empty so the pre-check can't catch it, but the DB
    // still rejects the bare name — the insert must retry with a unique suffix.
    const { storage } = makeStorageDup({
      existing: [],
      profiles: { "bill-1": { id: "bill-1", name: "Bill" } },
      enforceUnique: true,
    });
    await storage.createTracker({ name: "Running", category: "fitness", fields: [], linkedProfiles: ["bill-1"] } as any); // commits "Running" at the DB
    const t = await storage.createTracker({ name: "Running", category: "fitness", fields: [], linkedProfiles: ["bill-1"] } as any);
    expect(t.name).not.toBe("Running");
    expect(t.name.startsWith("Running")).toBe(true);
  });
});
