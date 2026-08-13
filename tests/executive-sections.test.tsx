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
    for (const k of ["expense", "income", "bill", "note", "task"]) {
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
// The Executive tab — the command center (2026-08-13 redesign).
//
// Overview bar (Net Worth · Cash Flow · Tasks Remaining · Next Important),
// then the card grid (Needs Attention | Tasks | Schedule | Habits | Money |
// Documents | Wellness | Upcoming) with Recent Activity full-width at the
// bottom. Records are still routed by shared/executive-sections.ts, so the
// duplication the 2026-07-29 report showed (a task under both "Overdue tasks"
// and "Alerts") cannot come back — with ONE deliberate exception: an expiring
// document appears under Needs Attention (urgency) AND Documents (inventory),
// exactly as the reference mock draws it.
// ─────────────────────────────────────────────────────────────────────────────
describe("ExecutiveBriefing", () => {
  const enhancedWith = (over: any = {}) => ({
    financeSnapshot: { upcomingBills: [{ id: "b1", name: "Phone", amount: 86.5, daysUntil: -2, status: "overdue" }] },
    expiringDocuments: [{ documentId: "d1", name: "Passport", documentName: "Passport", daysUntil: 12 }],
    ...over,
  });

  async function mount(enhanced: any, stats: any = {}) {
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} stats={stats} enhanced={enhanced} />);
    // The card grid replaces the skeletons once the feeding queries settle.
    await waitFor(() => {
      expect(screen.getByTestId("exec-card-attention")).toBeTruthy();
    });
  }

  it("renders the overview bar, every card, and none of the old board", async () => {
    await mount(enhancedWith());

    // The overview bar: four KPIs.
    expect(screen.getByTestId("exec-overview")).toBeTruthy();
    for (const id of ["exec-kpi-networth", "exec-kpi-cashflow", "exec-kpi-tasks", "exec-kpi-next"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }

    // The card grid, with Recent Activity present at the bottom.
    for (const id of [
      "exec-card-attention", "exec-card-tasks", "exec-card-schedule", "exec-card-habits",
      "exec-card-money", "exec-card-documents", "exec-card-wellness", "exec-card-upcoming",
      "exec-card-activity",
    ]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }

    // The old surfaces are gone — the tile row, the AI brief bubble, the
    // sections feed, and every section of the board before that.
    for (const id of [
      "brief-stat-row", "brief-stat-attention", "brief-ai", "exec-sections",
      "brief-agenda", "brief-overdue", "brief-tasks", "brief-priority", "brief-habits",
      "brief-reminders", "brief-birthdays", "brief-appointments", "brief-dates",
      "brief-docs", "brief-bills", "brief-calendar", "brief-notifications",
      "brief-projects", "brief-activity", "brief-notes", "brief-today-card",
      "attention-feed",
    ]) {
      expect(screen.queryByTestId(id), `${id} should no longer render`).toBeNull();
    }
  });

  it("puts an overdue bill in Needs Attention with its amount", async () => {
    await mount(enhancedWith());
    const attn = screen.getByTestId("exec-card-attention");
    expect(attn.textContent).toContain("Phone");
    expect(attn.textContent).toContain("$87 overdue");
  });

  it("shows an expiring document under Needs Attention AND in the Documents card", async () => {
    await mount(enhancedWith());
    // Inventory: the Documents card, with its expiry countdown.
    const docs = screen.getByTestId("exec-card-documents");
    expect(docs.textContent).toContain("Passport");
    expect(docs.textContent).toContain("Expires in 12 days");
    // Urgency: the same document surfaces in Needs Attention, as in the mock.
    expect(screen.getByTestId("exec-card-attention").textContent).toContain("Passport");
  });

  it("opens the Bills popup — stats, filters, expandable rows — from a bill row", async () => {
    await mount(enhancedWith());
    // Tapping a bill row anywhere on the tab opens the Bills drill-down.
    fireEvent.click(screen.getByTestId("exec-item-bill:b1"));
    expect(await screen.findByTestId("bills-popup")).toBeTruthy();
    // The mock's four headline stats.
    for (const id of ["bills-stat-total", "bills-stat-soon", "bills-stat-overdue", "bills-stat-paid"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
    // Filter chips narrow the list; the overdue Phone bill stays visible under
    // Overdue, and pressing its row reveals the detail card with real actions.
    fireEvent.click(screen.getByTestId("bills-filter-overdue"));
    fireEvent.click(screen.getByTestId("bill-row-b1"));
    expect(screen.getByTestId("popup-pay-b1")).toBeTruthy();
    expect(screen.getByTestId("popup-edit-b1")).toBeTruthy();
    // The footer offers Add Bill and the full Bills page.
    expect(screen.getByTestId("bills-add")).toBeTruthy();
    expect(screen.getByTestId("bills-view-all")).toBeTruthy();
  });

  it("offers a one-tap action on a row, and arms a payment before taking it", async () => {
    await mount(enhancedWith());
    const pay = screen.getByTestId("exec-action-bill:b1");
    expect(pay.textContent).toContain("Pay");
    // Money moves on the second tap, never the first.
    fireEvent.click(pay);
    expect(screen.getByTestId("exec-action-bill:b1").textContent).toContain("Confirm");
  });

  it("shows a real all-clear when nothing needs attention", async () => {
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    // Encouraging, not blank — the empty state is a designed surface.
    expect(screen.getByTestId("exec-attention-clear").textContent).toContain("You're all caught up");
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
    const all = screen.getByTestId("executive-briefing").textContent || "";
    // Hide-test-data defaults ON — the QA subscription must not render.
    expect(all).not.toContain("QA Test Subscription");
    // Same-amount name-nested pair renders once, keeping the specific name.
    expect((all.match(/Phone Bill payment/g) || []).length).toBe(1);
    expect(all).toContain("Verizon Phone Bill payment");
    // Different amounts ($2,500 vs $300) are NOT collapsed — user must reconcile.
    expect(all).toContain("rent the 1st");
    expect(all).toContain("$300");
    // Overdue ones sit under Needs Attention; the merely-upcoming one under
    // Money's "Bills Due Soon".
    expect(screen.getByTestId("exec-card-attention").textContent).toContain("rent the 1st");
    expect(screen.getByTestId("exec-card-money").textContent).toContain("$300");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Mounted for real against stubbed endpoints. `routes` lets a test answer
  // specific endpoints while everything else stays an empty list.
  function stubRoutes(routes: Record<string, any>) {
    fetchStub.mockImplementation(async (url: any, opts?: any) => {
      const u = String(url);
      const hit = Object.keys(routes).find(k => u.includes(k));
      const body = hit ? (typeof routes[hit] === "function" ? routes[hit](u, opts) : routes[hit]) : [];
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
  }
  const today = () => new Date().toLocaleDateString("en-CA");

  it("renders a due medication under Needs Attention, with Taken rather than Pay", async () => {
    stubRoutes({
      "/api/obligations": [{
        id: "o1", name: "Lisinopril 10mg", kind: "medication",
        status: "active", nextDueDate: today(), payments: [],
      }],
    });
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    await waitFor(() => {
      expect(screen.getByTestId("exec-card-attention").textContent).toContain("Lisinopril 10mg");
    });
    expect(screen.getByTestId("exec-action-med:o1").textContent).toContain("Taken");
  });

  it("completes a task from its circle in the Tasks card", async () => {
    stubRoutes({
      "/api/tasks": (u: string, opts: any) =>
        opts?.method === "PATCH" ? {} : [{ id: "t1", title: "Call mechanic", status: "open", dueDate: today() }],
    });
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    const circle = await screen.findByTestId("exec-task-complete-t1");
    // The card counts it as remaining before the tap.
    expect(screen.getByTestId("exec-card-tasks").textContent).toContain("Call mechanic");
    fireEvent.click(circle);
    await waitFor(() => {
      const patched = fetchStub.mock.calls.some((c: any[]) =>
        String(c[0]).includes("/api/tasks/t1") && c[1]?.method === "PATCH");
      expect(patched).toBe(true);
    });
  });

  it("shows a Done button on a managed recurring date, but none on a profile birthday", async () => {
    const soon = (n: number) => {
      const d = new Date(); d.setDate(d.getDate() + n);
      return d.toLocaleDateString("en-CA");
    };
    stubRoutes({
      "/api/calendar/timeline": [
        {
          id: "ev-rd-1", type: "event", title: "Maya's Graduation", date: soon(3),
          allDay: true, sourceId: "ev1", linkedProfiles: [],
          meta: { tags: ["rdate", "rd:kind:custom"] },
        },
        {
          id: "ev-bd-1", type: "event", title: "Mom's Birthday", date: soon(4),
          allDay: true, sourceId: "profile:p1:birthday", linkedProfiles: [],
          meta: { kind: "birthday", recurrence: "yearly" },
        },
      ],
    });
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    await waitFor(() => {
      expect(screen.getByTestId("exec-card-upcoming").textContent).toContain("Maya's Graduation");
    });
    const upcoming = screen.getByTestId("exec-card-upcoming");
    expect(upcoming.textContent).toContain("Mom's Birthday");
    // Writable occurrence → Done. A profile-derived date is read-only — its
    // sourceId is not an event id, so offering Done would PATCH into a 404.
    expect(screen.getByTestId("exec-action-event:ev-rd-1").textContent).toContain("Done");
    expect(screen.queryByTestId("exec-action-event:ev-bd-1")).toBeNull();
  });

  it("never asks for AI advice on mount, and renders it only once asked", async () => {
    stubRoutes({
      "/api/dashboard/ai-suggestions": {
        suggestions: [{ title: "Link 3 documents", body: "They have no profile.", action: "Link", priority: "high" }],
      },
    });
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });

    // Generating advice is a model call — a dashboard open must not be one.
    const asked = () => fetchStub.mock.calls.filter((c: any[]) => String(c[0]).includes("ai-suggestions")).length;
    expect(asked()).toBe(0);
    expect(screen.queryByTestId("exec-card-recommendations")).toBeNull();

    fireEvent.click(screen.getByTestId("exec-recommendations-generate"));
    const recs = await screen.findByTestId("exec-card-recommendations");
    expect(recs.textContent).toContain("Link 3 documents");
    expect(asked()).toBe(1);
  });

  it("surfaces recent activity in the bottom card", async () => {
    await mount(enhancedWith(), {
      recentActivity: [
        { id: "a1", type: "expense", description: "Logged $4 coffee", timestamp: new Date().toISOString() },
      ],
    });
    expect(screen.getByTestId("exec-card-activity").textContent).toContain("Logged $4 coffee");
  });

  it("opens the filters and lets a whole source be switched off", async () => {
    await mount(enhancedWith());
    expect(screen.queryByTestId("attention-filters")).toBeNull();
    fireEvent.click(screen.getByTestId("attention-filters-toggle"));
    expect(screen.getByTestId("attention-filters")).toBeTruthy();
    const habits = screen.getByTestId("attention-toggle-habits");
    expect(habits.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(habits);
    expect(screen.getByTestId("attention-toggle-habits").getAttribute("aria-checked")).toBe("false");
  });
});
