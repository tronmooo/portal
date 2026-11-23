// Owner, 2026-11-23: "remove this from my dashboard [the Expense / Income /
// Bill / Note / Task row], this button [⋮] should be in the Next Important
// bubble … I tried pressing these three buttons [bell, theme, account] and
// they don't work."
//
// 1. The header's bell, theme and account buttons sat under the iOS status
//    bar on the home-screen app (viewport-fit=cover + black-translucent), where
//    iOS keeps every tap. The header must pad for the safe area.
// 2. The Quick Actions row is gone from the dashboard, and a saved layout that
//    still names it drops it.
// 3. The ⋮ menu joins the Next Important bar whenever the briefing is on the
//    page, not only when the briefing is the first section.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SECTION_DEFS, LAYOUT_VERSION, parseLayoutValue } from "../shared/dashboard-layout";

const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("app header is tappable on an installed iPhone app", () => {
  it("the page draws under the status bar, so the header pads for it", () => {
    const html = read("client/index.html");
    expect(html).toMatch(/viewport-fit=cover/);
    expect(html).toMatch(/black-translucent/);
    const app = read("client/src/App.tsx");
    const header = app.match(/<header[^>]*data-testid="app-header"[^>]*>/s)?.[0];
    expect(header, "the app header must carry data-testid=app-header").toBeTruthy();
    expect(header!).toMatch(/env\(safe-area-inset-top/);
  });
});

describe("Quick Actions row is removed from the dashboard", () => {
  it("is not a dashboard section", () => {
    expect(DEFAULT_SECTION_DEFS.map((s) => s.id)).not.toContain("quick-actions");
    expect(DEFAULT_SECTION_DEFS.map((s) => s.id)).toContain("exec-briefing");
  });

  it("a saved layout that still shows it drops it and keeps the rest", () => {
    const saved = JSON.stringify({ version: LAYOUT_VERSION, sections: [
      { id: "quick-actions", label: "Quick Actions", visible: true, column: "full" },
      { id: "exec-briefing", label: "Daily Briefing", visible: true, column: "full" },
    ] });
    const parsed = parseLayoutValue(saved);
    expect(parsed).not.toBeNull();
    expect(parsed!.map((s) => s.id)).not.toContain("quick-actions");
    expect(parsed![0]).toMatchObject({ id: "exec-briefing", visible: true });
  });

  it("the dashboard page no longer renders the row", () => {
    const page = read("client/src/pages/dashboard.tsx");
    expect(page).not.toMatch(/QuickActionsSection/);
    expect(page).not.toMatch(/section-quick-actions/);
  });
});

describe("the ⋮ menu lives in the Next Important bar", () => {
  it("whenever the briefing is shown, not only when it leads the page", () => {
    const page = read("client/src/pages/dashboard.tsx");
    expect(page).toMatch(/sections\.some\(\(s\) => s\.visible && s\.id === "exec-briefing"\)/);
    expect(page).not.toMatch(/sections\.find\(\(s\) => s\.visible\)\?\.id === "exec-briefing"/);
    expect(page).toMatch(/overviewEnd=\{menuInBriefing \? dashboardMenu : undefined\}/);
  });
});
