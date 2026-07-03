import { describe, it, expect } from "vitest";
import { parseChartSpec } from "../client/src/lib/artifact-chart";

// PERF-AUDIT regression: a "Weight Trend" note stored its chart spec as raw JSON
// in `content` and rendered as literal JSON text. parseChartSpec is what lets
// the renderer detect the spec and draw a chart instead.

describe("parseChartSpec", () => {
  it("detects a line chart spec with a data array (the Weight Trend case)", () => {
    const content = JSON.stringify({
      type: "line",
      title: "Weight Trend",
      data: [{ name: "Mon", weight: 180 }, { name: "Tue", weight: 179 }],
    });
    const spec = parseChartSpec(content);
    expect(spec).not.toBeNull();
    expect(spec!.type).toBe("line");
    expect(spec!.data).toHaveLength(2);
  });

  it("detects a spec that uses `series` instead of `data`", () => {
    const spec = parseChartSpec(JSON.stringify({ type: "bar", series: [{ key: "a" }], data: [] }));
    expect(spec).not.toBeNull();
    expect(spec!.type).toBe("bar");
  });

  it.each(["bar", "line", "area", "pie"])("accepts chart type %s", (type) => {
    expect(parseChartSpec(JSON.stringify({ type, data: [] }))).not.toBeNull();
  });

  it("returns null for JSON that is not a chart spec (unknown type)", () => {
    expect(parseChartSpec(JSON.stringify({ type: "scatter", data: [] }))).toBeNull();
    expect(parseChartSpec(JSON.stringify({ title: "no type", data: [] }))).toBeNull();
  });

  it("returns null when the chart type has no data or series", () => {
    expect(parseChartSpec(JSON.stringify({ type: "line" }))).toBeNull();
    expect(parseChartSpec(JSON.stringify({ type: "line", data: "not-an-array" }))).toBeNull();
  });

  it("returns null for a JSON array (not an object spec)", () => {
    expect(parseChartSpec(JSON.stringify([{ type: "line" }]))).toBeNull();
  });

  it("returns null for plain text and empty/nullish content", () => {
    expect(parseChartSpec("just a normal note")).toBeNull();
    expect(parseChartSpec("")).toBeNull();
    expect(parseChartSpec(null)).toBeNull();
    expect(parseChartSpec(undefined)).toBeNull();
  });
});
