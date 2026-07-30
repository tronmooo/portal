// @vitest-environment jsdom
//
// Runtime proof for the Executive command-center sections. The no-backend dev
// server defaults the profile filter to "Everyone" (HouseholdDashboard branch)
// and never enters the section-grid path, so this jsdom mount is where we
// actually exercise the new sections with live React + providers.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// These mount real components that fetch on mount. Without a stub each render
// fires a dozen real `window.fetch` calls into a backendless jsdom, and those
// rejections land wherever the event loop happens to be — which is how an
// unrelated test file that asserts on `fetch.mock.calls[0]` starts failing
// under load. Answer every request with an empty list so the mounts are
// hermetic and nothing outlives the test.
let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchStub = vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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


// ─────────────────────────────────────────────────────────────────────────────
// The Executive tab — an attention center, not a board.
//
// It used to render 17 collapsible sections and a Today strip, and the same
// record could appear in several of them at once. These assert the shape the
// 2026-07-29 report asked for: context tiles, a one-glance brief, and ONE
// ranked feed where every row is a distinct thing to act on.
// ─────────────────────────────────────────────────────────────────────────────
describe("ExecutiveBriefing", () => {
  const enhancedWith = (over: any = {}) => ({
    financeSnapshot: { upcomingBills: [{ id: "b1", name: "Phone", amount: 86.5, daysUntil: 0, status: "due_today" }] },
    expiringDocuments: [{ documentId: "d1", name: "Passport", documentName: "Passport", expirationDate: "2026-10-01", daysUntil: 85 }],
    ...over,
  });

  async function mount(enhanced: any, stats: any = {}) {
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={stats} enhanced={enhanced} />);
    // The tiles settle out of their loading placeholder once `enhanced` lands.
    await waitFor(() => {
      expect(screen.getByTestId("brief-stat-attention").textContent).not.toContain("loading");
    });
  }

  it("renders the tiles, the brief, and one feed — and none of the old sections", async () => {
    await mount(enhancedWith());

    // Context layer survives: six tiles, unchanged testids.
    expect(screen.getByTestId("brief-stat-row")).toBeTruthy();
    for (const id of ["brief-stat-attention", "brief-stat-tasks", "brief-stat-events", "brief-stat-bills", "brief-stat-documents", "brief-stat-habits"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
    expect(screen.getByTestId("brief-ai")).toBeTruthy();
    expect(screen.getByTestId("attention-feed")).toBeTruthy();

    // The board is gone. Every one of these used to render on this tab and
    // restated something that already lives on Calendar / Tasks / Habits /
    // Documents / Bills / Goals / Journal.
    for (const id of [
      "brief-agenda", "brief-overdue", "brief-tasks", "brief-priority", "brief-habits",
      "brief-reminders", "brief-birthdays", "brief-appointments", "brief-dates",
      "brief-docs", "brief-bills", "brief-calendar", "brief-notifications",
      "brief-projects", "brief-activity", "brief-notes", "brief-today-card",
    ]) {
      expect(screen.queryByTestId(id), `${id} should no longer render`).toBeNull();
    }
  });

  it("the bill due today reaches the feed and the Attention tile agrees with it", async () => {
    await mount(enhancedWith());
    const attn = screen.getByTestId("brief-stat-attention").textContent || "";
    expect(attn).toContain("1");
    expect(attn).toContain("bill due today");
    // …and the same single item is what the feed shows.
    expect(screen.getByTestId("attention-item-bill:b1")).toBeTruthy();
    expect(screen.getByTestId("attention-item-bill:b1").textContent).toContain("Phone");
    expect(screen.getByTestId("attention-item-bill:b1").textContent).toContain("$87 due today");
  });

  it("groups by urgency with collapsible headers", async () => {
    await mount(enhancedWith());
    const group = screen.getByTestId("attention-group-immediate");
    const header = group.querySelector("button[aria-expanded]") as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("offers a one-tap action on every row, and arms a payment before taking it", async () => {
    await mount(enhancedWith());
    const pay = screen.getByTestId("attention-action-bill:b1");
    expect(pay.textContent).toContain("Pay");
    // Money moves on the second tap, never the first.
    fireEvent.click(pay);
    expect(screen.getByTestId("attention-action-bill:b1").textContent).toContain("Confirm");
  });

  it("shows a real all-clear when nothing needs attention", async () => {
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    expect(screen.getByTestId("attention-feed").textContent).toContain("Nothing needs your attention");
    expect(screen.getByTestId("brief-stat-attention").textContent).toContain("Nothing needs review");
  });

  it("hides QA bills and collapses the duplicate-bill pair (2026-07-29 report)", async () => {
    await mount(enhancedWith({
      financeSnapshot: { upcomingBills: [
        { id: "b1", name: "Verizon Phone Bill payment", amount: 86.5, daysUntil: -3, status: "overdue" },
        { id: "b2", name: "Phone Bill payment", amount: 86.5, daysUntil: -3, status: "overdue" },
        { id: "b3", name: "QA Test Subscription", amount: 15.99, daysUntil: 5, status: "upcoming" },
        { id: "b4", name: "rent the 1st", amount: 2500, daysUntil: -28, status: "overdue" },
        { id: "b5", name: "rent", amount: 300, daysUntil: 3, status: "upcoming" },
      ] },
      expiringDocuments: [],
    }));
    const feed = screen.getByTestId("attention-feed").textContent || "";
    // Hide-test-data defaults ON — the QA subscription must not render.
    expect(feed).not.toContain("QA Test Subscription");
    // Same-amount name-nested pair renders once, keeping the specific name.
    expect((feed.match(/Phone Bill payment/g) || []).length).toBe(1);
    expect(feed).toContain("Verizon Phone Bill payment");
    // Different amounts ($2,500 vs $300) are NOT collapsed — user must reconcile.
    expect(feed).toContain("rent the 1st");
    expect(feed).toContain("$300");
  });

  it("keeps the lead brief bullet honest about bills, and never says 'due in -28d'", async () => {
    await mount(enhancedWith({
      financeSnapshot: { upcomingBills: [
        { id: "b4", name: "rent the 1st", amount: 2500, daysUntil: -28, status: "overdue" },
      ] },
      expiringDocuments: [],
    }));
    const ai = screen.getByTestId("brief-ai").textContent || "";
    // Lead bullet may not claim "No overdue tasks." while bills are overdue.
    expect(ai).toContain("No overdue to-do tasks");
    // The -28d bill reads as overdue, never "due in -28d".
    expect(ai).toContain("28d overdue");
    expect(ai).not.toMatch(/due in -/);
  });

  it("opens the filters and lets a whole source be switched off", async () => {
    await mount(enhancedWith());
    expect(screen.queryByTestId("attention-filters")).toBeNull();
    fireEvent.click(screen.getByTestId("attention-filters-toggle"));
    const filters = screen.getByTestId("attention-filters");
    expect(filters).toBeTruthy();
    const habits = screen.getByTestId("attention-toggle-habits");
    expect(habits.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(habits);
    expect(screen.getByTestId("attention-toggle-habits").getAttribute("aria-checked")).toBe("false");
  });
});
