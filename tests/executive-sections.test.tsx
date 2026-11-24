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
import { WeeklySummarySection } from "../client/src/pages/dashboard";

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
const ALL_CARDS = JSON.stringify({ value: JSON.stringify({ quiet: false, hidden: [], order: [] }) });
beforeEach(() => {
  // Quiet mode is the default (2026-11-22) and hides half the cards. These
  // suites describe every card, so they run with it switched off unless a
  // test answers the preference itself.
  fetchStub = vi.fn(async (url: any) => new Response(
    String(url).includes("/api/preferences/exec_card_prefs") ? ALL_CARDS : "[]",
    { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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
    // 2026-11-22: the server sends each bill at its NEXT date (an elapsed date
    // is assumed paid), and the timeline its panel renders.
    financeSnapshot: {
      upcomingBills: [{ id: "b1", name: "Phone", amount: 86.5, daysUntil: 2, status: "upcoming" }],
      billsTimeline: {
        upcoming: [{ key: "b1:next", billId: "b1", name: "Phone", amount: 86.5, date: "2099-01-03", daysUntil: 2,
          frequency: "monthly", category: "utilities", kind: "bill", autopay: false, linkedLiabilityId: "b1", state: "upcoming" }],
        past: [],
      },
    },
    expiringDocuments: [{ documentId: "d1", name: "Passport", documentName: "Passport", daysUntil: 12 }],
    ...over,
  });

  /** The Bills & Payments rows the Money card lists (shared/bills-timeline). */
  const timelineOf = (bills: Array<{ id: string; name: string; amount: number; daysUntil: number }>) => ({
    upcoming: bills.filter((b) => b.daysUntil >= 0).map((b) => ({ key: `${b.id}:next`, billId: b.id, name: b.name, amount: b.amount,
      date: "2099-01-01", daysUntil: b.daysUntil, frequency: "monthly", category: "general", kind: "bill", autopay: false, linkedLiabilityId: b.id, state: "upcoming" })),
    past: [],
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

    // The cards that always render: they hold controls or figures.
    for (const id of ["exec-card-attention", "exec-card-money", "exec-card-documents"]) {
      expect(screen.getByTestId(id), id).toBeTruthy();
    }
    // 2026-11-22 (owner): "collapse empty sections automatically". A card
    // with nothing to show is one chip in the quiet row, not half a screen —
    // and a tap opens it in place, so nothing is out of reach.
    // (A card folds once its own data has loaded — never while it is pending.)
    await waitFor(() => { expect(screen.getByTestId("exec-quiet-tasks")).toBeTruthy(); expect(screen.getByTestId("exec-quiet-schedule")).toBeTruthy(); });
    const quiet = screen.getByTestId("exec-quiet-cards");
    for (const id of ["tasks", "schedule", "habits", "wellness", "activity"]) {
      expect(within(quiet).getByTestId(`exec-quiet-${id}`), id).toBeTruthy();
      expect(screen.queryByTestId(`exec-card-${id}`), id).toBeNull();
    }
    fireEvent.click(screen.getByTestId("exec-quiet-habits"));
    expect(screen.getByTestId("exec-card-habits").textContent).toContain("No habits scheduled today.");
    expect(screen.queryByTestId("exec-quiet-habits")).toBeNull();
    // Schedule and Upcoming are one Timeline card now.
    expect(screen.queryByTestId("exec-card-upcoming")).toBeNull();

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

  // 2026-11-22 (owner): "Show the next scheduled payments, not an accumulating
  // backlog of old bill occurrences." The Money card lists what is coming.
  it("keeps bills out of Needs Attention: the Money card lists the next payment, with no overdue backlog", async () => {
    await mount(enhancedWith());
    const attn = screen.getByTestId("exec-card-attention");
    expect(attn.textContent).toContain("Expirations & renewals");
    expect(attn.textContent).not.toContain("Phone");
    expect(screen.queryByTestId("exec-item-bill:b1")).toBeNull();
    const money = screen.getByTestId("exec-card-money");
    const row = screen.getByTestId("exec-money-bill-b1");
    expect(money.contains(row)).toBe(true);
    expect(row.textContent).toContain("Phone");
    expect(row.textContent).toMatch(/Due [A-Z][a-z]{2} \d{1,2}/);
    expect(money.textContent).toContain("Upcoming payments");
    expect(money.textContent).not.toMatch(/overdue/i);
  });

  it("never shows a months-old occurrence, even from a payload that still carries one", async () => {
    const bills = [
      { id: "old", name: "Spotify Premium", amount: 11, daysUntil: -115, status: "overdue" },
      { id: "next", name: "Netflix", amount: 9.99, daysUntil: 9, status: "upcoming" },
    ];
    await mount(enhancedWith({
      financeSnapshot: { upcomingBills: bills, billsTimeline: timelineOf(bills) },
    }));
    const money = screen.getByTestId("exec-card-money");
    expect(screen.getByTestId("exec-money-bill-next").textContent).toContain("Netflix");
    expect(screen.queryByTestId("exec-money-bill-old")).toBeNull();
    expect(money.textContent).not.toMatch(/overdue/i);
    expect(screen.getByTestId("exec-view-bills").textContent).toBe("View all bills");
  });

  it("lists an expiring document once — under Needs Attention — and the Documents card counts it", async () => {
    await mount(enhancedWith());
    const attn = screen.getByTestId("exec-card-attention");
    expect(attn.textContent).toContain("Passport");
    // Its date sits in a pill beside it (the reference screenshot's "Dec 28"),
    // and the card's badge counts it.
    const pill = screen.getAllByTestId(/^exec-item-pill-/);
    expect(pill).toHaveLength(1);
    expect(pill[0].textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(screen.getByTestId("exec-card-count-attention").textContent).toBe("1");
    // The Documents card is the library now: counts, not a second list.
    const docs = screen.getByTestId("exec-card-documents");
    expect(docs.textContent).not.toContain("Passport");
    expect(screen.getByTestId("exec-docs-count-soon").textContent).toContain("1");
    // 2026-11-22: what has expired is Needs Attention's alone — the Documents
    // card no longer repeats it as a tile or a caption.
    expect(screen.queryByTestId("exec-docs-count-expired")).toBeNull();
    expect(docs.textContent).not.toContain("Needs Attention");
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
    // 2026-11-21 (owner): Needs Attention is expirations only — a free-form
    // alert lives in the bell, not here.
    await waitFor(() => expect(fetchStub.mock.calls.some((c: any[]) => String(c[0]).includes("/api/notifications"))).toBe(true));
    expect(screen.getByTestId("exec-card-attention").textContent).not.toContain("Call the insurer");
    // The Tasks card lists the overdue task first, marked overdue.
    const tasks = screen.getByTestId("exec-card-tasks").textContent || "";
    expect(tasks.indexOf("Renew gym badge")).toBeLessThan(tasks.indexOf("Someday thing"));
    expect(tasks).toContain("Overdue");
  });

  // 2026-11-21 (owner): "make everything smaller so it fits … a more
  // truncated view so I can see everything at a glance". A card lists its
  // first rows and says how many it is holding back; the rest is one tap away.
  it("at a glance: a long task list shows three rows and a link to the rest", async () => {
    stubRoutes({
      "/api/tasks": ["One", "Two", "Three", "Four", "Five"].map((n, i) => (
        { id: `t-${i}`, title: `Task ${n}`, status: "todo", tags: [] })),
    });
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    const card = screen.getByTestId("exec-card-tasks");
    await waitFor(() => expect(card.textContent).toContain("Task One"));
    expect(card.querySelectorAll("[data-testid^='exec-task-complete-']")).toHaveLength(3);
    // The count above the list is still the whole list, not the three shown.
    expect(card.textContent).toContain("5Remaining");
    const more = screen.getByTestId("exec-tasks-more");
    expect(more.textContent).toContain("2 more tasks");
    fireEvent.click(more);
    await screen.findByTestId("popup-tasks");
  });

  it("at a glance: Recent Activity is a card of the grid, and the page menu sits in the top bar", async () => {
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="everyone" filterIds={[]} enhanced={enhancedWith()}
      stats={{ recentActivity: [{ id: "a1", type: "task", description: "Completed: Call mechanic", timestamp: new Date().toISOString() }] }}
      overviewEnd={<button data-testid="page-menu">menu</button>} />);
    const activity = await screen.findByTestId("exec-card-activity");
    expect(activity.parentElement!.className).toContain("exec-grid");
    expect(screen.getByTestId("exec-card-attention").parentElement).toBe(activity.parentElement);
    // Beside the overview cells, in the same bar — not a row of its own.
    expect(screen.getByTestId("exec-overview").parentElement!.contains(screen.getByTestId("page-menu"))).toBe(true);
  });

  // 2026-11-21 (owner): "I want the mobile view to be affected". A phone
  // shows the cards two to a row; the three that need the width take a full
  // row, and the half cards are ordered so each has a partner.
  it("phone layout: two columns, half cards paired, wide cards on their own row", async () => {
    await mount(enhancedWith());
    // Open every folded card so the whole layout is on screen.
    for (const id of ["tasks", "schedule", "habits", "wellness", "activity"]) fireEvent.click(await screen.findByTestId(`exec-quiet-${id}`));
    const grid = screen.getByTestId("exec-card-attention").parentElement!;
    expect(grid.className).toMatch(/(^| )grid-cols-2( |$)/);
    const cls = (id: string) => screen.getByTestId(`exec-card-${id}`).className;
    // The Timeline carries today AND what is coming, so it takes the full row.
    const wides = ["schedule", "money", "habits", "activity"];
    for (const id of wides) {
      expect(cls(id), id).toContain("col-span-2");
      expect(cls(id), id).not.toContain("exec-half");
    }
    const halves = ["attention", "tasks", "documents", "wellness"];
    for (const id of halves) expect(cls(id), id).toContain("exec-half");
    const order = (id: string) => Number(/(?:^| )order-(\d)(?: |$)/.exec(cls(id))![1]);
    // Attention + Tasks, then Timeline, Money, Habits, then Documents + Wellness, then Activity.
    expect(halves.map(order)).toEqual([1, 2, 6, 7]);
    expect(wides.map(order)).toEqual([3, 4, 5, 8]);
    // From 768px the source order applies again.
    for (const id of [...halves, ...wides]) expect(cls(id)).toContain("md:order-none");
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
    await waitFor(() => expect(screen.getByTestId("exec-timeline-coming").textContent).toContain("Mom's Birthday"));
    const ids = Array.from(document.querySelectorAll("[data-testid^='exec-item-'], [data-testid^='exec-money-bill-']"))
      .map((el) => el.getAttribute("data-testid")!.replace(/^exec-money-bill-/, "exec-item-bill:"));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    // The upcoming bill is Money's, not also the Timeline's.
    expect(screen.getByTestId("exec-card-schedule").textContent).not.toContain("Internet");
  });

  it("opens Bills & Payments — the Finance tab's panel — from a bill row", async () => {
    await mount(enhancedWith());
    fireEvent.click(screen.getByTestId("exec-money-bill-b1"));
    const panel = await screen.findByTestId("popup-bills");
    // Upcoming and past payments, from the server's timeline.
    expect(within(panel).getByTestId("bills-timeline").textContent).toContain("Phone");
    // No Pay button anywhere in it: a row opens the bill.
    expect(panel.querySelector('[data-testid^="popup-pay-"]')).toBeNull();
    expect(panel.textContent).not.toMatch(/overdue/i);
  });

  it("a bill row is information, not a button: no Pay on the Money card", async () => {
    await mount(enhancedWith());
    expect(screen.getByTestId("exec-money-bill-b1")).toBeTruthy();
    expect(screen.queryByTestId("exec-action-bill:b1")).toBeNull();
    expect(screen.getByTestId("exec-card-money").querySelector('[data-testid^="exec-action-bill:"]')).toBeNull();
  });

  // 2026-11-22 (owner): "Money only shows income, expenses, and negative cash
  // flow — show financial position."
  it("Money leads with what you own, what you owe and net worth, from the snapshot", async () => {
    await mount(enhancedWith({
      financeSnapshot: { upcomingBills: [], totalAssetValue: 48200, totalLiabilities: 13050 },
    }));
    const pos = screen.getByTestId("exec-money-position");
    expect(screen.getByTestId("exec-card-money").contains(pos)).toBe(true);
    expect(screen.getByTestId("exec-money-assets").textContent).toContain("$48,200");
    expect(screen.getByTestId("exec-money-debt").textContent).toContain("$13,050");
    // One source (Rule 1): assets minus debt, the figure the overview tile shows.
    expect(screen.getByTestId("exec-money-networth").textContent).toContain("$35,150");
    // It sits above this month's income / expenses / cash flow.
    const month = screen.getByTestId("exec-money-month");
    expect(pos.compareDocumentPosition(month) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and opens the Net Worth panel, in place.
    fireEvent.click(screen.getByTestId("exec-money-networth"));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  });

  it("a card with something to show is never folded away", async () => {
    stubRoutes({ "/api/tasks": [{ id: "t1", title: "Call mechanic", status: "todo", dueDate: today() }] });
    await mount(enhancedWith());
    await waitFor(() => expect(screen.getByTestId("exec-card-tasks").textContent).toContain("Call mechanic"));
    expect(screen.queryByTestId("exec-quiet-tasks")).toBeNull();
  });

  it("the quiet row says a profile filter may be why a list is empty (Rule 4)", async () => {
    const { ExecutiveBriefing } = await import("../client/src/components/dashboard/ExecutiveBriefing");
    wrap(<ExecutiveBriefing filterMode="selected" filterIds={["p1"]} stats={{}} enhanced={enhancedWith()} />);
    const note = await screen.findByTestId("exec-quiet-scope");
    expect(note.textContent).toContain("hidden, not deleted");
    cleanup();
    // With everyone showing there is no filter to mention.
    await mount(enhancedWith());
    await screen.findByTestId("exec-quiet-cards");
    expect(screen.queryByTestId("exec-quiet-scope")).toBeNull();
  });

  // ── Customize (2026-11-22, owner: "Give people control over how much they
  // see … My default would be Quiet Mode enabled") ──────────────────────────
  describe("Customize: quiet mode, hidden cards and order", () => {
    const prefsRoute = (stored: { value: string | null }) => (_u: string, opts: any) => {
      if (opts?.method === "PUT") { stored.value = JSON.parse(opts.body).value; return { success: true }; }
      return { value: stored.value };
    };
    const TASKS = [{ id: "t1", title: "Call mechanic", status: "todo", dueDate: today() }];
    const cardIds = () => Array.from(document.querySelectorAll('[data-testid^="exec-card-"]'))
      .map((n) => n.getAttribute("data-testid")!).filter((id) => /^exec-card-[a-z]+$/.test(id)).map((id) => id.replace("exec-card-", ""));

    it("quiet mode is the default: attention, tasks, timeline and money — the rest named, one tap away", async () => {
      const stored = { value: null as string | null };
      stubRoutes({ "/api/preferences/exec_card_prefs": prefsRoute(stored), "/api/tasks": TASKS });
      await mount(enhancedWith());
      await waitFor(() => expect(screen.getByTestId("exec-card-tasks")).toBeTruthy());
      expect(cardIds().sort()).toEqual(["attention", "money", "tasks"]); // Timeline has nothing → folded
      expect(screen.getByTestId("exec-quiet-schedule")).toBeTruthy();
      // Hidden is not gone: each hidden card is named and opens on a tap.
      const hidden = screen.getByTestId("exec-hidden-cards");
      expect(hidden.textContent).toContain("Quiet mode is on");
      for (const id of ["habits", "documents", "wellness", "activity"]) expect(within(hidden).getByTestId(`exec-hidden-${id}`)).toBeTruthy();
      fireEvent.click(screen.getByTestId("exec-hidden-documents"));
      expect(screen.getByTestId("exec-card-documents")).toBeTruthy();
      // Looking wrote nothing (Rule 3).
      expect(stored.value).toBeNull();
    });

    // 2026-11-22 (owner): "at the bottom, the customization shouldn't be there.
    // It should be at the top right" — the ⋮ menu's Customize opens the dialog
    // (tests/exec-customize-dialog.dom.test.tsx). The tab only APPLIES the
    // saved choice.
    it("has no Customize control at the bottom of the tab", async () => {
      const stored = { value: null as string | null };
      stubRoutes({ "/api/preferences/exec_card_prefs": prefsRoute(stored), "/api/tasks": TASKS });
      await mount(enhancedWith());
      await waitFor(() => expect(screen.getByTestId("exec-card-tasks")).toBeTruthy());
      expect(screen.queryByTestId("exec-customize-toggle")).toBeNull();
      expect(screen.queryByTestId("exec-customize")).toBeNull();
      expect(screen.getByTestId("executive-briefing").textContent).not.toMatch(/Customize/);
    });

    it("applies a saved choice: a hidden card is off the tab and named under it", async () => {
      const stored = { value: JSON.stringify({ quiet: false, hidden: ["money"], order: [] }) as string | null };
      stubRoutes({ "/api/preferences/exec_card_prefs": prefsRoute(stored), "/api/tasks": TASKS });
      await mount(enhancedWith());
      await waitFor(() => expect(screen.getByTestId("exec-card-tasks")).toBeTruthy());
      expect(screen.queryByTestId("exec-card-money")).toBeNull();
      expect(screen.getByTestId("exec-hidden-cards").textContent).toContain("Hidden by you:");
      expect(screen.getByTestId("exec-hidden-money")).toBeTruthy();
    });

    it("applies a saved order and sizes to the grid", async () => {
      const stored = { value: JSON.stringify({ quiet: false, hidden: [], order: ["money", "attention"], sizes: { tasks: "large", money: "medium" } }) as string | null };
      stubRoutes({ "/api/preferences/exec_card_prefs": prefsRoute(stored), "/api/tasks": TASKS });
      await mount(enhancedWith());
      await waitFor(() => expect(screen.getByTestId("exec-card-tasks")).toBeTruthy());
      const card = (id: string) => screen.getByTestId(`exec-card-${id}`) as HTMLElement;
      expect(card("money").style.order).toBe("1");
      expect(card("attention").style.order).toBe("2");
      expect(card("tasks").style.order).toBe("3");
      // Large takes the full row at every width; Medium is one column.
      expect(card("tasks").className).toMatch(/(^| )col-span-2( |$)/);
      expect(card("tasks").className).not.toContain("md:col-span-1");
      expect(card("money").className).toContain("exec-half");
      // A card with no size picked keeps the built-in layout.
      expect(card("attention").className).toContain("exec-half");
    });

    it("draws a card the user built, from their own records, and it shows in quiet mode too", async () => {
      const stored = { value: JSON.stringify({ quiet: true, hidden: [], order: [], widgets: [
        { id: "journal", title: "Recent Journal", icon: "book", source: "journal", limit: 3 },
      ] }) as string | null };
      stubRoutes({
        "/api/preferences/exec_card_prefs": prefsRoute(stored), "/api/tasks": TASKS,
        "/api/journal": [{ id: "j1", date: today(), title: "A good day at the lake", content: "…", mood: "good", tags: [], createdAt: new Date().toISOString() }],
      });
      await mount(enhancedWith());
      const card = await screen.findByTestId("exec-card-w-journal");
      await waitFor(() => expect(card.textContent).toContain("A good day at the lake"));
      expect(card.textContent).toContain("Recent Journal");
      // Quiet mode still trims the built-in cards.
      expect(screen.queryByTestId("exec-card-documents")).toBeNull();
    });

    // 2026-11-22 (owner): "different customizations for different types of
    // executive dashboards". The tab shows the active one and lets you switch.
    it("with several dashboards, the tab shows the active one and switches on a tap, saving the choice", async () => {
      const stored = { value: JSON.stringify({ v: 2, active: "main", widgets: [],
        dashboards: [
          { id: "main", name: "Main", quiet: true, hidden: [], order: [], sizes: {} },
          { id: "all", name: "Everything", quiet: false, hidden: ["money"], order: [], sizes: {} },
        ] }) as string | null };
      stubRoutes({ "/api/preferences/exec_card_prefs": prefsRoute(stored), "/api/tasks": TASKS });
      await mount(enhancedWith());
      await waitFor(() => expect(screen.getByTestId("exec-card-tasks")).toBeTruthy());
      const bar = screen.getByTestId("exec-dashboards");
      expect(within(bar).getAllByRole("tab").map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([["Main", "true"], ["Everything", "false"]]);
      expect(screen.getByTestId("exec-card-money")).toBeTruthy();
      expect(screen.queryByTestId("exec-card-documents")).toBeNull();
      fireEvent.click(screen.getByTestId("exec-dashboard-all"));
      await waitFor(() => expect(screen.getByTestId("exec-card-documents")).toBeTruthy());
      expect(screen.queryByTestId("exec-card-money")).toBeNull(); // hidden on that dashboard
      await waitFor(() => expect(JSON.parse(stored.value!).active).toBe("all"));
      // Only which one is showing changed; both layouts are as they were.
      expect(JSON.parse(stored.value!).dashboards.map((d: any) => d.hidden)).toEqual([[], ["money"]]);
    });

    it("a medium card with nobody beside it takes the whole row on a phone; paired ones stay half", async () => {
      const widget = (id: string, title: string) => ({ id, title, icon: "book", source: "journal", limit: 2 });
      const stored = { value: JSON.stringify({ quiet: false, hidden: ["tasks", "schedule", "habits", "documents", "wellness", "activity"],
        order: ["money", "attention", "w:a", "w:b", "w:c"], sizes: {}, widgets: [widget("a", "Card A"), widget("b", "Card B"), widget("c", "Card C")] }) as string | null };
      stubRoutes({ "/api/preferences/exec_card_prefs": prefsRoute(stored) });
      await mount(enhancedWith());
      const cls = async (id: string) => (await screen.findByTestId(`exec-card-${id}`)).className;
      // Money is large; Attention pairs with A; B pairs with C: nobody is alone.
      for (const id of ["attention", "w-a", "w-b", "w-c"]) expect(await cls(id), id).toContain("exec-half");
      cleanup();
      // Without C, B has no partner and fills its row.
      stored.value = JSON.stringify({ ...JSON.parse(stored.value!), widgets: [widget("a", "Card A"), widget("b", "Card B")], order: ["money", "attention", "w:a", "w:b"] });
      await mount(enhancedWith());
      expect(await cls("w-b")).toContain("col-span-2 md:col-span-1");
      expect(await cls("w-a")).toContain("exec-half");
    });

    it("with one dashboard there is no switcher", async () => {
      const stored = { value: null as string | null };
      stubRoutes({ "/api/preferences/exec_card_prefs": prefsRoute(stored), "/api/tasks": TASKS });
      await mount(enhancedWith());
      await waitFor(() => expect(screen.getByTestId("exec-card-tasks")).toBeTruthy());
      expect(screen.queryByTestId("exec-dashboards")).toBeNull();
    });

    it("a custom card that cannot load says so, with a retry — never 'nothing here'", async () => {
      const stored = { value: JSON.stringify({ quiet: true, hidden: [], order: [], widgets: [
        { id: "journal", title: "Recent Journal", icon: "book", source: "journal", limit: 3 },
      ] }) as string | null };
      fetchStub.mockImplementation(async (url: any, opts?: any) => {
        const u = String(url);
        if (u.includes("/api/journal")) return new Response(JSON.stringify({ error: "down" }), { status: 500, headers: { "Content-Type": "application/json" } });
        const body = u.includes("/api/preferences/exec_card_prefs") ? prefsRoute(stored)(u, opts) : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      });
      await mount(enhancedWith());
      await waitFor(() => expect(screen.getByTestId("exec-widget-error-journal")).toBeTruthy(), { timeout: 8000 });
      expect(screen.queryByTestId("exec-widget-empty-journal")).toBeNull();
    });
  });

  it("shows a real all-clear when nothing needs attention", async () => {
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    // Encouraging, not blank — the empty state is a designed surface.
    expect(screen.getByTestId("exec-attention-clear").textContent).toContain("You're all caught up");
  });

  it("hides QA bills and collapses the duplicate-bill pair (2026-07-29 report)", async () => {
    const bills = [
      { id: "b1", name: "Verizon Phone Bill payment", amount: 86.5, daysUntil: 3, status: "upcoming" },
      { id: "b2", name: "Phone Bill payment", amount: 86.5, daysUntil: 3, status: "upcoming" },
      { id: "b3", name: "QA Test Subscription", amount: 15.99, daysUntil: 5, status: "upcoming" },
      { id: "b4", name: "rent the 1st", amount: 2500, daysUntil: 1, status: "upcoming" },
      { id: "b5", name: "rent", amount: 300, daysUntil: 6, status: "upcoming" },
    ];
    await mount(enhancedWith({
      financeSnapshot: { upcomingBills: bills, billsTimeline: timelineOf(bills) },
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
    // Every bill — soonest first — sits in the Money card; none in Needs Attention.
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
      const body = hit ? (typeof routes[hit] === "function" ? routes[hit](u, opts) : routes[hit])
        : u.includes("/api/preferences/exec_card_prefs") ? JSON.parse(ALL_CARDS) : [];
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    });
  }
  const today = () => new Date().toLocaleDateString("en-CA");

  // 2026-11-21 (owner): "I want the needs attention not to include tasks or
  // stuff like that" — a dose due now moved to the Wellness card, Taken intact.
  it("renders a due medication under Wellness (not Needs Attention), with Taken rather than Pay", async () => {
    stubRoutes({
      "/api/obligations": [{
        id: "o1", name: "Lisinopril 10mg", kind: "medication",
        status: "active", nextDueDate: today(), payments: [],
      }],
    });
    await mount({ financeSnapshot: { upcomingBills: [] }, expiringDocuments: [] });
    await waitFor(() => {
      expect(screen.getByTestId("exec-card-wellness").textContent).toContain("Lisinopril 10mg");
    });
    expect(screen.getByTestId("exec-card-attention").textContent).not.toContain("Lisinopril 10mg");
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
    // Occasions live in the Timeline's "Coming up" list — the one place on
    // the tab that answers "when is it actually happening".
    await waitFor(() => {
      expect(screen.getByTestId("exec-timeline-coming").textContent).toContain("Maya's Graduation");
    });
    const dates = screen.getByTestId("exec-timeline-coming");
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
      const block = await screen.findByTestId("exec-timeline-coming");
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

    // 2026-11-22 (owner): "Combine overlapping upcoming information into one
    // useful timeline." A task, an occasion and an appointment are one list
    // in date order — not a "dates" block here and an Upcoming card there.
    it("is ONE list in date order: a task, a birthday and an appointment", async () => {
      stubRoutes({
        "/api/tasks": [{ id: "t1", title: "Call the insurance company", status: "todo", dueDate: soon(1) }],
        "/api/calendar/timeline": [
          { id: "ev-appt", type: "event", title: "Dentist visit", date: soon(10), time: "10:00", sourceId: "ev-appt", linkedProfiles: [] },
          { id: "ev-b1", type: "event", title: "Mom's Birthday", date: soon(3), allDay: true,
            sourceId: "ev-b1", linkedProfiles: [], meta: { kind: "birthday", recurrence: "yearly" } },
        ],
      });
      await mount(enhancedWith());
      const block = await screen.findByTestId("exec-timeline-coming");
      await waitFor(() => expect(block.textContent).toContain("Dentist visit"));
      const at = ["Call the insurance company", "Mom's Birthday", "Dentist visit"].map((t) => block.textContent!.indexOf(t));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(screen.getByTestId("exec-card-schedule").contains(block)).toBe(true);
      expect(screen.queryByTestId("exec-card-upcoming")).toBeNull();
    });

    it("folds away when there is nothing today or coming up, and explains itself when opened", async () => {
      await mount(enhancedWith({ expiringDocuments: [] }));
      await waitFor(() => expect(screen.queryByTestId("exec-card-schedule")).toBeNull());
      fireEvent.click(await screen.findByTestId("exec-quiet-schedule"));
      const card = screen.getByTestId("exec-card-schedule");
      // One empty state for the whole card, not one per block.
      expect(card.textContent).toContain("Your day is clear, and nothing is coming up in the next 30 days.");
      expect(screen.queryByTestId("exec-schedule-empty")).toBeNull();
    });

    it("renders a date once, and View all upcoming still opens the complete list", async () => {
      stubRoutes({
        "/api/calendar/timeline": [
          { id: "ev-b1", type: "event", title: "Mom's Birthday", date: soon(3), allDay: true,
            sourceId: "ev-b1", linkedProfiles: [], meta: { kind: "birthday", recurrence: "yearly" } },
        ],
      });
      await mount(enhancedWith());
      await waitFor(() => {
        expect(screen.getByTestId("exec-timeline-coming").textContent).toContain("Mom's Birthday");
      });
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
      // No open tasks here, so Tasks is folded into the quiet row.
      expect(screen.getByTestId("exec-quiet-tasks")).toBeTruthy();
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
      // Nothing is scheduled here, so the Timeline is folded: open it first.
      fireEvent.click(await screen.findByTestId("exec-quiet-schedule"));
      fireEvent.click(screen.getByTestId("exec-view-upcoming"));
      const dlg = await screen.findByTestId("upcoming-popup");
      // Passport (12d out) is in the complete list, beside whatever the card previews.
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
      expect(await screen.findByTestId("popup-bills")).toBeTruthy();
      expect(screen.queryByTestId("upcoming-popup")).toBeNull();
    });

    it("closing a panel returns to Executive with the tab intact", async () => {
      await mount(enhancedWith());
      fireEvent.click(screen.getByTestId("exec-kpi-next"));
      const dlg = await screen.findByTestId("upcoming-popup");
      fireEvent.keyDown(dlg, { key: "Escape", code: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("upcoming-popup")).toBeNull());
      expect(screen.getByTestId("exec-card-money")).toBeTruthy();
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
