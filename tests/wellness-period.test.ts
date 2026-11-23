// The Wellness tab's period maths (shared/wellness-period): one summary per
// series and range, read by every tile, trend row, widget and insight.
import { describe, it, expect } from "vitest";
import {
  dailyPoints, formatPct, metricDailyPoints, pctChange, periodWindow, priorLabel, rangeDays, shortDay, sparkValues, summarize,
} from "../shared/wellness-period";
import { TODAY, TZ, fixtureMetrics } from "./helpers/wellness-fixture";

describe("ranges", () => {
  it("a 30-day range ends today and is preceded by the 30 days before it", () => {
    expect(periodWindow("30d", TODAY)).toEqual({ from: "2026-10-25", to: "2026-11-23", priorFrom: "2026-09-25", priorTo: "2026-10-24", days: 30 });
    expect(periodWindow("7d", TODAY).from).toBe("2026-11-17");
  });
  it("all time has no lower bound and nothing to compare with", () => {
    expect(periodWindow("all", TODAY)).toEqual({ from: null, to: TODAY, priorFrom: null, priorTo: null, days: null });
    expect(rangeDays("all")).toBeNull();
    expect(priorLabel("all")).toBe("");
    expect(priorLabel("30d")).toBe("vs prior 30d");
  });
});

describe("one point per day", () => {
  const readings = [
    { value: 20, at: "2026-11-22T08:00:00Z" }, { value: 12, at: "2026-11-22T19:00:00Z" }, { value: 30, at: "2026-11-23T09:00:00Z", isEstimated: true },
  ];
  it("a total adds the day's entries; a reading keeps the day's last", () => {
    expect(dailyPoints(readings, "sum", TZ)).toEqual([{ day: "2026-11-22", value: 32, n: 2 }, { day: "2026-11-23", value: 30, n: 1, estimated: true }]);
    expect(dailyPoints(readings, "last", TZ)[0]).toEqual({ day: "2026-11-22", value: 12, n: 2 });
  });
  it("a bare calendar day is that day in any timezone", () => {
    expect(dailyPoints([{ value: 5, at: "2026-11-18" }], "sum", "America/Los_Angeles")[0].day).toBe("2026-11-18");
  });
  it("weight is read per weigh-in, not summed", () => {
    const pts = metricDailyPoints(fixtureMetrics().get("weight"));
    expect(pts.map((p) => p.value)).toEqual([215, 213, 208, 204]);
  });
});

describe("summarize", () => {
  const weight = () => metricDailyPoints(fixtureMetrics().get("weight"));

  it("states where the range started, where it is now, and the move between", () => {
    const s = summarize(weight(), "30d", TODAY);
    expect(s.days).toBe(3);
    expect(s.first!.value).toBe(213);
    expect(s.last!.value).toBe(204);
    expect(s.change).toBe(-9);
    expect(Math.round(s.changePct! * 10) / 10).toBe(-4.2);
    expect(s.min).toBe(204);
    expect(s.max).toBe(213);
  });

  it("compares with the period before", () => {
    const sleep = summarize(metricDailyPoints(fixtureMetrics().get("sleep_hours")), "30d", TODAY);
    expect(sleep.avg).toBe(7.75);
    expect(sleep.priorAvg).toBe(6.5);
    expect(formatPct(pctChange(sleep.avg, sleep.priorAvg)!)).toBe("+19%");
  });

  it("a range with no reading still knows the last one (a range is a filter, not a deletion)", () => {
    const bp = summarize(metricDailyPoints(fixtureMetrics().get("bp_systolic")), "7d", TODAY);
    expect(bp.days).toBe(0);
    expect(bp.avg).toBeNull();
    expect(bp.last).toBeNull();
    expect(bp.latestEver).toMatchObject({ day: "2026-10-21", value: 139 });
  });

  it("one day is not a change", () => {
    const s = summarize([{ day: TODAY, value: 5, n: 1 }], "7d", TODAY);
    expect(s.change).toBeNull();
    expect(s.changePct).toBeNull();
  });

  it("ignores a day after today", () => {
    const s = summarize([{ day: "2026-11-25", value: 9, n: 1 }], "all", TODAY);
    expect(s.days).toBe(0);
    expect(s.latestEver).toBeNull();
  });
});

describe("formatting", () => {
  it("percent, with a real minus and no sign on zero", () => {
    expect(formatPct(12.4)).toBe("+12%");
    expect(formatPct(-4.2)).toBe("−4%");
    expect(formatPct(0.2)).toBe("0%");
    expect(pctChange(5, 0)).toBeNull();
    expect(pctChange(null, 4)).toBeNull();
  });
  it("a day is printed as that calendar day", () => {
    expect(shortDay("2026-10-21")).toBe("Oct 21");
    expect(shortDay("garbage")).toBe("");
  });
  it("a long series is thinned for a small chart, keeping both ends", () => {
    const pts = Array.from({ length: 400 }, (_, i) => ({ day: `d${i}`, value: i, n: 1 }));
    const v = sparkValues(pts, 40);
    expect(v).toHaveLength(40);
    expect(v[0]).toBe(0);
    expect(v[39]).toBe(399);
  });
});
