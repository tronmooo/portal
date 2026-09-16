// The canonical metric registry — the fix for "the data is broken, so the
// insights can't be trusted". Two contracts:
//   * one id per measurement, whatever the tracker is called (the duplicates);
//   * a physically possible range per metric (the impossible values).
import { describe, it, expect } from "vitest";
import {
  resolveCanonicalMetric, validateCanonicalValue, flagAgainstReference,
  formatReference, CANONICAL_METRICS,
} from "../shared/wellness-canon";
import { sanitizeTrackerEntryValues } from "../server/tracker-entry-guard";
import { isHealthDocument } from "../shared/health-documents";
import { trackerNamesMatch } from "../shared/tracker-identity";

describe("canonical metric ids collapse duplicate trackers", () => {
  it("resolves every spelling of HDL to one id", () => {
    for (const name of ["HDL", "HDL Cholesterol", "Lipid Panel — HDL", "hdl (mg/dL)"]) {
      expect(resolveCanonicalMetric(name)?.id, name).toBe("hdl");
    }
  });

  it("keeps the lipid family apart", () => {
    expect(resolveCanonicalMetric("LDL Cholesterol")?.id).toBe("ldl");
    expect(resolveCanonicalMetric("Total Cholesterol")?.id).toBe("total_cholesterol");
    expect(resolveCanonicalMetric("Triglycerides")?.id).toBe("triglycerides");
    // "cholesterol ratio" is not cholesterol.
    expect(resolveCanonicalMetric("Cholesterol Ratio")?.id).toBe("cholesterol_ratio");
  });

  it("resolves the same metric from a tracker name or a field name", () => {
    expect(resolveCanonicalMetric("BMI")?.id).toBe("bmi");
    expect(resolveCanonicalMetric("Body Mass Index")?.id).toBe("bmi");
    expect(resolveCanonicalMetric("Vitals", "health", "systolic")?.id).toBe("bp_systolic");
  });

  it("returns null for things that are not health metrics", () => {
    for (const name of ["Guitar practice", "Video games", "Bathroom visits", "Shower", "Reading", "Studying"]) {
      expect(resolveCanonicalMetric(name), name).toBeNull();
    }
  });

  it("does not mistake a lifted weight for a body weight", () => {
    expect(resolveCanonicalMetric("Bench Press", "fitness", "weight")).toBeNull();
    expect(resolveCanonicalMetric("Weight")?.id).toBe("weight");
  });

  it("has a unique id per entry", () => {
    const ids = CANONICAL_METRICS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("impossible values are rejected", () => {
  const check = (name: string, v: number, unit?: string) => {
    const m = resolveCanonicalMetric(name)!;
    expect(m, name).toBeTruthy();
    return validateCanonicalValue(m, v, unit);
  };

  it("rejects the exact values the tab was showing", () => {
    expect(check("HbA1c", 179).ok).toBe(false);   // a percentage of 179
    expect(check("HDL", 170).ok).toBe(false);     // not physiologically possible
    expect(check("BMI", 470).ok).toBe(false);
    expect(check("Weight", 3000).ok).toBe(false);
  });

  it("accepts the real ones", () => {
    expect(check("HbA1c", 5.4).ok).toBe(true);
    expect(check("HDL", 58).ok).toBe(true);
    expect(check("BMI", 26.4).ok).toBe(true);
    expect(check("Weight", 184.6).ok).toBe(true);
  });

  it("converts alternate units before bounding", () => {
    // 84 kg is a normal person; the same number as pounds would be too.
    expect(check("Weight", 84, "kg").canonical).toBeCloseTo(185.2, 0);
    expect(check("Weight", 84, "kg").ok).toBe(true);
    // 500 kg is not.
    expect(check("Weight", 500, "kg").ok).toBe(false);
    expect(check("Body Temperature", 37, "C").canonical).toBeCloseTo(98.6, 1);
  });

  it("names the metric and the range in the error", () => {
    const r = check("HbA1c", 179);
    expect(r.error).toMatch(/HbA1c/);
    expect(r.error).toMatch(/2–20 %/);
  });
});

describe("reference ranges", () => {
  it("flags out-of-range lab values", () => {
    const ldl = resolveCanonicalMetric("LDL")!;
    expect(flagAgainstReference(ldl, 138)).toBe("high");
    expect(flagAgainstReference(ldl, 88)).toBe("normal");
    const hdl = resolveCanonicalMetric("HDL")!;
    expect(flagAgainstReference(hdl, 31)).toBe("low");
  });

  it("formats a range people can read", () => {
    expect(formatReference(resolveCanonicalMetric("LDL")!)).toBe("< 100 mg/dL");
    expect(formatReference(resolveCanonicalMetric("HDL")!)).toBe("> 40 mg/dL");
    expect(formatReference(resolveCanonicalMetric("Glucose")!)).toBe("70–99 mg/dL");
  });
});

describe("the write guard enforces the same table", () => {
  const labFields = [{ name: "value", type: "number" }];

  it("refuses an HbA1c of 179 logged into a bare `value` field", () => {
    const r = sanitizeTrackerEntryValues(labFields, { value: 179 }, { name: "HbA1c", category: "labs" });
    expect(r.error).toMatch(/HbA1c/);
  });

  it("still stores a real one", () => {
    const r = sanitizeTrackerEntryValues(labFields, { value: 5.4 }, { name: "HbA1c", category: "labs" });
    expect(r.error).toBeUndefined();
  });

  it("leaves non-health trackers alone", () => {
    const r = sanitizeTrackerEntryValues([{ name: "hours", type: "number" }], { hours: 3 }, { name: "Video games", category: "gaming" });
    expect(r.error).toBeUndefined();
  });

  it("does not bound a fridge by a fever", () => {
    const r = sanitizeTrackerEntryValues([{ name: "temperature", type: "number" }], { temperature: -5 }, { name: "Freezer temperature", category: "home" });
    expect(r.error).toBeUndefined();
  });
});

describe("health documents are filtered by TYPE", () => {
  it("keeps medical records and lab reports", () => {
    expect(isHealthDocument({ type: "medical_report", name: "Annual physical" })).toBe(true);
    expect(isHealthDocument({ type: "lab_result", name: "Quest — Lipid panel" })).toBe(true);
    expect(isHealthDocument({ type: "prescription", name: "Lisinopril" })).toBe(true);
  });

  it("stops filing homeowners insurance under health records", () => {
    expect(isHealthDocument({ type: "insurance", name: "Homeowners Insurance Policy" })).toBe(false);
    expect(isHealthDocument({ type: "insurance", name: "Auto insurance — Civic" })).toBe(false);
  });

  it("still keeps an actual health plan", () => {
    expect(isHealthDocument({ type: "insurance", name: "Blue Cross health insurance card" })).toBe(true);
    expect(isHealthDocument({ type: "insurance", name: "Dental plan 2026" })).toBe(true);
  });

  it("honours an explicit health tag and ignores deleted documents", () => {
    expect(isHealthDocument({ type: "other", name: "Scan", tags: ["medical"] })).toBe(true);
    expect(isHealthDocument({ type: "medical_report", name: "Old", deletedAt: "2026-01-01" })).toBe(false);
  });
});

describe("free-form extraction types still classify", () => {
  it("accepts the snake_case types extraction actually produces", () => {
    for (const type of ["lab_results", "medical_records", "vaccination_record", "health_insurance", "prescription_label"]) {
      expect(isHealthDocument({ type, name: "Scan" }), type).toBe(true);
    }
  });

  it("rejects the ones that only look adjacent", () => {
    for (const type of ["insurance_policy", "vehicle_registration", "receipt", "life_insurance"]) {
      expect(isHealthDocument({ type, name: "Policy 1042" }), type).toBe(false);
    }
  });
});

describe("duplicate lab trackers are never created in the first place", () => {
  it("treats every spelling of one lab value as the same tracker", () => {
    expect(trackerNamesMatch("HDL", "HDL Cholesterol")).toBe(true);
    expect(trackerNamesMatch("HDL Cholesterol", "Lipid Panel — HDL")).toBe(true);
    expect(trackerNamesMatch("Triglycerides", "Trig")).toBe(true);
  });

  it("still keeps different lab values apart", () => {
    expect(trackerNamesMatch("HDL", "LDL")).toBe(false);
    expect(trackerNamesMatch("Glucose", "HbA1c")).toBe(false);
  });

  it("does not collapse two workouts that share a unit", () => {
    expect(trackerNamesMatch("Running distance", "Cycling distance")).toBe(false);
    expect(trackerNamesMatch("Bench Press", "Leg Press")).toBe(false);
  });
});
