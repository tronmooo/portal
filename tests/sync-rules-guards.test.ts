// App-wide guards for the synchronization bug classes found on 2026-10-09.
//
// The specific screens are fixed and pinned elsewhere (tests/sync-*.test.*).
// These scan the WHOLE codebase so the same mistake made on a new screen, or a
// new endpoint, fails here before it reaches a user:
//   1. an asset's value read with an inline fallback chain instead of the one
//      canonical resolver — how one screen showed a different number;
//   2. a filter-chip row that hides itself (`options.length > 1 && …`) while
//      its filter can still be on — how four assets "disappeared";
//   3. a derived server payload (account-wide cache) that no client
//      invalidation reaches — how the bell and a person's page went stale.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { queryClient } from "../client/src/lib/queryClient";
import { DERIVED_ENDPOINT_DEPENDENCIES, DERIVED_KEY_SHAPES, invalidateDomains, __resetManifestCoverage } from "../client/src/lib/cache-bus";
import { CACHE_PREFIX_DOMAINS } from "@shared/cache-domains";

const root = path.resolve(__dirname, "..");
function sources(dirs: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(e.name)) out.push([rel, fs.readFileSync(path.join(root, rel), "utf8")]);
    }
  };
  dirs.forEach(walk);
  return out;
}

describe("1. asset values go through resolveAssetValue", () => {
  // A chain like `fields.currentValue ?? fields.value ?? fields.purchasePrice`
  // re-implements shared/asset-value.ts with a DIFFERENT precedence, so the
  // screen using it disagrees with net worth. The allowlist is code that reads
  // ONE specific key on purpose (the user's own typed value, the estimator's
  // mirror bookkeeping) — not a value resolution.
  const ALLOW = new Set([
    "shared/asset-value.ts",                              // the resolver itself
    "client/src/components/asset/CurrentValueCard.tsx",   // the user's typed number (userEnteredValue/currentValue)
    "server/valuation/service.ts",                        // mirror: is currentValue present / estimator-owned?
    "server/routes.ts",                                   // lookup-value: the value the user typed
  ]);
  const CHAIN = /currentValue\s*(\|\||\?\?)\s*[\w.?]*(value|Value|purchasePrice|marketValue|estimatedValue|balance)\b/;

  it("no inline value-fallback chain outside the allowlist", () => {
    const offenders: string[] = [];
    for (const [f, src] of sources(["client/src", "server", "shared"])) {
      if (ALLOW.has(f)) continue;
      src.split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return; // comments describe old code
        if (CHAIN.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe("2. filter controls never hide while their filter is on", () => {
  it("no `<options>.length > 1 &&` gate in front of a row that sets a filter", () => {
    const offenders: string[] = [];
    for (const [f, src] of sources(["client/src"])) {
      if (!f.endsWith(".tsx")) continue;
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/\b\w+\.length > 1 &&\s*\(?\s*$/.test(line) && !/\b\w+\.length > 1 && \($/.test(line)) return;
        const block = lines.slice(i + 1, i + 16).join("\n");
        if (/\bset\w*Filter\w*\(/.test(block)) offenders.push(`${f}:${i + 1}`);
      });
    }
    // Use showFilterControls(optionCount, filters) from client/src/lib/view-filters.ts.
    expect(offenders).toEqual([]);
  });
});

describe("3. every account-wide server payload is reached by client invalidation", () => {
  const routes = fs.readFileSync(path.join(root, "server/routes.ts"), "utf8");
  const ALL_PREFIXES = new Set(Object.entries(CACHE_PREFIX_DOMAINS).filter(([, d]) => d === "all").map(([p]) => p));
  // GET routes whose handler CACHES under an account-wide prefix (reads it via
  // cacheUserKey / getCached — not merely busting it after a write).
  function aggregateReads(): Array<{ route: string; prefix: string }> {
    const out: Array<{ route: string; prefix: string }> = [];
    const verbs = [...routes.matchAll(/\n  app\.(get|post|put|patch|delete)\("([^"]+)"/g)];
    verbs.forEach((m, i) => {
      if (m[1] !== "get") return;
      const body = routes.slice(m.index!, verbs[i + 1]?.index ?? routes.length);
      for (const p of body.matchAll(/cacheUserKey\([^)]*?"([a-z-]+:)"\)/g)) {
        if (ALL_PREFIXES.has(p[1])) out.push({ route: m[2], prefix: p[1] });
      }
    });
    return out;
  }
  // Where a route's payload lands in the client cache, when it is not a key
  // named after the route itself.
  const CLIENT_KEY: Record<string, readonly unknown[]> = {
    "/api/profile-bootstrap/:id": ["/api/profiles", "p1", "detail"],
  };
  const NOT_A_QUERY = new Set(["/api/warmup"]); // prefetch-only; never cached client-side

  it("finds the aggregate routes (sanity: the scan still matches the source)", () => {
    const found = aggregateReads().map(r => r.route);
    expect(found).toEqual(expect.arrayContaining(["/api/notifications", "/api/dashboard-enhanced", "/api/calendar/timeline"]));
  });

  it("each one is invalidated by every data domain (its server cache depends on all of them)", () => {
    const missing: string[] = [];
    for (const { route, prefix } of aggregateReads()) {
      if (NOT_A_QUERY.has(route)) continue;
      const key = CLIENT_KEY[route];
      if (key) {
        if (!DERIVED_KEY_SHAPES.some(s => s.matches(key))) missing.push(`${route} (${prefix}) → key ${JSON.stringify(key)}`);
        continue;
      }
      if (!DERIVED_ENDPOINT_DEPENDENCIES[route]) missing.push(`${route} (${prefix}) has no DERIVED_ENDPOINT_DEPENDENCIES entry`);
    }
    expect(missing).toEqual([]);
  });

  it("a task write refreshes a person's page (which embeds their tasks)", async () => {
    __resetManifestCoverage();
    queryClient.clear();
    queryClient.setQueryData(["/api/profiles", "p1", "detail"], { id: "p1", relatedTasks: [] });
    await invalidateDomains("tasks");
    expect(queryClient.getQueryState(["/api/profiles", "p1", "detail"])?.isInvalidated).toBe(true);
    // and is kept on screen while it refetches
    expect(queryClient.getQueryData(["/api/profiles", "p1", "detail"])).toEqual({ id: "p1", relatedTasks: [] });
  });
});
