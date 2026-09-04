// Regression: internal bookkeeping is never shown as a field, and never
// pretends to be deletable.
//
// User report 2026-09-04: a person's profile showed a section titled
// "_extraction Actions" holding one entry — a dedupe key ("1BISQTQ") and a
// timestamp — with a delete X on it. "Whenever I press the x button, nothing
// happens", followed by "409: Profile edit kept colliding with another writer".
//
// That X could never have worked: `_extractionActions` is the marker a
// document write leaves so a re-run recognises its own work, and the delete
// sweep skips reserved keys by design. The screen and the sweep now decide
// what is reserved with the SAME predicate, so an undeletable field cannot be
// offered for deletion again.

import { describe, it, expect } from "vitest";
import { deleteProfileFields, isReservedFieldKey } from "../shared/profile-field-identity";

const FIELDS = {
  allergies: "Fish",
  dateOfBirth: "1975-04-12",
  _docFields: { "doc-1": { dateOfBirth: "1975-04-12" } },
  _extractionActions: { "1bisqtq": "2026-09-04T16:07:47.992Z" },
};

describe("reserved profile field keys", () => {
  it("recognises the app's own bookkeeping", () => {
    expect(isReservedFieldKey("_extractionActions")).toBe(true);
    expect(isReservedFieldKey("_docFields")).toBe(true);
    expect(isReservedFieldKey("_ownershipPercentage")).toBe(true);
  });

  it("does not claim a user's field is reserved", () => {
    for (const k of ["allergies", "dateOfBirth", "eye color", "identity", ""]) {
      expect(isReservedFieldKey(k)).toBe(false);
    }
    expect(isReservedFieldKey(undefined)).toBe(false);
  });

  it("the delete sweep leaves reserved containers untouched", () => {
    // The exact click from the report: remove the dedupe key inside the marker.
    const out = deleteProfileFields(FIELDS, ["1bisqtq"]);
    expect(out.removed).toEqual([]);
    expect(out.fields._extractionActions).toEqual(FIELDS._extractionActions);
    expect(out.fields._docFields).toEqual(FIELDS._docFields);
  });

  it("a dotted path into a reserved container is refused too", () => {
    const out = deleteProfileFields(FIELDS, ["_extractionActions.1bisqtq"]);
    expect(out.removed).toEqual([]);
    expect(out.fields._extractionActions).toEqual(FIELDS._extractionActions);
  });

  it("still deletes real fields, and the reserved ones ride along", () => {
    const out = deleteProfileFields(FIELDS, ["allergies"]);
    expect(out.removed).toEqual(["allergies"]);
    expect(out.fields.allergies).toBeUndefined();
    expect(out.fields.dateOfBirth).toBe("1975-04-12");
    expect(out.fields._extractionActions).toEqual(FIELDS._extractionActions);
  });

  it("a screen listing user fields drops exactly the reserved ones", () => {
    // The rule the Info and Detail pages apply before rendering a field.
    const listed = Object.keys(FIELDS).filter((k) => !isReservedFieldKey(k));
    expect(listed).toEqual(["allergies", "dateOfBirth"]);
  });
});
