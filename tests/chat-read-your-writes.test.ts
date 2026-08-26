// The read-your-writes barrier.
//
// WHY THIS EXISTS: the server stamps its per-user response-cache keys with a
// data VERSION, and each serverless instance memoizes that version for ~2s.
// The chat handler used to bump the version on res.finish — AFTER the reply was
// on the wire — so the client's post-reply refetch could compute the PRE-write
// cache key, be served pre-write data, and store it as fresh for a full
// staleTime. That is the "the AI saved it but the page doesn't show it until I
// refresh" bug, and it is a cache-key ordering problem, not AI latency.
//
// Two things fix it, and both are pinned here: the reply waits for the bump,
// and the client carries the resulting version as a token so OTHER instances
// (whose 2s memo is still stale) also compute the post-write key.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveDataVersion, DATA_VERSION_HEADER } from "../server/routes";
import { startHarness, type Harness } from "./helpers/route-harness";
import {
  noteDataVersion,
  getKnownDataVersion,
  clearDataVersion,
  apiRequest,
} from "../client/src/lib/queryClient";

describe("resolveDataVersion — the client's token can only move the key forward", () => {
  it("uses the client's version when this instance's memo is behind", () => {
    // The exact race: instance B memoized v6 two seconds ago; the client was
    // told v7 by the instance that did the write.
    expect(resolveDataVersion(6, "7")).toBe(7);
  });

  it("ignores a token that is behind or equal — a stale response can't rewind the cache key", () => {
    expect(resolveDataVersion(9, "4")).toBe(9);
    expect(resolveDataVersion(9, "9")).toBe(9);
  });

  it("ignores junk instead of poisoning the key", () => {
    expect(resolveDataVersion(5, undefined)).toBe(5);
    expect(resolveDataVersion(5, "")).toBe(5);
    expect(resolveDataVersion(5, "not-a-number")).toBe(5);
    expect(resolveDataVersion(5, NaN)).toBe(5);
  });

  it("clamps a wild value so one client can't explode this user's cache cardinality", () => {
    expect(resolveDataVersion(5, "999999999")).toBe(1005);
  });

  it("takes the first value when the header arrives repeated", () => {
    expect(resolveDataVersion(1, ["8", "3"])).toBe(8);
  });

  it("names the header the client actually sends", () => {
    expect(DATA_VERSION_HEADER).toBe("x-data-version");
  });
});

describe("client data-version token", () => {
  beforeEach(() => clearDataVersion());
  afterEach(() => {
    clearDataVersion();
    vi.restoreAllMocks();
    vi.unstubAllGlobals(); // the harness suite below needs the real fetch back
  });

  it("is monotonic — out-of-order responses can't walk it backwards", () => {
    noteDataVersion(12);
    noteDataVersion(3);
    expect(getKnownDataVersion()).toBe(12);
    noteDataVersion(13);
    expect(getKnownDataVersion()).toBe(13);
  });

  it("ignores non-numeric values", () => {
    noteDataVersion("nope");
    noteDataVersion(undefined);
    noteDataVersion(null);
    expect(getKnownDataVersion()).toBe(0);
  });

  it("is sent on subsequent requests once a write has reported one", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("GET", "/api/tasks");
    const before = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(before["X-Data-Version"]).toBeUndefined();

    // The token is a per-domain map now: the server keys its caches per domain,
    // so claiming "everything is at 21" would tell an instance the trackers had
    // moved when only the liabilities did. A bare number is still accepted —
    // that is what an older server sends mid-deploy — and reads as the epoch.
    noteDataVersion(21);
    await apiRequest("GET", "/api/tasks");
    const after = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(after["X-Data-Version"]).toBe("epoch:21");

    noteDataVersion("epoch:21,liabilities:4");
    await apiRequest("GET", "/api/tasks");
    const merged = (fetchMock.mock.calls[2][1] as RequestInit).headers as Record<string, string>;
    expect(merged["X-Data-Version"]).toBe("epoch:21,liabilities:4");

    // Monotonic per domain: a response that arrives out of order cannot walk
    // one backwards, and cannot drag the others down with it.
    noteDataVersion("epoch:3,liabilities:9");
    await apiRequest("GET", "/api/tasks");
    const kept = (fetchMock.mock.calls[3][1] as RequestInit).headers as Record<string, string>;
    expect(kept["X-Data-Version"]).toBe("epoch:21,liabilities:9");
  });

  it("is NOT sent on document file fetches, which must stay header-clean for cross-origin redirects", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    noteDataVersion(21);
    await apiRequest("GET", "/api/documents/abc/file");
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Data-Version"]).toBeUndefined();
  });
});

describe("the chat reply is a read-your-writes barrier", () => {
  let h: Harness;
  beforeEach(async () => { h = await startHarness(); });
  afterEach(async () => { await h.close(); });

  it("a mutating turn has ALREADY bumped the version when the reply lands", async () => {
    const r = await h.api("POST", "/api/chat", { message: "mood good" });
    expect(r.status).toBe(200);
    // No settle delay: the whole point is that the bump completed BEFORE the
    // response was written. Reading the counter the instant the reply arrives
    // is the assertion — with the old finish-listener bump this was still 0.
    expect(h.db.bumpDataVersionCalls).toBeGreaterThan(0);
  });

  it("hands the client the post-write versions as its token", async () => {
    const r = await h.api("POST", "/api/chat", { message: "mood good" });
    // An encoded domain→version map, not a single counter — see noteDataVersion.
    expect(typeof r.data?.dataVersion).toBe("string");
    expect(r.data.dataVersion).toMatch(/^[a-z]+:\d+(,[a-z]+:\d+)*$/);
  });

  it("bumps only the domains the turn actually wrote", async () => {
    // The whole point of per-domain versions. "mood good" writes a journal
    // entry; it must not change the cache key of the liability list, the
    // document list or the calendar, because doing so cold-starts every one of
    // them — which is what made the app slow after ANY change.
    await h.api("POST", "/api/chat", { message: "mood good" });
    expect(h.db.lastBumpedDomains.length).toBeGreaterThan(0);
    expect(h.db.lastBumpedDomains).not.toContain("liabilities");
    expect(h.db.lastBumpedDomains).not.toContain("documents");
  });

  it("reports what it changed, so the client patches instead of re-asking for everything", async () => {
    const r = await h.api("POST", "/api/chat", { message: "mood good" });
    const mutations = r.data?.mutations;
    expect(Array.isArray(mutations)).toBe(true);
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) {
      expect(["create", "update", "delete"]).toContain(m.op);
      expect(Array.isArray(m.domains) && m.domains.length > 0).toBe(true);
    }
  });

  it("a read-only turn neither bumps nor claims a change", async () => {
    const r = await h.api("POST", "/api/chat", { message: "what is on my calendar" });
    expect(r.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let finish listeners run
    expect(h.db.bumpDataVersionCalls).toBe(0);
    expect(r.data?.dataVersion).toBeUndefined();
  });
});
