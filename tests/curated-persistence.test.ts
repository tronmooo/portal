import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Fix (2026-07-17): localStorage persistence is CURATED to first-paint keys and
// a single heavy payload can no longer disable persistence of the others.

const USER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STORAGE_KEY = "portol-query-cache-v1";

function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.`;
}
function session(uid: string): string {
  return JSON.stringify({
    access_token: fakeJwt(uid),
    refresh_token: "r",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
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

let queryClient: any;
let snapshotCache: any;
let isEssentialToPersist: any;

beforeEach(async () => {
  vi.resetModules();
  (globalThis as any).localStorage = makeStorage();
  (globalThis as any).sessionStorage = makeStorage();
  localStorage.setItem("portol_session", session(USER));
  const mod = await import("../client/src/lib/queryClient");
  queryClient = mod.queryClient;
  snapshotCache = mod.snapshotCache;
  isEssentialToPersist = mod.isEssentialToPersist;
  queryClient.clear();
});

afterEach(() => {
  delete (globalThis as any).localStorage;
  delete (globalThis as any).sessionStorage;
});

describe("isEssentialToPersist — only first-paint keys", () => {
  it("keeps bootstrap/stats/enhanced/profiles, drops everything else", () => {
    expect(isEssentialToPersist(["/api/dashboard-bootstrap", "everyone", "2026-07"])).toBe(true);
    expect(isEssentialToPersist(["/api/stats", "everyone"])).toBe(true);
    expect(isEssentialToPersist(["/api/dashboard-enhanced", "everyone"])).toBe(true);
    expect(isEssentialToPersist(["/api/profiles"])).toBe(true);
    expect(isEssentialToPersist(["/api/expenses"])).toBe(false);
    expect(isEssentialToPersist(["/api/trackers", "everyone"])).toBe(false);
    expect(isEssentialToPersist(["/api/documents"])).toBe(false);
  });
});

describe("snapshotCache — curation + heavy-payload isolation", () => {
  it("persists only the curated keys", () => {
    queryClient.setQueryData(["/api/stats", "everyone"], { net: 1 });
    queryClient.setQueryData(["/api/profiles"], [{ id: "p1" }]);
    queryClient.setQueryData(["/api/expenses"], [{ id: "e1" }]); // non-essential

    snapshotCache();

    const blob = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    const keys = blob.entries.map((e: any) => e.k[0]).sort();
    expect(keys).toEqual(["/api/profiles", "/api/stats"]);
    expect(blob.uid).toBe(USER);
  });

  it("a single oversize essential payload does not disable persistence of the others", () => {
    // dashboard-enhanced is huge (> per-entry cap), stats is small.
    const huge = "x".repeat(900_000);
    queryClient.setQueryData(["/api/dashboard-enhanced", "everyone"], { blob: huge });
    queryClient.setQueryData(["/api/stats", "everyone"], { net: 42 });

    snapshotCache();

    const blob = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    const keys = blob.entries.map((e: any) => e.k[0]);
    expect(keys).toContain("/api/stats");         // small one survives
    expect(keys).not.toContain("/api/dashboard-enhanced"); // heavy one dropped alone
  });

  it("leaves an existing snapshot intact when nothing curated is loaded yet", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ uid: USER, entries: [{ k: ["/api/stats"], d: { old: 1 }, t: Date.now() }] }));
    // Only non-essential data in cache.
    queryClient.setQueryData(["/api/expenses"], [{ id: "e1" }]);

    snapshotCache();

    const blob = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(blob.entries[0].d.old).toBe(1); // untouched
  });
});
