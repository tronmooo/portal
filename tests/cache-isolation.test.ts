import { describe, it, expect } from "vitest";
import {
  decodeSessionUserId,
  selectHydratableEntries,
  type PersistedBlob,
} from "../client/src/lib/cache-isolation";

// Build a fake (unsigned) Supabase-style JWT carrying `sub` + `exp`. The
// production code only base64url-decodes the payload to read `sub`; it never
// verifies the signature (the server does that), so an unsigned token is a
// faithful fixture for these client-side isolation checks.
function fakeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.`;
}

function session(uid: string, opts: { expired?: boolean } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    access_token: fakeJwt(uid),
    refresh_token: "r",
    expires_at: opts.expired ? now - 60 : now + 3600,
  });
}

function blobFor(uid: string, keys: string[] = ["/api/profiles"]): string {
  const blob: PersistedBlob = {
    uid,
    entries: keys.map((k) => ({ k: [k], d: [{ secret: `${uid}-data` }], t: Date.now() })),
  };
  return JSON.stringify(blob);
}

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DAY = 24 * 60 * 60_000;

describe("decodeSessionUserId", () => {
  it("returns the JWT subject for a live session", () => {
    expect(decodeSessionUserId(session(USER_A))).toBe(USER_A);
  });
  it("returns null for an expired session", () => {
    expect(decodeSessionUserId(session(USER_A, { expired: true }))).toBeNull();
  });
  it("returns null for missing / malformed session", () => {
    expect(decodeSessionUserId(null)).toBeNull();
    expect(decodeSessionUserId("not json")).toBeNull();
    expect(decodeSessionUserId(JSON.stringify({}))).toBeNull();
  });
});

describe("selectHydratableEntries — cross-account isolation", () => {
  it("restores user A's cache for user A's own session", () => {
    const { entries, purge } = selectHydratableEntries(blobFor(USER_A), USER_A, { maxAgeMs: DAY });
    expect(purge).toBe(false);
    expect(entries).toHaveLength(1);
    expect((entries[0].d as any)[0].secret).toBe(`${USER_A}-data`);
  });

  it("REFUSES to restore user A's cache into user B's session (the leak) and purges it", () => {
    const { entries, purge } = selectHydratableEntries(blobFor(USER_A), USER_B, { maxAgeMs: DAY });
    expect(entries).toHaveLength(0); // <- user B never sees user A's data
    expect(purge).toBe(true);        // <- and the stale blob is removed
  });

  it("REFUSES to restore any cache when there is no live session (logged out)", () => {
    const { entries, purge } = selectHydratableEntries(blobFor(USER_A), null, { maxAgeMs: DAY });
    expect(entries).toHaveLength(0);
    expect(purge).toBe(true);
  });

  it("purges a legacy un-stamped (array) blob instead of trusting it", () => {
    const legacy = JSON.stringify([{ k: ["/api/profiles"], d: [{ secret: "legacy" }], t: Date.now() }]);
    const { entries, purge } = selectHydratableEntries(legacy, USER_A, { maxAgeMs: DAY });
    expect(entries).toHaveLength(0);
    expect(purge).toBe(true);
  });

  it("purges a corrupt blob", () => {
    const { entries, purge } = selectHydratableEntries("{ broken", USER_A, { maxAgeMs: DAY });
    expect(entries).toHaveLength(0);
    expect(purge).toBe(true);
  });

  it("drops entries older than maxAge but keeps fresh ones for the right user", () => {
    const stale: PersistedBlob = {
      uid: USER_A,
      entries: [
        { k: ["/api/old"], d: [1], t: Date.now() - 2 * DAY }, // too old
        { k: ["/api/new"], d: [2], t: Date.now() },            // fresh
      ],
    };
    const { entries, purge } = selectHydratableEntries(JSON.stringify(stale), USER_A, { maxAgeMs: DAY });
    expect(purge).toBe(false);
    expect(entries).toHaveLength(1);
    expect((entries[0].k as string[])[0]).toBe("/api/new");
  });

  it("does nothing (no purge) when there is no persisted blob at all", () => {
    const { entries, purge } = selectHydratableEntries(null, USER_A, { maxAgeMs: DAY });
    expect(entries).toHaveLength(0);
    expect(purge).toBe(false);
  });

  it("end-to-end: A logs in → out → B logs in on same device, B gets nothing of A's", () => {
    // Simulate the persisted blob A left behind in localStorage.
    let persisted: string | null = blobFor(USER_A, ["/api/profiles", "/api/stats", "/api/expenses"]);

    // B's tab boots with B's session. hydrate validates ownership:
    const bSessionUid = decodeSessionUserId(session(USER_B));
    const res = selectHydratableEntries(persisted, bSessionUid, { maxAgeMs: DAY });
    if (res.purge) persisted = null; // hydrate removes the blob

    expect(res.entries).toHaveLength(0);
    expect(persisted).toBeNull(); // A's data is gone, cannot resurface
  });
});
