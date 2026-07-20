import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// [PERF 2026-07-20 "tabs should already be loaded"] On a fresh app open the
// persisted snapshot restores the /api/dashboard-bootstrap entry, but the
// per-tab query keys it seeds only ever existed as a side effect of the
// bootstrap queryFn running — so every hub tab still mounted cold.
// seedFromHydratedBootstrap re-runs the seeding over hydrated bootstrap
// entries at boot, stamped with the snapshot's timestamp so background
// refetches still fire.

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

let queryClient: any;
let seedFromHydratedBootstrap: any;
let seedDashboardCaches: any;

const MONTH = "2026-07";
const BOOTSTRAP = {
  stats: { netWorth: 100 },
  enhanced: { hero: 1 },
  profiles: [{ id: "p1", type: "self" }],
  incomes: [{ id: "i1" }],
  budgetSummary: { totalBudget: 10, totalSpent: 5, remaining: 5 },
  expenses: [{ id: "e1" }],
  budgets: [{ id: "b1" }],
  obligations: [{ id: "o1" }],
  tasks: [{ id: "t1" }],
  habits: [{ id: "h1" }],
  goals: [{ id: "g1" }],
  journal: [{ id: "j1" }],
  events: [{ id: "ev1" }],
  documents: [{ id: "d1" }],
  trackers: [{ id: "tr1" }],
  reminders: [{ id: "r1" }],
  paychecks: [{ id: "pc1" }],
};

beforeEach(async () => {
  vi.resetModules();
  (globalThis as any).localStorage = makeStorage();
  (globalThis as any).sessionStorage = makeStorage();
  const qcMod = await import("../client/src/lib/queryClient");
  queryClient = qcMod.queryClient;
  const seedMod = await import("../client/src/lib/bootstrap-seed");
  seedFromHydratedBootstrap = seedMod.seedFromHydratedBootstrap;
  seedDashboardCaches = seedMod.seedDashboardCaches;
  queryClient.clear();
});

afterEach(() => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).sessionStorage;
});

describe("seedFromHydratedBootstrap", () => {
  it("re-seeds every tab key from a hydrated bootstrap entry, stamped with its age", () => {
    const snapshotAge = Date.now() - 10 * 60_000; // 10 minutes old
    queryClient.setQueryData(
      ["/api/dashboard-bootstrap", "selected", "p1", MONTH],
      BOOTSTRAP,
      { updatedAt: snapshotAge },
    );

    seedFromHydratedBootstrap();

    // A representative key per hub tab (Trackers/Finance/Wellness/Calendar…).
    expect(queryClient.getQueryData(["/api/trackers", "selected", "p1"])).toEqual([{ id: "tr1" }]);
    expect(queryClient.getQueryData(["/api/expenses", "selected", "p1"])).toEqual([{ id: "e1" }]);
    expect(queryClient.getQueryData(["/api/paychecks", "selected", "p1"])).toEqual([{ id: "pc1" }]);
    expect(queryClient.getQueryData(["/api/habits", "selected", "p1"])).toEqual([{ id: "h1" }]);
    expect(queryClient.getQueryData(["/api/events", "selected", "p1"])).toEqual([{ id: "ev1" }]);
    expect(queryClient.getQueryData(["/api/stats", "selected", "p1"])).toEqual({ netWorth: 100 });
    expect(queryClient.getQueryData(["/api/profiles"])).toEqual([{ id: "p1", type: "self" }]);

    // Seeds carry the SNAPSHOT's timestamp (stale → background refetch), not "now".
    const state = queryClient.getQueryState(["/api/trackers", "selected", "p1"]);
    expect(state!.dataUpdatedAt).toBe(snapshotAge);
  });

  it("never clobbers a key that already holds fresher data", () => {
    const snapshotAge = Date.now() - 10 * 60_000;
    queryClient.setQueryData(
      ["/api/dashboard-bootstrap", "everyone", MONTH],
      BOOTSTRAP,
      { updatedAt: snapshotAge },
    );
    // A fresher entry for the same key (e.g. hydrated directly, or an early fetch).
    queryClient.setQueryData(["/api/stats", "everyone"], { netWorth: 999 });

    seedFromHydratedBootstrap();

    expect(queryClient.getQueryData(["/api/stats", "everyone"])).toEqual({ netWorth: 999 });
    // Other keys still seed normally.
    expect(queryClient.getQueryData(["/api/trackers", "everyone"])).toEqual([{ id: "tr1" }]);
  });

  it("parses the everyone-scope key shape (no ids) correctly", () => {
    queryClient.setQueryData(
      ["/api/dashboard-bootstrap", "everyone", MONTH],
      BOOTSTRAP,
      { updatedAt: Date.now() - 60_000 },
    );
    seedFromHydratedBootstrap();
    expect(queryClient.getQueryData(["/api/obligations", "everyone"])).toEqual([{ id: "o1" }]);
    expect(queryClient.getQueryData(["/api/budgets/summary", MONTH, "everyone"])).toEqual(BOOTSTRAP.budgetSummary);
  });

  it("is a no-op with nothing hydrated and ignores malformed entries", () => {
    queryClient.setQueryData(["/api/dashboard-bootstrap"], BOOTSTRAP); // too-short key
    queryClient.setQueryData(["/api/expenses"], [{ id: "keep" }]);
    seedFromHydratedBootstrap();
    expect(queryClient.getQueryData(["/api/expenses"])).toEqual([{ id: "keep" }]);
  });

  it("fresh network seeds (no updatedAt) still overwrite unconditionally", () => {
    queryClient.setQueryData(["/api/stats", "everyone"], { netWorth: 1 });
    seedDashboardCaches(BOOTSTRAP, "everyone", [], MONTH);
    expect(queryClient.getQueryData(["/api/stats", "everyone"])).toEqual({ netWorth: 100 });
  });
});
