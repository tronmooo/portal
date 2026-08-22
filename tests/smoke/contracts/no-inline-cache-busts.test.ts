/**
 * Build-time guard: the server response cache has exactly ONE bust path.
 *
 * `cacheBustMiddleware` (server/routes.ts) already busts every per-user cache
 * prefix — pre-handler AND on 'finish' — for every mutating request, via
 * `bustUserCaches(uid)` over USER_CACHE_PREFIXES. For years route handlers
 * ALSO carried inline `bustCache(...)` calls. Those were (a) fully redundant
 * with the middleware and (b) the source of a real cross-user bug: calls like
 * `bustCache(`enhanced:`)` / `bustCache(`trackers:`)` had no uid suffix, so a
 * single user's write wiped those caches for EVERY user on the warm instance
 * (BUG-20260822-unscoped-bust). The inline calls were removed 2026-08-22.
 *
 * This guard keeps it that way:
 *   1) No inline bustCache calls may reappear in route handlers — the only
 *      allowed uses are the bustCache function definition and the
 *      USER_CACHE_PREFIXES loop inside bustUserCaches. Anything else is either
 *      redundant or, if unscoped, the cross-user wipe again.
 *   2) Every response-cache key prefix constructed in routes.ts must be listed
 *      in USER_CACHE_PREFIXES (or explicitly exempt below). Before this guard,
 *      `paychecks:` / `incomes:` / `profiles-lite:` were cached but missing
 *      from the list — the same gap as the documented `caltimeline:` staleness
 *      window — and were only kept honest by the very inline busts rule 1 bans.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROUTES = path.resolve(__dirname, "..", "..", "..", "server", "routes.ts");

// Long-TTL AI-generated summaries: deliberately NOT busted on ordinary writes
// (a 4h briefing must survive an expense edit). Add here only with the same
// justification.
const EXEMPT_PREFIXES = new Set(["aisummary:"]);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("response-cache busting has a single owner (contracts)", () => {
  const raw = readFileSync(ROUTES, "utf8");
  const src = stripComments(raw);
  const lines = src.split("\n");

  it("routes.ts has no inline bustCache calls outside the canonical machinery", () => {
    const offenders = lines
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.includes("bustCache("))
      .filter(({ line }) => !line.startsWith("function bustCache("))
      .filter(({ line }) => !line.includes("for (const prefix of USER_CACHE_PREFIXES)"));
    expect(
      offenders,
      "Inline bustCache calls found. cacheBustMiddleware already busts every " +
        "USER_CACHE_PREFIXES key for the mutating user (pre-handler and on " +
        "finish); an inline call is redundant, and an unscoped one " +
        "(no uid in the prefix) wipes OTHER users' caches. If a new cache key " +
        "needs busting on writes, add its prefix to USER_CACHE_PREFIXES instead.",
    ).toEqual([]);
  });

  it("every response-cache key prefix is covered by USER_CACHE_PREFIXES (or exempt)", () => {
    const listMatch = src.match(/const USER_CACHE_PREFIXES = \[([\s\S]*?)\];/);
    expect(listMatch, "USER_CACHE_PREFIXES array not found in routes.ts").toBeTruthy();
    const covered = new Set(
      Array.from(listMatch![1].matchAll(/"([^"]+)"/g)).map((m) => m[1]),
    );

    // Key-construction sites: template literals whose value starts with a
    // `prefix:` token immediately followed by an interpolation — the shape
    // every getCached/setCache key in this file uses.
    const keyDecl = /=\s*`([a-z][a-z0-9_-]*:)\$\{/g;
    const used = new Set<string>();
    for (const m of src.matchAll(keyDecl)) {
      const prefix = m[1];
      // Not cache keys: rate-limit buckets, dedupe fingerprints, log tags.
      const context = src.slice(Math.max(0, m.index! - 200), m.index! + 200);
      if (!/getCached|setCache|CacheKey|cacheKey|Ck\b|ck\b/i.test(context)) continue;
      used.add(prefix);
    }
    expect(used.size, "expected to find cache key constructions").toBeGreaterThan(5);

    const missing = [...used].filter((p) => !covered.has(p) && !EXEMPT_PREFIXES.has(p));
    expect(
      missing,
      "Cache key prefixes constructed in routes.ts but absent from " +
        "USER_CACHE_PREFIXES — writes will not bust them on the writing " +
        "instance (the caltimeline: staleness bug all over again). Add them " +
        "to the list, or to EXEMPT_PREFIXES in this test with a justification.",
    ).toEqual([]);
  });
});
