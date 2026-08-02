/**
 * Build-time guard: list endpoints must not silently truncate.
 *
 * WHAT WENT WRONG (user report 2026-08-02, "I had to refresh the entire app for
 * all the trackers to show up, especially when there's a lot"):
 *
 * A generic `paginate()` helper defaulted to 100 rows per page. No client ever
 * sent `?limit`, and nothing read `X-Total-Count`, so it silently truncated
 * whatever it was applied to. Worse, `/api/dashboard-bootstrap` seeds the SAME
 * react-query cache slots UNCAPPED — so every affected list rendered complete
 * from the bootstrap seed and then visibly SHRANK to 100 the moment its own
 * fetch landed. Reloading the whole app was the only way to see everything
 * again, because that re-seeded from the bootstrap.
 *
 * This is the FOURTH time this cap has caused a bug:
 *   1. Finance page summed only the first 100 expenses   → paginateFull
 *   2. Net-worth rollup saw only the first 500 profiles  → paginateProfiles
 *   3. Documents list capped at 100 (hand-rolled copy of the same math)
 *   4. trackers/tasks/events/habits/obligations/artifacts/journal/goals
 *
 * So the helper is gone rather than fixed. `paginateFull` returns every row by
 * default and slices only when a caller explicitly opts in with
 * `?limit=`/`?offset=`, which is the only shape that agrees with the bootstrap
 * seed.
 *
 * Fix when this fails: use `paginateFull` (or `paginateProfiles`). If you truly
 * need a page-by-default endpoint, it must not be one the bootstrap seeds, and
 * its client must send an explicit limit and read X-Total-Count.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const ROUTES = path.join(REPO_ROOT, "server", "routes.ts");

/**
 * Strip comments so prose ABOUT the removed helper (including the tombstone
 * comment explaining why it was removed) isn't mistaken for a call to it.
 * Deliberately naive — routes.ts has no regex literals or strings containing
 * `//` that would confuse it, and a false positive here fails loudly rather
 * than silently passing.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("list pagination is full-by-default", () => {
  const raw = readFileSync(ROUTES, "utf8");
  const src = stripComments(raw);

  it("defines no capped paginate() helper", () => {
    // A `function paginate(` declaration — the helper itself, not paginateFull
    // or paginateProfiles (both full-by-default).
    const declaration = /function\s+paginate\s*</.test(src) || /function\s+paginate\s*\(/.test(src);
    expect(
      declaration,
      "server/routes.ts declares a capped paginate() helper again. Use paginateFull " +
        "— see the comment above its definition for why the capped one was removed.",
    ).toBe(false);
  });

  it("calls no capped paginate() from any route", () => {
    // Match `paginate(` but not `paginateFull(` / `paginateProfiles(`.
    const calls = src.match(/(?<![A-Za-z])paginate\((?!Full|Profiles)/g) || [];
    expect(
      calls.length,
      `${calls.length} route(s) still call the capped paginate(). Switch them to paginateFull().`,
    ).toBe(0);
  });

  it("does not hand-roll the 100/500 cap that paginate() used to apply", () => {
    // The exact arithmetic the old helper used, which /api/documents had copied
    // inline: `parseInt(req.query.limit) || 100` clamped to 500.
    const handRolled = /parseInt\(\s*req\.query\.limit[^)]*\)\s*\|\|\s*100\b/g;
    const hits = src.match(handRolled) || [];
    expect(
      hits.length,
      "A route re-derives the old 100-row default inline. Default to the full list " +
        "(FULL_PAGE_LIMIT) and slice only when the caller passes ?limit=/?offset=.",
    ).toBe(0);
  });

  it("keeps the bootstrap-seeded list endpoints uncapped", () => {
    // Every endpoint whose rows the dashboard bootstrap seeds into the client
    // cache. If one of these ever pages by default it will disagree with its
    // own seed, which is precisely the shrinking-list bug.
    const seededListRoutes = [
      "/api/trackers",
      "/api/tasks",
      "/api/events",
      "/api/documents",
      "/api/habits",
      "/api/obligations",
      "/api/journal",
      "/api/goals",
    ];
    for (const route of seededListRoutes) {
      const handler = src.slice(src.indexOf(`app.get("${route}"`));
      expect(
        handler.length,
        `route ${route} not found in server/routes.ts`,
      ).toBeGreaterThan(0);
      // Look only at this handler's body (up to the next route registration).
      const nextRoute = handler.indexOf("\n  app.get(", 10);
      const body = nextRoute === -1 ? handler.slice(0, 4000) : handler.slice(0, nextRoute);
      expect(
        /(?<![A-Za-z])paginate\((?!Full|Profiles)/.test(body),
        `${route} pages by default — it must return every row unless the caller asks.`,
      ).toBe(false);
    }
  });
});
