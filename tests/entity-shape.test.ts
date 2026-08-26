// tests/entity-shape.test.ts — a house is not a patient.
//
// Screenshot, 2026-08-26: a homeowners insurance policy, filed under a house,
// offered every extracted field the same six choices —
//
//     Profile data · Allergies · Medications · Medical history · Notes · Ignore
//
// — with the agent's phone number, eight coverage lines and the annual premium
// all sitting on "Profile data". The destination vocabulary grew out of a
// clinic report, and every document since had been handed a patient's chart.
//
// These tests pin the two halves of the fix: what a field can MEAN depends on
// what the entity IS, and the same concept spelled three ways is one field.

import { describe, it, expect } from "vitest";
import {
  entityFamily,
  destinationsForFamily,
  destinationAllowed,
  matchConcept,
  canonicalFieldName,
  identifyingConcepts,
  identifiersAgree,
  SECTIONS_BY_FAMILY,
} from "../shared/entity-shape";
import { PROFILE_FIELD_GROUPS } from "../shared/profile-field-identity";
import {
  suggestDestination, destinationOptionsFor, buildExtractionItems,
} from "../shared/extraction-destinations";

describe("what kind of thing is this", () => {
  it("reads the registry's finer type key before the coarse one", () => {
    // A profile typed `asset` with type_key "boat" is a vehicle; `type` alone
    // would call it generic and offer it a house's sections.
    expect(entityFamily("asset", "boat")).toBe("vehicle");
    expect(entityFamily("liability", "mortgage")).toBe("liability");
    expect(entityFamily("property")).toBe("property");
    expect(entityFamily("self")).toBe("person");
    expect(entityFamily("pet")).toBe("pet");
  });

  it("falls back to generic rather than guessing", () => {
    expect(entityFamily("asset")).toBe("generic");
    expect(entityFamily(undefined, undefined)).toBe("generic");
    expect(entityFamily("storage_unit" as any)).toBe("generic");
  });
});

describe("a house is never offered a patient's chart", () => {
  it("withholds every medical destination from a property", () => {
    for (const d of ["allergy", "medication", "medical_history"] as const) {
      expect(destinationAllowed("property", d), d).toBe(false);
      expect(destinationAllowed("vehicle", d), d).toBe(false);
      expect(destinationAllowed("liability", d), d).toBe(false);
    }
  });

  it("still offers them to a person and a pet", () => {
    for (const d of ["allergy", "medication", "medical_history"] as const) {
      expect(destinationAllowed("person", d), d).toBe(true);
      expect(destinationAllowed("pet", d), d).toBe(true);
    }
  });

  it("offers every family a note, a reference row and ignore", () => {
    for (const f of ["person", "property", "vehicle", "liability", "generic"] as const) {
      for (const d of ["note", "reference", "ignore"] as const) {
        expect(destinationAllowed(f, d), `${f}/${d}`).toBe(true);
      }
    }
  });

  it("the dropdown for a property field contains no medical option", () => {
    // The screenshot, asserted.
    const opts = destinationOptionsFor("entity_record", false, false, "property");
    expect(opts).not.toContain("allergy");
    expect(opts).not.toContain("medication");
    expect(opts).not.toContain("medical_history");
    expect(opts).toContain("entity_record");
    expect(opts).toContain("note");
  });

  it("keeps the old permissive list when no family is known", () => {
    // Nothing that called this before entity-awareness existed changed.
    const opts = destinationOptionsFor("profile", false, false);
    expect(opts).toContain("allergy");
    expect(opts).toContain("profile");
  });

  it("never drops the suggested option, even if the family would not list it", () => {
    const opts = destinationOptionsFor("profile", false, false, "property");
    expect(opts).toContain("profile");
  });
});

describe("sections belong to the entity", () => {
  it("gives a property housing, insurance and a loan — not a health section", () => {
    expect(SECTIONS_BY_FAMILY.property).toContain("insurance");
    expect(SECTIONS_BY_FAMILY.property).toContain("loan");
    expect(SECTIONS_BY_FAMILY.property).not.toContain("health");
  });

  it("gives a person a health section and no vehicle section", () => {
    expect(SECTIONS_BY_FAMILY.person).toContain("health");
    expect(SECTIONS_BY_FAMILY.person).not.toContain("vehicle");
  });

  it("only names groups the profile UI actually renders", () => {
    // A group outside PROFILE_FIELD_GROUPS is data that shows up nowhere.
    const known = new Set<string>(PROFILE_FIELD_GROUPS as readonly string[]);
    for (const [family, groups] of Object.entries(SECTIONS_BY_FAMILY)) {
      for (const g of groups) {
        expect(known.has(g), `${family} names a group "${g}" the profile UI does not promote`).toBe(true);
      }
    }
  });
});

describe("the schema-soup guard", () => {
  it("folds three spellings of one fact into one field", () => {
    for (const spelling of ["Square Feet", "Living Area", "Building Size", "sqft", "Gross Living Area"]) {
      expect(canonicalFieldName("property", spelling), spelling).toBe("squareFeet");
    }
  });

  it("folds every way a balance is printed on a debt", () => {
    for (const spelling of ["Principal Balance", "Outstanding Balance", "Unpaid Balance", "balance"]) {
      expect(canonicalFieldName("liability", spelling), spelling).toBe("currentBalance");
    }
  });

  it("leaves a concept it has never heard of completely alone", () => {
    // The guard is a synonym map, not an allowlist. An unknown field routes
    // and saves under its own name rather than being forced into the nearest
    // existing one.
    expect(canonicalFieldName("property", "moorageDepth")).toBe("moorageDepth");
    expect(matchConcept("property", "moorageDepth")).toBeNull();
  });

  it("does not fold a concept across entities that mean different things by it", () => {
    // "Year" on a vehicle is the model year; on a property "yearBuilt" is a
    // different fact and must not be reached by the vehicle alias.
    expect(canonicalFieldName("vehicle", "Model Year")).toBe("year");
    expect(canonicalFieldName("property", "Model Year")).toBe("Model Year");
  });

  it("recognises insurance concepts against whatever they cover", () => {
    // An agent's phone belongs to the policy on the house, not to the house.
    const m = matchConcept("property", "agent Phone", { insurance: true });
    expect(m?.canonical).toBe("agentPhone");
    expect(m?.group).toBe("insurance");
  });
});

describe("identity", () => {
  it("knows what distinguishes each kind of thing", () => {
    expect(identifyingConcepts("property")).toContain("address");
    expect(identifyingConcepts("vehicle")).toContain("vin");
    expect(identifyingConcepts("liability")).toContain("loanNumber");
  });

  it("does not call a longer form of the same address a conflict", () => {
    expect(identifiersAgree("123 Evergreen Ln", "123 Evergreen Lane, Springfield, CO 80501")).toBe(true);
    expect(identifiersAgree("1HGCM82633A004352", "1hgcm82633a004352")).toBe(true);
  });

  it("does call a different address a conflict", () => {
    expect(identifiersAgree("123 Evergreen Ln", "14 Oak Street")).toBe(false);
  });

  it("treats a missing value as nothing to disagree about", () => {
    expect(identifiersAgree("", "123 Evergreen Ln")).toBe(true);
    expect(identifiersAgree(null, undefined)).toBe(true);
  });
});

describe("routing a policy filed under a house", () => {
  const declarationFields = [
    { key: "policyNumber", label: "Policy Number", value: "SPI-24-87654321", selected: true, isDate: false },
    { key: "agentPhone", label: "agent Phone", value: "(303) 555-2899", selected: true, isDate: false },
    { key: "annualPremium", label: "annual Premium", value: "1428.00", selected: true, isDate: false },
    { key: "livingArea", label: "Living Area", value: "2450", selected: true, isDate: false },
    { key: "additionalCoverages5", label: "additional Coverages 5", value: "Equipment Breakdown", selected: true, isDate: false },
  ];

  const items = buildExtractionItems({
    extractedFields: declarationFields,
    docContext: "insurance_policy Homeowners Declarations",
    family: "property",
  });

  it("sends nothing to a person's profile", () => {
    for (const i of items) {
      expect(i.destination, `${i.label} → ${i.destination}`).not.toBe("profile");
    }
  });

  it("puts the policy's own details in the property's insurance section", () => {
    const policy = items.find((i) => i.key === "policyNumber")!;
    expect(policy.destination).toBe("entity_record");
    expect(policy.group).toBe("insurance");

    const agent = items.find((i) => i.label === "agent Phone")!;
    expect(agent.key).toBe("agentPhone");
    expect(agent.group).toBe("insurance");
  });

  it("canonicalises the house's own attributes as it routes them", () => {
    const area = items.find((i) => i.label === "Living Area")!;
    expect(area.key).toBe("squareFeet");
    expect(area.group).toBe("housing");
  });

  it("offers no medical destination on any row", () => {
    for (const i of items) {
      expect(i.destinationOptions, i.label).not.toContain("allergy");
      expect(i.destinationOptions, i.label).not.toContain("medication");
      expect(i.destinationOptions, i.label).not.toContain("medical_history");
    }
  });

  it("does not mistake a coverage line for a health metric", () => {
    const coverage = items.find((i) => i.label === "additional Coverages 5")!;
    expect(coverage.trackerName).toBeUndefined();
    expect(coverage.destination).toBe("entity_field");
  });
});

describe("a clinic report still behaves exactly as it did", () => {
  const items = buildExtractionItems({
    extractedFields: [
      { key: "bloodType", label: "Blood Type", value: "O+", selected: true, isDate: false },
      { key: "weight", label: "Weight", value: "180 lb", selected: true, isDate: false },
    ],
    docContext: "lab_results Annual Physical",
    family: "person",
  });

  it("routes a person's attributes to their profile", () => {
    expect(items.find((i) => i.key === "bloodType")!.destination).toBe("profile");
  });

  it("still recognises a measurement as one", () => {
    const w = items.find((i) => i.key === "weight")!;
    expect(w.destination).toBe("profile_tracker");
    expect(w.trackerName).toBe("Weight");
  });

  it("still offers the medical destinations", () => {
    const bt = items.find((i) => i.key === "bloodType")!;
    expect(bt.destinationOptions).toContain("allergy");
  });
});

describe("suggestDestination without a family is unchanged", () => {
  it("keeps the pre-entity-aware behaviour", () => {
    expect(suggestDestination({ key: "bloodType", value: "O+" })).toBe("profile");
    expect(suggestDestination({ key: "filename", value: "x.pdf" })).toBe("ignore");
  });
});
