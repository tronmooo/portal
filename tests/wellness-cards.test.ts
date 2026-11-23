// What the built-in Wellness cards say about a period (shared/wellness-cards).
// The fixture is one person's sixty days ending 2026-11-23
// (tests/helpers/wellness-fixture.ts).
import { describe, it, expect } from "vitest";
import {
  activitySummary, formatMinutes, healthGoals, moodSummary, moveIsGood, nutritionLines, nutritionSeries, overviewTiles, periodInsights,
  sleepLines, symptomRows, trendRows, vitalGraphs, type OverviewTile, type WellnessCardsInput,
} from "../shared/wellness-cards";
import { getCanonicalMetric } from "../shared/wellness-canon";
import { labPanels } from "../shared/wellness-readout";
import type { WellnessRange } from "../shared/wellness-period";
import { NOW, TODAY, TZ, daysAgo, entry, fixtureMetrics, fixtureTrackers, tracker } from "./helpers/wellness-fixture";

const input = (range: WellnessRange, trackers = fixtureTrackers()): WellnessCardsInput =>
  ({ metrics: fixtureMetrics(trackers), trackers, range, todayISO: TODAY, timezone: TZ, now: NOW });
const tile = (tiles: OverviewTile[], key: string): OverviewTile => {
  const t = tiles.find((x) => x.key === key);
  if (!t) throw new Error(`no ${key} tile`);
  return t;
};

describe("Overview tiles", () => {
  const tiles = overviewTiles(input("30d"));

  it("sleep is the average night, against the 30 days before", () => {
    expect(tile(tiles, "sleep")).toMatchObject({ tracked: true, value: "7.8 hrs avg", delta: { text: "+19% vs prior 30d", good: true, dir: "up" } });
  });
  it("activity counts sessions", () => {
    expect(tile(tiles, "activity")).toMatchObject({ value: "5 sessions", delta: { text: "+400% vs prior 30d", good: true } });
  });
  it("weight is the latest weigh-in and how far it moved; the direction is not judged", () => {
    expect(tile(tiles, "weight")).toMatchObject({ value: "204 lbs", delta: { text: "−9 lbs (4.2%)", good: null, dir: "down" }, last: "Last: Nov 20" });
  });
  it("nutrition is the average logged day, with one entry per food added up", () => {
    expect(tile(tiles, "nutrition")).toMatchObject({ value: "750 kcal avg", note: "2 days logged" });
  });
  it("something never recorded is not tracked — no zero is invented for it", () => {
    const water = tile(tiles, "hydration");
    expect(water.tracked).toBe(false);
    expect(water.value).toBeNull();
  });
  it("a reading older than the range is still shown, dated and marked stale", () => {
    const bp = tile(tiles, "bp");
    expect(bp).toMatchObject({ tracked: true, value: "139 / 80", last: "Last: Oct 21", stale: true });
    const weight7 = tile(overviewTiles(input("7d")), "weight");
    expect(weight7).toMatchObject({ value: "204 lbs", stale: false });
    expect(weight7.delta).toBeUndefined(); // one weigh-in in the week is not a change
  });
  it("an average with nothing in the range is empty, and names the last reading", () => {
    const old = [tracker("t-sleep", "Sleep", "health", [{ name: "hours", unit: "hours" }], [entry("2026-09-01", { hours: 7 })])];
    const sleep = tile(overviewTiles(input("30d", old)), "sleep");
    expect(sleep).toMatchObject({ tracked: true, value: null, last: "Last: Sep 1" });
  });
});

describe("Health Trends", () => {
  it("names where each measurement started and where it is now", () => {
    const rows = trendRows(input("30d"));
    const weight = rows.find((r) => r.key === "weight")!;
    expect(weight).toMatchObject({ label: "Weight", span: "213 → 204 lbs", change: "−9 lbs (4.2%)", good: null });
    expect(rows.find((r) => r.key === "sleep_hours")!.span).toBe("7 → 8.5 hrs");
  });
  it("blood pressure is one row of both numbers, judged against the reference range", () => {
    const rows = trendRows(input("90d"));
    const bp = rows.find((r) => r.key === "bp")!;
    // The top number edged further above its range while the bottom came down: neither better nor worse.
    expect(bp).toMatchObject({ label: "Blood Pressure", span: "138/86 → 139/80", change: "Mixed", good: null });
    expect(rows.some((r) => r.key === "bp_diastolic")).toBe(false);
  });
  it("a measurement with one reading in the range has no trend", () => {
    expect(trendRows(input("7d")).some((r) => r.key === "weight")).toBe(false);
  });
  it("a move is good when it ends closer to the healthy range", () => {
    const dia = getCanonicalMetric("bp_diastolic")!;
    expect(moveIsGood(dia, 86, 80)).toBe(true);
    expect(moveIsGood(dia, 78, 88)).toBe(false);
    expect(moveIsGood(getCanonicalMetric("weight")!, 213, 204)).toBeNull();
    expect(moveIsGood(getCanonicalMetric("hrv")!, 40, 52)).toBe(true);
  });
});

describe("Activity Summary", () => {
  it("totals the range, compares with the one before, and reads calories from the entries", () => {
    const a = activitySummary(input("30d"));
    expect(a).toMatchObject({ sessions: 5, priorSessions: 1, minutes: 100, distance: 10, calories: 1250 });
    expect(a.groups.map((g) => g.type)).toEqual(["Running"]);
    expect(formatMinutes(440)).toBe("7h 20m");
    expect(formatMinutes(45)).toBe("45m");
  });
  it("a hobby that records minutes is not a workout", () => {
    expect(activitySummary(input("all")).groups.some((g) => /guitar/i.test(g.type))).toBe(false);
  });
  it("an empty range still knows the last session", () => {
    const old = [tracker("t-run", "Running", "fitness", [{ name: "distance", unit: "mi" }], [entry(daysAgo(40), { distance: 3 })])];
    const a = activitySummary(input("7d", old));
    expect(a.sessions).toBe(0);
    expect(a.lastAt).toMatch(/^2026-10-14/);
  });
});

describe("Sleep & Recovery, Nutrition & Hydration", () => {
  it("lists only what was ever recorded", () => {
    const lines = sleepLines(input("30d"));
    expect(lines.map((l) => l.key)).toEqual(["sleep", "nights", "range"]);
    expect(lines[0]).toMatchObject({ value: "7.8 hrs", delta: "+19% vs prior 30d", good: true });
    expect(lines[2].value).toBe("7 · 8.5 hrs");
    expect(sleepLines(input("30d", []))).toEqual([]);
  });
  it("nutrition adds each food into its day", () => {
    const n = nutritionSeries(fixtureTrackers(), TZ);
    expect(n.calories.map((p) => p.value)).toEqual([800, 700]);
    expect(n.protein.map((p) => p.value)).toEqual([34, 25]);
    const lines = nutritionLines(input("30d"));
    expect(lines.find((l) => l.key === "calories")!.value).toBe("750 kcal");
    expect(lines.find((l) => l.key === "days")!.value).toBe("2");
    expect(lines.some((l) => l.key === "water")).toBe(false);
  });
});

describe("Insights", () => {
  it("are sentences about the period, from the same figures the cards show", () => {
    const lines = periodInsights(input("30d")).map((l) => l.text);
    expect(lines).toContain("Weight is down 9 lbs (4.2%) over 30 days.");
    expect(lines).toContain("Activity is up 400% with 5 sessions over 30 days.");
    expect(lines).toContain("Sleep improved by 1.3 hrs per night, to 7.8 hrs.");
  });
  it("name an out-of-range reading with its number, and never diagnose", () => {
    const i = input("90d");
    const lines = periodInsights(i, labPanels(i.metrics));
    const bp = lines.find((l) => l.tone === "warn");
    expect(bp?.text).toMatch(/blood pressure is above the reference range \(\d+ mmHg on Oct 21\)/);
    expect(lines.map((l) => l.text).join(" ")).not.toMatch(/hypertension|you should|diagnos/i);
  });
  it("say nothing when there is nothing", () => {
    expect(periodInsights(input("30d", []))).toEqual([]);
  });
});

describe("Mood, symptoms, graphs, goals", () => {
  it("mood is the journal's, averaged per day", () => {
    const journal = [
      { date: daysAgo(1), mood: "great", energy: 4 }, { date: daysAgo(1), mood: "good", energy: 2 }, { date: daysAgo(3), mood: "okay" },
      { date: daysAgo(50), mood: "bad" }, { date: daysAgo(2), mood: "not-a-mood" },
    ];
    const m = moodSummary(journal, "30d", TODAY, TZ);
    expect(m).toMatchObject({ entries: 3, average: "Good", energy: 3 });
    expect(m.counts).toEqual(expect.arrayContaining([{ mood: "Great", count: 1 }, { mood: "Okay", count: 1 }]));
    const none = moodSummary(journal, "7d", daysAgo(-30), TZ);
    expect(none.entries).toBe(0);
    expect(none.last).toBe(`Last: ${new Date(`${daysAgo(1)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`);
  });
  it("symptoms are counted per tracker with the last note", () => {
    expect(symptomRows(input("7d"))).toEqual([{ trackerId: "t-head", name: "Headache", count: 2, last: "Last: Nov 21", note: "After a long drive" }]);
  });
  it("a graph needs two days of a vital in the range", () => {
    expect(vitalGraphs(input("30d")).map((g) => g.id).sort()).toEqual(["sleep_hours", "weight"]);
    expect(vitalGraphs(input("90d")).map((g) => g.id)).toContain("bp_systolic");
  });
  it("health goals: by type, by a linked tracker, or by name — and a weight goal counts down", () => {
    const goals = [
      { id: "g1", title: "Reach 195", type: "weight_loss", target: 195, current: 204, startValue: 213, unit: "lbs", status: "active" },
      { id: "g2", title: "Save for a car", type: "savings", target: 5000, current: 100, status: "active" },
      { id: "g3", title: "Run 100 miles", type: "custom", target: 100, current: 25, unit: "mi", status: "active", deadline: "2027-03-01" },
      { id: "g4", title: "Old", type: "fitness_distance", target: 10, current: 10, status: "completed" },
    ];
    const rows = healthGoals(goals, fixtureTrackers());
    expect(rows.map((r) => r.id)).toEqual(["g1", "g3"]);
    expect(rows[0]).toMatchObject({ progress: "204 of 195 lbs", pct: 50 });
    expect(rows[1]).toMatchObject({ pct: 25, deadline: "By Mar 1" });
  });
});
