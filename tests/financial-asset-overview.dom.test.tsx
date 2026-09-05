// @vitest-environment jsdom
// The adaptive financial-asset Overview: one account profile page, several
// genuinely different screens, chosen by the account's KIND.
//
//   brokerage / retirement / crypto → the investment dashboard (portfolio
//     value, performance, holdings, allocation, activity)
//   checking / savings              → the bank overview (balance, cash flow,
//     balance history)
//   credit card                     → the debt card (owed, limit, utilization)
//
// Every assertion is comparative where it matters: the point is that a
// checking account and a brokerage do NOT render the same screen.

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { FinancialAssetOverview, financialHeroStats } from "../client/src/components/finance/FinancialAssetOverview";
import { financialCardSummary } from "../client/src/components/finance/FinancialAssetCard";
import { describeAccountDeletion } from "../client/src/components/finance/AccountsSection";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomains: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: () => ({ data: [] }),
}));
vi.mock("wouter", () => ({ Link: ({ children }: any) => <>{children}</> }));

afterEach(cleanup);

// recharts' ResponsiveContainer measures itself with ResizeObserver, which
// jsdom does not have. A no-op is enough: the chart's presence, not its
// pixels, is what these tests assert.
if (typeof (globalThis as any).ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const TODAY = "2026-09-05";

function account(kind: string, over: Record<string, any> = {}) {
  return {
    id: `acct-${kind}`,
    type: "account",
    type_key: kind,
    name: `My ${kind}`,
    fields: { accountKind: kind, balance: 1000, currentBalance: 1000, currentValue: 1000, balanceAsOf: TODAY, currency: "usd", ...over },
  };
}

const SNAPSHOTS = [
  { id: "a", at: "2026-01-05T00:00:00.000Z", date: "2026-01-05", balance: 20000, source: "user" },
  { id: "b", at: "2026-06-01T00:00:00.000Z", date: "2026-06-01", balance: 22000, source: "api" },
  { id: "c", at: "2026-08-20T00:00:00.000Z", date: "2026-08-20", balance: 23000, source: "api" },
];

const brokerage = account("brokerage", {
  institution: "Fidelity", balance: 24830, currentBalance: 24830, currentValue: 24830,
  balanceSnapshots: SNAPSHOTS,
  holdings: [
    { id: "h1", symbol: "AAPL", name: "Apple", quantity: 10, price: 200, value: 2000, costBasis: 1500, assetClass: "equity", source: "user" },
    { id: "h2", symbol: "VTI", name: "Vanguard Total", value: 12000, costBasis: 11000, assetClass: "etf", source: "user" },
  ],
  investmentActivity: [
    { id: "x1", date: "2026-08-01", kind: "contribution", amount: 500, source: "user", createdAt: "2026-08-01T00:00:00.000Z" },
    { id: "x2", date: "2026-08-15", kind: "dividend", amount: 12.5, symbol: "VTI", source: "user", createdAt: "2026-08-15T00:00:00.000Z" },
  ],
});
const checking = account("checking", {
  institution: "Chase", balance: 2400, currentBalance: 2400, currentValue: 2400, accountNumberLast4: "4821",
  balanceHistory: [
    { id: "1", date: "2026-08-10", previousBalance: 2000, newBalance: 3000, delta: 1000, reason: "Paycheck", source: "user", createdAt: "2026-08-10T00:00:00.000Z" },
    { id: "2", date: "2026-08-20", previousBalance: 3000, newBalance: 2400, delta: -600, reason: "Rent", source: "payment", createdAt: "2026-08-20T00:00:00.000Z" },
  ],
});
const amex = account("credit_card", { institution: "American Express", balance: 900, currentBalance: 900, creditLimit: 10000, currentValue: undefined });
const wallet = account("crypto", { institution: "Coinbase", balance: 8400, currentBalance: 8400, currentValue: 8400 });

describe("FinancialAssetOverview picks the layout from the account kind", () => {
  it("a brokerage gets the investment dashboard: value, performance, holdings, allocation, activity", () => {
    render(<FinancialAssetOverview profile={brokerage} todayISO={TODAY} />);
    expect(screen.getByTestId("financial-asset-overview-investment")).toBeTruthy();
    expect(screen.getByTestId("investment-dashboard")).toBeTruthy();
    expect(screen.getByTestId("account-balance").textContent).toContain("$24,830");
    expect(screen.getByTestId("balance-history-chart")).toBeTruthy();
    expect(screen.getByTestId("history-period-selector")).toBeTruthy();
    expect(screen.getByTestId("account-holdings")).toBeTruthy();
    expect(screen.getByTestId("account-allocation")).toBeTruthy();
    expect(screen.getByTestId("holdings-gain").textContent).toContain("$1,500");
    expect(screen.getByTestId("stat-contributions").textContent).toContain("$500");
    expect(screen.getByTestId("stat-dividends").textContent).toContain("$12.50");
    expect(screen.getByTestId("account-activity-list")).toBeTruthy();
    expect(screen.getByTestId("btn-transfer")).toBeTruthy();
    // The account card below renders without a second balance headline.
    expect(screen.getAllByTestId("account-balance")).toHaveLength(1);
  });

  it("a crypto wallet gets the same dashboard in crypto vocabulary", () => {
    render(<FinancialAssetOverview profile={wallet} todayISO={TODAY} />);
    expect(screen.getByTestId("financial-asset-overview-crypto")).toBeTruthy();
    expect(screen.getByText(/Positions/)).toBeTruthy();
    expect(screen.getByTestId("btn-add-holding").textContent).toContain("Add position");
    // One observation only: the chart says so instead of drawing a flat line.
    expect(screen.getByTestId("balance-history-empty")).toBeTruthy();
  });

  it("a checking account gets the bank overview: balance card, cash flow, no holdings", () => {
    render(<FinancialAssetOverview profile={checking} todayISO={TODAY} />);
    expect(screen.getByTestId("financial-asset-overview-bank")).toBeTruthy();
    expect(screen.getByTestId("bank-overview")).toBeTruthy();
    expect(screen.getByTestId("account-overview")).toBeTruthy();
    expect(screen.getByTestId("account-balance").textContent).toContain("$2,400");
    expect(screen.getByTestId("account-cash-flow").textContent).toContain("$1,000");
    expect(screen.getByTestId("account-cash-flow").textContent).toContain("$600");
    expect(screen.queryByTestId("investment-dashboard")).toBeNull();
    expect(screen.queryByTestId("account-holdings")).toBeNull();
    expect(screen.getByTestId("btn-record-activity").textContent).toContain("Deposit / withdrawal");
    // The adjustment ledger graphs: two adjustments + current = a chart.
    expect(screen.getByTestId("balance-history-chart")).toBeTruthy();
  });

  it("a credit card keeps the debt card and never the investment dashboard", () => {
    render(<FinancialAssetOverview profile={amex} todayISO={TODAY} />);
    expect(screen.getByTestId("financial-asset-overview-debt")).toBeTruthy();
    expect(screen.getByText("Balance owed")).toBeTruthy();
    expect(screen.getByTestId("account-utilization")).toBeTruthy();
    expect(screen.queryByTestId("investment-dashboard")).toBeNull();
    expect(screen.queryByTestId("bank-overview")).toBeNull();
  });

  it("the three layouts render genuinely different screens", () => {
    const texts: string[] = [];
    for (const p of [brokerage, checking, amex]) {
      cleanup();
      const { container } = render(<FinancialAssetOverview profile={p} todayISO={TODAY} />);
      texts.push(container.textContent || "");
    }
    expect(new Set(texts).size).toBe(3);
  });

  it("a connected account says so, and a possible duplicate asks", () => {
    const connected = account("checking", {
      connection: { provider: "stripe_financial_connections", status: "active", lastSyncAt: "2026-09-05T08:00:00.000Z" },
      possibleDuplicateOf: { profileId: "acct-other", name: "Chase Total Checking", score: 0.6, reasons: ["both at chase"] },
    });
    render(<FinancialAssetOverview profile={connected} todayISO={TODAY} />);
    expect(screen.getByTestId("account-connection-badge").textContent).toMatch(/Connected/);
    expect(screen.getByTestId("account-possible-duplicate").textContent).toMatch(/Chase Total Checking/);
    cleanup();
    const gone = account("checking", { connection: { provider: "stripe_financial_connections", status: "disconnected" } });
    render(<FinancialAssetOverview profile={gone} todayISO={TODAY} />);
    expect(screen.getByTestId("account-connection-badge").textContent).toMatch(/Disconnected · history kept/);
  });
});

describe("cards and hero tiles derive from the same model", () => {
  it("the Assets-tab card shows institution, gain/loss and a month change for a brokerage", () => {
    const s = financialCardSummary(brokerage, TODAY);
    expect(s.layout).toBe("investment");
    expect(s.meta.map((m) => m.label)).toEqual(["Institution", "Gain / loss"]);
    // The 1M window opens on Aug 5, when the balance in force was the $22,000
    // observed on Jun 1 → $24,830 today.
    expect(s.change).toBe(2830);
    expect(s.series.length).toBeGreaterThanOrEqual(4);
    expect(s.freshness).toBe("updated today");
  });
  it("…and cash flow for a checking account", () => {
    const s = financialCardSummary(checking, TODAY);
    expect(s.layout).toBe("bank");
    expect(s.meta.map((m) => m.label)).toEqual(["Institution", "30-day flow"]);
    expect(s.meta[1].value).toMatch(/^\+\$400/);
  });
  it("hero tiles add the month change and the holdings count", () => {
    const stats = financialHeroStats(brokerage, TODAY);
    expect(stats.map((s) => s.label)).toEqual(["1M change", "Holdings"]);
    expect(stats[0].value).toMatch(/^\+\$2,830/);
    expect(stats[1].value).toBe("2");
    expect(financialHeroStats(amex, TODAY)).toEqual([]);
  });
  it("deleting names what goes with the account", () => {
    const lines = describeAccountDeletion(brokerage);
    expect(lines.join(" | ")).toMatch(/3 balance observations/);
    expect(lines.join(" | ")).toMatch(/2 holdings/);
    expect(lines.join(" | ")).toMatch(/2 activity rows/);
    const connected = account("checking", { connection: { provider: "stripe_financial_connections", status: "active" } });
    expect(describeAccountDeletion(connected).join(" | ")).toMatch(/will not recreate/);
  });
});
