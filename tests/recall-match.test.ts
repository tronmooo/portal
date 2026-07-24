import { describe, it, expect } from "vitest";
import { buildRecallTerms, recallMatchScore, normalizeForMatch } from "../shared/recall-match";

// Regression for the reported bug: a CA vehicle registration was extracted with
// the VIN under the label "Vehicle ID Number", but asking "What is the VIN of
// my Honda CRV?" (or even the focused recall query "vin") returned nothing
// because recall required the whole query to be a literal substring of the
// field key/value. These tests pin the alias-bridging behavior so it can't
// silently regress.

// The exact field set shown in the user's screenshot.
const REGISTRATION = {
  "License Number": "8YPJ480",
  "Sticker Issued": "D7060197",
  "Expiration Date": "10/22/2026",
  "Registered Owner": "Sennabaum Robert James",
  "Vehicle ID Number": "7FARW2H70ME032834",
};

// Helper: best score across a record's fields for a given query, using the same
// key-path shape recallMemory builds ("<source label>.<field>").
function bestField(query: string, sourceLabel: string, record: Record<string, string>) {
  const terms = buildRecallTerms(query);
  let best = { key: "", value: "", score: 0 };
  for (const [k, v] of Object.entries(record)) {
    const score = recallMatchScore(terms, `${sourceLabel}.${k}`, v);
    if (score > best.score) best = { key: k, value: v, score };
  }
  return best;
}

describe("recall-match — alias bridging (VIN regression)", () => {
  it("normalizeForMatch splits camelCase and punctuation", () => {
    expect(normalizeForMatch("vehicleIdNumber")).toBe("vehicle id number");
    expect(normalizeForMatch("Honda CR-V 2021")).toBe("honda cr v 2021");
  });

  it("'vin' alias-expands to 'vehicle id number'", () => {
    const terms = buildRecallTerms("vin");
    expect(terms.phrases).toContain("vehicle id number");
  });

  it("focused query 'vin' finds the 'Vehicle ID Number' field", () => {
    const hit = bestField("vin", "Honda Registration", REGISTRATION);
    expect(hit.key).toBe("Vehicle ID Number");
    expect(hit.value).toBe("7FARW2H70ME032834");
  });

  it("natural-language 'What is the VIN of my Honda CRV 2021?' finds the VIN", () => {
    const hit = bestField("What is the VIN of my Honda CRV 2021?", "CA Vehicle Registration Honda 2021", REGISTRATION);
    expect(hit.key).toBe("Vehicle ID Number");
    expect(hit.value).toBe("7FARW2H70ME032834");
  });

  it("the OLD whole-query substring approach would have missed it", () => {
    // Documents the exact failure mode we fixed.
    const q = "what is the vin of my honda crv 2021";
    const anyHit = Object.entries(REGISTRATION).some(
      ([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q),
    );
    expect(anyHit).toBe(false);
  });

  it("other common aliases bridge too", () => {
    expect(buildRecallTerms("plate").phrases).toContain("license number");
    expect(buildRecallTerms("dob").phrases).toContain("date of birth");
    expect(buildRecallTerms("phone").phrases).toContain("phone number");

    // "plate" should reach the registration's "License Number" field.
    const plate = bestField("what's my plate number", "Honda Registration", REGISTRATION);
    expect(plate.key).toBe("License Number");
  });

  it("matches the entity by name even with no field hit", () => {
    const terms = buildRecallTerms("honda crv");
    // Profile rendered as "<name> <type>" key, value = name.
    expect(recallMatchScore(terms, "Honda CRV 2021 vehicle", "Honda CRV 2021")).toBeGreaterThan(0);
  });

  it("pure-stopword queries match nothing", () => {
    expect(buildRecallTerms("what is the").isEmpty).toBe(true);
    expect(recallMatchScore(buildRecallTerms("what is the"), "anything", "value")).toBe(0);
  });

  it("short tokens require a whole-word hit (no 'vin' inside 'vinyl')", () => {
    const terms = buildRecallTerms("vin");
    // 'vin' must not match the substring inside an unrelated value.
    expect(recallMatchScore(terms, "Flooring.material", "vinyl plank")).toBe(0);
  });

  it("key-path matches outrank value-only matches", () => {
    const terms = buildRecallTerms("vin");
    const keyHit = recallMatchScore(terms, "Doc.Vehicle ID Number", "7FARW2H70ME032834");
    const valHit = recallMatchScore(terms, "Doc.notes", "the vehicle id number is on the door");
    expect(keyHit).toBeGreaterThan(valHit);
  });
});

// Regression for the 2026-07 driver's-license report: "What is my driver's
// license number?" was answered with the vehicle's PLATE (8YPJ480), because
// (a) the registration prints the plate as "License Number" — a cross-document
// lookalike label — and (b) "license number" used to FIRE the plate alias
// group, dragging plate terms into a driver's-license query. These tests pin
// the type-scoped ranking so the wrong document can't win again.
describe("recall-match — driver's license vs license plate disambiguation", () => {
  // recallMemory key paths are "<doc name> <doc type>.<field>".
  const REG_PLATE_KEY = "Honda Registration registration.License Number";
  const DL_NUMBER_KEY = "Florida Driver License drivers_license.License Number";

  it("normalizes alias members — the apostrophe form fires the DL group", () => {
    // Old code compared the raw member "driver's license" against a normalized
    // query, so it could never match. Both spellings must fire now.
    for (const q of ["what is my driver's license number", "drivers license number"]) {
      expect(buildRecallTerms(q).phrases).toContain("license number");
    }
  });

  it("'driver's license number' ranks the DL document's field above the registration's plate", () => {
    const terms = buildRecallTerms("What is my driver's license number?");
    const dl = recallMatchScore(terms, DL_NUMBER_KEY, "D123-456-78-901-0");
    const plate = recallMatchScore(terms, REG_PLATE_KEY, "8YPJ480");
    expect(dl).toBeGreaterThan(plate);
  });

  it("'license plate' ranks the registration's field above the DL document's", () => {
    const terms = buildRecallTerms("what's my license plate?");
    const plate = recallMatchScore(terms, REG_PLATE_KEY, "8YPJ480");
    const dl = recallMatchScore(terms, DL_NUMBER_KEY, "D123-456-78-901-0");
    expect(plate).toBeGreaterThan(dl);
  });

  it("a driver's-license query does NOT drag plate terms into the search", () => {
    const terms = buildRecallTerms("driver's license number");
    expect(terms.phrases).not.toContain("license plate");
    expect(terms.tokens).not.toContain("plate");
  });

  it("'plate' still searches the ambiguous 'license number' label (registration answer path)", () => {
    expect(buildRecallTerms("plate").phrases).toContain("license number");
    const hit = recallMatchScore(buildRecallTerms("plate number"), REG_PLATE_KEY, "8YPJ480");
    expect(hit).toBeGreaterThan(0);
  });

  it("naming BOTH types applies no penalty in either direction", () => {
    const terms = buildRecallTerms("is that my license plate or my driver's license number?");
    expect(terms.penalties).toEqual([]);
  });
});
