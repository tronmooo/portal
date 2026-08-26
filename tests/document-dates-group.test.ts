// tests/document-dates-group.test.ts
//
// USER REPORT (2026-08-26): "Why does it say two documents when there's only
// one document present? Something's not updating correctly — I deleted one and
// it's still there."
//
// One homeowners policy printed an expiration AND a premium due date on the
// same day. The date-rule engine derived one rule per field — correctly — and
// every document-dates surface rendered one row per rule, so one document read
// as two, the badge said 2, and deleting "the duplicate" changed nothing
// because there was no second document.
//
// These tests pin the grouping that fixes it: one card per record per day,
// naming every kind of date it covers, standing for every rule it merged.

import { describe, it, expect } from "vitest";
import {
  groupDocumentDates,
  countDocumentDateRecords,
  documentDateBaseName,
  ruleIdsOf,
} from "../shared/document-dates";

const DOC = "doc-policy";

/** The two rows the reported screenshot actually contained. */
const policyRows = () => [
  {
    documentId: DOC,
    documentName: "Homeowners Insurance Policy Declaration — Expiration",
    documentType: "insurance",
    fieldName: "expirationDate",
    expirationDate: "2026-06-01",
    daysUntil: -85,
    ruleId: "rule-exp",
    ruleType: "expiration",
    ruleSubtype: "insurance",
    sourceEntityType: "document",
  },
  {
    documentId: DOC,
    documentName: "Homeowners Insurance Policy Declaration — Due",
    documentType: "insurance",
    fieldName: "premiumDueDate",
    expirationDate: "2026-06-01",
    daysUntil: -85,
    ruleId: "rule-due",
    ruleType: "due",
    ruleSubtype: "insurance",
    sourceEntityType: "document",
  },
];

describe("one document on one day is one row", () => {
  it("collapses the two rules into a single card", () => {
    const grouped = groupDocumentDates(policyRows());
    expect(grouped).toHaveLength(1);
    expect(grouped[0].mergedCount).toBe(2);
  });

  it("the card names the record once, without the rule-type suffix", () => {
    const [card] = groupDocumentDates(policyRows());
    expect(card.baseName).toBe("Homeowners Insurance Policy Declaration");
  });

  it("and still says both kinds of date it covers", () => {
    const [card] = groupDocumentDates(policyRows());
    expect(card.ruleTypes).toEqual(["expiration", "due"]);
    // Both labels present — nothing is hidden behind the other.
    expect(card.typesLabel).toMatch(/xpir/);
    expect(card.typesLabel).toContain("·");
  });

  it("dismissing the card covers every rule it merged", () => {
    const [card] = groupDocumentDates(policyRows());
    expect(ruleIdsOf(card).sort()).toEqual(["rule-due", "rule-exp"]);
  });

  it("counts records, not rules — the number the user was reading", () => {
    expect(countDocumentDateRecords(policyRows())).toBe(1);
  });
});

describe("what must NOT be merged", () => {
  it("two dates on the same document but different days stay two rows", () => {
    const rows = policyRows();
    rows[1].expirationDate = "2026-07-15";
    expect(groupDocumentDates(rows)).toHaveLength(2);
  });

  it("two different documents on the same day stay two rows", () => {
    const rows = policyRows();
    rows[1].documentId = "doc-other";
    const grouped = groupDocumentDates(rows);
    expect(grouped).toHaveLength(2);
    expect(countDocumentDateRecords(rows)).toBe(2);
  });

  it("a document date and a profile-carried date stay distinct records", () => {
    const rows = policyRows();
    rows[1].sourceEntityType = "profile";
    expect(groupDocumentDates(rows)).toHaveLength(2);
  });

  it("rows with no record id never collapse into one another", () => {
    const rows = [
      { ruleId: "a", expirationDate: "2026-06-01", documentName: "A", daysUntil: 1 },
      { ruleId: "b", expirationDate: "2026-06-01", documentName: "B", daysUntil: 2 },
    ];
    expect(groupDocumentDates(rows)).toHaveLength(2);
  });
});

describe("the merged card reads correctly", () => {
  it("keeps the most urgent countdown of the day it stands for", () => {
    const rows = policyRows();
    rows[0].daysUntil = 10;
    rows[1].daysUntil = -3;
    const [card] = groupDocumentDates(rows);
    expect(card.daysUntil).toBe(-3);
  });

  it("preserves input order, so an urgency-sorted list stays sorted", () => {
    const rows = [
      { documentId: "d1", ruleId: "r1", expirationDate: "2026-06-01", daysUntil: -5, documentName: "First — Expiration", ruleType: "expiration" },
      { documentId: "d2", ruleId: "r2", expirationDate: "2026-06-09", daysUntil: 3, documentName: "Second — Due", ruleType: "due" },
      { documentId: "d1", ruleId: "r3", expirationDate: "2026-06-01", daysUntil: -5, documentName: "First — Due", ruleType: "due" },
    ];
    const grouped = groupDocumentDates(rows);
    expect(grouped.map((g) => g.documentId)).toEqual(["d1", "d2"]);
  });

  it("a name with no rule-type suffix is left alone", () => {
    expect(documentDateBaseName("Passport")).toBe("Passport");
    expect(documentDateBaseName("Policy 2024-2025")).toBe("Policy 2024-2025");
  });

  it("empty input is an empty list, not a crash", () => {
    expect(groupDocumentDates(undefined)).toEqual([]);
    expect(groupDocumentDates([])).toEqual([]);
    expect(countDocumentDateRecords(null)).toBe(0);
  });
});
