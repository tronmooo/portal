// @vitest-environment jsdom
//
// Owner report 2026-10-20 (iPhone): the Nutrition card said "0 cal" with
// breakfast logged. One chat message ("Cinnamon Toast Crunch with 2 cups of
// milk … drank a Coke Zero") saved two entries a millisecond apart; the card
// headlined the NEWEST entry — the Coke Zero's 0 — and its sparkline dropped
// to zero. The card now shows the day's total and charts one point per day.
import { describe, it, expect, vi } from "vitest";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}), user: { id: "u1" } }) }));

import { buildTrackerInsight } from "../client/src/pages/trackers";

const now = new Date();
const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
const nutrition: any = {
  id: "t-nut", name: "Nutrition", category: "nutrition", unit: "", linkedProfiles: [], createdAt: at(10 * 86400000),
  fields: [
    { name: "item", type: "text" }, { name: "calories", type: "number", unit: "kcal" },
    { name: "protein", type: "number", unit: "g" },
  ],
  entries: [
    // newest first, as the API returns them
    { id: "coke", timestamp: at(1000), values: { item: "Coke Zero", calories: 0 }, computed: {} },
    { id: "cereal", timestamp: at(1001), values: { item: "Cinnamon Toast Crunch with 2 cups of milk", calories: 364, protein: 17.7 }, computed: {} },
    { id: "yday", timestamp: at(86400000 + 5000), values: { item: "Pasta", calories: 650 }, computed: {} },
  ],
};

describe("Nutrition card headline", () => {
  it("is today's total, not the newest entry's 0", () => {
    const ins = buildTrackerInsight(nutrition, []);
    expect(ins.bigPrimary).toBe("364");
    expect(ins.bigUnit).toBe("cal today");
    expect(ins.insight).toMatch(/364 cal today across 2 entries/);
  });

  it("charts one point per day, so a 0-cal drink can't sink the line", () => {
    const ins = buildTrackerInsight(nutrition, []);
    expect(ins.sparkValues).toEqual([650, 364]);
  });
});
