import { describe, it, expect } from "vitest";
import {
  pickPrimaryField, dailySeries, periodStats, comparePeriods, trendVerdict,
  rollingMean, macroSummary, rankCorrelations, buildInsights, currentStreak,
  dayModeFor, polarityFor, topContributors, type AnalyticsEntry, type SeriesSource,
} from "../shared/tracker-analytics";
import { classifyTrackerPresentation } from "../shared/tracker-presentation";

// The tracker detail popup's numbers. Each block below pins a bug the owner
// screenshotted on 2026-10-20 (Nutrition: "Quantity 2.0 – 2.0 across 1
// readings · stable", per-entry macro "averages", a 0-calorie day, and
// "Not enough matching data points" for Quantity vs Calories).

const TZ = "UTC";
const at = (day: string, hour = 12) => `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
let seq = 0;
const E = (day: string, values: Record<string, unknown>, hour = 12): AnalyticsEntry => ({ id: `e${++seq}`, timestamp: at(day, hour), values });

// The chat-created Nutrition tracker: `quantity` is key 0, so it was marked primary.
const nutrition = {
  id: "nut", name: "Nutrition", category: "nutrition",
  fields: [
    { name: "quantity", type: "number", isPrimary: true },
    { name: "calories", type: "number" },
    { name: "protein", type: "number" },
    { name: "carbs", type: "number" },
    { name: "fat", type: "number" },
    { name: "meal", type: "text" },
  ],
  entries: [
    E("2026-08-01", { quantity: 2, meal: "eggs" }),                       // no calories logged
    E("2026-08-09", { calories: 1200, protein: 60, carbs: 100, fat: 50, meal: "lunch" }, 12),
    E("2026-08-09", { calories: 1000, protein: 40, carbs: 120, fat: 30, meal: "dinner" }, 19),
    E("2026-08-24", { calories: 800, protein: 30, carbs: 90, fat: 25, meal: "pasta" }),
  ],
};

describe("the headline field", () => {
  it("is calories, not a serving count marked primary by accident", () => {
    expect(pickPrimaryField(nutrition)).toBe("calories");
    // and the presentation engine (KPI cards, chart style) agrees
    expect(classifyTrackerPresentation(nutrition as any).primaryField).toBe("calories");
  });

  it("keeps a declared primary that is a real measurement", () => {
    expect(pickPrimaryField({ fields: [{ name: "weight", type: "number", isPrimary: true }, { name: "bodyfat", type: "number" }] })).toBe("weight");
  });

  it("keeps a count when it is the only number there is", () => {
    expect(pickPrimaryField({ fields: [{ name: "count", type: "number", isPrimary: true }] })).toBe("count");
  });

  it("skips a better-sounding field that holds no data", () => {
    const t = { fields: [{ name: "quantity", type: "number", isPrimary: true }, { name: "calories", type: "number" }], entries: [E("2026-08-01", { quantity: 1 })] };
    expect(pickPrimaryField(t)).toBe("quantity");
  });
});

describe("daily series", () => {
  it("sums additive values per calendar day and never invents a 0 day", () => {
    const pts = dailySeries(nutrition.entries, "calories", { mode: "sum", tz: TZ });
    expect(pts.map((p) => [p.day, p.value, p.entries])).toEqual([
      ["2026-08-09", 2200, 2],
      ["2026-08-24", 800, 1],
    ]);
    // Aug 1 had no calories: absent, not zero
    expect(pts.find((p) => p.day === "2026-08-01")).toBeUndefined();
  });

  it("takes the day's LAST reading for a measurement", () => {
    const entries = [E("2026-09-01", { weight: 180 }, 7), E("2026-09-01", { weight: 178 }, 21)];
    const pts = dailySeries(entries, "weight", { mode: dayModeFor({}, "weight"), tz: TZ });
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBe(178);
  });

  it("counts a duplicated entry id once", () => {
    const e = E("2026-09-02", { calories: 500 });
    expect(dailySeries([e, { ...e }], "calories", { mode: "sum", tz: TZ })[0].value).toBe(500);
  });
});

describe("averages say what they are over", () => {
  it("nutrition macros are per LOGGED DAY, not per entry", () => {
    const m = macroSummary(nutrition.entries, TZ, null, "2026-10-20");
    expect(m.loggedDays).toBe(3);                 // Aug 1, 9, 24
    expect(m.perDay.protein).toBe(Math.round((130 / 3) * 10) / 10);
    expect(m.missingCalories).toBe(1);
    // energy shares add to ~100 and weight fat at 9 kcal/g
    const s = m.energyShare!;
    expect(s.protein + s.carbs + s.fat).toBeGreaterThanOrEqual(99);
    expect(s.fat).toBeGreaterThan(Math.round((105 / (130 + 310 + 105)) * 100));
  });

  it("period stats average over logged days and report coverage", () => {
    const pts = dailySeries(nutrition.entries, "calories", { mode: "sum", tz: TZ });
    const s = periodStats(pts, "2026-08-01", "2026-08-30");
    expect(s.loggedDays).toBe(2);
    expect(s.spanDays).toBe(30);
    expect(s.perDay).toBe(1500);
    expect(s.high?.day).toBe("2026-08-09");
  });

  it("compares equal-length periods and refuses with too little data", () => {
    const pts = dailySeries([
      E("2026-10-14", { steps: 1000 }), E("2026-10-15", { steps: 1000 }),
      E("2026-10-19", { steps: 1500 }), E("2026-10-20", { steps: 1500 }),
    ], "steps", { mode: "sum", tz: TZ });
    const c = comparePeriods(pts, 7, "2026-10-20");
    expect(c.current.loggedDays).toBe(4);
    expect(c.previous.loggedDays).toBe(0);
    expect(c.changePct).toBeNull();
  });
});

describe("trend verdicts", () => {
  it("one reading is not a trend", () => {
    const pts = dailySeries([E("2026-08-01", { quantity: 2 })], "quantity", { mode: "sum", tz: TZ });
    const v = trendVerdict(pts);
    expect(v.status).toBe("insufficient");
    expect(v.needed).toBe(3);
  });

  it("describes direction and tone from enough days", () => {
    const pts = dailySeries(
      ["2026-10-01", "2026-10-03", "2026-10-05", "2026-10-07", "2026-10-09"].map((d, i) => E(d, { weight: 200 - i * 2 })),
      "weight", { mode: "last", tz: TZ },
    );
    const v = trendVerdict(pts, polarityFor({}, "systolic"));
    expect(v.status).toBe("falling");
    expect(v.tone).toBe("good");
  });

  it("draws no moving average until there are enough days", () => {
    const pts = dailySeries(["2026-10-01", "2026-10-02", "2026-10-03"].map((d) => E(d, { steps: 5 })), "steps", { mode: "sum", tz: TZ });
    expect(rollingMean(pts).every((v) => v === null)).toBe(true);
  });
});

describe("correlations", () => {
  const days = Array.from({ length: 10 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
  const src = (key: string, trackerId: string, vals: number[], label = key): SeriesSource => ({
    key: `${trackerId}:${key}`, trackerId, label, unit: "",
    points: dailySeries(days.map((d, i) => E(d, { [key]: vals[i] })), key, { mode: "sum", tz: TZ }),
  });

  it("finds a day-aligned relationship across trackers", () => {
    const sleep = src("hours", "sleep", [5, 6, 7, 8, 6, 5, 7, 8, 6, 7], "Sleep");
    const rhr = src("bpm", "hr", [70, 66, 62, 58, 66, 71, 62, 57, 65, 61], "Resting HR");
    const { results } = rankCorrelations([sleep, rhr]);
    expect(results).toHaveLength(1);
    expect(results[0].n).toBe(10);
    expect(results[0].direction).toBe("negative");
    expect(results[0].strength).toBe("strong");
    expect(results[0].sentence).toMatch(/10 matching days/);
    expect(results[0].sentence).not.toMatch(/cause|significant/i);
  });

  it("skips arithmetic pairs inside a nutrition tracker (calories ↔ protein, quantity ↔ calories)", () => {
    const a = src("calories", "nut", days.map((_, i) => 400 + i * 10));
    const b = src("protein", "nut", days.map((_, i) => 20 + i));
    const q = src("quantity", "nut", days.map((_, i) => 1 + (i % 2)));
    const { results, near } = rankCorrelations([a, b, q]);
    expect(results).toEqual([]);
    expect(near).toEqual([]);
  });

  it("does not report chance links when many noisy pairs are compared", () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const noise = Array.from({ length: 12 }, (_, k) => src(`f${k}`, `t${k}`, days.map(() => Math.round(rnd() * 100))));
    const { results, tested } = rankCorrelations(noise);
    expect(tested).toBe(66);
    expect(results).toEqual([]);
  });

  it("reports a pair short of matching days as near, not as a result", () => {
    const a = src("hours", "sleep", [5, 6, 7, 8, 6, 5, 7, 8, 6, 7]);
    const b: SeriesSource = { key: "w:weight", trackerId: "w", label: "Weight", unit: "lbs",
      points: dailySeries(days.slice(0, 4).map((d, i) => E(d, { weight: 180 + i })), "weight", { mode: "last", tz: TZ }) };
    const { results, near } = rankCorrelations([a, b]);
    expect(results).toEqual([]);
    expect(near[0].n).toBe(4);
    expect(near[0].needed).toBe(3);
  });
});

describe("insights only say what the data supports", () => {
  it("produces nothing from a single reading but the data-quality warning", () => {
    const entries = [E("2026-10-20", { calories: 400 }), E("2026-10-20", { quantity: 1 })];
    const points = dailySeries(entries, "calories", { mode: "sum", tz: TZ });
    const ins = buildInsights({ field: "calories", label: "Calories", unit: "kcal", mode: "sum", polarity: "neutral", points, entries, today: "2026-10-20" });
    expect(ins.map((i) => i.id)).toEqual(["missing-values"]);
  });

  it("week-over-week change, streak and goal hits from real days", () => {
    const entries = [
      ...["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"].map((d) => E(d, { steps: 6000 })),
      ...["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"].map((d) => E(d, { steps: 9000 })),
    ];
    const points = dailySeries(entries, "steps", { mode: "sum", tz: TZ });
    const ins = buildInsights({ field: "steps", label: "Steps", unit: "steps", mode: "sum", polarity: "higher", points, entries, today: "2026-10-20", goal: { target: 8000 } });
    const byId = Object.fromEntries(ins.map((i) => [i.id, i]));
    expect(byId["week-change"].tone).toBe("improvement");
    expect(byId["week-change"].title).toBe("Up 50% vs last week");
    expect(byId["streak"].title).toBe("5-day logging streak");
    expect(byId["goal-hits"].title).toBe("Goal met on 5 of 9 logged days");
  });

  it("flags partial nutrition days", () => {
    const entries = ["2026-10-18", "2026-10-19", "2026-10-20"].map((d) => E(d, { calories: 400 }));
    const points = dailySeries(entries, "calories", { mode: "sum", tz: TZ });
    const ins = buildInsights({ field: "calories", label: "Calories", unit: "kcal", mode: "sum", polarity: "neutral", points, entries, today: "2026-10-20", isNutrition: true });
    expect(ins.some((i) => i.id === "partial-days")).toBe(true);
  });
});

describe("small helpers", () => {
  it("streak counts back from today or yesterday", () => {
    expect(currentStreak(["2026-10-18", "2026-10-19"], "2026-10-20")).toBe(2);
    expect(currentStreak(["2026-10-17"], "2026-10-20")).toBe(0);
  });

  it("ranks contributors by summed value", () => {
    const top = topContributors(nutrition.entries, "calories", (e) => String(e.values.meal ?? ""));
    expect(top[0]).toMatchObject({ label: "lunch", value: 1200 });
    expect(top.find((t) => t.label === "eggs")).toBeUndefined(); // no calories → not ranked
  });
});
