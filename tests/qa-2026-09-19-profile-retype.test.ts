// QA 2026-09-19 — repairing the rows F-04 left behind.
//
//   F-04 (2026-09-18) "Assets are stored as people": the profile switcher
//   listed "tires for my Dodge ram" and "my MacBook Pro m4", both typed
//   `person`, and both were offered in the loan's "+ Add owner…" dropdown and
//   in New Event → "Link to Profiles". The create path and the people pickers
//   were fixed then (tests/qa-2026-09-18-profiles.test.ts). The rows already in
//   the table were not — that is a data repair, run by
//   scripts/repair-mistyped-person-profiles.ts.
//
// The dangerous half is the decision, not the UPDATE. `looksLikeAssetName` is
// deliberately aggressive (it only breaks a tie at create time), so it fires on
// "My Mom" and on "Sarah 1990". Retyping a real person silently changes
// ownership semantics across the app and removes them from every people picker.
// `isSafeToRetypeAsThing` is therefore the one rule the repair and any future
// caller share, and it retypes only on an asset-shaped name PLUS positive
// evidence the row is not a human.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  isSafeToRetypeAsThing,
  personFieldEvidence,
  looksLikeAssetName,
} from "../shared/entity-classify";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const person = (name: string, fields: Record<string, any> = {}) => ({ type: "person", name, fields });

// ─────────────────────────────────────────────────────────────────────────────
// The two rows from the report
// ─────────────────────────────────────────────────────────────────────────────
describe("the F-04 rows, with nothing human on them, are repaired", () => {
  it("'tires for my Dodge ram' becomes a vehicle", () => {
    expect(isSafeToRetypeAsThing(person("tires for my Dodge ram"))).toBe("vehicle");
  });

  it("'my MacBook Pro m4' becomes an asset", () => {
    expect(isSafeToRetypeAsThing(person("my MacBook Pro m4"))).toBe("asset");
  });

  it("an empty evidence object and an all-zero one agree", () => {
    const zero = { trackers: 0, trackerEntries: 0, habits: 0, journalEntries: 0, medications: 0, healthDocuments: 0 };
    expect(isSafeToRetypeAsThing(person("my MacBook Pro m4"), zero)).toBe("asset");
    expect(isSafeToRetypeAsThing(person("my MacBook Pro m4"), {})).toBe("asset");
  });

  it("a person whose name is not asset-shaped is never touched", () => {
    for (const n of ["Bob Robertson", "Sarah Miller", "Dana", "Rex"]) {
      expect(isSafeToRetypeAsThing(person(n)), n).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The aggressive name matcher must NOT be enough on its own
// ─────────────────────────────────────────────────────────────────────────────
describe("an asset-shaped name alone never retypes a row", () => {
  it("'My Mom' with a birthday stays a person (the /^my /  rule is a false positive)", () => {
    expect(looksLikeAssetName("My Mom")).toBe(true); // the classifier does fire…
    expect(isSafeToRetypeAsThing(person("My Mom", { birthday: "1958-04-02" }))).toBeNull();
  });

  it("'Sarah 1990' with an email stays a person (the 4-digit rule is a false positive)", () => {
    expect(looksLikeAssetName("Sarah 1990")).toBe(true);
    expect(isSafeToRetypeAsThing(person("Sarah 1990", { email: "sarah@example.com" }))).toBeNull();
  });

  it("every human field spelling blocks the retype, aliases and nested groups included", () => {
    for (const fields of [
      { date_of_birth: "1958-04-02" },
      { dob: "1958-04-02" },
      { birthDate: "1958-04-02" },
      { "Date Of Birth": "1958-04-02" },
      { phone: "555-0100" },
      { mobilePhone: "555-0100" },
      { relationship: "Mother" },
      { age: 67 },
      { gender: "female" },
      { pronouns: "she/her" },
      { occupation: "Teacher" },
      { employer: "PS 118" },
      { bloodType: "O+" },
      { allergies: "penicillin" },
      { emergencyContact: "Dad" },
      { personal: { birthday: "1958-04-02" } },   // nested display group
      { contact: { email: "mom@example.com" } },
    ]) {
      expect(isSafeToRetypeAsThing(person("My Mom", fields)), JSON.stringify(fields)).toBeNull();
    }
  });

  it("a blank human field is not evidence — the AI seeds empty keys", () => {
    expect(personFieldEvidence({ email: "", phone: null, birthday: "   " })).toEqual([]);
    expect(isSafeToRetypeAsThing(person("my MacBook Pro m4", { email: "", phone: null }))).toBe("asset");
  });

  it("a thing's own fields are not human evidence", () => {
    expect(personFieldEvidence({ mileage: 41000, vin: "1C6", currentValue: 2400, garage: "yes" })).toEqual([]);
    expect(isSafeToRetypeAsThing(person("tires for my Dodge ram", { mileage: 41000 }))).toBe("vehicle");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Human-only records outrank the name entirely
// ─────────────────────────────────────────────────────────────────────────────
describe("a row that owns human-only records is left alone whatever it is called", () => {
  it("tracker entries block the retype", () => {
    expect(isSafeToRetypeAsThing(person("tires for my Dodge ram"), { trackerEntries: 12 })).toBeNull();
    expect(isSafeToRetypeAsThing(person("my MacBook Pro m4"), { trackerEntries: 1 })).toBeNull();
  });

  it("a linked tracker with no entries also blocks it (stricter on purpose)", () => {
    expect(isSafeToRetypeAsThing(person("my MacBook Pro m4"), { trackers: 1, trackerEntries: 0 })).toBeNull();
  });

  it("habits, journal entries, medications and health documents each block it", () => {
    for (const e of [{ habits: 1 }, { journalEntries: 3 }, { medications: 1 }, { healthDocuments: 2 }]) {
      expect(isSafeToRetypeAsThing(person("my MacBook Pro m4"), e), JSON.stringify(e)).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Types the repair must never touch, and re-runnability
// ─────────────────────────────────────────────────────────────────────────────
describe("only a plain `person` row is ever a candidate", () => {
  it("`self` and `pet` are always null, however asset-shaped the name", () => {
    for (const type of ["self", "pet"]) {
      for (const name of ["tires for my Dodge ram", "my MacBook Pro m4", "My Mom", "Rex"]) {
        expect(isSafeToRetypeAsThing({ type, name, fields: {} }), `${type}/${name}`).toBeNull();
      }
    }
  });

  it("is idempotent: a row already repaired to vehicle/asset returns null", () => {
    expect(isSafeToRetypeAsThing({ type: "vehicle", name: "tires for my Dodge ram", fields: {} })).toBeNull();
    expect(isSafeToRetypeAsThing({ type: "asset", name: "my MacBook Pro m4", fields: {} })).toBeNull();
    // and the answer for a fresh row is stable across calls
    const row = person("my MacBook Pro m4");
    expect(isSafeToRetypeAsThing(row)).toBe(isSafeToRetypeAsThing(row));
  });

  it("missing / unknown / liability types are not candidates", () => {
    expect(isSafeToRetypeAsThing(null)).toBeNull();
    expect(isSafeToRetypeAsThing({ name: "my MacBook Pro m4" })).toBeNull();
    expect(isSafeToRetypeAsThing({ type: "liability", name: "my MacBook Pro m4" })).toBeNull();
    expect(isSafeToRetypeAsThing(person(""))).toBeNull();
  });

  it("is pure — it reads nothing but its two arguments", () => {
    const row = person("my MacBook Pro m4", { note: "keep" });
    const evidence = { habits: 0 };
    const snapshot = JSON.stringify([row, evidence]);
    isSafeToRetypeAsThing(row, evidence);
    expect(JSON.stringify([row, evidence])).toBe(snapshot);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The repair script reuses the shared rule — it does not restate the heuristic
// ─────────────────────────────────────────────────────────────────────────────
describe("scripts/repair-mistyped-person-profiles.ts is the one supported path", () => {
  const src = read("scripts/repair-mistyped-person-profiles.ts");

  it("imports the shared rule instead of re-implementing it", () => {
    expect(src).toMatch(/import \{[\s\S]*?isSafeToRetypeAsThing[\s\S]*?\} from "\.\.\/shared\/entity-classify"/);
    expect(src).toMatch(/isSafeToRetypeAsThing\(p, evidence\)/);
    // no second copy of the name heuristic
    expect(src).not.toMatch(/VEHICLE_WORDS|THING_WORDS|\/\^\(\?:my\|our\|the/);
  });

  it("dry run is the default and --apply is explicit", () => {
    expect(src).toMatch(/const APPLY = args\.includes\("--apply"\)/);
    expect(src).toMatch(/dry run — the default/);
    // the only write in the file is guarded by the apply path
    expect(src.match(/method: "PATCH"/g) || []).toHaveLength(1);
    expect(src).toMatch(/if \(APPLY\) \{\s*await apply\(result\.retype\);/);
  });

  it("takes its credentials from the environment and prints no key", () => {
    expect(src).toMatch(/from "\.\/supabase-credentials"/);
    expect(src).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);          // no literal JWT
    expect(src).not.toMatch(/console\.log\([^)]*SUPABASE_SERVICE_KEY/);
  });

  it("documents why there is no SQL migration for this repair", () => {
    expect(src).toMatch(/WHY THERE IS NO \.sql MIGRATION/);
  });
});
