// ── Block 1 ("Pulse") has exactly one implementation ────────────────────────
// The hub shell (components/hub/HubKpiStrip.tsx) pins the stat chips above
// EVERY hub tab, including /dashboard. That is already the spec's block 1 —
// "sticky strip, always visible". A pass that did not know the hub existed
// added a second Pulse strip inside ExecutiveBriefing, so the board rendered
// net worth / cash flow / wellness / streak twice, stacked, which is exactly
// the redundancy this work exists to remove.
//
// Source-level assertions because this is a structural property: two components
// in different files rendering the same four numbers is invisible to a unit
// render test of either one.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const strip = readFileSync("client/src/components/hub/HubKpiStrip.tsx", "utf8");
const briefing = readFileSync("client/src/components/dashboard/ExecutiveBriefing.tsx", "utf8");
const hubRoutes = readFileSync("client/src/components/hub/hub-routes.ts", "utf8");

const chipLabels = [...strip.matchAll(/label="([^"]+)"/g)].map(m => m[1]);

describe("the hub KPI strip is block 1", () => {
  it("carries exactly the four numbers the spec asks for", () => {
    expect(chipLabels).toEqual(["Net Worth", "Cash Flow", "Wellness", "Streak"]);
  });

  it("no longer restates Tasks Due / Docs Exp", () => {
    // Those rows are owned by the board's Needs Attention and Today blocks, one
    // scroll below the strip.
    expect(chipLabels).not.toContain("Tasks Due");
    expect(chipLabels).not.toContain("Docs Exp");
  });

  it("renders on the Executive tab, which is what makes it block 1", () => {
    expect(hubRoutes).toMatch(/path === "\/dashboard"/);
    expect(hubRoutes).toMatch(/id: "executive",\s+label: "Executive",\s+route: "\/dashboard"/);
  });
});

describe("the board does not render a second Pulse", () => {
  it("ExecutiveBriefing has no Pulse component", () => {
    expect(briefing).not.toMatch(/function Pulse\b/);
    expect(briefing).not.toMatch(/<Pulse\b/);
  });

  it("ExecutiveBriefing renders no block-pulse testid", () => {
    expect(briefing).not.toContain('data-testid="block-pulse"');
    expect(briefing).not.toContain("block-pulse");
  });

  it("ExecutiveBriefing does not re-derive the strip's four numbers as tiles", () => {
    // The model still computes `pulse` (the strip could adopt it later), but the
    // board must not render those numbers itself.
    for (const id of ["pulse-net-worth", "pulse-cash-flow", "pulse-wellness", "pulse-streak"]) {
      expect(briefing, `${id} must not render on the board`).not.toContain(id);
    }
  });
});
