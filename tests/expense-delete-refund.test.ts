/**
 * Deleting an expense that was "Paid from" an account puts the money back
 * (2026-11-12). Add Expense moved the balance down, Edit moved it back and
 * forth, Delete left it lower for good.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expenseRefund } from "../shared/expense-account";

const ACCOUNTS = new Set(["acct-checking"]);

describe("expenseRefund", () => {
  it("returns the amount to the account the expense was paid from", () => {
    expect(expenseRefund({ amount: 100, linkedProfiles: ["self", "acct-checking"], tags: [] }, ACCOUNTS)).toEqual({ accountId: "acct-checking", amount: 100 });
    expect(expenseRefund({ amount: "42.5", linkedProfiles: ["acct-checking"] }, ACCOUNTS)).toEqual({ accountId: "acct-checking", amount: 42.5 });
  });
  it("owes nothing when the expense names no account", () => {
    expect(expenseRefund({ amount: 100, linkedProfiles: ["self"] }, ACCOUNTS)).toBeNull();
    expect(expenseRefund({ amount: 100 }, ACCOUNTS)).toBeNull();
    expect(expenseRefund(null, ACCOUNTS)).toBeNull();
  });
  it("leaves a bill-payment expense to the server, which reverses the payment itself", () => {
    expect(expenseRefund({ amount: 75, linkedProfiles: ["acct-checking"], tags: ["payment:abc"] }, ACCOUNTS)).toBeNull();
    expect(expenseRefund({ amount: 75, linkedProfiles: ["acct-checking"], tags: ["bill-payment"] }, ACCOUNTS)).toBeNull();
  });
  it("never moves a balance by a non-amount", () => {
    for (const amount of [0, -5, NaN, "abc", undefined]) {
      expect(expenseRefund({ amount, linkedProfiles: ["acct-checking"] }, ACCOUNTS)).toBeNull();
    }
  });
});

describe("the Finance page's delete uses it", () => {
  const src = readFileSync(join(__dirname, "../client/src/pages/finance.tsx"), "utf8");
  const del = src.slice(src.indexOf("const paidFrom = expenseRefund("));
  it("returns the amount after the DELETE succeeds, and Undo takes it out again", () => {
    expect(del.length).toBeGreaterThan(100);
    const deleted = del.indexOf('apiRequest("DELETE", `/api/expenses/${targetId}`)');
    const refunded = del.indexOf("{ delta: paidFrom.amount,");
    expect(deleted).toBeGreaterThan(-1);
    expect(refunded).toBeGreaterThan(deleted);
    expect(del).toContain("{ delta: -paidFrom.amount,");
  });
});
