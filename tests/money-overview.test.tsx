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
  it("renders the snapshot row (net worth, MoM, cash flow, spend + worst budget)", () => {
    render(<MoneyOverview {...baseProps} />);
    expect(screen.getByTestId("money-networth").textContent).toContain("$284,650");
    expect(screen.getByTestId("money-networth").textContent).toContain("1.8% MO");
    // cash flow +$2,270 (8420 - 6150)
    expect(screen.getByTestId("money-cashflow").textContent).toContain("$2,270");
    expect(screen.getByTestId("money-cashflow").textContent).toContain("IN $8,420");
    // worst budget = shopping 104%
    expect(screen.getByTestId("money-spend").textContent).toContain("SHOPPING 104% BUDGET");
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

  // ── Drill-downs (2026-07): every card opens its existing dashboard popup ──
  it("clicking the snapshot cards fires the drill-down handlers", () => {
    const onOpenNetWorth = vi.fn();
    const onOpenCashFlow = vi.fn();
    const onOpenSpend = vi.fn();
    render(<MoneyOverview {...baseProps}
      onOpenNetWorth={onOpenNetWorth} onOpenCashFlow={onOpenCashFlow} onOpenSpend={onOpenSpend} />);
    fireEvent.click(screen.getByTestId("money-networth"));
    fireEvent.click(screen.getByTestId("money-cashflow"));
    fireEvent.click(screen.getByTestId("money-spend"));
    expect(onOpenNetWorth).toHaveBeenCalledTimes(1);
    expect(onOpenCashFlow).toHaveBeenCalledTimes(1);
    expect(onOpenSpend).toHaveBeenCalledTimes(1);
  });

  it("balance sheet and budget chips drill into their popups", () => {
    const onOpenNetWorth = vi.fn();
    const onOpenSpend = vi.fn();
    render(<MoneyOverview {...baseProps} onOpenNetWorth={onOpenNetWorth} onOpenSpend={onOpenSpend} />);
    fireEvent.click(screen.getByTestId("money-balance-sheet"));
    expect(onOpenNetWorth).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("money-budget-dining"));
    expect(onOpenSpend).toHaveBeenCalledTimes(1);
  });

  it("renders the subscriptions summary with View all / + Sub actions", () => {
    const onViewSubs = vi.fn();
    const onAddSub = vi.fn();
    render(<MoneyOverview {...baseProps}
      subs={{ count: 12, monthlyTotal: 186 }} onViewSubs={onViewSubs} onAddSub={onAddSub} />);
    const card = screen.getByTestId("money-subs");
    expect(card.textContent).toContain("$186/mo");
    expect(card.textContent).toContain("12 active");
    fireEvent.click(screen.getByTestId("money-view-subs"));
    expect(onViewSubs).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("money-add-sub"));
    expect(onAddSub).toHaveBeenCalledTimes(1);
  });

  it("renders recent transactions with signed amounts and row clicks", () => {
    const onTransactionClick = vi.fn();
    render(<MoneyOverview {...baseProps}
      transactions={[
        { id: "t1", date: "2026-07-07", name: "Whole Foods", category: "groceries", amount: -86.4 },
        { id: "t2", date: "2026-07-06", name: "Paycheck — Acme Co", category: "income", amount: 4210 },
      ]}
      onTransactionClick={onTransactionClick} />);
    const card = screen.getByTestId("money-transactions");
    expect(card.textContent).toContain("Whole Foods");
    expect(card.textContent).toContain("+$4,210.00");
    expect(card.textContent).toContain("−$86.40");
    fireEvent.click(screen.getByTestId("money-txn-t1"));
    expect(onTransactionClick).toHaveBeenCalledWith("t1");
  });

  it("shows the spend category strip and + Budget / + Bill buttons when wired", () => {
    const onAddBudget = vi.fn();
    const onAddBill = vi.fn();
    render(<MoneyOverview {...baseProps}
      spendCats={[{ name: "dining", amount: 368 }, { name: "groceries", amount: 408 }]}
      onAddBudget={onAddBudget} onAddBill={onAddBill} />);
    expect(screen.getByTestId("money-spend-strip").textContent).toContain("groceries");
    fireEvent.click(screen.getByTestId("money-add-budget"));
    expect(onAddBudget).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("money-add-bill"));
    expect(onAddBill).toHaveBeenCalledTimes(1);
  });

  it("collapses the whole section from the MONEY header toggle", () => {
    render(<MoneyOverview {...baseProps} />);
    expect(screen.queryByTestId("money-networth")).not.toBeNull();
    fireEvent.click(screen.getByTestId("money-collapse"));
    expect(screen.queryByTestId("money-networth")).toBeNull();
    fireEvent.click(screen.getByTestId("money-collapse"));
    expect(screen.queryByTestId("money-networth")).not.toBeNull();
  });
});
