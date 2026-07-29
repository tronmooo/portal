// ── Tracker-entry write verification (server/supabase-storage.ts logEntry) ───
//
// Production audit 2026-07-29, blocker #2: "AI reports writes that never
// occurred". Asking chat to log 24 oz showed 24 oz in the UI and a success
// message from the assistant, but no `tracker_entries` row existed and the
// value vanished on refresh.
//
// Root cause: logEntry() ran an INSERT and then returned an entry object
// assembled from LOCAL VARIABLES. It never asked the database what it had
// actually stored, so any write that failed to persist still produced a
// perfectly well-formed "success" value.
//
// These tests drive the real logEntry() against a scripted Supabase double,
// covering the audit's required cases: failed, delayed and interrupted
// inserts, plus duplicate-submit protection.
import { describe, it, expect, vi } from "vitest";

/**
 * Minimal stand-in for the supabase-js query builder, scripted per table.
 * Only the calls logEntry() actually makes are modelled.
 */
function makeSupabaseDouble(opts: {
  tracker: any;
  /**
   * What the INSERT ... RETURNING resolves to. Receives the row that was
   * actually submitted, so the default behaviour can echo it back the way a
   * real database does — logEntry generates the entry id internally, and the
   * identity check it performs is only meaningful against the real payload.
   */
  insertResult: (submitted: any) => Promise<{ data: any; error: any }>;
  /** Rows the 5-minute dedup lookup sees. */
  recentEntries?: any[];
}) {
  const calls = { inserts: 0 };

  const selectChain = (rows: any[]) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      gte: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: rows, error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (res: any) => Promise.resolve({ data: rows, error: null }).then(res),
    };
    return chain;
  };

  return {
    calls,
    from(table: string) {
      if (table === "trackers") return selectChain(opts.tracker ? [opts.tracker] : []);
      if (table === "tracker_entries") {
        return {
          ...selectChain(opts.recentEntries ?? []),
          insert: (row: any) => {
            calls.inserts++;
            const chain: any = {
              select: () => chain,
              maybeSingle: () => opts.insertResult(row),
              single: () => opts.insertResult(row),
            };
            return chain;
          },
        };
      }
      return selectChain([]);
    },
  };
}

const TRACKER_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

/** Load SupabaseStorage with its module deps stubbed out. */
async function loadStorage() {
  vi.resetModules();
  const mod = await import("../server/supabase-storage");
  return mod as any;
}

/** Build a storage instance wired to the double, bypassing the real client. */
async function storageWith(double: any) {
  const { SupabaseStorage } = await loadStorage();
  const s = Object.create(SupabaseStorage.prototype);
  s.supabase = double;
  s.userId = USER_ID;
  s._timezone = "UTC";
  // logEntry reads the tracker through getTracker(); serve it directly so the
  // test focuses on the write-and-verify path.
  s.getTracker = async () => ({
    id: TRACKER_ID, name: "Hydration", category: "health",
    fields: [{ name: "ounces", type: "number", unit: "oz" }], entries: [],
  });
  s.logActivity = () => {};
  return s;
}

const okRow = (over: Partial<any> = {}) => ({
  id: "entry-1", user_id: USER_ID, tracker_id: TRACKER_ID,
  entry_values: { ounces: 24 }, computed: {}, notes: null, mood: null,
  tags: null, for_profile: null, profile_id: null,
  timestamp: "2026-07-29T12:00:00.000Z",
  ...over,
});

describe("logEntry write verification", () => {
  it("returns the row the DATABASE stored, not the one we intended", async () => {
    // The database normalizes/keeps its own view of the row; the caller must
    // receive that, so what the UI renders is what is actually persisted.
    const double = makeSupabaseDouble({
      tracker: { id: TRACKER_ID },
      // Echo the submitted row, but with the timestamp the DB actually stored.
      insertResult: async (row) => ({
        data: { ...row, timestamp: "2026-07-29T12:00:00.000Z" }, error: null,
      }),
    });
    const s = await storageWith(double);
    const entry = await s.logEntry({ trackerId: TRACKER_ID, values: { ounces: 24 } });
    expect(entry).toBeDefined();
    expect(entry.values).toEqual({ ounces: 24 });
    // The DB's timestamp wins over anything we assembled locally.
    expect(entry.timestamp).toBe("2026-07-29T12:00:00.000Z");
  });

  it("FAILED insert: an error is thrown, never a phantom success", async () => {
    const double = makeSupabaseDouble({
      tracker: { id: TRACKER_ID },
      insertResult: async () => ({ data: null, error: { message: "permission denied", code: "42501" } }),
    });
    const s = await storageWith(double);
    await expect(s.logEntry({ trackerId: TRACKER_ID, values: { ounces: 24 } })).rejects.toBeTruthy();
  });

  it("INTERRUPTED insert: no row returned means the write is NOT confirmed", async () => {
    // The exact audited shape: the statement reported no error, but nothing
    // was persisted. Previously this returned a fully-formed success object.
    const double = makeSupabaseDouble({
      tracker: { id: TRACKER_ID },
      insertResult: async () => ({ data: null, error: null }),
    });
    const s = await storageWith(double);
    await expect(s.logEntry({ trackerId: TRACKER_ID, values: { ounces: 24 } }))
      .rejects.toThrow(/could not be confirmed/i);
  });

  it("DELAYED insert: a slow but successful write still verifies", async () => {
    const double = makeSupabaseDouble({
      tracker: { id: TRACKER_ID },
      insertResult: async (row) => {
        await new Promise((r) => setTimeout(r, 40));
        return { data: row, error: null };
      },
    });
    const s = await storageWith(double);
    const entry = await s.logEntry({ trackerId: TRACKER_ID, values: { ounces: 24 } });
    expect(entry.values).toEqual({ ounces: 24 });
  });

  it("MISMATCHED row: a row for another tracker/user is rejected", async () => {
    const double = makeSupabaseDouble({
      tracker: { id: TRACKER_ID },
      insertResult: async (row) => ({ data: { ...row, user_id: "someone-else" }, error: null }),
    });
    const s = await storageWith(double);
    await expect(s.logEntry({ trackerId: TRACKER_ID, values: { ounces: 24 } }))
      .rejects.toThrow(/verification failed/i);
  });

  it("DUPLICATE submit: a matching recent entry is reused, not re-inserted", async () => {
    const existing = okRow({ id: "entry-existing" });
    const double = makeSupabaseDouble({
      tracker: { id: TRACKER_ID },
      recentEntries: [existing],
      insertResult: async () => ({ data: okRow(), error: null }),
    });
    const s = await storageWith(double);
    const entry = await s.logEntry({ trackerId: TRACKER_ID, values: { ounces: 24 } });
    expect(entry.id).toBe("entry-existing");
    expect(double.calls.inserts).toBe(0); // no second row written
  });

  it("unknown tracker returns undefined without attempting a write", async () => {
    const double = makeSupabaseDouble({
      tracker: null,
      insertResult: async () => ({ data: okRow(), error: null }),
    });
    const s = await storageWith(double);
    s.getTracker = async () => undefined;
    expect(await s.logEntry({ trackerId: TRACKER_ID, values: { ounces: 24 } })).toBeUndefined();
    expect(double.calls.inserts).toBe(0);
  });
});
