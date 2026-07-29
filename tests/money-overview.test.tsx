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
    // Asset/liability rows are individually addressable (navigate to profile).
    expect(screen.getByTestId("money-asset-a1")).toBeTruthy();
    expect(screen.getByTestId("money-liability-l1")).toBeTruthy();
  });

  // ── Audit 2026-07-29, finding D1 ───────────────────────────────────────────
  // "The same record shows different money on different pages": the balance
  // sheet said $250,000 for a house whose own profile page says $500,000. Both
  // were right — the sheet applies a 50% ownership share — but the screen never
  // said so, leaving "what is my house worth?" with two answers.
  describe("ownership share (D1)", () => {
    it("says whose share it is showing when a row is ownership-adjusted", () => {
      render(<MoneyOverview {...baseProps} assets={250000}
        assetBreakdown={[{ id: "h1", name: "House", type: "property", value: 250000, grossValue: 500000, share: 50 }]} />);
      const row = screen.getByTestId("money-asset-h1").textContent || "";
      // The share-adjusted amount stays the headline figure...
      expect(row).toContain("$250,000");
      // ...but the full value it derives from is now on screen next to it.
      expect(row).toContain("your 50% of $500,000");
    });

    it("labels a partially-owned liability the same way", () => {
      render(<MoneyOverview {...baseProps} liabilities={174444}
        liabilityBreakdown={[{ id: "m1", name: "Mike's House Mortgage", type: "mortgage", value: 174444, grossValue: 348889, share: 50 }]} />);
      expect(screen.getByTestId("money-liability-share-m1").textContent).toContain("your 50% of $348,889");
    });

    it("stays quiet for a wholly-owned row", () => {
      render(<MoneyOverview {...baseProps}
        assetBreakdown={[{ id: "a1", name: "Brokerage", type: "investment", value: 52600, grossValue: 52600, share: 100 }]} />);
      expect(screen.queryByTestId("money-asset-share-a1")).toBeNull();
    });

    it("stays quiet when the server sent no share at all", () => {
      // Pre-ownership snapshots and unfiltered household totals legitimately
      // omit `share`; absent must not be read as "partially owned".
      render(<MoneyOverview {...baseProps}
        assetBreakdown={[{ id: "a1", name: "Brokerage", type: "investment", value: 52600 }]} />);
      expect(screen.queryByTestId("money-asset-share-a1")).toBeNull();
    });
  });

  // ── Audit 2026-07-29, finding D2 ───────────────────────────────────────────
  // "Totals don't match their own rows": the header claimed $349,271 of
  // liabilities while the eight rows beneath summed to $349,048 — a $223 gap
  // with no "other" line and no footnote, because the list was silently capped
  // at 8. A count is the length of the list it labels.
  describe("total reconciles with rows (D2)", () => {
    const manyLiabilities = [
      { id: "l1", name: "Mortgage", type: "mortgage", value: 174444 },
      { id: "l2", name: "Cabin Mortgage", type: "mortgage", value: 125000 },
      { id: "l3", name: "Auto Loan", type: "auto", value: 17100 },
      { id: "l4", name: "Truck Loan", type: "auto", value: 15000 },
      { id: "l5", name: "Card — Visa", type: "credit", value: 6800 },
      { id: "l6", name: "Card — Amex", type: "credit", value: 4200 },
      { id: "l7", name: "Student Loan", type: "student", value: 3600 },
      { id: "l8", name: "Tires Financing", type: "other", value: 2904 },
      { id: "l9", name: "Dental Plan", type: "other", value: 148 },
      { id: "l10", name: "Gym Contract", type: "other", value: 75 },
    ];
    const grandTotal = manyLiabilities.reduce((s, r) => s + r.value, 0); // 349,271

    it("accounts for every dollar of the header total on screen", () => {
      render(<MoneyOverview {...baseProps} liabilities={grandTotal} liabilityBreakdown={manyLiabilities} />);
      const card = screen.getByTestId("money-liabilities").textContent || "";
      expect(card).toContain("$349,271");
      // The two rows past the cap are no longer invisible: they are summarised
      // as a labelled remainder worth exactly the gap the audit measured.
      const remainder = screen.getByTestId("money-liabilities-remainder").textContent || "";
      expect(remainder).toContain("+2 more items");
      expect(remainder).toContain("$223");
    });

    it("labels the card with the true number of items, not the number rendered", () => {
      render(<MoneyOverview {...baseProps} liabilities={grandTotal} liabilityBreakdown={manyLiabilities} />);
      expect(screen.getByTestId("money-liabilities").textContent).toContain("10 items");
    });

    it("adds no remainder row when everything already fits", () => {
      render(<MoneyOverview {...baseProps} liabilityBreakdown={manyLiabilities.slice(0, 8)} />);
      expect(screen.queryByTestId("money-liabilities-remainder")).toBeNull();
    });

    it("opens the full balance sheet from the remainder row", () => {
      const onOpenNetWorth = vi.fn();
      render(<MoneyOverview {...baseProps} liabilityBreakdown={manyLiabilities} onOpenNetWorth={onOpenNetWorth} />);
      fireEvent.click(screen.getByTestId("money-liabilities-remainder"));
      expect(onOpenNetWorth).toHaveBeenCalled();
    });
  });

  // ── Audit 2026-07-29, finding P1 ───────────────────────────────────────────
  // The trigger was labelled "Pay" — a neutral outline button on a summary card
  // that read as navigation and behaved as a financial commit. It records that
  // a payment happened; it does not move money. The label now says which.
  it("labels the bill action for what it actually does (P1)", () => {
    render(<MoneyOverview {...baseProps} />);
    const btn = screen.getByTestId("money-pay-b1");
    expect(btn.textContent).toBe("Mark paid");
    expect(btn.textContent).not.toBe("Pay");
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
