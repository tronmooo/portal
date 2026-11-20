// @vitest-environment jsdom
//
// The Auto Pay controls on a liability's Payments tab, rendered for real:
//   • the switch saves itself through the one server door and says what
//     turning it on / off does;
//   • a payment Auto Pay recorded is labelled "Assumed paid", never "Paid";
//   • "Mark as missed" on a recorded payment takes two taps (Rule 8);
//   • every per-payment action posts to …/status for THAT payment only.
import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const calls: Array<{ method: string; url: string; body?: any }> = [];
let schedule: any;

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({
  queryClient: { invalidateQueries: vi.fn() },
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    const json = url.includes("/schedule") ? schedule
      : url === "/api/accounts" ? { accounts: [{ profile: { id: "acct-1", name: "Chase Checking" } }] }
      : { ok: true };
    return { json: async () => json } as any;
  }),
}));

import { AutoPaySection } from "../client/src/components/liability/AutoPaySection";
import { PaymentStatusBadge, PaymentStatusControls } from "../client/src/components/liability/PaymentStatusControls";

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  calls.length = 0;
  schedule = {
    amount: 400, autopay: false, autopayReminders: false, autopayAccountId: null,
    nextDue: { date: "2026-12-15", effectiveDate: "2026-12-15", amount: 400 },
  };
});
afterEach(cleanup);

describe("AutoPaySection", () => {
  it("off: says the user records payments, and offers no source or reminder options", async () => {
    wrap(<AutoPaySection liabilityId="loan-1" />);
    const sw = await screen.findByTestId("switch-autopay");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("autopay-summary").textContent).toMatch(/You record each payment yourself/);
    expect(screen.queryByTestId("select-autopay-source")).toBeNull();
    expect(screen.queryByTestId("switch-autopay-reminders")).toBeNull();
  });

  it("rendering it writes nothing (Rule 3), and the switch posts to the Auto Pay endpoint", async () => {
    wrap(<AutoPaySection liabilityId="loan-1" />);
    const sw = await screen.findByTestId("switch-autopay");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    fireEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toEqual({ method: "POST", url: "/api/liabilities/loan-1/autopay", body: { enabled: true } });
  });

  it("on: names the amount and the next date, says it is assumed until confirmed, and offers source + reminders", async () => {
    schedule = { ...schedule, autopay: true };
    wrap(<AutoPaySection liabilityId="loan-1" />);
    const summary = await screen.findByTestId("autopay-summary");
    expect(summary.textContent).toMatch(/\$400\.00/);
    expect(summary.textContent).toMatch(/Dec(ember)? 15/);
    expect(summary.textContent).toMatch(/Assumed paid until you or your bank confirm/);
    expect(summary.textContent).toMatch(/won't get due-date reminders/);

    const source = await screen.findByTestId("select-autopay-source");
    await waitFor(() => expect(source.textContent).toMatch(/Chase Checking/));
    fireEvent.change(source, { target: { value: "acct-1" } });
    fireEvent.click(screen.getByTestId("switch-autopay-reminders"));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ accountId: "acct-1" }, { reminders: true }]);
  });

  it("on with no amount or date: says what is missing instead of promising a payment", async () => {
    schedule = { amount: 0, autopay: true, nextDue: null };
    wrap(<AutoPaySection liabilityId="loan-1" />);
    expect((await screen.findByTestId("autopay-summary")).textContent).toMatch(/Add a payment amount and a due date/);
  });
});

describe("PaymentStatusBadge / PaymentStatusControls", () => {
  it("an assumed payment is not labelled Paid", () => {
    render(<><PaymentStatusBadge status="assumed_paid" /><PaymentStatusBadge status="confirmed_paid" autopay /></>);
    expect(screen.getByTestId("payment-status-assumed_paid").textContent).toBe("Assumed paid");
    expect(screen.getByTestId("payment-status-confirmed_paid").textContent).toBe("Paid · Auto Pay");
  });

  it("confirm posts to the payment's status endpoint", async () => {
    wrap(<PaymentStatusControls target={{ liabilityId: "loan-1", paymentId: "pay-1" }} status="assumed_paid" amount={400} date="2026-11-15" />);
    fireEvent.click(screen.getByTestId("payment-controls-pay-1"));
    fireEvent.click(await screen.findByTestId("payment-confirm-pay-1"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: "POST", url: "/api/liability-payments/pay-1/status", body: { status: "confirmed" } });
  });

  it("marking a recorded payment missed takes two taps", async () => {
    wrap(<PaymentStatusControls target={{ liabilityId: "loan-1", paymentId: "pay-1" }} status="assumed_paid" amount={400} date="2026-11-15" />);
    fireEvent.click(screen.getByTestId("payment-controls-pay-1"));
    const missed = await screen.findByTestId("payment-missed-pay-1");
    fireEvent.click(missed);
    expect(calls).toHaveLength(0);
    expect(missed.textContent).toMatch(/Tap again to reverse this payment/);
    fireEvent.click(missed);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ status: "missed" });
  });

  it("a scheduled occurrence is addressed by its date; partial and move send that one payment's change", async () => {
    wrap(<PaymentStatusControls target={{ liabilityId: "bill-1", occurrenceDate: "2026-12-20" }} status="scheduled" amount={85} date="2026-12-20" />);
    fireEvent.click(screen.getByTestId("payment-controls-2026-12-20"));
    // Nothing recorded yet, so nothing to reverse: one tap.
    fireEvent.click(await screen.findByTestId("payment-missed-2026-12-20"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: "POST", url: "/api/liabilities/bill-1/occurrences/2026-12-20/status", body: { status: "missed" } });
  });

  it("partial and reschedule carry the amount / the new day", async () => {
    wrap(<PaymentStatusControls target={{ liabilityId: "bill-1", paymentId: "pay-9" }} status="confirmed_paid" amount={85} date="2026-11-20" />);
    fireEvent.click(screen.getByTestId("payment-controls-pay-9"));
    fireEvent.change(await screen.findByTestId("payment-partial-amount-pay-9"), { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("payment-partial-pay-9"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ status: "partial", amount: 40 });

    cleanup(); calls.length = 0;
    wrap(<PaymentStatusControls target={{ liabilityId: "bill-1", paymentId: "pay-9" }} status="confirmed_paid" amount={85} date="2026-11-20" />);
    fireEvent.click(screen.getByTestId("payment-controls-pay-9"));
    fireEvent.change(await screen.findByTestId("payment-move-date-pay-9"), { target: { value: "2026-11-27" } });
    fireEvent.click(screen.getByTestId("payment-move-pay-9"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).toEqual({ status: "delayed", movedTo: "2026-11-27" });
  });
});
