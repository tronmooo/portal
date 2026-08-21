// ── Dashboard layout drift guard ─────────────────────────────────────────────
// shared/dashboard-layout.ts is the ONE source of truth for section defs and
// LAYOUT_VERSION. If the client redefines either locally again, a server
// writer (configure_dashboard_sections) stamping the shared version would
// diverge from what parseSavedLayout accepts — and saved layouts would be
// silently discarded. This test fails on any local redefinition.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { LAYOUT_VERSION, DEFAULT_SECTION_DEFS, parseLayoutValue, serializeLayoutValue, findSection } from "../shared/dashboard-layout";

const dashboardSrc = readFileSync("client/src/pages/dashboard.tsx", "utf8");

describe("dashboard layout single source of truth", () => {
  it("client imports the shared module and does not redefine the constants", () => {
    expect(dashboardSrc).toMatch(/from ["']@shared\/dashboard-layout["']/);
    expect(dashboardSrc).not.toMatch(/const LAYOUT_VERSION\s*=/);
    expect(dashboardSrc).not.toMatch(/const DEFAULT_SECTIONS:\s*DashboardSection\[\]\s*=\s*\[/);
  });

  it("every section id has a client icon mapping", () => {
    for (const def of DEFAULT_SECTION_DEFS) {
      expect(dashboardSrc, `missing SECTION_ICONS entry for "${def.id}"`).toContain(`"${def.id}"`);
    }
  });

  it("round-trips a layout through serialize/parse with the current version", () => {
    const value = serializeLayoutValue(DEFAULT_SECTION_DEFS);
    const parsed = parseLayoutValue(value);
    expect(parsed).not.toBeNull();
    expect(parsed!.map((s) => s.id)).toEqual(DEFAULT_SECTION_DEFS.map((s) => s.id));
  });

  it("rejects layouts stamped with an older version (client reset semantics)", () => {
    const stale = JSON.stringify({ version: LAYOUT_VERSION - 1, sections: DEFAULT_SECTION_DEFS });
    expect(parseLayoutValue(stale)).toBeNull();
  });

  it("findSection resolves labels, ids, and partials", () => {
    expect(findSection(DEFAULT_SECTION_DEFS, "Weekly Summary")?.id).toBe("weekly-summary");
    expect(findSection(DEFAULT_SECTION_DEFS, "finance")?.id).toBe("finance");
    expect(findSection(DEFAULT_SECTION_DEFS, "notif")?.id).toBe("notifications");
    expect(findSection(DEFAULT_SECTION_DEFS, "nonexistent")).toBeUndefined();
  });
});

// ── Executive grid packs, with no dead space ─────────────────────────────────
// User report 2026-08-20 (screenshot): large black gaps between Executive
// cards, because the grid was `items-start` — every card shrank to its content
// and the shorter of each pair left a void running down to the next row. The
// three rules that fix it have to stay together; drop any one and the gaps
// come back, so each is pinned here.
describe("executive dashboard grid has no dead space", () => {
  const execSrc = readFileSync("client/src/components/dashboard/ExecutiveBriefing.tsx", "utf8");
  const cssSrc = readFileSync("client/src/index.css", "utf8");

  it("the card grid stretches its rows instead of top-aligning them", () => {
    const grid = execSrc.match(/className="exec-grid grid[^"]*"/);
    expect(grid, "the exec card grid should carry the exec-grid class").toBeTruthy();
    expect(grid![0], "items-start re-introduces the black gaps").not.toContain("items-start");
  });

  it("a card fills its cell and lays out as a column", () => {
    // ExecCard's <section> — h-full is what makes the short card in a row grow
    // to the row's height rather than leaving the rest of the cell empty.
    expect(execSrc).toMatch(/bubble bubble-enter p-3\.5 sm:p-4 h-full flex flex-col/);
  });

  it("card content lives in a bounded, scrollable body", () => {
    expect(execSrc).toContain('className="exec-card-body flex-1 min-h-0 flex flex-col"');
    expect(cssSrc).toMatch(/\.exec-card-body\s*\{[^}]*max-height/);
    expect(cssSrc).toMatch(/\.exec-card-body\s*\{[^}]*overflow-y:\s*auto/);
  });

  it("an odd trailing card spans the full width rather than leaving a blank cell", () => {
    expect(cssSrc).toMatch(/\.exec-grid\s*>\s*\*:last-child:nth-child\(odd\)\s*\{\s*grid-column:\s*1\s*\/\s*-1/);
  });

  it("the packing rules are desktop-only — phones are a single column", () => {
    const idx = cssSrc.indexOf(".exec-card-body");
    const mediaOpen = cssSrc.lastIndexOf("@media (min-width: 768px)", idx);
    expect(mediaOpen, "exec grid rules must sit inside a min-width media query").toBeGreaterThan(-1);
  });

  it("an empty card centres its message instead of hugging the top", () => {
    expect(execSrc).toMatch(/function CardEmpty[\s\S]{0,320}flex-1 flex items-center justify-center/);
  });
});
