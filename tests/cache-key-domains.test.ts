// Per-domain cache versions.
//
// The old scheme stamped every cached response key with ONE per-user counter
// bumped on every write. That made writes correct by making them total:
// recording a payment changed the cache key of the dashboard, the expense list,
// the tracker list, the calendar and the document list at once, on every
// instance and in the shared Postgres cache. Nothing was stale — everything was
// gone, so the next read of anything recomputed from scratch. These tests pin
// the narrowing, and pin the escape hatches that keep it safe.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  CACHE_PREFIX_DOMAINS, dependenciesForPrefix, versionStamp, EPOCH_KEY,
  encodeVersionMap, decodeVersionMap, mergeVersionMaps, MAX_VERSION_LOOKAHEAD,
} from "@shared/cache-domains";

/** The per-user cache prefixes routes.ts busts, read from its own source. */
function serverPrefixes(): string[] {
  const src = fs.readFileSync(path.resolve(__dirname, "../server/routes.ts"), "utf8");
  const start = src.indexOf("const USER_CACHE_PREFIXES");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n];", start);
  return [...src.slice(start, end).matchAll(/"([a-z-]+:)"/g)].map((m) => m[1]);
}

describe("cache prefix → domain declarations", () => {
  it("declares every per-user prefix the server busts", () => {
    // An undeclared prefix falls back to "all", which is safe but silently
    // gives up the narrowing for that cache. Naming them keeps the choice
    // deliberate.
    const undeclared = serverPrefixes().filter((p) => !(p in CACHE_PREFIX_DOMAINS));
    expect(undeclared).toEqual([]);
  });

  it("keeps account-wide aggregates depending on everything", () => {
    // These read most of the account. Narrowing them would be the one change
    // here that can serve genuinely stale data, and it would not make them
    // cheaper — they legitimately have to recompute.
    for (const prefix of ["stats:", "enhanced:", "bootstrap:", "profile-detail:", "caltimeline:", "notifications:"]) {
      expect(dependenciesForPrefix(prefix), prefix).toBe("all");
    }
  });

  it("treats an unknown prefix as depending on everything", () => {
    expect(dependenciesForPrefix("something-new:")).toBe("all");
  });
});

describe("version stamps", () => {
  const before = { [EPOCH_KEY]: 5, liabilities: 2, profiles: 3, trackers: 7, habits: 1 };
  const afterPayment = { ...before, liabilities: 3, profiles: 4 };

  it("changes the key of everything a payment feeds", () => {
    for (const prefix of ["stats:", "enhanced:", "bootstrap:", "profiles:", "obligations:"]) {
      expect(versionStamp(prefix, before), prefix).not.toBe(versionStamp(prefix, afterPayment));
    }
  });

  it("leaves the key of everything it does not feed alone", () => {
    // This is the entire point. Before this change these all changed too, so a
    // payment cold-started the tracker list, the task list and the journal.
    for (const prefix of ["trackers:", "tasks:", "habits:", "journal:", "documents:", "goals:"]) {
      expect(versionStamp(prefix, before), prefix).toBe(versionStamp(prefix, afterPayment));
    }
  });

  it("moves every key when the epoch moves", () => {
    // The epoch is the escape hatch: a write that could not be classified — and
    // a write made by an older instance through the legacy one-argument RPC —
    // bumps it, and every prefix carries it. Failure degrades to the old
    // over-invalidation, never to stale data.
    const nuked = { ...before, [EPOCH_KEY]: 6 };
    for (const prefix of Object.keys(CACHE_PREFIX_DOMAINS)) {
      expect(versionStamp(prefix, nuked), prefix).not.toBe(versionStamp(prefix, before));
    }
  });

  it("always produces a key the shared cross-instance cache will accept", () => {
    // sharedCacheEligible() tests for the literal "@v". A stamp without it
    // would silently drop every expensive key out of the Postgres cache.
    for (const prefix of Object.keys(CACHE_PREFIX_DOMAINS)) {
      expect(`user@${versionStamp(prefix, before)}`, prefix).toContain("@v");
    }
  });

  it("does not depend on the order domains were declared in", () => {
    expect(versionStamp("obligations:", { obligations: 1, liabilities: 2 }))
      .toBe(versionStamp("obligations:", { liabilities: 2, obligations: 1 }));
  });

  it("treats an absent version as zero rather than as undefined", () => {
    expect(versionStamp("tasks:", {})).toBe(versionStamp("tasks:", { tasks: 0 }));
    expect(versionStamp("tasks:", undefined)).toBe(versionStamp("tasks:", {}));
  });
});

describe("the read-your-writes token", () => {
  it("round-trips a map", () => {
    expect(decodeVersionMap(encodeVersionMap({ epoch: 4, liabilities: 9 }))).toEqual({ epoch: 4, liabilities: 9 });
  });

  it("reads an older server's bare counter as the epoch", () => {
    expect(decodeVersionMap("21")).toEqual({ epoch: 21 });
    expect(decodeVersionMap(21)).toEqual({ epoch: 21 });
  });

  it("survives a token it cannot parse", () => {
    expect(decodeVersionMap("")).toEqual({});
    expect(decodeVersionMap(null)).toEqual({});
    expect(decodeVersionMap("garbage")).toEqual({});
    expect(decodeVersionMap("liabilities:notanumber")).toEqual({});
  });

  it("only ever moves a version forward, per domain", () => {
    // A response that arrives out of order must not walk a version backwards —
    // that would re-address a pre-write cache entry.
    expect(mergeVersionMaps({ epoch: 5, liabilities: 9 }, { epoch: 3, liabilities: 2 }))
      .toEqual({ epoch: 5, liabilities: 9 });
    expect(mergeVersionMaps({ epoch: 5 }, { epoch: 7, trackers: 2 }))
      .toEqual({ epoch: 7, trackers: 2 });
  });

  it("clamps a token that claims an implausible jump", () => {
    // A buggy or hostile token costs that one user some cache misses and
    // nothing else — keys are per-user, so no other account is reachable.
    const merged = mergeVersionMaps({ epoch: 5 }, { epoch: 10_000_000 });
    expect(merged.epoch).toBe(5 + MAX_VERSION_LOOKAHEAD);
  });
});

describe("prefixes that seed each other must stamp identically", () => {
  it("keeps bootstrap, stats and enhanced on one stamp", () => {
    // /api/dashboard-bootstrap computes stats and dashboard-enhanced in the
    // same request and SEEDS their cache keys, using the stamp it resolved for
    // itself. If one of the three were narrowed without the others, that
    // seeding would write keys the real requests never look up — a warmup that
    // silently does nothing, and the cold dashboard it was meant to prevent.
    const versions = { epoch: 2, liabilities: 4, trackers: 9 };
    const stamps = ["bootstrap:", "stats:", "enhanced:"].map((p) => versionStamp(p, versions));
    expect(new Set(stamps).size).toBe(1);
  });
});
