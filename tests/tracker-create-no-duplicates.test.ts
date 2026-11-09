// A tracker is identified by OWNER + NAME. createTracker must never leave the
// user with two trackers for one thing ("Heart Rate" next to "Heart Rate 42c7",
// 2026-11-09 report), however its callers are scheduled:
//   · concurrent creates of one name in a process are serialized and the
//     second one reuses the first's tracker;
//   · a unique-index collision from another process reuses the colliding row;
//   · no path ever invents a new name to make an insert succeed.
// Drives the real SupabaseStorage.createTracker against a fake Supabase client
// that enforces the real unique index (user_id, linked_profiles[0], lower(name)).
import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

const SELF = { id: "self-1", name: "Robert", type: "self" };

function makeDb() {
  const rows: any[] = [];
  const inserts: any[] = [];
  const ownerOf = (r: any) => (Array.isArray(r.linked_profiles) && r.linked_profiles[0]) || null;
  const tick = () => new Promise((r) => setTimeout(r, 1));
  const client: any = {
    from: (table: string) => ({
      insert: async (row: any) => {
        await tick(); // let concurrent callers interleave, as real I/O does
        if (table !== "trackers") return { error: null };
        inserts.push(row);
        const clash = rows.some((r) => r.user_id === row.user_id && ownerOf(r) === ownerOf(row) && String(r.name).toLowerCase() === String(row.name).toLowerCase());
        if (clash) return { error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_trackers_name_owner"' } };
        rows.push(row);
        return { error: null };
      },
      select: () => ({ eq: () => ({ is: async () => { await tick(); return { data: rows.map((r) => ({ ...r })), error: null }; } }) }),
    }),
  };
  return { rows, inserts, client };
}

function makeStorage(db: ReturnType<typeof makeDb>, userId = "user-1") {
  const storage: any = Object.create(SupabaseStorage.prototype);
  storage.userId = userId;
  storage.supabase = db.client;
  // The real request memo, so a stale memoized list is part of the test.
  storage.memoEnabled = true;
  storage.memoCache = new Map();
  storage._getTrackersImpl = async () => {
    await new Promise((r) => setTimeout(r, 1));
    return db.rows.filter((r) => r.user_id === userId).map((r) => ({ id: r.id, name: r.name, linkedProfiles: r.linked_profiles, fields: [], entries: [] }));
  };
  storage.resolveOwnersAndValidate = async (_kind: string, data: any) => (data.linkedProfiles?.length ? data.linkedProfiles : [SELF.id]);
  storage.getProfile = async () => SELF;
  storage.linkProfileTo = async () => undefined;
  storage.logActivity = () => undefined;
  storage.getTracker = async (id: string) => {
    const r = db.rows.find((x) => x.id === id);
    return r ? { id: r.id, name: r.name, linkedProfiles: r.linked_profiles, fields: [], entries: [] } : undefined;
  };
  return storage;
}

const heartRate = { name: "Heart Rate", category: "health", fields: [{ name: "bpm", type: "number" }] } as any;

describe("createTracker never produces a duplicate tracker", () => {
  it("parallel creates of one name in one request → one tracker, reused by both", async () => {
    const db = makeDb();
    const storage = makeStorage(db);
    // Warm the request memo with the pre-create list, like a chat turn does.
    expect(await storage.getTrackers()).toEqual([]);
    const [a, b, c] = await Promise.all([
      storage.createTracker(heartRate),
      storage.createTracker(heartRate),
      storage.createTracker({ ...heartRate, name: "heart rate" }),
    ]);
    expect(db.rows).toHaveLength(1);
    expect(db.inserts).toHaveLength(1);
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(a.name).toBe("Heart Rate");
  });

  it("a collision with a row created by another process reuses that row", async () => {
    const db = makeDb();
    const storage = makeStorage(db);
    expect(await storage.getTrackers()).toEqual([]);
    // Another instance commits "Heart Rate" after this request's pre-check.
    const other = makeStorage(db);
    const winner = await other.createTracker(heartRate);
    storage.memoCache.set("getTrackers:120", Promise.resolve([])); // pre-check still sees nothing
    storage.dropMemo = () => undefined;                              // …even after the lock's refresh
    const t = await storage.createTracker(heartRate);
    expect(t.id).toBe(winner.id);
    expect(db.rows).toHaveLength(1);
  });

  it("a collision whose row cannot be found fails loudly instead of inventing a name", async () => {
    const db = makeDb();
    const storage = makeStorage(db);
    db.client.from = ((orig) => (table: string) => {
      const api = orig(table);
      return { ...api, insert: async () => ({ error: { code: "23505", message: 'duplicate key value violates unique constraint "idx_trackers_name_owner"' } }) };
    })(db.client.from);
    await expect(storage.createTracker(heartRate)).rejects.toMatchObject({ code: "23505" });
    expect(db.rows).toHaveLength(0);
  });

  it("the same name for two different owners is two trackers, both named plainly", async () => {
    const db = makeDb();
    const storage = makeStorage(db);
    const mine = await storage.createTracker({ ...heartRate, linkedProfiles: [SELF.id] });
    const bobs = await storage.createTracker({ ...heartRate, linkedProfiles: ["bob-1"] });
    expect(mine.id).not.toBe(bobs.id);
    expect([mine.name, bobs.name]).toEqual(["Heart Rate", "Heart Rate"]);
  });

  it("no insert in any scenario carries a name other than the one requested", async () => {
    const db = makeDb();
    const storage = makeStorage(db);
    await Promise.all(Array.from({ length: 6 }, () => storage.createTracker(heartRate)));
    expect(db.inserts.every((r) => r.name === "Heart Rate")).toBe(true);
    expect(db.rows).toHaveLength(1);
  });
});
