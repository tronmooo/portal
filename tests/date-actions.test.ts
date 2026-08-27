// tests/date-actions.test.ts — every date on the page becomes a suggested action.
//
// USER REPORT (2026-08-27): a medical report listed "Birthday 1975-04-12",
// "date Of Birth 1975-04-12" and "report Date 2026-06-23" under the review's
// "Dates & Deadlines" heading with a completely empty actions rail — and the
// user asked for the birthday specifically to "create a reoccurring event every
// year" that shows "in the calendar under reoccurring".
//
// The asymmetry had one cause: the SECTION was decided from the row's shape
// (shared/extraction-sections.isDateRow) while the ACTION was decided from the
// reasoner's facts. Any row the reasoner missed — and every row on any document
// whose understanding step degraded — landed under the heading with nothing
// beside it. These tests plan with an EMPTY semantic envelope on purpose: that
// is the degraded case, and it is the one that has to work.

import { describe, it, expect } from "vitest";
import { planExtractionActions, emptyEntityIndex, type EntityIndex } from "../shared/extraction-actions";
import type { ExtractionItem } from "../shared/extraction-destinations";
import { emptySemanticDocument } from "../shared/semantic-document";

const TODAY = "2026-08-27";

const person = {
  id: "prof-jane",
  name: "Jane Ortiz",
  type: "person",
  fields: {} as Record<string, any>,
};

function index(): EntityIndex {
  return { ...emptyEntityIndex(), profiles: [person as any] };
}

function row(over: Partial<ExtractionItem> & { id: string; key: string; label: string; value: string }): ExtractionItem {
  return {
    destination: "profile",
    destinationOptions: ["profile"],
    selected: true,
    source: "field",
    ...over,
  } as ExtractionItem;
}

function planRows(items: ExtractionItem[], over: any = {}) {
  return planExtractionActions({
    semantic: emptySemanticDocument("medical report", ""),
    items,
    index: index(),
    primaryProfileId: person.id,
    documentId: "doc-1",
    documentName: "Lab report",
    today: TODAY,
    ...over,
  });
}

describe("a date row produces an action even when the reasoner produced nothing", () => {
  it("a birthday becomes a yearly recurring calendar rule", () => {
    const p = planRows([
      row({ id: "field-dateofbirth", key: "dateOfBirth", label: "Date Of Birth", value: "1975-04-12", date: "1975-04-12" }),
    ]);
    const a = p.actions.find((x) => x.itemIds.includes("field-dateofbirth") && x.destination === "calendar");
    expect(a, "no calendar action for the birthday row").toBeTruthy();
    expect(a!.payload.recurrence).toBe("yearly");
    expect(a!.payload.ruleType).toBe("birthday");
    expect(a!.kindLabel).toBe("Create recurring calendar rule");
    expect(a!.selected).toBe(true);
  });

  it("the birthday does BOTH — the date lands on the person, and a yearly event is created", () => {
    const p = planRows([
      row({ id: "field-dateofbirth", key: "dateOfBirth", label: "Date Of Birth", value: "1975-04-12", date: "1975-04-12" }),
    ]);
    const a = p.actions.find((x) => x.destination === "calendar")!;
    // Half one: the field write onto the record that owns the birthday.
    expect(a.payload.profileId).toBe(person.id);
    expect(a.payload.fields).toEqual({ dateOfBirth: "1975-04-12" });
    // Half two: the event. Both the title and the profile link are load-bearing
    // — seriesFromEvents only shadows an event it can recognise as a birthday
    // AND tie to a profile that already owns the rule, and without that shadow
    // the calendar would show the birthday twice.
    expect(a.payload.createEvent).toBe(true);
    expect(String(a.payload.title).toLowerCase()).toContain("birthday");
    expect(String(a.payload.title)).toContain(person.name);
  });

  it("a report date is kept and named, but nothing is scheduled", () => {
    const p = planRows([
      row({ id: "field-reportdate", key: "reportDate", label: "Report Date", value: "2026-06-23", date: "2026-06-23" }),
    ]);
    const a = p.actions.find((x) => x.itemIds.includes("field-reportdate"))!;
    expect(a.operation).toBe("NO_ACTION");
    expect(a.destination).toBe("reference");
    expect(a.payload.date).toBe("2026-06-23");
    expect(a.selected).toBe(false);
  });

  it("an expiration is named an expiration, not a generic date", () => {
    const p = planRows([
      row({ id: "field-expirationdate", key: "expirationDate", label: "Expiration Date", value: "2027-01-31", date: "2027-01-31" }),
    ]);
    const a = p.actions.find((x) => x.destination === "calendar")!;
    expect(a.payload.ruleType).toBe("expiration");
    expect(a.kindLabel).toBe("Create expiration");
    expect(a.title).toMatch(/^Expiration/);
    // Not yearly: a licence expires once and becomes a new date when renewed.
    expect(a.payload.recurrence).toBe("none");
  });

  it("a renewal is named a renewal", () => {
    const p = planRows([
      row({ id: "field-renewaldate", key: "renewalDate", label: "Renewal Date", value: "2027-03-01", date: "2027-03-01" }),
    ]);
    const a = p.actions.find((x) => x.destination === "calendar")!;
    expect(a.kindLabel).toBe("Create renewal");
  });

  it("every date row in the table is answered by exactly one action", () => {
    const items = [
      row({ id: "field-dateofbirth", key: "dateOfBirth", label: "Date Of Birth", value: "1975-04-12", date: "1975-04-12" }),
      row({ id: "field-reportdate", key: "reportDate", label: "Report Date", value: "2026-06-23", date: "2026-06-23" }),
      row({ id: "field-expirationdate", key: "expirationDate", label: "Expiration Date", value: "2027-01-31", date: "2027-01-31" }),
    ];
    const p = planRows(items);
    for (const it of items) {
      const owning = p.actions.filter((a) => a.itemIds.includes(it.id));
      expect(owning.length, `${it.key} produced ${owning.length} actions`).toBe(1);
    }
  });

  it("is deterministic, and the same date is never proposed twice", () => {
    const items = [
      row({ id: "field-dateofbirth", key: "dateOfBirth", label: "Date Of Birth", value: "1975-04-12", date: "1975-04-12" }),
      row({ id: "field-birthday", key: "birthday", label: "Birthday", value: "1975-04-12", date: "1975-04-12" }),
    ];
    const p = planRows(items);
    const keys = p.actions.map((a) => a.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    // Two spellings of one birthday cannot become two yearly events.
    expect(p.actions.filter((a) => a.payload?.ruleType === "birthday")).toHaveLength(1);
  });
});

describe("a date with no record behind it still reaches the calendar", () => {
  it("creates a standalone event rather than a field write", () => {
    const p = planRows(
      [row({ id: "field-expirationdate", key: "expirationDate", label: "Expiration Date", value: "2027-01-31", date: "2027-01-31" })],
      { primaryProfileId: undefined, index: emptyEntityIndex() },
    );
    const a = p.actions.find((x) => x.destination === "calendar")!;
    expect(a.operation).toBe("CREATE");
    expect(a.target.kind).toBe("event");
    expect(a.payload.fields).toBeUndefined();
    expect(a.payload.createEvent).toBe(true);
  });
});
