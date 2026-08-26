// tests/trackable-values.test.ts
//
// "The AI determines whether a piece of extracted data is longitudinal/
//  trackable — completely dynamic, no hard-coded list of medical trackers or
//  document types." (user directive, 2026-08-26)
//
// The detector answers from the SHAPE of the value and the SENSE of the field
// name. These tests pin both halves: the numbers that deserve a chart, and the
// numbers that emphatically do not.

import { describe, it, expect } from "vitest";
import {
  detectTrackable, notTrackableReason, canonicalTrackerName, isConfidentlyTrackable,
} from "../shared/trackable-values";
import { unitDimension, unitsCompatible } from "../shared/tracker-units";
import { HIDDEN_TRACKER_CATEGORIES } from "../shared/hidden-tracker-categories";

const t = (key: string, label: string, value: unknown, extra: any = {}) =>
  detectTrackable({ key, label, value, ...extra });

describe("values that deserve a chart", () => {
  it("reads a known health metric with its canonical name and unit", () => {
    const w = t("weight", "Weight", "300 lb")!;
    expect(w.name).toBe("Weight");
    expect(w.values).toEqual({ value: 300 });
    expect(w.category).toBe("health");
    expect(isConfidentlyTrackable(w)).toBe(true);
  });

  it("keeps a compound reading as ONE candidate", () => {
    const bp = t("bloodPressure", "Blood Pressure", "138/86")!;
    expect(bp.values).toEqual({ systolic: 138, diastolic: 86 });
    expect(bp.unit).toBe("mmHg");
  });

  it("reads a height printed in two units as one value", () => {
    const h = t("height", "Height", "5 ft 7 in (170 cm)")!;
    expect(h.values.value).toBe(67);
    expect(h.unit).toBe("in");
  });

  // The whole point: none of these are in any medical registry.
  it("tracks an odometer reading", () => {
    const o = t("odometer", "Odometer", "43,120 mi")!;
    expect(o.name).toBe("Odometer");
    expect(o.values).toEqual({ value: 43120 });
    expect(o.category).toBe("custom");
  });

  it("tracks a property valuation and an annual premium", () => {
    const v = t("estimatedMarketValue", "Estimated Market Value", "$612,000")!;
    expect(v.values).toEqual({ value: 612000 });
    expect(v.name).toBe("Estimated Market Value");
    const p = t("annualPremium", "Annual Premium", "1428.00", { roles: ["financial"] })!;
    expect(p.values).toEqual({ value: 1428 });
  });

  it("tracks a loan balance", () => {
    const b = t("currentBalance", "Current Balance", "24820.11", {
      roles: ["financial", "measurement"], financialKind: "balance",
    })!;
    expect(b.values).toEqual({ value: 24820.11 });
    expect(isConfidentlyTrackable(b)).toBe(true);
  });

  it("never files a tracker under a category the app hides", () => {
    for (const c of ["annualPremium", "currentBalance", "estimatedMarketValue"]) {
      const cand = t(c, c, "100", { roles: ["financial"] })!;
      expect(HIDDEN_TRACKER_CATEGORIES.has(cand.category)).toBe(false);
    }
  });
});

describe("numbers that are not measurements", () => {
  const reason = (key: string, label: string, value: unknown, extra: any = {}) =>
    notTrackableReason({ key, label, value, ...extra });

  it("rejects identifiers by name and by shape", () => {
    expect(reason("policyNumber", "Policy Number", "SPI-24-87654321")).toBe("identifier");
    expect(reason("vin", "VIN", "2HKRW2H85MH512345")).toBe("identifier");
    expect(reason("receiptNumber", "Receipt #", "00483")).toBe("identifier");
    expect(reason("approvalCode", "Approval Code", "04562B")).toBe("identifier");
    expect(reason("naicCode", "NAIC Company Code", "12345")).toBe("identifier");
    expect(reason("phone", "Phone", "555-0134")).toBe("identifier");
    expect(reason("zipCode", "ZIP", "80501")).toBe("identifier");
    for (const k of ["policyNumber", "vin", "receiptNumber", "zipCode"]) {
      expect(t(k, k, "12345678")).toBeNull();
    }
  });

  it("rejects counts, years, dates and prose", () => {
    expect(reason("itemQuantity", "Item Quantity", "1")).toBe("count");
    expect(reason("yearBuilt", "Year Built", "2018")).toBe("year");
    expect(reason("expirationDate", "Expiration Date", "2025-06-01")).toBe("date");
    expect(reason("returnPolicyDays", "Return Policy Days", "90", { date: "2026-08-18" })).toBe("date");
    expect(t("propertyAddress", "Property Address", "123 Evergreen Lane, Springfield, CO 80501")).toBeNull();
  });

  it("rejects rows the reasoner said must cause nothing", () => {
    expect(reason("signatureDate", "Signature Date", "5", { roles: ["reference_only"] })).toBe("metadata");
    expect(reason("formCode", "Form Code", "7", { roles: ["document_metadata"] })).toBe("metadata");
  });

  it("but a QUANTITY word rescues a field an identifier word would have caught", () => {
    // "Account Balance" contains "account"; it is still a balance.
    expect(reason("accountBalance", "Account Balance", "4,120.55")).toBeNull();
    expect(reason("groupNumber", "Group Number", "774")).toBe("identifier");
  });

  it("rejects anything with no number in it at all", () => {
    expect(t("carrier", "Insurance Carrier", "Summit Peak Insurance Group")).toBeNull();
  });
});

describe("units carry a dimension, and dimensions veto", () => {
  it("groups units by what they measure", () => {
    expect(unitDimension("lbs")).toBe("mass");
    expect(unitDimension("kg")).toBe("mass");
    expect(unitDimension("in")).toBe("length");
    expect(unitDimension("mi")).toBe("distance");
    expect(unitDimension("mmHg")).toBe("pressure");
    expect(unitDimension("mg/dL")).toBe("concentration");
    expect(unitDimension("$")).toBe("money");
    expect(unitDimension("")).toBeNull();
    expect(unitDimension("widgets")).toBeNull();
  });

  it("same metric in two units is compatible; different kinds are not", () => {
    expect(unitsCompatible("lbs", "kg")).toBe(true);
    expect(unitsCompatible("in", "lbs")).toBe(false);
    expect(unitsCompatible("mi", "$")).toBe(false);
    expect(unitsCompatible("mmHg", "bpm")).toBe(false);
  });

  it("an unknown or absent unit never blocks an append", () => {
    expect(unitsCompatible("", "mmHg")).toBe(true);
    expect(unitsCompatible(null, "kg")).toBe(true);
    expect(unitsCompatible("widgets", "kg")).toBe(true);
  });
});

describe("naming", () => {
  it("strips the unit and the auto-number a label carries", () => {
    expect(canonicalTrackerName("Weight [lbs]")).toBe("Weight");
    expect(canonicalTrackerName("LDL Cholesterol (mg/dL)")).toBe("LDL Cholesterol");
    expect(canonicalTrackerName("Odometer (2)")).toBe("Odometer");
  });
});
