/**
 * Deleting a habit retires the tracker that only existed to mirror it — also
 * on a database without `trackers.linked_habit_id` (2026-11-12).
 *
 * Found on production: delete a habit, and a tracker with the habit's name
 * stays on the Trackers page. The mirror test read `name, linked_habit_id`;
 * that column comes from migration 20260922, which was never applied there,
 * so the read failed and "fail closed" recognised no mirror at all. The
 * auto-created mirror is also title-cased, which the legacy name test (the
 * fallback when there is no stamp) did not allow for.
 *
 * Drives the real SupabaseStorage.deleteHabit over a fake Supabase client.
 */
import { describe, it, expect } from "vitest";
import { SupabaseStorage } from "../server/supabase-storage";

const USER = "user-1";
type Db = { habits: any[]; trackers: any[]; tracker_entries: any[]; goals: any[]; hasStampColumn: boolean };

function client(db: Db) {
  return {
    from(table: keyof Db & string) {
      const filters: Array<(r: any) => boolean> = [];
      let op: "select" | "update" | "delete" = "select"; let patch: any = null; let columns = "*";
      const rows = () => ((db as any)[table] as any[] || []).filter((r) => filters.every((f) => f(r)));
      const run = () => {
        if (op === "select" && table === "trackers" && /linked_habit_id/.test(columns) && !db.hasStampColumn) {
          return { data: null, error: { code: "42703", message: "column trackers.linked_habit_id does not exist" } };
        }
        const hit = rows();
        if (op === "update") for (const r of hit) Object.assign(r, patch);
        if (op === "delete") (db as any)[table] = ((db as any)[table] as any[]).filter((r) => !hit.includes(r));
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const q: any = {
        select(c?: string) { if (op === "select") columns = c || "*"; return q; },
        update(p: any) { op = "update"; patch = p; return q; },
        delete() { op = "delete"; return q; },
        eq(k: string, v: any) { filters.push((r) => r[k] === v); return q; },
        is(k: string, v: any) { filters.push((r) => (r[k] ?? null) === v); return q; },
        in(k: string, v: any[]) { filters.push((r) => v.includes(r[k])); return q; },
        not() { return q; }, order() { return q; },
        limit() { return q; },
        maybeSingle: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        single: async () => { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
        then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
      };
      return q;
    },
  };
}

function storage(db: Db) {
  const s: any = Object.create(SupabaseStorage.prototype);
  s.userId = USER; s._timezone = "UTC"; s.supabase = client(db);
  s.memoEnabled = false; s.memoCache = new Map();
  s.logActivity = () => undefined;
  s.freezeGoalProgress = async () => undefined;
  s.retireHabitMirrorEntries = async () => undefined;
  return s;
}

const habit = (over: any = {}) => ({ id: "h1", user_id: USER, name: "stretch", linked_tracker_id: "t1", deleted_at: null, ...over });
const tracker = (over: any = {}) => ({ id: "t1", user_id: USER, name: "Stretch", deleted_at: null, ...over });
const mirrorEntry = (id: string, habitId = "h1") => ({ id, user_id: USER, tracker_id: "t1", entry_values: { _habitId: habitId, completed: true }, deleted_at: null });

describe.each([[true], [false]])("deleteHabit — database %s the linked_habit_id column", (hasStampColumn) => {
  const label = hasStampColumn ? "with" : "without";
  it(`retires an empty auto-created mirror (${label} stamp column)`, async () => {
    const db: Db = { habits: [habit()], trackers: [tracker(hasStampColumn ? { linked_habit_id: "h1" } : {})], tracker_entries: [], goals: [], hasStampColumn };
    expect(await storage(db).deleteHabit("h1")).toBe(true);
    expect(db.habits[0].deleted_at).toBeTruthy();
    expect(db.trackers[0].deleted_at).toBeTruthy();
  });

  it(`retires a mirror whose only entries are this habit's check-ins (${label} stamp column)`, async () => {
    const db: Db = { habits: [habit({ name: "Read 12 minutes" })], trackers: [tracker({ name: "Read 15 Minutes" })], tracker_entries: [mirrorEntry("e1"), mirrorEntry("e2")], goals: [], hasStampColumn };
    expect(await storage(db).deleteHabit("h1")).toBe(true);
    expect(db.trackers[0].deleted_at).toBeTruthy();
    expect(db.tracker_entries.every((e) => e.deleted_at)).toBe(true);
  });

  it(`keeps a tracker the user logs their own measurements in (${label} stamp column)`, async () => {
    const own = { id: "e9", user_id: USER, tracker_id: "t1", entry_values: { value: 176 }, deleted_at: null };
    const db: Db = { habits: [habit()], trackers: [tracker({ name: "Weight" })], tracker_entries: [mirrorEntry("e1"), own], goals: [], hasStampColumn };
    expect(await storage(db).deleteHabit("h1")).toBe(true);
    expect(db.trackers[0].deleted_at).toBeNull();
    expect(own.deleted_at).toBeNull();
  });

  it(`keeps an empty tracker with a different name: it is the user's, linked by hand (${label} stamp column)`, async () => {
    const db: Db = { habits: [habit()], trackers: [tracker({ name: "Flexibility log" })], tracker_entries: [], goals: [], hasStampColumn };
    expect(await storage(db).deleteHabit("h1")).toBe(true);
    expect(db.trackers[0].deleted_at).toBeNull();
  });
});
