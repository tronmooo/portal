// @vitest-environment jsdom
//
// The FIRST budget can be made from Finance (integrity run, 2026-11-27: the
// Budgets card — and its "+ Budget" button, the only door to the budget
// editor — was drawn only once a budget existed, so an account with none had
// no screen that could make one; the owner asked for a first budget to be
// verified). And a budget list that is still loading or failed is not "no
// budgets" (Rule 7): neither the card nor the popup offers a first budget
// over a list it has not read.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({
  Link: ({ children }: any) => <>{children}</>,
  useLocation: () => ["/", () => {}],
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", async (orig) => ({ ...(await orig<any>()), apiRequest: (...a: any[]) => apiRequest(...a) }));

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || ResizeObserverStub;

import { MoneyOverview } from "../client/src/components/finance/MoneyOverview";
import { BudgetPopup } from "../client/src/components/dashboard/HeroKPIPopups";

afterEach(() => { cleanup(); apiRequest.mockReset(); });

const base = {
  netWorth: 0, assets: 0, liabilities: 0, momPct: null, nwSeries: [], cashIn: 0, cashOut: 0, spendMtd: 0,
  budgets: [] as Array<{ category: string; limit: number; spent: number }>,
  assetBreakdown: [], liabilityBreakdown: [], monthLabel: "NOV",
};

describe("Finance's Budgets card with no budget", () => {
  it("is drawn with a way to add the first budget", () => {
    const onOpenBudget = vi.fn();
    render(<MoneyOverview {...base} onOpenBudget={onOpenBudget} />);
    expect(screen.getByTestId("money-budgets")).toBeTruthy();
    expect(screen.getByTestId("money-budgets-empty").textContent).toMatch(/no budget/i);
    fireEvent.click(screen.getByTestId("money-manage-budgets"));
    expect(onOpenBudget).toHaveBeenCalledTimes(1);
  });

  it("says Loading… while the list is unread, and Couldn't load with a retry when it failed — never 'no budget'", () => {
    const { unmount } = render(<MoneyOverview {...base} onOpenBudget={() => {}} budgetsStatus="loading" />);
    expect(screen.getByTestId("money-budgets-loading")).toBeTruthy();
    expect(screen.queryByTestId("money-budgets-empty")).toBeNull();
    unmount();
    const retry = vi.fn();
    render(<MoneyOverview {...base} onOpenBudget={() => {}} budgetsStatus="error" onRetryBudgets={retry} />);
    expect(screen.queryByTestId("money-budgets-empty")).toBeNull();
    fireEvent.click(screen.getByTestId("money-budgets-retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("still lists budgets that exist", () => {
    render(<MoneyOverview {...base} budgets={[{ category: "dining", limit: 400, spent: 120 }]} onOpenBudget={() => {}} />);
    expect(screen.getByTestId("money-budget-dining").textContent).toContain("400");
    expect(screen.queryByTestId("money-budgets-empty")).toBeNull();
  });
});

describe("the budget popup", () => {
  const mount = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <BudgetPopup open onOpenChange={() => {}} filterMode="everyone" filterIds={[]} monthlyIncome={0} />
      </QueryClientProvider>,
    );
  };
  it("offers the first category only once the empty list has been read", async () => {
    apiRequest.mockImplementation(async (_m: string, url: string) => ({
      json: async () => (url.startsWith("/api/budgets") ? { budgets: [] } : {}),
    }));
    mount();
    await waitFor(() => expect(screen.getByTestId("budget-add-first")).toBeTruthy());
  });
  it("a failed budget read is an error with a retry, not 'No budget categories yet'", async () => {
    apiRequest.mockImplementation(async (_m: string, url: string) => {
      if (url.startsWith("/api/budgets")) throw new Error("500: boom");
      return { json: async () => ({}) };
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("budget-list-error")).toBeTruthy());
    expect(screen.queryByTestId("budget-add-first")).toBeNull();
    expect(screen.queryByText(/no budget categories yet/i)).toBeNull();
  });
  it("copies last month's budgets on a tap (and not on opening)", async () => {
    apiRequest.mockImplementation(async (_m: string, url: string) => ({
      json: async () => (url.startsWith("/api/budgets/copy") ? { copied: 2 } : url.startsWith("/api/budgets") ? { budgets: [] } : {}),
    }));
    mount();
    const btn = await screen.findByTestId("budget-copy-last-month");
    expect(apiRequest.mock.calls.some((c) => c[0] !== "GET")).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(apiRequest.mock.calls.some((c) => c[1] === "/api/budgets/copy")).toBe(true));
    const [, , body] = apiRequest.mock.calls.find((c) => c[1] === "/api/budgets/copy")!;
    const [y, m] = body.toMonth.split("-").map(Number);
    const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
    expect(body).toEqual({ fromMonth: prev, toMonth: body.toMonth });
  });
});
