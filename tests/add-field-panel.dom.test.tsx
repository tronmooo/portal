// @vitest-environment jsdom
//
// Owner, 2026-11-21: "add this [the person Info page's Add field] to the
// liabilities and asset profiles, this exact thing". AddFieldPanel is that
// Field | Value | Add row. Pinned here:
//   · Add field → Field | Value | Add writes the field with the Info page's PATCH;
//   · on a liability the added free-form fields are listed, tap to change,
//     X (two taps) to remove with the explicit delete signal;
//   · money, rate, date, switch and schedule fields are NOT listed as text
//     (they have their own editors — L2/L3);
//   · opening it writes nothing (Rule 3).
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequest, calls } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  calls: [] as Array<{ method: string; url: string; body: any }>,
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomain: vi.fn(async () => {}), invalidateDomains: vi.fn(async () => {}) }));

import { AddFieldPanel, freeFormFieldEntries } from "../client/src/components/AddFieldPanel";

const LOAN_FIELDS = {
  balance: 18250, interestRate: 6.25, _interestRateUnit: "percent", monthlyPayment: 450,
  dueDay: 15, firstPaymentDate: "2025-03-15", autopay: true, frequency: "monthly",
  accountManager: "Dana at the branch", "Gap insurance": "Yes, through dealer",
};

beforeEach(() => {
  calls.length = 0;
  apiRequest.mockImplementation(async (method: string, url: string, body?: any) => {
    calls.push({ method, url, body });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(cleanup);

function renderPanel(props: Partial<React.ComponentProps<typeof AddFieldPanel>> = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AddFieldPanel profileId="loan-1" fields={LOAN_FIELDS} showFields {...props} />
    </QueryClientProvider>,
  );
}

const writes = () => calls.filter(c => c.method !== "GET");

describe("AddFieldPanel", () => {
  it("Add field → Field | Value | Add writes the field", async () => {
    renderPanel();
    expect(writes()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("add-field-button"));
    fireEvent.change(screen.getByTestId("add-field-key"), { target: { value: "Loan officer" } });
    fireEvent.change(screen.getByTestId("add-field-value"), { target: { value: "Sam Ortiz" } });
    fireEvent.click(screen.getByTestId("add-field-save"));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ method: "PATCH", url: "/api/profiles/loan-1", body: { fields: { "Loan officer": "Sam Ortiz" } } });
    await waitFor(() => expect(screen.queryByTestId("add-field-form")).toBeNull());
  });

  it("lists the free-form fields, never money, rates, dates, switches or schedule", () => {
    const keys = freeFormFieldEntries(LOAN_FIELDS).map(([k]) => k);
    expect(keys.sort()).toEqual(["Gap insurance", "accountManager"]);
    renderPanel();
    expect(screen.getByTestId("add-field-cell-accountManager").textContent).toMatch(/Dana at the branch/);
    expect(screen.queryByTestId("add-field-cell-interestRate")).toBeNull();
  });

  it("a listed field changes on tap and is removed with two taps", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("add-field-cell-accountManager"));
    const input = screen.getByTestId("add-field-edit-accountManager");
    fireEvent.change(input, { target: { value: "Dana Lee" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ fields: { accountManager: "Dana Lee" } });

    fireEvent.click(screen.getByTestId("add-field-remove-Gap insurance"));
    expect(writes()).toHaveLength(1);
    fireEvent.click(screen.getByTestId("add-field-remove-Gap insurance"));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1].body).toEqual({ fieldsToDelete: ["Gap insurance"] });
  });
});
