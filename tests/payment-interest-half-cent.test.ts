// $18,300 at 3.9%: a month's interest is exactly $59.475, which a lender
// charges as $59.48. Float arithmetic computes 59.474999999999994 and the old
// rounding (+Number.EPSILON) gave $59.47, so the ledger, the balance and the
// month's spending were each a cent off the independent oracle
// (money.loan-payments, GitHub isolated run, 2026-11-28).
import { describe, it, expect } from "vitest";
import { allocatePayment, roundCents } from "../shared/liability-calc";

describe("a month's interest is rounded half up as written in decimal", () => {
  it("$18,300 at 3.9% charges $59.48 and $440.52 of a $500 payment is principal", () => {
    const a = allocatePayment(500, 18300, 3.9);
    expect(a.interest).toBe(59.48);
    expect(a.principal).toBe(440.52);
    expect(a.remainingBalanceAfter).toBe(17859.48);
    expect(a.interest + a.principal).toBeCloseTo(500, 10);
  });
  it("roundCents rounds the decimal half up and keeps exact cents", () => {
    expect(roundCents(59.474999999999994)).toBe(59.48);
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents(60 - 0.17)).toBe(59.83);
    expect(roundCents(59.4749)).toBe(59.47);
    expect(roundCents(0)).toBe(0);
  });
});
