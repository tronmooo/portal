// tests/extraction-sections.test.ts
//
// Document-driven sections for the review (shared/extraction-sections).
//
// The contract under test: sections come from what the pipeline UNDERSTOOD —
// field groups, semantic roles, subjects, and value shape — never from a
// document-type table. An insurance declarations page and a hand-built set of
// unrelated rows must both come out sensibly sectioned by the same code.

import { describe, it, expect } from "vitest";
import { sectionLabelForItem, groupItemsIntoSections } from "../shared/extraction-sections";
import { planExtractionActions } from "../shared/extraction-actions";
import type { ExtractionItem } from "../shared/extraction-destinations";
import { insuranceDeclarations } from "./document-fixtures";

const item = (over: Partial<ExtractionItem> & { id: string; key: string; label: string; value: any }): ExtractionItem => ({
  destination: "profile",
  destinationOptions: ["profile", "note", "ignore"],
  selected: true,
  source: "field",
  ...over,
});

describe("sectionLabelForItem routes by meaning, not by document type", () => {
  it("a field group names its own section", () => {
    expect(sectionLabelForItem(item({ id: "a", key: "policyNumber", label: "Policy Number", value: "X-1", group: "insurance" })))
      .toBe("Insurance Details");
    expect(sectionLabelForItem(item({ id: "b", key: "loanNumber", label: "Loan Number", value: "L-9", group: "loan" })))
      .toBe("Loan Details");
  });

  it("a date is a deadline whichever group it also belongs to", () => {
    expect(sectionLabelForItem(item({ id: "c", key: "expirationDate", label: "Expiration Date", value: "2026-06-01", group: "insurance" })))
      .toBe("Dates & Deadlines");
  });

  it("a tracker-bound row is a measurement", () => {
    expect(sectionLabelForItem(item({
      id: "d", key: "odometer", label: "Odometer", value: "48221",
      destination: "tracker", trackerName: "Mileage", values: { value: 48221 }, unit: "mi",
    }))).toBe("Measurements");
  });

  it("contact-shaped fields become Contact Information", () => {
    expect(sectionLabelForItem(item({ id: "e", key: "agentPhone", label: "Agent Phone", value: "555-0100" })))
      .toBe("Contact Information");
    expect(sectionLabelForItem(item({ id: "f", key: "email", label: "Email", value: "a@b.co" })))
      .toBe("Contact Information");
  });

  it("medical rows are Health Information", () => {
    expect(sectionLabelForItem(item({ id: "g", key: "penicillin", label: "Penicillin", value: "rash", source: "allergy", destination: "allergy" })))
      .toBe("Health Information");
  });

  it("the reasoner's subject entity names the section for entity data", () => {
    const it1 = item({ id: "h", key: "yearBuilt", label: "Year Built", value: "2018", roles: ["entity_data"], subjectRef: "e-prop" });
    const semantic: any = { entities: [{ ref: "e-prop", kind: "property", name: "123 Evergreen Lane", identifiers: {}, confidence: 0.9 }] };
    expect(sectionLabelForItem(it1, semantic)).toBe("Property Details");
    const it2 = item({ id: "i", key: "vin", label: "VIN", value: "1HGCM", roles: ["entity_data"], subjectRef: "e-veh" });
    const semantic2: any = { entities: [{ ref: "e-veh", kind: "vehicle", name: "Honda HR-V", identifiers: {}, confidence: 0.9 }] };
    expect(sectionLabelForItem(it2, semantic2)).toBe("Vehicle Details");
  });

  it("an unknown row still lands somewhere, last", () => {
    const rows = [
      item({ id: "j", key: "mystery", label: "Mystery", value: "??", destination: "unsupported" }),
      item({ id: "k", key: "agentPhone", label: "Agent Phone", value: "555" }),
    ];
    const sections = groupItemsIntoSections(rows);
    expect(sections[sections.length - 1].label).toBe("Other Details");
  });
});

describe("an insurance declarations page comes out sectioned", () => {
  const plan = planExtractionActions({
    semantic: insuranceDeclarations.semantic,
    items: insuranceDeclarations.items,
    index: insuranceDeclarations.index,
    primaryProfileId: insuranceDeclarations.primaryProfileId,
    documentId: "doc-1",
    documentName: "Declarations Page",
    today: "2026-08-25",
  });
  const sections = groupItemsIntoSections(plan.items, insuranceDeclarations.semantic);

  it("splits the flat list into multiple meaningful sections", () => {
    expect(sections.length).toBeGreaterThan(2);
    const labels = sections.map((s) => s.label);
    expect(labels).toContain("Dates & Deadlines");
    // Every row is in exactly one section — nothing lost, nothing doubled.
    const total = sections.reduce((n, s) => n + s.items.length, 0);
    expect(total).toBe(plan.items.length);
  });

  it("dates land under Dates & Deadlines", () => {
    const dates = sections.find((s) => s.label === "Dates & Deadlines")!;
    expect(dates.items.map((i) => i.key)).toContain("expirationDate");
  });

  it("a section dominated by one entity names its owner", () => {
    const owned = sections.filter((s) => s.owner);
    expect(owned.length).toBeGreaterThan(0);
  });

  it("is deterministic — same input, same sections", () => {
    const again = groupItemsIntoSections(plan.items, insuranceDeclarations.semantic);
    expect(again.map((s) => `${s.id}:${s.items.map((i) => i.id).join(",")}`))
      .toEqual(sections.map((s) => `${s.id}:${s.items.map((i) => i.id).join(",")}`));
  });
});
