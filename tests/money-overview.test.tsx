// @vitest-environment jsdom
//
// Render test for the Finance-tab Money overview. The dev server has no
// backend, so this jsdom mount is where we actually prove MoneyOverview draws
// the mockup cards from real props: net worth + MoM, cash flow, spend + worst
// budget, budget chips, a payable bill, balance sheet, and asset/liability
// breakdowns.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MoneyOverview } from "../client/src/components/finance/MoneyOverview";

// wouter <Link> needs a router context; stub it to a plain anchor so the
// component renders in isolation.
vi.mock("wouter", () => ({
  Link: ({ children }: any) => <>{children}</>,
}));

// recharts' ResponsiveContainer needs ResizeObserver, absent in jsdom.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || ResizeObserverStub;

afterEach(cleanup);

const baseProps = {
  netWorth: 284650,
  assets: 342100,
  liabilities: 57450,
  momPct: 1.8,
  nwSeries: [270000, 275000, 278000, 284650],
  cashIn: 8420,
  cashOut: 6150,
  spendMtd: 1384,
  budgets: [
    { category: "dining", limit: 400, spent: 368 },
    { category: "shopping", limit: 300, spent: 312 },
    { category: "groceries", limit: 600, spent: 408 },
  ],
  bills: [
    { id: "b1", name: "Rent — Maple St", amount: 2400, daysUntil: 3, status: "upcoming" },
    { id: "b2", name: "Internet — Fiber One", amount: 79, daysUntil: 5, status: "upcoming" },
  ],
  assetBreakdown: [{ id: "a1", name: "Brokerage — Vanguard", type: "investment", value: 52600 }],
  liabilityBreakdown: [{ id: "l1", name: "Visa — Chase", type: "credit", value: 6800 }],
  monthLabel: "JUL",
  onAddExpense: () => {},
  onPayBill: () => {},
  payingId: null,
};

describe("MoneyOverview", () => {
  it("renders the KPI card row (net worth, cash flow, spend, income, bills, savings)", () => {
    render(<MoneyOverview {...baseProps} incomeMtd={8420} spendByCategory={{ dining: 368, shopping: 312 }} />);
    expect(screen.getByTestId("money-networth").textContent).toContain("$284,650");
    expect(screen.getByTestId("money-networth").textContent).toContain("1.8% mo");
    // cash flow +$2,270 (8420 - 6150)
    expect(screen.getByTestId("money-cashflow").textContent).toContain("$2,270");
    expect(screen.getByTestId("money-cashflow").textContent).toContain("IN $8,420");
    // spend KPI shows worst-budget hint
    expect(screen.getByTestId("money-spend").textContent).toContain("shopping 104%");
    // new KPI cards
    expect(screen.getByTestId("money-income").textContent).toContain("$8,420");
    expect(screen.getByTestId("money-bills-kpi")).toBeTruthy();
    // savings rate = (8420-1384)/8420 ≈ 84%
    expect(screen.getByTestId("money-savings").textContent).toContain("84%");
  });

  it("renders the cash-flow overview donut and sorted category breakdown", () => {
    const onCategoryClick = vi.fn();
    render(<MoneyOverview {...baseProps} incomeMtd={8420}
      spendByCategory={{ dining: 368, shopping: 312, groceries: 74 }} onCategoryClick={onCategoryClick} />);
    expect(screen.getByTestId("money-cashflow-overview").textContent).toContain("Inflow");
    const cats = screen.getByTestId("money-categories");
    expect(cats.textContent).toContain("dining");
    // sorted highest-first → dining before groceries
    expect(cats.textContent!.indexOf("dining")).toBeLessThan(cats.textContent!.indexOf("groceries"));
    fireEvent.click(screen.getByTestId("money-cat-dining"));
    expect(onCategoryClick).toHaveBeenCalledWith("dining");
  });

  it("KPI cards and budgets open their drill-down popups", () => {
    const onOpenNetWorth = vi.fn(), onOpenCashFlow = vi.fn(), onOpenBudget = vi.fn();
    render(<MoneyOverview {...baseProps} onOpenNetWorth={onOpenNetWorth} onOpenCashFlow={onOpenCashFlow} onOpenBudget={onOpenBudget} />);
    fireEvent.click(screen.getByTestId("money-networth"));
    expect(onOpenNetWorth).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("money-cashflow"));
    expect(onOpenCashFlow).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("money-budgets-header"));
    expect(onOpenBudget).toHaveBeenCalled();
  });

  it("renders financial alerts that deep-link", () => {
    const onClick = vi.fn();
    render(<MoneyOverview {...baseProps} alerts={[{ id: "a1", text: "2 overdue bills", tone: "neg", onClick }]} />);
    expect(screen.getByTestId("money-alerts").textContent).toContain("2 overdue bills");
    fireEvent.click(screen.getByTestId("money-alert-a1"));
    expect(onClick).toHaveBeenCalled();
  });

  it("renders budget chips with correct percentages", () => {
    render(<MoneyOverview {...baseProps} />);
    expect(screen.getByTestId("money-budget-dining").textContent).toContain("92%");
    expect(screen.getByTestId("money-budget-shopping").textContent).toContain("104%");
    expect(screen.getByTestId("money-budget-groceries").textContent).toContain("68%");
  });

  it("renders bills with a working Pay button", () => {
    const onPayBill = vi.fn();
    render(<MoneyOverview {...baseProps} onPayBill={onPayBill} />);
    expect(screen.getByTestId("money-bill-b1").textContent).toContain("Rent — Maple St");
    fireEvent.click(screen.getByTestId("money-pay-b1"));
    expect(onPayBill).toHaveBeenCalledWith(expect.objectContaining({ id: "b1" }));
  });

  it("renders the balance sheet and breakdowns", () => {
    render(<MoneyOverview {...baseProps} />);
    const bs = screen.getByTestId("money-balance-sheet").textContent || "";
    expect(bs).toContain("Assets");
    expect(bs).toContain("$342,100");
    expect(bs).toContain("$57,450");
    expect(screen.getByTestId("money-assets").textContent).toContain("Brokerage — Vanguard");
    expect(screen.getByTestId("money-liabilities").textContent).toContain("Visa — Chase");
  });

  it("hides budgets card when there are no budgets", () => {
    render(<MoneyOverview {...baseProps} budgets={[]} />);
    expect(screen.queryByTestId("money-budgets")).toBeNull();
  });

  it("shows a negative net worth in red without crashing", () => {
    render(<MoneyOverview {...baseProps} netWorth={-22086} assets={0} liabilities={22086} />);
    expect(screen.getByTestId("money-networth").textContent).toContain("$22,086");
  });

  it("renders the multi-month cash-flow trend chart when given >=2 months", () => {
    render(<MoneyOverview {...baseProps} cashTrend={[
      { month: "Feb", inflow: 8000, outflow: 5200, net: 2800 },
      { month: "Mar", inflow: 8000, outflow: 6100, net: 1900 },
      { month: "Apr", inflow: 8000, outflow: 4800, net: 3200 },
    ]} />);
    expect(screen.getByTestId("money-cashflow-trend")).toBeTruthy();
    expect(screen.getByTestId("money-cashflow-trend").textContent).toContain("Cash Flow Trend");
  });

  it("omits the cash-flow trend chart with fewer than 2 months", () => {
    render(<MoneyOverview {...baseProps} cashTrend={[{ month: "Apr", inflow: 8000, outflow: 4800, net: 3200 }]} />);
    expect(screen.queryByTestId("money-cashflow-trend")).toBeNull();
  });

  it("renders the balance sheet as assets-vs-liabilities bars", () => {
    render(<MoneyOverview {...baseProps} />);
    const bs = screen.getByTestId("money-balance-sheet").textContent || "";
    expect(bs).toContain("Assets");
    expect(bs).toContain("Liabilities");
    expect(bs).toContain("$342,100");
    expect(bs).toContain("$57,450");
    expect(bs).toContain("Net worth");
  });
});
