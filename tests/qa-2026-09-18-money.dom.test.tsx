// @vitest-environment jsdom
//
// QA 2026-09-18 F-18 / F-21: the Finance Assets card lists every row on
// request, and rows + totals share one formatter so the column sums.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MoneyOverview } from "../client/src/components/finance/MoneyOverview";

vi.mock("wouter", () => ({
  Link: ({ children }: any) => <>{children}</>,
}));
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || ResizeObserverStub;

afterEach(cleanup);

const fourteenAssets = Array.from({ length: 14 }, (_, i) => ({ id: `a${i + 1}`, name: `Asset ${i + 1}`, type: "asset", value: 1000 * (i + 1) }));

const baseProps = {
  netWorth: 100, assets: 106.43, liabilities: 49829.1, momPct: null, nwSeries: [],
  cashIn: 0, cashOut: 0, spendMtd: 0, budgets: [], bills: [],
  assetBreakdown: [
    { id: "c1", name: "MacBook Screen Cover", type: "asset", value: 39.75 },
    { id: "c2", name: "MacBook Mouse", type: "asset", value: 66.68 },
  ],
  liabilityBreakdown: [{ id: "l1", name: "Auto loan", type: "loan", value: 49829.1 }],
  monthLabel: "SEP", onAddExpense: () => {}, onPayBill: () => {}, payingId: null,
};

describe("F-18 Assets card shows all rows on request", () => {
  it("previews eight rows, then lists all fourteen", () => {
    render(<MoneyOverview {...baseProps} assetBreakdown={fourteenAssets} assets={105000} />);
    expect(screen.queryByTestId("money-asset-a9")).toBeNull();
    const btn = screen.getByTestId("money-assets-show-all");
    expect(btn.textContent).toContain("Show all 14");
    fireEvent.click(btn);
    expect(screen.getByTestId("money-asset-a14")).toBeTruthy();
    expect(screen.queryByTestId("money-assets-show-all")).toBeNull();
  });
  it("never collapses a short list", () => {
    render(<MoneyOverview {...baseProps} assetBreakdown={fourteenAssets.slice(0, 10)} />);
    expect(screen.getByTestId("money-asset-a10")).toBeTruthy();
    expect(screen.queryByTestId("money-assets-show-all")).toBeNull();
  });
});

describe("F-21 rows and totals share one formatter", () => {
  it("keeps cents on the rows and the total so the column sums", () => {
    render(<MoneyOverview {...baseProps} />);
    expect(screen.getByTestId("money-asset-c1").textContent).toContain("$39.75");
    expect(screen.getByTestId("money-asset-c2").textContent).toContain("$66.68");
    expect(screen.getByTestId("money-assets").textContent).toContain("$106.43");
    // The loan balance reads the same here as on the Accounts card.
    expect(screen.getByTestId("money-liability-l1").textContent).toContain("$49,829.10");
    expect(screen.getByTestId("money-balance-sheet").textContent).toContain("$49,829.10");
  });
});
