// Rule 25 — internal metadata never appears in normal UI.
//
// shared/system-fields is the ONE definition of "this key is the app's own
// bookkeeping": the explicit inventory plus the `_` prefix convention. Every
// renderer that lists profile fields or tracker values reads through it, the
// legacy `isReservedFieldKey` delegates to it, and Developer Mode is the only
// way a system field is revealed — read-only.
import { describe, it, expect } from "vitest";
import { SYSTEM_FIELD_KEYS, isSystemFieldKey, visibleFields, systemFieldEntries } from "../shared/system-fields";
import { isReservedFieldKey, deleteProfileFields } from "../shared/profile-field-identity";

describe("isSystemFieldKey", () => {
  it("is true for every key in the inventory", () => {
    for (const k of SYSTEM_FIELD_KEYS) expect(isSystemFieldKey(k), k).toBe(true);
  });

  it("names the metadata the code actually writes", () => {
    for (const k of ["_enrichment", "_extractionActions", "_docFields", "_calendarOptOut", "_provenance",
      "_embedding", "_sourceHash", "_contentHash", "_cacheVersion", "_version", "_turnId", "_sourceMessageId"]) {
      expect(SYSTEM_FIELD_KEYS.has(k), k).toBe(true);
    }
  });

  it("is true for ANY underscore-prefixed key, registered or not", () => {
    expect(isSystemFieldKey("_somethingNew")).toBe(true);
    expect(isSystemFieldKey("_")).toBe(true);
  });

  it("is false for user data and for non-strings", () => {
    for (const k of ["name", "licenseNumber", "identity", "computed", "enrichment", "snake_case", "a_b"]) {
      expect(isSystemFieldKey(k), k).toBe(false);
    }
    expect(isSystemFieldKey(null)).toBe(false);
    expect(isSystemFieldKey(undefined)).toBe(false);
    expect(isSystemFieldKey(42)).toBe(false);
  });

  it("is what isReservedFieldKey means", () => {
    for (const k of ["_docFields", "_extractionActions", "_x", "name", "identity"]) {
      expect(isReservedFieldKey(k)).toBe(isSystemFieldKey(k));
    }
  });
});

describe("visibleFields", () => {
  const fields = {
    name: "Bob",
    licenseNumber: "S226",
    identity: { dateOfBirth: "1990-01-01" },
    _docFields: { licenseNumber: "doc-1" },
    _extractionActions: [{ key: "dedupe", at: "2026-09-04" }],
    _enrichment: { estimated: {} },
  };

  it("strips every system field by default", () => {
    const v = visibleFields(fields);
    expect(Object.keys(v).sort()).toEqual(["identity", "licenseNumber", "name"]);
  });

  it("keeps them only in developer mode", () => {
    const v = visibleFields(fields, { developerMode: true });
    expect(Object.keys(v).sort()).toEqual(Object.keys(fields).sort());
  });

  it("is pure and safe on nothing", () => {
    const before = JSON.stringify(fields);
    visibleFields(fields);
    expect(JSON.stringify(fields)).toBe(before);
    expect(visibleFields(null)).toEqual({});
    expect(visibleFields(undefined)).toEqual({});
  });

  it("lists exactly the system entries for the developer badge", () => {
    expect(systemFieldEntries(fields).map(([k]) => k).sort()).toEqual(["_docFields", "_enrichment", "_extractionActions"]);
    expect(systemFieldEntries(null)).toEqual([]);
  });
});

describe("the screen and the delete sweep agree", () => {
  it("a key a screen never lists is a key the sweep never removes", () => {
    const fields = { name: "Bob", _extractionActions: [{ key: "x" }], _docFields: { name: "d" } };
    const r = deleteProfileFields(fields, ["_extractionActions", "_docFields"]);
    expect((r as any).fields._extractionActions).toBeDefined();
    expect((r as any).fields._docFields).toBeDefined();
    expect(Object.keys(visibleFields(fields))).toEqual(["name"]);
  });
});
