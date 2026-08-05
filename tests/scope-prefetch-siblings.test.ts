// @vitest-environment jsdom
/**
 * Profile-switch warmup contract (2026-08-05).
 *
 * "When I filter to another person it takes too long to load" — the hover/touch
 * prefetch only covers the case where the pointer rests on the row long enough
 * to absorb a cold bootstrap, which is never true on mobile and rarely true on
 * a decisive click. warmSiblingScopes closes that gap by loading the OTHER
 * people's dashboards in the background once the active one has painted.
 *
 * The behaviour that matters (and is easy to regress into a request storm):
 *   1. every other person is warmed, and the active scope is skipped,
 *   2. requests are strictly sequential — never a parallel fan-out,
 *   3. each response seeds the scoped query keys, so the switch itself is a
 *      pure cache hit with no network,
 *   4. a repeat call inside the TTL is a no-op,
 *   5. cancel() stops the sweep mid-flight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MONTH = new Date().toISOString().slice(0, 7);

interface FetchLog {
  urls: string[];
  maxConcurrent: number;
}

/** Fresh module graph per test — warmSiblingScopes keeps a module-level TTL map. */
async function loadModule(log: FetchLog, payloadFor: (url: string) => any) {
  vi.resetModules();
  let inFlight = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    log.urls.push(String(url));
    inFlight += 1;
    log.maxConcurrent = Math.max(log.maxConcurrent, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const body = payloadFor(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  });
  const prefetch = await import("../client/src/lib/scope-prefetch");
  const { queryClient } = await import("../client/src/lib/queryClient");
  queryClient.clear();
  return { ...prefetch, queryClient };
}

function bootstrapPayload(ids: string[]) {
  return {
    stats: { scope: ids.join(",") },
    enhanced: { scope: ids.join(",") },
    profiles: [{ id: "self-1", type: "self" }],
    tasks: [{ id: `task-${ids.join(",")}` }],
    habits: [{ id: `habit-${ids.join(",")}` }],
    month: MONTH,
    filterIds: ids,
  };
}

/** Drain the idle/timeout chain the sweep schedules between requests. */
async function settle(ms = 400) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

let log: FetchLog;

beforeEach(() => {
  log = { urls: [], maxConcurrent: 0 };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("warmSiblingScopes", () => {
  it("warms every other person and skips the active scope", async () => {
    const { warmSiblingScopes } = await loadModule(log, (url) => {
      const m = /profileIds=([^&]*)/.exec(url);
      return bootstrapPayload(m ? m[1].split(",") : []);
    });

    warmSiblingScopes(["self-1", "mike", "craig"], ["self-1"]);
    await settle();

    expect(log.urls.filter((u) => u.includes("profileIds=mike"))).toHaveLength(1);
    expect(log.urls.filter((u) => u.includes("profileIds=craig"))).toHaveLength(1);
    // The scope already on screen must never be re-fetched by the sweep.
    expect(log.urls.filter((u) => u.includes("profileIds=self-1"))).toHaveLength(0);
  });

  it("runs strictly one request at a time (no serverless fan-out)", async () => {
    const { warmSiblingScopes } = await loadModule(log, (url) => {
      const m = /profileIds=([^&]*)/.exec(url);
      return bootstrapPayload(m ? m[1].split(",") : []);
    });

    warmSiblingScopes(["a", "b", "c", "d"], ["self-1"]);
    await settle();

    expect(log.urls).toHaveLength(4);
    expect(log.maxConcurrent).toBe(1);
  });

  it("seeds the scoped query keys so the switch itself needs no network", async () => {
    const { warmSiblingScopes, queryClient } = await loadModule(log, (url) => {
      const m = /profileIds=([^&]*)/.exec(url);
      return bootstrapPayload(m ? m[1].split(",") : []);
    });

    warmSiblingScopes(["self-1", "mike"], ["self-1"]);
    await settle();

    // The exact keys the dashboard reads for the "mike" scope.
    expect(queryClient.getQueryData(["/api/dashboard-bootstrap", "selected", "mike", MONTH]))
      .toBeTruthy();
    expect(queryClient.getQueryData(["/api/stats", "selected", "mike"]))
      .toEqual({ scope: "mike" });
    expect(queryClient.getQueryData(["/api/tasks", "selected", "mike"]))
      .toEqual([{ id: "task-mike" }]);
  });

  it("is a no-op on a repeat sweep inside the TTL", async () => {
    const { warmSiblingScopes } = await loadModule(log, (url) => {
      const m = /profileIds=([^&]*)/.exec(url);
      return bootstrapPayload(m ? m[1].split(",") : []);
    });

    warmSiblingScopes(["self-1", "mike"], ["self-1"]);
    await settle();
    const afterFirst = log.urls.length;

    warmSiblingScopes(["self-1", "mike"], ["self-1"]);
    await settle();

    expect(log.urls).toHaveLength(afterFirst);
  });

  it("stops queueing further requests once cancelled", async () => {
    const { warmSiblingScopes } = await loadModule(log, (url) => {
      const m = /profileIds=([^&]*)/.exec(url);
      return bootstrapPayload(m ? m[1].split(",") : []);
    });

    const cancel = warmSiblingScopes(["a", "b", "c", "d", "e", "f"], ["self-1"]);
    // Let the sweep get going, then cancel mid-flight (what an unmount or a
    // rescope does) — the in-flight request finishes, nothing further queues.
    while (log.urls.length === 0) await new Promise((r) => setTimeout(r, 5));
    cancel();
    await settle();

    expect(log.urls).toHaveLength(1);
  });

  it("never warms more than the cap, however many profiles exist", async () => {
    const { warmSiblingScopes } = await loadModule(log, (url) => {
      const m = /profileIds=([^&]*)/.exec(url);
      return bootstrapPayload(m ? m[1].split(",") : []);
    });

    const many = Array.from({ length: 20 }, (_, i) => `p${i}`);
    warmSiblingScopes(many, ["self-1"]);
    await settle(900);

    expect(log.urls.length).toBeLessThanOrEqual(6);
  });
});
