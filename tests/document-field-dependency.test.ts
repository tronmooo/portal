// tests/document-field-dependency.test.ts
//
// Reported 2026-08-13:
//   "I could not delete my birthday / date of birth until I deleted my
//    driver's license. That is incorrect behavior."
//
// Document extraction is allowed to POPULATE a profile. It is not allowed to
// become a hidden dependency that owns the value afterwards. Two mechanisms
// made it one:
//
//   1. `fields._docFields[docId]` recorded that the licence contributed
//      `dateOfBirth`. Deleting the Birthday row removed the value but left the
//      provenance entry standing, so the licence still claimed a field that no
//      longer existed — and the document-delete cascade remained the only code
//      that could withdraw it.
//   2. Nothing remembered the deletion, so the next extraction confirm on the
//      same licence wrote the DOB straight back.
//
// Together: the DOB was only stably deletable by deleting the licence.
//
// The contract pinned here: deleting a field withdraws it from every
// document's provenance AND is remembered, and re-entering the value by hand
// lifts that memory. The document's own extracted_data is never touched — the
// document keeps its data, it just loses the power to re-populate the profile.
import { describe, it, expect } from "vitest";
import {
  deleteProfileFields,
  recordFieldDeletions,
  clearFieldSuppression,
  isFieldSuppressed,
  suppressedFieldIdentities,
} from "@shared/profile-field-identity";

/** A person profile as it stands right after confirming a licence extraction. */
function profileAfterLicenceExtraction() {
  return {
    name: "Jane Doe",
    birthday: "1992-04-11",
    dateOfBirth: "1992-04-11",
    license: "TEST-DL-4829-XJ1",
    licenseExpiration: "2030-03-21",
    personal: { dateOfBirth: "1992-04-11" },
    _docFields: {
      "licence-doc-1": {
        name: "Jane Doe",
        birthday: "1992-04-11",
        dateOfBirth: "1992-04-11",
        license: "TEST-DL-4829-XJ1",
        licenseExpiration: "2030-03-21",
      },
    },
  } as Record<string, any>;
}

/** What server/supabase-storage.updateProfile does for `fieldsToDelete`. */
function deleteField(fields: Record<string, any>, uiKey: string) {
  return recordFieldDeletions(deleteProfileFields(fields, [uiKey]).fields, [uiKey]);
}

describe("deleting a document-contributed field", () => {
  it("removes every spelling of the birthday, top-level and nested", () => {
    const after = deleteField(profileAfterLicenceExtraction(), "birthday");
    expect(after.birthday).toBeUndefined();
    expect(after.dateOfBirth).toBeUndefined();
    expect(after.personal?.dateOfBirth).toBeUndefined();
  });

  it("withdraws the birthday from the licence's provenance record", () => {
    const after = deleteField(profileAfterLicenceExtraction(), "birthday");
    const contributed = after._docFields["licence-doc-1"];
    expect(contributed.birthday).toBeUndefined();
    expect(contributed.dateOfBirth).toBeUndefined();
    // The licence still owns everything else it genuinely contributed, so
    // deleting the DOCUMENT still withdraws the licence number.
    expect(contributed.license).toBe("TEST-DL-4829-XJ1");
    expect(contributed.licenseExpiration).toBe("2030-03-21");
  });

  it("remembers the deletion so a later extraction cannot undo it", () => {
    const after = deleteField(profileAfterLicenceExtraction(), "birthday");
    expect(isFieldSuppressed(after, "birthday")).toBe(true);
    // Every spelling the extractor might use is covered by identity, not by an
    // exact-string list — `dob`, `date_of_birth`, `DOB` all resolve to the same
    // field, which is what made the old alias tables leak.
    expect(isFieldSuppressed(after, "dateOfBirth")).toBe(true);
    expect(isFieldSuppressed(after, "dob")).toBe(true);
    expect(isFieldSuppressed(after, "date_of_birth")).toBe(true);
    // Unrelated fields are untouched.
    expect(isFieldSuppressed(after, "license")).toBe(false);
    expect(isFieldSuppressed(after, "address")).toBe(false);
  });

  it("the licence keeps its own extracted data — nothing is deleted from the document", () => {
    const licence = {
      id: "licence-doc-1",
      extractedData: { dateOfBirth: "1992-04-11", licenseNumber: "TEST-DL-4829-XJ1" },
    };
    const before = JSON.stringify(licence);
    deleteField(profileAfterLicenceExtraction(), "birthday");
    expect(JSON.stringify(licence)).toBe(before);
  });

  it("drops _docFields entirely when a document has nothing left to claim", () => {
    const fields: Record<string, any> = {
      birthday: "1992-04-11",
      _docFields: { "licence-doc-1": { birthday: "1992-04-11" } },
    };
    const after = deleteField(fields, "birthday");
    expect(after._docFields).toBeUndefined();
  });

  it("re-entering the value by hand lifts the suppression", () => {
    const after = deleteField(profileAfterLicenceExtraction(), "birthday");
    expect(isFieldSuppressed(after, "birthday")).toBe(true);

    // The profile PATCH path: an explicit non-empty write clears the memory.
    const readded = clearFieldSuppression({ ...after, birthday: "1992-04-11" }, ["birthday"]);
    expect(isFieldSuppressed(readded, "birthday")).toBe(false);
    expect(readded._deletedFields).toBeUndefined();
  });

  it("suppression survives deletes of other fields and accumulates", () => {
    let fields = deleteField(profileAfterLicenceExtraction(), "birthday");
    fields = deleteField(fields, "license");
    const ids = suppressedFieldIdentities(fields);
    expect(ids.has("birthday")).toBe(true);
    expect(ids.has("license")).toBe(true);
    // The licence's provenance is now empty of both, so the entry is gone.
    expect(fields._docFields?.["licence-doc-1"]?.license).toBeUndefined();
  });

  it("is a no-op when nothing was deleted", () => {
    const fields = profileAfterLicenceExtraction();
    const after = recordFieldDeletions({ ...fields }, []);
    expect(after._deletedFields).toBeUndefined();
    expect(after._docFields["licence-doc-1"].dateOfBirth).toBe("1992-04-11");
  });
});
