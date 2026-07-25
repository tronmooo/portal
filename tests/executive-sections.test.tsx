// @vitest-environment jsdom
//
// Runtime proof for the Executive command-center sections. The no-backend dev
// server defaults the profile filter to "Everyone" (HouseholdDashboard branch)
// and never enters the section-grid path, so this jsdom mount is where we
// actually exercise the new sections with live React + providers.
import React from "react";
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { QuickActionsSection, WeeklySummarySection } from "../client/src/pages/dashboard";

// Auth is used by WeeklySummarySection.getAuthHeader; stub to a no-op header.
vi.mock("../client/src/lib/auth", () => ({
  useAuth: () => ({ getAuthHeader: () => ({}) }),
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Static-location wouter Router so useLocation works without a real history.
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={() => ["/dashboard", () => {}] as any}>{ui}</Router>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("QuickActionsSection", () => {
  it("renders all five quick-add buttons", () => {
    wrap(<QuickActionsSection filterMode="everyone" filterIds={[]} />);
    for (const k of ["expense", "income", "bill", "note", "reminder"]) {
      expect(screen.getByTestId(`quick-action-${k}`)).toBeTruthy();
    }
  });

  it("opens the quick-add dialog when a button is clicked", () => {
    wrap(<QuickActionsSection filterMode="everyone" filterIds={[]} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    fireEvent.click(screen.getByTestId("quick-action-expense"));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("WeeklySummarySection", () => {
  it("renders the this-week snapshot cells from stats", () => {
    const stats: any = {
      weeklyEntries: 12, activeTasks: 4, journalStreak: 5,
      streaks: [{ name: "Meditation", days: 12 }], habitCompletionRate: 80,
    };
    wrap(<WeeklySummarySection stats={stats} filterIds={[]} />);
    expect(screen.getByTestId("section-weekly-summary")).toBeTruthy();
    const txt = screen.getByTestId("section-weekly-summary").textContent || "";
    expect(txt).toContain("12");   // entries this week
    expect(txt).toContain("12d");  // best streak (max of streaks/journalStreak)
    expect(txt).toContain("80%");  // habit completion
    expect(screen.getByTestId("weekly-generate")).toBeTruthy();
  });

  it("renders nothing without stats", () => {
    const { container } = wrap(<WeeklySummarySection stats={undefined} filterIds={[]} />);
    expect(container.querySelector('[data-testid="section-weekly-summary"]')).toBeNull();
  });
});

describe("ExecutiveBriefing — dense command centre", () => {
  const stats: any = {
    recentActivity: [{ type: "habit", description: "Completed Workout", timestamp: new Date().toISOString() }],
  };
  const enhanced: any = {
    financeSnapshot: { upcomingBills: [{ id: "b1", name: "Phone", amount: 86.5, daysUntil: 0, status: "due_today" }] },
    expiringDocuments: [{ documentId: "d1", name: "Passport", expirationDate: "2026-10-01", daysUntil: 85 }],
  };
  let ExecutiveBriefingCmp: any;
  beforeAll(async () => {
    ExecutiveBriefingCmp = (await import("../client/src/components/dashboard/ExecutiveBriefing")).ExecutiveBriefing;
  });
  const renderBoard = () =>
    wrap(<ExecutiveBriefingCmp filterMode="everyone" filterIds={[]} stats={stats} enhanced={enhanced} />);

  // The reference design is a single scrolling column of colour-coded,
  // collapsible section cards. Every one of these must be on the board.
  const SECTION_IDS = [
    "brief-ai", "brief-agenda", "brief-overdue", "brief-tasks", "brief-priority",
    "brief-habits", "brief-reminders", "brief-birthdays", "brief-appointments",
    "brief-dates", "brief-docs", "brief-bills", "brief-calendar",
    "brief-notifications", "brief-projects", "brief-activity", "brief-notes",
  ];

  it("renders every dense briefing section", () => {
    renderBoard();
    for (const id of SECTION_IDS) expect(screen.getByTestId(id), id).toBeTruthy();
  });

  it("renders the sections in the reference order", () => {
    const { container } = renderBoard();
    const seen = Array.from(container.querySelectorAll("[data-testid^='brief-']"))
      .map(el => el.getAttribute("data-testid")!)
      .filter(id => SECTION_IDS.includes(id));
    expect(seen).toEqual(SECTION_IDS);
  });

  it("stacks to one column on phones and only fans out on wider screens", () => {
    // The screenshots are full-width rows at iPhone width; the multi-column
    // masonry is a md+ affordance, not the mobile layout.
    const { container } = renderBoard();
    const grid = screen.getByTestId("brief-agenda").parentElement!;
    expect(grid.className).toContain("md:columns-2");
    expect(grid.className).not.toMatch(/(^|\s)columns-\d/);
    expect(container.querySelector("[data-testid='brief-stat-row']")!.className).toContain("grid-cols-2");
  });

  it("renders the stat tiles and the full-width Today strip above the sections", () => {
    renderBoard();
    expect(screen.getByTestId("brief-stat-row")).toBeTruthy();
    for (const id of ["brief-stat-attention", "brief-stat-tasks", "brief-stat-events",
                      "brief-stat-bills", "brief-stat-documents", "brief-stat-habits", "brief-today-card"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
  });

  it("surfaces the bill due today on the Attention tile once queries settle", async () => {
    renderBoard();
    await waitFor(() => {
      expect(screen.getByTestId("brief-stat-attention").textContent).not.toContain("loading");
    });
    const attnTxt = screen.getByTestId("brief-stat-attention").textContent || "";
    expect(attnTxt).toContain("1");
    expect(attnTxt).toContain("bill due today");
  });

  it("says nothing is scheduled rather than 'all done' when there are no habits", async () => {
    renderBoard();
    await waitFor(() => {
      expect(screen.getByTestId("brief-stat-habits").textContent).toContain("No habits scheduled");
    });
  });

  it("shows a tile as loading rather than a hard zero while its query is pending", () => {
    // BUG-20260715-everyone-zeros: a wall of 0s reads as "aggregation broke".
    wrap(<ExecutiveBriefingCmp filterMode="everyone" filterIds={[]} stats={undefined} enhanced={undefined} />);
    expect(screen.getByTestId("brief-stat-bills").textContent).toContain("loading");
    expect(screen.getByTestId("brief-stat-documents").textContent).toContain("loading");
  });

  it("renders bill and document rows straight from enhanced data", () => {
    renderBoard();
    expect(screen.getByTestId("brief-bills").textContent).toContain("Phone");
    expect(screen.getByTestId("brief-pay-b1")).toBeTruthy();
    expect(screen.getByTestId("brief-docs").textContent).toContain("Passport");
  });

  it("collapses a section on header click", () => {
    renderBoard();
    const header = screen.getByTestId("brief-bills").querySelector("button[aria-expanded]") as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a row's panel through PopupHost, mounting nothing before the tap", async () => {
    renderBoard();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    fireEvent.click(screen.getByTestId("brief-stat-bills"));
    // Bills and Documents share the Obligations panel; the sub-tab picks the side.
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("panel")).toBe("obligations"));
    expect(new URLSearchParams(window.location.search).get("sub")).toBe("bills");
  });
});

describe("extracted TasksPopup / HabitsPopup still render (regression: 'popups destroyed')", () => {
  it("TasksPopup mounts open with its dialog content", async () => {
    const { TasksPopup } = await import("../client/src/components/dashboard/TaskHabitPopups");
    wrap(<TasksPopup open onClose={() => {}} filterMode="everyone" filterIds={[]} />);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog, "tasks dialog mounts").not.toBeNull();
    expect((dialog!.textContent || "").length).toBeGreaterThan(0);
  });
  it("HabitsPopup mounts open with its dialog content", async () => {
    const { HabitsPopup } = await import("../client/src/components/dashboard/TaskHabitPopups");
    wrap(<HabitsPopup open onClose={() => {}} filterMode="everyone" filterIds={[]} />);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog, "habits dialog mounts").not.toBeNull();
    expect((dialog!.textContent || "").length).toBeGreaterThan(0);
  });
});
