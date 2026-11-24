// @vitest-environment jsdom
// The hover warm-up of a profile's page reads its response to the end.
//
// 2026-11-24, found by tests/live-all-pages-check.ts: warmProfileDetail fired
// GET /api/profile-bootstrap/:id and dropped the response unread. A response
// nobody reads never completes, so the browser kept the request open (16 s and
// counting on the Assets tab, against a server that answered in 150 ms).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

async function load(response: () => any) {
  vi.resetModules();
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => { urls.push(String(url)); return response(); });
  const mod = await import("../client/src/lib/scope-prefetch");
  return { warm: mod.warmProfileDetail, urls };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("warmProfileDetail", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads the response body to its end", async () => {
    let bodyRead = 0;
    const { warm, urls } = await load(() => ({
      ok: true, status: 200, headers: new Headers(),
      arrayBuffer: async () => { bodyRead++; return new ArrayBuffer(8); },
      json: async () => ({}), text: async () => "",
    }));
    warm("p-1");
    await flush(); await flush();
    expect(urls.filter((u) => u.endsWith("/api/profile-bootstrap/p-1"))).toHaveLength(1);
    expect(bodyRead).toBe(1);
  });

  it("asks once inside the server's cache window, and again after a failure", async () => {
    let fail = true;
    const { warm, urls } = await load(() => {
      if (fail) throw new Error("offline");
      return { ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}), text: async () => "" };
    });
    const count = () => urls.filter((u) => u.endsWith("/api/profile-bootstrap/p-2")).length;
    warm("p-2");
    await flush(); await flush();
    expect(count()).toBe(1);
    fail = false;
    warm("p-2"); // the failure cleared the mark, so this one goes out
    await flush(); await flush();
    expect(count()).toBe(2);
    warm("p-2"); // … and now it is warm
    await flush();
    expect(count()).toBe(2);
    warm("");
    expect(urls.some((u) => u.endsWith("/api/profile-bootstrap/"))).toBe(false);
  });
});
