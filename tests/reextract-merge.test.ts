import { describe, it, expect } from "vitest";
import { mergeExtractedData } from "../server/ai-engine";

// Re-extraction must be ADDITIVE: it pulls fields a first pass missed (e.g. a
// driver-license number) and fills gaps, but never clobbers a value the user
// may have corrected by hand. These tests pin that merge contract.

describe("mergeExtractedData (re-extraction merge)", () => {
  it("adds newly-recovered fields the original pass missed", () => {
    const existing = { fullName: "ROBERT JAMES SENNABAUM", dateOfBirth: "03/12/1993" };
    const fresh = { fullName: "ROBERT JAMES SENNABAUM", licenseNumber: "S226-116-24-800", address: "2103 ALEXIS CT" };
    const { merged, addedKeys } = mergeExtractedData(existing, fresh);
    expect(merged.licenseNumber).toBe("S226-116-24-800");
    expect(merged.address).toBe("2103 ALEXIS CT");
    expect(addedKeys.sort()).toEqual(["address", "licenseNumber"]);
  });

  it("keeps existing non-empty values (never clobbers a user correction)", () => {
    const existing = { fullName: "Robert J. Sennabaum (corrected)" };
    const fresh = { fullName: "ROBERT JAMES SENNABAUM" };
    const { merged, addedKeys } = mergeExtractedData(existing, fresh);
    expect(merged.fullName).toBe("Robert J. Sennabaum (corrected)");
    expect(addedKeys).toEqual([]);
  });

  it("fills a previously-blank / placeholder value", () => {
    const existing = { licenseNumber: "", address: "N/A" };
    const fresh = { licenseNumber: "S226-116-24-800", address: "2103 ALEXIS CT" };
    const { merged, addedKeys } = mergeExtractedData(existing, fresh);
    expect(merged.licenseNumber).toBe("S226-116-24-800");
    expect(merged.address).toBe("2103 ALEXIS CT");
    expect(addedKeys.sort()).toEqual(["address", "licenseNumber"]);
  });

  it("skips empty fresh values", () => {
    const { merged, addedKeys } = mergeExtractedData({}, { a: "", b: null, c: undefined, d: "ok" });
    expect(merged).toEqual({ d: "ok" });
    expect(addedKeys).toEqual(["d"]);
  });

  it("handles null/empty existing", () => {
    const { merged, addedKeys } = mergeExtractedData(null, { vin: "7FARW2H70ME032834" });
    expect(merged.vin).toBe("7FARW2H70ME032834");
    expect(addedKeys).toEqual(["vin"]);
  });
});
