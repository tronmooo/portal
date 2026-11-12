/**
 * A chat confirmation writes money as money (2026-11-12): "I spent $42.50 on
 * groceries" was confirmed as "Added expense: Groceries — $42.5".
 */
import { describe, it, expect } from "vitest";
import { recapMoney, summarizeOpDetail } from "../server/ai-bulk-log";

describe("recapMoney", () => {
  it.each([
    [42.5, "$42.50"],
    [42, "$42"],
    [1200, "$1,200"],
    [1234.5, "$1,234.50"],
    [0.99, "$0.99"],
    ["42.5", "$42.50"],
    ["$1,200", "$1,200"],
    [-20, "-$20"],
  ])("%j → %s", (input, expected) => {
    expect(recapMoney(input)).toBe(expected);
  });
  it("echoes what it cannot read rather than inventing a number", () => {
    expect(recapMoney("about fifty")).toBe("$about fifty");
  });
});

describe("the recap line of an expense", () => {
  it("carries two decimals", () => {
    expect(summarizeOpDetail({ description: "Groceries", amount: 42.5 })).toBe("$42.50");
  });
});
