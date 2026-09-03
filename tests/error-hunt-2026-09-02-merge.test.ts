// D124 — merging a person archived the source and left their co-ownership
// shares (asset_party_links / liability_profile_links) pointing at the
// archived row: the target never received Linda's half of the car, the dead
// share kept counting toward the asset's 100%, and undo could not bring it back.
import { describe, it, expect } from "vitest";
import { planMergeProfiles, executeMergeProfiles, reverseMerge } from "../server/merge-profiles";

const SELF = "11111111-1111-4111-8111-111111111111";
const LINDA = "22222222-2222-4222-8222-222222222222";
const LINDA2 = "33333333-3333-4333-8333-333333333333";
const CAR = "44444444-4444-4444-8444-444444444444";
const LOAN = "55555555-5555-4555-8555-555555555555";
const PROFILES = [
  { id: SELF, type: "self", name: "Me" },
  { id: LINDA, type: "person", name: "Linda" },
  { id: LINDA2, type: "person", name: "Linda Carter" },
  { id: CAR, type: "vehicle", name: "Honda", parentProfileId: SELF },
  { id: LOAN, type: "liability", name: "Car loan", parentProfileId: SELF },
];

/** Records every write the merge makes through the raw client; `respond`
 *  answers reads by table (entity_links / tracker_entries derivations). */
function recorderClient(respond: (table: string) => any[] = () => []) {
  const writes: Array<{ table: string; op: string; payload?: any; eq: Array<[string, any]>; in?: [string, any[]] }> = [];
  const from = (table: string) => {
    const rec = { table, op: "select", payload: undefined as any, eq: [] as Array<[string, any]>, in: undefined as any };
    const chain: any = {
      update: (payload: any) => { rec.op = "update"; rec.payload = payload; writes.push(rec); return chain; },
      delete: () => { rec.op = "delete"; writes.push(rec); return chain; },
      insert: (payload: any) => { rec.op = "insert"; rec.payload = payload; writes.push(rec); return chain; },
      select: () => chain,
      or: () => chain,
      limit: () => chain,
      in: (k: string, v: any[]) => { rec.in = [k, v]; return chain; },
      eq: (k: string, v: any) => { rec.eq.push([k, v]); return chain; },
      then: (res: any, rej?: any) => Promise.resolve({ data: rec.op === "select" ? respond(table) : [], error: null }).then(res, rej),
    };
    return chain;
  };
  return { client: { from }, writes };
}

function stubStorage(links: { asset?: any[]; liability?: any[]; budgets?: Record<string, any[]> }, client: any): any {
  const plans = new Map<string, any>();
  const empty = async () => [];
  const budgets: Record<string, any[]> = JSON.parse(JSON.stringify(links.budgets || {}));
  return {
    _budgets: budgets,
    getAllBudgets: async () => budgets,
    getBudgets: async (month: string) => budgets[month] || [],
    setBudgets: async (month: string, arr: any[]) => { budgets[month] = arr; },
    supabase: client, userId: "user-1", _plans: plans,
    getProfiles: async () => PROFILES,
    getTasks: empty, getExpenses: empty, getIncomes: empty, getEvents: empty, getHabits: empty, getTrackers: empty,
    getGoals: empty, getObligations: empty, getJournalEntries: empty, getArtifacts: empty, getDocuments: empty,
    getAssetPartyLinks: async () => links.asset || [],
    getLiabilityProfileLinks: async () => links.liability || [],
    createAiBulkPlan: async (p: any) => { const row = { id: `plan-${plans.size + 1}`, status: "pending", ...p }; plans.set(row.id, row); return row; },
    getAiBulkPlan: async (id: string) => plans.get(id),
    setAiBulkPlanStatus: async (id: string, status: string, patch?: any) => { const row = plans.get(id); if (row) Object.assign(row, { status }, patch || {}); },
    createAiActionLog: async () => undefined,
    restoreEntity: async () => true,
  };
}

describe("D124: merging a person moves their co-ownership shares to the target", () => {
  it("previews the shares and re-points a share the target does not hold", async () => {
    const { client, writes } = recorderClient();
    const storage = stubStorage({ asset: [
      { id: "apl-self", assetProfileId: CAR, partyProfileId: SELF, ownershipPercentage: 50, role: "owner" },
      { id: "apl-linda", assetProfileId: CAR, partyProfileId: LINDA, ownershipPercentage: 50, role: "co_owner" },
    ] }, client);
    const plan = await planMergeProfiles(storage, "Linda", "Linda Carter");
    expect(plan.preview.shares_moved).toBe(1);
    expect(plan.message).toMatch(/1 ownership share/);
    const res = await executeMergeProfiles(storage, storage._plans.get(plan.plan_id));
    expect(res.executed).toBe(true);
    expect(res.merged.shares_moved).toBe(1);
    const moved = writes.find((w) => w.table === "asset_party_links" && w.op === "update");
    expect(moved?.payload).toEqual({ party_profile_id: LINDA2 });
    expect(moved?.eq).toContainEqual(["id", "apl-linda"]);
    // Nothing on the link table was deleted; the source profile was archived.
    expect(writes.filter((w) => w.table === "asset_party_links" && w.op === "delete")).toHaveLength(0);
    expect(writes.some((w) => w.table === "profiles" && w.op === "update" && w.payload?.deleted_at)).toBe(true);
  });

  it("sums into the target's existing share on the same loan and drops the source row first", async () => {
    const { client, writes } = recorderClient();
    const storage = stubStorage({ liability: [
      { id: "lpl-linda", liabilityProfileId: LOAN, partyProfileId: LINDA, ownershipPercentage: 30 },
      { id: "lpl-linda2", liabilityProfileId: LOAN, partyProfileId: LINDA2, ownershipPercentage: 20 },
      { id: "lpl-self", liabilityProfileId: LOAN, partyProfileId: SELF, ownershipPercentage: 50 },
    ] }, client);
    const plan = await planMergeProfiles(storage, "Linda", "Linda Carter");
    const res = await executeMergeProfiles(storage, storage._plans.get(plan.plan_id));
    expect(res.merged.shares_moved).toBe(1);
    const linkWrites = writes.filter((w) => w.table === "liability_profile_links");
    expect(linkWrites.map((w) => w.op)).toEqual(["delete", "update"]);
    expect(linkWrites[0].eq).toContainEqual(["id", "lpl-linda"]);
    expect(linkWrites[1].payload).toEqual({ ownership_percentage: 50 });
    expect(linkWrites[1].eq).toContainEqual(["id", "lpl-linda2"]);
  });

  it("undo gives the shares back: re-points the moved row and re-inserts an absorbed one", async () => {
    const { client, writes } = recorderClient();
    const storage = stubStorage({}, client);
    const out = await reverseMerge(storage, {
      source_id: LINDA, target_id: LINDA2, affected: {}, child_ids: [],
      shares: [
        { table: "asset_party_links", id: "apl-linda", subjectId: CAR, pct: 50, role: "co_owner" },
        { table: "liability_profile_links", id: "lpl-linda", subjectId: LOAN, pct: 30, mergeIntoId: "lpl-linda2", mergeIntoPct: 20 },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.description).toMatch(/2 ownership share/);
    const asset = writes.find((w) => w.table === "asset_party_links");
    expect(asset?.op).toBe("update");
    expect(asset?.payload).toEqual({ party_profile_id: LINDA });
    const liab = writes.filter((w) => w.table === "liability_profile_links");
    expect(liab.map((w) => w.op)).toEqual(["update", "insert"]);
    expect(liab[0].payload).toEqual({ ownership_percentage: 20 });
    expect(liab[1].payload).toMatchObject({ id: "lpl-linda", liability_profile_id: LOAN, party_profile_id: LINDA, ownership_percentage: 30 });
  });
});

// D126 — the merge left three more kinds of rows naming the source by id:
// entity_links (the relationship graph), tracker_entries logged FOR the
// person, and per-person budgets.
describe("D126: merging re-points relationship links, entries logged for the person, and budgets", () => {
  const reads = (table: string) => table === "entity_links"
    ? [{ id: "el-1", source_type: "task", source_id: "t1", target_type: "profile", target_id: LINDA }, { id: "el-2", source_type: "profile", source_id: LINDA, target_type: "document", target_id: "d1" }, { id: "el-x", source_type: "task", source_id: "t2", target_type: "profile", target_id: LINDA2 }]
    : table === "tracker_entries" ? [{ id: "te-1" }, { id: "te-2" }] : [];
  const budgets = { "2026-09": [
    { id: "b-food-l", category: "food", amount: 200, profileId: LINDA },
    { id: "b-fuel-l", category: "fuel", amount: 80, profileId: LINDA },
    { id: "b-food-l2", category: "Food", amount: 300, profileId: LINDA2 },
    { id: "b-self", category: "food", amount: 500 },
  ] };
  it("previews and executes the re-pointing; a budget category the target already has is dropped", async () => {
    const { client, writes } = recorderClient(reads);
    const storage = stubStorage({ budgets }, client);
    const plan = await planMergeProfiles(storage, "Linda", "Linda Carter");
    expect(plan.preview.references_moved).toBe(2 + 2 + 2);
    expect(plan.message).toMatch(/re-point 6 linked records/);
    const res = await executeMergeProfiles(storage, storage._plans.get(plan.plan_id));
    expect(res.merged.references_moved).toBe(6);
    const el = writes.filter((w) => w.table === "entity_links");
    expect(el.map((w) => [w.payload, w.eq[0]])).toEqual([[{ target_id: LINDA2 }, ["id", "el-1"]], [{ source_id: LINDA2 }, ["id", "el-2"]]]);
    const te = writes.find((w) => w.table === "tracker_entries");
    expect(te?.payload).toEqual({ profile_id: LINDA2 });
    expect(te?.in).toEqual(["id", ["te-1", "te-2"]]);
    expect(storage._budgets["2026-09"].map((b: any) => [b.id, b.profileId])).toEqual([["b-fuel-l", LINDA2], ["b-food-l2", LINDA2], ["b-self", undefined]]);
  });
  it("undo re-points the links and entries back and restores the dropped budget", async () => {
    const { client, writes } = recorderClient();
    const storage = stubStorage({ budgets: { "2026-09": [
      { id: "b-fuel-l", category: "fuel", amount: 80, profileId: LINDA2 },
      { id: "b-food-l2", category: "Food", amount: 300, profileId: LINDA2 },
    ] } }, client);
    const out = await reverseMerge(storage, {
      source_id: LINDA, target_id: LINDA2, affected: {}, child_ids: [],
      entity_links: [{ id: "el-1", side: "target" }, { id: "el-2", side: "source" }],
      tracker_entry_ids: ["te-1", "te-2"],
      budgets: [{ month: "2026-09", movedIds: ["b-fuel-l"], dropped: [{ id: "b-food-l", category: "food", amount: 200, profileId: LINDA }] }],
    });
    expect(out.ok).toBe(true);
    expect(out.description).toMatch(/6 linked record/);
    expect(writes.filter((w) => w.table === "entity_links").map((w) => w.payload)).toEqual([{ target_id: LINDA }, { source_id: LINDA }]);
    expect(writes.find((w) => w.table === "tracker_entries")?.payload).toEqual({ profile_id: LINDA });
    expect(storage._budgets["2026-09"].map((b: any) => [b.id, b.profileId])).toEqual([["b-fuel-l", LINDA], ["b-food-l2", LINDA2], ["b-food-l", LINDA]]);
  });
});
