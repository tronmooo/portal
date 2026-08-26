// tests/profile-field-write-identity.test.ts
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
  mergeFieldWrite,
  fieldValuePersisted,
  fieldIdentity,
  removeDocumentContributedFields,
} from "../shared/profile-field-identity";
import { readFileSync } from "fs";
import { join } from "path";

const repo = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

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
    const { fields, written } = mergeFieldWrite({ name: "Jane Doe" }, LICENSE_PAYLOAD);
    // Storage keeps nulls out on the way back; model that.
    const stored = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));

    const unsaved = Object.keys(written).filter(
      (k) => !fieldValuePersisted(stored, k, written[k]),
    );
    expect(unsaved).toEqual([]);
  });

  it("keeps the address and the state, and stores each exactly once", () => {
    const { fields } = mergeFieldWrite({ name: "Jane Doe" }, LICENSE_PAYLOAD);
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

describe("mergeFieldWrite", () => {
  it("still supersedes a stale twin already on the profile", () => {
    const { fields } = mergeFieldWrite(
      { currentMileage: 69063 },
      { mileage: 80000 },
    );
    expect(fields.mileage).toBe(80000);
    expect(fields.currentMileage).toBeNull();
  });

  it("keeps a displaced odometer reading for _mileageHistory", () => {
    const { replacedMileage } = mergeFieldWrite({ currentMileage: 69063 }, { mileage: 80000 });
    expect(replacedMileage).toEqual([{ from: "currentMileage", value: 69063 }]);
  });

  it("sweeps a twin hiding inside a nested group", () => {
    const { fields } = mergeFieldWrite(
      { vehicles: { currentMileage: 69063, make: "Toyota" } },
      { mileage: 80000 },
    );
    expect(fields.vehicles).toEqual({ make: "Toyota" });
    expect(fields.mileage).toBe(80000);
  });

  it("does not mutate the profile it was given", () => {
    const existing = { currentMileage: 69063, vehicles: { mileage: 1 } };
    mergeFieldWrite(existing, { mileage: 80000 });
    expect(existing).toEqual({ currentMileage: 69063, vehicles: { mileage: 1 } });
  });
});

describe("fieldValuePersisted", () => {
  it("finds the value under a sibling spelling", () => {
    expect(fieldValuePersisted({ address: "742 Pixel Loop" }, "streetAddress", "742 Pixel Loop")).toBe(true);
  });

  it("finds the value inside a nested group", () => {
    expect(fieldValuePersisted({ personal: { address: "742 Pixel Loop" } }, "address", "742 Pixel Loop")).toBe(true);
  });

  it("compares loosely, so $26,000 and 26000 agree", () => {
    expect(fieldValuePersisted({ currentValue: 26000 }, "value", "$26,000")).toBe(true);
  });

  it("still reports a value that really did not land", () => {
    expect(fieldValuePersisted({ address: null }, "address", "742 Pixel Loop")).toBe(false);
    expect(fieldValuePersisted({}, "licenseNumber", "TEST-DL-4829-XJ1")).toBe(false);
  });

  it("does not accept a different value under the same identity", () => {
    expect(fieldValuePersisted({ address: "9 Other St" }, "streetAddress", "742 Pixel Loop")).toBe(false);
  });
});

// ─── The same mistake wearing other hats ─────────────────────────────────────
//
// "Compare field keys as strings" is the bug, not "the confirm route". These
// pin the other doors it came through.

describe("an inline edit supersedes the spelling already stored", () => {
  it("editing the promoted key replaces the nested original", () => {
    // The Info tab promotes `personal.address` and shows it as "Address". The
    // edit posts `address` — which used to land as a SECOND field while the
    // nested original kept the old value.
    const { fields } = mergeFieldWrite(
      { personal: { address: "1 Old Road", eyeColor: "BRN" } },
      { address: "742 Pixel Loop" },
    );
    expect(fields.address).toBe("742 Pixel Loop");
    expect(fields.personal).toEqual({ eyeColor: "BRN" });
  });

  it("an AI update under a different spelling replaces, not duplicates", () => {
    // update_profile(fields: { streetAddress }) onto a profile holding `address`.
    const { fields } = mergeFieldWrite({ address: "1 Old Road" }, { streetAddress: "9 New St" });
    const live = Object.entries(fields).filter(([k, v]) => !k.startsWith("_") && v !== null);
    expect(live).toHaveLength(1);
    expect(live[0][1]).toBe("9 New St");
  });

  it("leaves unrelated fields alone", () => {
    const { fields } = mergeFieldWrite(
      { name: "Jane Doe", licenseNumber: "TEST-DL-4829-XJ1" },
      { city: "Readwood Harbor" },
    );
    expect(fields.name).toBe("Jane Doe");
    expect(fields.licenseNumber).toBe("TEST-DL-4829-XJ1");
    expect(fields.city).toBe("Readwood Harbor");
  });
});

describe("deleting a document takes its data back", () => {
  const recorded = { streetAddress: "742 Pixel Loop", "issuing State": "EX" };

  it("finds the value under the spelling it ended up stored as", () => {
    const { fields, removed } = removeDocumentContributedFields(
      { name: "Jane Doe", address: "742 Pixel Loop", State: "EX" },
      recorded,
    );
    expect(removed.sort()).toEqual(["State", "address"]);
    expect(fields).toEqual({ name: "Jane Doe" });
  });

  it("reaches a value that settled inside a nested group", () => {
    const { fields, removed } = removeDocumentContributedFields(
      { personal: { address: "742 Pixel Loop", eyeColor: "BRN" } },
      recorded,
    );
    expect(removed).toEqual(["personal.address"]);
    expect(fields.personal).toEqual({ eyeColor: "BRN" });
  });

  it("keeps a value the user edited after the import", () => {
    const { fields, removed } = removeDocumentContributedFields(
      { address: "9 New St — moved" },
      recorded,
    );
    expect(removed).toEqual([]);
    expect(fields.address).toBe("9 New St — moved");
  });

  it("does not mutate the profile it was given", () => {
    const before = { address: "742 Pixel Loop", personal: { address: "742 Pixel Loop" } };
    removeDocumentContributedFields(before, recorded);
    expect(before).toEqual({ address: "742 Pixel Loop", personal: { address: "742 Pixel Loop" } });
  });
});

describe("the write path stays funnelled through one place", () => {
  it("storage.updateProfile merges profile fields via mergeFieldWrite", () => {
    // If a future edit re-introduces an exact-key merge here, every writer
    // silently loses the supersede again — which is how this bug survived
    // being fixed in the confirm route alone.
    const src = repo("server/supabase-storage.ts");
    expect(src).toContain("mergeFieldWrite(existing.fields");
  });

  it("the confirm route verifies on identity, not on the literal key", () => {
    const src = repo("server/routes.ts");
    expect(src).toContain("fieldValuePersisted(afterFields");
    expect(src).not.toContain("!looselyEqual(afterFields[k], incoming[k])");
  });

  it("the document-delete cascade matches on identity", () => {
    // The cascade moved out of the route and into the one deletion service
    // every entry point calls (the DELETE route, the AI's manage_document, an
    // undo) — but it still has to remove a contributed field by IDENTITY, not
    // by the literal key it was saved under.
    const src = repo("server/document-deletion.ts");
    expect(src).toContain("removeDocumentContributedFields(p.fields");
  });

  it("every document delete goes through that one service", () => {
    // Three screens deleting a document three slightly different ways is how
    // the Documents page and an asset profile came to disagree about whether a
    // document still existed.
    const routes = repo("server/routes.ts");
    expect(routes).toContain("deleteDocumentEverywhere(storage as any, docIdToDelete");
    expect(routes).not.toContain("await storage.deleteDocument(");
    expect(repo("server/ai-engine.ts")).not.toContain("await storage.deleteDocument(");
  });
});

describe("mergeFieldWrite reports what it superseded", () => {
  it("names the twin it nulled, so storage can drop exactly that key", () => {
    const { superseded, fields } = mergeFieldWrite({ currentMileage: 69063 }, { mileage: 80000 });
    expect(superseded).toEqual(["currentMileage"]);
    expect(fields.currentMileage).toBeNull();
  });

  it("supersedes nothing when the write touches a fresh field", () => {
    const { superseded } = mergeFieldWrite({ name: "Jane Doe" }, { city: "Readwood Harbor" });
    expect(superseded).toEqual([]);
  });

  it("does not claim a null the profile already held", () => {
    // storage.updateProfile drops exactly the keys named here — a null some
    // other caller stored deliberately must not be swept up with them.
    const { superseded } = mergeFieldWrite({ lateFee: null }, { city: "Readwood Harbor" });
    expect(superseded).toEqual([]);
  });
});
