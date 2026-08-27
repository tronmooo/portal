// Regression tests for shared/extraction-destinations — the destination model
// and the ONE measurement parser.
//
// Locks the fix for the 2026-08-25 report: a clinic report printing
// "Height: 5 ft 7 in (170 cm)" produced a Height tracker whose only entry read
// "5 in". The review UI's own parser fell through to parseFloat (→ 5) and then
// GUESSED the unit from the field name (→ "in"). It also locks the destination
// routing that report exposed: a full lab panel was flattened into loose profile
// strings because the trackable-field allowlist was 25 hard-coded keys.

import { describe, it, expect } from "vitest";
import {
  parseMeasurement,
  matchHealthMetric,
  suggestDestination,
  destinationOptionsFor,
  buildExtractionItems,
  mergeStructuredRecords,
  allergyKey,
  medicationKey,
  surgeryKey,
  formatMeasurement,
  isProseValue,
  type ProfileAllergy,
  type ProfileMedication,
} from "@shared/extraction-destinations";
import { normalizeDateString } from "@shared/extraction-normalize";

describe("parseMeasurement — the exact strings the clinic report prints", () => {
  it("reads a dual-unit height as inches, NOT as the leading digit", () => {
    const h = parseMeasurement("5 ft 7 in (170 cm)", matchHealthMetric("height"));
    // The bug: value 5, unit "in". 5 feet 7 inches is 67 inches.
    expect(h).toEqual({ values: { value: 67 }, unit: "in" });
  });

  it("reads every other way a height is printed", () => {
    const m = matchHealthMetric("height")!;
    expect(parseMeasurement("5'7\"", m)!.values.value).toBe(67);
    expect(parseMeasurement("5 ft 7", m)!.values.value).toBe(67);
    expect(parseMeasurement("67 in", m)!.values.value).toBe(67);
    expect(parseMeasurement("170 cm", m)!.values.value).toBeCloseTo(66.9, 1);
  });

  it("keeps the printed imperial weight and does not switch to the parenthetical kg", () => {
    expect(parseMeasurement("300 lb (136.1 kg)", matchHealthMetric("weight")))
      .toEqual({ values: { value: 300 }, unit: "lbs" });
  });

  it("splits blood pressure into its two components", () => {
    expect(parseMeasurement("138/86 mmHg", matchHealthMetric("bloodPressure")))
      .toEqual({ values: { systolic: 138, diastolic: 86 }, unit: "mmHg" });
  });

  it("keeps the printed Fahrenheit temperature", () => {
    expect(parseMeasurement("98.4 °F (36.9 °C)", matchHealthMetric("temperature")))
      .toEqual({ values: { value: 98.4 }, unit: "°F" });
  });

  it("reads every lab unit off the page instead of guessing one", () => {
    expect(parseMeasurement("104 mg/dL", matchHealthMetric("glucose"))).toEqual({ values: { value: 104 }, unit: "mg/dL" });
    expect(parseMeasurement("0.81 mg/dL", matchHealthMetric("creatinine"))).toEqual({ values: { value: 0.81 }, unit: "mg/dL" });
    expect(parseMeasurement("140 mmol/L", matchHealthMetric("sodium"))).toEqual({ values: { value: 140 }, unit: "mmol/L" });
    expect(parseMeasurement("4.2 mmol/L", matchHealthMetric("potassium"))).toEqual({ values: { value: 4.2 }, unit: "mmol/L" });
    expect(parseMeasurement("5.8%", matchHealthMetric("a1c"))).toEqual({ values: { value: 5.8 }, unit: "%" });
    expect(parseMeasurement("2.1 mIU/L", matchHealthMetric("tsh"))).toEqual({ values: { value: 2.1 }, unit: "mIU/L" });
    expect(parseMeasurement("27 ng/mL", matchHealthMetric("vitaminD"))).toEqual({ values: { value: 27 }, unit: "ng/mL" });
    expect(parseMeasurement("17 breaths/min", matchHealthMetric("respiratoryRate"))).toEqual({ values: { value: 17 }, unit: "breaths/min" });
    expect(parseMeasurement("97%", matchHealthMetric("oxygenSaturation"))).toEqual({ values: { value: 97 }, unit: "%" });
    expect(parseMeasurement("82 bpm", matchHealthMetric("heartRate"))).toEqual({ values: { value: 82 }, unit: "bpm" });
    expect(parseMeasurement("47.0 kg/m²", matchHealthMetric("bmi"))).toEqual({ values: { value: 47 }, unit: "kg/m²" });
  });

  it("falls back to the metric's canonical unit when the page prints a bare number", () => {
    expect(parseMeasurement("104", matchHealthMetric("glucose"))).toEqual({ values: { value: 104 }, unit: "mg/dL" });
  });

  it("returns null rather than a number with an invented unit", () => {
    expect(parseMeasurement("Normal", matchHealthMetric("glucose"))).toBeNull();
    expect(parseMeasurement("", null)).toBeNull();
    expect(parseMeasurement(null, null)).toBeNull();
  });
});

describe("matchHealthMetric — the whole lab panel is trackable, not 25 keys", () => {
  it("resolves every row of the report to a canonical tracker", () => {
    const expected: Record<string, string> = {
      height: "Height", weight: "Weight", bmi: "BMI",
      bloodPressure: "Blood Pressure", heartRate: "Heart Rate",
      respiratoryRate: "Respiratory Rate", temperature: "Temperature",
      oxygenSaturation: "Oxygen Saturation", glucoseFasting: "Blood Glucose",
      creatinine: "Creatinine", sodium: "Sodium", potassium: "Potassium",
      totalCholesterol: "Total Cholesterol", ldlCholesterol: "LDL Cholesterol",
      hdlCholesterol: "HDL Cholesterol", triglycerides: "Triglycerides",
      hemoglobinA1c: "Hemoglobin A1C", tsh: "TSH", vitaminD: "Vitamin D",
    };
    for (const [key, trackerName] of Object.entries(expected)) {
      expect(matchHealthMetric(key)?.trackerName, key).toBe(trackerName);
    }
  });

  it("does not let generic cholesterol steal LDL or HDL", () => {
    expect(matchHealthMetric("ldl")!.trackerName).toBe("LDL Cholesterol");
    expect(matchHealthMetric("hdl")!.trackerName).toBe("HDL Cholesterol");
    expect(matchHealthMetric("cholesterol")!.trackerName).toBe("Total Cholesterol");
  });

  it("folds every spelling of A1C onto one tracker", () => {
    for (const k of ["a1c", "hba1c", "hemoglobinA1c", "Hemoglobin A1C"]) {
      expect(matchHealthMetric(k)!.trackerName).toBe("Hemoglobin A1C");
    }
  });

  it("is not fooled by a profile attribute that shares a word", () => {
    // "Blood Type: O+" is profile data, not a Blood Pressure reading.
    expect(suggestDestination({ key: "bloodType", value: "O+" })).toBe("profile");
  });
});

describe("suggestDestination", () => {
  it("routes body characteristics to the profile AND a tracker", () => {
    expect(suggestDestination({ key: "height", value: "5 ft 7 in (170 cm)" })).toBe("profile_tracker");
    expect(suggestDestination({ key: "weight", value: "300 lb (136.1 kg)" })).toBe("profile_tracker");
    expect(suggestDestination({ key: "bmi", value: "47.0" })).toBe("profile_tracker");
  });

  it("routes vitals and labs to a tracker only", () => {
    expect(suggestDestination({ key: "bloodPressure", value: "138/86 mmHg" })).toBe("tracker");
    expect(suggestDestination({ key: "creatinine", value: "0.81 mg/dL" })).toBe("tracker");
    expect(suggestDestination({ key: "tsh", value: "2.1 mIU/L" })).toBe("tracker");
  });

  it("routes identity and stable attributes to the profile", () => {
    expect(suggestDestination({ key: "dateOfBirth", value: "1988-03-14" })).toBe("profile");
    expect(suggestDestination({ key: "gender", value: "Female" })).toBe("profile");
    expect(suggestDestination({ key: "bloodType", value: "O+" })).toBe("profile");
  });

  it("routes narrative prose to a note, not a profile field", () => {
    expect(suggestDestination({ key: "physicalExamination", value: "Alert, oriented, no acute distress." })).toBe("note");
    expect(suggestDestination({
      key: "abdomen",
      value: "Soft and non-tender throughout with no guarding, no rebound, and no palpable masses on examination today.",
    })).toBe("note");
  });

  it("routes a follow-up commitment to a task", () => {
    expect(suggestDestination({ key: "nextAppointment", value: "2027-08-25", isDate: true })).toBe("task");
    expect(suggestDestination({ key: "repeatLabs", value: "2027-02-25", isDate: true })).toBe("task");
  });

  it("ignores file metadata", () => {
    expect(suggestDestination({ key: "fileName", value: "scan.png" })).toBe("ignore");
    expect(suggestDestination({ key: "electronicallySignedBy", value: "Robert James, MD" })).toBe("ignore");
  });

  it("always offers Notes and Ignore as escape hatches", () => {
    const opts = destinationOptionsFor("profile", false, false);
    expect(opts).toContain("note");
    expect(opts).toContain("ignore");
    expect(opts).toContain("profile");
  });
});

describe("buildExtractionItems", () => {
  const field = (key: string, value: any, extra: Record<string, any> = {}) =>
    ({ key, label: key, value, selected: true, isDate: false, ...extra });

  it("one fact is one row, whatever the document spells it", () => {
    // USER REPORT (2026-08-27): the review listed "Birthday 1975-04-12" beside
    // "date Of Birth 1975-04-12" — one date, two rows. matchConcept already
    // folds dob/birthday/birthdate onto the canonical `dateOfBirth`, but two
    // items still carried that same key and that same value.
    const items = buildExtractionItems({
      family: "person",
      extractedFields: [
        { key: "dateOfBirth", label: "date Of Birth", value: "1975-04-12", selected: true, isDate: true },
        { key: "birthday", label: "Birthday", value: "1975-04-12", selected: true, isDate: true },
      ],
      normalizeDate: normalizeDateString,
    });
    const births = items.filter((i) => i.key === "dateOfBirth");
    expect(births).toHaveLength(1);
    // The better-written of the two labels survives the merge.
    expect(births[0].label).toBe("Birthday");
    expect(births[0].date).toBe("1975-04-12");
  });

  it("keeps two rows when the values differ, however alike the keys are", () => {
    const items = buildExtractionItems({
      family: "person",
      extractedFields: [
        { key: "dateOfBirth", label: "date Of Birth", value: "1975-04-12", selected: true, isDate: true },
        { key: "birthday", label: "Birthday", value: "1980-01-01", selected: true, isDate: true },
      ],
      normalizeDate: normalizeDateString,
    });
    expect(items.filter((i) => i.key === "dateOfBirth")).toHaveLength(2);
  });

  it("proposes a destination for every row and never duplicates a tracker", () => {
    const items = buildExtractionItems({
      extractedFields: [
        field("height", "5 ft 7 in (170 cm)"),
        field("weight", "300 lb (136.1 kg)"),
        field("bloodPressure", "138/86 mmHg"),
        field("bloodType", "O+"),
        field("fileName", "report.png"),
      ],
      // The model usually emits the SAME measurements a second time as tracker
      // entries. Two rows for one reading means two entries on one tracker.
      trackerEntries: [
        { trackerName: "Weight", values: { value: 300 }, unit: "lbs", category: "health" },
        { trackerName: "Heart Rate", values: { value: 82 }, unit: "bpm", category: "health" },
      ],
      normalizeDate: normalizeDateString,
    });

    const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
    expect(byLabel.height.destination).toBe("profile_tracker");
    expect(byLabel.height.values).toEqual({ value: 67 });
    expect(byLabel.height.unit).toBe("in");
    expect(byLabel.bloodType.destination).toBe("profile");
    expect(byLabel.fileName.destination).toBe("ignore");
    expect(byLabel.fileName.selected).toBe(false);

    // Weight arrived twice; exactly one row carries it.
    expect(items.filter((i) => i.trackerName === "Weight")).toHaveLength(1);
    // Heart Rate arrived only as a tracker entry and is still present.
    expect(byLabel["Heart Rate"].destination).toBe("tracker");
    expect(byLabel["Heart Rate"].values).toEqual({ value: 82 });
  });

  it("turns the structured medical sections into their own destinations", () => {
    const items = buildExtractionItems({
      extractedFields: [],
      allergies: [{ substance: "Penicillin", reaction: "Rash", type: "medication" }],
      medications: [{ name: "Cetirizine", dose: "10 mg", frequency: "once daily as needed", kind: "medication" }],
      conditions: [{ name: "GERD", status: "active" }],
      surgicalHistory: [{ procedure: "Appendectomy", year: 2012 }],
      clinicalNotes: [{ title: "Physical Examination Summary", body: "Alert, oriented, no acute distress." }],
      followUps: [{ label: "Return for annual visit", date: "2027-08-25", kind: "appointment" }],
      normalizeDate: normalizeDateString,
    });

    const dest = Object.fromEntries(items.map((i) => [i.label, i.destination]));
    expect(dest.Penicillin).toBe("allergy");
    expect(dest.Cetirizine).toBe("medication");
    expect(dest.GERD).toBe("medical_history");
    expect(dest.Appendectomy).toBe("medical_history");
    expect(dest["Physical Examination Summary"]).toBe("note");
    expect(dest["Return for annual visit"]).toBe("calendar");

    // "once daily as needed" is a PRN prescription, not a daily schedule.
    const med = items.find((i) => i.label === "Cetirizine")!;
    expect(med.payload!.asNeeded).toBe(true);
    // A prescription list never claims a dose was taken.
    expect(med.values).toBeUndefined();
  });

  it("gives every row a unique id even when two rows share a name", () => {
    const items = buildExtractionItems({
      extractedFields: [field("note", "a"), field("note", "b")],
    });
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
});

describe("mergeStructuredRecords — a re-uploaded report adds nothing", () => {
  it("dedupes on a normalized key", () => {
    const first = mergeStructuredRecords<ProfileAllergy>(
      undefined,
      [{ substance: "Penicillin", reaction: "Rash" }, { substance: "Pollen" }],
      allergyKey,
      (t) => ({ substance: t }),
    );
    expect(first).toHaveLength(2);

    const second = mergeStructuredRecords<ProfileAllergy>(
      first,
      [{ substance: "penicillin", reaction: "Rash" }, { substance: "Dust" }],
      allergyKey,
      (t) => ({ substance: t }),
    );
    expect(second.map((a) => a.substance)).toEqual(["Penicillin", "Pollen", "Dust"]);
  });

  it("converts a legacy free-text string instead of dropping it", () => {
    const merged = mergeStructuredRecords<ProfileAllergy>(
      "Shellfish, Latex",
      [{ substance: "Penicillin", reaction: "Rash" }],
      allergyKey,
      (t) => ({ substance: t }),
    );
    expect(merged.map((a) => a.substance)).toEqual(["Shellfish", "Latex", "Penicillin"]);
  });

  it("never overwrites a value the user edited, but fills a blank one", () => {
    const merged = mergeStructuredRecords<ProfileMedication>(
      [{ name: "Cetirizine", dose: "5 mg" }],
      [{ name: "Cetirizine", dose: "10 mg", frequency: "once daily" }],
      medicationKey,
      (t) => ({ name: t }),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].dose).toBe("5 mg");            // the user's edit survives
    expect(merged[0].frequency).toBe("once daily"); // the blank is filled
  });

  it("treats the same procedure in different years as two records", () => {
    expect(surgeryKey({ procedure: "Biopsy", year: 2012 }))
      .not.toBe(surgeryKey({ procedure: "Biopsy", year: 2019 }));
  });
});

describe("formatMeasurement / isProseValue", () => {
  it("renders a blood pressure as one reading", () => {
    expect(formatMeasurement({ systolic: 138, diastolic: 86 }, "mmHg")).toBe("138/86 mmHg");
  });
  it("renders a single value with its unit", () => {
    expect(formatMeasurement({ value: 67 }, "in")).toBe("67 in");
  });
  it("does not call a short datum prose", () => {
    expect(isProseValue("O+")).toBe(false);
    expect(isProseValue("138/86 mmHg")).toBe(false);
  });
});
