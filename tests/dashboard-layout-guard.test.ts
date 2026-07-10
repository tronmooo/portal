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
