// @vitest-environment jsdom
//
// Runtime proof for the Executive command-center sections. The no-backend dev
// server defaults the profile filter to "Everyone" (HouseholdDashboard branch)
// and never enters the section-grid path, so this jsdom mount is where we
// actually exercise the new sections with live React + providers.
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
// and "Alerts") cannot come back.
//
// 2026-10-21: Needs Attention is documents, renewals and deadlines. Bills live
// in the Money card (overdue first, two-tap Pay), overdue tasks in the Tasks
// card, and the Documents card is the library (counts + recently added) — so
// an expiring document is listed once, under Needs Attention.
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

  it("keeps bills out of Needs Attention: an overdue bill leads the Money card instead", async () => {
    await mount(enhancedWith());
    const attn = screen.getByTestId("exec-card-attention");
    expect(attn.textContent).toContain("Documents, renewals & deadlines");
    expect(attn.textContent).not.toContain("Phone");
    expect(screen.queryByTestId("exec-item-bill:b1")).toBeNull();
    const money = screen.getByTestId("exec-card-money");
    const row = screen.getByTestId("exec-money-bill-b1");
    expect(money.contains(row)).toBe(true);
    expect(row.textContent).toContain("Phone");
    expect(row.textContent).toContain("2d overdue");
    expect(money.textContent).toContain("1 overdue");
  });

  it("lists an expiring document once — under Needs Attention — and the Documents card counts it", async () => {
    await mount(enhancedWith());
    const attn = screen.getByTestId("exec-card-attention");
    expect(attn.textContent).toContain("Passport");
    // Grouped by urgency: 12 days out is "This month".
    expect(screen.getByTestId("exec-attention-band-month")).toBeTruthy();
    // The Documents card is the library now: counts, not a second list.
    const docs = screen.getByTestId("exec-card-documents");
    expect(docs.textContent).not.toContain("Passport");
    expect(screen.getByTestId("exec-docs-count-soon").textContent).toContain("1");
    expect(screen.getByTestId("exec-docs-count-expired").textContent).toContain("0");
  });

  it("shows the most recently added documents in the Documents card", async () => {
    stubRoutes({
      "/api/documents": [{ id: "dr1", name: "Lease agreement", type: "lease", createdAt: new Date().toISOString() }],
    });
    await mount(enhancedWith());
    await waitFor(() => expect(screen.getByTestId("exec-docs-recent-dr1").textContent).toContain("Lease agreement"));
  });

  it("keeps overdue tasks and bill alerts out of Needs Attention", async () => {
    const past = (() => { const d = new Date(); d.setDate(d.getDate() - 3); return d.toLocaleDateString("en-CA"); })();
    stubRoutes({
      "/api/tasks": [
        { id: "t-late", title: "Renew gym badge", status: "open", dueDate: past },
        { id: "t-later", title: "Someday thing", status: "open" },
      ],
      "/api/notifications": [
        { id: "n-bill", type: "bill_due", title: "Water bill overdue", severity: "critical", entityType: "obligation", entityId: "ob-x" },
        { id: "n-custom", type: "custom", title: "Call the insurer about the claim", severity: "warning" },
      ],
    });
    await mount(enhancedWith());
    await waitFor(() => expect(screen.getByTestId("exec-card-tasks").textContent).toContain("Renew gym badge"));
    const attn = screen.getByTestId("exec-card-attention").textContent || "";
    expect(attn).not.toContain("Renew gym badge");
    expect(attn).not.toContain("Water bill overdue");
    // A real alert that isn't about a bill or task still belongs here.
    await waitFor(() => expect(screen.getByTestId("exec-card-attention").textContent).toContain("Call the insurer"));
    // The Tasks card lists the overdue task first, marked overdue.
    const tasks = screen.getByTestId("exec-card-tasks").textContent || "";
    expect(tasks.indexOf("Renew gym badge")).toBeLessThan(tasks.indexOf("Someday thing"));
    expect(tasks).toContain("Overdue");
  });

  it("never names an event that already happened today as Next Important", async () => {
    const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
    stubRoutes({
      "/api/calendar/timeline": [
        // 00:00 has passed by the time this runs (it counts as past from 00:01).
        { id: "ev-am", type: "event", title: "Midnight check", date: inDays(0), time: "00:00", sourceId: "ev-am", linkedProfiles: [] },
        { id: "ev-later", type: "event", title: "Dentist visit", date: inDays(2), time: "10:00", sourceId: "ev-later", linkedProfiles: [] },
      ],
    });
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    await waitFor(() => expect(screen.getByTestId("exec-kpi-next").textContent).toContain("Dentist visit"));
    expect(screen.getByTestId("exec-kpi-next").textContent).not.toContain("Midnight check");
  });

  it("Upcoming: tasks within 30 days, a filter by kind, and a tap lands on that task", async () => {
    const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
    stubRoutes({
      "/api/tasks": [
        { id: "t-soon", title: "Submit expense report", status: "todo", dueDate: inDays(3), tags: [] },
        // 9 days out: counted under the Tasks popup's Upcoming tab, and it
        // used to be missing here (the panel only looked 7 days ahead).
        { id: "t-far", title: "Book flights for June", status: "todo", dueDate: inDays(9), tags: [] },
      ],
      "/api/calendar/timeline": [
        { id: "ev-1", type: "event", title: "Team offsite", date: inDays(5), time: "09:00", sourceId: "ev-1", linkedProfiles: [] },
      ],
    });
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    fireEvent.click(screen.getByTestId("exec-view-upcoming"));
    const dlg = await screen.findByTestId("upcoming-popup");
    await waitFor(() => expect(dlg.textContent).toContain("Book flights for June"));
    expect(dlg.textContent).toContain("Team offsite");
    // Filter to tasks only.
    fireEvent.click(screen.getByTestId("upcoming-filter-tasks"));
    expect(screen.getByTestId("upcoming-popup").textContent).not.toContain("Team offsite");
    expect(screen.getByTestId("upcoming-popup").textContent).toContain("Submit expense report");
    // Tapping a task opens Tasks on the Upcoming tab with that task open.
    fireEvent.click(within(screen.getByTestId("upcoming-popup")).getByTestId("exec-item-task:t-far"));
    await screen.findByTestId("popup-tasks");
    await waitFor(() => expect(screen.getByTestId("task-detail-t-far")).toBeTruthy());
    expect(screen.getByTestId("task-tab-upcoming").getAttribute("aria-selected")).toBe("true");
  });

  it("shows each record in exactly one place on the tab", async () => {
    stubRoutes({
      "/api/calendar/timeline": [
        { id: "ev-b1", type: "event", title: "Mom's Birthday", date: (() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toLocaleDateString("en-CA"); })(),
          allDay: true, sourceId: "ev-b1", linkedProfiles: [], meta: { kind: "birthday", recurrence: "yearly" } },
      ],
    });
    await mount(enhancedWith({
      financeSnapshot: { upcomingBills: [
        { id: "b1", name: "Phone", amount: 86.5, daysUntil: -2, status: "overdue" },
        { id: "b2", name: "Internet", amount: 60, daysUntil: 4, status: "upcoming" },
      ] },
    }));
    await waitFor(() => expect(screen.getByTestId("exec-important-dates").textContent).toContain("Mom's Birthday"));
    const ids = Array.from(document.querySelectorAll("[data-testid^='exec-item-'], [data-testid^='exec-money-bill-']"))
      .map((el) => el.getAttribute("data-testid")!.replace(/^exec-money-bill-/, "exec-item-bill:"));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    // The upcoming bill is Money's, not also the Upcoming card's.
    expect(screen.getByTestId("exec-card-upcoming").textContent).not.toContain("Internet");
  });

  it("opens the Bills popup — stats, filters, expandable rows — from a bill row", async () => {
    await mount(enhancedWith());
    // Tapping a bill row anywhere on the tab opens the Bills drill-down.
    fireEvent.click(screen.getByTestId("exec-money-bill-b1"));
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
    // Every bill — overdue first — sits in the Money card; none in Needs Attention.
    const money = screen.getByTestId("exec-card-money").textContent || "";
    expect(money).toContain("rent the 1st");
    expect(money).toContain("$300");
    expect(money.indexOf("rent the 1st")).toBeLessThan(money.indexOf("$300"));
    expect(screen.getByTestId("exec-card-attention").textContent).not.toContain("rent the 1st");
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
    // Occasions live in Schedule's Important dates block — the one place on
    // the tab that answers "when is it actually happening".
    await waitFor(() => {
      expect(screen.getByTestId("exec-important-dates").textContent).toContain("Maya's Graduation");
    });
    const dates = screen.getByTestId("exec-important-dates");
    expect(dates.textContent).toContain("Mom's Birthday");
    // Writable occurrence → Done. A profile-derived date is read-only — its
    // sourceId is not an event id, so offering Done would PATCH into a 404.
    expect(screen.getByTestId("exec-action-event:ev-rd-1").textContent).toContain("Done");
    expect(screen.queryByTestId("exec-action-event:ev-bd-1")).toBeNull();
  });

  // Requested 2026-09-22: "there should be a place in the executive tab that
  // displays all these important dates … in the schedule place … birthdays
  // etc. … and when things are about to expire."
  describe("Schedule · Important dates", () => {
    const soon = (n: number) => {
      const d = new Date(); d.setDate(d.getDate() + n);
      return d.toLocaleDateString("en-CA");
    };

    it("lists birthdays and occasions, soonest first, inside Schedule — expirations are Needs Attention's", async () => {
      stubRoutes({
        "/api/calendar/timeline": [
          { id: "ev-b2", type: "event", title: "Dad's Birthday", date: soon(20), allDay: true,
            sourceId: "ev-b2", linkedProfiles: [], meta: { kind: "birthday", recurrence: "yearly" } },
          { id: "ev-b1", type: "event", title: "Mom's Birthday", date: soon(3), allDay: true,
            sourceId: "ev-b1", linkedProfiles: [], meta: { kind: "birthday", recurrence: "yearly" } },
        ],
      });
      await mount(enhancedWith());
      const block = await screen.findByTestId("exec-important-dates");
      await waitFor(() => expect(block.textContent).toContain("Mom's Birthday"));
      // Expirations moved to Needs Attention (2026-10-21) — listed once.
      expect(block.textContent).not.toContain("Passport");
      expect(screen.getByTestId("exec-card-attention").textContent).toContain("Passport");
      expect(block.textContent).toContain("Dad's Birthday");
      // Soonest first: Mom (3d) before Dad (20d).
      const order = ["Mom's Birthday", "Dad's Birthday"]
        .map((t) => block.textContent!.indexOf(t));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // It sits in the Schedule card, not in a card of its own.
      expect(screen.getByTestId("exec-card-schedule").contains(block)).toBe(true);
    });

    it("says how the list splits, so the week you must act on is legible", async () => {
      stubRoutes({
        "/api/calendar/timeline": [
          { id: "ev-b1", type: "event", title: "Mom's Birthday", date: soon(3), allDay: true,
            sourceId: "ev-b1", linkedProfiles: [], meta: { kind: "birthday", recurrence: "yearly" } },
          { id: "ev-b2", type: "event", title: "Dad's Birthday", date: soon(20), allDay: true,
            sourceId: "ev-b2", linkedProfiles: [], meta: { kind: "birthday", recurrence: "yearly" } },
        ],
      });
      await mount(enhancedWith());
      await waitFor(() => {
        // Mom (3d) is inside the week; Dad (20d) is not.
        expect(screen.getByTestId("exec-important-dates-note").textContent)
          .toBe("1 in the next 7 days · 1 more within 45");
      });
    });

    it("is present and explains itself when there is nothing coming up", async () => {
      await mount(enhancedWith({ expiringDocuments: [] }));
      const block = await screen.findByTestId("exec-important-dates");
      expect(block.textContent).toContain("Dates to remember");
      // One empty state for the whole card, not one per block.
      expect(block.textContent).toContain("Nothing today, and no birthdays or occasions in the next 45 days.");
      expect(screen.queryByTestId("exec-schedule-empty")).toBeNull();
      expect(screen.getByTestId("exec-card-schedule").textContent).not.toContain("Nothing scheduled today.");
    });

    it("does not also render the same date in the Upcoming card", async () => {
      stubRoutes({
        "/api/calendar/timeline": [
          { id: "ev-b1", type: "event", title: "Mom's Birthday", date: soon(3), allDay: true,
            sourceId: "ev-b1", linkedProfiles: [], meta: { kind: "birthday", recurrence: "yearly" } },
        ],
      });
      await mount(enhancedWith());
      await waitFor(() => {
        expect(screen.getByTestId("exec-important-dates").textContent).toContain("Mom's Birthday");
      });
      expect(screen.getByTestId("exec-card-upcoming").textContent).not.toContain("Mom's Birthday");
      // One row, one testid — the duplicate is what made the DOM ambiguous.
      expect(screen.getAllByTestId("exec-item-event:ev-b1")).toHaveLength(1);
      // "View all upcoming" is still the COMPLETE list, because the KPI above
      // it opens the same panel and names its first row.
      fireEvent.click(screen.getByTestId("exec-view-upcoming"));
      const dlg = await screen.findByTestId("upcoming-popup");
      expect(dlg.textContent).toContain("Mom's Birthday");
    });
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
    // QA 2026-09-18 BUG-06: the advice renders INSIDE the Needs Attention
    // card (where the button is), not in a tenth card below the fold.
    const recs = await screen.findByTestId("exec-recommendations");
    expect(screen.getByTestId("exec-card-attention").contains(recs)).toBe(true);
    expect(recs.textContent).toContain("Link 3 documents");
    expect(recs.textContent).toContain("They have no profile.");
    expect(recs.textContent.toLowerCase()).toContain("high");
    expect(asked()).toBe(1);

    // Each row dismisses on its own; the header Dismiss clears the panel.
    fireEvent.click(screen.getByTestId("exec-recommendation-dismiss-0"));
    expect(screen.queryByTestId("exec-recommendation-0")).toBeNull();
    fireEvent.click(screen.getByTestId("exec-recommendations-dismiss-all"));
    expect(screen.queryByTestId("exec-recommendations")).toBeNull();
  });

  it("BUG-06: a bare array or {items} response still renders the advice", async () => {
    stubRoutes({
      "/api/dashboard/ai-suggestions": [{ title: "Resolve four overdue tasks", priority: "medium", body: "They are piling up." }],
    });
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    fireEvent.click(screen.getByTestId("exec-recommendations-generate"));
    const recs = await screen.findByTestId("exec-recommendations");
    expect(recs.textContent).toContain("Resolve four overdue tasks");
  });

  it("surfaces recent activity in the bottom card", async () => {
    await mount(enhancedWith(), {
      recentActivity: [
        { id: "a1", type: "expense", description: "Logged $4 coffee", timestamp: new Date().toISOString() },
      ],
    });
    expect(screen.getByTestId("exec-card-activity").textContent).toContain("Logged $4 coffee");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE ROUTING RULE (user report 2026-08-13): pressing a summary expands it
  // over Executive in that category's ONE canonical panel. The label pressed
  // must match the panel that opens — no Bills when pressing an important
  // date, no Finance page when pressing Tasks — and closing it must leave the
  // user on Executive.
  describe("every press opens its own category's canonical panel, in place", () => {
    const opened = () => document.querySelector('[role="dialog"]')?.textContent || "";

    it("Tasks — the KPI and the card header open the Tasks panel, not the Finance page", async () => {
      await mount(enhancedWith());
      fireEvent.click(screen.getByTestId("exec-kpi-tasks"));
      expect(opened()).toContain("Task");
      // Still on Executive underneath — the tab was never navigated away.
      expect(screen.getByTestId("executive-briefing")).toBeTruthy();
      expect(screen.getByTestId("exec-card-tasks")).toBeTruthy();
    });

    it("Next Important — opens the Upcoming dates, never the Bills panel", async () => {
      await mount(enhancedWith());
      fireEvent.click(screen.getByTestId("exec-kpi-next"));
      const dlg = await screen.findByTestId("upcoming-popup");
      expect(dlg.textContent).toContain("Upcoming");
      // The bill that used to hijack this press is not the panel's subject.
      expect(screen.queryByTestId("bills-popup")).toBeNull();
    });

    it("View all upcoming — expands the same list the card previews", async () => {
      await mount(enhancedWith());
      fireEvent.click(screen.getByTestId("exec-view-upcoming"));
      const dlg = await screen.findByTestId("upcoming-popup");
      // Passport (12d out) is on the card and in the expansion — same dataset.
      expect(dlg.textContent).toContain("Passport");
      expect(screen.getByTestId("executive-briefing")).toBeTruthy();
    });

    it("View wellness — opens the Wellness panel over Executive, not the Wellness tab", async () => {
      stubRoutes({
        "/api/trackers": [{
          id: "tr1", name: "Steps", category: "Fitness", unit: "steps",
          fields: [{ name: "count", type: "number", isPrimary: true, unit: "steps" }],
          entries: [{ timestamp: new Date().toISOString(), values: { count: 7420 } }],
        }],
      });
      await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
      fireEvent.click(await screen.findByTestId("exec-view-wellness"));
      expect(await screen.findByTestId("wellness-popup-score")).toBeTruthy();
      expect(screen.getByTestId("executive-briefing")).toBeTruthy();
    });

    it("a wellness tile opens that metric's own Wellness popup", async () => {
      stubRoutes({
        "/api/trackers": [{
          id: "tr2", name: "Sleep", category: "Health", unit: "h",
          fields: [{ name: "hours", type: "number", isPrimary: true, unit: "h" }],
          entries: [{ timestamp: new Date().toISOString(), values: { hours: 6.9 } }],
        }],
      });
      await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
      fireEvent.click(await screen.findByTestId("exec-well-sleep"));
      expect(await screen.findByTestId("wellness-popup-sleep")).toBeTruthy();
    });

    it("Documents — the card opens the Documents panel, not a document page", async () => {
      await mount(enhancedWith());
      fireEvent.click(screen.getByTestId("exec-view-documents"));
      expect(opened()).toContain("Passport");
      expect(screen.getByTestId("executive-briefing")).toBeTruthy();
    });

    it("Bills — a bill row opens Bills, and Bills only", async () => {
      await mount(enhancedWith());
      fireEvent.click(screen.getByTestId("exec-money-bill-b1"));
      expect(await screen.findByTestId("bills-popup")).toBeTruthy();
      expect(screen.queryByTestId("upcoming-popup")).toBeNull();
    });

    it("closing a panel returns to Executive with the tab intact", async () => {
      await mount(enhancedWith());
      fireEvent.click(screen.getByTestId("exec-view-upcoming"));
      const dlg = await screen.findByTestId("upcoming-popup");
      fireEvent.keyDown(dlg, { key: "Escape", code: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("upcoming-popup")).toBeNull());
      expect(screen.getByTestId("exec-card-upcoming")).toBeTruthy();
      expect(screen.getByTestId("exec-overview")).toBeTruthy();
    });
  });

  it("opens the filters, and the urgency setting applies to documents", async () => {
    stubRoutes({ "/api/preferences/attention_prefs": { value: null } });
    await mount(enhancedWith());
    expect(screen.getByTestId("exec-card-attention").textContent).toContain("Passport");
    expect(screen.queryByTestId("attention-filters")).toBeNull();
    fireEvent.click(screen.getByTestId("attention-filters-toggle"));
    expect(screen.getByTestId("attention-filters")).toBeTruthy();
    // The switches that no longer change this card are gone.
    expect(screen.queryByTestId("attention-toggle-habits")).toBeNull();
    // "Immediate only" hides a passport 12 days out — it used to stay.
    fireEvent.click(screen.getByTestId("attention-tier-immediate"));
    await waitFor(() => expect(screen.getByTestId("exec-card-attention").textContent).not.toContain("Passport"));
    expect(screen.getByTestId("attention-tier-immediate").getAttribute("aria-pressed")).toBe("true");
  });
});
