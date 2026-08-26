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
  it("gives the second profile the SAME plain name, no owner suffix", async () => {
    // CONTRACT CHANGE (migrations/20260824_tracker_owner_scoped_names.sql): the
    // unique index is now (user_id, owner_profile_id, lower(name)), so Bill's
    // Calories tracker is simply "Calories". This test previously asserted
    // "Calories - Bill" — that suffix only existed to dodge the old
    // account-wide UNIQUE (user_id, name), and the mangled name then had to be
    // stripped back off on every read.
    const { storage, captured } = makeStorageDup({
      existing: [{ name: "Calories", linkedProfiles: ["self-1"] }],
      profiles: { "bill-1": { id: "bill-1", name: "Bill" } },
    });
    const t = await storage.createTracker({ name: "Calories", category: "nutrition", fields: [{ name: "value", type: "number" }], linkedProfiles: ["bill-1"] } as any);
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0].name).toBe("Calories");
    expect(captured.inserts[0].linked_profiles).toEqual(["bill-1"]);
    expect(t.name).toBe("Calories");
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

  it("reuses a LEGACY 'Name - Profile' row rather than giving that owner a second tracker", async () => {
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

// ── Owner-scoped tracker identity ───────────────────────────────────────────
// Tracker identity is OWNER + NAME, not account + name (migrations/20260824_
// tracker_owner_scoped_names.sql). Bob can have a Running tracker, Sarah can
// have a Running tracker, and neither is a duplicate of the other.
function makeOwnerStorage(existing: any[]) {
  const captured: { inserts: any[] } = { inserts: [] };
  const client: any = {
    from: (table: string) => ({
      insert: (row: any) => {
        if (table === "trackers") captured.inserts.push(row);
        return Promise.resolve({ error: null });
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  };
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = "user-1";
  storage.supabase = client;
  storage.getTrackers = async () => existing;
  storage.getSelfProfile = async () => ({ id: "self-1", type: "self" });
  storage.getProfile = async (id: string) => ({ id, name: id === "bob-1" ? "Bob" : "Sarah Miller" });
  storage.linkProfileTo = async () => undefined;
  storage.logActivity = () => undefined;
  storage.getTracker = async () => ({ id: captured.inserts[0]?.id, name: captured.inserts[0]?.name, entries: [] });
  return { storage, captured };
}

describe("SupabaseStorage.createTracker — identity is owner + name", () => {
  it("keeps the plain name for a second profile instead of suffixing the owner on", async () => {
    // Regression: this used to insert "Running - Sarah Miller" because the old
    // UNIQUE (user_id, name) index made a second "Running" un-insertable.
    const { storage, captured } = makeOwnerStorage([
      { id: "t-mine", name: "Running", linkedProfiles: ["self-1"] },
    ]);
    await storage.createTracker({ name: "Running", category: "fitness", linkedProfiles: ["sarah-1"] } as any);
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0].name).toBe("Running");
    expect(captured.inserts[0].linked_profiles).toEqual(["sarah-1"]);
  });

  it("still reuses the SAME owner's tracker rather than making a second one", async () => {
    const mine = { id: "t-mine", name: "Running", linkedProfiles: ["sarah-1"] };
    const { storage, captured } = makeOwnerStorage([mine]);
    const got = await storage.createTracker({ name: "Running", linkedProfiles: ["sarah-1"] } as any);
    expect(got).toBe(mine);
    expect(captured.inserts).toHaveLength(0);
  });

  it("does not hand one person's tracker to another person when no owner is given", async () => {
    // An unspecified owner means the SELF profile, not "any owner" — matching
    // any owner is how a log for me could land on Bob's tracker.
    const { storage, captured } = makeOwnerStorage([
      { id: "t-bob", name: "Running", linkedProfiles: ["bob-1"] },
    ]);
    await storage.createTracker({ name: "Running", category: "fitness" } as any);
    expect(captured.inserts).toHaveLength(1);
    expect(captured.inserts[0].linked_profiles).toEqual(["self-1"]);
  });

  it("adopts an unowned orphan tracker instead of cloning it", async () => {
    const orphan = { id: "t-orphan", name: "Running", linkedProfiles: [] };
    const { storage, captured } = makeOwnerStorage([orphan]);
    const got = await storage.createTracker({ name: "Running", linkedProfiles: ["bob-1"] } as any);
    expect(got).toBe(orphan);
    expect(captured.inserts).toHaveLength(0);
  });
});
