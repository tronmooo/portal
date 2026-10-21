// Profile detail → Loan / Finances numbers must agree with the payoff chart
// and the liability page (2026-10-21).
//  - The amortization schedule starts at today's balance and the next due date,
//    so every row is a payment still to make. The Loan tab used to slice off
//    "months since the loan started" as already paid: "33 months left" next to
//    a schedule (and payoff chart) with 45 payments left.
//  - Finances "Outstanding" hand-picked three balance fields instead of the one
//    resolver (sync rule 1), missing currentBalance.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "../client/src/pages/profile-detail.tsx"), "utf8");

describe("profile detail loan numbers", () => {
  it("treats the whole schedule as remaining — never slices it by months since the start", () => {
    expect(src).not.toMatch(/schedule\.slice\(0,\s*monthsElapsed\)/);
    expect(src).not.toMatch(/schedule\.slice\(monthsElapsed\)/);
    expect(src).not.toMatch(/row\.month <= monthsElapsed/);
    expect(src).toContain("const remainingSlice = schedule;");
  });

  it("derives principal paid from the original amount, not from a guessed number of payments", () => {
    expect(src).toMatch(/const principalPaid = originalAmount > loanBalance \? originalAmount - loanBalance : 0;/);
  });

  it("reads Outstanding through resolveLiabilityBalance", () => {
    expect(src).toMatch(/const outstanding =\s*\n(\s*\/\/[^\n]*\n)*\s*resolveLiabilityBalance\(profile\)/);
  });
});
