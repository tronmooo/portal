import { describe, it, expect } from "vitest";
import { readMetric, readDailyTotal } from "../client/src/lib/wellness-metrics";
import type { Tracker } from "../shared/schema";

// Reported at 00:44 on Sunday Aug 2: "All this stuff in the wellness tab, when
// I press it it says today, even though it was yesterday."
//
// Two things combined to produce it:
//   1. readDailyTotal sums TODAY's entries, and falls back to the most recent
//      reading when there are none — which, minutes after midnight, is always.
//      That fallback is deliberate: a blank hydration tile is worse than a
//      stale one.
//   2. Every card then captioned that number "today" unconditionally, and the
//      Sleep tile said "last night".
//
// So yesterday's 94 oz of water and 7.7 h of sleep were presented as today's.
// The number was never wrong; the label was. These tests pin the day each
// reading belongs to, which is what the captions now read from.

function tracker(partial: Partial<Tracker>): Tracker {
  return {
    id: "t", name: "T", category: "health", unit: "", icon: "",
    fields: [{ name: "value", type: "number" }],
    entries: [], linkedProfiles: [], createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  } as Tracker;
}

/** A timestamp at local noon on the given day — no UTC-boundary ambiguity. */
const at = (day: string, hour = 12) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, hour, 0, 0).toISOString();
};
/** The moment the report came in: 00:44, just past midnight. */
const JUST_AFTER_MIDNIGHT = new Date(2026, 7, 2, 0, 44, 0);

const hydration = (entries: Array<{ day: string; oz: number; hour?: number }>) =>
  tracker({
    name: "Hydration", category: "health", unit: "oz",
    fields: [{ name: "oz", type: "number", unit: "oz", isPrimary: true }],
    entries: entries.map((e, i) => ({
      id: `e${i}`, values: { oz: e.oz }, computed: {}, timestamp: at(e.day, e.hour),
    })) as any,
  });

describe("readDailyTotal — the reading knows which day it is from", () => {
  it("flags yesterday's total as NOT today", () => {
    const m = readDailyTotal([hydration([{ day: "2026-08-01", oz: 94 }])], [/hydration|water/], {
      now: JUST_AFTER_MIDNIGHT,
    });
    // The number still shows — a blank tile helps nobody.
    expect(m.value).toBe(94);
    // …but it is dated, so the caption can say "yesterday".
    expect(m.isToday).toBe(false);
    expect(m.loggedOn).toBe("2026-08-01");
  });

  it("sums and flags today's entries once there are any", () => {
    const m = readDailyTotal(
      [hydration([
        { day: "2026-08-02", oz: 16, hour: 1 },
        { day: "2026-08-02", oz: 24, hour: 2 },
        { day: "2026-08-01", oz: 94 },
      ])],
      [/hydration|water/],
      { now: new Date(2026, 7, 2, 9, 0, 0) },
    );
    expect(m.value).toBe(40);
    expect(m.isToday).toBe(true);
    expect(m.loggedOn).toBe("2026-08-02");
  });

  it("does not count yesterday's entries toward today's total", () => {
    const m = readDailyTotal(
      [hydration([{ day: "2026-08-02", oz: 16, hour: 1 }, { day: "2026-08-01", oz: 94 }])],
      [/hydration|water/],
      { now: new Date(2026, 7, 2, 9, 0, 0) },
    );
    expect(m.value).toBe(16);
  });

  it("dates a reading from further back correctly too", () => {
    const m = readDailyTotal([hydration([{ day: "2026-07-28", oz: 60 }])], [/hydration|water/], {
      now: JUST_AFTER_MIDNIGHT,
    });
    expect(m.isToday).toBe(false);
    expect(m.loggedOn).toBe("2026-07-28");
  });
});

describe("readMetric — the reading knows which day it is from", () => {
  const sleep = (day: string, hours: number) =>
    tracker({
      name: "Sleep", category: "health", unit: "h",
      fields: [{ name: "hours", type: "number", unit: "h", isPrimary: true }],
      entries: [{ id: "s1", values: { hours }, computed: {}, timestamp: at(day, 7) }] as any,
    });

  it("does not claim yesterday's sleep was last night", () => {
    const m = readMetric([sleep("2026-08-01", 7.7)], [/sleep/], { now: JUST_AFTER_MIDNIGHT });
    expect(m.value).toBe(7.7);
    expect(m.isToday).toBe(false);
    expect(m.loggedOn).toBe("2026-08-01");
  });

  it("flags a reading logged today", () => {
    const m = readMetric([sleep("2026-08-02", 8.1)], [/sleep/], {
      now: new Date(2026, 7, 2, 9, 0, 0),
    });
    expect(m.isToday).toBe(true);
    expect(m.loggedOn).toBe("2026-08-02");
  });

  it("dates the newest entry that actually has a number for the field", () => {
    // A later entry with no value for the field must not date the reading —
    // the caption has to describe the number being shown.
    const t = tracker({
      name: "Resting HR", category: "health", unit: "bpm",
      fields: [{ name: "bpm", type: "number", unit: "bpm", isPrimary: true }],
      entries: [
        { id: "a", values: { note: "felt fine" }, computed: {}, timestamp: at("2026-08-02", 8) },
        { id: "b", values: { bpm: 58 }, computed: {}, timestamp: at("2026-08-01", 8) },
      ] as any,
    });
    const m = readMetric([t], [/resting\s*(heart|hr)/], { now: new Date(2026, 7, 2, 9, 0, 0) });
    expect(m.value).toBe(58);
    expect(m.loggedOn).toBe("2026-08-01");
    expect(m.isToday).toBe(false);
  });

  it("reports no day when there is nothing to report", () => {
    const m = readMetric([], [/sleep/], { now: JUST_AFTER_MIDNIGHT });
    expect(m.value).toBeNull();
    expect(m.loggedOn).toBeNull();
    expect(m.isToday).toBe(false);
  });
});
