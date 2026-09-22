// Rule 17 — cache invalidation is domain-specific and deterministic.
//
// Creating an expense must reach every slot that renders expense-derived
// numbers: the expense list, finance totals (/api/stats), the enhanced
// snapshot + Recent Activity (/api/dashboard-enhanced), cash flow, the budget
// summary, and the PROFILE detail payload (relatedExpenses / the person's
// Finance tab), which the audit found was never invalidated. The search
// palette's private result cache is not a React Query slot at all — it is
// told about every bust through onCacheBust().
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { queryClient } from "../client/src/lib/queryClient";
import { invalidateDomains, invalidateDomainsFromManifest, onCacheBust, __resetManifestCoverage } from "../client/src/lib/cache-bus";

const PID = "0f6c2a2e-6c0b-4c25-8e0e-7f6e6d1d9a11";

function seed(key: unknown[]) {
  queryClient.setQueryData(key, { seeded: true });
}
function invalidated(key: unknown[]): boolean {
  return !!queryClient.getQueryState(key)?.isInvalidated;
}

beforeEach(() => { queryClient.clear(); __resetManifestCoverage(); });
afterEach(() => { queryClient.clear(); __resetManifestCoverage(); });

describe("expenses domain", () => {
  const MUST_REACH: unknown[][] = [
    ["/api/expenses", "everyone"],
    ["/api/stats", "everyone"],
    ["/api/dashboard-enhanced", "everyone"],
    ["/api/cashflow", "everyone"],
    ["/api/budgets/summary", "2026-09", "everyone"],
    ["/api/profiles"],
    ["/api/profiles", PID, "detail"],
  ];

  it("reaches expenses, stats, dashboard-enhanced, cashflow, budgets/summary and profile detail", async () => {
    for (const k of MUST_REACH) seed(k);
    seed(["/api/journal"]); // unrelated — must stay fresh
    await invalidateDomains("expenses");
    for (const k of MUST_REACH) expect(invalidated(k), JSON.stringify(k)).toBe(true);
    expect(invalidated(["/api/journal"])).toBe(false);
  });

  it("incomes reach the profile detail embed too", async () => {
    seed(["/api/profiles", PID, "detail"]);
    seed(["/api/incomes", "everyone"]);
    await invalidateDomains("incomes");
    expect(invalidated(["/api/profiles", PID, "detail"])).toBe(true);
    expect(invalidated(["/api/incomes", "everyone"])).toBe(true);
  });
});

describe("onCacheBust — caches outside React Query", () => {
  it("is told about every bust with the domains it named, and can unsubscribe", async () => {
    const seen: string[][] = [];
    const off = onCacheBust((domains) => seen.push([...domains]));
    await invalidateDomains("expenses");
    expect(seen).toEqual([["expenses"]]);
    off();
    await invalidateDomains("tasks");
    expect(seen).toEqual([["expenses"]]);
  });

  it("fires for a manifest-driven bust as well (the write path most mutations take)", async () => {
    const seen: string[][] = [];
    const off = onCacheBust((domains) => seen.push([...domains]));
    await invalidateDomainsFromManifest(["expenses", "profiles"]);
    expect(seen).toEqual([["expenses", "profiles"]]);
    off();
  });

  it("clears a CommandSearch-shaped cache on any bust", async () => {
    // The palette keeps Map<filterSig, Map<query, {raw, ts}>>; the listener
    // replaces the whole map so the next keystroke goes to the server.
    const cacheRef = { current: new Map<string, Map<string, { raw: any[]; ts: number }>>() };
    cacheRef.current.set("all", new Map([["rent", { raw: [{ id: "e1", title: "Rent" }], ts: Date.now() }]]));
    const off = onCacheBust(() => { cacheRef.current = new Map(); });
    await invalidateDomains("expenses");
    expect(cacheRef.current.size).toBe(0);
    off();
  });

  it("a throwing listener does not stop the others or the invalidation", async () => {
    const off1 = onCacheBust(() => { throw new Error("boom"); });
    let called = 0;
    const off2 = onCacheBust(() => { called++; });
    seed(["/api/expenses", "everyone"]);
    await invalidateDomains("expenses");
    expect(called).toBe(1);
    expect(invalidated(["/api/expenses", "everyone"])).toBe(true);
    off1(); off2();
  });
});
