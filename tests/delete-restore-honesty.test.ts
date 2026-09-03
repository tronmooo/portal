// Delete/restore honesty — the lifecycle contract.
//
// The old shape was the worst of every option: deletes wiped owners (so
// restore returned rows visible only under "Everyone"), "recoverable"
// document deletes destroyed the bytes (restore → a file that won't open),
// habit deletes hard-purged the check-in history behind a soft-deleted row,
// goals hard-deleted despite having a deleted_at column, a dozen methods
// returned `!error` (0 rows matched still reported success, so route 404s
// could never fire), and "delete all my data" skipped profiles and swallowed
// per-table errors. Most of this is storage-shape, pinned here by source
// guards plus assertions on the exported contracts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { SOFT_DELETE_TYPES } from "../server/ai-envelope";
import { SupabaseStorage } from "../server/supabase-storage";

const src = readFileSync(resolve(__dirname, "../server/supabase-storage.ts"), "utf8");
const method = (name: string, stops: string[] = ["\n  async ", "\n  private "]) => {
  const i = src.indexOf(`async ${name}(`);
  expect(i, `method ${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(i + 6);
  const end = Math.min(...stops.map(s => {
    const j = rest.indexOf(s);
    return j < 0 ? rest.length : j;
  }));
  return rest.slice(0, end);
};

describe("soft deletes keep owners", () => {
  it.each(["deleteTask", "deleteExpense", "deleteDocument"])("%s no longer wipes linked_profiles", (m) => {
    expect(method(m)).not.toContain("linked_profiles: []");
  });
});

describe("deletes and restores report honestly (0 rows ⇒ false)", () => {
  it.each([
    "deleteTask", "restoreTask", "deleteExpense", "deleteHabit", "restoreHabit",
    "deleteGoal", "restoreGoal", "deleteDocument", "restoreDocument", "purgeDocument",
  ])("%s uses .select and checks the row count", (m) => {
    const body = method(m);
    expect(body).toContain(".select(");
    expect(body).toMatch(/data\.length (>|===) 0/);
    expect(body).not.toMatch(/return !error;\s*$/m);
  });
});

describe("recoverable means recoverable", () => {
  it("deleteHabit keeps the check-in history", () => {
    expect(method("deleteHabit")).not.toMatch(/from\("habit_checkins"\)\.delete/);
  });

  it("deleteGoal is soft (the column always existed)", () => {
    const body = method("deleteGoal");
    expect(body).toContain("deleted_at");
    expect(body).not.toMatch(/from\("goals"\)\s*\n?\s*\.delete\(/);
  });

  it("deleteDocument keeps the bytes; only purgeDocument destroys them", () => {
    const del = method("deleteDocument");
    expect(del).not.toContain("file_data: ''");
    expect(del).not.toContain(".storage.from(");
    const purge = method("purgeDocument");
    expect(purge).toContain(".storage.from(");
    // Exactly one byte-destroyer in the whole storage layer.
    const removers = (src.match(/\.storage\.from\(DOCUMENTS_BUCKET\)\s*\n?\s*\.remove\(/g) || []).length;
    expect(removers).toBe(1);
  });

  it("restoreEntity delegates documents to restoreDocument, never promises obligation, and restores a profile only from a soft-deleted row", () => {
    const body = method("restoreEntity");
    expect(body).toContain("restoreDocument");
    expect(body).not.toMatch(/obligation:\s*"(profiles|obligations)"/);
    expect(body).toMatch(/goal:\s*"goals"/);
    // A merge archives its source with deleted_at (server/merge-profiles.ts),
    // the one soft-deleted profile path; a hard-cascaded profile matches no
    // row, and the row-count check below keeps that answering false.
    expect(body).toMatch(/profile:\s*"profiles"/);
    expect(body).toMatch(/Array\.isArray\(data\) && data\.length > 0/);
  });

  it("SOFT_DELETE_TYPES matches what the storage layer actually does", () => {
    // profile/obligation deletes are hard cascades — promising undo for them
    // produced "restore succeeded" toasts over permanently gone data.
    expect(SOFT_DELETE_TYPES.has("profile")).toBe(false);
    expect(SOFT_DELETE_TYPES.has("obligation")).toBe(false);
    for (const t of ["task", "habit", "expense", "income", "event", "document", "goal"]) {
      expect(SOFT_DELETE_TYPES.has(t), `${t} should be soft`).toBe(true);
    }
  });
});

describe("soft-deleted rows are invisible to every reader", () => {
  it.each([
    ["_getTrackersImpl", 'from("trackers")'],
    ["getTracker", 'from("trackers")'],
    ["_getGoalsImpl", 'from("goals")'],
    ["getGoal", 'from("goals")'],
    ["getArtifacts", 'from("artifacts")'],
    ["getArtifact", 'from("artifacts")'],
    ["getJournalEntries", 'from("journal_entries")'],
    ["getMemories", 'from("memories")'],
  ] as const)("%s filters deleted_at", (m) => {
    expect(method(m as string)).toContain('.is("deleted_at", null)');
  });
});

describe("account erasure is complete and loud", () => {
  it("the table list covers the tables the old list forgot, profiles last", () => {
    const t = SupabaseStorage.ALL_USER_TABLES;
    for (const missing of [
      "profiles", "liability_payments", "asset_party_links", "liability_profile_links",
      "liability_asset_links", "ownership_history", "net_worth_snapshots",
      "ai_action_log", "user_notifications", "chat_artifacts",
    ]) {
      expect(t, `erasure list missing ${missing}`).toContain(missing);
    }
    expect(t[t.length - 1]).toBe("profiles");
    // Dropped tables must not linger — a delete against a missing table reads
    // as an "error" and pollutes the report.
    expect(t).not.toContain("obligations");
    expect(t).not.toContain("obligation_payments");
  });

  it("per-table errors are collected, not swallowed", () => {
    const body = method("deleteAllUserData");
    expect(body).toContain("errors[table]");
    expect(body).not.toMatch(/catch\s*\{\s*\n?\s*\/\/ Table may not exist/);
  });
});
