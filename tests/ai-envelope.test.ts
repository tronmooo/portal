// ── Envelope + verification unit tests (server/ai-envelope.ts) ───────────────
// Stub-storage tests for the standard tool-result envelope: read-back
// existence, duplicate counting, profile isolation, delete semantics, and —
// critically — raw-result spread preservation (the chat UI's undo cards and
// the entityId extraction in processMessage read raw keys off the result).
import { describe, it, expect } from "vitest";
import { finalizeToolResult, buildTurnVerifyContext, classifyOperation } from "../server/ai-envelope";

const PROFILES = [
  { id: "self-1", type: "self", name: "Me" },
  { id: "mike-1", type: "person", name: "Mike" },
];

function stubStorage(overrides: Record<string, any> = {}): any {
  return {
    getProfiles: async () => PROFILES,
    getTasks: async () => [],
    getExpenses: async () => [],
    getIncomes: async () => [],
    getEvents: async () => [],
    getHabits: async () => [],
    getTrackers: async () => [],
    getGoals: async () => [],
    getObligations: async () => [],
    getJournalEntries: async () => [],
    getMemories: async () => [],
    getArtifacts: async () => [],
    listReminders: async () => [],
    getDocuments: async () => [],
    getPaychecks: async () => [],
    ...overrides,
  };
}

describe("classifyOperation", () => {
  it("classifies create/log/journal/save/duplicate as create", () => {
    for (const t of ["create_task", "log_income", "journal_entry", "save_memory", "duplicate_artifact", "add_liability_payment"])
      expect(classifyOperation(t), t).toBe("create");
  });
  it("classifies delete_* as delete and the rest as update", () => {
    expect(classifyOperation("delete_expense")).toBe("delete");
    expect(classifyOperation("complete_task")).toBe("update");
    expect(classifyOperation("pay_obligation")).toBe("update");
    expect(classifyOperation("restore_task")).toBe("update");
  });
});

describe("finalizeToolResult", () => {
  it("create: read-back exists + duplicate_count + isolation valid", async () => {
    const storage = stubStorage({
      getTasks: async () => [
        { id: "t1", title: "Buy milk", linkedProfiles: ["mike-1"] },
        { id: "t0", title: "Buy milk!", linkedProfiles: [] }, // normalized duplicate
      ],
    });
    const ctx = buildTurnVerifyContext(storage);
    const env = await finalizeToolResult("create_task", "create_task", { title: "Buy milk" }, { id: "t1", title: "Buy milk" }, ctx);
    expect(env.success).toBe(true);
    expect(env.action).toBe("create_task");
    expect(env.entity).toMatchObject({ type: "task", id: "t1", name: "Buy milk" });
    expect(env.verification.database_record_exists).toBe(true);
    expect(env.verification.duplicate_count).toBe(1);
    expect(env.verification.profile_isolation_valid).toBe(true);
  });

  it("create: isolation flags a linked profile that is not the user's", async () => {
    const storage = stubStorage({
      getTasks: async () => [{ id: "t9", title: "X", linkedProfiles: ["someone-elses-profile"] }],
    });
    const ctx = buildTurnVerifyContext(storage);
    const env = await finalizeToolResult("create_task", "create_task", { title: "X" }, { id: "t9" }, ctx);
    expect(env.verification.profile_isolation_valid).toBe(false);
  });

  it("create: missing read-back row reports database_record_exists=false", async () => {
    const ctx = buildTurnVerifyContext(stubStorage()); // empty task list
    const env = await finalizeToolResult("create_task", "create_task", { title: "Ghost" }, { id: "nope" }, ctx);
    expect(env.success).toBe(true); // envelope reports; the MODEL decides how to phrase it
    expect(env.verification.database_record_exists).toBe(false);
  });

  it("delete: absence of the live row means the delete is confirmed", async () => {
    const ctx = buildTurnVerifyContext(stubStorage()); // row gone from list
    const env = await finalizeToolResult("delete_expense", "delete_entity", { description: "coffee" }, { deleted: true, id: "e1" }, ctx);
    expect(env.verification.database_record_exists).toBe(false);
  });

  it("update: existence-only (no duplicate_count)", async () => {
    const storage = stubStorage({
      getHabits: async () => [{ id: "h1", name: "Stretch", linkedProfiles: [] }],
    });
    const ctx = buildTurnVerifyContext(storage);
    const env = await finalizeToolResult("update_habit", "update_entity", { name: "Stretch" }, { updated: true, habit: { id: "h1" } }, ctx);
    expect(env.verification.database_record_exists).toBe(true);
    expect(env.verification.duplicate_count).toBeUndefined();
    expect(env.verification.profile_isolation_valid).toBe(true); // orphan → self rule
  });

  it("preserves every raw key (spread last) — undo cards depend on this", async () => {
    const storage = stubStorage({ getProfiles: async () => PROFILES });
    const ctx = buildTurnVerifyContext(storage);
    const raw = { id: "p1", updated: true, _previousState: { fields: { a: 1 } }, profile: { id: "p1" } };
    const env = await finalizeToolResult("update_profile", "update_profile", { name: "Mike" }, raw, ctx);
    expect(env.id).toBe("p1");
    expect(env._previousState).toEqual({ fields: { a: 1 } });
    expect(env.profile).toEqual({ id: "p1" });
  });

  it("unmapped tools get the envelope without verification", async () => {
    const ctx = buildTurnVerifyContext(stubStorage());
    const env = await finalizeToolResult("set_budget", "set_budget", { category: "food", amount: 100 }, { success: true, budget: { id: "b1" } }, ctx);
    expect(env.action).toBe("set_budget");
    expect(env.verification).toBeUndefined();
  });

  it("never throws — a broken storage returns the raw result", async () => {
    const storage = stubStorage({ getTasks: async () => { throw new Error("boom"); }, getProfiles: async () => { throw new Error("boom"); } });
    const ctx = buildTurnVerifyContext(storage);
    const raw = { id: "t1", title: "X" };
    const env = await finalizeToolResult("create_task", "create_task", { title: "X" }, raw, ctx);
    // list fetch failed → no verification computed, but envelope still forms
    expect(env.id).toBe("t1");
    expect(env.success).toBe(true);
  });

  it("prefers the handler's own message when present", async () => {
    const ctx = buildTurnVerifyContext(stubStorage());
    const env = await finalizeToolResult("copy_budgets_previous_month", "set_budget", {}, { copied: 3, message: "Copied 3 budgets from 2026-06 to 2026-07" }, ctx);
    expect(env.message).toBe("Copied 3 budgets from 2026-06 to 2026-07");
  });
});
