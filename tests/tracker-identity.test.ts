import { describe, it, expect } from "vitest";
import { trackerIdentityKey, trackerNamesMatch, trackerNameContains, findIdentityMatches } from "@shared/tracker-identity";

// Root-cause guard for the duplicate-tracker bug: the same subject arriving with
// different wording ("Multivitamin" vs "Supplement Multivitamin") must collapse
// to one identity so it reuses the existing tracker instead of duplicating.
describe("trackerIdentityKey", () => {
  it("collapses supplement wording variations to one key", () => {
    const k = trackerIdentityKey("Multivitamin");
    expect(trackerIdentityKey("Supplement Multivitamin")).toBe(k);
    expect(trackerIdentityKey("Daily Multivitamin")).toBe(k);
    expect(trackerIdentityKey("My Multivitamin Supplement")).toBe(k);
    expect(trackerIdentityKey("Multivitamin (2)")).toBe(k);
  });

  it("collapses Fish Oil wording variations", () => {
    const k = trackerIdentityKey("Fish Oil");
    expect(k).toBe("fishoil");
    expect(trackerIdentityKey("Fish Oil Supplement")).toBe(k);
    expect(trackerIdentityKey("Daily Fish Oil softgel")).toBe(k);
  });

  it("keeps distinct subjects distinct", () => {
    expect(trackerIdentityKey("Vitamin D")).not.toBe(trackerIdentityKey("Vitamin C"));
    expect(trackerIdentityKey("Multivitamin")).not.toBe(trackerIdentityKey("Fish Oil"));
    expect(trackerIdentityKey("Amoxicillin")).not.toBe(trackerIdentityKey("Lisinopril"));
  });

  it("falls back to a stable key when the name is all noise words", () => {
    expect(trackerIdentityKey("Supplements")).toBeTruthy();
    expect(trackerIdentityKey("My Meds")).toBeTruthy();
  });
});

describe("trackerNamesMatch", () => {
  it("matches supplement wording variations", () => {
    expect(trackerNamesMatch("Multivitamin", "Supplement Multivitamin")).toBe(true);
    expect(trackerNamesMatch("Multivitamin", "Daily Multivitamin")).toBe(true);
    expect(trackerNamesMatch("Fish Oil", "Fish Oil Supplement")).toBe(true);
  });

  it("matches compound names by containment", () => {
    expect(trackerNamesMatch("Bench Press", "Morning Bench Press")).toBe(true);
  });

  it("does NOT match unrelated trackers", () => {
    expect(trackerNamesMatch("Leg Press", "Bench Press")).toBe(false);
    expect(trackerNamesMatch("Multivitamin", "Fish Oil")).toBe(false);
    expect(trackerNamesMatch("Running", "Cycling")).toBe(false);
    expect(trackerNamesMatch("Vitamin D", "Vitamin C")).toBe(false);
  });

  it("short fragments cannot swallow other names", () => {
    // "oil" must not match "Fish Oil" as a standalone tracker fragment.
    expect(trackerNamesMatch("Oil", "Fish Oil")).toBe(false);
    expect(trackerNamesMatch("Run", "Marathon Run")).toBe(false);
  });

  // Root-cause guard for the 2026-08-02 report: workout sets ("Weighted
  // Pull-Ups") were logged INTO the body-weight tracker because key-level
  // substring containment matched the partial word "weight" inside
  // "weightedpullups". Containment must be whole-token only.
  it("does NOT match across partial-word boundaries", () => {
    expect(trackerNamesMatch("Weight", "Weighted Pull-Ups")).toBe(false);
    expect(trackerNamesMatch("Weight", "Weighted Pull-ups Workout")).toBe(false);
    expect(trackerNamesMatch("Water", "Watermelon")).toBe(false);
    expect(trackerNamesMatch("Press", "Pressure")).toBe(false);
  });

  it("still matches whole-token compounds and aliases", () => {
    expect(trackerNamesMatch("Weight", "Body Weight")).toBe(true);
    expect(trackerNamesMatch("Bench Press", "Morning Bench Press")).toBe(true);
    expect(trackerNamesMatch("Pull-Ups", "Weighted Pull-Ups")).toBe(true);
  });

  it("folds trivial plurals into one identity", () => {
    expect(trackerNamesMatch("Pull-Up", "Pull-Ups")).toBe(true);
    expect(trackerNamesMatch("Push-Up", "Push-Ups")).toBe(true);
  });

  it("returns false on empty input", () => {
    expect(trackerNamesMatch("", "Multivitamin")).toBe(false);
    expect(trackerNamesMatch(null, undefined)).toBe(false);
  });
});

describe("trackerNameContains", () => {
  it("matches whole-word runs only, never raw substrings", () => {
    expect(trackerNameContains("Weighted Pull-Ups", "pull-ups")).toBe(true);
    expect(trackerNameContains("Body Weight", "weight")).toBe(true);
    expect(trackerNameContains("Weighted Pull-Ups", "weight")).toBe(false);
    expect(trackerNameContains("Watermelon", "water")).toBe(false);
  });

  it("is plural-insensitive", () => {
    expect(trackerNameContains("Weighted Pull-Ups", "pull up")).toBe(true);
  });
});

describe("findIdentityMatches", () => {
  const trackers = [
    { id: "mv", name: "Multivitamin", linkedProfiles: ["self"] },
    { id: "fo", name: "Fish Oil", linkedProfiles: ["self"] },
    { id: "run", name: "Running", linkedProfiles: ["self"] },
  ];

  it("finds the existing Multivitamin tracker for a worded variant", () => {
    const m = findIdentityMatches(trackers, "Supplement Multivitamin");
    expect(m.map((t) => t.id)).toEqual(["mv"]);
  });

  it("returns nothing for a genuinely new subject", () => {
    expect(findIdentityMatches(trackers, "Creatine")).toEqual([]);
  });
});
