// ── System validate/repair/refresh unit tests (server/ai-system-tools.ts) ────
import { describe, it, expect } from "vitest";
import {
  validateProfileIsolation, findDuplicates, validateDashboardCounts,
  findMisclassifiedProfiles, repairMisclassifiedProfiles,
} from "../server/ai-system-tools";
import { explainDashboardItem } from "../server/dashboard-explain";

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
    getNotes: async () => [],
    listReminders: async () => [],
    getDocuments: async () => [],
    getPaychecks: async () => [],
    ...overrides,
  };
}

describe("validateProfileIsolation", () => {
  it("valid when all links point at owned profiles (orphans = self, valid)", async () => {
    const storage = stubStorage({
      getTasks: async () => [
        { id: "t1", title: "A", linkedProfiles: ["mike-1"] },
        { id: "t2", title: "B", linkedProfiles: [] },
      ],
    });
    const res = await validateProfileIsolation(storage);
    expect(res.isolation_valid).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it("flags records pointing at unknown profile ids", async () => {
    const storage = stubStorage({
      getTasks: async () => [{ id: "t9", title: "Stale", linkedProfiles: ["ghost-1"] }],
    });
    const res = await validateProfileIsolation(storage);
    expect(res.isolation_valid).toBe(false);
    expect(res.violations[0]).toMatchObject({ type: "task", id: "t9", unknown_profile_ids: ["ghost-1"] });
  });
});

describe("findDuplicates", () => {
  it("groups same-name same-links tasks; distinct links are not duplicates", async () => {
    const storage = stubStorage({
      getTasks: async () => [
        { id: "t1", title: "Buy milk", linkedProfiles: ["self-1"] },
        { id: "t2", title: "buy  MILK", linkedProfiles: ["self-1"] },
        { id: "t3", title: "Buy milk", linkedProfiles: ["mike-1"] },
      ],
    });
    const res = await findDuplicates(storage, "task");
    expect(res.count).toBe(1);
    expect(res.duplicate_groups[0]).toMatchObject({ type: "task", count: 2 });
  });

  it("expense heuristic: same description + amount ±1% + date ±3d", async () => {
    const storage = stubStorage({
      getExpenses: async () => [
        { id: "e1", description: "Latte", amount: 5.0, date: "2026-07-08" },
        { id: "e2", description: "latte", amount: 5.04, date: "2026-07-10" },
        { id: "e3", description: "Latte", amount: 9.0, date: "2026-07-10" },
      ],
    });
    const res = await findDuplicates(storage, "expense");
    expect(res.count).toBe(1);
    expect(res.duplicate_groups[0].ids.sort()).toEqual(["e1", "e2"]);
  });

  it("person profiles dedupe via the shared normalizer; different types don't collide", async () => {
    const storage = stubStorage({
      getProfiles: async () => [
        { id: "p1", type: "person", name: "Mike Smith" },
        { id: "p2", type: "person", name: "mike smith" },
        { id: "p3", type: "vehicle", name: "Honda" },
        { id: "p4", type: "liability", name: "Honda" },
      ],
    });
    const res = await findDuplicates(storage, "profile");
    expect(res.count).toBe(1);
    expect(res.duplicate_groups[0].ids.sort()).toEqual(["p1", "p2"]);
  });

  it("reports cleanly when nothing matches", async () => {
    const res = await findDuplicates(stubStorage());
    expect(res.count).toBe(0);
    expect(res.message).toMatch(/No likely duplicates/);
  });
});

describe("validateDashboardCounts", () => {
  it("valid when stats agree; reports mismatched tiles otherwise", async () => {
    const mkStats = (tasks: number) => ({
      totalProfiles: 2, totalTrackers: 0, totalTasks: tasks, activeTasks: tasks,
      totalExpenses: 0, totalEvents: 0, monthlySpend: 0, weeklyEntries: 0,
      streaks: [], recentActivity: [], totalHabits: 0, habitCompletionRate: 0,
      totalObligations: 0, upcomingObligations: 0, monthlyObligationTotal: 0,
      journalStreak: 0, totalArtifacts: 0, totalMemories: 0,
    });
    const okStorage = stubStorage({
      getTasks: async () => [{ id: "t1", title: "A" }],
      getStats: async () => mkStats(1),
    });
    expect((await validateDashboardCounts(okStorage)).valid).toBe(true);

    const badStorage = stubStorage({
      getTasks: async () => [{ id: "t1", title: "A" }],
      getStats: async () => mkStats(5),
    });
    const bad = await validateDashboardCounts(badStorage);
    expect(bad.valid).toBe(false);
    expect(bad.mismatches[0]).toMatchObject({ tile: "tasks", dashboard_shows: 5, database_has: 1 });
  });
});

describe("explainDashboardItem", () => {
  const todayStr = new Date().toISOString().slice(0, 10);

  it("explains a due-today task as Today's Agenda", async () => {
    const storage = stubStorage({
      getTasks: async () => [{ id: "t1", title: "Pay water bill", dueDate: todayStr, linkedProfiles: [] }],
    });
    const res = await explainDashboardItem(storage, "water bill");
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0].reasons.join(" ")).toMatch(/due today/i);
  });

  it("explains an overdue obligation", async () => {
    const past = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const storage = stubStorage({
      getObligations: async () => [{ id: "o1", name: "Mortgage", nextDueDate: past, frequency: "monthly" }],
    });
    const res = await explainDashboardItem(storage, "mortgage");
    expect(res.matches[0].reasons.join(" ")).toMatch(/OVERDUE/);
  });

  it("says so honestly when nothing matches", async () => {
    const res = await explainDashboardItem(stubStorage(), "nonexistent thing");
    expect(res.matches).toEqual([]);
    expect(res.message).toMatch(/couldn't find/i);
  });
});


// ── Objects filed as people (2026-08-09 cleanup) ────────────────────────────
// "Create a profile for my MacBook Pro m4" left a PERSON row named "my MacBook
// Pro m4" in the profile picker next to real people. create_profile no longer
// defaults an invalid type to "person", but the rows already written need
// removing. Detection keys ONLY on a leading "my"/"our" on a person/pet row —
// no human is named that, so a real person can never be caught by it.
describe("misclassified profile repair", () => {
  const SELF = { id: "self-1", type: "self", name: "Poop", fields: {} };
  const REAL_PERSON = { id: "p-mike", type: "person", name: "Mike", fields: { phone: "555-0100" } };
  const REAL_ASSET = { id: "a-mac", type: "asset", name: "MacBook Pro M4", fields: {} };
  const TWIN = { id: "x-mac", type: "person", name: "my MacBook Pro m4", fields: {} };
  const LONE = { id: "x-ram", type: "person", name: "my 2025 Dodge ram", fields: {} };

  const withProfiles = (rows: any[]) => stubStorage({
    getProfiles: async () => rows,
    updateProfile: async (id: string, data: any) => ({ id, ...data }),
    deleteProfile: async () => true,
  });

  it("finds the bogus person rows and leaves real people alone", async () => {
    const res = await findMisclassifiedProfiles(withProfiles([SELF, REAL_PERSON, REAL_ASSET, TWIN, LONE]));
    expect(res.issue_count).toBe(2);
    const names = res.issues.map((i: any) => i.name);
    expect(names).toEqual(expect.arrayContaining(["my MacBook Pro m4", "my 2025 Dodge ram"]));
    expect(names).not.toContain("Mike");
    expect(names).not.toContain("Poop");
    expect(names).not.toContain("MacBook Pro M4");
  });

  it("removes the twin when the real asset already exists, retypes when it doesn't", async () => {
    const res = await findMisclassifiedProfiles(withProfiles([SELF, REAL_ASSET, TWIN, LONE]));
    const byName = Object.fromEntries(res.issues.map((i: any) => [i.name, i]));
    expect(byName["my MacBook Pro m4"].action).toBe("delete_duplicate");
    expect(byName["my MacBook Pro m4"].duplicateOfId).toBe("a-mac");
    expect(byName["my 2025 Dodge ram"].action).toBe("retype");
    expect(byName["my 2025 Dodge ram"].suggestedName).toBe("2025 Dodge ram");
  });

  it("never touches a person carrying real human fields", async () => {
    const oddlyNamed = { id: "p-odd", type: "person", name: "my Brother Dave", fields: { phone: "555-0199" } };
    const res = await findMisclassifiedProfiles(withProfiles([SELF, oddlyNamed]));
    expect(res.issue_count).toBe(0);
  });

  it("retypes rather than deletes when the row has children", async () => {
    const child = { id: "c-1", type: "asset", name: "Charger", parentProfileId: "x-mac", fields: {} };
    const res = await findMisclassifiedProfiles(withProfiles([SELF, REAL_ASSET, TWIN, child]));
    expect(res.issues.find((i: any) => i.id === "x-mac").action).toBe("retype");
  });

  it("reports a clean bill when nothing is misclassified", async () => {
    const res = await findMisclassifiedProfiles(withProfiles([SELF, REAL_PERSON, REAL_ASSET]));
    expect(res.issue_count).toBe(0);
    expect(res.message).toMatch(/No misclassified profiles/i);
  });

  it("applies both repairs and reports what it did", async () => {
    const deleted: string[] = [];
    const updated: Array<{ id: string; data: any }> = [];
    const storage = stubStorage({
      getProfiles: async () => [SELF, REAL_ASSET, TWIN, LONE],
      deleteProfile: async (id: string) => { deleted.push(id); return true; },
      updateProfile: async (id: string, data: any) => { updated.push({ id, data }); return { id, ...data }; },
    });
    const res = await repairMisclassifiedProfiles(storage);
    expect(res.repaired_count).toBe(2);
    expect(deleted).toEqual(["x-mac"]);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe("x-ram");
    expect(updated[0].data.type).toBe("asset");
    expect(updated[0].data.name).toBe("2025 Dodge ram");
    expect(res.message).toMatch(/recoverable/i);
  });

  it("is a no-op on clean data", async () => {
    const deleted: string[] = [];
    const storage = stubStorage({
      getProfiles: async () => [SELF, REAL_PERSON, REAL_ASSET],
      deleteProfile: async (id: string) => { deleted.push(id); return true; },
      updateProfile: async () => ({}),
    });
    const res = await repairMisclassifiedProfiles(storage);
    expect(res.repaired_count).toBe(0);
    expect(deleted).toEqual([]);
  });
});
