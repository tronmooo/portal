// Rules 2 and 6 — a mutation reaches every view derived from it.
//
// Derived payloads (the bell, the calendar, the date rules, the dashboard
// aggregates) declare the domains their server computation reads, once, in
// client/src/lib/cache-bus.ts DERIVED_ENDPOINT_DEPENDENCIES; the bus adds each
// one to every source domain. These tests hold that table to the server's
// actual reads, so adding a source to a derived payload without declaring it
// fails here instead of shipping a stale bell.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { queryClient } from "../client/src/lib/queryClient";
import { DERIVED_ENDPOINT_DEPENDENCIES, domainKeys, invalidateDomains, __resetManifestCoverage } from "../client/src/lib/cache-bus";

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");
const keysOf = (d: Parameters<typeof domainKeys>[0]) => domainKeys(d).map(k => k[0]);

/** storage reader → the cache domain a write to that data names. */
const READER_DOMAIN: Record<string, string> = {
  getDocuments: "documents", getProfiles: "profiles", getTasks: "tasks", getObligations: "obligations",
  getHabits: "habits", getEvents: "events", listUserNotifications: "notifications", getPreference: "preferences",
};

describe("derived endpoints are invalidated by every domain they are computed from", () => {
  it("the notification feed declares every storage read buildNotifications makes", () => {
    const src = read("server/notification-service.ts");
    const reads = new Set([...src.matchAll(/storage\.(\w+)\(/g)].map(m => m[1]).filter(m => m in READER_DOMAIN));
    const deps = DERIVED_ENDPOINT_DEPENDENCIES["/api/notifications"];
    for (const r of reads) expect(deps, `${r} → ${READER_DOMAIN[r]}`).toContain(READER_DOMAIN[r]);
    // assets/liabilities/people are profiles rows: an asset's dates feed the bell too.
    for (const d of ["assets", "liabilities", "people"] as const) expect(deps).toContain(d);
  });

  it("revaluing an asset, checking in a habit and completing a recurring date all refresh the bell", () => {
    // The gaps that left a satisfied notification on screen.
    expect(keysOf("assets")).toContain("/api/notifications");
    expect(keysOf("habits")).toContain("/api/notifications");
    expect(keysOf("events")).toContain("/api/notifications");
    expect(keysOf("documents")).toContain("/api/notifications");
  });

  it("an asset write refreshes every surface showing its value or its dates", () => {
    const k = keysOf("assets");
    for (const e of ["/api/profiles", "/api/dashboard-enhanced", "/api/stats", "/api/dashboard-bootstrap", "/api/net-worth/history", "/api/insights", "/api/ai-digest", "/api/calendar/timeline", "/api/date-rules"]) {
      expect(k, e).toContain(e);
    }
  });

  it("every data domain refreshes the account-wide aggregates (their server caches depend on 'all')", () => {
    for (const d of ["tasks", "habits", "trackers", "profiles", "assets", "liabilities", "people", "documents", "expenses", "incomes", "obligations", "budgets", "goals", "events", "journal"] as const) {
      expect(keysOf(d), d).toEqual(expect.arrayContaining(["/api/dashboard-enhanced", "/api/stats", "/api/dashboard-bootstrap"]));
    }
  });

  it("invalidating 'assets' actually marks a cached notification feed stale", async () => {
    __resetManifestCoverage();
    queryClient.clear();
    queryClient.setQueryData(["/api/notifications"], [{ id: "n1" }]);
    queryClient.setQueryData(["/api/profiles"], []);
    expect(queryClient.getQueryState(["/api/notifications"])?.isInvalidated).toBe(false);
    await invalidateDomains("assets");
    expect(queryClient.getQueryState(["/api/notifications"])?.isInvalidated).toBe(true);
    // Data is kept while it refetches — invalidation is never deletion.
    expect(queryClient.getQueryData(["/api/notifications"])).toEqual([{ id: "n1" }]);
  });
});
