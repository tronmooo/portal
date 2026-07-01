import { describe, it, expect } from "vitest";
import {
  liabilityFamily, countsTowardNetWorth, isAmortizable, isRecurringBill,
} from "../shared/liability-types";
import { isNetWorthLiabilityProfile } from "../shared/asset-value";
import { computeNetWorth } from "../shared/net-worth";

describe("liabilityFamily", () => {
  it("classifies amortizing loans", () => {
    for (const k of ["mortgage", "auto_loan", "student_loan", "personal_loan", "heloc", "loan"])
      expect(liabilityFamily(k)).toBe("amortizing");
  });
  it("classifies revolving credit", () => {
    expect(liabilityFamily("credit_card")).toBe("revolving");
  });
  it("classifies one-time debt", () => {
    expect(liabilityFamily("medical_debt")).toBe("one_time");
    expect(liabilityFamily("tax_debt")).toBe("one_time");
  });
  it("classifies recurring bills", () => {
    for (const k of ["utility", "phone_plan", "streaming", "internet", "software", "subscription", "bill"])
      expect(liabilityFamily(k)).toBe("recurring");
  });
  it("defaults unknown/blank to one_time (never fabricates amortization)", () => {
    expect(liabilityFamily(undefined)).toBe("one_time");
    expect(liabilityFamily("")).toBe("one_time");
    expect(liabilityFamily("weird_new_type")).toBe("one_time");
  });
});

describe("net-worth inclusion", () => {
  it("counts real debt, excludes recurring bills", () => {
    expect(countsTowardNetWorth("mortgage")).toBe(true);
    expect(countsTowardNetWorth("credit_card")).toBe(true);
    expect(countsTowardNetWorth("medical_debt")).toBe(true);
    expect(countsTowardNetWorth("utility")).toBe(false);
    expect(countsTowardNetWorth("streaming")).toBe(false);
    expect(countsTowardNetWorth("phone_plan")).toBe(false);
  });
});

describe("net-worth liability profile filter", () => {
  it("excludes recurring-bill liability profiles from balance-sheet debt", () => {
    // A utility bill stored as a liability profile is NOT balance-sheet debt.
    expect(isNetWorthLiabilityProfile({ type: "liability", type_key: "utility", fields: { balance: 60 } })).toBe(false);
    expect(isNetWorthLiabilityProfile({ type: "liability", type_key: "streaming", fields: { balance: 15 } })).toBe(false);
    // Real debt still counts.
    expect(isNetWorthLiabilityProfile({ type: "liability", type_key: "mortgage", fields: { currentBalance: 300000 } })).toBe(true);
    expect(isNetWorthLiabilityProfile({ type: "liability", type_key: "credit_card", fields: { balance: 1200 } })).toBe(true);
    // A financed car (asset type carrying a loan balance, no liability type_key) still counts.
    expect(isNetWorthLiabilityProfile({ type: "vehicle", fields: { loanBalance: 18000 } })).toBe(true);
  });

  it("computeNetWorth subtracts only real debt, not recurring bills", () => {
    const profiles = [
      { id: "a", type: "asset", fields: { currentValue: 100000 } },
      { id: "m", type: "liability", type_key: "mortgage", fields: { currentBalance: 60000 } },
      { id: "u", type: "liability", type_key: "utility", fields: { balance: 120 } },
      { id: "s", type: "liability", type_key: "streaming", fields: { balance: 15 } },
    ];
    const nw = computeNetWorth(profiles as any, { mode: "everyone", selectedIds: [] });
    expect(nw.assets).toBe(100000);
    expect(nw.liabilities).toBe(60000); // utility + streaming excluded
    expect(nw.netWorth).toBe(40000);
  });
});

describe("behavior guards", () => {
  it("only amortizes loans + credit cards", () => {
    expect(isAmortizable("mortgage")).toBe(true);
    expect(isAmortizable("credit_card")).toBe(true);
    expect(isAmortizable("utility")).toBe(false);       // the $0.17/360mo bug source
    expect(isAmortizable("medical_debt")).toBe(false);
  });
  it("recurring bills advance a due date", () => {
    expect(isRecurringBill("phone_plan")).toBe(true);
    expect(isRecurringBill("mortgage")).toBe(false);
  });
});
