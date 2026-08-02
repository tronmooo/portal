import { describe, it, expect } from "vitest";
import {
  bootstrapSeedEntries,
  isTrimmedSeedEntry,
  projectBootstrapShell,
} from "../client/src/lib/bootstrap-seed-keys";
import { scopedKey, goalsQueryKey } from "../shared/query-keys";

// These pin the two hazards the perf audit called out for the single
// round-trip dashboard paint:
//   1. The seed key shapes MUST match what the live tab readers request, or the
//      seeded cache is dead weight (a miss on every mount).
//   2. Over-cap persistence must degrade to a bounded shell, never silently drop
//      the whole entry (which regressed exactly the heavy-data users).

const MONTH = "2026-07";

function sampleBootstrap() {
  return {
    stats: { net: 1 },
    enhanced: { score: 2 },
    profiles: [{ id: "self-1", type: "self" }],
    incomes: [{ id: "i1" }],
    budgetSummary: { total: 3 },
    expenses: [{ id: "e1" }, { id: "e2" }],
    budgets: [{ id: "b1" }],
    obligations: [{ id: "o1" }],
    assetPartyLinks: [{ id: "apl1" }],
    liabilityProfileLinks: [{ id: "lpl1" }],
    tasks: [{ id: "t1" }],
    habits: [{ id: "h1" }],
    goals: [{ id: "g1" }],
    journal: [{ id: "j1" }],
    events: [{ id: "ev1" }],
    documents: [{ id: "d1" }],
    trackers: [{ id: "tr1" }],
    reminders: [{ id: "r1" }],
  };
}

describe("bootstrapSeedEntries", () => {
  it("seeds the everyone-scope keys the unfiltered dashboard reads", () => {
    const entries = bootstrapSeedEntries(sampleBootstrap(), "everyone", [], MONTH);
    const byKey = new Map(entries.map((e) => [JSON.stringify(e.key), e.data]));

    expect(byKey.get(JSON.stringify([...scopedKey("/api/stats", "everyone", [])]))).toEqual({ net: 1 });
    expect(byKey.get(JSON.stringify([...scopedKey("/api/expenses", "everyone", [])]))).toHaveLength(2);
    // Profiles + link tables are global (not profile-scoped) keys.
    expect(byKey.has(JSON.stringify(["/api/profiles"]))).toBe(true);
    expect(byKey.has(JSON.stringify(["/api/asset-party-links"]))).toBe(true);
    expect(byKey.has(JSON.stringify(["/api/liability-profile-links"]))).toBe(true);
  });

  it("seeds goals exactly once, on the slot goalsQueryKey collapses to (no double-seed)", () => {
    const entries = bootstrapSeedEntries(sampleBootstrap(), "everyone", [], MONTH);
    const goalKeyStr = JSON.stringify([...goalsQueryKey([])]);
    const goalEntries = entries.filter((e) => JSON.stringify(e.key) === goalKeyStr);
    expect(goalEntries).toHaveLength(1);
  });

  it("scopes list keys to the selected profile ids", () => {
    const entries = bootstrapSeedEntries(sampleBootstrap(), "selected", ["p1"], MONTH);
    const keys = entries.map((e) => JSON.stringify(e.key));
    expect(keys).toContain(JSON.stringify([...scopedKey("/api/tasks", "selected", ["p1"])]));
    // The unfiltered slot must NOT be seeded when a selection is active.
    expect(keys).not.toContain(JSON.stringify([...scopedKey("/api/tasks", "everyone", [])]));
  });

  it("never seeds a slot with null/undefined data (a partial bootstrap can't clobber)", () => {
    const partial = { ...sampleBootstrap(), tasks: null, habits: undefined } as any;
    const entries = bootstrapSeedEntries(partial, "everyone", [], MONTH);
    const keys = entries.map((e) => JSON.stringify(e.key));
    expect(keys).not.toContain(JSON.stringify([...scopedKey("/api/tasks", "everyone", [])]));
    expect(keys).not.toContain(JSON.stringify([...scopedKey("/api/habits", "everyone", [])]));
    // Present slots still seed.
    expect(keys).toContain(JSON.stringify([...scopedKey("/api/expenses", "everyone", [])]));
  });

  it("returns nothing for a non-object payload", () => {
    expect(bootstrapSeedEntries(null, "everyone", [], MONTH)).toEqual([]);
    expect(bootstrapSeedEntries(undefined, "everyone", [], MONTH)).toEqual([]);
    expect(bootstrapSeedEntries("nope" as any, "everyone", [], MONTH)).toEqual([]);
  });

  it("never seeds an EMPTY list (a stale snapshot can't assert 'you have none')", () => {
    // The 2026-08-02 report: the Trackers tab said "0 trackers / No trackers
    // yet" for a user who had trackers. A bootstrap snapshot captured before
    // they existed re-installed `trackers: []` on every launch, and because
    // hydrateQueryCache stamps seeds FRESH, refetchOnMount would not correct it
    // for the full 3-minute staleTime. An absent slot just fetches; a `[]` slot
    // is a confident, durable, wrong answer — so empty lists never seed.
    const empty = { ...sampleBootstrap(), trackers: [], tasks: [] } as any;
    const keys = bootstrapSeedEntries(empty, "everyone", [], MONTH).map((e) => JSON.stringify(e.key));
    expect(keys).not.toContain(JSON.stringify([...scopedKey("/api/trackers", "everyone", [])]));
    expect(keys).not.toContain(JSON.stringify([...scopedKey("/api/trackers", "everyone", [], "trends")]));
    expect(keys).not.toContain(JSON.stringify([...scopedKey("/api/tasks", "everyone", [])]));
    // Non-empty slots are unaffected.
    expect(keys).toContain(JSON.stringify([...scopedKey("/api/expenses", "everyone", [])]));
  });

  it("tags list entries with their source field so truncation is detectable", () => {
    const entries = bootstrapSeedEntries(sampleBootstrap(), "everyone", [], MONTH);
    const trackers = entries.find(
      (e) => JSON.stringify(e.key) === JSON.stringify([...scopedKey("/api/trackers", "everyone", [])]),
    );
    expect(trackers?.field).toBe("trackers");
    // Aggregates aren't trimmable, so they carry no field.
    const stats = entries.find(
      (e) => JSON.stringify(e.key) === JSON.stringify([...scopedKey("/api/stats", "everyone", [])]),
    );
    expect(stats?.field).toBeUndefined();
  });
});

describe("isTrimmedSeedEntry", () => {
  // Why this matters: hydrateQueryCache stamps seeds fresh so a launch fires
  // ONE refetch instead of twenty. That's right for a complete list and wrong
  // for a truncated one — a heavy-data user would paint their first 100 rows
  // and keep them for the whole staleTime ("not all my trackers show up").
  // Truncated entries get the persisted timestamp instead, so they're stale on
  // arrival and refetch behind the already-painted rows.
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));

  it("flags a list the shell projection truncated", () => {
    const full = { ...sampleBootstrap(), trackers: rows(250) };
    const shell = projectBootstrapShell(full, 100);
    const entry = bootstrapSeedEntries(shell, "everyone", [], MONTH).find((e) => e.field === "trackers")!;
    expect(entry.data).toHaveLength(100);
    expect(isTrimmedSeedEntry(entry, shell)).toBe(true);
  });

  it("does not flag a list that fit", () => {
    const full = { ...sampleBootstrap(), trackers: rows(3), expenses: rows(250) };
    const shell = projectBootstrapShell(full, 100);
    const entry = bootstrapSeedEntries(shell, "everyone", [], MONTH).find((e) => e.field === "trackers")!;
    // expenses WAS trimmed, so the payload is marked trimmed — but trackers
    // itself is complete and must keep the fast fresh stamp.
    expect(shell.__shell.trimmed).toBe(true);
    expect(isTrimmedSeedEntry(entry, shell)).toBe(false);
  });

  it("does not flag anything in an untrimmed payload", () => {
    const payload = sampleBootstrap();
    for (const entry of bootstrapSeedEntries(payload, "everyone", [], MONTH)) {
      expect(isTrimmedSeedEntry(entry, payload)).toBe(false);
    }
  });

  it("tolerates a payload with no shell marker (older persisted snapshot)", () => {
    const payload = sampleBootstrap();
    const entry = bootstrapSeedEntries(payload, "everyone", [], MONTH).find((e) => e.field === "trackers")!;
    expect(isTrimmedSeedEntry(entry, { ...payload, __shell: undefined })).toBe(false);
  });
});

describe("projectBootstrapShell", () => {
  it("slices scaling lists to maxRows while keeping aggregates whole", () => {
    const big = {
      stats: { net: 1 },
      enhanced: { score: 2 },
      budgetSummary: { total: 3 },
      profiles: [{ id: "self-1" }],
      expenses: Array.from({ length: 250 }, (_, i) => ({ id: `e${i}` })),
      tasks: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` })),
    };
    const shell = projectBootstrapShell(big, 100);
    expect(shell.expenses).toHaveLength(100);
    // Under the cap => untouched.
    expect(shell.tasks).toHaveLength(5);
    // Aggregates/summaries stay whole so the KPI numbers remain correct.
    expect(shell.stats).toEqual({ net: 1 });
    expect(shell.enhanced).toEqual({ score: 2 });
    expect(shell.budgetSummary).toEqual({ total: 3 });
    expect(shell.__shell.trimmed).toBe(true);
    expect(shell.__shell.counts.expenses).toBe(250);
    expect(shell.__shell.counts.tasks).toBe(5);
  });

  it("does not mutate the input payload", () => {
    const big = { expenses: Array.from({ length: 250 }, (_, i) => ({ id: `e${i}` })) };
    const shell = projectBootstrapShell(big, 100);
    expect(big.expenses).toHaveLength(250);
    expect(shell.expenses).toHaveLength(100);
  });

  it("marks trimmed=false when everything already fits", () => {
    const small = { expenses: [{ id: "e1" }], tasks: [{ id: "t1" }] };
    const shell = projectBootstrapShell(small, 100);
    expect(shell.__shell.trimmed).toBe(false);
    expect(shell.expenses).toHaveLength(1);
  });
});
