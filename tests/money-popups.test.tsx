// @vitest-environment jsdom
//
// Render tests for the per-card Money drill-down popups (MoneyPopups.tsx).
// Each KPI card on the Finance/Money overview opens its OWN popup now; these
// mounts prove each popup renders its bespoke layout from real props and that
// the interactive bits (Pay) fire their callbacks.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  CashFlowWaterfallPopup, SpendPopup, IncomePopup, BillsDuePopup,
  SavingsRatePopup, CashFlowOverviewPopup,
} from "../client/src/components/finance/MoneyPopups";

vi.mock("wouter", () => ({
  Link: ({ children }: any) => <>{children}</>,
  useLocation: () => ["/", vi.fn()],
}));

// recharts' ResponsiveContainer needs ResizeObserver, absent in jsdom.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || ResizeObserverStub;

afterEach(cleanup);

const noop = () => {};

describe("MoneyPopups", () => {
  it("CashFlowWaterfallPopup renders the waterfall with in/recurring/one-time/net", () => {
    render(<CashFlowWaterfallPopup open onOpenChange={noop} monthLabel="JUL"
      cashIn={35500} spendMtd={789} recurringOut={6822}
      incomes={[{ id: "i1", name: "Salary", amount: 30000, frequency: "monthly" }]}
      spendByCategory={{ food: 434 }} />);
    const el = screen.getByTestId("popup-cashflow-waterfall");
    expect(el.textContent).toContain("Cash Flow · JUL");
    // net = 35500 - (789 + 6822) = 27889
    expect(el.textContent).toContain("+$27,889");
    expect(el.textContent).toContain("RECURRING");
    expect(el.textContent).toContain("ONE-TIME");
    expect(el.textContent).toContain("Salary");
    expect(el.textContent).toContain("Money in");
    expect(el.textContent).toContain("Money out");
  });

  it("SpendPopup renders the heat calendar, categories and largest purchases", () => {
    const day = new Date().toISOString().slice(0, 10);
    render(<SpendPopup open onOpenChange={noop} monthLabel="JUL" spendMtd={789}
      spendTrendPct={57} spendByCategory={{ food: 434, transport: 200 }}
      monthExpenses={[
        { id: "e1", description: "Groceries run", category: "food", amount: 434, date: day },
        { id: "e2", description: "Gas", category: "transport", amount: 200, date: day },
      ]} />);
    const el = screen.getByTestId("popup-spend");
    expect(el.textContent).toContain("$789");
    expect(el.textContent).toContain("57% vs last month");
    expect(el.textContent).toContain("Spending heatmap");
    expect(el.textContent).toContain("Where it went");
    expect(el.textContent).toContain("food");
    expect(el.textContent).toContain("Largest purchases");
    expect(el.textContent).toContain("Groceries run");
  });

  it("IncomePopup renders sources with monthly amounts and shares", () => {
    render(<IncomePopup open onOpenChange={noop} monthlyIncome={35500}
      incomes={[
        { id: "i1", name: "Salary", amount: 30000, frequency: "monthly" },
        { id: "i2", source: "Freelance", amount: 2800, frequency: "monthly" },
      ]} />);
    const el = screen.getByTestId("popup-income");
    expect(el.textContent).toContain("$35,500");
    expect(el.textContent).toContain("/ year");
    expect(el.textContent).toContain("Salary");
    expect(el.textContent).toContain("Freelance");
    expect(screen.getByTestId("income-source-i1").textContent).toContain("$30,000");
    expect(el.textContent).toContain("% of income");
  });

  it("BillsDuePopup groups bills on the timeline and Pay fires the callback", () => {
    const onPayBill = vi.fn();
    render(<BillsDuePopup open onOpenChange={noop} onPayBill={onPayBill} payingId={null}
      bills={[
        { id: "b1", name: "Rent", amount: 2500, daysUntil: -2, status: "overdue", dueDate: "2026-07-18" },
        { id: "b2", name: "Electric bill", amount: 140, daysUntil: 3, status: "upcoming", dueDate: "2026-07-23" },
        { id: "b3", name: "Car Insurance", amount: 350, daysUntil: 12, status: "upcoming", dueDate: "2026-08-01" },
      ] as any} />);
    const el = screen.getByTestId("popup-bills");
    expect(el.textContent).toContain("Overdue");
    expect(el.textContent).toContain("Next 7 days");
    expect(el.textContent).toContain("Later this month");
    expect(el.textContent).toContain("Rent");
    expect(el.textContent).toContain("$2,990"); // header total
    fireEvent.click(screen.getByTestId("bill-pay-b2"));
    expect(onPayBill).toHaveBeenCalledWith(expect.objectContaining({ id: "b2" }));
  });

  it("SavingsRatePopup renders the gauge, equation and active band", () => {
    render(<SavingsRatePopup open onOpenChange={noop} incomeMtd={35500} spendMtd={789} />);
    const el = screen.getByTestId("popup-savings");
    // (35500-789)/35500 ≈ 98%
    expect(el.textContent).toContain("98%");
    expect(el.textContent).toContain("Income");
    expect(el.textContent).toContain("Kept");
    expect(el.textContent).toContain("Exceptional");
    expect(el.textContent).toContain("← you");
    // yearly projection = saved × 12
    expect(el.textContent).toContain("$416,532");
  });

  it("SavingsRatePopup shows the overspending band for a negative rate", () => {
    render(<SavingsRatePopup open onOpenChange={noop} incomeMtd={1000} spendMtd={1500} />);
    const el = screen.getByTestId("popup-savings");
    expect(el.textContent).toContain("-50%");
    expect(el.textContent).toContain("Spending more than you earn");
  });

  it("CashFlowOverviewPopup renders donut totals and the month table", () => {
    render(<CashFlowOverviewPopup open onOpenChange={noop} monthLabel="JUL"
      cashIn={35500} cashOut={7611}
      cashTrend={[
        { month: "Jun", inflow: 35500, outflow: 9000, net: 26500 },
        { month: "Jul", inflow: 35500, outflow: 7611, net: 27889 },
      ]} />);
    const el = screen.getByTestId("popup-cashflow-overview");
    expect(el.textContent).toContain("Cash Flow Overview");
    expect(el.textContent).toContain("$35,500");
    expect(el.textContent).toContain("$7,611");
    expect(el.textContent).toContain("+$27,889");
    expect(el.textContent).toContain("6-month flow");
    expect(el.textContent).toContain("Jun");
  });

  it("popups are not in the DOM when closed", () => {
    render(<SavingsRatePopup open={false} onOpenChange={noop} incomeMtd={1} spendMtd={0} />);
    expect(screen.queryByTestId("popup-savings")).toBeNull();
  });
});
