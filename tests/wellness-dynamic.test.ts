import { describe, it, expect } from "vitest";
import { buildWellnessCards, groupWellnessCards } from "../client/src/lib/wellness-dynamic";

// The dynamic wellness builder must reflect the user's REAL data: a card per
// tracker with entries (any metric, incl. custom ones), nothing for empties,
// with correct latest value / trend / favorable direction.
const tracker = (over: any) => ({
  id: over.id, name: over.name, category: over.category ?? "custom",
  unit: over.unit ?? null, fields: over.fields ?? [{ name: "value", type: "number", isPrimary: true }],
  entries: over.entries ?? [], linkedProfiles: [],
});

const entry = (value: any, daysAgo = 0, field = "value") => ({
  values: { [field]: value }, timestamp: new Date(Date.now() - daysAgo * 86400000).toISOString(),
});

describe("buildWellnessCards", () => {
  it("makes ONE card per tracker that has entries, and none for empty trackers", () => {
    const cards = buildWellnessCards([
      tracker({ id: "w", name: "Weight", category: "health", unit: "lbs", entries: [entry(178, 0), entry(180, 3)] }),
      tracker({ id: "empty", name: "Steps", category: "fitness", entries: [] }),
    ] as any);
    expect(cards.map((c) => c.id)).toEqual(["w"]);
    expect(cards[0].value).toBe(178);
    expect(cards[0].unit).toBe("lbs");
  });

  it("computes trend + favorable direction (lower weight is good)", () => {
    const [c] = buildWellnessCards([
      tracker({ id: "w", name: "Weight", category: "health", entries: [entry(178, 0), entry(180, 2)] }),
    ] as any);
    expect(c.direction).toBe("down");
    expect(c.favorable).toBe("good"); // weight down = good
  });

  it("higher sleep is good", () => {
    const [c] = buildWellnessCards([
      tracker({ id: "s", name: "Sleep", category: "health", entries: [entry(8, 0), entry(6, 1)] }),
    ] as any);
    expect(c.direction).toBe("up");
    expect(c.favorable).toBe("good");
  });

  it("handles Blood Pressure as a dual reading", () => {
    const [c] = buildWellnessCards([
      tracker({ id: "bp", name: "Blood Pressure", category: "health",
        fields: [{ name: "systolic", type: "number", isPrimary: true }, { name: "diastolic", type: "number" }],
        entries: [
          { values: { systolic: 118, diastolic: 76 }, timestamp: new Date().toISOString() },
          { values: { systolic: 122, diastolic: 80 }, timestamp: new Date(Date.now() - 86400000).toISOString() },
        ] }),
    ] as any);
    expect(c.pair).toEqual({ systolic: 118, diastolic: 76 });
    expect(c.favorable).toBe("good"); // systolic down = good
  });

  it("still surfaces a NON-numeric custom tracker as a recent-log count", () => {
    const [c] = buildWellnessCards([
      tracker({ id: "g", name: "Guitar", category: "lifestyle",
        fields: [{ name: "practiced", type: "boolean" }],
        entries: [entry(true, 0, "practiced"), entry(true, 2, "practiced")] }),
    ] as any);
    expect(c.isCount).toBe(true);
    expect(c.value).toBe(2); // 2 logs in the last 14 days
    expect(c.name).toBe("Guitar");
  });

  it("groups cards and returns only non-empty groups, most-recent first", () => {
    const cards = buildWellnessCards([
      tracker({ id: "a", name: "Weight", category: "health", entries: [entry(178, 5)] }),
      tracker({ id: "b", name: "Running", category: "fitness", unit: "mi", entries: [entry(3, 0)] }),
    ] as any);
    // Running logged today → sorts before Weight (5 days ago)
    expect(cards[0].id).toBe("b");
    const groups = groupWellnessCards(cards);
    expect(groups.map((g) => g.group)).toEqual(["Fitness", "Health"]);
  });
});
