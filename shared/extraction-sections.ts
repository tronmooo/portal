// shared/extraction-sections.ts — document-driven sections for the review.
// =============================================================================
//
// A review that lists 75 rows as one flat table makes the reader do the
// categorising. This module does it instead — from what the pipeline already
// UNDERSTOOD about the document, never from a table of document types:
//
//   • `item.group` is the concept registry's answer ("insurance", "loan",
//     "warranty") — a named record section the field belongs in.
//   • `item.roles` + `item.subjectRef` are the reasoner's answer — what the
//     fact IS and which entity it describes.
//   • the value/key shape is the fallback for rows the reasoner never saw —
//     an ISO date is a date and a money-shaped amount is money, annotated
//     or not.
//
// The section labels below are a vocabulary, not a whitelist: an entity kind
// or field group this file has never heard of still produces a section, named
// from the group or kind itself. A deed, a lab panel and a boat registration
// therefore come out sectioned differently because their CONTENT differs —
// no branch in here names a document type.
//
// Pure and deterministic: same items in, same sections out. Pinned by
// tests/extraction-sections.test.ts.

import type { ExtractionItem } from "./extraction-destinations";
import type { SemanticDocument, SemanticEntityKind } from "./semantic-document";

export interface ReviewSection {
  /** Stable slug for keys/testids ("property-details"). */
  id: string;
  /** What the header prints ("Property Details"). */
  label: string;
  /** The entity most of the section's rows describe, when one dominates. */
  owner?: string;
  items: ExtractionItem[];
}

/** Sections for the entity KINDS the semantic layer speaks. Any kind not
 *  listed still gets a section — named from the kind itself. */
const KIND_SECTION: Partial<Record<SemanticEntityKind, string>> = {
  person: "Personal Information",
  property: "Property Details",
  vehicle: "Vehicle Details",
  pet: "Pet Details",
  asset: "Asset Details",
  liability: "Loan & Liability Details",
  account: "Account Information",
  investment: "Investment Details",
  business: "Business Details",
  organization: "Provider Details",
};

const OTHER_SECTION = "Other Details";

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}/;
const DATE_KEY = /(date|expir|renew|\bdue\b|birth|effective|deadline|maturity|appointment)/i;
const CONTACT_KEY = /(phone|email|website|\burl\b|fax|contact person|contact number)/i;
const MONEY_KEY = /(premium|amount|total|price|cost|\bfees?\b|balance|payment|deductible|coverage|limit|salary|income)/i;
const MONEY_VALUE = /^[$€£¥]?\s?-?[\d,]+(\.\d+)?$/;

function titleCase(s: string): string {
  return String(s || "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The section one row belongs in.
 *
 * Order of authority: structured medical sources, then contact/date/measurement
 * SHAPE (a date is a deadline whichever record group it also belongs to), then
 * the concept registry's group, then money, relationships, metadata, notes,
 * then the reasoner's subject entity, then the plain profile fallback.
 */
export function sectionLabelForItem(
  item: ExtractionItem,
  semantic?: SemanticDocument | null,
): string {
  const roles = item.roles ?? [];
  const keyAndLabel = `${item.key} ${item.label}`;
  const value = String(item.value ?? "");

  if (
    item.source === "allergy" || item.source === "medication"
    || item.source === "condition" || item.source === "surgery"
    || item.destination === "allergy" || item.destination === "medication"
    || item.destination === "medical_history"
  ) {
    return "Health Information";
  }
  if (CONTACT_KEY.test(keyAndLabel)) return "Contact Information";
  if (
    Boolean(item.date) || roles.includes("actionable_date")
    || item.destination === "calendar"
    || DATE_VALUE.test(value) || DATE_KEY.test(keyAndLabel)
  ) {
    return "Dates & Deadlines";
  }
  if (
    roles.includes("measurement") || Boolean(item.trackerName)
    || item.destination === "tracker" || item.destination === "profile_tracker"
  ) {
    return "Measurements";
  }
  if (item.group) return `${titleCase(item.group)} Details`;
  if (
    roles.includes("financial")
    || item.destination === "expense" || item.destination === "income"
    || item.destination === "obligation" || item.destination === "liability_payment"
    || (MONEY_KEY.test(keyAndLabel) && MONEY_VALUE.test(value.trim()))
  ) {
    return "Financial Details";
  }
  if (roles.includes("relationship") || item.destination === "relationship_link") {
    return "Relationships";
  }
  if (roles.includes("document_metadata")) return "Document Details";
  if (roles.includes("narrative") || item.destination === "note") return "Notes";

  const subject = semantic?.entities.find((e) => e.ref === item.subjectRef);
  if (subject) return KIND_SECTION[subject.kind] ?? `${titleCase(subject.kind)} Details`;

  if (roles.includes("profile_data") || item.destination === "profile") {
    return "Personal Information";
  }
  return OTHER_SECTION;
}

/**
 * Group rows into sections, in the order the document introduced them —
 * a review reads top-to-bottom the way the page did — with "Other Details"
 * always last. Each section names its owner when one entity dominates it.
 */
export function groupItemsIntoSections(
  items: readonly ExtractionItem[],
  semantic?: SemanticDocument | null,
): ReviewSection[] {
  const byLabel = new Map<string, ExtractionItem[]>();
  for (const item of items) {
    const label = sectionLabelForItem(item, semantic);
    const list = byLabel.get(label) ?? [];
    list.push(item);
    byLabel.set(label, list);
  }
  const sections: ReviewSection[] = [];
  for (const [label, sectionItems] of byLabel) {
    // The owner: the entity MOST of the section's rows describe — shown only
    // when it genuinely dominates, so a mixed section never claims one.
    let owner: string | undefined;
    if (semantic) {
      const tally = new Map<string, number>();
      for (const it of sectionItems) {
        if (it.subjectRef) tally.set(it.subjectRef, (tally.get(it.subjectRef) ?? 0) + 1);
      }
      const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] * 2 > sectionItems.length) {
        owner = semantic.entities.find((e) => e.ref === top[0])?.name;
      }
    }
    sections.push({ id: slugify(label), label, owner, items: sectionItems });
  }
  const otherIdx = sections.findIndex((s) => s.label === OTHER_SECTION);
  if (otherIdx >= 0 && otherIdx !== sections.length - 1) {
    sections.push(...sections.splice(otherIdx, 1));
  }
  return sections;
}
