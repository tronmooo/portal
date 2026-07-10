// ── merge_profiles planner unit tests (server/merge-profiles.ts) ─────────────
// The execute path needs a live Supabase client (setOwners) and is covered by
// the live verifier; these tests pin the pure parts — profile resolution,
// refusals, preview derivation, and the drift-expiry discipline shared with
// bulk deletes.
import { describe, it, expect } from "vitest";
import { planMergeProfiles } from "../server/merge-profiles";
import { executeBulkPlan } from "../server/bulk-actions";

const PROFILES = [
  { id: "11111111-1111-4111-8111-111111111111", type: "self", name: "Me" },
  { id: "22222222-2222-4222-8222-222222222222", type: "person", name: "Mike" },
  { id: "33333333-3333-4333-8333-333333333333", type: "person", name: "Mike Smith" },
];
const MIKE = PROFILES[1].id;
const MIKE_SMITH = PROFILES[2].id;

function stubStorage(overrides: Record<string, any> = {}): any {
  const plans = new Map<string, any>();
  return {
    _plans: plans,
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
    getArtifacts: async () => [],
    getDocuments: async () => [],
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
    createAiActionLog: async () => undefined,
    ...overrides,
  };
}

describe("planMergeProfiles", () => {
  it("refuses missing/self/same-profile merges", async () => {
    const storage = stubStorage();
    expect((await planMergeProfiles(storage, "", "Mike")).error).toMatch(/both profiles/i);
    expect((await planMergeProfiles(storage, "Nobody", "Mike")).error).toMatch(/No profile found/);
    expect((await planMergeProfiles(storage, "Me", "Mike")).error).toMatch(/self profile/);
    expect((await planMergeProfiles(storage, "Mike Smith", "Mike Smith")).error).toMatch(/same profile/);
  });

  it("prefers the exact-name match over substring (Mike vs Mike Smith)", async () => {
    const storage = stubStorage();
    const res = await planMergeProfiles(storage, "Mike", "Mike Smith");
    expect(res.plan_id).toBeTruthy();
    const plan = storage._plans.get(res.plan_id);
    expect(plan.criteria.source_id).toBe(MIKE);
    expect(plan.criteria.target_id).toBe(MIKE_SMITH);
  });

  it("previews re-point counts and children without changing anything", async () => {
    const storage = stubStorage({
      getTasks: async () => [
        { id: "t1", title: "A", linkedProfiles: [MIKE] },
        { id: "t2", title: "B", linkedProfiles: [MIKE, MIKE_SMITH] },
        { id: "t3", title: "C", linkedProfiles: [MIKE_SMITH] },
      ],
      getProfiles: async () => [
        ...PROFILES,
        { id: "44444444-4444-4444-8444-444444444444", type: "pet", name: "Rex", parentProfileId: MIKE },
      ],
    });
    const res = await planMergeProfiles(storage, "Mike", "Mike Smith");
    expect(res.preview.counts.task).toBe(2);
    expect(res.preview.child_profiles_moved).toBe(1);
    expect(res.message).toMatch(/Nothing has been changed/);
    expect(storage._plans.get(res.plan_id).status).toBe("pending");
  });

  it("expires the plan on drift instead of merging", async () => {
    let tasks = [{ id: "t1", title: "A", linkedProfiles: [MIKE] }];
    const storage = stubStorage({ getTasks: async () => tasks });
    const { plan_id } = await planMergeProfiles(storage, "Mike", "Mike Smith");
    tasks = [...tasks, { id: "t2", title: "New", linkedProfiles: [MIKE] }]; // drifted
    const res = await executeBulkPlan(storage, plan_id);
    expect(res.error).toMatch(/data changed/);
    expect(storage._plans.get(plan_id).status).toBe("expired");
  });
});
