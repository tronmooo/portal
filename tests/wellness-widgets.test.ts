// Cards the user builds for the Wellness tab (shared/wellness-widgets): the
// same shape from a Widget Idea, the manual builder and the AI Builder, held
// to one validator and computed from the records on read.
import { describe, it, expect } from "vitest";
import {
  COMPARE_CAVEAT, WELLNESS_WIDGET_IDEAS, buildWellnessWidgetView, describeWellnessWidget, formatWellnessValue, groundWellnessWidget,
  inferWellnessWidgetFromText, inferWellnessWidgetsFromText, suggestWellnessWidgets,
  resolveSeries, sanitizeWellnessWidget, wellnessWidgetNeeds, type WellnessSourceData, type WellnessWidget,
} from "../shared/wellness-widgets";
import { TODAY, TZ, daysAgo, fixtureMetrics, fixtureTrackers } from "./helpers/wellness-fixture";

const trackers = fixtureTrackers();
const data = (over: Partial<WellnessSourceData> = {}): WellnessSourceData => ({ metrics: fixtureMetrics(trackers), trackers, journal: [], expenses: [], timezone: TZ, ...over });
const widget = (raw: Record<string, unknown>): WellnessWidget => {
  const w = sanitizeWellnessWidget({ id: "w1", title: "Test card", ...raw });
  if (!w) throw new Error(`not a valid widget: ${JSON.stringify(raw)}`);
  return w;
};
const view = (raw: Record<string, unknown>, range: any = "30d", d = data()) => {
  const v = buildWellnessWidgetView(widget(raw), d, range, TODAY);
  if (!v) throw new Error("the widget is still waiting for a list");
  return v;
};
const M = (key: string) => ({ kind: "metric", key });

describe("the validator is the only door", () => {
  it("accepts the three kinds and fills the defaults", () => {
    expect(widget({ kind: "metric", source: M("weight") })).toMatchObject({ kind: "metric", calc: "average", display: "number", icon: "heart" });
    expect(widget({ kind: "compare", source: M("sleep_hours"), other: { kind: "workouts" }, lag: 7 })).toMatchObject({ kind: "compare", lag: 0 });
    expect(widget({ kind: "score", parts: [{ source: M("sleep_hours"), weight: 99, target: 8 }] }).parts![0]).toMatchObject({ weight: 10, better: "higher" });
  });

  it("refuses what the tab cannot draw", () => {
    const no = (raw: Record<string, unknown>) => expect(sanitizeWellnessWidget({ id: "x", title: "Nope", ...raw })).toBeNull();
    no({ kind: "metric", source: { kind: "metric", key: "not_a_metric" } });
    no({ kind: "metric", source: { kind: "sql", key: "select * from trackers" } });
    no({ kind: "metric" });
    no({ kind: "compare", source: M("weight") });
    no({ kind: "score", parts: [] });
    no({ kind: "score", parts: [{ source: M("weight"), target: -1 }] });
    expect(sanitizeWellnessWidget({ id: "x", title: "A", kind: "metric", source: M("weight") })).toBeNull(); // a one-letter name
    expect(sanitizeWellnessWidget("<script>")).toBeNull();
  });

  it("keeps nothing a model slipped in beside the known fields", () => {
    const w = widget({ kind: "metric", source: { ...M("weight"), query: "drop table" }, calc: "eval(x)", display: "<b>", formula: "a+b", html: "<img>" });
    expect(Object.keys(w).sort()).toEqual(["calc", "display", "icon", "id", "kind", "source", "title"]);
    expect(w.source).toEqual({ kind: "metric", key: "weight" });
    expect(w.calc).toBe("average");
    expect(w.display).toBe("number");
  });
});

describe("one measure", () => {
  it("average, against the period before", () => {
    const v = view({ kind: "metric", source: M("sleep_hours"), calc: "average", display: "line" });
    expect(v.headline).toEqual({ value: "7.8 h", label: "Average · 30 days" });
    expect(v.delta).toEqual({ text: "+19% vs prior 30d", good: true });
    expect(v.chart).toBe("line");
    expect(v.series).toHaveLength(10);
  });
  it("latest, change, lowest and highest read the same weigh-ins", () => {
    expect(view({ kind: "metric", source: M("weight"), calc: "latest" }).headline!.value).toBe("204 lbs");
    expect(view({ kind: "metric", source: M("weight"), calc: "change" }).headline!.value).toBe("-9 lbs");
    expect(view({ kind: "metric", source: M("weight"), calc: "max" }).headline!.value).toBe("213 lbs");
    expect(view({ kind: "metric", source: M("weight"), calc: "min" }).headline!.value).toBe("204 lbs");
  });
  it("counts a tracker's entries, and totals one of its number fields", () => {
    expect(view({ kind: "metric", source: { kind: "tracker", key: "Guitar practice" }, calc: "count" }).headline!.value).toBe("2 entries");
    expect(view({ kind: "metric", source: { kind: "tracker", key: "guitar", field: "minutes" }, calc: "total" }).headline!.value).toBe("75 min");
    expect(view({ kind: "metric", source: { kind: "workouts" }, calc: "count", display: "bar" })).toMatchObject({ headline: { value: "5 entries" }, chart: "bar" });
  });
  it("a list shows the newest days first", () => {
    const rows = view({ kind: "metric", source: M("weight"), calc: "latest", display: "list" }).rows!;
    expect(rows.map((r) => r.value)).toEqual(["204 lbs", "208 lbs", "213 lbs"]);
  });
  it("its own range wins over the tab's", () => {
    expect(view({ kind: "metric", source: M("weight"), calc: "max", range: "all" }, "7d").headline!.value).toBe("215 lbs");
  });
  it("a range with nothing names the last reading; never-recorded says so", () => {
    expect(view({ kind: "metric", source: M("bp_systolic") }, "7d").empty).toBe("No systolic in 7 days · Last: Oct 21");
    expect(view({ kind: "metric", source: M("hrv") }).empty).toBe("Nothing recorded for hrv yet.");
    expect(view({ kind: "metric", source: { kind: "tracker", key: "No such tracker" } }).empty).toMatch(/Nothing recorded/);
  });
  it("says what it read and how", () => {
    const v = view({ kind: "metric", source: M("sleep_hours") });
    expect(v.sources).toEqual(["Sleep"]);
    expect(v.explain).toBe("Average of Sleep over 30 days (10 days with data).");
  });
});

describe("health spending and mood come from their own lists", () => {
  const expenses = [
    { amount: 40, category: "pharmacy", description: "Refill", date: daysAgo(3), tags: [] },
    { amount: 120, category: "medical", description: "Dentist", date: daysAgo(10), tags: [] },
    { amount: 60, category: "groceries", description: "Food", date: daysAgo(2), tags: [] },
  ];
  it("totals only health expenses, or the ones containing the word", () => {
    expect(view({ kind: "metric", source: { kind: "spending" }, calc: "total" }, "30d", data({ expenses })).headline!.value).toBe("$160");
    expect(view({ kind: "metric", source: { kind: "spending", key: "pharmacy" }, calc: "total" }, "30d", data({ expenses })).headline!.value).toBe("$40");
  });
  it("a list that has not loaded is 'not yet', never an empty card (Rule 7)", () => {
    const spend = widget({ kind: "metric", source: { kind: "spending" }, calc: "total" });
    expect(buildWellnessWidgetView(spend, data({ expenses: undefined }), "30d", TODAY)).toBeNull();
    expect(resolveSeries({ kind: "mood" }, data({ journal: undefined }))).toBeNull();
    expect(wellnessWidgetNeeds(spend)).toEqual(["expenses"]);
    expect(wellnessWidgetNeeds(widget({ kind: "compare", source: { kind: "workouts" }, other: { kind: "mood" } }))).toEqual(["journal"]);
    expect(wellnessWidgetNeeds(widget({ kind: "metric", source: M("weight") }))).toEqual([]);
  });
});

describe("comparing two", () => {
  it("splits the days by the condition and averages the other on each side", () => {
    // Ten nights: five of 8.5 h (a run on each), five of 7 h (none).
    const v = view({ kind: "compare", source: M("sleep_hours"), other: { kind: "workouts" }, threshold: 8 });
    expect(v.rows).toEqual([
      { key: "hi", label: "Sleep 8 h or more", value: "1 session", sub: "5 days" },
      { key: "lo", label: "Sleep under 8 h", value: "0 sessions", sub: "5 days" },
    ]);
    expect(v.caveat).toBe(COMPARE_CAVEAT);
    expect(v.explain).toMatch(/^Days are split by Sleep \(8 h or more, and under\)/);
  });
  it("a total with no threshold is days with any against days with none", () => {
    const journal = [0, 2, 4, 6, 8].map((n) => ({ date: daysAgo(n), mood: "great" })).concat([1, 3, 5, 7].map((n) => ({ date: daysAgo(n), mood: "okay" })));
    const v = view({ kind: "compare", source: { kind: "workouts" }, other: { kind: "mood" } }, "30d", data({ journal }));
    expect(v.rows!.map((r) => [r.label, r.value, r.sub])).toEqual([["Days with workout sessions", "7 / 8", "5 days"], ["Days without", "5 / 8", "4 days"]]);
    expect(v.headline!.value).toBe("+40%");
  });
  it("too few days is said, with the caveat still there — never a made-up pattern", () => {
    // No night reached 9 hours: one side of the split is empty.
    const v = view({ kind: "compare", source: M("sleep_hours"), other: { kind: "workouts" }, threshold: 9 });
    expect(v.headline).toBeUndefined();
    expect(v.empty).toMatch(/^Not enough days with both yet/);
    expect(v.caveat).toBe(COMPARE_CAVEAT);
  });
});

describe("a custom score", () => {
  it("shows its working, and leaves out a part with no data instead of scoring it zero", () => {
    const idea = WELLNESS_WIDGET_IDEAS.find((i) => i.key === "score")!.widget;
    const v = view(idea as any);
    // Sleep 7.75 of 8 → 97 at weight 4; workouts 5 in 30 days → 0.17 of 0.5 a day → 33 at weight 3; water has no data.
    expect(v.headline!.value).toBe("70");
    expect(v.rows!.map((r) => r.value)).toEqual(["97", "33", "—"]);
    expect(v.rows![2].sub).toBe("No data in 30 days · left out");
    expect(v.explain).toMatch(/left out, not counted as zero/);
  });
  it("lower-is-better parts lose marks above their target", () => {
    const v = view({ kind: "score", parts: [{ source: M("weight"), weight: 1, target: 200, better: "lower" }] });
    expect(Number(v.headline!.value)).toBeGreaterThan(90);
    expect(Number(v.headline!.value)).toBeLessThan(100);
  });
});

describe("a sentence, read by fixed rules (the AI Builder's fallback)", () => {
  const names = { trackerNames: trackers.map((t) => t.name) };
  const infer = (text: string) => inferWellnessWidgetFromText(text, names);

  it("reads a comparison: what is compared, and the condition with its threshold", () => {
    expect(infer("do I exercise more after sleeping 8 hours")).toMatchObject({
      kind: "compare", source: { kind: "metric", key: "sleep_hours" }, other: { kind: "workouts" }, threshold: 8, by: "ai",
    });
    expect(infer("mood vs activity")).toMatchObject({ kind: "compare", source: { kind: "workouts" }, other: { kind: "mood" }, title: "Mood vs. Workouts" });
  });
  it("reads a single measure, its calculation and its period", () => {
    expect(infer("my weekly sleep average")).toMatchObject({ kind: "metric", source: { kind: "metric", key: "sleep_hours" }, calc: "average", range: "7d" });
    expect(infer("how much I spend on healthcare this year")).toMatchObject({ source: { kind: "spending" }, calc: "total", range: "1y" });
    expect(infer("how often I practice guitar")).toMatchObject({ source: { kind: "tracker", key: "Guitar practice" }, calc: "count" });
  });
  it("reads a score from the things named", () => {
    const w = infer("a health score from sleep and workouts");
    expect(w.kind).toBe("score");
    expect(w.parts!.map((p) => p.source)).toEqual([{ kind: "metric", key: "sleep_hours" }, { kind: "workouts" }]);
  });
  it("does not find a lab inside another word ('health' contains ALT)", () => {
    const w = infer("my health in general");
    expect(JSON.stringify(w)).not.toMatch(/"alt"/);
  });
  it("always answers with a valid widget", () => {
    for (const text of ["", "asdf qwer", "🙂", "x".repeat(500)]) {
      const w = infer(text);
      expect(sanitizeWellnessWidget(w)).toEqual(w);
    }
  });
});

describe("several cards from one description", () => {
  const names = { trackerNames: trackers.map((t) => t.name) };
  it("each thing asked for is its own card", () => {
    const ws = inferWellnessWidgetsFromText("running distance, my weekly sleep average, weight trend and whether I exercise more after sleeping eight hours", names);
    expect(ws.map((w) => w.kind)).toEqual(["metric", "metric", "metric", "compare"]);
    expect(ws[1]).toMatchObject({ source: { kind: "metric", key: "sleep_hours" }, range: "7d" });
    expect(ws[3]).toMatchObject({ source: { kind: "metric", key: "sleep_hours" }, other: { kind: "workouts" }, threshold: 8 });
    expect(new Set(ws.map((w) => w.id)).size).toBe(4);
  });
  it("one thing is one card; a score's parts are not split", () => {
    expect(inferWellnessWidgetsFromText("my average sleep", names)).toHaveLength(1);
    const score = inferWellnessWidgetsFromText("a health score from sleep and workouts", names);
    expect(score).toHaveLength(1);
    expect(score[0].kind).toBe("score");
  });
});

describe("held to the trackers the person actually has", () => {
  it("writes the real tracker name and field back, and drops a field it does not have", () => {
    const w = widget({ kind: "metric", source: { kind: "tracker", key: "guitar", field: "MINUTES" }, calc: "total" });
    expect(groundWellnessWidget(w, trackers)!.source).toEqual({ kind: "tracker", key: "Guitar practice", field: "minutes" });
    const noField = widget({ kind: "metric", source: { kind: "tracker", key: "Guitar practice", field: "laps" }, calc: "count" });
    expect(groundWellnessWidget(noField, trackers)!.source).toEqual({ kind: "tracker", key: "Guitar practice" });
  });
  it("refuses a card over a tracker that does not exist — anywhere in it", () => {
    expect(groundWellnessWidget(widget({ kind: "metric", source: { kind: "tracker", key: "Cycling" } }), trackers)).toBeNull();
    expect(groundWellnessWidget(widget({ kind: "compare", source: { kind: "metric", key: "sleep_hours" }, other: { kind: "tracker", key: "Cycling" } }), trackers)).toBeNull();
    expect(groundWellnessWidget(widget({ kind: "score", parts: [{ source: { kind: "tracker", key: "Cycling" }, target: 1 }] }), trackers)).toBeNull();
  });
  it("leaves the fixed sources alone", () => {
    const w = widget({ kind: "compare", source: { kind: "workouts" }, other: { kind: "mood" } });
    expect(groundWellnessWidget(w, [])).toEqual(w);
  });
});

describe("suggested from what is actually tracked", () => {
  const offers = suggestWellnessWidgets(data());
  it("offers a card for each measurement and tracker that has data, busiest first", () => {
    const titles = offers.map((o) => o.widget.title);
    expect(titles).toEqual(["Sleep Trend", "Running Log", "Running Distance", "Weight Trend", "Nutrition Calories", "Systolic Trend", "Diastolic Trend", "Headache Severity", "Guitar Practice Minutes"]);
    // A level is averaged, an amount is added up.
    expect(offers.find((o) => o.widget.title === "Headache Severity")!.widget).toMatchObject({ calc: "average", display: "line" });
    expect(offers.find((o) => o.widget.title === "Running Distance")!.widget).toMatchObject({ calc: "total", source: { kind: "tracker", key: "Running", field: "distance" } });
    expect(offers[0]).toMatchObject({ key: "metric:sleep_hours", entries: 20, hint: "20 readings · last Nov 23" });
    for (let i = 1; i < offers.length; i++) expect(offers[i - 1].entries).toBeGreaterThanOrEqual(offers[i].entries);
  });
  it("every offer draws real figures the moment it is added", () => {
    for (const o of offers) {
      const v = buildWellnessWidgetView(widget(o.widget as any), data(), "all", TODAY)!;
      expect(v.empty, o.widget.title).toBeUndefined();
      expect(v.headline?.value, o.widget.title).toBeTruthy();
    }
    expect(view(offers.find((o) => o.widget.title === "Guitar Practice Minutes")!.widget as any, "all").headline!.value).toBe("75 min");
  });
  it("offers nothing for an empty account, and nothing the person already has", () => {
    expect(suggestWellnessWidgets(data({ metrics: new Map(), trackers: [] }))).toEqual([]);
    expect(suggestWellnessWidgets(data(), [{ title: "Sleep Trend" }]).some((o) => o.widget.title === "Sleep Trend")).toBe(false);
  });
});

describe("words", () => {
  it("describes a card in one line", () => {
    expect(describeWellnessWidget(widget({ kind: "metric", source: M("weight"), calc: "latest", display: "line", range: "90d" }))).toBe("Weight · Latest value · Line graph · 90 days");
    expect(describeWellnessWidget(widget({ kind: "compare", source: M("sleep_hours"), other: { kind: "workouts" } }))).toBe("Workouts against Sleep");
  });
  it("formats a value with its unit", () => {
    expect(formatWellnessValue(1, "sessions")).toBe("1 session");
    expect(formatWellnessValue(2320, "kcal")).toBe("2,320 kcal");
    expect(formatWellnessValue(7.75, "h")).toBe("7.8 h");
    expect(formatWellnessValue(159.6, "$")).toBe("$160");
    expect(formatWellnessValue(null)).toBe("—");
  });
});
