// Valuation context builder: which facts are material, and the fingerprint
// that decides whether a stored estimate is still valid.
import { describe, it, expect } from "vitest";
import { buildValuationContext, isEstimatorOwnedValue, isPriorValuationKey, stableHash } from "@shared/valuation/context";
import type { AssetDataBundle } from "@shared/valuation/types";

const NOW = new Date("2026-09-16T12:00:00Z");

function bundle(fields: Record<string, any>, extra: Partial<AssetDataBundle> = {}, profile: Partial<AssetDataBundle["profile"]> = {}): AssetDataBundle {
  return {
    profile: { id: "p1", name: "Honda CR-V", type: "vehicle", fields, notes: "", ...profile },
    ...extra,
  };
}

describe("material inputs are chosen by semantic role, not by asset type", () => {
  it("keeps identity / usage / condition / location facts and drops contact, coverage and admin keys", () => {
    const ctx = buildValuationContext(bundle({
      year: 2021, make: "Honda", model: "CR-V", mileage: 80000, condition: "good", location: "Los Angeles, CA",
      insurer: "Progressive", policyNumber: "907344659", ownerPhone: "555-1212", ownerEmail: "a@b.c",
      parentProfileId: "x", _internal: "hidden", registrationExpiration: "2026-10-22",
      purchasePrice: 28000, purchaseDate: "2021-11-02",
    }), NOW);
    expect(ctx.attributes).toMatchObject({ year: 2021, make: "Honda", model: "CR-V", mileage: 80000, condition: "good", location: "Los Angeles, CA" });
    for (const k of ["insurer", "policyNumber", "ownerPhone", "ownerEmail", "parentProfileId", "_internal", "registrationExpiration"]) {
      expect(ctx.attributes).not.toHaveProperty(k);
    }
    expect(ctx.purchase).toEqual({ price: 28000, date: "2021-11-02" });
    expect(ctx.usage.mileage).toBe(80000);
    expect(ctx.condition).toBe("good");
    expect(ctx.entityClass).toBe("asset");
  });

  it("never treats prior valuation outputs as inputs", () => {
    const ctx = buildValuationContext(bundle({
      make: "Honda", model: "CR-V", currentValue: 21400, previousValue: 21000, valuationRange: "$19k - $25k",
      valuationMethod: "Live search: KBB", valuationDate: "2026-07-01", valuationFactors: ["x"], currentValueSource: "estimate",
    }), NOW);
    expect(JSON.stringify(ctx.materialInputs)).not.toContain("21400");
    expect(JSON.stringify(ctx.materialInputs)).not.toContain("valuation");
    expect(ctx.userValue).toBeNull();
    expect(ctx.estimatorValue).toBe(21400);
    for (const k of ["currentValue", "CURRENTVALUE", "valuationFactors", "currentValueSource", "valuationSources"]) expect(isPriorValuationKey(k)).toBe(true);
    expect(isPriorValuationKey("purchasePrice")).toBe(false);
  });

  it("flattens nested storage groups (fields.vehicles.*, fields.housing.*)", () => {
    const ctx = buildValuationContext(bundle({ vehicles: { make: "Ford", model: "F-150", mileage: 40000 }, housing: { sqft: 1800 } }), NOW);
    expect(ctx.attributes).toMatchObject({ make: "Ford", model: "F-150", mileage: 40000, sqft: 1800 });
  });
});

describe("fingerprint: material changes invalidate, irrelevant ones do not", () => {
  const base = { year: 2021, make: "Honda", model: "CR-V", mileage: 80000, condition: "good", purchasePrice: 28000, purchaseDate: "2021-11-02", insurer: "Progressive" };
  const fp = (fields: Record<string, any>, extra: Partial<AssetDataBundle> = {}, profile: Partial<AssetDataBundle["profile"]> = {}) =>
    buildValuationContext(bundle(fields, extra, profile), NOW).inputFingerprint;

  it("is deterministic and independent of key order", () => {
    const a = fp(base);
    const b = fp(Object.fromEntries(Object.entries(base).reverse()));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when mileage, condition or purchase price change", () => {
    const a = fp(base);
    expect(fp({ ...base, mileage: 120000 })).not.toBe(a);
    expect(fp({ ...base, condition: "poor" })).not.toBe(a);
    expect(fp({ ...base, purchasePrice: 30000 })).not.toBe(a);
    expect(fp({ ...base, newField: "lifted suspension" })).not.toBe(a);
  });

  it("does NOT change for contact, coverage, admin, prior-valuation or bookkeeping edits", () => {
    const a = fp(base);
    expect(fp({ ...base, insurer: "Geico" })).toBe(a);
    expect(fp({ ...base, policyNumber: "123", ownerPhone: "555" })).toBe(a);
    expect(fp({ ...base, currentValue: 20100, valuationDate: "2026-09-16", currentValueSource: "estimate" })).toBe(a);
    expect(fp({ ...base, registrationExpiration: "2027-01-01" })).toBe(a);
    expect(fp({ ...base, _docFields: { foo: 1 } })).toBe(a);
    expect(fp(base, {}, { tags: ["family"], updatedAt: "2026-09-16T00:00:00Z" })).toBe(a);
  });

  it("numeric strings and numbers are the same fact", () => {
    expect(fp({ ...base, mileage: "80,000" })).toBe(fp(base));
  });

  it("notes only matter through condition/history signals", () => {
    const a = fp(base, {}, { notes: "Bought at the dealership on Main St." });
    expect(a).toBe(fp(base, {}, { notes: "" }));
    expect(fp(base, {}, { notes: "Garage kept, one owner, minor dent." })).not.toBe(a);
  });

  it("does not depend on a cached understanding (so both load paths agree)", () => {
    const a = fp(base);
    const withUnderstanding = fp(base, {
      understanding: {
        source: "ai", kind: "used SUV", valueDrivers: ["mileage"], volatility: "low", expectedAnnualChangePct: -0.1,
        usefulLifeYears: 15, searchable: true, searchQuery: "2021 Honda CR-V", tradableSymbol: null, methodologyHints: [],
        missingInfo: [], signature: "s", generatedAt: NOW.toISOString(),
      },
    });
    expect(withUnderstanding).toBe(a);
  });

  it("stableHash is stable across calls", () => {
    expect(stableHash("abc")).toBe(stableHash("abc"));
    expect(stableHash("abc")).not.toBe(stableHash("abd"));
  });
});

describe("user value vs estimator value", () => {
  it("a user-typed currentValue is a verified value; an estimator-written one is not", () => {
    const user = buildValuationContext(bundle({ make: "Honda", currentValue: 20000, currentValueSource: "user" }), NOW);
    expect(user.userValue).toEqual({ value: 20000, asOf: null, key: "currentValue" });
    const est = buildValuationContext(bundle({ make: "Honda", currentValue: 20000, currentValueSource: "estimate" }), NOW);
    expect(est.userValue).toBeNull();
    expect(est.estimatorValue).toBe(20000);
  });
  it("legacy: valuationMethod present with no provenance marker means the estimator wrote it", () => {
    expect(isEstimatorOwnedValue({ currentValue: 1, valuationMethod: "Live search" })).toBe(true);
    expect(isEstimatorOwnedValue({ currentValue: 1 })).toBe(false);
    expect(isEstimatorOwnedValue({ currentValue: 1, valuationMethod: "x", currentValueSource: "user" })).toBe(false);
  });
  it("an account balance is the user's value with its as-of date", () => {
    const ctx = buildValuationContext(bundle({ balance: 5200, balanceAsOf: "2026-09-01" }, {}, { type: "account", name: "Savings" }), NOW);
    expect(ctx.userValue).toEqual({ value: 5200, asOf: "2026-09-01", key: "balance" });
  });
  it("a kept userEnteredValue is the user's evidence even after the estimate took over currentValue", () => {
    const ctx = buildValuationContext(bundle({ make: "Honda", currentValue: 987, currentValueSource: "estimate", currentValueAsOf: "2026-09-16T00:00:00Z", userEnteredValue: 1200, userEnteredValueAsOf: "2026-08-01" }), NOW);
    expect(ctx.userValue).toEqual({ value: 1200, asOf: "2026-08-01", key: "userEnteredValue" });
    expect(ctx.estimatorValue).toBe(987);
  });
  it("the as-of date never falls back to the row's updatedAt (that would churn the fingerprint)", () => {
    const a = buildValuationContext(bundle({ make: "Honda", currentValue: 20000 }, {}, { updatedAt: "2026-09-01T00:00:00Z" }), NOW);
    const b = buildValuationContext(bundle({ make: "Honda", currentValue: 20000 }, {}, { updatedAt: "2026-09-16T00:00:00Z" }), NOW);
    expect(a.userValue?.asOf).toBeNull();
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
  });
  it("profileFingerprint ignores linked-record facts, inputFingerprint does not", () => {
    const base = buildValuationContext(bundle({ make: "Honda", model: "CR-V" }), NOW);
    const withExpense = buildValuationContext(bundle({ make: "Honda", model: "CR-V" }, { expenses: [{ description: "New tires installed", amount: 800, date: "2026-03-01" }] }), NOW);
    expect(withExpense.profileFingerprint).toBe(base.profileFingerprint);
    expect(withExpense.inputFingerprint).not.toBe(base.inputFingerprint);
    expect(buildValuationContext(bundle({ make: "Honda", model: "CR-V", mileage: 1 }), NOW).profileFingerprint).not.toBe(base.profileFingerprint);
  });
});

describe("evidence pulled from related records", () => {
  it("finds appraisals inside linked documents' extracted data", () => {
    const ctx = buildValuationContext(bundle({ address: "12 Elm St", city: "Austin", state: "TX" }, {
      documents: [{ id: "d1", name: "Appraisal report", type: "appraisal", createdAt: "2026-03-01", extractedData: { appraisedValue: "$412,000", appraisalDate: "2026-02-20", lender: "Bank" } }],
    }, { type: "property", name: "Elm St house" }), NOW);
    expect(ctx.appraisals).toEqual([{ value: 412000, date: "2026-02-20", source: "document:d1", label: "Appraisal report · appraisedValue" }]);
    expect(ctx.identifiers.address).toBe("12 Elm St, Austin, TX");
  });

  it("splits linked expenses into upgrades and repairs", () => {
    const ctx = buildValuationContext(bundle({ make: "Honda" }, {
      expenses: [
        { description: "New tires installed", amount: 820, date: "2026-03-14" },
        { description: "Oil change and brake service", amount: 240, date: "2026-05-02" },
        { description: "Car wash", amount: 25, date: "2026-06-20" },
      ],
    }), NOW);
    expect(ctx.improvements).toEqual({ upgradesTotal: 820, repairsTotal: 240, count: 2, lastServiceDate: "2026-05-02" });
  });

  it("reads tradable identifiers and units", () => {
    const ctx = buildValuationContext(bundle({ ticker: "aapl", shares: 12 }, {}, { type: "investment", name: "Apple" }), NOW);
    expect(ctx.identifiers.symbol).toBe("AAPL");
    expect(ctx.quantity).toBe(12);
  });

  it("flags sparse assets", () => {
    const ctx = buildValuationContext(bundle({}, {}, { type: "asset", name: "Grandma's quilt" }), NOW);
    expect(ctx.sparse).toBe(true);
    expect(ctx.dataQuality).toBeLessThan(0.25);
  });
});
