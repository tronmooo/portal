// Pins the missing-info → profile-field mapping behind the "Tighten this
// estimate" panel inside asset profiles (user request 2026-07-24: make the
// valuation's missing-detail list actionable inside the profile).
import { describe, it, expect } from "vitest";
import { resolveMissingFields } from "../client/src/components/asset/ImproveEstimatePanel";

describe("resolveMissingFields", () => {
  it("maps the home-valuation missing list to canonical field keys", () => {
    const specs = resolveMissingFields([
      "Interior square footage",
      "Bedroom/bath count",
      "Lot size and waterfront/access details",
      "Renovation or upgrade history",
      "Current condition and any recent sale/listing status",
    ], {});
    const keys = specs.map(s => s.key);
    expect(keys).toContain("sqft");
    expect(keys).toContain("bedrooms");
    expect(keys).toContain("lotSize");
    expect(keys).toContain("renovations");
    expect(keys).toContain("condition");
    expect(specs.find(s => s.key === "sqft")!.type).toBe("number");
  });

  it("maps vehicle missing items", () => {
    const keys = resolveMissingFields(["trim level", "condition", "service records", "mileage"], {}).map(s => s.key);
    expect(keys).toContain("trim");
    expect(keys).toContain("mileage");
  });

  it("skips items whose field is already filled and de-dupes keys", () => {
    const specs = resolveMissingFields(
      ["Interior square footage", "square footage", "bedroom count"],
      { sqft: 2400 },
    );
    expect(specs.map(s => s.key)).toEqual(["bedrooms"]);
  });

  it("falls back to a slug key for unrecognized items", () => {
    const specs = resolveMissingFields(["roof age"], {});
    expect(specs).toHaveLength(1);
    expect(specs[0].key).toBe("roofAge");
    expect(specs[0].type).toBe("text");
  });

  it("caps at six fields and ignores empties", () => {
    const specs = resolveMissingFields(["", "a", "b", "c", "d", "e", "f", "g"], {});
    expect(specs.length).toBeLessThanOrEqual(6);
  });
});
