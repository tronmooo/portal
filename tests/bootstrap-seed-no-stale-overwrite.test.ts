// A dashboard bootstrap that began before a write must not put pre-write rows
// back over the lists the write already updated (Rule 6).
//
// Integrity run, 2026-11-27 (production, about one run in three): a task was
// ticked done on Tasks — stored as done — and the dashboard opened right after
// kept it under "Remaining", Timeline and Next Important until the page was
// left. The bootstrap request had started before the tick was acknowledged;
// it landed afterwards and `seedDashboardCaches` copied its "todo" row into
// every list, stamping each fresh for three minutes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const MONTH = "2026-11";
const TASKS_KEY = ["/api/tasks", "everyone"];
const EVENTS_KEY = ["/api/events", "everyone"];
const BOOT_KEY = ["/api/dashboard-bootstrap", "everyone", MONTH];
const open = { id: "t1", title: "water plants", status: "todo" };
const done = { ...open, status: "done" };
const PRE_WRITE = { stats: { activeTasks: 1 }, profiles: [], tasks: [open], events: [{ id: "ev1" }] };

function makeStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: (i: number) => Array.from(m.keys())[i] ?? null, get length() { return m.size; } } as Storage;
}

let qc: typeof import("../client/src/lib/queryClient");
let seed: typeof import("../client/src/lib/bootstrap-seed");
let clock: typeof import("../client/src/lib/write-clock");

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
  vi.stubGlobal("localStorage", makeStorage());
  vi.stubGlobal("sessionStorage", makeStorage());
  qc = await import("../client/src/lib/queryClient");
  seed = await import("../client/src/lib/bootstrap-seed");
  clock = await import("../client/src/lib/write-clock");
  clock.resetWriteClock();
  qc.queryClient.clear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const tick = (ms: number) => vi.advanceTimersByTime(ms);

describe("seeding the dashboard bootstrap", () => {
  it("a cold cache is filled from the payload (the single-round-trip paint still works)", () => {
    const startedAt = Date.now();
    tick(400);
    seed.seedDashboardCaches(PRE_WRITE, "everyone", [], MONTH, startedAt);
    expect(qc.queryClient.getQueryData(TASKS_KEY)).toEqual([open]);
    expect(qc.queryClient.getQueryData(EVENTS_KEY)).toEqual([{ id: "ev1" }]);
    expect(qc.queryClient.getQueryState(TASKS_KEY)?.isInvalidated).toBe(false);
  });

  it("a later bootstrap refreshes lists that are older than it", () => {
    qc.queryClient.setQueryData(TASKS_KEY, [open]);
    tick(5000);
    const startedAt = Date.now();
    tick(300);
    seed.seedDashboardCaches({ ...PRE_WRITE, tasks: [done] }, "everyone", [], MONTH, startedAt);
    expect(qc.queryClient.getQueryData(TASKS_KEY)).toEqual([done]);
  });

  it("THE BUG: a bootstrap that began before the tick was acknowledged does not put the task back to open", () => {
    qc.queryClient.setQueryData(TASKS_KEY, [open]);
    tick(5000);
    const startedAt = Date.now();          // dashboard bootstrap goes out…
    tick(50);
    clock.writeStarted();                   // …the tick's PATCH is in the air…
    qc.queryClient.setQueryData(TASKS_KEY, [done]);   // optimistic
    tick(300);
    clock.writeSettled();                   // …and is acknowledged (the manifest patched the row in)
    qc.queryClient.setQueryData(TASKS_KEY, [done]);
    tick(400);
    seed.seedDashboardCaches(PRE_WRITE, "everyone", [], MONTH, startedAt);   // the old payload lands last
    expect(qc.queryClient.getQueryData(TASKS_KEY)).toEqual([done]);
  });

  it("a list refetched after the bootstrap started is newer than the payload and is kept, with no write involved", () => {
    const startedAt = Date.now();
    tick(100);
    qc.queryClient.setQueryData(TASKS_KEY, [done]);   // the list's own fetch came back first
    tick(600);
    seed.seedDashboardCaches(PRE_WRITE, "everyone", [], MONTH, startedAt);
    expect(qc.queryClient.getQueryData(TASKS_KEY)).toEqual([done]);
    // a list nobody had fetched is still seeded
    expect(qc.queryClient.getQueryData(EVENTS_KEY)).toEqual([{ id: "ev1" }]);
  });

  it("a write acknowledged after the request began makes the whole payload suspect: existing lists are kept, what it had to seed is marked stale and the bootstrap is read again", async () => {
    qc.queryClient.setQueryData(TASKS_KEY, [done]);
    qc.queryClient.setQueryData(BOOT_KEY, PRE_WRITE);
    tick(5000);                              // every list is OLDER than the request
    const startedAt = Date.now();
    tick(50);
    clock.writeStarted(); tick(200); clock.writeSettled();   // some other write, acknowledged meanwhile
    tick(300);
    seed.seedDashboardCaches(PRE_WRITE, "everyone", [], MONTH, startedAt);
    expect(qc.queryClient.getQueryData(TASKS_KEY)).toEqual([done]);          // not overwritten, though older
    expect(qc.queryClient.getQueryData(EVENTS_KEY)).toEqual([{ id: "ev1" }]); // first paint from the payload…
    await vi.advanceTimersByTimeAsync(10);
    expect(qc.queryClient.getQueryState(EVENTS_KEY)?.isInvalidated).toBe(true);  // …but not trusted
    expect(qc.queryClient.getQueryState(BOOT_KEY)?.isInvalidated).toBe(true);
  });

  it("while a write is still in the air nothing is re-requested (no refetch loop); the write's own invalidation follows", async () => {
    qc.queryClient.setQueryData(TASKS_KEY, [done]);
    qc.queryClient.setQueryData(BOOT_KEY, PRE_WRITE);
    tick(5000);
    const startedAt = Date.now();
    clock.writeStarted();                    // e.g. a long chat turn
    tick(800);
    seed.seedDashboardCaches(PRE_WRITE, "everyone", [], MONTH, startedAt);
    await vi.advanceTimersByTimeAsync(10);
    expect(qc.queryClient.getQueryData(TASKS_KEY)).toEqual([done]);
    expect(qc.queryClient.getQueryState(BOOT_KEY)?.isInvalidated).toBe(false);
    expect(qc.queryClient.getQueryState(EVENTS_KEY)?.isInvalidated).toBe(true);
    clock.writeSettled();
  });

  it("a read that begins after the write was acknowledged is trusted again", () => {
    clock.writeStarted(); tick(200); clock.writeSettled();
    tick(1);
    const startedAt = Date.now();
    expect(clock.readMayPredateWrite(startedAt)).toBe(false);
    qc.queryClient.setQueryData(TASKS_KEY, [open]);
    tick(-0);
    tick(1000);
    const later = Date.now();
    tick(200);
    seed.seedDashboardCaches({ ...PRE_WRITE, tasks: [done] }, "everyone", [], MONTH, later);
    expect(qc.queryClient.getQueryData(TASKS_KEY)).toEqual([done]);
  });
});

describe("every seeding call site passes when its request started, and apiRequest keeps the clock", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const read = (rel: string) => fs.readFileSync(`${process.cwd()}/${rel}`, "utf8");
  it.each(["client/src/App.tsx", "client/src/pages/dashboard.tsx", "client/src/lib/scope-prefetch.ts", "client/src/components/MultiProfileFilter.tsx"])("%s", (file) => {
    const src = read(file);
    const calls = src.match(/seedDashboardCaches\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c, "pass startedAt, taken before the request").toMatch(/, startedAt\)$/);
    const at = src.indexOf("const startedAt = Date.now();");
    expect(at).toBeGreaterThan(0);
    expect(src.indexOf("/api/dashboard-bootstrap", at), "startedAt is taken before the request goes out").toBeGreaterThan(at);
  });
  it("apiRequest marks every write's start and end", () => {
    const src = read("client/src/lib/queryClient.ts");
    expect(src).toMatch(/if \(isWrite\) writeStarted\(\);/);
    expect(src).toMatch(/finally \{\s*clearTimeout\(timeout\);\s*if \(isWrite\) writeSettled\(\);/);
  });
});
