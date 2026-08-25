// tests/extraction-calendar.test.ts
//
// The contract for extracted DUE / EXPIRY / RENEWAL dates, end to end at the
// data level:
//
//   Document → Extract → date recognized → Calendar section → Add to Calendar
//     → Confirm → document saved → calendar updated → Executive updated
//
// Written against the bug that produced it (user report 2026-08-25): a City of
// Riverview parking citation was extracted. "Due Date 2026-09-25" appeared in
// the review table as an ordinary row — no calendar affordance, no type, no
// countdown — and confirming it produced no visible calendar entry and nothing
// on the Executive tab, which listed only things that "expire".
//
// Three causes, each pinned here:
//
//   1. The extractor offered a calendar affordance ONLY for dates the rule
//      engine could NOT classify, so every date that mattered was silent.
//   2. There was no way to say yes or no to a date before confirming, and no
//      way to say no afterwards that did not mean deleting the date.
//   3. The Executive tab filtered on EXPIRY_RULE_TYPES, so a document that is
//      DUE — a citation, an invoice — could never appear there at all.

import { describe, it, expect } from "vitest";
import {
  extractionDateRows,
  extractionDateTypeLabel,
  UPCOMING_WINDOW_DAYS,
} from "../shared/extraction-calendar";
import {
  rulesFromAll,
  rulesFromDocuments,
  seriesFromDateRules,
  isDocumentAttentionRule,
  dateRuleVerbs,
  daysBetweenISO,
  CALENDAR_OPT_OUT_KEY,
  EXPIRY_RULE_TYPES,
} from "../shared/date-rules";
import { buildExecutiveSections } from "../shared/executive-sections";

const TODAY = "2026-08-25";

/**
 * Rows of one Executive section. Empty sections do not render at all, so an
 * absent section means "nothing here" rather than a missing feature.
 */
const sectionItems = (sections: any[], id: string) =>
  sections.find((s) => s.id === id)?.items ?? [];

/** Every row the tab shows, whichever section claimed it. */
const allItems = (sections: any[]) => sections.flatMap((s: any) => s.items);

/** The document as extraction saves it, minus whichever dates a case sets. */
const citation = (extractedData: Record<string, any>) => ({
  id: "doc-citation",
  name: "Parking Violation Notice",
  title: "Parking Violation Notice",
  type: "parking_citation",
  linkedProfiles: ["profile-self"],
  extractedData,
});

/** The review-table rows the extractor produces for that citation. */
const citationFields = [
  { key: "citationNumber", label: "Citation Number", value: "RV62045871", selected: true },
  { key: "dateIssued", label: "Date Issued", value: "2026-08-25", selected: true },
  { key: "timeIssued", label: "Time Issued", value: "11:42 AM", selected: true },
  { key: "violationCode", label: "Violation Code", value: "12.36.140", selected: true },
  { key: "fineAmount", label: "Fine Amount", value: "45", selected: true },
  { key: "amountDue", label: "Amount Due", value: "45", selected: true },
  { key: "dueDate", label: "Due Date", value: "2026-09-25", selected: true },
  { key: "licensePlate", label: "License Plate", value: "QWE1234", selected: true },
];

describe("extraction review · Calendar section", () => {
  it("recognizes the citation's due date, with its type, its date and a real countdown", () => {
    const rows = extractionDateRows(citationFields, {
      documentContext: "parking_citation Parking Violation Notice",
      today: TODAY,
    });

    const due = rows.find((r) => r.key === "dueDate");
    expect(due).toBeDefined();
    expect(due!.ruleType).toBe("due");
    expect(due!.typeLabel).toBe("Due Date");
    expect(due!.date).toBe("2026-09-25");
    expect(due!.daysUntil).toBe(31);
    // The real number of days — never a hard-coded window.
    expect(due!.countdown).toBe("Due in 1 month");
    // Actionable dates start ticked: the user is shown the choice, not made to
    // hunt for it to get the behaviour the app already intends.
    expect(due!.defaultAddToCalendar).toBe(true);
    // The record owns this date, so the calendar entry is DERIVED from the
    // field — never a second, drifting copy.
    expect(due!.derived).toBe(true);
  });

  it("offers no calendar decision for metadata dates, non-dates, or money", () => {
    const rows = extractionDateRows(citationFields, { today: TODAY });
    const keys = rows.map((r) => r.key);
    // "Date Issued" is when the ticket was written — nothing to act on.
    expect(keys).not.toContain("dateIssued");
    // A time, an amount and a code are not dates at all.
    expect(keys).not.toContain("timeIssued");
    expect(keys).not.toContain("amountDue");
    expect(keys).not.toContain("fineAmount");
    expect(keys).not.toContain("violationCode");
    expect(keys).toEqual(["dueDate"]);
  });

  it("recognizes every actionable kind of date, not just due dates", () => {
    const rows = extractionDateRows([
      { key: "dueDate", label: "Due Date", value: "2026-09-25", selected: true },
      { key: "expirationDate", label: "Expiration Date", value: "2026-09-10", selected: true },
      { key: "renewalDate", label: "Renewal Date", value: "2026-12-01", selected: true },
      { key: "filingDeadline", label: "Filing Deadline", value: "2026-10-15", selected: true },
      { key: "paymentDueDate", label: "Payment Due Date", value: "2026-09-05", selected: true },
      { key: "appointmentDate", label: "Appointment Date", value: "2026-09-02", selected: true },
      { key: "nextServiceDate", label: "Next Service Date", value: "2027-01-04", selected: true },
    ], { today: TODAY });

    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.dueDate.ruleType).toBe("due");
    expect(byKey.expirationDate.ruleType).toBe("expiration");
    expect(byKey.renewalDate.ruleType).toBe("renewal");
    expect(byKey.filingDeadline.ruleType).toBe("deadline");
    expect(byKey.paymentDueDate.ruleType).toBe("payment");
    expect(byKey.appointmentDate.ruleType).toBe("appointment");
    expect(byKey.nextServiceDate.ruleType).toBe("maintenance");
    // Every one of them is shown with a type label the user can read.
    for (const r of rows) expect(r.typeLabel).not.toBe("Date");
    // Soonest first, so the most urgent decision is the first one seen.
    expect(rows.map((r) => r.date)).toEqual([...rows.map((r) => r.date)].sort());
  });

  it("names the thing the date is about when the field says so", () => {
    expect(extractionDateTypeLabel("expiration", "drivers_license")).toBe("Driver's License · Expiration Date");
    expect(extractionDateTypeLabel("renewal", "vehicle_registration")).toBe("Registration · Renewal Date");
    expect(extractionDateTypeLabel("due")).toBe("Due Date");
  });

  it("reads printed date forms, not just ISO", () => {
    const rows = extractionDateRows([
      { key: "dueDate", label: "Due Date", value: "09/25/2026", selected: true },
    ], { today: TODAY });
    expect(rows[0].date).toBe("2026-09-25");
  });

  it("skips a row the user unticked — a field that is not saved has no date to place", () => {
    const rows = extractionDateRows(
      citationFields.map((f) => f.key === "dueDate" ? { ...f, selected: false } : f),
      { today: TODAY },
    );
    expect(rows).toEqual([]);
  });
});

describe("confirmed extraction · the date reaches the calendar", () => {
  it("derives a due rule from the saved document and puts it on the calendar", () => {
    const rules = rulesFromAll({
      profiles: [],
      documents: [citation({ dueDate: "2026-09-25", amountDue: 45 })],
    });
    const due = rules.find((r) => r.ruleType === "due");
    expect(due).toBeDefined();
    expect(due!.date).toBe("2026-09-25");
    expect(due!.sourceEntityType).toBe("document");
    expect(due!.sourceField).toBe("dueDate");
    expect(due!.calendarVisible).toBe(true);
    expect(due!.importantVisible).toBe(true);
    expect(due!.countdownEnabled).toBe(true);

    // …and the calendar is a VIEW of that rule, traceable back to the document.
    const series = seriesFromDateRules(rules);
    const s = series.find((x) => x.id === `rule:${due!.id}`);
    expect(s).toBeDefined();
    expect(s!.baseDate).toBe("2026-09-25");
    expect(s!.source.id).toBe("doc-citation");
  });

  it("honours 'not on my calendar' without deleting the date", () => {
    const doc = citation({
      dueDate: "2026-09-25",
      [CALENDAR_OPT_OUT_KEY]: ["dueDate"],
    });
    const rules = rulesFromAll({ profiles: [], documents: [doc] });
    const due = rules.find((r) => r.ruleType === "due");

    // The rule still exists — the date is not lost, it still counts down and
    // still shows under Important Dates…
    expect(due).toBeDefined();
    expect(due!.date).toBe("2026-09-25");
    expect(due!.importantVisible).toBe(true);
    // …it is just off the calendar, which is exactly what was asked.
    expect(due!.calendarVisible).toBe(false);
    expect(seriesFromDateRules(rules).some((s) => s.id === `rule:${due!.id}`)).toBe(false);
  });

  it("matches an opt-out across spellings and nested paths", () => {
    const doc = {
      ...citation({
        payment: { dueDate: "2026-09-25" },
        [CALENDAR_OPT_OUT_KEY]: ["payment.due_date"],
      }),
    };
    const rules = rulesFromDocuments([doc]);
    const due = rules.find((r) => r.ruleType === "due");
    expect(due).toBeDefined();
    expect(due!.calendarVisible).toBe(false);
  });

  it("clearing the opt-out puts the date back on the calendar", () => {
    const rules = rulesFromDocuments([citation({ dueDate: "2026-09-25", [CALENDAR_OPT_OUT_KEY]: [] })]);
    expect(rules.find((r) => r.ruleType === "due")!.calendarVisible).toBe(true);
  });

  it("editing the date moves the SAME rule; deleting it removes the rule", () => {
    const before = rulesFromDocuments([citation({ dueDate: "2026-09-25" })]);
    const after = rulesFromDocuments([citation({ dueDate: "2026-10-09" })]);
    expect(after[0].id).toBe(before[0].id);          // one real-world date, one rule
    expect(after[0].date).toBe("2026-10-09");
    expect(seriesFromDateRules(after)[0].baseDate).toBe("2026-10-09");

    const removed = rulesFromDocuments([citation({ amountDue: 45 })]);
    expect(removed.some((r) => r.ruleType === "due")).toBe(false);
  });
});

describe("Executive Dashboard · due and expiring documents", () => {
  it("counts a document's due date as something to act on, not only expirations", () => {
    const due = rulesFromDocuments([citation({ dueDate: "2026-09-25" })])[0];
    expect(EXPIRY_RULE_TYPES.has(due.ruleType)).toBe(false);   // it does not "expire"…
    expect(isDocumentAttentionRule(due)).toBe(true);           // …but it is still due.
  });

  it("leaves a PROFILE's payment date on the bills surface", () => {
    // The regression this guard exists for: an insurance profile's
    // `premiumDueDate` is a bill, and it used to read "Expired 3d ago" in the
    // documents tile.
    const profileRule = rulesFromAll({
      profiles: [{ id: "p1", name: "Auto Policy", type: "insurance", fields: { premiumDueDate: "2026-09-01" } }],
      documents: [],
    }).find((r) => r.ruleType === "due");
    expect(profileRule).toBeDefined();
    expect(profileRule!.sourceEntityType).toBe("profile");
    expect(isDocumentAttentionRule(profileRule!)).toBe(false);
  });

  it("surfaces a document due inside the window, with the real days remaining", () => {
    const rule = rulesFromDocuments([citation({ dueDate: "2026-09-25" })])[0];
    const daysUntil = daysBetweenISO(TODAY, rule.date);
    expect(daysUntil).toBe(31);

    const sections = buildExecutiveSections({
      today: TODAY,
      documents: [{
        documentId: rule.sourceEntityId,
        documentName: rule.label,
        fieldName: rule.sourceField,
        expirationDate: rule.date,
        ruleId: rule.id,
        ruleType: rule.ruleType,
        daysUntil,
        status: "expiring_soon",
        href: rule.href,
      }],
    } as any);

    const docs = sectionItems(sections, "documents");
    expect(docs).toHaveLength(1);
    // The verb follows what the date MEANS…
    expect(docs[0].reason).toContain("Due");
    expect(docs[0].reason).not.toContain("Expires");
    // …and the count is the actual remaining days, not a fixed "30 days".
    expect(docs[0].reason).toContain("31");
    expect(docs[0].daysUntil).toBe(31);
  });

  it("says 'Expires' for an expiration and 'Due' for a due date", () => {
    expect(dateRuleVerbs("expiration")[0]).toBe("Expires");
    expect(dateRuleVerbs("due")[0]).toBe("Due");
    expect(dateRuleVerbs("renewal")[0]).toBe("Renews");
    expect(dateRuleVerbs("due")[1]).toBe("Was due");
  });

  it("drops out of the window once the date is far enough away", () => {
    const far = rulesFromDocuments([citation({ dueDate: "2027-06-01" })])[0];
    const daysUntil = daysBetweenISO(TODAY, far.date);
    expect(daysUntil).toBeGreaterThan(UPCOMING_WINDOW_DAYS);
    const sections = buildExecutiveSections({
      today: TODAY,
      documents: [{
        documentId: far.sourceEntityId, documentName: far.label, fieldName: far.sourceField,
        expirationDate: far.date, ruleId: far.id, ruleType: far.ruleType, daysUntil,
      }],
    } as any);
    expect(sectionItems(sections, "documents")).toHaveLength(0);
  });

  it("still surfaces an overdue document, with how long it has been overdue", () => {
    const overdue = rulesFromDocuments([citation({ dueDate: "2026-08-11" })])[0];
    const daysUntil = daysBetweenISO(TODAY, overdue.date);
    expect(daysUntil).toBe(-14);
    const sections = buildExecutiveSections({
      today: TODAY,
      documents: [{
        documentId: overdue.sourceEntityId, documentName: overdue.label, fieldName: overdue.sourceField,
        expirationDate: overdue.date, ruleId: overdue.id, ruleType: overdue.ruleType, daysUntil,
      }],
    } as any);
    // An overdue row is claimed by Immediate Attention — it is on fire, so it
    // renders at the top rather than in the inventory list. Either way the tab
    // shows it, which is the thing that was missing.
    const item = allItems(sections).find((i: any) => i.kind === "document")!;
    expect(item.reason).toBe("Was due 14 days ago");
    expect(item.tier).toBe("immediate");
  });

  it("covers every date type a document can carry, end to end", () => {
    const docs = [
      { id: "d-due", name: "Parking Citation", type: "citation", extractedData: { dueDate: "2026-09-05" } },
      { id: "d-exp", name: "Driver License", type: "drivers_license", extractedData: { expirationDate: "2026-09-12" } },
      { id: "d-ren", name: "Vehicle Registration", type: "vehicle_registration", extractedData: { renewalDate: "2026-09-18" } },
      { id: "d-dl", name: "Tax Filing", type: "tax", extractedData: { filingDeadline: "2026-09-20" } },
      { id: "d-pay", name: "Electric Bill", type: "utility_bill", extractedData: { paymentDueDate: "2026-09-02" } },
    ];
    const rules = rulesFromDocuments(docs);
    expect(rules).toHaveLength(5);
    for (const r of rules) {
      expect(isDocumentAttentionRule(r)).toBe(true);
      expect(r.calendarVisible).toBe(true);
      expect(daysBetweenISO(TODAY, r.date)).toBeLessThanOrEqual(UPCOMING_WINDOW_DAYS);
    }
    // All five reach the calendar as their own series.
    expect(seriesFromDateRules(rules)).toHaveLength(5);

    const sections = buildExecutiveSections({
      today: TODAY,
      documents: rules.map((r) => ({
        documentId: r.sourceEntityId, documentName: r.label, fieldName: r.sourceField,
        expirationDate: r.date, ruleId: r.id, ruleType: r.ruleType,
        daysUntil: daysBetweenISO(TODAY, r.date),
      })),
    } as any);
    expect(sectionItems(sections, "documents")).toHaveLength(5);
  });
});
