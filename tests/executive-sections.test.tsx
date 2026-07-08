// @vitest-environment jsdom
//
// Runtime proof for the Executive command-center sections. The no-backend dev
// server defaults the profile filter to "Everyone" (HouseholdDashboard branch)
// and never enters the section-grid path, so this jsdom mount is where we
// actually exercise the new sections with live React + providers.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
