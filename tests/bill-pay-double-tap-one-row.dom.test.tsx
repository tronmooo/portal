// @vitest-environment jsdom
// A phone double tap on a bill occurrence's Pay paid TWO months: the first tap
// paid December, its row lost the Pay button, and January's Pay slid under
// the finger for the second tap (ui-money.bill on the isolated stack,
// 2026-11-28: ".../occurrences/2026-12-04/pay" then ".../2027-01-04/pay",
// 0.3 s apart). A press within a double tap's span of the previous action's
// start is the same gesture. Renders the real section.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import React from "react";

const calls: Array<[string, string]> = [];
const schedule = {
  id: "bill-1", name: "Water", amount: 66.25, frequency: "monthly", isRecurring: true, billingModel: "fixed",
  firstPayment: "2026-06-04", nextDue: { date: "2026-12-04", effectiveDate: "2026-12-04", amount: 66.25 },
  lastPaid: null, autopay: false, paused: false, pausedUntil: null, gracePeriodDays: null, lateFee: null,
  reminderLeadDays: null, totalPayments: null, paidCount: 0, remainingPayments: null, recurrenceEnd: null,
  annualTotal: 795, calendarSynced: true, payments: [],
  occurrences: [
    { date: "2026-12-04", effectiveDate: "2026-12-04", amount: 66.25, status: "upcoming", occurrenceId: "o1" },
    { date: "2027-01-04", effectiveDate: "2027-01-04", amount: 66.25, status: "upcoming", occurrenceId: "o2" },
  ],
};
vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    queryClient,
    apiRequest: vi.fn(async (method: string, url: string) => {
      calls.push([method, url]);
      if (method === "GET") return new Response(JSON.stringify(schedule));
      return new Response(JSON.stringify({ ok: true }));
    }),
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

afterEach(() => { cleanup(); calls.length = 0; vi.useRealTimers(); });

async function mount() {
  const { QueryClientProvider } = await import("@tanstack/react-query");
  const { queryClient } = await import("@/lib/queryClient");
  const { BillScheduleSection } = await import("@/components/liability/BillScheduleSection");
  render(<QueryClientProvider client={queryClient}><BillScheduleSection liabilityId="bill-1" /></QueryClientProvider>);
  await screen.findByTestId("occ-pay-2026-12-04");
}
const pays = () => calls.filter(([m, u]) => m === "POST" && u.endsWith("/pay"));

describe("a double tap on Pay pays one occurrence", () => {
  it("the second tap, landing on the next month's Pay, pays nothing", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("occ-pay-2026-12-04"));
    await waitFor(() => expect(pays()).toHaveLength(1));
    fireEvent.click(screen.getByTestId("occ-pay-2027-01-04"));
    await new Promise((r) => setTimeout(r, 50));
    expect(pays().map(([, u]) => u)).toEqual(["/api/liabilities/bill-1/occurrences/2026-12-04/pay"]);
  });
  it("paying the next month a moment later is a second, deliberate payment", async () => {
    await mount();
    const { SAME_GESTURE_MS } = await import("@/components/liability/BillScheduleSection");
    fireEvent.click(screen.getByTestId("occ-pay-2026-12-04"));
    await waitFor(() => expect(pays()).toHaveLength(1));
    await act(async () => { await new Promise((r) => setTimeout(r, SAME_GESTURE_MS + 50)); });
    fireEvent.click(screen.getByTestId("occ-pay-2027-01-04"));
    await waitFor(() => expect(pays()).toHaveLength(2));
  });
});
