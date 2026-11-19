// The History tab records edits, not just the day the profile was created.
//
// 2026-11-19 (owner report): an asset's History tab only ever showed "create";
// manual edits and chat edits never appeared. The tab read the ownership log
// alone. A manual edit is now recorded as the fields it changed, a chat edit
// is read from the chat's action ledger, and the tab lists both.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { diffProfileEdit, historyValueText } from "../shared/profile-edit-history";
import { recordManualProfileEdit, recordProfileEdit, readProfileEditHistory } from "../server/profile-history";

/** The slice of the Supabase client the history module uses, over an array. */
function fakeAuditLog(opts: { failRead?: boolean } = {}) {
  const rows: any[] = [];
  const client = {
    from(table: string) {
      if (table !== "audit_log") throw new Error(`unexpected table ${table}`);
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        insert: async (row: any) => {
          rows.push({ id: `a-${rows.length + 1}`, created_at: new Date(Date.UTC(2026, 10, 18, 12, rows.length)).toISOString(), ...row });
          return { error: null };
        },
        select: () => q,
        eq: (col: string, val: unknown) => { filters.push([col, val]); return q; },
        order: () => q,
        limit: async () => opts.failRead
          ? { data: null, error: { message: "connection reset" } }
          : { data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)).reverse(), error: null },
      };
      return q;
    },
  };
  return { rows, client };
}

const BEFORE = { id: "a-sony", name: "Sony WH-1000XM5", notes: "", fields: { purchasePrice: 599, color: "Black", currentValue: 447, currentValueSource: "estimate", _integrity: { stale: {} } } };

describe("what an edit changed", () => {
  it("lists each changed field with its value before and after", () => {
    const after = { ...BEFORE, fields: { ...BEFORE.fields, purchasePrice: 549, color: "Silver" } };
    expect(diffProfileEdit(BEFORE, after)).toEqual([
      { field: "color", label: "Color", from: "Black", to: "Silver" },
      { field: "purchasePrice", label: "Purchase Price", from: "599", to: "549" },
    ]);
  });
  it("a field that was added or cleared is a change from or to nothing", () => {
    const added = diffProfileEdit(BEFORE, { ...BEFORE, fields: { ...BEFORE.fields, serialNumber: "SN-1" } });
    expect(added).toEqual([{ field: "serialNumber", label: "Serial Number", from: null, to: "SN-1" }]);
    const { color, ...rest } = BEFORE.fields;
    expect(diffProfileEdit(BEFORE, { ...BEFORE, fields: rest })).toEqual([{ field: "color", label: "Color", from: "Black", to: null }]);
  });
  it("a rename is a change", () => {
    expect(diffProfileEdit(BEFORE, { ...BEFORE, name: "Sony WH-1000XM5 headphones" }))
      .toEqual([{ field: "name", label: "Name", from: "Sony WH-1000XM5", to: "Sony WH-1000XM5 headphones" }]);
  });
  it("the same value in another spelling is not a change", () => {
    expect(diffProfileEdit(BEFORE, { ...BEFORE, fields: { ...BEFORE.fields, purchasePrice: "599" } })).toEqual([]);
  });
  it("internal bookkeeping never appears", () => {
    const after = { ...BEFORE, fields: { ...BEFORE.fields, currentValueSource: "user", currentValueAsOf: "2026-11-18T00:00:00Z", _integrity: { stale: { x: 1 } } } };
    expect(diffProfileEdit(BEFORE, after)).toEqual([]);
  });
  it("renders values as text, and nothing as null", () => {
    expect(historyValueText(599)).toBe("599");
    expect(historyValueText("  ")).toBeNull();
    expect(historyValueText(null)).toBeNull();
    expect(historyValueText(["a", "b"])).toBe("a, b");
  });
});

describe("recording and reading a profile's edits", () => {
  it("a manual edit is stored once and read back as a user edit", async () => {
    const log = fakeAuditLog();
    const storage = { supabase: log.client };
    const after = { ...BEFORE, fields: { ...BEFORE.fields, color: "Silver" } };
    await recordManualProfileEdit(storage, "u1", BEFORE, after);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ user_id: "u1", action: "update", entity_type: "profile", entity_id: "a-sony", source: "manual" });

    const history = await readProfileEditHistory(storage, "u1", "a-sony");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: "edit", changedBy: "user", changes: [{ field: "color", label: "Color", from: "Black", to: "Silver" }] });
  });

  it("an edit that changed nothing writes no row", async () => {
    const log = fakeAuditLog();
    await recordManualProfileEdit({ supabase: log.client }, "u1", BEFORE, { ...BEFORE });
    expect(log.rows).toEqual([]);
  });

  it("another profile's edits and another user's edits are not listed", async () => {
    const log = fakeAuditLog();
    const storage = { supabase: log.client };
    await recordManualProfileEdit(storage, "u1", BEFORE, { ...BEFORE, name: "Renamed" });
    expect(await readProfileEditHistory(storage, "u1", "a-other")).toEqual([]);
    expect(await readProfileEditHistory(storage, "u2", "a-sony")).toEqual([]);
  });

  it("a chat edit is stored the same way and read back as an AI edit", async () => {
    const log = fakeAuditLog();
    const storage = { supabase: log.client };
    await recordProfileEdit(storage, "u1", BEFORE, { ...BEFORE, fields: { ...BEFORE.fields, purchasePrice: 549 } }, "chat");
    expect(log.rows[0].source).toBe("chat");
    const history = await readProfileEditHistory(storage, "u1", "a-sony");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ changedBy: "ai", changes: [{ field: "purchasePrice", from: "599", to: "549" }] });
  });

  it("a failed read is an error, not an empty history (Rule 7)", async () => {
    const log = fakeAuditLog({ failRead: true });
    await expect(readProfileEditHistory({ supabase: log.client }, "u1", "a-sony")).rejects.toThrow(/edit history/i);
  });
});

describe("the wiring", () => {
  const routes = readFileSync(resolve(__dirname, "../server/routes.ts"), "utf8");
  const tab = readFileSync(resolve(__dirname, "../client/src/components/ProfileSharedTabs.tsx"), "utf8");
  it("the profile edit route records the edit", () => {
    const start = routes.indexOf('app.patch("/api/profiles/:id"');
    const body = routes.slice(start, routes.indexOf('app.delete("/api/profiles/:id"', start));
    expect(start).toBeGreaterThan(0);
    expect(body).toMatch(/recordManualProfileEdit\(/);
  });
  it("the chat's profile and debt edit tools record their edits", () => {
    const engine = readFileSync(resolve(__dirname, "../server/ai-engine.ts"), "utf8");
    for (const tool of ["update_profile", "update_liability"]) {
      const start = engine.indexOf(`case "${tool}": {`);
      const body = engine.slice(start, engine.indexOf("\n    case \"", start + 10));
      expect(start, tool).toBeGreaterThan(0);
      expect(body, tool).toMatch(/recordProfileEdit\(storage, .*"chat"\)/);
    }
  });
  it("the History tab reads the edit history under the profile's cache key", () => {
    expect(routes).toMatch(/app\.get\("\/api\/profiles\/:id\/edit-history"/);
    expect(tab).toMatch(/queryKey: \["\/api\/profiles", profileId, "edit-history"\]/);
  });
});
