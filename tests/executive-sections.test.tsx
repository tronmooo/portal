// @vitest-environment jsdom
//
// Runtime proof for the Executive command-center sections. The no-backend dev
// server defaults the profile filter to "Everyone" (HouseholdDashboard branch)
// and never enters the section-grid path, so this jsdom mount is where we
// actually exercise the new sections with live React + providers.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
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

describe("ExecutiveBriefing", () => {
  const stats: any = { recentActivity: [{ id: "a1", type: "habit", description: "Completed Workout", timestamp: new Date().toISOString() }] };
  const enhanced: any = {
    financeSnapshot: { upcomingBills: [{ id: "b1", name: "Phone", amount: 86.5, daysUntil: 0, status: "due_today" }] },
    expiringDocuments: [{ documentId: "d1", name: "Passport", expirationDate: "2026-10-01", daysUntil: 85 }],
  };

  it("renders the five deduplicated sections and four tiles", async () => {
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={stats} enhanced={enhanced} />);

    // Five sections, down from seventeen. The removed ids (brief-agenda,
    // brief-overdue, brief-priority, brief-birthdays, brief-appointments,
    // brief-dates, brief-calendar, brief-ai, …) were all views of these.
    for (const id of ["brief-attention", "brief-today", "brief-next14", "brief-open", "brief-recent"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
    // Four tiles, down from six: the Attention tile counted the section right
    // below it, and Bills + Documents merged into Obligations.
    expect(screen.getByTestId("brief-stat-row")).toBeTruthy();
    for (const id of ["brief-stat-today", "brief-stat-tasks", "brief-stat-obligations", "brief-stat-habits"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }

    // The bill due today surfaces on the Obligations tile once queries settle.
    await waitFor(() => {
      expect(screen.getByTestId("brief-stat-obligations").textContent).not.toContain("loading");
    });
    const obTxt = screen.getByTestId("brief-stat-obligations").textContent || "";
    expect(obTxt).toContain("Phone");
    // Zero habits must NOT read "all done" — nothing is scheduled.
    expect(screen.getByTestId("brief-stat-habits").textContent).toContain("No habits scheduled");

    // The bill is an attention item; the 85-day document is open work, not
    // attention — and neither is rendered in both.
    expect(screen.getByTestId("brief-attention").textContent).toContain("Phone");
    expect(screen.getByTestId("brief-open").textContent).toContain("Passport");
    expect(screen.getByTestId("brief-open").textContent).not.toContain("Phone");
  });

  it("renders one row per datum in the DOM, not one per section", async () => {
    // The regression guard for the original bug: this bill previously rendered
    // in Bills & Obligations, in Calendar · Next 14d, in the AI Executive Brief
    // and on the Attention tile at the same time.
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    const { container } = wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={stats} enhanced={enhanced} />);
    await waitFor(() => {
      expect(screen.getByTestId("brief-stat-obligations").textContent).not.toContain("loading");
    });
    const rows = Array.from(container.querySelectorAll('[data-testid^="brief-row-"]'));
    const phoneRows = rows.filter(r => (r.textContent || "").includes("Phone"));
    expect(phoneRows).toHaveLength(1);
    // Row keys are the model's dedup identity, so uniqueness in the DOM is the
    // same property the model guarantees.
    const keys = rows.map(r => r.getAttribute("data-testid"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("collapses a section on header click", async () => {
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={stats} enhanced={enhanced} />);
    const header = screen.getByTestId("brief-attention").querySelector("button[aria-expanded]") as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
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
