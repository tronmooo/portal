// The Wellness AI Builder (server/wellness-widget-builder.ts): a sentence
// becomes a widget description. The model only chooses among what the tab can
// draw; its answer passes the validator or the fixed rules answer instead.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const create = vi.fn();
vi.mock("../server/anthropic-client", () => ({ getAnthropicClient: () => ({ messages: { create } }) }));

import { buildWellnessWidgetFromPrompt } from "../server/wellness-widget-builder";
import { sanitizeWellnessWidget } from "../shared/wellness-widgets";

const reply = (obj: unknown) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj) }] });
const ctx = { trackerNames: ["Running", "Guitar practice"], metricIds: ["sleep_hours", "weight"] };

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

  it("is told what exists, never a reading", async () => {
    create.mockResolvedValue(reply({ kind: "metric", title: "Sleep Average", source: { kind: "metric", key: "sleep_hours" }, calc: "average", display: "line" }));
    await buildWellnessWidgetFromPrompt("my sleep average", ctx);
    const sent = JSON.stringify(create.mock.calls[0][0]);
    expect(sent).toContain("Guitar practice");
    expect(sent).toContain("sleep_hours");
    // The context type has no field that could carry a value.
    expect(Object.keys(ctx).sort()).toEqual(["metricIds", "trackerNames"]);
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
});

describe("the route", () => {
  const routes = readFileSync("server/routes.ts", "utf8");
  const at = routes.indexOf('app.get("/api/wellness-widgets/suggest"');
  const body = routes.slice(at, routes.indexOf("// ---- Onboarding Status ----", at));

  it("is a GET that writes nothing", () => {
    expect(at).toBeGreaterThan(0);
    expect(body).not.toMatch(/storage\.(set|create|update|delete|upsert|save)\w*\(/);
  });
  it("hands the builder names and metric ids only", () => {
    expect(body).toMatch(/trackerNames:/);
    expect(body).toMatch(/metricIds/);
    expect(body).not.toMatch(/entries|readings|\.values/);
  });
});
