// Field identity: delete actually deletes, and one field renders once.
//
// User report 2026-07-25 (Info tab screenshot):
//   "It's not allowing me to delete anything here and what's all this data
//    doing here none of it makes sense… There's a bunch of duplicates."
//
// WHY IT KEPT COMING BACK. Three layers matched field keys by EXACT STRING,
// each with its own alias table — the client flattener (display), the server
// updateProfile (delete), and profile-field-canon (write). A key spelled
// `license_number` matched none of them, so it survived every delete and
// rendered as a second card. Fixing one table never fixed the others.
//
// These tests run against the SHARED identity function all three now use.
import { describe, it, expect } from "vitest";
import {
  fieldIdentity,
  sameField,
  normalizeKey,
  deleteProfileFields,
  dedupeDisplayFields,
  fieldBelongsOnProfileType,
  PROFILE_FIELD_GROUPS,
  cleanupStoredProfileFields,
} from "../shared/profile-field-identity";

// The exact fields from the screenshot.
const LICENSE_PROFILE_FIELDS = {
  license: "S226-116-24-800-0",
  licenseNumber: "S226-116-24-800-0",
  restrictions: "12 REST: NONE",
  donorIndicator: "DONOR",
  status: "SAFE DRIVER",
  vendorPhone: "(619) 625-5263",
  customerName: "SENNABAUN, ROBERT",
  identity: {
    class: "E",
    donor: "true",
    safeDriver: "SAFE DRIVER",
    licenseType: "DRIVER LICENSE",
    endorsements: "NONE",
    restrictions: "NONE",
  },
  other: {
    make: "Honda",
    year: "2021",
    status: "SAFE DRIVER",
    licenseplate: "8YPJ480",
  },
};

describe("field identity collapses every spelling of one field", () => {
  it("treats all license-number spellings as one field", () => {
    const spellings = [
      "license", "licenseNumber", "license_number", "LICENSE NUMBER",
      "licenseNo", "LicenseNo", "dlNumber", "driversLicenseNumber",
    ];
    const ids = spellings.map(fieldIdentity);
    expect(new Set(ids).size, ids.join(",")).toBe(1);
    expect(ids[0]).toBe("license");
  });

  it("collapses the other reported twins", () => {
    expect(sameField("donor", "donorIndicator")).toBe(true);
    expect(sameField("safeDriver", "safe_driver")).toBe(true);
    expect(sameField("restrictions", "RESTRICTIONS")).toBe(true);
    expect(sameField("endorsements", "Endorsement")).toBe(true);
    expect(sameField("dateOfBirth", "dob")).toBe(true);
    expect(sameField("licenseplate", "License Plate")).toBe(true);
  });

  it("keeps genuinely different fields apart", () => {
    expect(sameField("license", "licenseState")).toBe(false);
    expect(sameField("license", "licenseExpiration")).toBe(false);
    expect(sameField("phone", "address")).toBe(false);
    expect(sameField("make", "model")).toBe(false);
    // A near-miss that must NOT merge.
    expect(sameField("licenseClass", "licenseType")).toBe(false);
  });

  it("normalizes formatting without needing an alias entry", () => {
    expect(normalizeKey("Vendor Phone")).toBe("vendorphone");
    expect(fieldIdentity("some_unknown_field")).toBe(fieldIdentity("someUnknownField"));
  });
});

describe("deleting a field actually deletes it", () => {
  it("removes every spelling, top level AND nested", () => {
    // The blocker: deleting "License" left identity.licenseNumber behind, and
    // the flattener promoted it right back on the next read.
    const { fields, removed } = deleteProfileFields(LICENSE_PROFILE_FIELDS, ["license"]);
    expect(fields.license).toBeUndefined();
    expect(fields.licenseNumber).toBeUndefined();
    expect(removed).toEqual(expect.arrayContaining(["license", "licenseNumber"]));
  });

  it("sweeps a nested group even when the UI key differs in spelling", () => {
    const { fields } = deleteProfileFields(LICENSE_PROFILE_FIELDS, ["donor"]);
    expect(fields.donorIndicator).toBeUndefined();
    expect((fields.identity as any)?.donor).toBeUndefined();
  });

  it("removes a field that exists in TWO nested groups at once", () => {
    const { fields } = deleteProfileFields(LICENSE_PROFILE_FIELDS, ["status"]);
    expect(fields.status).toBeUndefined();
    expect((fields.other as any)?.status).toBeUndefined();
  });

  it("is idempotent — deleting twice is not an error", () => {
    const once = deleteProfileFields(LICENSE_PROFILE_FIELDS, ["license"]).fields;
    const twice = deleteProfileFields(once, ["license"]);
    expect(twice.removed).toEqual([]);
    expect(twice.fields.license).toBeUndefined();
  });

  it("leaves every other field untouched", () => {
    const { fields } = deleteProfileFields(LICENSE_PROFILE_FIELDS, ["license"]);
    expect(fields.restrictions).toBe("12 REST: NONE");
    expect(fields.customerName).toBe("SENNABAUN, ROBERT");
    expect((fields.identity as any).class).toBe("E");
    expect((fields.other as any).make).toBe("Honda");
  });

  it("drops a nested group once it is emptied", () => {
    const { fields } = deleteProfileFields(
      { identity: { donor: "true" }, name: "R" },
      ["donor"],
    );
    expect(fields.identity).toBeUndefined();
    expect(fields.name).toBe("R");
  });

  it("never touches reserved metadata", () => {
    const { fields } = deleteProfileFields(
      { _ownershipPercentage: 50, license: "x" },
      ["license"],
    );
    expect(fields._ownershipPercentage).toBe(50);
  });

  it("handles empty and malformed input safely", () => {
    expect(deleteProfileFields(null, ["license"]).fields).toEqual({});
    expect(deleteProfileFields({ a: 1 }, []).fields).toEqual({ a: 1 });
    expect(deleteProfileFields({ a: 1 }, null).fields).toEqual({ a: 1 });
  });

  it("deletes several fields in one call", () => {
    const { fields } = deleteProfileFields(LICENSE_PROFILE_FIELDS, ["license", "donor", "restrictions"]);
    expect(fields.license).toBeUndefined();
    expect(fields.donorIndicator).toBeUndefined();
    expect(fields.restrictions).toBeUndefined();
    expect((fields.identity as any)?.restrictions).toBeUndefined();
  });

  // ── Nested objects the group whitelist never knew about ────────────────────
  // User, 2026-08-05: "when I delete stuff from the info tab I want it to be
  // gone forever why is it still there".
  //
  // The Info tab renders EVERY object-valued field as a group with a delete
  // button on each cell, but this function only descended into the ~17 names in
  // PROFILE_FIELD_GROUPS. Extraction invents group names freely, so a field
  // under `education`/`employment`/`credentials` had a working-looking X that
  // removed nothing — the PATCH succeeded and the field survived the refetch.
  it("deletes a field inside a nested object that is NOT a known group name", () => {
    const fields = {
      education: { school: "UCSD", degree: "BS" },
      employment: { employer: "Acme" },
    };
    expect((PROFILE_FIELD_GROUPS as readonly string[]).includes("education")).toBe(false);

    const { fields: after, removed } = deleteProfileFields(fields, ["school"]);
    expect((after.education as any)?.school).toBeUndefined();
    expect((after.education as any)?.degree).toBe("BS");
    expect(removed).toEqual(["education.school"]);
  });

  it("drops an unknown nested object once its last field is deleted", () => {
    const { fields } = deleteProfileFields(
      { credentials: { certNumber: "A-1" }, name: "R" },
      ["certNumber"],
    );
    expect(fields.credentials).toBeUndefined();
    expect(fields.name).toBe("R");
  });

  it("still matches by identity inside an unknown nested object", () => {
    // `licenseNo` folds to `license`, so deleting the UI's "License" reaches it
    // even though nobody listed `vaultedIds` as a group.
    const { fields } = deleteProfileFields(
      { vaultedIds: { licenseNo: "S226-116-24-800-0", passport: "X1" } },
      ["license"],
    );
    expect((fields.vaultedIds as any)?.licenseNo).toBeUndefined();
    expect((fields.vaultedIds as any)?.passport).toBe("X1");
  });

  it("deletes a whole group by its own key", () => {
    // Previously impossible: the group branch consumed the key before the
    // top-level check ran, so `identity` could be emptied field by field but
    // never removed outright.
    const { fields, removed } = deleteProfileFields(LICENSE_PROFILE_FIELDS, ["identity"]);
    expect(fields.identity).toBeUndefined();
    expect(removed).toContain("identity");
    expect(fields.other).toBeDefined();
  });

  it("leaves arrays alone unless the array's own key is deleted", () => {
    const src = { loans: [{ balance: 100 }], balance: 250 };
    expect(deleteProfileFields(src, ["balance"]).fields).toEqual({ loans: [{ balance: 100 }] });
    expect(deleteProfileFields(src, ["loans"]).fields).toEqual({ balance: 250 });
  });
});

describe("one field renders once", () => {
  it("hides the duplicate license card", () => {
    const flat = { license: "S226-116-24-800-0", licenseNumber: "S226-116-24-800-0" };
    const { fields, hidden } = dedupeDisplayFields(flat);
    expect(Object.keys(fields)).toHaveLength(1);
    expect(hidden).toHaveLength(1);
    expect(fields.license ?? fields.licenseNumber).toBe("S226-116-24-800-0");
  });

  it("collapses DONOR / true and STATUS / SAFE DRIVER", () => {
    expect(dedupeDisplayFields({ donorIndicator: "DONOR", donor: "true" }).hidden).toHaveLength(1);
    expect(dedupeDisplayFields({ status: "SAFE DRIVER", safeDriver: "SAFE DRIVER" }).hidden).toHaveLength(0);
    // ^ status and safeDriver are DIFFERENT identities, so both stay — the
    //   right call, because "status" could legitimately hold something else.
  });

  it("keeps both when the values genuinely differ", () => {
    const { fields, hidden } = dedupeDisplayFields({
      license: "AAA-111", licenseNumber: "BBB-222",
    });
    expect(hidden).toHaveLength(0);
    expect(Object.keys(fields)).toHaveLength(2);
  });

  it("drops an empty twin in favour of the one carrying a value", () => {
    const { fields } = dedupeDisplayFields({ license: "", licenseNumber: "S226" });
    expect(Object.values(fields)).toEqual(["S226"]);
  });

  it("treats currency formatting as the same number", () => {
    expect(dedupeDisplayFields({ currentValue: "$26,000", marketValue: "26000" }).hidden)
      .toHaveLength(1);
  });

  it("leaves a single-key object completely alone", () => {
    const one = { license: "S226" };
    expect(dedupeDisplayFields(one).fields).toEqual(one);
  });
});

describe("fields land on the right kind of profile", () => {
  it("rejects vehicle fields on a person", () => {
    // The screenshot: MAKE Honda / YEAR 2021 / LICENSEPLATE on a HUMAN.
    for (const key of ["make", "model", "year", "licensePlate", "vin", "mileage"]) {
      expect(fieldBelongsOnProfileType(key, "person"), key).toBe(false);
      expect(fieldBelongsOnProfileType(key, "self"), key).toBe(false);
    }
  });

  it("allows those same fields on a vehicle", () => {
    for (const key of ["make", "model", "year", "licensePlate"]) {
      expect(fieldBelongsOnProfileType(key, "vehicle"), key).toBe(true);
    }
  });

  it("allows ordinary person fields", () => {
    for (const key of ["license", "birthday", "phone", "address", "restrictions"]) {
      expect(fieldBelongsOnProfileType(key, "person"), key).toBe(true);
    }
  });

  it("never filters unknown fields — it is not a schema police", () => {
    expect(fieldBelongsOnProfileType("somethingNovel", "person")).toBe(true);
  });

  it("rejects receipt residue on a person", () => {
    // The screenshot also carried VENDOR PHONE (619) 625-5263 — the SHOP's
    // number, filed on Robert as if it were his.
    for (const key of ["vendorPhone", "vendorName", "merchant", "subtotal", "taxAmount"]) {
      expect(fieldBelongsOnProfileType(key, "person"), key).toBe(false);
    }
  });

  it("still keeps the person's own name from a receipt", () => {
    // `customerName` folds to `name`, which really is theirs.
    expect(fieldBelongsOnProfileType("customerName", "person")).toBe(true);
    expect(fieldBelongsOnProfileType("phone", "person")).toBe(true);
  });

  it("matches type-only fields however they are spelled", () => {
    // The rule compares normalized identity. Written as camelCase set entries
    // and compared raw, the whole receipt bucket would silently match nothing.
    for (const spelling of ["vendorPhone", "vendor_phone", "VENDOR PHONE", "vendorphone"]) {
      expect(fieldBelongsOnProfileType(spelling, "person"), spelling).toBe(false);
    }
    for (const spelling of ["licensePlate", "license_plate", "LICENSE PLATE", "plateNumber"]) {
      expect(fieldBelongsOnProfileType(spelling, "person"), spelling).toBe(false);
    }
  });
});

describe("the nested-group list is shared, not re-declared", () => {
  it("covers the groups seen in the report", () => {
    for (const g of ["identity", "other", "personal", "vehicles", "finance"]) {
      expect(PROFILE_FIELD_GROUPS as readonly string[]).toContain(g);
    }
  });
});

// ─── cleanupStoredProfileFields — stored-twin collapse (2026-07-27) ─────────
// The self-heal that runs on profile-detail read: one canonical storage key
// per logical field, agreeing twins collapsed, differing values untouched.
describe("cleanupStoredProfileFields", () => {
  it("collapses agreeing top-level twins and nested-group copies of one field", () => {
    const r = cleanupStoredProfileFields({
      mileage: 69063,
      currentMileage: 69063,               // agreeing top-level twin
      vehicles: { mileage: 69063, licensePlate: "8YPJ480" }, // agreeing nested copy
      make: "Honda",
    });
    expect(r.changed).toBe(true);
    expect(r.fields.mileage).toBe(69063);
    expect(r.fields).not.toHaveProperty("currentMileage");
    expect(r.fields.vehicles).not.toHaveProperty("mileage");
    expect(r.fields.vehicles.licensePlate).toBe("8YPJ480"); // untouched neighbor
    expect(r.removed.sort()).toEqual(["currentMileage", "vehicles.mileage"].sort());
  });

  it("never drops a twin whose value disagrees", () => {
    const r = cleanupStoredProfileFields({
      mileage: 69063,
      currentMileage: 80000, // conflicting — must survive
    });
    expect(r.fields.currentMileage).toBe(80000);
    expect(r.fields.mileage).toBe(69063);
  });

  it("never deletes a nested value in favor of an empty top-level twin", () => {
    const r = cleanupStoredProfileFields({
      mileage: "",
      vehicles: { mileage: 69063 },
    });
    expect(r.fields.vehicles.mileage).toBe(69063);
  });

  it("is idempotent and reports no change on a clean profile", () => {
    const clean = { mileage: 69063, make: "Honda", vehicles: { licensePlate: "8YPJ480" } };
    const r = cleanupStoredProfileFields(clean);
    expect(r.changed).toBe(false);
    expect(r.fields).toEqual(clean);
    const r2 = cleanupStoredProfileFields(r.fields);
    expect(r2.changed).toBe(false);
  });

  it("preserves reserved underscore metadata untouched", () => {
    const r = cleanupStoredProfileFields({ _mileageHistory: [{ value: 80000 }], mileage: 69063 });
    expect(r.fields._mileageHistory).toEqual([{ value: 80000 }]);
  });
});
