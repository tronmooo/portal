// The undo ledger must be written even when the database is one migration
// behind. Production lacked the operation-id columns for two months; every
// ledger insert failed silently and "undo my last action" removed a record
// from 2 September (found by the 2026-11-09 sweep of every chat tool).
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import { writeWithOptionalColumns, isMissingColumnError } from "../server/optional-columns";

const OPTIONAL = ["turn_id", "request_id", "operation_id"];
const ROW = { user_id: "u1", tool: "create_task", action_type: "create_task", turn_id: "t1", request_id: "r1", operation_id: "op1" };

/** A table that, like production's, does not have the id columns. */
function oldTable() {
  const rows: Record<string, unknown>[] = [];
  const write = vi.fn(async (row: Record<string, unknown>) => {
    const unknown = Object.keys(row).find((k) => OPTIONAL.includes(k));
    if (unknown) return { data: null, error: { code: "PGRST204", message: `Could not find the '${unknown}' column of 'ai_action_log' in the schema cache` } };
    rows.push(row);
    return { data: { id: `row${rows.length}`, ...row }, error: null };
  });
  return { rows, write };
}

describe("ledger write against a database missing the operation-id columns", () => {
  it("still records the action (the reported failure)", async () => {
    const t = oldTable();
    const degraded = vi.fn();
    const res = await writeWithOptionalColumns(t.write, ROW, OPTIONAL, degraded);
    expect(res.error).toBeNull();
    expect(t.rows).toEqual([{ user_id: "u1", tool: "create_task", action_type: "create_task" }]);
    expect(degraded).toHaveBeenCalledTimes(1);
  });

  it("writes the full row, once, when the columns exist", async () => {
    const write = vi.fn(async (row: Record<string, unknown>) => ({ data: row, error: null }));
    const res = await writeWithOptionalColumns(write, ROW, OPTIONAL);
    expect(write).toHaveBeenCalledTimes(1);
    expect(res.data).toEqual(ROW);
  });

  it("does not retry any other failure", async () => {
    const dup = { code: "23505", message: "duplicate key value violates unique constraint" };
    const write = vi.fn(async () => ({ data: null, error: dup }));
    const res = await writeWithOptionalColumns(write, ROW, OPTIONAL);
    expect(write).toHaveBeenCalledTimes(1);
    expect(res.error).toBe(dup);
    expect(isMissingColumnError(dup)).toBe(false);
    expect(isMissingColumnError({ code: "42703", message: 'column "operation_id" does not exist' })).toBe(true);
  });

  it("the ledger insert goes through it", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../server/supabase-storage.ts"), "utf8");
    const fn = src.slice(src.indexOf("async createAiActionLog("));
    const body = fn.slice(0, fn.indexOf("async listAiActionLog("));
    expect(body).toContain("writeWithOptionalColumns");
    expect(body).toContain('["turn_id", "request_id", "operation_id"]');
  });
});
