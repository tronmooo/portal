// @vitest-environment jsdom
//
// The tracker detail popup's tabs, rendered for every kind of tracker. Pins
// the owner's 2026-10-20 screenshots of the Nutrition tracker: Trends charted
// "Quantity 2.0 – 2.0 across 1 readings · stable", Breakdown averaged macros
// per ENTRY, and Correlations showed a giant empty "Not enough matching data
// points" for Quantity vs Calories.
import React from "react";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import type { Tracker } from "../shared/schema";
import {
  buildTrackerModel, OverviewTab, TrendsTab, BreakdownTab, CorrelationsTab, InsightsTab,
} from "../client/src/components/tracker-detail";

beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any;
});
afterEach(cleanup);

const NOW = new Date("2026-10-20T18:00:00Z");
const TZ = "UTC";
let n = 0;
const day = (ago: number, hour = 12) => new Date(NOW.getTime() - ago * 86400000 + (hour - 18) * 3600000).toISOString();
const E = (ago: number, values: Record<string, unknown>, hour = 12) => ({ id: `e${++n}`, values, computed: {}, timestamp: day(ago, hour) });
const T = (over: Partial<Tracker>): Tracker => ({
  id: `t${++n}`, name: "T", category: "custom", unit: "", fields: [], entries: [], linkedProfiles: [], createdAt: day(200),
  ...over,
} as any);

// The screenshot tracker: quantity marked primary, one entry with no calories.
const nutrition = T({
  name: "Nutrition", category: "nutrition",
  fields: [
    { name: "quantity", type: "number", isPrimary: true }, { name: "calories", type: "number" },
    { name: "protein", type: "number" }, { name: "carbs", type: "number" }, { name: "fat", type: "number" }, { name: "meal", type: "text" },
  ] as any,
  entries: [
    E(80, { quantity: 2, meal: "Eggs" }),
    E(72, { quantity: 1, calories: 1200, protein: 60, carbs: 100, fat: 50, meal: "Lunch" }, 12),
    E(72, { quantity: 1, calories: 1000, protein: 40, carbs: 120, fat: 30, meal: "Dinner" }, 17),
    E(57, { quantity: 1, calories: 400, protein: 20, carbs: 40, fat: 15, meal: "Pasta" }),
  ] as any,
});

const weight = T({ name: "Weight", category: "health", unit: "lbs", fields: [{ name: "weight", type: "number", isPrimary: true }] as any,
  entries: Array.from({ length: 12 }, (_, i) => E(24 - i * 2, { weight: 190 - i * 0.5 }, 7)) as any });
const sleep = T({ name: "Sleep", category: "sleep", unit: "hours", fields: [{ name: "hours", type: "number", isPrimary: true }, { name: "quality", type: "text" }] as any,
  entries: Array.from({ length: 10 }, (_, i) => E(i, { hours: 6 + (i % 4) * 0.7, quality: i % 2 ? "Good" : "Fair" }, 7)) as any });
const bp = T({ name: "Blood Pressure", category: "health", unit: "mmHg", fields: [{ name: "systolic", type: "number", isPrimary: true }, { name: "diastolic", type: "number" }] as any,
  entries: Array.from({ length: 8 }, (_, i) => E(i * 2, { systolic: 118 + i, diastolic: 76 + (i % 3) }, 8)) as any });
const spending = T({ name: "Spending", category: "finance", unit: "$", fields: [{ name: "amount", type: "number", isPrimary: true, unit: "$" }, { name: "category", type: "text" }] as any,
  entries: Array.from({ length: 9 }, (_, i) => E(i, { amount: 10 + i * 3.25, category: ["Food", "Gas", "Fun"][i % 3] })) as any });
const journal = T({ name: "Gratitude journal", category: "habit", fields: [{ name: "entry", type: "text" }] as any,
  entries: Array.from({ length: 4 }, (_, i) => E(i, { entry: "thanks" })) as any });

const goals: any[] = [];
const qc = new QueryClient();
const wrap = (el: React.ReactElement) => render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
const model = (t: Tracker) => buildTrackerModel(t, goals, NOW, TZ);

describe("Nutrition — the screenshot bugs", () => {
  it("charts calories, never the serving count", () => {
    const m = model(nutrition);
    expect(m.field).toBe("calories");
    wrap(<TrendsTab model={m} />);
    const chips = screen.getByTestId("td-metric-chips");
    expect(within(chips).queryByText("Quantity")).toBeNull();
    expect(within(chips).getByText("Calories")).toBeTruthy();
  });

  it("says a trend needs more days instead of calling one reading 'stable'", () => {
    wrap(<TrendsTab model={model(nutrition)} />);
    // range defaults to 30 days; nothing logged in it
    expect(screen.getByTestId("td-verdict").textContent).toMatch(/Not enough days for a trend yet/);
    expect(screen.queryByText(/stable/i)).toBeNull();
  });

  it("labels macro tiles per LOGGED DAY and flags the entry with no calories", () => {
    wrap(<BreakdownTab model={model(nutrition)} />);
    // last entry is 57 days old → breakdown opens on All time
    const tiles = screen.getByTestId("td-nutrition-tiles");
    expect(tiles.textContent).toMatch(/per logged day · all time/);
    // 3 logged days: protein (60+40+20)/3 = 40 g — per entry it would have read 30 g
    expect(tiles.textContent).toMatch(/40 g/);
    expect(screen.getByText(/1 of 4 entries in the all time have no calories/)).toBeTruthy();
  });

  it("shows a compact explanation, not an empty chart, when there is nothing to correlate", () => {
    wrap(<CorrelationsTab model={model(nutrition)} allTrackers={[nutrition]} />);
    expect(screen.getByTestId("td-empty").textContent).toMatch(/No relationships to show yet/);
    expect(screen.queryByText(/Not enough matching data points/)).toBeNull();
    expect(screen.queryByTestId("td-scatter")).toBeNull();
  });
});

describe("every tab renders for every kind of tracker", () => {
  const all = [nutrition, weight, sleep, bp, spending, journal];
  for (const t of all) {
    it(`${t.name}`, () => {
      const m = model(t);
      for (const Tab of [OverviewTab, TrendsTab, BreakdownTab, InsightsTab] as any[]) {
        const { unmount } = wrap(<Tab model={m} onNavigate={() => {}} />);
        unmount();
      }
      const { unmount } = wrap(<CorrelationsTab model={m} allTrackers={all} />);
      unmount();
    });
  }

  it("gives each kind its own identity", () => {
    expect([nutrition, weight, sleep, bp, spending, journal].map((t) => model(t).theme.identity))
      .toEqual(["nutrition", "body", "sleep", "heart", "finance", "habit"]);
  });

  it("Weight overview leads with the latest reading and its 30-day change", () => {
    wrap(<OverviewTab model={model(weight)} onNavigate={() => {}} />);
    expect(screen.getByTestId("td-hero-value").textContent).toBe("184.5");
    expect(screen.getByTestId("td-hero").textContent).toMatch(/in 30 days/);
  });

  it("Spending money goes through the shared money format", () => {
    wrap(<OverviewTab model={model(spending)} onNavigate={() => {}} />);
    expect(screen.getByTestId("td-hero-value").textContent).toBe("$10");
    expect(screen.getAllByText("$138.25").length).toBeGreaterThan(0); // this-week total, cents kept
  });

  it("Blood pressure shows the paired reading, not one number", () => {
    wrap(<OverviewTab model={model(bp)} onNavigate={() => {}} />);
    expect(screen.getByTestId("td-hero-value").textContent).toBe("118/76");
  });

  it("a tracker with no numbers still gets consistency, not a broken chart", () => {
    wrap(<OverviewTab model={model(journal)} onNavigate={() => {}} />);
    expect(screen.getByTestId("td-consistency")).toBeTruthy();
    expect(screen.queryByTestId("td-trend-chart")).toBeNull();
  });
});
