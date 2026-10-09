// Rules 3 and 4 — navigation and filters are presentation only.
//
// Pure rules (client/src/lib/view-filters.ts) plus static guards over the
// client source so the class of bug behind "I pressed on bubbles and now all
// my assets are missing" (2026-10-09) cannot be reintroduced on another page:
//   · a presentation filter persisted to storage outlives the gesture that set
//     it and silently hides records on every later visit;
//   · a filter-chip row gated on `options.length > 1` hides the very control
//     that shows (and clears) an active filter;
//   · a page that issues a write from a mount effect turns NAVIGATION into a
//     data change.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  activeViewFilters, emptyReason, filterSummary, isViewFilterActive, showFilterControls,
} from "../client/src/lib/view-filters";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, "client/src"));
  return out;
}

describe("view-filter rules", () => {
  const off = { value: "all", defaultValue: "all" };
  const on = { value: "hasChildren", defaultValue: "all" };

  it("an active filter keeps its controls on screen even with a single option (the screenshot)", () => {
    // One asset left after "Has children" → one type option. The old gate
    // (`options.length > 1`) removed the row and its reset with the filter on.
    expect(showFilterControls(1, [on])).toBe(true);
    expect(showFilterControls(0, [on])).toBe(true);
    expect(showFilterControls(1, [off])).toBe(false);
    expect(showFilterControls(2, [off])).toBe(true);
  });

  it("an empty list caused by a filter is 'filtered', never 'empty'", () => {
    expect(emptyReason({ shown: 0, total: 5, filters: [on] })).toBe("filtered");
    expect(emptyReason({ shown: 0, total: 0, filters: [on] })).toBe("empty");
    expect(emptyReason({ shown: 0, total: 0, filters: [off] })).toBe("empty");
    expect(emptyReason({ shown: 1, total: 5, filters: [on] })).toBe("none");
  });

  it("a failed request is 'error' and an in-flight one is 'loading' — neither claims there are no records (Rule 10)", () => {
    expect(emptyReason({ shown: 0, total: 0, error: true })).toBe("error");
    expect(emptyReason({ shown: 0, total: 0, loading: true })).toBe("loading");
  });

  it("reports which filters are active and summarizes the hidden count", () => {
    expect(isViewFilterActive(on)).toBe(true);
    expect(activeViewFilters([off, on])).toEqual([on]);
    expect(filterSummary(1, 5, { one: "asset", many: "assets" })).toBe("Showing 1 of 5 assets");
  });
});

describe("static guards", () => {
  it("no page persists a record-HIDING filter to sessionStorage/localStorage", () => {
    // View preferences that only reorder or restyle (sort, card/list view, a
    // collapsed section) may be remembered; anything named like a filter that
    // hides rows may not. The profile SCOPE store is the one deliberate
    // exception: it is the app-wide "whose dashboard" switch, always shown in
    // the header with its own control (client/src/lib/profileFilter.ts).
    const allowed = new Set(["client/src/lib/profileFilter.ts"]);
    const offenders: string[] = [];
    for (const f of clientFiles()) {
      if (allowed.has(f)) continue;
      const src = read(f);
      for (const m of src.matchAll(/(sessionStorage|localStorage)\.setItem\(\s*["'`]([^"'`]+)["'`]/g)) {
        const key = m[2].toLowerCase();
        if (/filter|_cat\b|_range\b|nesting|doctype|category/.test(key)) offenders.push(`${f}: ${m[2]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the Assets / Liabilities / Documents / Trackers chip rows stay visible while a filter is active", () => {
    const src = read("client/src/pages/trackers.tsx");
    expect(src).not.toMatch(/sectionFilter === "profiles" && assetTypeOptions\.length > 1/);
    expect(src).not.toMatch(/sectionFilter === "liabilities" && liabilityCategoryOptions\.length > 1/);
    expect(src).not.toMatch(/sectionFilter === "documents" && docTypes\.length > 1/);
    expect(src).not.toMatch(/sectionFilter === "trackers" && allTrackerCats\.length > 1/);
    expect(src).toContain("showFilterControls(assetTypeOptions.length, assetFilterStates)");
    expect(src).toContain("portol_asset_nesting_filter\"); } catch"); // the stale-key cleanup
  });

  it("no page issues a write from a mount effect (navigation cannot mutate data)", () => {
    // Opening the Trackers/Assets page used to POST /api/trackers/migrate-to-self
    // and rewrite the owner of every unlinked tracker. Two known POSTs inside
    // effects are READ-shaped: the editor's AI transform (a read-only POST on
    // the server allowlist) and a chart artifact's data binding (a chat READ
    // turn, which the server refuses to let write — Rule 1).
    const allowed = new Set([
      "client/src/pages/artifacts.tsx:/api/chat",
      "client/src/pages/editor.tsx:/api/ai-transform",
    ]);
    const offenders: string[] = [];
    for (const f of clientFiles()) {
      const src = read(f);
      for (const m of src.matchAll(/useEffect\(\s*\(\)\s*=>\s*\{/g)) {
        let i = (m.index ?? 0) + m[0].length;
        let depth = 1;
        while (i < src.length && depth > 0) {
          const c = src[i++];
          if (c === "{") depth++;
          else if (c === "}") depth--;
        }
        const body = src.slice((m.index ?? 0) + m[0].length, i);
        for (const w of body.matchAll(/apiRequest\(\s*"(POST|PATCH|PUT|DELETE)"\s*,\s*[`"']([^`"'$?]+)/g)) {
          const tag = `${f}:${w[2]}`;
          if (!allowed.has(tag)) offenders.push(`${tag} (${w[1]})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the household profile cards announce that they switch the dashboard view", () => {
    const src = read("client/src/pages/dashboard.tsx");
    expect(src).toMatch(/title=\{`Show \$\{c\.name\}'s dashboard`\}/);
  });
});
