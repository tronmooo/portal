// tests/period-deadlines.test.ts
//
// USER REPORT (2026-08-26), on a TechMart receipt for a $81.19 radio:
//
//   1. "The 90-day return policy should be a suggested action, it should be in
//      the calendar, and it should be an expiration date — I want to know in
//      90 days that I can still return my radio."
//   2. Three expense actions were proposed for ONE purchase: $75.00 (subtotal),
//      $6.19 (tax) and $81.19 (total).
//
// Both are pinned here: a stated period becomes the date it implies, and a
// component of a total never becomes its own expense.

import { describe, it, expect } from "vitest";
import {
  parsePeriod, deadlineLabelFor, findAnchorDate, derivePeriodDeadlines,
} from "../shared/period-deadlines";
import { planExtractionActions, componentAmountIds } from "../shared/extraction-actions";
import type { ExtractionItem } from "../shared/extraction-destinations";
import type { SemanticDocument } from "../shared/semantic-document";

describe("reading a period off a field", () => {
  it("takes the unit from the key and the number from the value", () => {
    expect(parsePeriod("returnPolicyDays", "Return Policy Days", 90))
      .toEqual({ amount: 90, unit: "day", days: 90 });
    expect(parsePeriod("warrantyMonths", "Warranty Months", 12))
      .toEqual({ amount: 12, unit: "month", days: 360 });
  });

  it("takes both from the value when the document writes it that way", () => {
    expect(parsePeriod("returnPolicy", "Return Policy", "90 days")?.days).toBe(90);
    expect(parsePeriod("warranty", "Warranty", "2 years")?.days).toBe(730);
  });

  it("ignores numbers that are not windows", () => {
    // No window word — a count, not a deadline.
    expect(parsePeriod("itemQuantity", "Item Quantity", 1)).toBeNull();
    expect(parsePeriod("daysSincePurchase", "Days Since Purchase", 30)).toBeNull();
    // A real date is already a date.
    expect(parsePeriod("expirationDate", "Expiration Date", "2026-06-01")).toBeNull();
    // Nonsense magnitudes are parse failures, not policies.
    expect(parsePeriod("returnDays", "Return Days", 99999)).toBeNull();
    expect(parsePeriod("returnDays", "Return Days", -5)).toBeNull();
  });

  it("names the deadline for what it is", () => {
    expect(deadlineLabelFor("returnPolicyDays", "Return Policy")).toBe("Return deadline");
    expect(deadlineLabelFor("warrantyMonths", "Warranty")).toBe("Warranty expires");
    expect(deadlineLabelFor("trialDays", "Trial")).toBe("Trial ends");
  });
});

describe("anchoring the period to the day it counts from", () => {
  const rows = [
    { id: "a", key: "transactionDate", label: "Transaction Date", value: "2026-05-20" },
    { id: "b", key: "returnPolicyDays", label: "Return Policy Days", value: 90 },
  ];

  it("finds the transaction date and computes the deadline", () => {
    const [d] = derivePeriodDeadlines(rows);
    expect(d.date).toBe("2026-08-18");
    expect(d.anchorDate).toBe("2026-05-20");
    expect(d.label).toBe("Return deadline");
    expect(d.detail).toBe("90 days from 2026-05-20");
  });

  it("prefers the transaction date over an unrelated one", () => {
    expect(findAnchorDate([
      { id: "x", key: "printedDate", label: "Printed", value: "2026-01-01" },
      { id: "y", key: "transactionDate", label: "Transaction Date", value: "2026-05-20" },
    ])).toBe("2026-05-20");
  });

  it("derives NOTHING when the document states no anchor — never guesses today", () => {
    expect(derivePeriodDeadlines([
      { id: "b", key: "returnPolicyDays", label: "Return Policy Days", value: 90 },
    ])).toEqual([]);
  });
});

// ─── The receipt, end to end through the planner ─────────────────────────────

const item = (id: string, key: string, label: string, value: any): ExtractionItem => ({
  id, key, label, value,
  destination: "profile",
  destinationOptions: ["profile", "note", "ignore"],
  selected: true,
  source: "field",
});

const receiptItems: ExtractionItem[] = [
  item("field-transactiondate", "transactionDate", "Transaction Date", "2026-05-20"),
  item("field-subtotal", "subtotal", "Subtotal", "75.00"),
  item("field-salestax", "salesTax", "Sales Tax", "6.19"),
  item("field-totalamount", "totalAmount", "Total Amount", "81.19"),
  item("field-returnpolicydays", "returnPolicyDays", "Return Policy Days", "90"),
];

const fact = (id: string, itemIds: string[], label: string, value: any, extra: any = {}) => ({
  id, itemIds, label, value,
  roles: ["financial"],
  subject: { entityRef: "e-item", confidence: 0.95 },
  volatility: "historical",
  confidence: 0.95,
  date: "2026-05-20",
  ...extra,
});

const receiptSemantic: SemanticDocument = {
  documentType: "Retail Purchase Receipt",
  primarySubject: "e-item",
  confidence: 0.95,
  summary: "TechMart receipt for a portable radio.",
  entities: [
    { ref: "e-item", kind: "asset", name: "Portable AM/FM Radio (Model PR-200)", identifiers: {}, confidence: 0.95 },
    { ref: "e-store", kind: "organization", name: "TechMart", identifiers: {}, role: "merchant", confidence: 0.95 },
  ],
  relationships: [],
  facts: [
    fact("f-sub", ["field-subtotal"], "Subtotal", 75, { financialKind: "charge" }),
    fact("f-tax", ["field-salestax"], "Sales Tax", 6.19, { financialKind: "charge" }),
    fact("f-total", ["field-totalamount"], "Total Amount", 81.19, { financialKind: "charge" }),
  ],
  recurrences: [],
  narrative: [],
} as any;

const plan = () => planExtractionActions({
  semantic: receiptSemantic,
  items: receiptItems,
  index: { profiles: [], obligations: [], expenses: [], trackers: [], links: [] },
  documentId: "doc-receipt",
  documentName: "radio.png",
  today: "2026-05-20",
});

describe("one purchase is one expense", () => {
  it("proposes exactly ONE expense, and it is the total", () => {
    const expenses = plan().actions.filter(
      (a) => a.destination === "expense" && a.operation !== "NO_ACTION");
    expect(expenses).toHaveLength(1);
    expect(expenses[0].payload.amount).toBe(81.19);
  });

  it("keeps the subtotal and the tax, explained, never as their own expenses", () => {
    const parts = plan().actions.filter((a) => a.id.startsWith("act-part-"));
    expect(parts.map((p) => p.payload.amount).sort((a, b) => a - b)).toEqual([6.19, 75]);
    for (const p of parts) {
      expect(p.operation).toBe("NO_ACTION");
      expect(p.savable).toBe(false);
      expect(p.selected).toBe(false);
      expect(p.detail).toContain("81.19");
    }
  });

  it("identifies components arithmetically, not by their names", () => {
    const { componentFactIds, total } = componentAmountIds(receiptSemantic.facts);
    expect([...componentFactIds].sort()).toEqual(["f-sub", "f-tax"]);
    expect(total).toBe(81.19);
  });

  it("leaves two unrelated charges alone — nothing sums to another", () => {
    const facts: any[] = [
      fact("f-a", ["i1"], "Parking", 12, { financialKind: "charge" }),
      fact("f-b", ["i2"], "Coffee", 5, { financialKind: "charge" }),
      fact("f-c", ["i3"], "Lunch", 20, { financialKind: "charge" }),
    ];
    expect(componentAmountIds(facts).componentFactIds.size).toBe(0);
  });
});

describe("the 90-day return policy becomes a date", () => {
  it("proposes a calendar action on the computed deadline", () => {
    const deadline = plan().actions.find((a) => a.id.startsWith("act-deadline-"));
    expect(deadline).toBeTruthy();
    expect(deadline!.destination).toBe("calendar");
    expect(deadline!.payload.date).toBe("2026-08-18");
    expect(deadline!.selected).toBe(true);
    // Named for the thing being returned, and showing its arithmetic.
    expect(deadline!.payload.title).toContain("Return deadline");
    expect(deadline!.detail).toContain("90 days from 2026-05-20");
  });

  it("marks the row itself as a date, so it files under Dates & Deadlines", () => {
    const row = plan().items.find((i) => i.id === "field-returnpolicydays")!;
    expect(row.date).toBe("2026-08-18");
    expect(row.roles).toContain("actionable_date");
    // It is the evidence for its own deadline.
    expect(row.actionIds?.length).toBeGreaterThan(0);
  });

  it("does not invent a second deadline for the same window", () => {
    const deadlines = plan().actions.filter((a) => a.id.startsWith("act-deadline-"));
    expect(deadlines).toHaveLength(1);
  });
});
