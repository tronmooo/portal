// Consistency layer — fixed/variable classification (req. test 16).
import { describe, expect, it } from "vitest";
import { getPaymentClassification, isFixedPayment } from "../shared/domain";

describe("16. The same payment has the same fixed/variable classification everywhere", () => {
  const netflix = { name: "Netflix", type: "liability", type_key: "streaming", fields: { billingModel: "fixed", monthlyAmount: 15.49 } };
  const electric = { name: "Electric", type: "liability", type_key: "utility", fields: { billingModel: "variable" } };
  const loan = { name: "Auto Loan", type: "liability", type_key: "auto_loan", fields: {} };
  it("one function, one answer, regardless of which page asks", () => {
    const surfaces = ["liability page", "finance page", "dashboard", "chat", "notifications"];
    const answers = surfaces.map(() => getPaymentClassification(netflix).classification);
    expect(new Set(answers)).toEqual(new Set(["fixed"]));
    expect(getPaymentClassification(electric).label).toBe("Variable");
    // A recurring service bill with fixed billing is Fixed even though its FAMILY is not amortizing.
    expect(isFixedPayment(netflix)).toBe(true);
    expect(getPaymentClassification(loan)).toMatchObject({ classification: "fixed", billingModel: "installment" });
  });
  it("an obligation row that carries billingModel at the top level classifies the same", () => {
    expect(getPaymentClassification({ billingModel: "usage_based" }).classification).toBe("variable");
    expect(getPaymentClassification({ billingModel: "fixed" }).classification).toBe("fixed");
  });
});
