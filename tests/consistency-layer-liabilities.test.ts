// Consistency layer — liabilities vs payments, equity (req. tests 6, 22).
import { describe, expect, it } from "vitest";
import { classifyLiabilityWrite, attachPayment, paymentHistoryOf, assetEquity, depreciation } from "../shared/domain";

const loan = { id: "loan-1", name: "Auto Loan", type: "liability", type_key: "auto_loan", parentProfileId: "ram", fields: { balance: 48000, monthlyPayment: 912.4 } };

describe("6. A payment cannot become a liability when attached to an existing liability", () => {
  it("a $912.40 payment on the auto loan is a payment, not a second liability", () => {
    const d = classifyLiabilityWrite({ name: "Auto Loan payment", amount: 912.4 }, [loan]);
    expect(d.kind).toBe("payment");
    expect(d.targetLiabilityId).toBe("loan-1");
    expect(classifyLiabilityWrite({ name: "$912.40 monthly payment", linkedLiabilityId: "loan-1" }, [loan]).kind).toBe("payment");
  });
  it("a genuinely new debt is a liability", () => {
    expect(classifyLiabilityWrite({ name: "Student Loan", description: "took out a new loan, balance of 20000" }, [loan]).kind).toBe("liability");
  });
  it("the payment lands inside the loan's payment history and moves the balance", () => {
    const patch = attachPayment(loan, { amount: 912.4, date: "2026-09-15" });
    expect(patch.payments).toHaveLength(1);
    expect(patch.balance).toBe(48000 - 912.4);
    const again = attachPayment({ ...loan, fields: { ...loan.fields, ...patch } }, { amount: 912.4, date: "2026-09-15" });
    expect(again.payments).toHaveLength(1); // idempotent
    expect(paymentHistoryOf({ ...loan, fields: { ...loan.fields, ...patch } })[0].amount).toBe(912.4);
  });
});

describe("22. Asset value minus debt produces correct equity", () => {
  it("45,500 − 48,000 = −2,500, shown as negative equity", () => {
    const e = assetEquity(45500, 48000);
    expect(e.equity).toBe(-2500);
    expect(e.negative).toBe(true);
    expect(e.label).toBe("Negative equity");
    expect(e.loanToValue).toBeCloseTo(48000 / 45500, 4);
  });
  it("depreciation from valuation history", () => {
    const d = depreciation([{ date: "2025-09-01", value: 50000 }, { date: "2026-09-01", value: 45500 }]);
    expect(d.direction).toBe("depreciating");
    expect(d.change).toBe(-4500);
    expect(d.annualizedPct).toBeCloseTo(-0.09, 2);
  });
});
