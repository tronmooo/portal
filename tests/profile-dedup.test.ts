import { describe, it, expect } from "vitest";
import { findBlockingDuplicateProfile, normalizePersonName } from "../shared/profile-dedup";

// Pins the dup-detection policy so it can't regress to the old too-aggressive
// behavior (fuzzy "Tv" ≈ "Samsung TV", or blocking duplicate assets at all).

const existing = [
  { id: "p1", name: "John Smith", type: "person" },
  { id: "self", name: "Test", type: "self" },
  { id: "a1", name: "Samsung TV", type: "asset" },
  { id: "a2", name: "Honda HR-V", type: "vehicle" },
  { id: "del", name: "Jane Doe", type: "person", deletedAt: "2026-01-01" },
];

describe("findBlockingDuplicateProfile", () => {
  it("ALLOWS duplicate assets (returns null)", () => {
    expect(findBlockingDuplicateProfile({ name: "Samsung TV", type: "asset" }, existing)).toBeNull();
    expect(findBlockingDuplicateProfile({ name: "Tv", type: "asset" }, existing)).toBeNull();
  });

  it("ALLOWS duplicates for every non-person type", () => {
    for (const type of ["vehicle", "property", "subscription", "loan", "investment", "account", "pet"]) {
      expect(findBlockingDuplicateProfile({ name: "Honda HR-V", type }, existing)).toBeNull();
    }
  });

  it("never fuzzy-matches (Tv is not a duplicate of Samsung TV)", () => {
    expect(findBlockingDuplicateProfile({ name: "Tv", type: "asset" }, existing)).toBeNull();
  });

  it("BLOCKS a person with an exact full-name match (case/space-insensitive)", () => {
    expect(findBlockingDuplicateProfile({ name: "John Smith", type: "person" }, existing)?.id).toBe("p1");
    expect(findBlockingDuplicateProfile({ name: "  john   smith ", type: "person" }, existing)?.id).toBe("p1");
    expect(findBlockingDuplicateProfile({ name: "JOHN SMITH", type: "person" }, existing)?.id).toBe("p1");
  });

  it("ALLOWS a person whose name differs at all (first OR last)", () => {
    expect(findBlockingDuplicateProfile({ name: "John Smithe", type: "person" }, existing)).toBeNull();
    expect(findBlockingDuplicateProfile({ name: "Jon Smith", type: "person" }, existing)).toBeNull();
    expect(findBlockingDuplicateProfile({ name: "John", type: "person" }, existing)).toBeNull();
  });

  it("ignores soft-deleted people", () => {
    expect(findBlockingDuplicateProfile({ name: "Jane Doe", type: "person" }, existing)).toBeNull();
  });

  it("treats self and person as the same people-namespace", () => {
    expect(findBlockingDuplicateProfile({ name: "Test", type: "person" }, existing)?.id).toBe("self");
  });

  it("does not block on empty/blank names", () => {
    expect(findBlockingDuplicateProfile({ name: "", type: "person" }, existing)).toBeNull();
    expect(findBlockingDuplicateProfile({ name: "   ", type: "person" }, existing)).toBeNull();
  });

  it("normalizePersonName collapses case and whitespace", () => {
    expect(normalizePersonName("  John   Smith ")).toBe("john smith");
  });
});
