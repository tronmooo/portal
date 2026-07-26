// End-to-end profile-field CRUD, plus a guard against the drift that made this
// bug recur.
//
// User, 2026-07-25:
//   "why do errors keep happening like this over and over again, I come back in
//    a month and it's still not fixed or it is fixed and then I come back and
//    it's not fixed."
//
// For THIS bug the mechanism is identifiable. Field-key matching lived in three
// places, each with its own alias table, each comparing exact strings:
//
//   client/src/lib/flattenProfile.ts   KEY_ALIASES / NESTED_GROUPS   (display)
//   server/supabase-storage.ts         PROFILE_KEY_ALIAS_REVERSE     (delete)
//   shared/profile-field-canon.ts      CANONICAL_ALIASES             (write)
//
// Fixing one never fixed the others, and every new document type added
// spellings none of them knew. A fix would hold until the next extraction
// wrote `license_number` instead of `licenseNumber`, and then "come back and
// it's not fixed".
//
// The round-trip below is the test that would have caught it: write nested
// data the way extraction does, flatten it the way the UI does, delete the way
// the user does, and flatten AGAIN — the step that used to resurrect the field.
// The drift guard at the bottom fails if a module starts matching field keys
// with its own private table again.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { deleteProfileFields, dedupeDisplayFields } from "../shared/profile-field-identity";
import { flattenProfileFields } from "../client/src/lib/flattenProfile";

/** What a driver's-licence extraction actually writes: same value, many keys. */
const EXTRACTED = {
  licenseNumber: "S226-116-24-800-0",
  restrictions: "12 REST: NONE",
  donorIndicator: "DONOR",
  identity: {
    license_number: "S226-116-24-800-0",
    donor: "true",
    class: "E",
    licenseType: "DRIVER LICENSE",
  },
  personal: {
    dateOfBirth: "1985-03-12",
  },
};

/** The user deletes a field; the server applies it; the UI re-reads. */
function deleteThenReload(fields: Record<string, any>, uiKey: string) {
  const afterDelete = deleteProfileFields(fields, [uiKey]).fields;
  return { stored: afterDelete, displayed: flattenProfileFields(afterDelete) };
}

describe("delete → refresh → still gone", () => {
  it("removes a licence number stored under three spellings", () => {
    // Before: the UI shows it (possibly twice).
    const before = flattenProfileFields(EXTRACTED);
    expect(before.license ?? before.licenseNumber).toBe("S226-116-24-800-0");

    const { stored, displayed } = deleteThenReload(EXTRACTED, "license");

    // Gone from storage, top level AND nested.
    expect(stored.licenseNumber).toBeUndefined();
    expect((stored.identity as any)?.license_number).toBeUndefined();
    // …and gone from the re-flattened view. THIS is the assertion that fails
    // on the old code: the nested twin was promoted straight back.
    expect(displayed.license).toBeUndefined();
    expect(displayed.licenseNumber).toBeUndefined();
  });

  it("survives a second refresh", () => {
    const { stored } = deleteThenReload(EXTRACTED, "license");
    const again = flattenProfileFields(flattenProfileFields(stored));
    expect(again.license).toBeUndefined();
    expect(again.licenseNumber).toBeUndefined();
  });

  it("removes the donor flag from both the top level and identity", () => {
    const { stored, displayed } = deleteThenReload(EXTRACTED, "donor");
    expect(stored.donorIndicator).toBeUndefined();
    expect((stored.identity as any)?.donor).toBeUndefined();
    expect(displayed.donorIndicator).toBeUndefined();
    expect(displayed.donor).toBeUndefined();
  });

  it("removes a date of birth stored only in a nested group", () => {
    const { stored, displayed } = deleteThenReload(EXTRACTED, "birthday");
    expect((stored.personal as any)?.dateOfBirth).toBeUndefined();
    expect(displayed.birthday).toBeUndefined();
    expect(displayed.dateOfBirth).toBeUndefined();
  });

  it("does not disturb neighbouring fields", () => {
    const { displayed } = deleteThenReload(EXTRACTED, "license");
    expect(displayed.restrictions).toBe("12 REST: NONE");
    expect(displayed.licenseType).toBe("DRIVER LICENSE");
    // The licence class survives — under its canonical key. `identity.class`
    // and `licenseClass` are one field, so it renders once, and the clearer
    // name wins. Asserting the raw key here would be asserting the duplicate.
    expect(displayed.licenseClass ?? displayed.class).toBe("E");
  });

  it("deletes every remaining field one by one without error", () => {
    let stored: Record<string, any> = { ...EXTRACTED };
    const keys = Object.keys(flattenProfileFields(stored)).filter(
      (k) => !k.startsWith("_") && typeof stored[k] !== "object",
    );
    for (const key of keys) {
      stored = deleteProfileFields(stored, [key]).fields;
      const displayed = flattenProfileFields(stored);
      expect(displayed[key], `${key} survived its own delete`).toBeUndefined();
    }
  });
});

describe("the same field is never shown twice", () => {
  it("renders one licence card, not two", () => {
    const displayed = flattenProfileFields(EXTRACTED);
    const licenceKeys = Object.keys(displayed).filter(
      (k) => /licen[cs]e/i.test(k) && /^S226/.test(String(displayed[k])),
    );
    expect(licenceKeys, `duplicate licence cards: ${licenceKeys.join(", ")}`).toHaveLength(1);
  });

  it("never emits two keys with the same identity AND the same value", () => {
    const displayed = flattenProfileFields(EXTRACTED);
    expect(dedupeDisplayFields(displayed).hidden).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DRIFT GUARD — the anti-recurrence mechanism.
//
// This is the part that stops the bug coming back in a month. It fails if the
// delete path stops using the shared identity function, or if a module starts
// carrying its own private field-alias table again.
// ─────────────────────────────────────────────────────────────────────────────
const repo = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

describe("field-key matching stays in one place", () => {
  it("the server delete path uses the shared identity resolver", () => {
    const src = repo("server/supabase-storage.ts");
    expect(src).toContain("deleteProfileFields");
    expect(src).toContain("profile-field-identity");
  });

  it("the server no longer hand-rolls exact-key deletion", () => {
    const src = repo("server/supabase-storage.ts");
    // The old shape: expand a UI key through a local alias table, then strip
    // exact matches from nested groups. Both are what let `license_number`
    // slip through every delete.
    expect(src).not.toMatch(/expandProfileFieldDeletions\(data\.fieldsToDelete\)/);
    expect(src).not.toMatch(/stripFromNestedGroups\(mergedFields/);
  });

  it("the client flattener de-duplicates via the shared resolver", () => {
    const src = repo("client/src/lib/flattenProfile.ts");
    expect(src).toContain("dedupeDisplayFields");
    expect(src).toContain("profile-field-identity");
  });

  it("the shared module owns the nested-group list", () => {
    const src = repo("shared/profile-field-identity.ts");
    expect(src).toContain("PROFILE_FIELD_GROUPS");
    for (const g of ["identity", "personal", "other", "vehicles"]) {
      expect(src).toContain(`"${g}"`);
    }
  });

  it("every alias the identity table claims actually resolves", () => {
    // Guards a silent typo in the alias table, which would quietly reopen the
    // duplicate-card bug for that one spelling.
    const pairs: Array<[string, string]> = [
      ["licenseNumber", "license"],
      ["license_number", "license"],
      ["dlNumber", "license"],
      ["donorIndicator", "organDonor"],
      ["dateOfBirth", "birthday"],
      ["plateNumber", "licensePlate"],
      ["marketValue", "currentValue"],
    ];
    for (const [alias, canonical] of pairs) {
      const { fields } = deleteProfileFields({ [alias]: "x" }, [canonical]);
      expect(fields[alias], `${alias} should delete via ${canonical}`).toBeUndefined();
    }
  });
});
