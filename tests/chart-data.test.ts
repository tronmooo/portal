import { describe, it, expect } from "vitest";
import {
  classifyMetric, pickGranularity, aggregateTimeSeries, pickChartField,
} from "../shared/chart-data";

// These pin the "numbers are correct" contract for AI charts: the right field
// is plotted, additive metrics are SUMMED per day, measurements take the last
// reading, and gaps in the window are reported (not silently dropped).

const TZ = "America/Los_Angeles";
// Midday UTC keeps the calendar day stable across the LA offset.
const at = (ymd: string) => new Date(`${ymd}T19:00:00Z`); // 12pm LA

describe("classifyMetric", () => {
  it("additive nutrition/activity fields → sum", () => {
    for (const f of ["carbs", "Protein", "calories", "miles", "amount", "steps"]) {
      expect(classifyMetric(f)).toBe("sum");
    }
  });
  it("measurement fields → last reading", () => {
    for (const f of ["weight", "systolic", "glucose", "bodyFat", "heartRate"]) {
      expect(classifyMetric(f)).toBe("last");
    }
  });
});

describe("pickGranularity", () => {
  it("scales the bucket size with the window", () => {
    expect(pickGranularity("week")).toBe("day");
    expect(pickGranularity("month")).toBe("day");
    expect(pickGranularity("3months")).toBe("week");
    expect(pickGranularity("year")).toBe("month");
  });
});

describe("pickChartField — plot the metric the user asked for", () => {
  const fields = ["item", "calories", "protein", "carbs", "fat"];
  it("honors an explicit requested field", () => {
    expect(pickChartField("carbs", "Anything", fields)).toBe("carbs");
  });
  it("handles synonyms (carb → carbs)", () => {
    expect(pickChartField("carb", undefined, fields)).toBe("carbs");
  });
  it("falls back to a keyword in the title", () => {
    expect(pickChartField(undefined, "Carbs This Week", fields)).toBe("carbs");
  });
  it("does NOT silently pick the primary field when a macro was asked for", () => {
    // The bug: title says Carbs but code plotted the primary 'calories'.
    expect(pickChartField(undefined, "Carbs This Week", fields, "calories")).toBe("carbs");
  });
});

describe("aggregateTimeSeries — daily carbs SUM (the reported bug)", () => {
  // Three nutrition logs on Jun 17 (incl. the 120g Steak Quesadillas), one Jun 21.
  const entries = [
    { date: at("2026-06-17"), value: 120 }, // Steak Quesadillas
    { date: at("2026-06-17"), value: 30 },
    { date: at("2026-06-17"), value: 20 },
    { date: at("2026-06-21"), value: 45 },
  ];

  it("sums all logs within a day instead of plotting one entry", () => {
    const r = aggregateTimeSeries(entries, {
      since: at("2026-06-15"), until: at("2026-06-21"), granularity: "day", mode: "sum", tz: TZ,
    });
    const jun17 = r.points.find(p => p.label === "Jun 17");
    expect(jun17?.value).toBe(170); // 120 + 30 + 20 — the correct daily total
    expect(jun17?.count).toBe(3);
    const jun21 = r.points.find(p => p.label === "Jun 21");
    expect(jun21?.value).toBe(45);
  });

  it("fills the whole window so gaps are explicit, not dropped", () => {
    const r = aggregateTimeSeries(entries, {
      since: at("2026-06-15"), until: at("2026-06-21"), granularity: "day", mode: "sum", tz: TZ,
    });
    expect(r.totalBuckets).toBe(7);       // Jun 15..21 inclusive
    expect(r.filledBuckets).toBe(2);      // only 17 and 21 have data
    expect(r.emptyBuckets).toBe(5);       // the gaps the chart should note
    expect(r.usedCount).toBe(4);
    // Empty days are present as null (a gap), not fabricated zeros that imply a reading.
    const jun18 = r.points.find(p => p.label === "Jun 18");
    expect(jun18?.value).toBeNull();
  });
});

describe("aggregateTimeSeries — measurements take the last reading", () => {
  it("weight: two readings same day → keeps the latest, never sums", () => {
    const entries = [
      { date: at("2026-06-17"), value: 180 },
      { date: at("2026-06-17"), value: 179 }, // later same-day reading
      { date: at("2026-06-19"), value: 178 },
    ];
    const r = aggregateTimeSeries(entries, {
      since: at("2026-06-17"), until: at("2026-06-19"), granularity: "day", mode: "last", tz: TZ,
    });
    expect(r.points.find(p => p.label === "Jun 17")?.value).toBe(179);
    expect(r.points.find(p => p.label === "Jun 19")?.value).toBe(178);
  });
});

describe("aggregateTimeSeries — weekly bucketing for long ranges", () => {
  it("groups daily entries into Monday-anchored weeks", () => {
    const entries = [
      { date: at("2026-06-01"), value: 10 }, // Mon
      { date: at("2026-06-03"), value: 5 },  // Wed (same week)
      { date: at("2026-06-08"), value: 7 },  // next Mon
    ];
    const r = aggregateTimeSeries(entries, {
      since: at("2026-06-01"), until: at("2026-06-08"), granularity: "week", mode: "sum", tz: TZ,
    });
    // Week of Jun 1 = 15, week of Jun 8 = 7
    const wk1 = r.points[0];
    expect(wk1.value).toBe(15);
  });
});
