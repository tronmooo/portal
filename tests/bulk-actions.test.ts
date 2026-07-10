// ── Bulk preview → confirm → execute unit tests (server/bulk-actions.ts) ─────
// Stub-storage tests for the two-phase bulk delete: set derivation (filters,
// profile scoping, date cutoff), the unbounded-delete refusal, plan
// persistence, hash-drift expiry, and honest hard-delete reporting.
import { describe, it, expect } from "vitest";
import { deriveBulkSet, planBulkAction, executeBulkPlan } from "../server/bulk-actions";

const PROFILES = [
  { id: "self-1", type: "self", name: "Me" },
  { id: "mike-1", type: "person", name: "Mike" },
];

function stubStorage(overrides: Record<string, any> = {}): any {
  const plans = new Map<string, any>();
  const deleted: string[] = [];
  const ledger: any[] = [];
  return {
    _plans: plans,
    _deleted: deleted,
    _ledger: ledger,
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
    deleteTask: async (id: string) => { deleted.push(`task:${id}`); return true; },
    deleteExpense: async (id: string) => { deleted.push(`expense:${id}`); return true; },
    deleteTracker: async (id: string) => { deleted.push(`tracker:${id}`); return true; },
    createAiBulkPlan: async (p: any) => {
      const row = { id: `plan-${plans.size + 1}`, status: "pending", ...p };
      plans.set(row.id, row);
      return row;
    },
    getAiBulkPlan: async (id: string) => plans.get(id),
    getLatestPendingAiBulkPlan: async () => [...plans.values()].reverse().find((p: any) => p.status === "pending"),
    setAiBulkPlanStatus: async (id: string, status: string, patch?: any) => {
      const row = plans.get(id);
      if (row) Object.assign(row, { status }, patch || {});
    },
    createAiActionLog: async (e: any) => { ledger.push(e); return { id: "log-1", ...e }; },
    ...overrides,
  };
}

const TASKS = [
  { id: "t1", title: "ZZZBULK alpha", linkedProfiles: ["self-1"], createdAt: "2026-07-01T00:00:00Z" },
  { id: "t2", title: "ZZZBULK beta", linkedProfiles: ["mike-1"], createdAt: "2026-07-02T00:00:00Z" },
  { id: "t3", title: "Keep me", linkedProfiles: ["self-1"], createdAt: "2026-07-03T00:00:00Z" },
];

describe("deriveBulkSet", () => {
  it("matches by name substring across types", async () => {
    const storage = stubStorage({ getTasks: async () => TASKS });
    const { idsByType } = await deriveBulkSet(storage, { operation: "delete", name_contains: "zzzbulk" });
    expect(idsByType.task).toEqual(["t1", "t2"]);
  });

  it("scopes to a profile by name", async () => {
    const storage = stubStorage({ getTasks: async () => TASKS });
    const { idsByType, profileId } = await deriveBulkSet(storage, { operation: "delete", profile_name: "Mike" });
    expect(profileId).toBe("mike-1");
    expect(idsByType.task).toEqual(["t2"]);
  });

  it("applies a before_date cutoff on createdAt", async () => {
    const storage = stubStorage({ getTasks: async () => TASKS });
    const { idsByType } = await deriveBulkSet(storage, { operation: "delete", name_contains: "zzzbulk", before_date: "2026-07-02" });
    expect(idsByType.task).toEqual(["t1"]);
  });

  it("errors on an unknown profile", async () => {
    const storage = stubStorage();
    const { error } = await deriveBulkSet(storage, { operation: "delete", profile_name: "Nobody" });
    expect(error).toMatch(/No profile found/);
  });
});

describe("planBulkAction", () => {
  it("refuses an unbounded delete", async () => {
    const res = await planBulkAction(stubStorage(), { operation: "delete" });
    expect(res.error).toMatch(/unbounded/i);
  });

  it("errors honestly when nothing matches", async () => {
    const res = await planBulkAction(stubStorage(), { operation: "delete", name_contains: "zzznothing" });
    expect(res.error).toMatch(/Nothing matches/);
  });

  it("persists a pending plan and returns preview + plan_id, deleting nothing", async () => {
    const storage = stubStorage({ getTasks: async () => TASKS });
    const res = await planBulkAction(storage, { operation: "delete", name_contains: "ZZZBULK" });
    expect(res.plan_id).toBe("plan-1");
    expect(res.preview.total).toBe(2);
    expect(res.preview.counts.task).toBe(2);
    expect(res.message).toMatch(/Nothing has been deleted/);
    expect(storage._deleted).toEqual([]);
    expect(storage._plans.get("plan-1").status).toBe("pending");
  });
});

describe("executeBulkPlan", () => {
  it("deletes the previewed set, marks the plan executed, logs one restore_set ledger row", async () => {
    const storage = stubStorage({ getTasks: async () => TASKS });
    const { plan_id } = await planBulkAction(storage, { operation: "delete", name_contains: "ZZZBULK" });
    const res = await executeBulkPlan(storage, plan_id);
    expect(res.executed).toBe(true);
    expect(res.total).toBe(2);
    expect(storage._deleted).toEqual(["task:t1", "task:t2"]);
    expect(storage._plans.get(plan_id).status).toBe("executed");
    expect(storage._ledger).toHaveLength(1);
    expect(storage._ledger[0].reversible).toBe(true);
    expect(storage._ledger[0].reversePlan).toMatchObject({ op: "restore_set", ids: { task: ["t1", "t2"] } });
  });

  it("expires the plan on hash drift instead of deleting", async () => {
    let rows = TASKS;
    const storage = stubStorage({ getTasks: async () => rows });
    const { plan_id } = await planBulkAction(storage, { operation: "delete", name_contains: "ZZZBULK" });
    rows = TASKS.slice(0, 1); // t2 vanished between preview and confirm
    const res = await executeBulkPlan(storage, plan_id);
    expect(res.error).toMatch(/data changed/);
    expect(storage._deleted).toEqual([]);
    expect(storage._plans.get(plan_id).status).toBe("expired");
  });

  it("refuses a plan that is not pending or already expired", async () => {
    const storage = stubStorage({ getTasks: async () => TASKS });
    const { plan_id } = await planBulkAction(storage, { operation: "delete", name_contains: "ZZZBULK" });
    await storage.setAiBulkPlanStatus(plan_id, "executed");
    expect((await executeBulkPlan(storage, plan_id)).error).toMatch(/already executed/);

    const { plan_id: p2 } = await planBulkAction(storage, { operation: "delete", name_contains: "ZZZBULK" });
    storage._plans.get(p2).expiresAt = new Date(Date.now() - 1000).toISOString();
    expect((await executeBulkPlan(storage, p2)).error).toMatch(/expired/);
    expect(storage._plans.get(p2).status).toBe("expired");

    expect((await executeBulkPlan(storage, "no-such-plan")).error).toMatch(/doesn't exist/);
  });

  it("resolves the newest pending plan when plan_id is omitted (text-only chat history)", async () => {
    const storage = stubStorage({ getTasks: async () => TASKS });
    await planBulkAction(storage, { operation: "delete", name_contains: "ZZZBULK" });
    const res = await executeBulkPlan(storage);
    expect(res.executed).toBe(true);
    expect(storage._deleted).toEqual(["task:t1", "task:t2"]);
  });

  it("errors honestly when no pending plan exists and plan_id is omitted", async () => {
    const res = await executeBulkPlan(stubStorage());
    expect(res.error).toMatch(/No pending bulk delete/);
  });

  it("reports hard-deleted types as permanent (irreversible ledger row)", async () => {
    const storage = stubStorage({
      getTrackers: async () => [{ id: "tr1", name: "ZZZBULK tracker", linkedProfiles: ["self-1"], createdAt: "2026-07-01T00:00:00Z" }],
    });
    const { plan_id } = await planBulkAction(storage, { operation: "delete", name_contains: "ZZZBULK" });
    const res = await executeBulkPlan(storage, plan_id);
    expect(res.executed).toBe(true);
    expect(res.message).toMatch(/permanent/);
    expect(storage._ledger[0].reversible).toBe(false);
  });
});
