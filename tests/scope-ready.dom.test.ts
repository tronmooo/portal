// @vitest-environment jsdom
// The first screen after sign-in settles WHOSE data it shows before it asks
// for any (client/src/lib/scope-ready.ts).
//
// 2026-11-24, measured on production: with no scope saved for the user (a
// first sign-in, and every sign-in after a sign-out) the dashboard loaded
// everything for "Everyone", painted it, then learned who "me" is and loaded
// everything again — 30 requests and ~6 s, with household totals on screen in
// between. A saved scope took 18 requests and 0.7 s.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const UID = "11111111-1111-4111-8111-111111111111";
const SLOT = `portol_profile_filter_v5:${UID}`;
const PROFILES = [
  { id: "p-kid", type: "person", name: "Kid", createdAt: "2024-01-01T00:00:00Z" },
  { id: "p-me", type: "self", name: "Sam", createdAt: "2023-01-01T00:00:00Z" },
  { id: "p-car", type: "vehicle", name: "Car", createdAt: "2024-02-01T00:00:00Z" },
];

async function load(respond: (url: string) => Promise<any> | any) {
  vi.resetModules();
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(String(url));
    const body = await respond(String(url));
    return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) };
  });
  const filter = await import("../client/src/lib/profileFilter");
  const ready = await import("../client/src/lib/scope-ready");
  return { filter, ready, urls, listCalls: () => urls.filter((u) => u.endsWith("/api/profiles/lite")).length };
}

describe("the scope is settled before the first screen loads its data", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("the slot key this test reads is the one the store writes", async () => {
    const { filter } = await load(() => PROFILES);
    filter.setActiveUserForFilter(UID);
    filter.setFilterSelected(["p-kid"], ["Kid"]);
    expect(JSON.parse(localStorage.getItem(SLOT) || "null")?.selectedIds).toEqual(["p-kid"]);
  });

  it("nothing saved: one profile list, then the scope is the user's own profile", async () => {
    const { filter, ready, listCalls } = await load(() => PROFILES);
    expect(filter.needsDefaultScope(UID)).toBe(true);
    await ready.resolveDefaultScope(UID);
    expect(listCalls()).toBe(1);
    expect(filter.getProfileFilter()).toMatchObject({ mode: "selected", selectedIds: ["p-me"], selectedNames: ["Sam"] });
    expect(JSON.parse(localStorage.getItem(SLOT) || "null")?.selectedIds).toEqual(["p-me"]);
    expect(filter.needsDefaultScope(UID)).toBe(false);
    // Settled: asking again fetches nothing.
    await ready.resolveDefaultScope(UID);
    expect(listCalls()).toBe(1);
  });

  it("two callers at once share one request (the screen and the prefetch)", async () => {
    const { ready, listCalls } = await load(async () => { await new Promise((r) => setTimeout(r, 10)); return PROFILES; });
    await Promise.all([ready.resolveDefaultScope(UID), ready.resolveDefaultScope(UID)]);
    expect(listCalls()).toBe(1);
  });

  it("a saved scope is kept and nothing is fetched — a returning user does not wait", async () => {
    localStorage.setItem(SLOT, JSON.stringify({ mode: "selected", selectedIds: ["p-kid"], selectedNames: ["Kid"] }));
    const { filter, ready, urls } = await load(() => PROFILES);
    expect(filter.needsDefaultScope(UID)).toBe(false);
    await ready.resolveDefaultScope(UID);
    expect(urls).toEqual([]);
  });

  it("a saved \"Everyone\" is a choice, not an absence: it is kept", async () => {
    localStorage.setItem(SLOT, JSON.stringify({ mode: "everyone", selectedIds: [], selectedNames: [] }));
    const { filter, ready, urls } = await load(() => PROFILES);
    await ready.resolveDefaultScope(UID);
    filter.setActiveUserForFilter(UID);
    expect(urls).toEqual([]);
    expect(filter.getProfileFilter().mode).toBe("everyone");
  });

  it("an account with no profile of its own stays on Everyone, and still resolves", async () => {
    const { filter, ready } = await load(() => PROFILES.filter((p) => p.type !== "self"));
    await ready.resolveDefaultScope(UID);
    expect(filter.getProfileFilter().mode).toBe("everyone");
  });

  it("a failed profile list does not block the screen or invent a scope", async () => {
    const { filter, ready } = await load(() => { throw new Error("offline"); });
    await expect(ready.resolveDefaultScope(UID)).resolves.toBeUndefined();
    expect(filter.getProfileFilter().mode).toBe("everyone");
    expect(localStorage.getItem(SLOT)).toBeNull();
  });

  it("a list that never answers stops holding the screen after the timeout", async () => {
    const { ready } = await load(() => new Promise(() => { /* never */ }));
    let done = false;
    void ready.resolveDefaultScope(UID, 30).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(done).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(true);
  });

  it("a choice the user makes while the list is loading wins", async () => {
    let release: (v: any) => void = () => undefined;
    const { filter, ready } = await load(() => new Promise((r) => { release = r; }));
    const pending = ready.resolveDefaultScope(UID);
    await new Promise((r) => setTimeout(r, 0));
    filter.setFilterSelected(["p-kid"], ["Kid"]);
    release(PROFILES);
    await pending;
    expect(filter.getProfileFilter().selectedIds).toEqual(["p-kid"]);
  });

  it("another user's saved scope on the device is not this user's", async () => {
    localStorage.setItem("portol_profile_filter_v5:someone-else", JSON.stringify({ mode: "selected", selectedIds: ["x"], selectedNames: ["X"] }));
    const { filter, ready } = await load(() => PROFILES);
    expect(filter.needsDefaultScope(UID)).toBe(true);
    await ready.resolveDefaultScope(UID);
    expect(filter.getProfileFilter().selectedIds).toEqual(["p-me"]);
  });
});
