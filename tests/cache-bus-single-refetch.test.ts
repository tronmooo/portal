/**
 * One write, one refetch per active query.
 *
 * Two things used to multiply refetches on every write:
 *  1. invalidateDomains issued one invalidateQueries per top-level key AND one
 *     per nested predicate; a query both matched (["/api/tasks"] and
 *     "/api/tasks*") had its refetch cancelled and restarted — two requests.
 *  2. The response's write manifest invalidated the touched domains, and the
 *     mutation's own onSettled invalidated the same domains ~10ms later —
 *     another cancel-and-restart.
 * Net: a task create fired 4 GETs of the task list (probe p12, 2026-09-02).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { queryClient } from "../client/src/lib/queryClient";
import { invalidateDomains, invalidateDomainsFromManifest, __resetManifestCoverage } from "../client/src/lib/cache-bus";

const P1 = "0f6c2a2e-6c0b-4c25-8e0e-7f6e6d1d9a11";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function observe(key: unknown[], counter: { n: number }) {
  const observer = new QueryObserver(queryClient, {
    queryKey: key,
    queryFn: async () => { counter.n++; await sleep(5); return [{ id: `row-${counter.n}` }]; },
    staleTime: 60_000,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { observer, unsubscribe };
}
async function settled(key: unknown[]) {
  for (let i = 0; i < 100; i++) {
    const q = queryClient.getQueryCache().find({ queryKey: key, exact: true });
    if (q && q.state.fetchStatus === "idle") return;
    await sleep(5);
  }
}

beforeEach(() => { queryClient.clear(); __resetManifestCoverage(); });
afterEach(() => { queryClient.clear(); __resetManifestCoverage(); });

describe("cache bus: one refetch per active query per invalidation", () => {
  it("a domain that names a key prefix AND a predicate for it refetches once", async () => {
    const key = ["/api/tasks", "selected", P1]; const c = { n: 0 };
    const { unsubscribe } = observe(key, c);
    await settled(key); expect(c.n).toBe(1);
    await invalidateDomains("tasks"); await settled(key);
    expect(c.n).toBe(2);
    unsubscribe();
  });

  it("the mutation's follow-up invalidation right after the manifest's is a no-op", async () => {
    const key = ["/api/tasks", "selected", P1]; const c = { n: 0 };
    const { unsubscribe } = observe(key, c);
    await settled(key); expect(c.n).toBe(1);
    const manifest = invalidateDomainsFromManifest(["tasks"]);
    await invalidateDomains("tasks");           // what onSettled does ~10ms later
    await manifest; await settled(key);
    expect(c.n).toBe(2);
    unsubscribe();
  });

  it("…but a later invalidation of the same domain still refetches", async () => {
    const key = ["/api/tasks", "selected", P1]; const c = { n: 0 };
    const { unsubscribe } = observe(key, c);
    await settled(key);
    await invalidateDomainsFromManifest(["tasks"]); await settled(key);
    await sleep(200);
    await invalidateDomains("tasks"); await settled(key);
    expect(c.n).toBe(3);
    unsubscribe();
  });

  it("a manifest never coalesces with a previous manifest (a second write always refetches)", async () => {
    const key = ["/api/tasks", "selected", P1]; const c = { n: 0 };
    const { unsubscribe } = observe(key, c);
    await settled(key);
    await invalidateDomainsFromManifest(["tasks"]); await settled(key);
    await invalidateDomainsFromManifest(["tasks"]); await settled(key);
    expect(c.n).toBe(3);
    unsubscribe();
  });

  it("queries nobody is rendering are marked stale, not refetched", async () => {
    const idle = ["/api/tasks", "selected", "6047d1d3-db76-42dd-819d-366c772bafcf"];
    queryClient.setQueryData(idle, [{ id: "seeded" }], { updatedAt: Date.now() });
    const key = ["/api/tasks", "selected", P1]; const c = { n: 0 };
    const { unsubscribe } = observe(key, c);
    await settled(key);
    await invalidateDomains("tasks"); await settled(key);
    const q = queryClient.getQueryCache().find({ queryKey: idle, exact: true })!;
    expect(q.state.fetchStatus).toBe("idle");
    expect(q.state.data).toEqual([{ id: "seeded" }]);
    expect(q.isStale()).toBe(true);
    unsubscribe();
  });

  it("the ripple still reaches the aggregate keys the domain names", async () => {
    const stats = ["/api/stats", "selected", P1]; const c = { n: 0 };
    const { unsubscribe } = observe(stats, c);
    await settled(stats); expect(c.n).toBe(1);
    await invalidateDomains("tasks"); await settled(stats);
    expect(c.n).toBe(2);
    unsubscribe();
  });
});
