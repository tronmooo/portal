import { describe, it, expect } from "vitest";
import {
  normalizeAppleUnit,
  parseAttributes,
  dayOf,
  hoursBetween,
  isAsleepValue,
  parseAppleHealthXml,
  parseHealthCsv,
  parseCsvRow,
} from "../client/src/lib/health-file-parse";

/** Feed a string to the streaming parser in fixed-size pieces, so tests can
 *  force records to straddle a chunk boundary. */
async function* inChunks(text: string, size: number): AsyncGenerator<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

const rec = (attrs: Record<string, string>) =>
  `<Record ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`;

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="en_US">\n`;
const XML_TAIL = `\n</HealthData>\n`;

describe("normalizeAppleUnit", () => {
  it("translates Apple's spellings", () => {
    expect(normalizeAppleUnit("lb")).toBe("lbs");
    expect(normalizeAppleUnit("degC")).toBe("C");
    expect(normalizeAppleUnit("fl_oz_us")).toBe("oz");
    expect(normalizeAppleUnit("Cal")).toBe("kcal");
  });

  it("strips the molar mass from Apple's mmol unit", () => {
    expect(normalizeAppleUnit("mmol<180.1558800000541>/L")).toBe("mmol/L");
  });

  it("blanks dimensionless units so they don't drive a conversion", () => {
    expect(normalizeAppleUnit("count")).toBe("");
    expect(normalizeAppleUnit("count/min")).toBe("");
  });

  it("passes unknown units through untouched", () => {
    expect(normalizeAppleUnit("mmHg")).toBe("mmHg");
    expect(normalizeAppleUnit("")).toBe("");
  });
});

describe("attribute + date helpers", () => {
  it("parses attributes regardless of order or spacing", () => {
    expect(parseAttributes(`type="HKX"  value="12"   unit="lb"`))
      .toEqual({ type: "HKX", value: "12", unit: "lb" });
  });

  it("reads the local calendar day straight off the timestamp", () => {
    expect(dayOf("2026-03-01 07:15:22 -0800")).toBe("2026-03-01");
    expect(dayOf("garbage")).toBeNull();
    expect(dayOf(undefined)).toBeNull();
  });

  it("measures interval length across an offset timestamp", () => {
    expect(hoursBetween("2026-03-01 23:00:00 -0800", "2026-03-02 06:30:00 -0800")).toBeCloseTo(7.5, 5);
  });

  it("returns zero for a reversed or unparseable interval", () => {
    expect(hoursBetween("2026-03-02 06:00:00 -0800", "2026-03-01 23:00:00 -0800")).toBe(0);
    expect(hoursBetween(undefined, undefined)).toBe(0);
  });

  it("recognises the asleep sleep states only", () => {
    expect(isAsleepValue("HKCategoryValueSleepAnalysisAsleepCore")).toBe(true);
    expect(isAsleepValue("HKCategoryValueSleepAnalysisAsleepDeep")).toBe(true);
    expect(isAsleepValue("HKCategoryValueSleepAnalysisInBed")).toBe(false);
    expect(isAsleepValue("HKCategoryValueSleepAnalysisAwake")).toBe(false);
  });
});

describe("parseAppleHealthXml", () => {
  it("aggregates step records into a daily total", async () => {
    const xml = XML_HEAD + [
      rec({ type: "HKQuantityTypeIdentifierStepCount", startDate: "2026-08-01 08:00:00 -0700", endDate: "2026-08-01 09:00:00 -0700", unit: "count", value: "3000" }),
      rec({ type: "HKQuantityTypeIdentifierStepCount", startDate: "2026-08-01 18:00:00 -0700", endDate: "2026-08-01 19:00:00 -0700", unit: "count", value: "5214" }),
      rec({ type: "HKQuantityTypeIdentifierStepCount", startDate: "2026-08-02 08:00:00 -0700", endDate: "2026-08-02 09:00:00 -0700", unit: "count", value: "1000" }),
    ].join("\n") + XML_TAIL;

    const { rows, recordsUsed } = await parseAppleHealthXml(inChunks(xml, 4096));
    expect(recordsUsed).toBe(3);
    expect(rows).toEqual([
      { metric: "steps", day: "2026-08-01", value: 8214 },
      { metric: "steps", day: "2026-08-02", value: 1000 },
    ]);
  });

  // The bug this guards: a naive chunked scan drops any record whose text
  // straddles a boundary. Tiny chunk sizes split nearly every record.
  it("does not lose records split across stream chunks", async () => {
    const xml = XML_HEAD + Array.from({ length: 25 }, (_, i) =>
      rec({
        type: "HKQuantityTypeIdentifierStepCount",
        startDate: `2026-08-${String(i + 1).padStart(2, "0")} 08:00:00 -0700`,
        endDate: `2026-08-${String(i + 1).padStart(2, "0")} 09:00:00 -0700`,
        unit: "count", value: "100",
      }),
    ).join("\n") + XML_TAIL;

    for (const size of [1, 3, 7, 13, 64, 999]) {
      const { rows, recordsUsed } = await parseAppleHealthXml(inChunks(xml, size));
      expect(recordsUsed, `chunk size ${size}`).toBe(25);
      expect(rows, `chunk size ${size}`).toHaveLength(25);
      expect(rows.every(r => r.value === 100)).toBe(true);
    }
  });

  it("converts units on the way in", async () => {
    const xml = XML_HEAD + [
      rec({ type: "HKQuantityTypeIdentifierBodyMass", startDate: "2026-08-01 07:00:00 -0700", endDate: "2026-08-01 07:00:00 -0700", unit: "kg", value: "80" }),
      rec({ type: "HKQuantityTypeIdentifierDistanceWalkingRunning", startDate: "2026-08-01 07:00:00 -0700", endDate: "2026-08-01 08:00:00 -0700", unit: "km", value: "5" }),
    ].join("\n") + XML_TAIL;

    const { rows } = await parseAppleHealthXml(inChunks(xml, 100));
    const weight = rows.find(r => r.metric === "weight")!;
    const distance = rows.find(r => r.metric === "distance_walked")!;
    expect(weight.value).toBeCloseTo(176.37, 1);
    expect(distance.value).toBeCloseTo(3.11, 2);
  });

  it("counts only asleep intervals and buckets a night by its wake day", async () => {
    const xml = XML_HEAD + [
      // In bed from 22:45 but only asleep from 23:00 — the InBed record must not count.
      rec({ type: "HKCategoryTypeIdentifierSleepAnalysis", startDate: "2026-08-01 22:45:00 -0700", endDate: "2026-08-02 06:30:00 -0700", value: "HKCategoryValueSleepAnalysisInBed" }),
      rec({ type: "HKCategoryTypeIdentifierSleepAnalysis", startDate: "2026-08-01 23:00:00 -0700", endDate: "2026-08-02 03:00:00 -0700", value: "HKCategoryValueSleepAnalysisAsleepCore" }),
      rec({ type: "HKCategoryTypeIdentifierSleepAnalysis", startDate: "2026-08-02 03:00:00 -0700", endDate: "2026-08-02 06:30:00 -0700", value: "HKCategoryValueSleepAnalysisAsleepDeep" }),
    ].join("\n") + XML_TAIL;

    const { rows } = await parseAppleHealthXml(inChunks(xml, 200));
    expect(rows).toEqual([{ metric: "sleep", day: "2026-08-02", value: 7.5 }]);
  });

  it("joins systolic and diastolic into one blood-pressure row", async () => {
    const xml = XML_HEAD + [
      rec({ type: "HKQuantityTypeIdentifierBloodPressureSystolic", startDate: "2026-08-01 07:00:00 -0700", endDate: "2026-08-01 07:00:00 -0700", unit: "mmHg", value: "118" }),
      rec({ type: "HKQuantityTypeIdentifierBloodPressureDiastolic", startDate: "2026-08-01 07:00:00 -0700", endDate: "2026-08-01 07:00:00 -0700", unit: "mmHg", value: "76" }),
    ].join("\n") + XML_TAIL;

    const { rows } = await parseAppleHealthXml(inChunks(xml, 90));
    expect(rows).toEqual([
      { metric: "blood_pressure", day: "2026-08-01", value: 118, value2: 76 },
    ]);
  });

  it("expands a 0-1 blood-oxygen fraction to a percentage", async () => {
    const xml = XML_HEAD + rec({
      type: "HKQuantityTypeIdentifierOxygenSaturation",
      startDate: "2026-08-01 07:00:00 -0700", endDate: "2026-08-01 07:00:00 -0700",
      unit: "%", value: "0.97",
    }) + XML_TAIL;

    const { rows } = await parseAppleHealthXml(inChunks(xml, 500));
    expect(rows[0].value).toBeCloseTo(97, 5);
  });

  it("averages heart rate rather than summing it", async () => {
    const xml = XML_HEAD + [
      rec({ type: "HKQuantityTypeIdentifierHeartRate", startDate: "2026-08-01 07:00:00 -0700", endDate: "2026-08-01 07:00:00 -0700", unit: "count/min", value: "60" }),
      rec({ type: "HKQuantityTypeIdentifierHeartRate", startDate: "2026-08-01 08:00:00 -0700", endDate: "2026-08-01 08:00:00 -0700", unit: "count/min", value: "80" }),
    ].join("\n") + XML_TAIL;

    const { rows } = await parseAppleHealthXml(inChunks(xml, 120));
    expect(rows).toEqual([{ metric: "heart_rate", day: "2026-08-01", value: 70 }]);
  });

  it("ignores HealthKit types we do not model without failing", async () => {
    const xml = XML_HEAD + [
      rec({ type: "HKQuantityTypeIdentifierElectrodermalActivity", startDate: "2026-08-01 07:00:00 -0700", endDate: "2026-08-01 07:00:00 -0700", unit: "siemens", value: "1" }),
      rec({ type: "HKQuantityTypeIdentifierStepCount", startDate: "2026-08-01 08:00:00 -0700", endDate: "2026-08-01 09:00:00 -0700", unit: "count", value: "500" }),
    ].join("\n") + XML_TAIL;

    const { rows, recordsUsed, recordsIgnored } = await parseAppleHealthXml(inChunks(xml, 64));
    expect(recordsUsed).toBe(1);
    expect(recordsIgnored).toBe(1);
    expect(rows).toEqual([{ metric: "steps", day: "2026-08-01", value: 500 }]);
  });

  it("returns nothing for an export with no records", async () => {
    const { rows, recordsUsed } = await parseAppleHealthXml(inChunks(XML_HEAD + XML_TAIL, 32));
    expect(rows).toEqual([]);
    expect(recordsUsed).toBe(0);
  });
});

describe("parseCsvRow", () => {
  it("honours quoted fields and escaped quotes", () => {
    expect(parseCsvRow(`a,"b,c",d`)).toEqual(["a", "b,c", "d"]);
    expect(parseCsvRow(`"say ""hi""",2`)).toEqual([`say "hi"`, "2"]);
  });

  it("keeps empty trailing cells", () => {
    expect(parseCsvRow("a,,")).toEqual(["a", "", ""]);
  });
});

describe("parseHealthCsv", () => {
  it("reads the long form", () => {
    const csv = [
      "date,metric,value,unit",
      "2026-08-01,steps,8214,steps",
      "2026-08-01,weight,80,kg",
    ].join("\n");
    const { rows } = parseHealthCsv(csv);
    expect(rows.find(r => r.metric === "steps")!.value).toBe(8214);
    expect(rows.find(r => r.metric === "weight")!.value).toBeCloseTo(176.37, 1);
  });

  it("reads the wide form", () => {
    const csv = ["date,steps,sleep", "2026-08-01,8214,7.5", "2026-08-02,900,6"].join("\n");
    const { rows } = parseHealthCsv(csv);
    expect(rows).toEqual([
      { metric: "sleep", day: "2026-08-01", value: 7.5 },
      { metric: "sleep", day: "2026-08-02", value: 6 },
      { metric: "steps", day: "2026-08-01", value: 8214 },
      { metric: "steps", day: "2026-08-02", value: 900 },
    ]);
  });

  it("ignores columns that are not registry metrics", () => {
    const csv = ["date,steps,horoscope", "2026-08-01,10,leo"].join("\n");
    const { rows } = parseHealthCsv(csv);
    expect(rows).toEqual([{ metric: "steps", day: "2026-08-01", value: 10 }]);
  });

  it("skips rows with an unusable date and blank cells", () => {
    const csv = ["date,steps", "not-a-date,10", "2026-08-01,", "2026-08-02,7"].join("\n");
    const { rows } = parseHealthCsv(csv);
    expect(rows).toEqual([{ metric: "steps", day: "2026-08-02", value: 7 }]);
  });

  it("returns nothing when there is no date column or no data", () => {
    expect(parseHealthCsv("steps,value\n1,2").rows).toEqual([]);
    expect(parseHealthCsv("date,steps").rows).toEqual([]);
    expect(parseHealthCsv("").rows).toEqual([]);
  });
});
