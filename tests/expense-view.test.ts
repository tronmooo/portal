import { describe, it, expect } from "vitest";
import { matchesExpenseSearch, sortExpenses } from "../shared/expense-view";

// The user reported the Expenses page was "out of order" and had "no filter /
// no search". These pin the toolbar semantics so they can't silently regress.

const E = (over: Partial<{ description: string; vendor: string; category: string; amount: number; date: string }>) => ({
  description: "", vendor: "", category: "general", amount: 0, date: "2026-01-01", ...over,
});

describe("matchesExpenseSearch", () => {
  it("matches everything on empty / whitespace query", () => {
    const e = E({ description: "Coffee" });
    expect(matchesExpenseSearch(e, "")).toBe(true);
    expect(matchesExpenseSearch(e, "   ")).toBe(true);
  });

  it("matches on description, vendor, and category, case-insensitively", () => {
    expect(matchesExpenseSearch(E({ description: "Groceries" }), "groc")).toBe(true);
    expect(matchesExpenseSearch(E({ vendor: "Whole Foods" }), "whole")).toBe(true);
    expect(matchesExpenseSearch(E({ category: "Transport" }), "transp")).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(matchesExpenseSearch(E({ description: "Coffee", vendor: "Starbucks", category: "food" }), "rent")).toBe(false);
  });

  it("tolerates null/undefined fields", () => {
    expect(matchesExpenseSearch({ description: null, vendor: undefined, category: null }, "x")).toBe(false);
    expect(matchesExpenseSearch({}, "")).toBe(true);
  });
});

describe("sortExpenses", () => {
  const a = E({ description: "Apple", amount: 10, date: "2026-06-24" });
  const b = E({ description: "Banana", amount: 200, date: "2026-06-30" });
  const c = E({ description: "Cherry", amount: 50, date: "2026-06-03" });
  const list = [a, b, c];

  it("date-desc puts newest first (the default fix)", () => {
    expect(sortExpenses(list, "date-desc").map(x => x.date)).toEqual(["2026-06-30", "2026-06-24", "2026-06-03"]);
  });

  it("date-asc puts oldest first", () => {
    expect(sortExpenses(list, "date-asc").map(x => x.date)).toEqual(["2026-06-03", "2026-06-24", "2026-06-30"]);
  });

  it("amount-desc / amount-asc order by magnitude", () => {
    expect(sortExpenses(list, "amount-desc").map(x => x.amount)).toEqual([200, 50, 10]);
    expect(sortExpenses(list, "amount-asc").map(x => x.amount)).toEqual([10, 50, 200]);
  });

  it("name-asc orders alphabetically by description", () => {
    expect(sortExpenses([c, a, b], "name-asc").map(x => x.description)).toEqual(["Apple", "Banana", "Cherry"]);
  });

  it("date sorts tie-break on description (stable, not jumbled)", () => {
    const x = E({ description: "Zebra", date: "2026-06-30" });
    const y = E({ description: "Ant", date: "2026-06-30" });
    // same date → descending tie-break: Zebra before Ant
    expect(sortExpenses([y, x], "date-desc").map(e => e.description)).toEqual(["Zebra", "Ant"]);
  });

  it("does not mutate the input array", () => {
    const input = [b, a, c];
    const snapshot = input.slice();
    sortExpenses(input, "amount-desc");
    expect(input).toEqual(snapshot);
  });
});
