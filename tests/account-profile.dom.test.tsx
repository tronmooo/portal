// @vitest-environment jsdom
// Creating one account profile of EVERY kind, and checking each one actually
// renders as its own thing.
//
// The complaint this answers: an account profile opened the generic asset page,
// so a credit card, a brokerage and a checking account were three identical
// screens showing a name and nothing else. "Different asset profiles should
// have different details."
//
// So every assertion here is comparative — not "does a field render" but "does
// THIS kind show something the others don't". A test that only checked one kind
// would have passed against the broken version.

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { AccountOverview, accountHeroStats } from "../client/src/components/finance/AccountOverview";
import { profileVisual } from "../client/src/lib/profile-visuals";
import { ACCOUNT_KINDS, toAccountView, type AccountKind } from "@shared/finance-accounts";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomains: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

afterEach(cleanup);

const TODAY = "2026-08-11";

/** One account profile per kind, shaped exactly as createAccount writes them. */
function makeAccount(kind: AccountKind, over: Record<string, any> = {}) {
  return {
    id: `acct-${kind}`,
    type: "account",
    type_key: kind,
    name: `My ${kind}`,
    fields: {
      accountKind: kind,
      balance: 1000, currentBalance: 1000,
      balanceAsOf: TODAY,
      currency: "usd",
      balanceHistory: [],
      ...over,
    },
  };
}

// The eight kinds the product promises, built the way a user would build them.
const ACCOUNTS = {
  checking: makeAccount("checking", { balance: 2400, currentBalance: 2400, institution: "Chase", accountNumberLast4: "4821" }),
  savings: makeAccount("savings", { balance: 10000, currentBalance: 10000, institution: "Ally" }),
  cash: makeAccount("cash", { balance: 300, currentBalance: 300 }),
  investment: makeAccount("investment", { balance: 45000, currentBalance: 45000, institution: "Fidelity" }),
  credit_card: makeAccount("credit_card", { balance: 2000, currentBalance: 2000, creditLimit: 10000, institution: "American Express", accountNumberLast4: "1007" }),
  line_of_credit: makeAccount("line_of_credit", { balance: 15000, currentBalance: 15000, creditLimit: 50000, institution: "Wells Fargo" }),
  loan: makeAccount("loan", { balance: 18400, currentBalance: 18400, institution: "Toyota Financial" }),
  other: makeAccount("other", { balance: 750, currentBalance: 750 }),
} as const;

const ALL = Object.values(ACCOUNTS);

describe("every account kind exists and is distinguishable", () => {
  it("covers all eight kinds the product promises", () => {
    expect(ACCOUNT_KINDS.map(k => k.key).sort()).toEqual([
      "cash", "checking", "credit_card", "investment",
      "line_of_credit", "loan", "other", "savings",
    ]);
    // Every kind has a fixture, so nothing below is untested by omission.
    expect(Object.keys(ACCOUNTS).sort()).toEqual(ACCOUNT_KINDS.map(k => k.key).sort());
  });

  it("gives each kind its own label rather than the bare type", () => {
    const labels = ALL.map(a => toAccountView(a).kindLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain("account");
    expect(toAccountView(ACCOUNTS.credit_card).kindLabel).toBe("Credit card");
    expect(toAccountView(ACCOUNTS.investment).kindLabel).toBe("Investment / brokerage");
  });

  it("paints kinds with different icons, not one generic bank glyph", () => {
    const icons = ALL.map(a => profileVisual(a).icon);
    // Checking / savings / cash / investment / credit / loan / other must not
    // all collapse to a single glyph — that was the bug.
    expect(new Set(icons).size).toBeGreaterThan(4);
    expect(profileVisual(ACCOUNTS.checking).icon)
      .not.toBe(profileVisual(ACCOUNTS.credit_card).icon);
    expect(profileVisual(ACCOUNTS.savings).icon)
      .not.toBe(profileVisual(ACCOUNTS.investment).icon);
  });

  it("colours money held green and money owed red", () => {
    expect(profileVisual(ACCOUNTS.credit_card).accent).toBe("0 72% 55%");
    expect(profileVisual(ACCOUNTS.loan).accent).toBe("0 72% 55%");
    expect(profileVisual(ACCOUNTS.checking).accent).not.toBe(profileVisual(ACCOUNTS.credit_card).accent);
  });

  it("falls back to the generic account visual when handed only a type string", () => {
    // The old call signature still has callers (grids that know a type but not
    // a row), and it must not throw or return undefined.
    expect(profileVisual("account").icon).toBeTruthy();
    expect(profileVisual("vehicle").icon).not.toBe(profileVisual("account").icon);
  });
});

describe("the account profile page renders each kind's own details", () => {
  it("leads a cash account with its balance and no debt language", () => {
    render(<AccountOverview profile={ACCOUNTS.checking} todayISO={TODAY} />);
    expect(screen.getByTestId("account-kind-badge").textContent).toContain("Checking");
    expect(screen.getByTestId("account-balance").textContent).toContain("$2,400");
    expect(screen.getByTestId("account-balance").textContent).not.toContain("−");
    expect(screen.getByText("Current balance")).toBeTruthy();
    expect(screen.queryByText("Balance owed")).toBeNull();
    expect(screen.getByTestId("account-institution").textContent).toContain("Chase");
    expect(screen.getByTestId("account-last-four").textContent).toContain("4821");
  });

  it("leads a credit card with what is OWED, plus limit and utilization", () => {
    render(<AccountOverview profile={ACCOUNTS.credit_card} todayISO={TODAY} />);
    expect(screen.getByText("Balance owed")).toBeTruthy();
    expect(screen.getByTestId("account-balance").textContent).toContain("−");
    expect(screen.getByTestId("account-credit-limit").textContent).toContain("$10,000");
    // 2000 / 10000 = 20%, derived — the user never typed it.
    expect(screen.getByTestId("account-utilization").textContent).toContain("20%");
    expect(screen.getByTestId("account-available").textContent).toContain("$8,000");
    expect(screen.getByTestId("account-utilization-bar")).toBeTruthy();
  });

  it("shows NO credit limit or utilization on kinds that have none", () => {
    // The point of the kind-aware layout: a checking account must not render
    // an empty "Credit limit —" row.
    for (const kind of ["checking", "savings", "cash", "investment", "loan", "other"] as const) {
      cleanup();
      render(<AccountOverview profile={ACCOUNTS[kind]} todayISO={TODAY} />);
      expect(screen.queryByTestId("account-credit-limit"), `${kind} showed a credit limit`).toBeNull();
      expect(screen.queryByTestId("account-utilization"), `${kind} showed utilization`).toBeNull();
      expect(screen.queryByTestId("account-utilization-bar"), `${kind} drew a utilization bar`).toBeNull();
    }
  });

  it("treats a line of credit like a card, and a loan account like a debt with no line", () => {
    render(<AccountOverview profile={ACCOUNTS.line_of_credit} todayISO={TODAY} />);
    expect(screen.getByTestId("account-utilization").textContent).toContain("30%"); // 15k/50k
    expect(screen.getByTestId("account-available").textContent).toContain("$35,000");
    cleanup();
    render(<AccountOverview profile={ACCOUNTS.loan} todayISO={TODAY} />);
    expect(screen.getByText("Balance owed")).toBeTruthy();
    expect(screen.queryByTestId("account-credit-limit")).toBeNull();
  });

  it("omits an institution row when the account has none", () => {
    render(<AccountOverview profile={ACCOUNTS.cash} todayISO={TODAY} />);
    expect(screen.queryByTestId("account-institution")).toBeNull();
    expect(screen.getByTestId("account-balance").textContent).toContain("$300");
  });

  it("renders a genuinely different card for every kind", () => {
    // The regression guard: dump each kind's rendered text and require that no
    // two are identical. Against the old generic page every one of these was
    // the same screen.
    const seen = new Map<string, string>();
    for (const [kind, profile] of Object.entries(ACCOUNTS)) {
      cleanup();
      const { container } = render(<AccountOverview profile={profile} todayISO={TODAY} />);
      const text = container.textContent || "";
      for (const [otherKind, otherText] of seen) {
        expect(text, `${kind} renders identically to ${otherKind}`).not.toBe(otherText);
      }
      seen.set(kind, text);
    }
    expect(seen.size).toBe(8);
  });
});

describe("balance freshness", () => {
  it("says how stale the balance is, and flags an old one", () => {
    cleanup();
    render(<AccountOverview profile={ACCOUNTS.checking} todayISO={TODAY} />);
    expect(screen.getByTestId("account-as-of").textContent).toContain("updated today");

    cleanup();
    const old = makeAccount("checking", { balanceAsOf: "2026-08-09" });
    render(<AccountOverview profile={old} todayISO={TODAY} />);
    expect(screen.getByTestId("account-as-of").textContent).toContain("2 days ago");

    cleanup();
    const never = makeAccount("checking", { balanceAsOf: undefined });
    render(<AccountOverview profile={never} todayISO={TODAY} />);
    expect(screen.getByTestId("account-as-of").textContent).toContain("never updated");
  });
});

describe("balance history", () => {
  const withHistory = makeAccount("checking", {
    balance: 1850, currentBalance: 1850,
    balanceHistory: [
      { id: "a1", date: "2026-08-01", previousBalance: 2400, newBalance: 2300, delta: -100, reason: "Groceries", source: "user", createdAt: "" },
      { id: "a2", date: "2026-08-05", previousBalance: 2300, newBalance: 1850, delta: -450, reason: "Rent", source: "payment", createdAt: "" },
    ],
  });

  it("shows each change with its reason and the resulting balance", () => {
    render(<AccountOverview profile={withHistory} todayISO={TODAY} />);
    const history = screen.getByTestId("account-balance-history");
    expect(within(history).getByText("Groceries")).toBeTruthy();
    expect(within(history).getByText("Rent")).toBeTruthy();
    expect(history.textContent).toContain("$450");
    expect(history.textContent).toContain("$1,850");
  });

  it("hides the history block entirely when nothing has changed yet", () => {
    render(<AccountOverview profile={ACCOUNTS.cash} todayISO={TODAY} />);
    expect(screen.queryByTestId("account-balance-history")).toBeNull();
  });
});

describe("hero stats", () => {
  it("gives an account real numbers instead of three zero counts", () => {
    // A fresh account has 0 docs, 0 expenses and 0 tasks; DetailHero drops zero
    // tiles, so the old generic builder left the hero empty.
    const stats = accountHeroStats(ACCOUNTS.checking);
    expect(stats.map(s => s.label)).toEqual(["Balance"]);
    expect(stats[0].value).toContain("2,400");
  });

  it("says Owed on a debt account, and adds limit-derived tiles for a card", () => {
    expect(accountHeroStats(ACCOUNTS.loan)[0].label).toBe("Owed");
    const card = accountHeroStats(ACCOUNTS.credit_card);
    expect(card.map(s => s.label)).toEqual(["Owed", "Available credit", "Utilization"]);
    expect(card[2].value).toBe("20%");
  });

  it("omits tiles an account cannot compute", () => {
    // No limit → no available-credit tile and no utilization tile.
    expect(accountHeroStats(ACCOUNTS.cash).map(s => s.label)).toEqual(["Balance"]);
  });
});
