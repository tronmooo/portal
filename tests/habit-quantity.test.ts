// Quantitative habits: the day is finished by an AMOUNT, additively.

import { describe, it, expect } from "vitest";
import {
  parseHabitQuantityTarget,
  sumDayQuantity,
  quantityProgress,
} from "@shared/habit-quantity";

const dayOf = (ts: unknown) => String(ts ?? "").slice(0, 10);

describe("parseHabitQuantityTarget", () => {
  it("reads the amount and unit off the habit name", () => {
    expect(parseHabitQuantityTarget("Walk 2 Miles")).toMatchObject({ value: 2, unit: "mi" });
    expect(parseHabitQuantityTarget("Drink 64 oz of water")).toMatchObject({ value: 64, unit: "oz" });
    expect(parseHabitQuantityTarget("Read 20 pages")).toMatchObject({ value: 20, unit: "pages" });
    expect(parseHabitQuantityTarget("Meditate 10 minutes")).toMatchObject({ value: 10, unit: "min" });
    expect(parseHabitQuantityTarget("Walk 10,000 steps")).toMatchObject({ unit: "steps" });
  });

  it("names the tracker fields that carry the measurement", () => {
    expect(parseHabitQuantityTarget("Walk 2 Miles")!.fields).toContain("distance");
    expect(parseHabitQuantityTarget("Drink 64 oz")!.fields).toContain("ounces");
  });

  it("returns null for completion-only habits", () => {
    for (const name of ["Make my bed", "Brush teeth", "Floss", "Take vitamins"]) {
      expect(parseHabitQuantityTarget(name), name).toBeNull();
    }
  });

  it("does not mistake a per-day cadence for an amount", () => {
    // "twice a day" is targetPerDay, and must keep using the count path.
    expect(parseHabitQuantityTarget("Brush teeth 2x a day")).toBeNull();
    expect(parseHabitQuantityTarget("Walk the dog 3 times a day")).toBeNull();
  });

  it("reads the amount even when a cadence is also present", () => {
    expect(parseHabitQuantityTarget("Walk 2 miles 3x a day")).toMatchObject({ value: 2, unit: "mi" });
  });
});

describe("QA req 11 — amounts accumulate through the day", () => {
  const walk = parseHabitQuantityTarget("Walk 2 Miles")!;
  const water = parseHabitQuantityTarget("Drink 64 oz")!;

  it("1.2 + 0.8 completes a 2-mile habit", () => {
    const entries = [
      { timestamp: "2026-08-21T09:00:00Z", values: { distance: 1.2 } },
      { timestamp: "2026-08-21T18:00:00Z", values: { distance: 0.8 } },
    ];
    const total = sumDayQuantity(entries, walk, "2026-08-21", dayOf);
    expect(total).toBe(2);
    expect(quantityProgress(walk, total).isComplete).toBe(true);
  });

  it("32 + 16 + 16 completes a 64 oz habit", () => {
    const entries = [
      { timestamp: "2026-08-21T08:00:00Z", values: { ounces: 32 } },
      { timestamp: "2026-08-21T12:00:00Z", values: { ounces: 16 } },
      { timestamp: "2026-08-21T17:00:00Z", values: { ounces: 16 } },
    ];
    expect(sumDayQuantity(entries, water, "2026-08-21", dayOf)).toBe(64);
  });

  it("preserves the hydration behaviour the report says works (32 + 16 = 48)", () => {
    const entries = [
      { timestamp: "2026-08-21T08:00:00Z", values: { ounces: 32 } },
      { timestamp: "2026-08-21T12:00:00Z", values: { ounces: 16 } },
    ];
    const total = sumDayQuantity(entries, water, "2026-08-21", dayOf);
    expect(total).toBe(48);
    // 48 of 64 is real progress, and honestly incomplete.
    const p = quantityProgress(water, total);
    expect(p.isComplete).toBe(false);
    expect(p.percent).toBe(75);
    expect(p.remaining).toBe(16);
  });

  it("counts only the named day", () => {
    const entries = [
      { timestamp: "2026-08-20T09:00:00Z", values: { distance: 5 } },
      { timestamp: "2026-08-21T09:00:00Z", values: { distance: 1 } },
    ];
    expect(sumDayQuantity(entries, walk, "2026-08-21", dayOf)).toBe(1);
  });
});

describe("QA req 10 — one big activity finishes a smaller target", () => {
  const walk = parseHabitQuantityTarget("Walk 2 Miles")!;

  it("a 2.4-mile walk completes the 2-mile habit", () => {
    const entries = [{ timestamp: "2026-08-21T09:00:00Z", values: { distance: 2.4 } }];
    const total = sumDayQuantity(entries, walk, "2026-08-21", dayOf);
    expect(quantityProgress(walk, total).isComplete).toBe(true);
  });

  it("a 1-mile walk does not", () => {
    const entries = [{ timestamp: "2026-08-21T09:00:00Z", values: { distance: 1 } }];
    const total = sumDayQuantity(entries, walk, "2026-08-21", dayOf);
    expect(quantityProgress(walk, total).isComplete).toBe(false);
  });
});

describe("QA req 12 — one measurement per entry", () => {
  it("an entry stating the same distance twice counts it once", () => {
    const walk = parseHabitQuantityTarget("Walk 2 Miles")!;
    // `distance` and `miles` are two names for one walk.
    const entries = [{ timestamp: "2026-08-21T09:00:00Z", values: { distance: 2.4, miles: 2.4 } }];
    expect(sumDayQuantity(entries, walk, "2026-08-21", dayOf)).toBe(2.4);
  });
});
