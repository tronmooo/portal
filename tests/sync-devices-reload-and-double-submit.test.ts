import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Two systemic client defects found by the integrity run (isolated stack,
// 2026-11-28), each fixed once at its root.
//
// 1. A RELOAD HID ANOTHER DEVICE'S WRITE. Device A added a task; device B
//    (signed in, its cache snapshot saved) reloaded: its dashboard did not show
//    the task, and still did not after going to Tasks and back. The snapshot is
//    restored as a first paint, much of it as fresh, and the version watch
//    (I9) took its baseline from the FIRST map after the reload — which already
//    included A's write, so nothing ever looked new. The map a page load had
//    seen is now saved with the snapshot and restored with it.
//
// 2. A DOUBLE PRESS MADE TWO RECORDS. Two clicks land before React re-renders a
//    button as disabled, so the form's `isPending` guard read false twice (two
//    identical goals; two assets from the Net worth sheet). `apiRequest` now
//    sends an identical write that is still in flight only once; once it is
//    answered, an identical write is a new submission (I14).

const USER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STORAGE_KEY = "portol-query-cache-v1";
const MONTH = "2026-11";
const BOOTSTRAP_KEY = ["/api/dashboard-bootstrap", "everyone", MONTH];
const TASKS_KEY = ["/api/tasks", "everyone"];

function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.`;
}
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

const T1 = { id: "t1", title: "Existing task", completed: false };
const T2 = { id: "t2", title: "Added on the phone", completed: false };
const BOOTSTRAP = { stats: { tasksDue: 1 }, profiles: [], tasks: [T1] };

let mod: typeof import("../client/src/lib/queryClient");

beforeEach(async () => {
  vi.resetModules();
  (globalThis as any).localStorage = makeStorage();
  (globalThis as any).sessionStorage = makeStorage();
  localStorage.setItem("portol_session", JSON.stringify({
    access_token: fakeJwt(USER), refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  mod = await import("../client/src/lib/queryClient");
});
afterEach(() => {
  mod?.queryClient.clear();
  vi.unstubAllGlobals();
  delete (globalThis as any).localStorage;
  delete (globalThis as any).sessionStorage;
});

/** Device B before the reload: launched a minute ago and saw the server at `map`. */
async function deviceB(map: string | null) {
  const { bootstrapSeedEntries } = await import("../client/src/lib/bootstrap-seed-keys");
  const launchedAt = Date.now() - 60_000; // inside the 3-minute staleTime
  if (map) mod.noteServerVersions(map);
  mod.queryClient.setQueryData(BOOTSTRAP_KEY, BOOTSTRAP, { updatedAt: launchedAt });
  for (const { key, data } of bootstrapSeedEntries(BOOTSTRAP, "everyone", [], MONTH)) {
    mod.queryClient.setQueryData(key as any, data, { updatedAt: launchedAt });
  }
  expect(mod.queryClient.getQueryData(TASKS_KEY)).toEqual([T1]);
}

/** pagehide's snapshot, then a reload: new modules, the same localStorage. */
async function reload() {
  mod.snapshotCache();
  const blob = localStorage.getItem(STORAGE_KEY)!;
  expect(blob).toBeTruthy();
  mod.queryClient.clear();
  vi.resetModules();
  mod = await import("../client/src/lib/queryClient");
  localStorage.setItem(STORAGE_KEY, blob);
  mod.hydrateQueryCache();
  return blob;
}

const invalidated = (key: unknown[]) => mod.queryClient.getQueryState(key as any)?.isInvalidated === true;

describe("a reload shows what another device wrote while this one was closed", () => {
  it("the snapshot carries the version map it was read under", async () => {
    await deviceB("epoch:10,tasks:4,expenses:3");
    const blob = await reload();
    expect(JSON.parse(blob).v).toEqual({ epoch: 10, tasks: 4, expenses: 3 });
    expect(mod.persistedVersionsOf(blob)).toEqual({ epoch: 10, tasks: 4, expenses: 3 });
  });

  it("the first map after the reload names the domain that moved: the restored task list and bootstrap are read again", async () => {
    await deviceB("epoch:10,tasks:4,expenses:3");
    await reload();
    // restored as a first paint, trusted (one refresh on launch, not twenty)
    expect(invalidated(TASKS_KEY)).toBe(false);
    expect(invalidated(BOOTSTRAP_KEY)).toBe(false);
    // the other device added a task: the first answer after the reload says so
    mod.noteServerVersions("epoch:11,tasks:5,expenses:3");
    await vi.waitFor(() => expect(invalidated(TASKS_KEY)).toBe(true));
    expect(invalidated(BOOTSTRAP_KEY)).toBe(true);

    // and the page's list, mounted with the app's defaults, refetches it
    const { QueryObserver } = await import("@tanstack/react-query");
    const queryFn = vi.fn(async () => [T2, T1]);
    const observer = new QueryObserver(mod.queryClient, { queryKey: TASKS_KEY, queryFn } as any);
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual([T2, T1]));
    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("nothing written elsewhere: the restored lists stay trusted (I9)", async () => {
    await deviceB("epoch:10,tasks:4,expenses:3");
    await reload();
    mod.noteServerVersions("epoch:10,tasks:4,expenses:3");
    await new Promise((r) => setTimeout(r, 20));
    expect(invalidated(TASKS_KEY)).toBe(false);
    expect(invalidated(BOOTSTRAP_KEY)).toBe(false);
  });

  it("a snapshot saved before the map existed cannot tell what it missed: the first map re-reads everything once", async () => {
    await deviceB(null);
    const blob = await reload();
    expect(JSON.parse(blob).v).toBeUndefined();
    mod.noteServerVersions("epoch:11,tasks:5");
    await vi.waitFor(() => expect(invalidated(TASKS_KEY)).toBe(true));
    expect(invalidated(BOOTSTRAP_KEY)).toBe(true);
  });

  it("a fresh sign-in with nothing restored still takes the first map as its baseline", async () => {
    mod.noteServerVersions("epoch:11,tasks:5");
    mod.queryClient.setQueryData(TASKS_KEY, [T2, T1]);
    await new Promise((r) => setTimeout(r, 20));
    expect(invalidated(TASKS_KEY)).toBe(false);
  });
});

describe("a double press on a create is one submission", () => {
  function deferredFetch() {
    const calls: Array<{ url: string; init: any; resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
    const fetchMock = vi.fn((url: string, init: any) => new Promise<Response>((resolve, reject) => {
      calls.push({ url, init, resolve, reject });
    }));
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, calls };
  }
  const created = (id: string) => new Response(JSON.stringify({ id, title: "Read 12 books" }), {
    status: 201, headers: { "Content-Type": "application/json" },
  });
  const GOAL = { title: "Read 12 books", target: 12, unit: "books" };

  it("two identical writes in the same tick send one request, and both callers read the answer", async () => {
    const { fetchMock, calls } = deferredFetch();
    const a = mod.apiRequest("POST", "/api/goals", GOAL);
    const b = mod.apiRequest("POST", "/api/goals", { ...GOAL });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    calls[0].resolve(created("g1"));
    const [ra, rb] = await Promise.all([a, b]);
    expect(await ra.json()).toEqual({ id: "g1", title: "Read 12 books" });
    expect(await rb.json()).toEqual({ id: "g1", title: "Read 12 books" });
  });

  it("once the first is answered, the same write again is a new submission (I14)", async () => {
    const { fetchMock, calls } = deferredFetch();
    const first = mod.apiRequest("POST", "/api/goals", GOAL);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    calls[0].resolve(created("g1"));
    await (await first).json();
    const again = mod.apiRequest("POST", "/api/goals", GOAL);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    calls[1].resolve(created("g2"));
    expect(await (await again).json()).toEqual({ id: "g2", title: "Read 12 books" });
  });

  it("a different body, method or URL is a different submission", async () => {
    const { fetchMock, calls } = deferredFetch();
    const ps = [
      mod.apiRequest("POST", "/api/goals", GOAL),
      mod.apiRequest("POST", "/api/goals", { ...GOAL, target: 13 }),
      mod.apiRequest("POST", "/api/profiles", GOAL),
    ];
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    calls.forEach((c, i) => c.resolve(created(`x${i}`)));
    await Promise.all(ps);
  });

  it("a failure is the answer to both callers, and nothing is half-sent", async () => {
    const { fetchMock, calls } = deferredFetch();
    const a = mod.apiRequest("POST", "/api/profiles", { name: "TV", type: "asset" });
    const b = mod.apiRequest("POST", "/api/profiles", { name: "TV", type: "asset" });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    calls[0].resolve(new Response(JSON.stringify({ error: "Server down" }), { status: 500 }));
    await expect(a).rejects.toThrow(/500: Server down/);
    await expect(b).rejects.toThrow(/500: Server down/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a transaction keeps its per-submission key on the one request sent", async () => {
    const { fetchMock, calls } = deferredFetch();
    const body = { description: "Coffee", amount: 4.5, date: "2026-11-28" };
    const a = mod.apiRequest("POST", "/api/expenses", body);
    const b = mod.apiRequest("POST", "/api/expenses", body);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].init.headers["Idempotency-Key"]).toMatch(/^sub-/);
    calls[0].resolve(created("e1"));
    await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // answered: the next identical expense is a new purchase with a new key (I14)
    const c = mod.apiRequest("POST", "/api/expenses", body);
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].init.headers["Idempotency-Key"]).not.toBe(calls[0].init.headers["Idempotency-Key"]);
    calls[1].resolve(created("e2"));
    await c;
  });
});
