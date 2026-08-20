// tests/confirm-extraction-merge.test.ts
//
// Pins the confirm-extraction merge against the 2026-08-20 report:
// confirming a driver license returned
//   "Saved with warnings — Some pieces didn't save:
//    fields did not persist to Jane Doe: address, issuing State"
// even though the write succeeded. The payload named one field twice
// (address/streetAddress, State/issuing State); writing the second spelling
// nulled the first, and the exact-key verification then called a good save a
// failure.

import { describe, it, expect } from "vitest";
import {
  foldIncomingTwins,
  mergeConfirmedFields,
  confirmedFieldPersisted,
  fieldIdentity,
} from "../shared/profile-field-identity";

/** The ticked fields from the reported driver-license review card. */
const LICENSE_PAYLOAD = {
  address: "742 Pixel Loop, Unit 9",
  city: "Readwood Harbor",
  dateOfBirth: "1992-04-11",
  birthday: "1992-04-11",
  expirationDate: "2030-03-21",
  issueDate: "2024-03-21",
  "issuing State": "EX",
  lastName: "Doe",
  licenseClass: "C",
  licenseNumber: "TEST-DL-4829-XJ1",
  State: "EX",
  streetAddress: "742 Pixel Loop, Unit 9",
  zipCode: "90012",
};

describe("the reported failure", () => {
  it("the payload really does name one field under two spellings", () => {
    expect(fieldIdentity("address")).toBe(fieldIdentity("streetAddress"));
    expect(fieldIdentity("State")).toBe(fieldIdentity("issuing State"));
    expect(fieldIdentity("dateOfBirth")).toBe(fieldIdentity("birthday"));
  });

  it("confirming a license reports no unsaved fields", () => {
    const { fields, written } = mergeConfirmedFields({ name: "Jane Doe" }, LICENSE_PAYLOAD);
    // Storage keeps nulls out on the way back; model that.
    const stored = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));

    const unsaved = Object.keys(written).filter(
      (k) => !confirmedFieldPersisted(stored, k, written[k]),
    );
    expect(unsaved).toEqual([]);
  });

  it("keeps the address and the state, and stores each exactly once", () => {
    const { fields } = mergeConfirmedFields({ name: "Jane Doe" }, LICENSE_PAYLOAD);
    const live = Object.entries(fields).filter(([k, v]) => !k.startsWith("_") && v !== null);

    const addresses = live.filter(([k]) => fieldIdentity(k) === "address");
    expect(addresses).toHaveLength(1);
    expect(addresses[0][1]).toBe("742 Pixel Loop, Unit 9");

    const states = live.filter(([k]) => fieldIdentity(k) === "licenseState");
    expect(states).toHaveLength(1);
    expect(states[0][1]).toBe("EX");

    const birthdays = live.filter(([k]) => fieldIdentity(k) === "birthday");
    expect(birthdays).toHaveLength(1);
  });
});

describe("foldIncomingTwins", () => {
  it("folds an agreeing twin into the spelling the profile already uses", () => {
    const { fields, collapsed } = foldIncomingTwins(
      { streetAddress: "742 Pixel Loop", address: "742 Pixel Loop" },
      { address: "1 Old Road" },
    );
    expect(Object.keys(fields)).toEqual(["address"]);
    expect(fields.address).toBe("742 Pixel Loop");
    expect(collapsed).toEqual([{ from: "streetAddress", into: "address" }]);
  });

  it("prefers a non-empty value over an empty twin", () => {
    const { fields } = foldIncomingTwins({ address: "", streetAddress: "742 Pixel Loop" });
    expect(Object.values(fields)).toEqual(["742 Pixel Loop"]);
  });

  it("never drops a genuinely different value", () => {
    const { fields } = foldIncomingTwins({ address: "742 Pixel Loop", homeAddress: "9 Other St" });
    expect(fields).toEqual({ address: "742 Pixel Loop", homeAddress: "9 Other St" });
  });

  it("leaves reserved metadata alone", () => {
    const { fields } = foldIncomingTwins({ _docFields: { a: 1 }, address: "x" });
    expect(fields._docFields).toEqual({ a: 1 });
  });
});

describe("mergeConfirmedFields", () => {
  it("still supersedes a stale twin already on the profile", () => {
    const { fields } = mergeConfirmedFields(
      { currentMileage: 69063 },
      { mileage: 80000 },
    );
    expect(fields.mileage).toBe(80000);
    expect(fields.currentMileage).toBeNull();
  });

  it("keeps a displaced odometer reading for _mileageHistory", () => {
    const { replacedMileage } = mergeConfirmedFields({ currentMileage: 69063 }, { mileage: 80000 });
    expect(replacedMileage).toEqual([{ from: "currentMileage", value: 69063 }]);
  });

  it("sweeps a twin hiding inside a nested group", () => {
    const { fields } = mergeConfirmedFields(
      { vehicles: { currentMileage: 69063, make: "Toyota" } },
      { mileage: 80000 },
    );
    expect(fields.vehicles).toEqual({ make: "Toyota" });
    expect(fields.mileage).toBe(80000);
  });

  it("does not mutate the profile it was given", () => {
    const existing = { currentMileage: 69063, vehicles: { mileage: 1 } };
    mergeConfirmedFields(existing, { mileage: 80000 });
    expect(existing).toEqual({ currentMileage: 69063, vehicles: { mileage: 1 } });
  });
});

describe("confirmedFieldPersisted", () => {
  it("finds the value under a sibling spelling", () => {
    expect(confirmedFieldPersisted({ address: "742 Pixel Loop" }, "streetAddress", "742 Pixel Loop")).toBe(true);
  });

  it("finds the value inside a nested group", () => {
    expect(confirmedFieldPersisted({ personal: { address: "742 Pixel Loop" } }, "address", "742 Pixel Loop")).toBe(true);
  });

  it("compares loosely, so $26,000 and 26000 agree", () => {
    expect(confirmedFieldPersisted({ currentValue: 26000 }, "value", "$26,000")).toBe(true);
  });

  it("still reports a value that really did not land", () => {
    expect(confirmedFieldPersisted({ address: null }, "address", "742 Pixel Loop")).toBe(false);
    expect(confirmedFieldPersisted({}, "licenseNumber", "TEST-DL-4829-XJ1")).toBe(false);
  });

  it("does not accept a different value under the same identity", () => {
    expect(confirmedFieldPersisted({ address: "9 Other St" }, "streetAddress", "742 Pixel Loop")).toBe(false);
  });
});
