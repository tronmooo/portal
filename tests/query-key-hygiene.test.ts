// Guard against the "bare-key unscoped read" connectedness bug (G3).
//
// The scoped hub pages (dashboard/finance/wellness) render under the global
// profile filter. If one of them reads a profile-filterable endpoint with a
// BARE key — `useQuery({ queryKey: ["/api/trackers"] })` instead of
// `["/api/trackers", filterMode, ...filterIds]` — it lands in a different
// cache slot from the rest of the app and silently shows Everyone data while a
// single profile is selected (the KeyFindingsSection bug). This test fails if
// such a read reappears.
//
// NOTE: this targets READ keys only. `invalidateQueries` / `setQueriesData` /
// `cancelQueries` with a bare key are CORRECT (prefix-match reconciles every
// scoped slot) and end with `})`, so the read-only regex below never matches
// them. Dedicated single-entity pages (profile-detail, CalendarManagerPanel)
// intentionally fetch the full list to filter client-side and are out of scope.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const HUB_PAGES = ["dashboard.tsx", "finance.tsx", "wellness.tsx"];
// Endpoints that MUST carry [endpoint, filterMode, ...filterIds] on the hub pages.
const FILTERABLE = ["trackers", "obligations", "habits", "events", "dashboard-enhanced", "net-worth/history", "goals"];

describe("query-key hygiene (connectedness guard G3)", () => {
  const eps = FILTERABLE.map((e) => e.replace("/", "\\/")).join("|");
  // Match a `useQuery(...)` whose queryKey is a BARE filterable key
  // `["/api/<ep>"]` — no `filterMode`/ids after it. `[^;]*?` keeps the match
  // inside a single useQuery statement (they contain no `;`), so
  // invalidateQueries/setQueriesData/cancelQueries (no `useQuery` prefix) and
  // scoped keys (a comma + more elements before `]`) never match. `s` flag lets
  // the match span the multi-line `useQuery({ ... })` form.
  const bareReadRe = new RegExp(
    `useQuery[^;]*?queryKey:\\s*\\[\\s*["']\\/api\\/(?:${eps})["']\\s*\\]`,
    "gs",
  );

  for (const page of HUB_PAGES) {
    it(`${page} has no bare profile-filterable read keys`, () => {
      const file = path.resolve(__dirname, "../client/src/pages", page);
      const src = fs.readFileSync(file, "utf8");
      const matches = src.match(bareReadRe) || [];
      // Report a short snippet per offender for a readable failure.
      const offenders = matches.map((m) => m.replace(/\s+/g, " ").slice(0, 80));
      expect(offenders, `bare filterable reads in ${page}`).toEqual([]);
    });
  }
});
