// Structural guard against the profile-data-leak bug class (BUG-20260709).
//
// WHY THIS EXISTS — the root cause of the recurring "other profiles' data shows
// up" bugs: profile scoping is applied BY HAND at every read site. A component
// that reads a profile-filterable endpoint must (a) put the active filter in its
// query KEY — ["/api/x", filterMode, ...filterIds] — and (b) append ?profileIds=
// in its query FN. Miss either and the read lands in the global ("Everyone")
// cache slot and silently shows every profile's data while one profile is
// selected. That is exactly how INCOME·MTD (/api/incomes), the reminders card
// (/api/reminders) and the wellness health docs (/api/documents) all leaked.
//
// The previous guard only scanned 3 pages and 7 endpoints, so those reads sailed
// past CI. This version scans EVERY page and component for a bare read of ANY
// profile-filterable endpoint. The only permitted exceptions are listed — and
// documented — in ALLOWLIST below. Adding a new bare read anywhere else fails
// this test; the fix is to scope the read, not to extend the allowlist without
// cause.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// Every endpoint whose rows carry per-profile ownership (linkedProfiles / a
// profileId) and are filtered server-side by ?profileIds=. A bare read of any
// of these on a profile-scoped surface leaks other profiles' data.
const FILTERABLE = [
  "incomes", "expenses", "obligations", "tasks", "habits", "trackers",
  "events", "goals", "journal", "reminders", "paychecks", "documents",
  "notifications", "memories", "dashboard-enhanced", "net-worth/history",
  "budgets/summary", "stats", "insights", "ai-digest", "activity",
];

// INTENTIONAL exceptions — a bare read here is CORRECT, with the reason.
// Two legitimate shapes:
//   1. GLOBAL/account pages that do NOT render under the profile filter
//      (settings, profile-info) — there is no active profile to scope to.
//   2. "Fetch-all-then-filter-locally" surfaces that pull the whole list and
//      apply passesProfileFilter / a route-profile id in-component, so the
//      network read is intentionally unscoped (profile-detail, trackers,
//      artifacts, the global CalendarManagerPanel).
// Key shape: "<relpath from client/src>::<endpoint>".
const ALLOWLIST = new Set<string>([
  // Global calendar manager — a management tool that intentionally shows the
  // full set across all profiles.
  "components/CalendarManagerPanel.tsx::documents",
  "components/CalendarManagerPanel.tsx::obligations",
  "components/CalendarManagerPanel.tsx::events",
  "components/CalendarManagerPanel.tsx::tasks",
  // Artifacts library — reads all docs, then applies passesProfileFilter into
  // `profileFiltered` before rendering (see artifacts.tsx).
  "pages/artifacts.tsx::documents",
  // A single profile's detail page — fetches the full list and filters to the
  // route's profile id client-side.
  "pages/profile-detail.tsx::events",
  "pages/profile-detail.tsx::journal",
  "pages/profile-detail.tsx::documents",
  "pages/profile-detail.tsx::trackers",
  // Account / settings pages — global, not rendered under the profile filter.
  "pages/profile-info.tsx::memories",
  "pages/settings.tsx::stats",
  "pages/settings.tsx::documents",
  // Trackers hub — reads all docs, then filters into `profileFilteredDocs`
  // (passesProfileFilter) before any display; the combined feed also filters.
  "pages/trackers.tsx::documents",
  // Briefing detail popups — lookup maps keyed BY ID to enrich rows that are
  // already profile-scoped upstream (bills/docs come from the filtered
  // dashboard-enhanced snapshot); nothing from these lists renders directly.
  "components/dashboard/BriefingPopups.tsx::obligations",
  "components/dashboard/BriefingPopups.tsx::documents",
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("query-key hygiene — profile-scope leak guard (repo-wide)", () => {
  const root = path.resolve(__dirname, "../client/src");
  const eps = FILTERABLE.map((e) => e.replace("/", "\\/")).join("|");
  // A `useQuery({ ... queryKey: ["/api/<ep>"] ... })` whose key is BARE — the
  // endpoint string is immediately followed by `]` (no filterMode/ids). `[^;]*?`
  // keeps the match inside the single useQuery statement, so invalidateQueries /
  // setQueriesData / cancelQueries (no `useQuery(` prefix) never match, and a
  // scoped key ["/api/x", ...] has a comma before `]` and never matches.
  const bareReadRe = new RegExp(
    `useQuery\\s*(?:<[^>]*>)?\\s*\\(\\s*\\{[^;]*?queryKey:\\s*\\[\\s*["']\\/api\\/(?:${eps})["']\\s*\\]`,
    "gs",
  );

  const offenders: string[] = [];
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    bareReadRe.lastIndex = 0;
    while ((m = bareReadRe.exec(src)) !== null) {
      const ep = /\/api\/([^"']+)/.exec(m[0])![1];
      const rel = path.relative(root, file).split(path.sep).join("/");
      const key = `${rel}::${ep}`;
      if (!ALLOWLIST.has(key)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${rel}:${line} bare read of /api/${ep}`);
      }
    }
  }

  it("no unscoped read of a profile-filterable endpoint outside the allowlist", () => {
    expect(
      offenders,
      "A read below hits a profile-scoped endpoint with a BARE query key, so it " +
        "shows every profile's data while one profile is selected. Scope it with " +
        "[endpoint, filterMode, ...filterIds] + ?profileIds= in the queryFn. Only " +
        "add to ALLOWLIST if the read is genuinely global or filtered locally.",
    ).toEqual([]);
  });

  it("guards a meaningful surface (sanity: endpoints + files are actually scanned)", () => {
    // Guardrail on the guard: if the regex silently stops matching (e.g. a
    // refactor changes useQuery call shape), this catches it by asserting the
    // allowlisted reads are still SEEN by the scanner.
    const seen = new Set<string>();
    for (const file of walk(root)) {
      const src = fs.readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      bareReadRe.lastIndex = 0;
      while ((m = bareReadRe.exec(src)) !== null) {
        const ep = /\/api\/([^"']+)/.exec(m[0])![1];
        const rel = path.relative(root, file).split(path.sep).join("/");
        seen.add(`${rel}::${ep}`);
      }
    }
    // Every allowlisted entry must still be found — otherwise the allowlist is
    // stale (the read was scoped/removed) OR the scanner broke.
    const missing = [...ALLOWLIST].filter((k) => !seen.has(k));
    expect(missing, "stale ALLOWLIST entries (remove them) or scanner regex broke").toEqual([]);
  });
});
