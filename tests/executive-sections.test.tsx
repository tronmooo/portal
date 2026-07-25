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

describe("ExecutiveBriefing — eight blocks", () => {
  const stats: any = {
    monthlySpend: 2200, journalStreak: 7,
    streaks: [{ name: "Meditation", days: 12 }],
    recentActivity: [],
  };
  const enhanced: any = {
    financeSnapshot: {
      upcomingBills: [{ id: "b1", name: "Phone", amount: 86.5, daysUntil: 0, status: "due_today" }],
      totalAssetValue: 412000, totalLiabilities: 180000,
      totalMonthlySpend: 2200, monthlyObligationTotal: 1800,
    },
    expiringDocuments: [{ documentId: "d1", name: "Passport", expirationDate: "2026-10-01", daysUntil: 85 }],
  };
  const render8 = () =>
    wrap(<ExecutiveBriefingCmp filterMode="everyone" filterIds={[]} stats={stats} enhanced={enhanced} />);
  let ExecutiveBriefingCmp: any;
  beforeAll(async () => {
    ExecutiveBriefingCmp = (await import("../client/src/components/dashboard/ExecutiveBriefing")).ExecutiveBriefing;
  });

  it("always renders Today and Quick Capture", () => {
    render8();
    // Blocks 3 and 8 render unconditionally per the spec's render rules.
    expect(screen.getByTestId("block-today")).toBeTruthy();
    expect(screen.getByTestId("block-capture")).toBeTruthy();
  });

  it("does NOT render its own Pulse — the hub strip is block 1", () => {
    // components/hub/HubKpiStrip is pinned above every hub tab including this
    // one. A second strip here stacked the same four numbers twice; see
    // tests/hub-kpi-strip.test.ts.
    render8();
    expect(screen.queryByTestId("block-pulse")).toBeNull();
    expect(screen.queryByTestId("pulse-net-worth")).toBeNull();
  });

  it("renders Next 14 Days collapsed, and expands it on tap", () => {
    render8();
    const block = screen.getByTestId("block-next14");
    const header = block.querySelector("button[aria-expanded]") as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  it("hides Open Projects at zero and rolls it into the All clear line", async () => {
    render8();
    expect(screen.queryByTestId("block-projects")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("all-clear")).toBeTruthy());
    expect(screen.getByTestId("all-clear").textContent).toContain("Open Projects");
  });

  it("shows the bill due today in Needs Attention, not in Money", async () => {
    render8();
    await waitFor(() => expect(screen.getByTestId("block-attention")).toBeTruthy());
    expect(screen.getByTestId("block-attention").textContent).toContain("Phone");
    // Money hides at zero here: the only bill was claimed by Needs Attention.
    expect(screen.queryByTestId("block-money")).toBeNull();
  });

  it("puts one synthesis line inside Today instead of a standalone AI brief", async () => {
    render8();
    await waitFor(() => expect(screen.getByTestId("today-synthesis")).toBeTruthy());
    const line = screen.getByTestId("today-synthesis").textContent || "";
    expect(line.length).toBeGreaterThan(0);
    // It lives INSIDE Today, not as its own card.
    expect(screen.getByTestId("block-today").contains(screen.getByTestId("today-synthesis"))).toBe(true);
  });

  it("renders one row per datum in the DOM, not one per block", async () => {
    // The regression guard for the original bug: this bill previously rendered
    // in Bills & Obligations, in Calendar · Next 14d, in the AI Executive Brief
    // and on the Attention tile at the same time.
    const { container } = render8();
    await waitFor(() => expect(screen.getByTestId("block-attention")).toBeTruthy());
    const rows = Array.from(container.querySelectorAll('[data-testid^="brief-row-"]'));
    const phoneRows = rows.filter(r => (r.textContent || "").includes("Phone"));
    expect(phoneRows).toHaveLength(1);
    // Row keys are the model's dedup identity, so uniqueness in the DOM is the
    // same property the model guarantees.
    const keys = rows.map(r => r.getAttribute("data-testid"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("cuts Notifications and Recently Added from the board entirely", () => {
    const { container } = render8();
    const text = container.textContent || "";
    expect(text).not.toContain("Notifications");
    expect(text).not.toContain("Recently Added");
  });

  it("offers Quick Capture as a one-tap input", () => {
    render8();
    const input = screen.getByTestId("capture-input") as HTMLInputElement;
    const save = screen.getByTestId("capture-save") as HTMLButtonElement;
    // Nothing typed yet — saving is inert rather than posting an empty note.
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "Remember the milk" } });
    expect(save.disabled).toBe(false);
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
