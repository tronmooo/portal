// Deleting a document offers to delete the data it saved — so the preview and
// the purge must agree on exactly which fields those are.
//
// User, 2026-08-05: "When you delete a document, you should delete all the data
// that comes with it and it should ask before you delete a document. If there is
// data I've saved with the document there should be an option when you delete the
// document it should say are you sure? Do you want to remove all the data in the
// info?"
//
// The dialog's promise IS the user's consent. If it lists five fields and the
// delete removes three, they consented to something that didn't happen — which
// is why one function computes the set for both.
import { describe, it, expect } from "vitest";
import {
  documentDerivedFields,
  derivedFieldKeys,
} from "../shared/document-field-provenance";
import { deleteProfileFields } from "../shared/profile-field-identity";

const DOC_ID = "doc-license-1";

// A person profile as a scanned driver's licence leaves it: some fields saved
// through confirm-extraction (so provenance exists), some written by an earlier
// path with no provenance at all, and one nested under a group.
const PROFILE_FIELDS = {
  name: "Jane Doe",
  birthday: "1992-04-11",
  licenseNumber: "S226-116-24-800-0",
  expirationDate: "2030-03-21",
  documentLabel: "Driver License",
  purposeNote: "FOR APP TESTING",
  bloodType: "O+",                       // nothing to do with the licence
  identity: { class: "C", donor: "true" },
  _docFields: {
    [DOC_ID]: {
      licenseNumber: "S226-116-24-800-0",
      expirationDate: "2030-03-21",
      documentLabel: "Driver License",
    },
  },
  _ownershipPercentage: 100,
};

const EXTRACTED = {
  licenseNumber: "S226-116-24-800-0",
  expirationDate: "2030-03-21",
  class: "C",
  purposeNote: "FOR APP TESTING",
};

describe("which fields did this document save", () => {
  it("finds the fields recorded by confirm-extraction", () => {
    const found = documentDerivedFields(PROFILE_FIELDS, DOC_ID, EXTRACTED);
    const byPath = Object.fromEntries(found.map((f) => [f.path, f]));
    expect(byPath.licenseNumber?.via).toBe("provenance");
    expect(byPath.expirationDate?.via).toBe("provenance");
    expect(byPath.documentLabel?.via).toBe("provenance");
  });

  it("ALSO finds fields the document extracted with no provenance recorded", () => {
    // Provenance only exists for fields accepted through confirm-extraction.
    // Real profiles are full of fields written before that existed, or by chat's
    // update_profile — just as much "the data that came with the document".
    const found = documentDerivedFields(PROFILE_FIELDS, DOC_ID, EXTRACTED);
    const byPath = Object.fromEntries(found.map((f) => [f.path, f]));
    expect(byPath.purposeNote?.via).toBe("extraction");
    // …including one nested inside a group, matched by identity: the document
    // extracted "class", the profile stores it as identity.class.
    expect(byPath["identity.class"]?.via).toBe("extraction");
  });

  it("leaves alone anything the document had nothing to do with", () => {
    const paths = documentDerivedFields(PROFILE_FIELDS, DOC_ID, EXTRACTED).map((f) => f.path);
    expect(paths).not.toContain("bloodType");
    expect(paths).not.toContain("name");
    expect(paths).not.toContain("birthday");
    expect(paths).not.toContain("identity.donor");
  });

  it("never returns reserved metadata as user data", () => {
    const paths = documentDerivedFields(PROFILE_FIELDS, DOC_ID, EXTRACTED).map((f) => f.path);
    expect(paths.some((p) => p.startsWith("_"))).toBe(false);
  });

  it("flags a field the user has edited since the document saved it", () => {
    const edited = { ...PROFILE_FIELDS, expirationDate: "2031-01-01" };
    const found = documentDerivedFields(edited, DOC_ID, EXTRACTED);
    const byPath = Object.fromEntries(found.map((f) => [f.path, f]));
    expect(byPath.expirationDate.edited).toBe(true);
    expect(byPath.licenseNumber.edited).toBe(false);
  });

  it("does not call a field edited when there is no saved value to compare", () => {
    const found = documentDerivedFields(
      { someNote: "typed by hand" },
      DOC_ID,
      { someNote: "" },       // extracted but blank
    );
    expect(found).toHaveLength(1);
    expect(found[0].edited).toBe(false);
  });

  it("reports nothing for a document that saved nothing", () => {
    expect(documentDerivedFields(PROFILE_FIELDS, "some-other-doc", {})).toEqual([]);
    expect(documentDerivedFields(PROFILE_FIELDS, null, null)).toEqual([]);
    expect(documentDerivedFields(null, DOC_ID, EXTRACTED)).toEqual([]);
  });

  it("labels fields for a human, not a database", () => {
    const found = documentDerivedFields(PROFILE_FIELDS, DOC_ID, EXTRACTED);
    const labels = found.map((f) => f.label);
    expect(labels).toContain("License Number");
    expect(labels).toContain("Expiration Date");
  });
});

describe("the purge removes exactly what the dialog listed", () => {
  it("every previewed field is gone afterwards, and nothing else is", () => {
    const preview = documentDerivedFields(PROFILE_FIELDS, DOC_ID, EXTRACTED);
    expect(preview.length).toBeGreaterThan(0);

    const { fields: after } = deleteProfileFields(PROFILE_FIELDS, derivedFieldKeys(preview));

    // Everything promised is gone — including the nested one.
    for (const f of preview) {
      const [head, leaf] = f.path.split(".");
      if (leaf) expect((after as any)[head]?.[leaf]).toBeUndefined();
      else expect((after as any)[head]).toBeUndefined();
    }
    // Untouched: the fields the document never contributed.
    expect(after.bloodType).toBe("O+");
    expect(after.name).toBe("Jane Doe");
    expect(after.birthday).toBe("1992-04-11");
    expect((after.identity as any)?.donor).toBe("true");
    // Reserved metadata survives the field purge (the delete route maintains
    // _docFields itself).
    expect(after._ownershipPercentage).toBe(100);
  });

  it("re-previewing after a purge finds nothing left to remove", () => {
    const preview = documentDerivedFields(PROFILE_FIELDS, DOC_ID, EXTRACTED);
    const { fields: after } = deleteProfileFields(PROFILE_FIELDS, derivedFieldKeys(preview));
    expect(documentDerivedFields(after, DOC_ID, EXTRACTED)).toEqual([]);
  });

  it("dedupes keys so one identity is asked for once", () => {
    const twins = {
      license: "S226", licenseNumber: "S226",
      _docFields: { [DOC_ID]: { licenseNumber: "S226" } },
    };
    const preview = documentDerivedFields(twins, DOC_ID, { licenseNumber: "S226" });
    expect(preview).toHaveLength(2);                     // both shown to the user
    expect(derivedFieldKeys(preview)).toHaveLength(2);   // distinct leaf keys
    const { fields: after } = deleteProfileFields(twins, derivedFieldKeys(preview));
    expect(after.license).toBeUndefined();
    expect(after.licenseNumber).toBeUndefined();
  });
});
