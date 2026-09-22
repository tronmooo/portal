import { describe, it, expect } from "vitest";
import {
  sameLiability, findCanonicalLiability, mergeLiabilityRecords,
  liabilityNameKey, identifiersConflict, identifiersMatch, creditorsConflict,
  classificationRank, preferLiabilityTypeKey, preferLiabilityName,
  reconcileLiabilityPaymentFields, liabilitySubtypeKey, liabilityPaymentShape,
  liabilityIdentifiers, isLiabilityRecord,
} from "../shared/liability-identity";
import { liabilityFamily } from "../shared/liability-types";

// The reported pair (user report 2026-09-22): one debt, two profiles, one
// filed as a fixed liability and one as a variable one.
const loan = {
  id: "loan", name: "Dodge Ram 2025 Auto Loan", type: "liability", type_key: "auto_loan",
  parentProfileId: "self",
  fields: { currentBalance: 47979.70, originalBalance: 54800, monthlyPayment: 912.40, lender: "Capital Auto Finance", dueDay: 30 },
};
const paymentTwin = {
  id: "twin", name: "Dodge Ram 2025 Auto Loan payment", type: "liability", type_key: "bill",
  parentProfileId: "self",
  fields: { monthlyAmount: 912.40, amount: 912.40, frequency: "monthly", category: "liability", source: "obligation", dueDate: "2026-10-30" },
};

describe("name identity", () => {
  it("folds the '… payment' spelling of a debt onto the debt", () => {
    expect(liabilityNameKey("Dodge Ram 2025 Auto Loan payment")).toBe(liabilityNameKey("Dodge Ram 2025 Auto Loan"));
    expect(liabilityNameKey("Water Bill payments")).toBe(liabilityNameKey("Water Bill"));
    expect(liabilityNameKey("Car Loan bill payment")).toBe("car loan");
    expect(liabilityNameKey("  My  Car   Loan ")).toBe("car loan");
  });
  it("does not fold two genuinely different names together", () => {
    expect(liabilityNameKey("First Mortgage")).not.toBe(liabilityNameKey("Second Mortgage"));
  });
});

describe("sameLiability", () => {
  it("recognises the reported duplicate as one liability", () => {
    expect(sameLiability(loan, paymentTwin)).toBe(true);
  });
  it("treats a null parent and the self profile as the same owner", () => {
    expect(sameLiability({ ...loan, parentProfileId: null }, paymentTwin, { selfProfileId: "self" })).toBe(true);
  });
  it("keeps one person's loan away from another person's same-named loan", () => {
    expect(sameLiability(loan, { ...paymentTwin, parentProfileId: "linda" })).toBe(false);
  });
  it("matches across doors on the account number even when the names differ", () => {
    const fromStatement = { id: "s", name: "CAPITAL AUTO FIN 8842", type: "liability", fields: { accountNumber: "8842001", lender: "Capital Auto Finance" } };
    const onFile = { id: "l", name: "Truck Loan", type: "liability", type_key: "auto_loan", fields: { loanNumber: "8842001" } };
    expect(identifiersMatch(fromStatement, onFile)).toBe(true);
    expect(sameLiability(fromStatement, onFile)).toBe(true);
  });
  it("matches a masked last-four against the full account number", () => {
    const a = { id: "a", name: "Visa", type: "liability", fields: { accountNumberLast4: "****4417" } };
    const b = { id: "b", name: "Visa", type: "liability", fields: { accountNumber: "4111 1111 1111 4417" } };
    expect(identifiersMatch(a, b)).toBe(true);
  });
  it("ignores values too short to identify anything", () => {
    expect(liabilityIdentifiers({ fields: { loanNumber: "7" } })).toEqual([]);
  });
});

describe("the two-debts-on-one-asset exception", () => {
  const first = { id: "m1", name: "Mortgage", type: "liability", type_key: "mortgage", parentProfileId: "self", fields: { loanNumber: "100200300", lender: "Wells Fargo" } };
  const second = { id: "m2", name: "Mortgage", type: "liability", type_key: "mortgage", parentProfileId: "self", fields: { loanNumber: "900800700", lender: "Wells Fargo" } };

  it("keeps two same-named loans apart when their account numbers disagree", () => {
    expect(identifiersConflict(first, second)).toBe(true);
    expect(sameLiability(first, second)).toBe(false);
  });
  it("keeps them apart when the creditors disagree", () => {
    const a = { id: "a", name: "Truck Loan", type: "liability", fields: { lender: "Chase" } };
    const b = { id: "b", name: "Truck Loan", type: "liability", fields: { lender: "Ally" } };
    expect(creditorsConflict(a, b)).toBe(true);
    expect(sameLiability(a, b)).toBe(false);
  });
  it("a shared account number across different creditors is a coincidence, not an identity", () => {
    const a = { id: "a", name: "Loan A", type: "liability", fields: { loanNumber: "4471", lender: "Chase" } };
    const b = { id: "b", name: "Loan B", type: "liability", fields: { accountNumber: "4471", lender: "Ally" } };
    expect(sameLiability(a, b)).toBe(false);
  });
  it("still merges when only one side names the creditor", () => {
    expect(sameLiability(loan, { ...paymentTwin, fields: { ...paymentTwin.fields } })).toBe(true);
  });
});

describe("findCanonicalLiability", () => {
  it("returns the debt instrument, not the bill shell, when both exist", () => {
    const incoming = { name: "Dodge Ram 2025 Auto Loan payment", type: "liability", type_key: "bill", parentProfileId: "self", fields: {} };
    expect(findCanonicalLiability(incoming, [paymentTwin, loan])?.id).toBe("loan");
  });
  it("returns undefined for a genuinely new liability", () => {
    expect(findCanonicalLiability({ name: "Student Loan", type: "liability", parentProfileId: "self" }, [loan, paymentTwin])).toBeUndefined();
  });
  it("never matches a record against itself", () => {
    expect(findCanonicalLiability(loan, [loan])).toBeUndefined();
  });
  it("ignores soft-deleted rows", () => {
    expect(findCanonicalLiability({ name: "Dodge Ram 2025 Auto Loan", type: "liability", parentProfileId: "self" }, [{ ...loan, deletedAt: "2026-01-01" }])).toBeUndefined();
  });
  it("ignores records outside the liability namespace", () => {
    expect(isLiabilityRecord({ type: "vehicle", name: "Dodge Ram 2025" })).toBe(false);
    expect(findCanonicalLiability({ name: "Dodge Ram 2025 Auto Loan", type: "vehicle" }, [loan])).toBeUndefined();
  });
});

describe("canonical classification", () => {
  it("ranks a named debt instrument above a bill shell above nothing", () => {
    expect(classificationRank(loan)).toBeGreaterThan(classificationRank(paymentTwin));
    expect(classificationRank({ type: "liability", type_key: "bill" })).toBeGreaterThan(classificationRank({ type: "liability" }));
  });
  it("a bill shell can never demote the loan it pays", () => {
    expect(preferLiabilityTypeKey(loan, paymentTwin)).toBe("auto_loan");
    expect(preferLiabilityTypeKey(paymentTwin, loan)).toBe("auto_loan");
  });
  it("a specific subtype still upgrades a bare shell", () => {
    expect(preferLiabilityTypeKey({ type: "liability" }, { type: "liability", type_key: "mortgage" })).toBe("mortgage");
  });
  it("keeps the debt's own name, never the '… payment' spelling of it", () => {
    expect(preferLiabilityName(paymentTwin, loan)).toBe("Dodge Ram 2025 Auto Loan");
    expect(preferLiabilityName(loan, paymentTwin)).toBe("Dodge Ram 2025 Auto Loan");
  });
  it("labels a liability from its registry key, not a routing placeholder", () => {
    expect(liabilitySubtypeKey(loan)).toBe("auto_loan");
    expect(liabilitySubtypeKey(paymentTwin)).toBe("bill");
    // `category: "liability"` says nothing — it must not become a subtype.
    expect(liabilitySubtypeKey({ type: "liability", fields: { category: "liability" } })).toBe("other");
  });
});

describe("mergeLiabilityRecords", () => {
  const merged = mergeLiabilityRecords(loan, paymentTwin);

  it("produces ONE record that is still the loan", () => {
    expect(merged.name).toBe("Dodge Ram 2025 Auto Loan");
    expect(merged.type_key).toBe("auto_loan");
    expect(liabilityFamily(merged.type_key)).toBe("amortizing");
    expect(liabilityPaymentShape({ type: "liability", type_key: merged.type_key })).toBe("fixed");
  });
  it("keeps the balance the twin never carried", () => {
    expect(merged.fields.currentBalance).toBe(47979.70);
    expect(merged.fields.originalBalance).toBe(54800);
  });
  it("takes the due date the twin did carry", () => {
    expect(merged.fields.dueDate).toBe("2026-10-30");
  });
  it("refuses the placeholder category that made the twin read as 'Liability'", () => {
    expect(merged.fields.category).toBeUndefined();
  });
  it("leaves every spelling of the payment amount agreeing", () => {
    expect(merged.fields.monthlyPayment).toBe(912.40);
    expect(merged.fields.monthlyAmount).toBe(912.40);
    expect(merged.fields.amount).toBe(912.40);
  });
  it("never erases a stored value with an empty incoming one", () => {
    const out = mergeLiabilityRecords(loan, { ...paymentTwin, fields: { lender: "", currentBalance: null } });
    expect(out.fields.lender).toBe("Capital Auto Finance");
    expect(out.fields.currentBalance).toBe(47979.70);
  });
  it("refreshes a real value with a newer real one", () => {
    const out = mergeLiabilityRecords(loan, { ...paymentTwin, fields: { currentBalance: 46000 } });
    expect(out.fields.currentBalance).toBe(46000);
  });
});

describe("reconcileLiabilityPaymentFields", () => {
  it("lets the installment win on a debt", () => {
    const out = reconcileLiabilityPaymentFields({ monthlyPayment: 912.4, monthlyAmount: 50 }, "auto_loan");
    expect(out.monthlyAmount).toBe(912.4);
    expect(out.monthlyPayment).toBe(912.4);
  });
  it("lets the bill amount win on a recurring bill", () => {
    const out = reconcileLiabilityPaymentFields({ monthlyAmount: 89.99, monthlyPayment: 12 }, "internet");
    expect(out.monthlyPayment).toBe(89.99);
    expect(out.amount).toBe(89.99);
  });
  it("invents nothing when no payment is on file", () => {
    expect(reconcileLiabilityPaymentFields({ currentBalance: 100 }, "auto_loan")).toEqual({ currentBalance: 100 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The chokepoint: every door that can mint a liability goes through
// storage.createProfile, so identity is applied once, there.
// ─────────────────────────────────────────────────────────────────────────────
import { MemStorage } from "../server/storage";

describe("createProfile is the one place duplicates are stopped", () => {
  const seedLoan = (s: any) => s.createProfile({
    type: "liability", type_key: "auto_loan", name: "Dodge Ram 2025 Auto Loan",
    fields: { currentBalance: 47979.7, originalBalance: 54800, monthlyPayment: 912.4, lender: "Capital Auto Finance" },
  } as any);

  it("a second create of the same loan updates the first — manual entry, import, chat alike", async () => {
    const s = new MemStorage() as any;
    const first = await seedLoan(s);
    const again = await s.createProfile({
      type: "liability", type_key: "auto_loan", name: "Dodge Ram 2025 Auto Loan",
      fields: { currentBalance: 46000 },
    } as any);
    expect(again.id).toBe(first.id);
    expect((await s.getProfiles()).filter((p: any) => p.type === "liability")).toHaveLength(1);
    expect(again.fields.currentBalance).toBe(46000);
    expect(again.fields.originalBalance).toBe(54800);   // nothing was lost
  });

  it("a '<loan> payment' bill lands ON the loan and cannot demote it", async () => {
    const s = new MemStorage() as any;
    const loanRow = await seedLoan(s);
    const bill = await s.createProfile({
      type: "liability", type_key: "bill", name: "Dodge Ram 2025 Auto Loan payment",
      fields: { monthlyAmount: 912.4, frequency: "monthly", category: "liability", dueDate: "2026-10-30" },
    } as any);
    expect(bill.id).toBe(loanRow.id);
    expect(bill.name).toBe("Dodge Ram 2025 Auto Loan");
    expect(bill.type_key).toBe("auto_loan");
    expect(liabilityFamily(bill.type_key)).toBe("amortizing");     // still FIXED, in one place
    expect(bill.fields.currentBalance).toBe(47979.7);
    expect(bill.fields.dueDate).toBe("2026-10-30");
  });

  it("still creates two genuinely separate loans against one vehicle", async () => {
    const s = new MemStorage() as any;
    const a = await s.createProfile({ type: "liability", type_key: "auto_loan", name: "Truck Loan", fields: { loanNumber: "111222333", lender: "Chase" } } as any);
    const b = await s.createProfile({ type: "liability", type_key: "auto_loan", name: "Truck Loan", fields: { loanNumber: "999888777", lender: "Chase" } } as any);
    expect(b.id).not.toBe(a.id);
    expect((await s.getProfiles()).filter((p: any) => p.type === "liability")).toHaveLength(2);
  });

  it("leaves non-liability profiles free to repeat (two 'Samsung TV's are fine)", async () => {
    const s = new MemStorage() as any;
    const a = await s.createProfile({ type: "asset", name: "Samsung TV", fields: {} } as any);
    const b = await s.createProfile({ type: "asset", name: "Samsung TV", fields: {} } as any);
    expect(b.id).not.toBe(a.id);
  });
});
