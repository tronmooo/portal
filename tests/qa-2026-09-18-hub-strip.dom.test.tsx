// @vitest-environment jsdom
//
// QA 2026-09-18 BUG-10 / BUG-28 — the hub KPI strip.
//
// BUG-10: "TASKS DUE 9 · 5 late" on the strip disagreed with the Tasks card's
// "8 Remaining · 4 Overdue" and survived two reloads, because the chip read
// /api/stats.activeTasks and /api/dashboard-enhanced.overdueTasks (two older
// snapshots) while the card counted /api/tasks. The chip now counts the same
// /api/tasks cache slot with the same shared rule (shared/task-counts).
//
// BUG-28: at 1442px the strip ended mid-word with the DOCS EXP chip off-screen
// and no hint that it scrolled. When the row is clipped a gradient plus an
// arrow button now sit on the overflowing edge.

import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const navigateSpy = vi.fn();
vi.mock("@/lib/hashNavigate", () => ({ hashNavigate: (...a: any[]) => navigateSpy(...a), hashReplace: vi.fn() }));
vi.mock("@/hooks/useProfileScope", () => ({
  useProfileScope: () => ({ mode: "everyone", selectedIds: [], selectedNames: [], isFiltered: false }),
  profileScopeParam: () => "",
}));
vi.mock("@/lib/showTestData", () => ({ useShowTestData: () => false }));

let clipped = false;
vi.mock("@/hooks/useOverflowX", () => ({ useOverflowX: () => [{ current: null }, clipped] }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn(), BROWSER_TIMEZONE: "UTC" }));

const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "UTC" });
const TASKS = [
  { id: "t1", title: "Overdue one", status: "todo", dueDate: "2020-01-01" },
  { id: "t2", title: "Overdue two", status: "todo", dueDate: "2020-01-02" },
  { id: "t3", title: "Today", status: "todo", dueDate: TODAY },
  { id: "t4", title: "Undated", status: "todo", dueDate: null },
  { id: "t5", title: "Done", status: "done", dueDate: "2020-01-01", completedAt: new Date().toISOString() },
  // Hidden by the default "hide test data" rule on the card — and so here.
  { id: "t6", title: "TEST task please ignore", status: "todo", dueDate: "2020-01-03" },
];

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: any) => {
    const endpoint = String(queryKey?.[0] ?? "");
    if (endpoint === "/api/tasks") return { data: TASKS, isPending: false };
    if (endpoint === "/api/dashboard-enhanced") {
      // The stale snapshot the chip used to trust: 5 late.
      return { data: { expiringDocuments: [], overdueTasks: [1, 2, 3, 4, 5], financeSnapshot: {} }, isPending: false };
    }
    if (endpoint === "/api/stats") return { data: { activeTasks: 9, streaks: [] }, isPending: false };
    return { data: [], isPending: false };
  },
}));

vi.mock("@/components/dashboard/BriefingPopups", () => ({
  DocsPopup: () => <div data-testid="docs-popup" />,
}));

import { HubKpiStrip } from "../client/src/components/hub/HubKpiStrip";
import { isTestDataRow } from "../shared/test-data";

beforeEach(() => { navigateSpy.mockClear(); clipped = false; });
afterEach(() => cleanup());

describe("BUG-10 — TASKS DUE reads the same rows as the Tasks card", () => {
  it("shows the /api/tasks count, not the stale stats snapshot", () => {
    render(<HubKpiStrip />);
    const chip = screen.getByTestId("hub-kpi-tasks");
    const testHidden = isTestDataRow("TEST task please ignore") ? 1 : 0;
    // Open tasks (2 overdue + today + undated), minus the test row when the
    // shared detector hides it — exactly the card's "Remaining".
    const remaining = 4 + (1 - testHidden);
    const late = 2 + (1 - testHidden);
    expect(chip.textContent).toContain(String(remaining));
    expect(chip.textContent).toContain(`${late} late`);
    expect(chip.textContent).not.toContain("9");
    expect(chip.textContent).not.toContain("5 late");
  });
});

describe("BUG-28 — a clipped strip shows an overflow affordance", () => {
  it("renders no arrows when everything fits", () => {
    render(<HubKpiStrip />);
    expect(screen.queryByTestId("hub-kpi-scroll-right")).toBeNull();
    expect(screen.getByTestId("hub-kpi-strip").getAttribute("data-clipped")).toBe("false");
  });
  it("renders the right-edge fade and arrow when chips are cut off", () => {
    clipped = true;
    render(<HubKpiStrip />);
    // jsdom reports scrollWidth 0, so the hook's answer alone drives this; the
    // edge state starts at "atEnd" only after a real measurement, which jsdom
    // cannot make — so we assert the affordance wiring through the attribute
    // and the button's presence once the edge state is not at the end.
    const strip = screen.getByTestId("hub-kpi-strip");
    expect(strip.getAttribute("data-clipped")).toBe("true");
    Object.defineProperty(strip, "scrollWidth", { value: 1200, configurable: true });
    Object.defineProperty(strip, "clientWidth", { value: 600, configurable: true });
    fireEvent.scroll(strip, { target: { scrollLeft: 0 } });
    expect(screen.getByTestId("hub-kpi-scroll-right")).toBeTruthy();
    expect(screen.getByTestId("hub-kpi-fade-right")).toBeTruthy();
    expect(screen.queryByTestId("hub-kpi-scroll-left")).toBeNull();
  });
});
