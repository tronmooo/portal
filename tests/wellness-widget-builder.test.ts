// The Wellness AI Builder (server/wellness-widget-builder.ts): a sentence
// becomes a widget description. The model only chooses among what the tab can
// draw; its answer passes the validator or the fixed rules answer instead.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const create = vi.fn();
vi.mock("../server/anthropic-client", () => ({ getAnthropicClient: () => ({ messages: { create } }) }));

import { buildWellnessWidgetFromPrompt, buildWellnessWidgetsFromPrompt, outlineTrackers } from "../server/wellness-widget-builder";
import { sanitizeWellnessWidget } from "../shared/wellness-widgets";
import { fixtureTrackers } from "./helpers/wellness-fixture";

const reply = (obj: unknown) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] });
const rows = fixtureTrackers();
const ctx = { trackers: outlineTrackers(rows), metricIds: ["sleep_hours", "weight"], rows };

beforeEach(() => { create.mockReset(); process.env.ANTHROPIC_API_KEY = "test-key"; });
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("with a model", () => {
  it("takes the model's choice when it is a widget the tab can draw", async () => {
    create.mockResolvedValue(reply({
      kind: "compare", title: "Exercise After Sleep", icon: "chart",
      source: { kind: "metric", key: "sleep_hours" }, other: { kind: "workouts" }, threshold: 8, lag: 0,
    }));
    const r = await buildWellnessWidgetFromPrompt("do I exercise more after sleeping eight hours", ctx);
    expect(r.by).toBe("ai");
    expect(r.widget).toMatchObject({ kind: "compare", title: "Exercise After Sleep", source: { kind: "metric", key: "sleep_hours" }, other: { kind: "workouts" }, threshold: 8, by: "ai" });
    expect(sanitizeWellnessWidget(r.widget)).toEqual(r.widget);
  });

  it("is told what the user actually tracks — names, fields, units, entry counts — and never a reading", async () => {
    // Values nothing else in the prompt could contain.
    const secret = [{ id: "s1", name: "Glucose log", category: "health", fields: [{ name: "reading", type: "number", unit: "mg/dL" }], linkedProfiles: [],
      entries: [{ id: "a", timestamp: "2026-11-20T08:00:00Z", values: { reading: 7731.25, notes: "felt dizzy after lunch" }, notes: "private remark 9917", computed: {} }] }];
    create.mockResolvedValue(reply({ widgets: [{ kind: "metric", title: "Sleep Average", source: { kind: "metric", key: "sleep_hours" }, calc: "average", display: "line" }] }));
    await buildWellnessWidgetsFromPrompt("my sleep average", { trackers: outlineTrackers([...rows, ...secret]), metricIds: ["sleep_hours"], rows: [...rows, ...secret] });
    const sent = JSON.stringify(create.mock.calls[0][0]);
    expect(sent).toContain("Guitar practice");
    expect(sent).toContain("minutes (min)");       // a field and its unit
    expect(sent).toContain("Glucose log");
    expect(sent).toContain("reading (mg/dL)");
    expect(sent).toMatch(/\\"Running\\" \[workout\]: 6 entries/);
    expect(sent).not.toContain("7731");
    expect(sent).not.toContain("dizzy");
    expect(sent).not.toContain("9917");
    expect(sent).not.toContain("2026-11-20");
    // The outline type has no place for a value.
    expect(Object.keys(outlineTrackers(secret)[0]).sort()).toEqual(["entries", "fields", "name", "workout"]);
  });

  it("one description can ask for several cards; each is validated and grounded on its own", async () => {
    create.mockResolvedValue(reply({
      name: "Running & Sleep",
      widgets: [
        { kind: "metric", title: "Running Distance", icon: "dumbbell", source: { kind: "tracker", key: "running", field: "Distance" }, calc: "total", display: "bar" },
        { kind: "metric", title: "Weekly Sleep", source: { kind: "metric", key: "sleep_hours" }, calc: "average", display: "number", range: "7d" },
        { kind: "metric", title: "Cycling Distance", source: { kind: "tracker", key: "Cycling" }, calc: "total", display: "bar" },   // no such tracker
        { kind: "metric", title: "Everything", source: { kind: "sql", key: "select 1" } },                                          // not drawable
        { kind: "compare", title: "Exercise After Sleep", source: { kind: "metric", key: "sleep_hours" }, other: { kind: "workouts" }, threshold: 8 },
      ],
    }));
    const r = await buildWellnessWidgetsFromPrompt("running distance, weekly sleep, cycling distance, and exercise after 8 hours of sleep", ctx);
    expect(r.by).toBe("ai");
    expect(r.name).toBe("Running & Sleep");
    expect(r.widgets.map((w) => w.title)).toEqual(["Running Distance", "Weekly Sleep", "Exercise After Sleep"]);
    // Grounded: the tracker's real name and its real field are written back.
    expect(r.widgets[0].source).toEqual({ kind: "tracker", key: "Running", field: "distance" });
    expect(r.widgets.map((w) => w.id)).toEqual(["widget-1", "widget-2", "widget-3"]);
    expect(r.widget).toBe(r.widgets[0]);
  });

  it("a tracker that is itself a health measurement is read as that measurement", async () => {
    create.mockResolvedValue(reply({ widgets: [{ kind: "metric", title: "Weight Log", source: { kind: "tracker", key: "Weight" }, calc: "latest", display: "line" }] }));
    const r = await buildWellnessWidgetsFromPrompt("my weight", ctx);
    expect(r.widgets[0].source).toEqual({ kind: "metric", key: "weight" });
  });

  it("an answer that is not a drawable widget is refused; the fixed rules answer", async () => {
    for (const bad of [
      { kind: "metric", title: "Everything", source: { kind: "sql", key: "select * from tracker_entries" } },
      { kind: "metric", title: "Raw", source: { kind: "metric", key: "made_up_metric" } },
      "Sure! Here is some <script>alert(1)</script>",
      { title: "No source at all" },
    ]) {
      create.mockResolvedValue(reply(bad));
      const r = await buildWellnessWidgetFromPrompt("my weekly sleep average", ctx);
      expect(r.by, JSON.stringify(bad)).toBe("rules");
      expect(r.widget).toMatchObject({ kind: "metric", source: { kind: "metric", key: "sleep_hours" }, range: "7d" });
    }
  });

  it("strips anything extra the model added to a valid answer", async () => {
    create.mockResolvedValue(reply({
      kind: "metric", title: "Weight", source: { kind: "metric", key: "weight", where: "1=1" }, calc: "latest", display: "number",
      sql: "drop table", html: "<b>hi</b>", id: "../../etc",
    }));
    const { widget } = await buildWellnessWidgetFromPrompt("my weight", ctx, "w9");
    expect(widget.id).toBe("w9");
    expect(JSON.stringify(widget)).not.toMatch(/drop table|<b>|1=1|etc/);
  });

  it("a model that fails or hangs does not fail the request", async () => {
    create.mockRejectedValue(new Error("overloaded"));
    const r = await buildWellnessWidgetFromPrompt("how often I run", ctx);
    expect(r.by).toBe("rules");
    expect(r.widget.kind).toBe("metric");
  });
});

describe("without a model", () => {
  it("answers by fixed rules and never calls out", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await buildWellnessWidgetFromPrompt("how often I practice guitar", ctx);
    expect(create).not.toHaveBeenCalled();
    expect(r).toMatchObject({ by: "rules", widget: { source: { kind: "tracker", key: "Guitar practice" }, calc: "count" } });
  });

  it("a tracker's number is read off its field: \"running distance\" totals the distance", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await buildWellnessWidgetsFromPrompt("my running distance and my average headache severity", ctx);
    expect(r.widgets.map((w) => [w.title, w.source, w.calc])).toEqual([
      ["Running Distance", { kind: "tracker", key: "Running", field: "distance" }, "total"],
      ["Headache Severity", { kind: "tracker", key: "Headache", field: "severity" }, "average"],
    ]);
  });

  it("reads several cards out of one description", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await buildWellnessWidgetsFromPrompt("my weekly sleep average, weight trend, and whether I exercise more after sleeping eight hours", ctx);
    expect(r.by).toBe("rules");
    expect(r.widgets.map((w) => [w.kind, w.source])).toEqual([
      ["metric", { kind: "metric", key: "sleep_hours" }],
      ["metric", { kind: "metric", key: "weight" }],
      ["compare", { kind: "metric", key: "sleep_hours" }],
    ]);
    expect(r.widgets[0].range).toBe("7d");
    expect(r.widgets[2]).toMatchObject({ other: { kind: "workouts" }, threshold: 8 });
  });
});

describe("the route", () => {
  const routes = readFileSync("server/routes.ts", "utf8");
  const at = routes.indexOf('app.get("/api/wellness-widgets/suggest"');
  const body = routes.slice(at, routes.indexOf("// ---- Onboarding Status ----", at));

  it("is a GET that writes nothing", () => {
    expect(at).toBeGreaterThan(0);
    expect(body).not.toMatch(/storage\.(set|create|update|delete|upsert|save)\w*\(/);
  });
  it("outlines the trackers for the model and keeps the rows on the server for grounding", () => {
    expect(body).toMatch(/trackers: outlineTrackers\(/);
    expect(body).toMatch(/metricIds/);
    expect(body).toMatch(/rows:/);
  });

});
