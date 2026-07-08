import { describe, it, expect } from "vitest";
import { computeAge, infoFieldsForType, readField, PERSON_INFO_FIELDS, PET_INFO_FIELDS } from "../client/src/lib/profile-fields";

describe("computeAge", () => {
  it("returns years for adults", () => {
    // 30 years + 10 days ago so leap-year fractional math can't round to 29.
    const y = new Date(); y.setFullYear(y.getFullYear() - 30); y.setDate(y.getDate() - 10);
    expect(computeAge(y.toISOString().slice(0, 10))).toBe("30 yr");
  });
  it("returns months for infants under 2", () => {
    const d = new Date(); d.setMonth(d.getMonth() - 6);
    expect(computeAge(d.toISOString().slice(0, 10))).toMatch(/\d+ mo/);
  });
  it("rejects garbage / implausible / future dates", () => {
    expect(computeAge("")).toBeNull();
    expect(computeAge(undefined)).toBeNull();
    expect(computeAge("not-a-date")).toBeNull();
    expect(computeAge("1800-01-01")).toBeNull(); // >130yr
    const future = new Date(); future.setFullYear(future.getFullYear() + 5);
    expect(computeAge(future.toISOString().slice(0, 10))).toBeNull();
  });
});

describe("infoFieldsForType", () => {
  it("returns pet fields for pets, person fields otherwise", () => {
    expect(infoFieldsForType("pet")).toBe(PET_INFO_FIELDS);
    expect(infoFieldsForType("person")).toBe(PERSON_INFO_FIELDS);
    expect(infoFieldsForType("self")).toBe(PERSON_INFO_FIELDS);
    expect(infoFieldsForType(undefined)).toBe(PERSON_INFO_FIELDS);
  });
});

describe("readField", () => {
  it("reads exact and case-insensitive keys", () => {
    expect(readField({ email: "a@b.com" }, "email")).toBe("a@b.com");
    expect(readField({ Email: "a@b.com" }, "email")).toBe("a@b.com");
  });
  it("resolves birthday aliases (dateOfBirth / dob)", () => {
    expect(readField({ dateOfBirth: "1990-01-01" }, "birthday")).toBe("1990-01-01");
    expect(readField({ dob: "1990-01-01" }, "birthday")).toBe("1990-01-01");
  });
  it("returns undefined for missing", () => {
    expect(readField({}, "phone")).toBeUndefined();
    expect(readField(undefined, "phone")).toBeUndefined();
  });
});
