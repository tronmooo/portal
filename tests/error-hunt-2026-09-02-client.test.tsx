// @vitest-environment jsdom
//
// Regression coverage for the 2026-09-02 error-hunting round — CLIENT half,
// component mounts. Item numbers match the audit list; the pure-logic half is
// error-hunt-2026-09-02-client-logic.test.ts.
import React, { useState } from "react";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequest, scope } = vi.hoisted(() => ({
  apiRequest: vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })),
  scope: { mode: "everyone" as string, selectedIds: [] as string[], selectedNames: [] as string[], isFiltered: false },
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, BROWSER_TIMEZONE: "America/Los_Angeles" };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useProfileScope", async () => {
  const actual = await vi.importActual<any>("@/hooks/useProfileScope");
  return { ...actual, useProfileScope: () => scope };
});
vi.mock("wouter", () => ({
  Link: ({ children }: any) => <>{children}</>,
  useLocation: () => ["/", vi.fn()],
}));

import { MoneyOverview } from "../client/src/components/finance/MoneyOverview";
import { BillsDuePopup } from "../client/src/components/finance/MoneyPopups";
import { getRelativeTime } from "../client/src/components/NotificationBell";
import { useResyncedState } from "../client/src/hooks/useResyncedState";
import CalendarManagerPanel from "../client/src/components/CalendarManagerPanel";
import { localTodayISO } from "../client/src/lib/dates";

// recharts' ResponsiveContainer needs ResizeObserver, absent in jsdom.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || ResizeObserverStub;

// A US zone, where a bare "YYYY-MM-DD" read by `new Date()` is the previous
// local evening. Vitest's default TZ (UTC) hides the whole bug class.
beforeAll(() => { process.env.TZ = "America/Los_Angeles"; });
afterEach(cleanup);

// ── Item 3: the Bills Due tile counts the rows the popup shows ──────────────
describe("item 3: Bills Due KPI / card / popup are one list", () => {
  const bills = [
    { id: "b1", name: "Rent", amount: 2400, daysUntil: 3, status: "upcoming", dueDate: "2026-09-05" },
    { id: "b2", name: "Internet", amount: 79, daysUntil: 20, status: "upcoming", dueDate: "2026-09-22" },
    { id: "b3", name: "Water", amount: 40, daysUntil: 28, status: "upcoming", dueDate: "2026-09-30" },
  ];
  const props: any = {
    netWorth: 1, assets: 1, liabilities: 0, momPct: null, nwSeries: [], cashIn: 0, cashOut: 0, spendMtd: 0,
    budgets: [], bills, assetBreakdown: [], liabilityBreakdown: [], monthLabel: "SEP", onPayBill: () => {}, payingId: null,
  };

  it("counts every bill in the 30-day window on the KPI and the card, and names the window", () => {
    render(<MoneyOverview {...props} />);
    expect(screen.getByTestId("money-bills-kpi").textContent).toContain("3");
    const card = screen.getByTestId("money-bills");
    expect(card.querySelectorAll("[data-testid^='money-bill-']")).toHaveLength(3);
    expect(card.textContent).toContain("next 30d");
    expect(card.textContent).not.toContain("14d");
  });

  it("the popup opened from that tile lists the same rows", () => {
    render(<BillsDuePopup open onOpenChange={() => {}} bills={bills as any} onPayBill={() => {}} />);
    expect(screen.getAllByTestId(/^bill-row-/)).toHaveLength(3);
  });
});

// ── Item 2: DueChip shows the stored day, not the UTC-rolled-back one ───────
describe("item 2: DueChip renders the due day the row carries", () => {
  it("a bill due on the 23rd shows 23 / Jul in a US zone", () => {
    render(<BillsDuePopup open onOpenChange={() => {}} onPayBill={() => {}}
      bills={[{ id: "b1", name: "Electric", amount: 140, daysUntil: 3, status: "upcoming", dueDate: "2026-07-23" }] as any} />);
    const row = screen.getByTestId("bill-row-b1");
    expect(row.textContent).toContain("Jul");
    expect(row.textContent).toContain("23");
    expect(row.textContent).not.toContain("22");
  });
});

// ── Item 2: the bell's relative label ───────────────────────────────────────
describe("item 2: NotificationBell relative time is a local-day distance", () => {
  it("a task due today says 'today', not 'yesterday'", () => {
    expect(getRelativeTime(localTodayISO())).toBe("today");
    expect(getRelativeTime(undefined)).toBe("");
    expect(getRelativeTime("garbage")).toBe("");
  });
});

// ── Item 7: form state seeded from props re-syncs when the record changes ───
function NotesHarness({ profileId, notes }: { profileId: string; notes: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useResyncedState(notes, profileId, editing);
  return (
    <div>
      <textarea data-testid="notes" value={draft} onChange={(e) => { setEditing(true); setDraft(e.target.value); }} />
      <span data-testid="editing">{String(editing)}</span>
    </div>
  );
}

describe("item 7: notes drafts follow the profile the page is showing", () => {
  it("re-seeds when the profile id changes (the component instance is reused across ids)", () => {
    const { rerender } = render(<NotesHarness profileId="a" notes="A's notes" />);
    expect((screen.getByTestId("notes") as HTMLTextAreaElement).value).toBe("A's notes");
    rerender(<NotesHarness profileId="b" notes="B's notes" />);
    // Before the fix: still "A's notes" — and Save would write them into B.
    expect((screen.getByTestId("notes") as HTMLTextAreaElement).value).toBe("B's notes");
  });

  it("re-seeds when the saved notes change while not editing, but never clobbers a draft", () => {
    const { rerender } = render(<NotesHarness profileId="a" notes="v1" />);
    rerender(<NotesHarness profileId="a" notes="v2 (AI wrote this)" />);
    expect((screen.getByTestId("notes") as HTMLTextAreaElement).value).toBe("v2 (AI wrote this)");
    fireEvent.change(screen.getByTestId("notes"), { target: { value: "my draft" } });
    rerender(<NotesHarness profileId="a" notes="v3 (refetch)" />);
    expect((screen.getByTestId("notes") as HTMLTextAreaElement).value).toBe("my draft");
    // A different profile always wins over a draft — the draft belonged to "a".
    rerender(<NotesHarness profileId="b" notes="B" />);
    expect((screen.getByTestId("notes") as HTMLTextAreaElement).value).toBe("B");
  });
});

// ── Item 9: the calendar Manage tab honours the toolbar profile filter ──────
describe("item 9: CalendarManagerPanel Manage tab reads under the active profile scope", () => {
  beforeEach(() => {
    apiRequest.mockClear();
    scope.mode = "selected"; scope.selectedIds = ["jane-1"]; scope.selectedNames = ["Jane"]; scope.isFiltered = true;
  });

  it("fetches obligations / events / tasks with ?profileIds= and the full-list limit", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CalendarManagerPanel open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    const tab = screen.getByTestId("manager-tab-manage");
    fireEvent.mouseDown(tab, { button: 0 });
    fireEvent.click(tab);
    await waitFor(() => {
      const urls = apiRequest.mock.calls.map((c: any[]) => String(c[1]));
      expect(urls.some((u) => u.startsWith("/api/obligations?"))).toBe(true);
    });
    const urls = apiRequest.mock.calls.map((c: any[]) => String(c[1]));
    for (const ep of ["obligations", "events", "tasks"]) {
      const hit = urls.find((u) => u.startsWith(`/api/${ep}`));
      expect(hit, ep).toBeDefined();
      expect(hit, ep).toContain("profileIds=jane-1");
      expect(hit, ep).toContain("limit=500");
      // And no bare, unscoped read of the same list.
      expect(urls.filter((u) => u === `/api/${ep}`), ep).toEqual([]);
    }
    // The reads land in the scoped cache slot every other page uses.
    expect(qc.getQueryData(["/api/obligations", "selected", "jane-1"])).toBeDefined();
    expect(qc.getQueryData(["/api/obligations"])).toBeUndefined();
  });
});

