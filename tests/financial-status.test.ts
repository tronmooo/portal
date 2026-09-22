// tests/financial-status.test.ts — Rules 3 and 4 at the decision layer.
//
// RULE 3: never turn extracted information into a financial transaction
// without transaction evidence. Regression pinned here: an UNPAID $549.50
// estimate uploaded with the message "Nothing paid" still created an expense.
//
// RULE 4: an explicit user instruction beats AI inference — and beats the
// document. "Do not create an expense" on a receipt creates nothing; "log this
// as an expense" on an invoice creates one.

import { describe, it, expect } from "vitest";
import {
  classifyFinancialDocKind,
  inferFinancialStatus,
  detectExpenseInstruction,
  decideExpenseCreation,
  assessExpenseFromDocument,
  FINANCIAL_DOC_KINDS,
  type FinancialDocKind,
} from "../shared/financial-status";

// The regression document: a body-shop estimate for $549.50, nothing paid.
const unpaidEstimate = {
  documentType: "auto_repair_estimate",
  extractedData: {
    vendorName: { value: "Northside Auto Body", confidence: 0.95 },
    estimateNumber: "EST-20417",
    estimateDate: "2026-09-14",
    totalAmount: { value: 549.5, confidence: 0.98 },
    laborTotal: 320,
    partsTotal: 229.5,
    notes: "Estimate valid for 30 days. Nothing paid.",
  },
};

const paidReceipt = {
  documentType: "vehicle_service_receipt",
  extractedData: {
    vendorName: "Oil Changers",
    transactionDate: "2026-07-22",
    totalAmount: 118.14,
    amountPaid: 118.14,
    paymentMethod: "Visa ending 4421",
  },
};

describe("Rule 3 — the unpaid $549.50 estimate never becomes an expense", () => {
  it("is classified as an estimate", () => {
    expect(classifyFinancialDocKind(unpaidEstimate.documentType, unpaidEstimate.extractedData)).toBe("estimate");
  });

  it("has status estimated / unpaid, never paid — and no expense is created", () => {
    const kind = classifyFinancialDocKind(unpaidEstimate.documentType, unpaidEstimate.extractedData);
    const status = inferFinancialStatus({ docKind: kind, extractedData: unpaidEstimate.extractedData });
    expect(["estimated", "unpaid"]).toContain(status.status);
    expect(status.status).not.toBe("paid");
    const decision = decideExpenseCreation({ financialStatus: status.status, userInstruction: null });
    expect(decision.create).toBe(false);
    expect(decision.source).toBe("deterministic_rule");
    expect(decision.reason).toMatch(/stays on the document/i);
  });

  it("with the upload message 'Nothing paid' the status is unpaid and the expense is refused by explicit instruction", () => {
    const r = assessExpenseFromDocument({
      ...unpaidEstimate,
      userMessage: "Nothing paid. Here is the estimate from the body shop.",
    });
    expect(r.docKind).toBe("estimate");
    expect(r.status.status).toBe("unpaid");
    expect(r.instruction).toBe("forbid");
    expect(r.decision.create).toBe(false);
    expect(r.decision.source).toBe("explicit_instruction");
  });

  it("an estimate with a total but no message is still not an expense — a dollar amount is not evidence of payment", () => {
    const r = assessExpenseFromDocument({
      documentType: "estimate",
      extractedData: { totalAmount: 549.5, vendorName: "Northside Auto Body" },
    });
    expect(r.status.status).toBe("estimated");
    expect(r.decision.create).toBe(false);
  });

  it("an invoice with an amount due is invoiced, not paid", () => {
    const r = assessExpenseFromDocument({
      documentType: "invoice",
      extractedData: { invoiceNumber: "1042", totalAmount: 900, amountDue: 900, dueDate: "2026-10-15" },
    });
    expect(r.docKind).toBe("invoice");
    expect(r.status.status).toBe("invoiced");
    expect(r.decision.create).toBe(false);
    expect(r.decision.reason).toMatch(/unpaid invoice/i);
  });

  it("a refund never creates an expense", () => {
    const r = assessExpenseFromDocument({
      documentType: "receipt",
      extractedData: { totalAmount: 40, refundAmount: 40, status: "refunded" },
    });
    expect(r.status.status).toBe("refunded");
    expect(r.decision.create).toBe(false);
  });
});

describe("Rule 3 — paid evidence creates an expense", () => {
  it("a receipt with amountPaid > 0 is paid and creates an expense", () => {
    const r = assessExpenseFromDocument(paidReceipt);
    expect(r.docKind).toBe("receipt");
    expect(r.status.status).toBe("paid");
    expect(r.status.confidence).toBeGreaterThanOrEqual(0.8);
    expect(r.decision).toEqual(expect.objectContaining({ create: true, source: "deterministic_rule" }));
  });

  it("a receipt with a total and nothing due is paid — a receipt is proof of payment", () => {
    const r = assessExpenseFromDocument({
      documentType: "parking_receipt",
      extractedData: { totalAmount: 12, transactionDate: "2026-09-01", paymentMethod: "Pay by: Visa" },
    });
    expect(r.status.status).toBe("paid");
    expect(r.decision.create).toBe(true);
  });

  it("a receipt whose balanceDue field is $0 is still paid (the field name is not a due phrase)", () => {
    const r = assessExpenseFromDocument({
      documentType: "receipt",
      extractedData: { totalAmount: 55.2, balanceDue: 0, amountPaid: 55.2 },
    });
    expect(r.status.status).toBe("paid");
  });

  it("a receipt that still shows a balance due is NOT paid", () => {
    const r = assessExpenseFromDocument({
      documentType: "receipt",
      extractedData: { totalAmount: 500, amountPaid: 100, balanceDue: 400 },
    });
    expect(r.status.status).toBe("unpaid");
    expect(r.decision.create).toBe(false);
  });

  it("a paymentStatus field that says paid is strong evidence", () => {
    const r = assessExpenseFromDocument({
      documentType: "invoice",
      extractedData: { invoiceNumber: "77", totalAmount: 200, paymentStatus: "PAID" },
    });
    expect(r.status.status).toBe("paid");
    expect(r.decision.create).toBe(true);
  });

  it("a paymentDate / paidOn field is strong evidence", () => {
    const r = assessExpenseFromDocument({
      documentType: "invoice",
      extractedData: { invoiceNumber: "78", totalAmount: 200, paidOn: "2026-09-10" },
    });
    expect(r.status.status).toBe("paid");
  });

  it("structured data outranks inference: a bill occurrence the app already tracks as paid", () => {
    const d = decideExpenseCreation({ financialStatus: "invoiced", userInstruction: null, structuredPaid: true });
    expect(d).toEqual(expect.objectContaining({ create: true, source: "structured_data" }));
    const u = decideExpenseCreation({ financialStatus: "paid", userInstruction: null, structuredPaid: false });
    expect(u).toEqual(expect.objectContaining({ create: false, source: "structured_data" }));
  });
});

describe("Rule 4 — explicit user instruction overrides everything", () => {
  it("'do not create an expense' on a paid receipt creates nothing", () => {
    const r = assessExpenseFromDocument({
      ...paidReceipt,
      userMessage: "Save this receipt to the Honda. Do not create an expense.",
    });
    expect(r.instruction).toBe("forbid");
    expect(r.decision.create).toBe(false);
    expect(r.decision.source).toBe("explicit_instruction");
  });

  it("'Nothing has been paid. Do not create an expense.' forbids, and the status follows the user", () => {
    const r = assessExpenseFromDocument({
      ...paidReceipt,
      userMessage: "Nothing has been paid. Do not create an expense.",
    });
    expect(r.instruction).toBe("forbid");
    expect(r.status.status).toBe("unpaid");
    expect(r.decision.create).toBe(false);
  });

  it("'log this as an expense' on an unpaid invoice creates one", () => {
    const r = assessExpenseFromDocument({
      documentType: "invoice",
      extractedData: { invoiceNumber: "1042", totalAmount: 900, amountDue: 900 },
      userMessage: "Log this as an expense.",
    });
    expect(r.instruction).toBe("require");
    expect(r.decision.create).toBe(true);
    expect(r.decision.source).toBe("explicit_instruction");
  });

  it("'I paid this' on an invoice is paid and creates an expense", () => {
    const r = assessExpenseFromDocument({
      documentType: "invoice",
      extractedData: { invoiceNumber: "1042", totalAmount: 900, amountDue: 900 },
      userMessage: "I paid this yesterday",
    });
    expect(r.status.status).toBe("paid");
    expect(r.decision.create).toBe(true);
  });

  it("the user instruction outranks structured data too", () => {
    expect(decideExpenseCreation({ financialStatus: "paid", userInstruction: "forbid", structuredPaid: true }).create).toBe(false);
    expect(decideExpenseCreation({ financialStatus: "quoted", userInstruction: "require", structuredPaid: false }).create).toBe(true);
  });

  describe("detectExpenseInstruction is conservative", () => {
    it.each([
      "Do not create an expense.",
      "don't log this as an expense",
      "Please don't add a charge for this",
      "never record a transaction from this",
      "No expense please",
      "This is not an expense",
      "Nothing has been paid.",
      "nothing paid",
      "I haven't paid this yet",
      "not paid yet",
      "It's unpaid",
      "this is just an estimate",
    ])("forbids: %s", (msg) => {
      expect(detectExpenseInstruction(msg)).toBe("forbid");
    });

    it.each([
      "Log this as an expense",
      "add it as an expense",
      "create an expense for this",
      "record the expense",
      "I paid this",
      "we already paid it",
      "This was paid in full",
      "mark it paid",
    ])("requires: %s", (msg) => {
      expect(detectExpenseInstruction(msg)).toBe("require");
    });

    it.each([
      "",
      "Here is the receipt from the oil change",
      "file this under the Honda",
      "what is the total on this?",
      "estimate for the roof repair",
      "invoice from the plumber",
      "the amount was $549.50",
    ])("returns null for: %s", (msg) => {
      expect(detectExpenseInstruction(msg)).toBeNull();
    });
  });
});

describe("document kind classification — all eight kinds", () => {
  const cases: Array<{ kind: FinancialDocKind; documentType: string; extractedData?: Record<string, any>; ocrText?: string }> = [
    { kind: "quote", documentType: "repair_quote" },
    { kind: "estimate", documentType: "auto_repair_estimate" },
    { kind: "invoice", documentType: "invoice" },
    { kind: "receipt", documentType: "parking_receipt" },
    { kind: "bill", documentType: "utility_bill" },
    { kind: "payment_confirmation", documentType: "payment_confirmation" },
    { kind: "statement", documentType: "auto_loan_statement" },
    { kind: "contract", documentType: "lease_agreement" },
  ];
  it.each(cases)("classifies documentType → $kind", ({ kind, documentType }) => {
    expect(classifyFinancialDocKind(documentType, {})).toBe(kind);
  });

  it("falls back to title fields when the type is free-form", () => {
    expect(classifyFinancialDocKind("other", { title: "Quotation #88 — Roof replacement" })).toBe("quote");
    expect(classifyFinancialDocKind("other", { documentTitle: "Proposal for kitchen remodel" })).toBe("estimate");
    expect(classifyFinancialDocKind("document", { label: "Thank you for your payment" })).toBe("payment_confirmation");
  });

  it("falls back to the document's own words, earliest mention first", () => {
    expect(classifyFinancialDocKind("other", {}, "INVOICE\nAcme Plumbing\nItem: estimate of hours 4\nAmount due $300")).toBe("invoice");
    expect(classifyFinancialDocKind("other", {}, "ESTIMATE\nNorthside Auto Body\nTotal $549.50")).toBe("estimate");
    expect(classifyFinancialDocKind("other", {}, "Account Statement for March")).toBe("statement");
    expect(classifyFinancialDocKind("other", {}, "Service Agreement between…")).toBe("contract");
  });

  it("falls back to field names", () => {
    expect(classifyFinancialDocKind("other", { quoteNumber: "Q-1", total: 10 })).toBe("quote");
    expect(classifyFinancialDocKind("other", { receiptNumber: "R-1", total: 10 })).toBe("receipt");
  });

  it("is unknown for a document that is not about money", () => {
    expect(classifyFinancialDocKind("drivers_license", { licenseNumber: "D123", expirationDate: "2030-01-01" })).toBe("unknown");
  });

  it("every kind maps to a status, and only the paid-shaped kinds are paid", () => {
    for (const kind of FINANCIAL_DOC_KINDS) {
      const s = inferFinancialStatus({ docKind: kind, extractedData: { totalAmount: 100 } });
      if (kind === "receipt" || kind === "payment_confirmation") expect(s.status, kind).toBe("paid");
      else expect(s.status, kind).not.toBe("paid");
    }
    expect(inferFinancialStatus({ docKind: "quote", extractedData: {} }).status).toBe("quoted");
    expect(inferFinancialStatus({ docKind: "estimate", extractedData: {} }).status).toBe("estimated");
    expect(inferFinancialStatus({ docKind: "invoice", extractedData: {} }).status).toBe("invoiced");
    expect(inferFinancialStatus({ docKind: "bill", extractedData: {} }).status).toBe("unpaid");
    expect(inferFinancialStatus({ docKind: "statement", extractedData: {} }).status).toBe("pending");
    expect(inferFinancialStatus({ docKind: "contract", extractedData: {} }).status).toBe("scheduled");
  });
});
