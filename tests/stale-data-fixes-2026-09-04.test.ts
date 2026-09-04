import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { bootstrapSeedEntries, projectBootstrapShell, shellTrimmedFields } from "../client/src/lib/bootstrap-seed-keys";
import { reconcileProfileFilter, getProfileFilter, setFilterSelected } from "../client/src/lib/profileFilter";
import { targetForStorageMethod } from "../shared/storage-domains";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/**
 * The 2026-09-04 stale-data sweep. Each block names the symptom a user would
 * have reported, because that is what these are guarding — not the shape of
 * the code that happens to fix it.
 */
describe("cache bus reaches the keys it was written for", () => {
  const src = read("client/src/lib/cache-bus.ts");

  it("matches ownership keys whose id is the SECOND segment", () => {
    // ["/api/assets", id, "parties"] has k0 === "/api/assets" — no trailing
    // slash — so a `startsWith("/api/assets/")` test matched none of them and
    // the ownership panels never refreshed from anywhere else in the app.
    expect(src).not.toMatch(/startsWith\("\/api\/assets\/"\)/);
    expect(src).not.toMatch(/startsWith\("\/api\/liabilities\/"\)/);
    expect(src).toMatch(/startsWith\("\/api\/assets"\)/);
    expect(src).toMatch(/startsWith\("\/api\/liabilities"\)/);
  });

  it("covers the endpoints that belonged to no domain at all", () => {
    for (const key of [
      "/api/obligation-occurrences", // skipping a bill left the calendar showing it
      "/api/anomalies",              // the Insights anomaly list refreshed after nothing
      "/api/notes",                  // a note written elsewhere never reached the profile
    ]) {
      expect(src).toContain(`["${key}"]`);
    }
    // The connected-bank panels, reached by predicate rather than by key.
    expect(src).toMatch(/startsWith\("\/api\/finance\/"\)/);
  });

  it("treats paying a bill as money leaving an account", () => {
    // The obligations domain is what every bill surface fires. Without these
    // the month's spend, the budget bars, the account balance and the
    // net-worth trend all kept the pre-payment picture.
    const obligations = src.slice(src.indexOf("  obligations: ["), src.indexOf("  budgets: ["));
    for (const key of ["/api/expenses", "/api/budgets", "/api/budgets/summary", "/api/accounts", "/api/net-worth/history"]) {
      expect(obligations).toContain(`["${key}"]`);
    }
  });
});

describe("the launch snapshot does not present a shell as the whole account", () => {
  const bootstrap = {
    stats: { a: 1 },
    tasks: Array.from({ length: 300 }, (_, i) => ({ id: `t${i}` })),
    habits: [{ id: "h1" }],
  };

  it("names the lists it truncated", () => {
    const shell = projectBootstrapShell(bootstrap, 100);
    const trimmed = shellTrimmedFields(shell);
    expect(trimmed.has("tasks")).toBe(true);
    // habits fit whole — it must NOT be marked stale, or the fix costs a
    // request per launch for nothing.
    expect(trimmed.has("habits")).toBe(false);
  });

  it("says nothing was truncated for a whole payload", () => {
    expect(shellTrimmedFields(bootstrap).size).toBe(0);
    expect(shellTrimmedFields(projectBootstrapShell(bootstrap, 1000)).size).toBe(0);
  });

  it("tags each seeded slot with the list it came from", () => {
    const entries = bootstrapSeedEntries(bootstrap, "everyone", [], "2026-09");
    const tasks = entries.find((e) => e.key[0] === "/api/tasks");
    const stats = entries.find((e) => e.key[0] === "/api/stats");
    expect(tasks?.field).toBe("tasks");
    // Aggregates are never trimmed, so they carry no field.
    expect(stats?.field).toBeUndefined();
  });
});

describe("a renamed profile is called by its new name", () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it("refreshes the stored scope label even when every id still resolves", () => {
    setFilterSelected(["p1"], ["Mike"]);
    // The id is still live — the early return this used to take is exactly the
    // rename case, which is why the header kept saying "Mike" across reloads.
    reconcileProfileFilter([{ id: "p1", name: "Michael", type: "person" }]);
    expect(getProfileFilter().selectedNames).toEqual(["Michael"]);
    expect(getProfileFilter().selectedIds).toEqual(["p1"]);
  });

  it("leaves an unchanged selection completely alone", () => {
    setFilterSelected(["p1"], ["Mike"]);
    reconcileProfileFilter([{ id: "p1", name: "Mike", type: "person" }]);
    expect(getProfileFilter().selectedNames).toEqual(["Mike"]);
  });
});

describe("destroying a document is a write", () => {
  it("journals purgeDocument, so the response carries a change manifest", () => {
    const target = targetForStorageMethod("purgeDocument");
    expect(target).not.toBeNull();
    expect(target?.op).toBe("delete");
    expect(target?.domains).toContain("documents");
  });
});

describe("writes wait for the network instead of being discarded", () => {
  it("pauses mutations offline while reads still fail fast", () => {
    const src = read("client/src/lib/queryClient.ts");
    const mutations = src.slice(src.indexOf("    mutations: {"));
    expect(mutations).toMatch(/networkMode: "online"/);
    // Queries keep "always": a read that fails offline should let cached data
    // stand rather than hang.
    const queries = src.slice(src.indexOf("    queries: {"), src.indexOf("    mutations: {"));
    expect(queries).toMatch(/networkMode: "always"/);
  });
});

describe("freshness arrives on events that imply staleness", () => {
  const src = read("client/src/lib/queryClient.ts");

  it("refreshes on reconnect, on a long return, and at a day change", () => {
    expect(src).toMatch(/addEventListener\("online"/);
    expect(src).toMatch(/RESUME_REFRESH_AFTER_MS/);
    expect(src).toMatch(/checkDayRollover/);
  });

  it("never fights an in-flight fetch", () => {
    // Invalidating a fetching query cancels and restarts it — the wasted round
    // trip wedged-query recovery exists to avoid.
    const fn = src.slice(src.indexOf("export function refreshActiveQueries"));
    expect(fn.slice(0, 900)).toMatch(/fetchStatus === "idle"/);
  });
});

describe("search does not answer from before the write", () => {
  const src = read("client/src/components/CommandSearch.tsx");

  it("drops its own cache when anything changes", () => {
    expect(src).toMatch(/subscribeDataChange/);
    expect(src).toMatch(/cacheRef\.current\.clear\(\)/);
  });

  it("filters out rows the app has already deleted", () => {
    expect(src).toMatch(/isTombstoned\(item\?\.id\)/);
  });
});
