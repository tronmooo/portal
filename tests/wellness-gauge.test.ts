// Reference-range gauge geometry (shared/wellness-gauge.ts). What it proves:
//   * the zones come from the canonical metric's own reference range;
//   * the zone a value lands in always matches the row's flag pill, including
//     a value sitting exactly on a boundary;
//   * a metric with no reference range draws no gauge.
import { describe, it, expect } from "vitest";
import { referenceGauge, gaugeZoneFor } from "../shared/wellness-gauge";
import { CANONICAL_METRICS, flagAgainstReference, getCanonicalMetric } from "../shared/wellness-canon";

describe("referenceGauge", () => {
  it("splits a two-sided range into low · in range · high", () => {
    const g = referenceGauge("glucose", 92)!;
    expect(g).not.toBeNull();
    expect(g.zones.map((z) => z.flag)).toEqual(["low", "normal", "high"]);
    expect(g.zones[1].to).toBe(99);
    expect(g.flag).toBe("normal");
    expect(gaugeZoneFor(g, 92).label).toBe("In range");
    expect(g.min).toBeLessThan(70);
    expect(g.max).toBeGreaterThan(99);
  });

  it("uses the AHA elevated band for systolic pressure", () => {
    const g = referenceGauge("bp_systolic", 125)!;
    expect(g.zones.map((z) => z.flag)).toEqual(["low", "normal", "elevated", "high"]);
    expect(gaugeZoneFor(g, 125).label).toBe("Elevated");
    expect(gaugeZoneFor(referenceGauge("bp_systolic", 130)!, 130).flag).toBe("high");
  });

  it("names the good side the metric's own way", () => {
    const g = referenceGauge("resting_hr", 52)!;
    expect(gaugeZoneFor(g, 52).label).toBe("Athletic");
  });

  it("keeps an out-of-range value on the bar", () => {
    const g = referenceGauge("ldl", 240)!;
    expect(g.max).toBeGreaterThanOrEqual(240);
    expect(gaugeZoneFor(g, 240).flag).toBe("high");
  });

  it("never reaches past the plausible range", () => {
    const g = referenceGauge("spo2", 97)!;
    expect(g.max).toBeLessThanOrEqual(100);
    expect(g.zones.map((z) => z.flag)).toEqual(["low", "normal"]);
  });

  it("draws nothing for a metric without a reference range", () => {
    const noRef = CANONICAL_METRICS.find((m) => !m.ref);
    expect(noRef, "registry should have at least one metric without a range").toBeTruthy();
    expect(referenceGauge(noRef!, 10)).toBeNull();
    expect(referenceGauge("not_a_metric", 10)).toBeNull();
    expect(referenceGauge("ldl", Number.NaN)).toBeNull();
  });

  it("agrees with the flag pill for every metric, at and around every boundary", () => {
    let checked = 0;
    for (const m of CANONICAL_METRICS) {
      if (!m.ref) continue;
      const edges = [m.ref.low, m.ref.high, m.ref.highFrom].filter((x): x is number => x != null);
      const probes = new Set<number>();
      for (const e of edges) for (const d of [-0.5, -0.01, 0, 0.01, 0.5]) probes.add(e + d * Math.max(1, e * 0.1));
      for (const v of probes) {
        if (v < m.plausible[0] || v > m.plausible[1]) continue;
        const g = referenceGauge(m, v);
        expect(g, `${m.id} @ ${v}`).not.toBeNull();
        const flag = flagAgainstReference(getCanonicalMetric(m.id)!, v);
        expect(g!.flag, `${m.id} @ ${v}`).toBe(flag);
        expect(gaugeZoneFor(g!, v).flag, `${m.id} @ ${v} zone`).toBe(flag);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
