// Every table and column a migration adds is on the list the database is
// probed against (shared/schema-expectations.ts → GET /api/diagnostics/schema
// → tests/live-schema-drift-check.ts). Twice a migration was merged and never
// run on production, and the code's "safe" fallback hid it for months.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  EXPECTED_COLUMNS, EXPECTED_TABLES, RETIRED_TABLES, isMissingSchemaError, parseMigrationSchema,
} from "../shared/schema-expectations";
import { SupabaseStorage } from "../server/supabase-storage";

const dir = path.join(process.cwd(), "migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

describe("schema expectations cover the migrations", () => {
  it("reads the migrations", () => {
    expect(files.length).toBeGreaterThan(40);
    const parsed = parseMigrationSchema(fs.readFileSync(path.join(dir, "20260922_tracker_linked_habit.sql"), "utf8"));
    expect(parsed.columns).toEqual([{ table: "trackers", column: "linked_habit_id" }]);
    expect(parseMigrationSchema(fs.readFileSync(path.join(dir, "20261115_auth_rate_limits.sql"), "utf8")).tables).toContain("auth_rate_limits");
  });

  it("every column a migration adds is expected", () => {
    const listed = new Set(EXPECTED_COLUMNS.map((c) => `${c.table}.${c.column}`));
    const unlisted: string[] = [];
    for (const f of files) {
      for (const c of parseMigrationSchema(fs.readFileSync(path.join(dir, f), "utf8")).columns) {
        if (!listed.has(`${c.table}.${c.column}`) && !(c.table in RETIRED_TABLES)) unlisted.push(`${c.table}.${c.column} (${f})`);
      }
    }
    expect(unlisted, "add to EXPECTED_COLUMNS in shared/schema-expectations.ts").toEqual([]);
  });

  it("every table a migration creates is expected, or retired with a reason", () => {
    const listed = new Set(EXPECTED_TABLES.map((t) => t.table));
    const unlisted: string[] = [];
    for (const f of files) {
      for (const t of parseMigrationSchema(fs.readFileSync(path.join(dir, f), "utf8")).tables) {
        if (!listed.has(t) && !(t in RETIRED_TABLES)) unlisted.push(`${t} (${f})`);
      }
    }
    expect(unlisted, "add to EXPECTED_TABLES in shared/schema-expectations.ts").toEqual([]);
    for (const [t, why] of Object.entries(RETIRED_TABLES)) {
      expect(why.length, `${t} retired without a reason`).toBeGreaterThan(10);
      expect(listed.has(t), `${t} is both expected and retired`).toBe(false);
    }
  });

  it("each expectation names a migration file that exists", () => {
    for (const e of [...EXPECTED_COLUMNS, ...EXPECTED_TABLES]) expect(files, e.table).toContain(e.migration);
  });

  it("tells 'not there' from 'not allowed'", () => {
    expect(isMissingSchemaError({ code: "42703", message: "column trackers.linked_habit_id does not exist" })).toBe(true);
    expect(isMissingSchemaError({ code: "PGRST205", message: "Could not find the table 'public.auth_rate_limits' in the schema cache" })).toBe(true);
    expect(isMissingSchemaError({ code: "42501", message: "permission denied for table response_cache" })).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
  });
});

// A database double that knows which tables and columns it has.
function db(has: { tables: string[]; missingColumns?: string[] }, rows: Record<string, any[]> = {}) {
  const selects: Array<{ table: string; cols: string }> = [];
  const updates: Array<{ table: string; payload: any }> = [];
  const from = (table: string) => {
    let cols = "*";
    let op: "select" | "update" = "select";
    const answer = () => {
      if (!has.tables.includes(table)) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` } };
      const bad = (has.missingColumns || []).find((c) => c.startsWith(`${table}.`) && cols.split(",").map((x) => x.trim()).includes(c.split(".")[1]));
      if (bad && op === "select") return { data: null, error: { code: "42703", message: `column ${bad} does not exist` } };
      return { data: rows[table] ?? [], error: null };
    };
    const q: any = {
      select: (c: string) => { cols = c; if (op === "select") selects.push({ table, cols: c }); return q; },
      update: (payload: any) => { op = "update"; updates.push({ table, payload }); return q; },
      eq: () => q, is: () => q, limit: () => q,
      maybeSingle: async () => { const a = answer(); return { data: Array.isArray(a.data) ? a.data[0] ?? null : a.data, error: a.error }; },
      then: (ok: any, bad: any) => Promise.resolve(answer()).then(ok, bad),
    };
    return q;
  };
  return { client: { from }, selects, updates };
}
function storageOver(client: any): any {
  const s: any = Object.create(SupabaseStorage.prototype);
  s.userId = "22222222-2222-4222-8222-222222222222";
  s._timezone = "America/Los_Angeles";
  s.supabase = client;
  return s;
}

describe("probeSchema names what the database lacks", () => {
  const allTables = [...new Set([...EXPECTED_TABLES.map((t) => t.table), ...EXPECTED_COLUMNS.map((c) => c.table)])];

  it("a complete database has no gaps", async () => {
    expect(await storageOver(db({ tables: allTables }).client).probeSchema()).toEqual([]);
  });

  it("the two gaps found in production on 2026-11-24 are reported by name", async () => {
    const { client } = db({ tables: allTables.filter((t) => t !== "auth_rate_limits"), missingColumns: ["trackers.linked_habit_id"] });
    expect(await storageOver(client).probeSchema()).toEqual([
      { kind: "table", table: "auth_rate_limits", migration: "20261115_auth_rate_limits.sql" },
      { kind: "column", table: "trackers", column: "linked_habit_id", migration: "20260922_tracker_linked_habit.sql" },
    ]);
  });
});

describe("a deleted habit takes its mirror tracker with it, stamp column or not", () => {
  const HABIT = "h-1";
  const TRACKER = "t-1";

  it("with no linked_habit_id column, the mirror is still recognised by its entries", async () => {
    const { client, selects } = db(
      { tables: ["trackers", "tracker_entries"], missingColumns: ["trackers.linked_habit_id"] },
      { trackers: [{ name: "Stretch" }], tracker_entries: [{ entry_values: { _habitId: HABIT } }, { entry_values: { _habitId: HABIT } }] },
    );
    expect(await storageOver(client).habitMirrorTrackerId(HABIT, "stretch", TRACKER)).toBe(TRACKER);
    // It asked for the stamp, was told the column is not there, and asked again without it.
    expect(selects.filter((s) => s.table === "trackers").map((s) => s.cols)).toEqual(["name, linked_habit_id", "name"]);
  });

  it("an empty mirror is recognised by the habit's name whatever its case (\"stretch\" → \"Stretch\")", async () => {
    const { client } = db({ tables: ["trackers", "tracker_entries"], missingColumns: ["trackers.linked_habit_id"] }, { trackers: [{ name: "Wfm8zzo  Stretch" }], tracker_entries: [] });
    expect(await storageOver(client).habitMirrorTrackerId(HABIT, "WFM8ZZO stretch", TRACKER)).toBe(TRACKER);
  });

  it("the user's own tracker is kept: a log of theirs on it, or empty under a name of its own", async () => {
    const own = db({ tables: ["trackers", "tracker_entries"], missingColumns: ["trackers.linked_habit_id"] },
      { trackers: [{ name: "Stretch" }], tracker_entries: [{ entry_values: { _habitId: HABIT } }, { entry_values: { minutes: 20 } }] });
    expect(await storageOver(own.client).habitMirrorTrackerId(HABIT, "stretch", TRACKER)).toBeNull();
    const emptyOther = db({ tables: ["trackers", "tracker_entries"] }, { trackers: [{ name: "Mobility log", linked_habit_id: null }], tracker_entries: [] });
    expect(await storageOver(emptyOther.client).habitMirrorTrackerId(HABIT, "stretch", TRACKER)).toBeNull();
  });

  it("a tracker stamped for another habit is never this one's, and a real read failure still keeps the tracker", async () => {
    const other = db({ tables: ["trackers", "tracker_entries"] }, { trackers: [{ name: "Stretch", linked_habit_id: "h-2" }], tracker_entries: [] });
    expect(await storageOver(other.client).habitMirrorTrackerId(HABIT, "stretch", TRACKER)).toBeNull();
    const down = db({ tables: ["tracker_entries"] }, { tracker_entries: [] }); // trackers read fails outright
    expect(await storageOver(down.client).habitMirrorTrackerId(HABIT, "stretch", TRACKER)).toBeNull();
  });
});
