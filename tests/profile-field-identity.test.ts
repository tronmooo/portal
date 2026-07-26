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
