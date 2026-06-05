// Regression tests for document-extraction date/flatten helpers.
//
// Locks the fix for: "uploaded a vet exam report with THREE due dates and the
// system extracted none of them." Root causes were (1) a date regex that
// required zero-padded months/days so "6/4/2029" was rejected, and (2) nested/
// array date values collapsing to "[object Object]" and being dropped.

import { describe, it, expect } from "vitest";
import {
  normalizeDateString,
  containsDate,
  flattenExtractedData,
  unwrapValue,
  buildReminderFields,
  toCamelKey,
  isPlaceholderValue,
} from "@shared/extraction-normalize";

describe("normalizeDateString", () => {
  it("parses single-digit US dates as printed on the certificate", () => {
    expect(normalizeDateString("6/4/2029")).toBe("2029-06-04");
    expect(normalizeDateString("12/16/2023")).toBe("2023-12-16");
    expect(normalizeDateString("6-4-2029")).toBe("2029-06-04");
  });

  it("parses zero-padded and ISO dates", () => {
    expect(normalizeDateString("06/04/2029")).toBe("2029-06-04");
    expect(normalizeDateString("2029-06-04")).toBe("2029-06-04");
    expect(normalizeDateString("2029/6/4")).toBe("2029-06-04");
  });

  it("parses month-name dates", () => {
    expect(normalizeDateString("Jun 4, 2029")).toBe("2029-06-04");
    expect(normalizeDateString("June 4 2029")).toBe("2029-06-04");
    expect(normalizeDateString("4 Jun 2029")).toBe("2029-06-04");
  });

  it("finds a date embedded in a larger string", () => {
    expect(normalizeDateString("Due Date: 6/4/2029")).toBe("2029-06-04");
  });

  it("returns null for non-dates and impossible dates", () => {
    expect(normalizeDateString("")).toBeNull();
    expect(normalizeDateString("hello")).toBeNull();
    expect(normalizeDateString(null)).toBeNull();
    expect(normalizeDateString("13/40/2029")).toBeNull();
    expect(normalizeDateString("50.80")).toBeNull(); // a weight, not a date
  });
});

describe("containsDate", () => {
  it("detects dates regardless of padding", () => {
    expect(containsDate("6/4/2029")).toBe(true);
    expect(containsDate("2023-12-16")).toBe(true);
    expect(containsDate("Husky")).toBe(false);
  });
});

describe("unwrapValue", () => {
  it("unwraps {value, confidence} envelopes", () => {
    expect(unwrapValue({ value: "6/4/2029", confidence: 0.9 })).toBe("6/4/2029");
  });
  it("leaves real nested objects intact", () => {
    const nested = { Rabies: "6/4/2029" };
    expect(unwrapValue(nested)).toBe(nested);
  });
});

describe("flattenExtractedData", () => {
  it("splits a nested date table into one field per date", () => {
    const flat = flattenExtractedData({
      preventiveCareDue: {
        Rabies: "6/4/2029",
        DAPP: "6/4/2027",
        "Fecal Exam": "12/16/2023",
      },
    });
    const dateValues = Object.values(flat).filter((v) => containsDate(v));
    expect(dateValues).toHaveLength(3);
    // Each leaf is preserved with its own readable key.
    const entries = Object.entries(flat);
    expect(entries.some(([k, v]) => /rabies/i.test(k) && v === "6/4/2029")).toBe(true);
    expect(entries.some(([k, v]) => /dapp/i.test(k) && v === "6/4/2027")).toBe(true);
    expect(entries.some(([k, v]) => /fecal/i.test(k) && v === "12/16/2023")).toBe(true);
  });

  it("splits an array of {name, dueDate} into named date fields", () => {
    const flat = flattenExtractedData({
      vaccines: [
        { name: "Rabies", dueDate: "6/4/2029" },
        { name: "DAPP", dueDate: "6/4/2027" },
      ],
    });
    const entries = Object.entries(flat);
    expect(entries.some(([k, v]) => /rabies/i.test(k) && v === "6/4/2029")).toBe(true);
    expect(entries.some(([k, v]) => /dapp/i.test(k) && v === "6/4/2027")).toBe(true);
  });

  it("passes scalars through with readable keys", () => {
    const flat = flattenExtractedData({ petName: "Rex", weight: "50.80 lbs" });
    expect(Object.values(flat)).toContain("Rex");
    expect(Object.values(flat)).toContain("50.80 lbs");
  });

  it("end-to-end: a same-date pair of vaccines both survive flattening", () => {
    // Leptospirosis and DAPP are BOTH due 6/4/2029 — distinct fields, same date.
    const flat = flattenExtractedData({
      preventiveCareDue: { Leptospirosis: "6/4/2029", DAPP: "6/4/2029", Bordetella: "6/4/2027" },
    });
    const dates = Object.values(flat).filter((v) => containsDate(v));
    expect(dates).toHaveLength(3);
  });

  it("end-to-end: the vet exam report yields exactly three due dates", () => {
    // Shape the model returns for the second photo (a sparse two-column table).
    const extractedData = {
      petName: "Rex Sennabaum",
      species: "Canine",
      preventiveCareDueInTheFuture: {
        Rabies: "6/4/2029",
        DAPP: "6/4/2027",
        "Fecal Exam": "12/16/2023",
      },
    };
    const flat = flattenExtractedData(extractedData);
    const normalizedDueDates = Object.values(flat)
      .map((v) => normalizeDateString(v))
      .filter((d): d is string => d !== null)
      .sort();
    expect(normalizedDueDates).toEqual(["2023-12-16", "2027-06-04", "2029-06-04"]);
  });
});

describe("isPlaceholderValue (blank cells must never become fields)", () => {
  it("treats dashes / N/A / empty as placeholders", () => {
    for (const v of ["", " ", "-", "--", "—", "–", "N/A", "n/a", "None", "null", "TBD", "(N/A)"]) {
      expect(isPlaceholderValue(v)).toBe(true);
    }
  });
  it("keeps real values", () => {
    for (const v of ["6/4/2029", "Rex", "50.80 lbs", 0, false, "WAT110U"]) {
      expect(isPlaceholderValue(v)).toBe(false);
    }
  });

  it("a vet schedule with mostly blank rows keeps only the real dates", () => {
    // The exact failure: blank rows were getting invented dates. After dropping
    // placeholders, only the printed dates survive.
    const raw = {
      preventiveCareDue: {
        "Heartworm Prevention": "—",
        "Flea Prevention": "—",
        Roundworms: "—",
        Hookworms: "—",
        Rabies: "—",
        Leptospirosis: "6/4/2029",
        DAPP: "6/4/2029",
        "Dental Prophylaxis": "—",
        Bordetella: "6/4/2027",
        "Fecal Exam": "12/16/2023",
        "Heartworm Test": "—",
      },
    };
    const flat = flattenExtractedData(raw);
    for (const k of Object.keys(flat)) {
      if (isPlaceholderValue((flat as any)[k])) delete (flat as any)[k];
    }
    const kept = Object.entries(flat);
    // Exactly the four rows that actually had dates.
    expect(kept).toHaveLength(4);
    const dates = kept.map(([, v]) => normalizeDateString(v)).sort();
    expect(dates).toEqual(["2023-12-16", "2027-06-04", "2029-06-04", "2029-06-04"]);
    expect(kept.some(([k]) => /heartworm|flea|roundworm|hookworm|rabies|dental/i.test(k))).toBe(false);
  });
});

describe("toCamelKey", () => {
  it("turns arbitrary labels into camelCase keys", () => {
    expect(toCamelKey("Policy Expiration Date")).toBe("policyExpirationDate");
    expect(toCamelKey("Rabies (due)")).toBe("rabiesDue");
    expect(toCamelKey("")).toBe("reminderDate");
  });
});

describe("buildReminderFields (model-driven, document-agnostic)", () => {
  it("creates one confirmable date field per actionable reminder, any doc type", () => {
    const fields = buildReminderFields([
      { label: "Registration expires", date: "3/15/2027", kind: "expiration" },
      { label: "Premium payment due", date: "2026-07-01", kind: "payment" },
      { label: "Annual checkup", date: "Jun 4, 2027", kind: "appointment" },
    ]);
    expect(fields).toHaveLength(3);
    expect(fields[0]).toMatchObject({ label: "Registration expires", date: "2027-03-15", isDate: true });
    expect(fields[0].suggestedEvent).toContain("Registration expires");
    expect(fields.map((f) => f.date).sort()).toEqual(["2026-07-01", "2027-03-15", "2027-06-04"]);
  });

  it("skips reminders with no parseable date and ignores non-arrays", () => {
    expect(buildReminderFields(null)).toEqual([]);
    expect(buildReminderFields([{ label: "no date here", kind: "due" }])).toEqual([]);
    expect(buildReminderFields([{ label: "junk", date: "not a date" }])).toEqual([]);
  });

  it("does not duplicate a reminder already present as an extractedData date field", () => {
    const existing = [{ label: "Rabies Due Date", value: "6/4/2029" }];
    const fields = buildReminderFields(
      [{ label: "Rabies Due Date", date: "2029-06-04", kind: "due" }],
      existing,
    );
    expect(fields).toHaveLength(0);
  });

  it("keeps two same-date reminders with different labels", () => {
    const fields = buildReminderFields([
      { label: "Leptospirosis due", date: "6/4/2029", kind: "due" },
      { label: "DAPP due", date: "6/4/2029", kind: "due" },
    ]);
    expect(fields).toHaveLength(2);
  });
});
