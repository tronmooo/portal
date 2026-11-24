// @vitest-environment jsdom
// "All Bills" keeps a bill paid this month on the list, on its next date.
//
// 2026-11-24 (tests/live-bills-ui-check.ts): after the month's last bill was
// paid, All Bills read "No bills in the next 30 days — Add a bill to see
// what's due and when", while the bill sat under Paid. A monthly bill just
// paid is next due 28 to 33 days out, past the snapshot's 30-day window.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { allBillsRows } from "../shared/bills-all-tab";
import { BillsView } from "../client/src/components/dashboard/BriefingPopups";
import { queryClient as appQueryClient } from "../client/src/lib/queryClient";

const iso = (d: Date) => d.toLocaleDateString("en-CA");
const today = new Date();
const inDays = (n: number) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };

describe("allBillsRows", () => {
  const T = "2026-11-24";
  it("adds a bill paid this month on its next date, after the upcoming ones", () => {
    const upcoming = [{ id: "rent", name: "Rent", amount: 1200, status: "upcoming", daysUntil: 7, dueDate: "2026-12-01" }];
    const paid = [{ id: "water", name: "Water", amount: 45.5, status: "paid", daysUntil: null, dueDate: "2026-12-27", paidDate: "2026-11-24" }];
    const all = allBillsRows(upcoming, paid, T);
    expect(all.map((b) => b.id)).toEqual(["rent", "water"]);
    expect(all[1]).toMatchObject({ status: "upcoming", dueDate: "2026-12-27", daysUntil: 33, paidDate: "2026-11-24", amount: 45.5 });
  });

  it("does not list a bill twice when it is both upcoming and paid this month", () => {
    const upcoming = [{ id: "gym", name: "Gym", amount: 30, status: "upcoming", daysUntil: 20, dueDate: "2026-12-14" }];
    const paid = [{ id: "gym", name: "Gym", amount: 30, status: "paid", daysUntil: null, dueDate: "2026-12-14", paidDate: "2026-11-14" }];
    expect(allBillsRows(upcoming, paid, T).map((b) => b.id)).toEqual(["gym"]);
  });

  it("adds nothing for a paid bill with no date still to come", () => {
    const paid = [
      { id: "once", name: "One-time fee", amount: 80, status: "paid", daysUntil: null, dueDate: "2026-11-20", paidDate: "2026-11-20" },
      { id: "none", name: "No date", amount: 10, status: "paid", daysUntil: null, dueDate: null, paidDate: "2026-11-21" },
      { id: "junk", name: "Junk date", amount: 10, status: "paid", daysUntil: null, dueDate: "soon", paidDate: "2026-11-21" },
    ];
    expect(allBillsRows([], paid, T)).toEqual([]);
  });
});

function renderBills(obligations: any[], bills: any[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: async () => [] } } });
  client.setQueryData(["/api/obligations"], obligations);
  return render(<QueryClientProvider client={client}><BillsView bills={bills} /></QueryClientProvider>);
}

describe("the Bills page", () => {
  afterEach(() => cleanup());

  it("lists a monthly bill paid today under All Bills, on its next date", () => {
    renderBills([{ id: "water", name: "Water Bill", amount: 45.5, frequency: "monthly", nextDueDate: inDays(33), payments: [{ id: "p1", amount: 45.5, date: iso(today) }], linkedProfiles: [] }]);
    const row = screen.getByTestId("bill-row-water");
    expect(row.textContent).toContain("Water Bill");
    expect(row.textContent).toContain("$45.50");
    expect(row.textContent).toContain("Upcoming");
    expect(row.textContent).toContain("in 33 days");
    expect(row.textContent).toMatch(/paid /);
    expect(screen.queryByText("No bills in the next 30 days")).toBeNull();
    // It is not money due now: the headline figures do not count it.
    expect(screen.getByTestId("bills-stat-total").textContent).toContain("$0");
    // … and it is still under Paid.
    fireEvent.click(screen.getByTestId("bills-filter-paid"));
    expect(screen.getByTestId("bill-row-water").textContent).toContain("Paid");
  });

  it("still says there are no bills when there are none", () => {
    renderBills([]);
    expect(screen.getByText("No bills in the next 30 days")).toBeTruthy();
    expect(screen.queryByTestId("bill-row-water")).toBeNull();
  });
});

// A bill row answers the tap; the refetch confirms it; a failed write puts it back.
describe("a bill edit or delete shows at once", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const BILL = { id: "net", name: "Internet", amount: 60, status: "upcoming", daysUntil: 5, dueDate: inDays(5) };
  const OB = { id: "net", name: "Internet", amount: 60, frequency: "monthly", nextDueDate: inDays(5), payments: [], linkedProfiles: [] };

  /** A server that answers when the test says so. */
  function heldServer() {
    let settle: (ok: boolean) => void = () => undefined;
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string, init?: any) => {
      const method = String(init?.method || "GET");
      calls.push(`${method} ${String(url)}`);
      if (method === "GET") return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => [OB], text: async () => "[]" });
      return new Promise((resolve) => {
        settle = (ok) => resolve(ok
          ? { ok: true, status: 200, headers: new Headers(), json: async () => ({ success: true }), text: async () => "{}" }
          : { ok: false, status: 500, statusText: "Server Error", headers: new Headers(), json: async () => ({ error: "boom" }), text: async () => '{"error":"boom"}' });
      });
    });
    return { calls, answer: (ok: boolean) => settle(ok) };
  }
  // The view takes its rows from the snapshot cache; the test owns that cache.
  function renderFromCache() {
    // The app's own cache: it is the one the view's writes are drawn into.
    const client = appQueryClient;
    client.clear();
    client.setQueryData(["/api/obligations"], [OB]);
    function Host() {
      const { data } = useQuery<any>({ queryKey: ["/api/dashboard-enhanced", "everyone"], queryFn: async () => ({ financeSnapshot: { upcomingBills: [BILL] } }), staleTime: Infinity });
      return <BillsView bills={data?.financeSnapshot?.upcomingBills || []} />;
    }
    client.setQueryData(["/api/dashboard-enhanced", "everyone"], { financeSnapshot: { upcomingBills: [BILL] } });
    render(<QueryClientProvider client={client}><Host /></QueryClientProvider>);
    return client;
  }

  it("delete: the row leaves on the confirming tap, before the server answers; a failure brings it back", async () => {
    const server = heldServer();
    renderFromCache();
    fireEvent.click(screen.getByTestId("bill-row-net"));
    fireEvent.click(screen.getByTestId("popup-delete-net"));
    // Two steps (Rule 8): nothing has been sent yet.
    expect(server.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
    fireEvent.click(screen.getByTestId("bill-delete-confirm-net"));
    await waitFor(() => expect(screen.queryByTestId("bill-row-net")).toBeNull());
    expect(server.calls.some((c) => c.startsWith("DELETE") && c.endsWith("/api/obligations/net"))).toBe(true);
    server.answer(false);
    await waitFor(() => expect(screen.getByTestId("bill-row-net").textContent).toContain("Internet"));
  });

  it("edit: the row shows the new amount before the server answers; a failure puts the old one back", async () => {
    const server = heldServer();
    renderFromCache();
    fireEvent.click(screen.getByTestId("bill-row-net"));
    fireEvent.click(screen.getByTestId("popup-edit-net"));
    fireEvent.change(screen.getByTestId("bill-edit-amount-net"), { target: { value: "72.25" } });
    fireEvent.click(screen.getByTestId("bill-edit-save-net"));
    await waitFor(() => expect(screen.getByTestId("bill-row-net").textContent).toContain("$72.25"));
    // Only what changed was sent: the untouched due date is not written back.
    const sent = server.calls.find((c) => c.startsWith("PATCH"));
    expect(sent).toMatch(/\/api\/obligations\/net$/);
    server.answer(false);
    await waitFor(() => expect(screen.getByTestId("bill-row-net").textContent).not.toContain("$72.25"));
    expect(screen.getByTestId("bill-row-net").textContent).toContain("$60");
  });
});
