// @vitest-environment jsdom
//
// The redesigned Wellness tab, rendered as the real page over a stubbed API
// (owner's design, 2026-11-23): a customizable dashboard of cards over a time
// range. What it proves:
//   * the default dashboard is the ten standard sections, on a 30-day range;
//   * the figures on screen are the period's (shared/wellness-cards);
//   * a range is a view: it changes the cards and writes nothing;
//   * nothing hidden reads as missing — switched-off cards are named and open
//     in place, a section with nothing recorded folds into a named row;
//   * a failed request is an error with a retry, never an empty tab (Rule 7);
//   * opening the tab writes nothing (Rule 3); a dashboard chip switches, and saves that.
process.env.TZ = "UTC";
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import {
  addWellnessDashboard, addWellnessWidget, defaultWellnessBoards, parseWellnessBoards, serializeWellnessBoards,
} from "../shared/wellness-dashboards";
import { WELLNESS_WIDGET_IDEAS } from "../shared/wellness-widgets";
import { NOW, daysAgo, entry, fixtureTrackers, tracker } from "./helpers/wellness-fixture";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}) }) }));

let stored: string | null;
let writes: string[];
let fail: Set<string>;
let trackers: any[];
let journal: any[];
let calls: string[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  stored = null; writes = []; fail = new Set(); calls = [];
  trackers = fixtureTrackers();
  journal = [{ id: "j1", date: daysAgo(1), mood: "great", content: "", tags: [], linkedProfiles: [] }, { id: "j2", date: daysAgo(2), mood: "good", content: "", tags: [], linkedProfiles: [] }];
  vi.stubGlobal("fetch", vi.fn(async (url: any, opts?: any) => {
    const u = String(url); const method = String(opts?.method || "GET");
    const json = (b: any, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    calls.push(`${method} ${u}`);
    for (const f of fail) if (u.includes(f)) return json({ error: "boom" }, 500);
    if (u.includes("/api/preferences/wellness_card_prefs")) {
      if (method === "PUT") { stored = JSON.parse(opts.body).value; writes.push(stored!); return json({ success: true }); }
      return json({ value: stored });
    }
    if (method !== "GET") { writes.push(`${method} ${u}`); return json({}); }
    if (u.includes("/api/trackers")) return json(trackers);
    if (u.includes("/api/profiles")) return json([{ id: "me", type: "self", name: "Me", fields: {} }]);
    if (u.includes("/api/journal")) return json(journal);
    if (u.includes("/api/expenses")) return json([{ id: "x1", amount: 40, category: "pharmacy", description: "Refill", date: daysAgo(3), tags: [], linkedProfiles: [] }]);
    return json([]);
  }));
});
// The picked range lives in the URL: each test starts from a clean address.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); window.history.replaceState(null, "", "/"); });

async function openTab() {
  const { default: WellnessPage } = await import("../client/src/pages/wellness");
  const { queryClient } = await import("../client/src/lib/queryClient");
  queryClient.clear();
  render(
    <QueryClientProvider client={queryClient}>
      <Router hook={() => ["/wellness", () => {}] as any}><WellnessPage /></Router>
    </QueryClientProvider>,
  );
}
const cards = () => Array.from(screen.getByTestId("wellness-grid").querySelectorAll("[data-card]")).map((n) => n.getAttribute("data-card"));
const text = (id: string) => screen.getByTestId(id).textContent || "";

describe("the default dashboard", () => {
  it("shows the standard sections on a 30-day range, with the period's figures", async () => {
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    expect(screen.getByTestId("wellness-dashboard").getAttribute("data-range")).toBe("30d");
    expect(screen.getByTestId("wellness-range-30d").getAttribute("aria-selected")).toBe("true");
    // Labs and Medications have nothing recorded: they fold into the quiet row, named.
    expect(cards()).toEqual(["overview", "trends", "activity", "sleep", "nutrition", "body", "sources", "insights"]);
    expect(text("wellness-quiet-cards")).toContain("Labs");
    expect(text("wellness-quiet-cards")).toContain("Medications & Care");

    expect(text("wellness-tile-sleep-value")).toBe("7.8 hrs avg");
    expect(text("wellness-tile-sleep-delta")).toBe("+19% vs prior 30d");
    expect(text("wellness-tile-activity-value")).toBe("5 sessions");
    expect(text("wellness-tile-weight-value")).toBe("204 lbs");
    expect(text("wellness-tile-weight-delta")).toBe("−9 lbs (4.2%)");
    expect(text("wellness-tile-nutrition-value")).toBe("750 kcal avg");
    // A reading older than the range is shown with its date, not dropped.
    expect(text("wellness-tile-bp-value")).toBe("139 / 80");
    expect(text("wellness-tile-bp-last")).toBe("Last: Oct 21");
    // Never recorded: named as not tracked, with no zero invented for it.
    expect(text("wellness-overview-untracked")).toBe("Not tracked yet: Hydration.");
    expect(screen.queryByTestId("wellness-tile-hydration")).toBeNull();

    expect(text("wellness-trend-weight")).toContain("213 → 204 lbs");
    expect(text("wellness-activity-sessions")).toContain("5");
    expect(text("wellness-activity-time")).toContain("1h 40m");
    expect(text("wellness-activity-distance")).toContain("10 mi");
    expect(text("wellness-card-insights")).toContain("Weight is down 9 lbs (4.2%) over 30 days.");
    expect(text("wellness-card-insights")).toContain("Not medical advice.");
  });

  it("opening the tab writes nothing", async () => {
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    expect(writes).toEqual([]);
    expect(calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  });
});

describe("the time range is a view", () => {
  it("changes what the cards describe and is not saved", async () => {
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    fireEvent.click(screen.getByTestId("wellness-range-7d"));
    expect(screen.getByTestId("wellness-dashboard").getAttribute("data-range")).toBe("7d");
    // Seven nights: 8.5, 7, 8.5, 7, 8.5, 7, 8.5 → 7.9; one weigh-in in the week is not a change.
    expect(text("wellness-tile-sleep-value")).toBe("7.9 hrs avg");
    expect(screen.queryByTestId("wellness-tile-weight-delta")).toBeNull();
    expect(text("wellness-tile-weight-value")).toBe("204 lbs");
    expect(text("wellness-activity-sessions")).toContain("4");
    fireEvent.click(screen.getByTestId("wellness-range-all"));
    expect(text("wellness-trend-weight")).toContain("215 → 204 lbs");
    expect(writes).toEqual([]);
  });

  it("opens on the range saved in the display options", async () => {
    stored = serializeWellnessBoards({ ...defaultWellnessBoards(), options: { ...defaultWellnessBoards().options, range: "90d", comparison: false } });
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    expect(screen.getByTestId("wellness-dashboard").getAttribute("data-range")).toBe("90d");
    // "Show Comparison Change (%)" is off.
    expect(screen.queryByTestId("wellness-tile-sleep-delta")).toBeNull();
  });
});

describe("nothing hidden reads as missing", () => {
  it("names the sections that are switched off, and opens one in place", async () => {
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    const off = within(screen.getByTestId("wellness-hidden-cards")).getAllByRole("button").map((b) => b.textContent);
    expect(off).toEqual(["Mood & Energy", "Symptoms & Notes", "Vitals Graphs (Advanced)", "Health Goals", "Wellness Score"]);
    expect(calls.some((c) => c.includes("/api/journal"))).toBe(false); // not fetched until wanted
    fireEvent.click(screen.getByTestId("wellness-hidden-mood"));
    await screen.findByTestId("wellness-mood-average");
    expect(text("wellness-mood-average")).toBe("Great");
    expect(cards()).toContain("mood");
    fireEvent.click(screen.getByTestId("wellness-hidden-symptoms"));
    expect(text("wellness-symptom-t-head")).toContain("Headache");
    expect(writes).toEqual([]); // looking is not saving
  });

  it("a section with nothing recorded opens from the quiet row and says how to fill it", async () => {
    await openTab();
    await screen.findByTestId("wellness-quiet-labs");
    fireEvent.click(screen.getByTestId("wellness-quiet-labs"));
    expect(text("wellness-card-labs")).toContain("No lab values yet");
  });

  it("a dashboard with every section off says so, and that nothing was deleted", async () => {
    stored = serializeWellnessBoards(addWellnessDashboard(defaultWellnessBoards(), "Mine", "blank"));
    await openTab();
    await screen.findByTestId("wellness-empty-dashboard");
    expect(text("wellness-empty-dashboard")).toContain("Mine has no sections yet");
    expect(text("wellness-empty-dashboard")).toContain("Nothing is deleted");
    expect(within(screen.getByTestId("wellness-hidden-cards")).getAllByRole("button").length).toBe(15);
  });
});

describe("a failed request is not an empty account", () => {
  it("the tracker list failing is an error with a retry, and no card claims nothing was recorded", async () => {
    fail.add("/api/trackers");
    await openTab();
    await screen.findByTestId("wellness-load-error", {}, { timeout: 8000 });
    expect(screen.queryByTestId("wellness-grid")).toBeNull();
    expect(screen.queryByTestId("wellness-quiet-cards")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Nothing recorded|Not tracked yet/);
    fail.clear();
    fireEvent.click(within(screen.getByTestId("wellness-load-error")).getByRole("button", { name: "Retry" }));
    await screen.findByTestId("wellness-tile-sleep-value");
  }, 15000);

  it("a card whose own list failed says so and offers the retry", async () => {
    const withSpend = addWellnessWidget(defaultWellnessBoards(), WELLNESS_WIDGET_IDEAS.find((i) => i.key === "spending")!.widget);
    stored = serializeWellnessBoards(withSpend.boards);
    fail.add("/api/expenses");
    await openTab();
    await screen.findByTestId("wellness-widget-error-health-spending", {}, { timeout: 8000 });
    expect(screen.queryByTestId("wellness-widget-empty-health-spending")).toBeNull();
    fail.clear();
    fireEvent.click(within(screen.getByTestId("wellness-widget-error-health-spending")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(text("wellness-widget-value-health-spending")).toBe("$40"));
  }, 15000);
});

describe("cards the user built and several dashboards", () => {
  it("a custom card is drawn from the records and shows its working", async () => {
    let b = addWellnessWidget(defaultWellnessBoards(), WELLNESS_WIDGET_IDEAS.find((i) => i.key === "consistency")!.widget).boards;
    b = addWellnessWidget(b, { ...WELLNESS_WIDGET_IDEAS.find((i) => i.key === "sleep-exercise")!.widget, threshold: 8 }).boards;
    stored = serializeWellnessBoards(b);
    await openTab();
    await screen.findByTestId("wellness-widget-value-exercise-consistency");
    expect(text("wellness-widget-value-exercise-consistency")).toBe("5 entries");
    expect(text("wellness-widget-row-sleep-vs-exercise-hi")).toContain("Sleep 8 h or more");
    expect(text("wellness-widget-row-sleep-vs-exercise-hi")).toContain("1 session");
    expect(text("wellness-widget-caveat-sleep-vs-exercise")).toBe("A pattern in your own records, not a medical conclusion.");
    expect(text("wellness-widget-working-exercise-consistency")).toContain("Sources: Workout sessions.");
  });

  it("a dashboard chip switches the dashboard and saves that choice", async () => {
    let b = addWellnessDashboard(defaultWellnessBoards(), "Fitness", "fitness");
    b = { ...b, active: "overview" };
    stored = serializeWellnessBoards(b);
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    expect(within(screen.getByTestId("wellness-boards")).getAllByRole("button").map((x) => x.textContent).slice(0, 2)).toEqual(["Overview", "Fitness"]);
    expect(screen.getByTestId("wellness-board-fitness").getAttribute("title")).toBe("Show the Fitness dashboard");
    fireEvent.click(screen.getByTestId("wellness-board-fitness"));
    await waitFor(() => expect(screen.getByTestId("wellness-dashboard").getAttribute("data-dashboard")).toBe("fitness"));
    expect(cards().slice(0, 3)).toEqual(["activity", "sleep", "trends"]);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(parseWellnessBoards(stored).active).toBe("fitness");
  });

  it("a half-width card with nobody beside it takes the row on a phone", async () => {
    const b = defaultWellnessBoards();
    b.dashboards[0].sizes = { trends: "medium", activity: "medium", sleep: "medium" };
    stored = serializeWellnessBoards(b);
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    const cls = (id: string) => screen.getByTestId("wellness-grid").querySelector(`[data-card="${id}"]`)!.className;
    expect(cls("trends")).toContain("col-span-1");
    expect(cls("activity")).toContain("col-span-1");
    expect(cls("sleep")).toContain("col-span-2 sm:col-span-1"); // lonely: nutrition after it is full width
    expect(cls("overview")).toMatch(/(^| )col-span-2( |$)/);
  });
});

// QA 2026-11-24 (live demo account): a 140-mile DRIVE counted as a workout and
// as workout distance; Health Trends compared it with a 1.5-mile run
// ("139-mile decline") and opened the Running tracker, where the 140 was not.
describe("a drive is travel, not exercise; a trend is one tracker", () => {
  it("leaves a drive out of the Activity Summary and Health Trends", async () => {
    trackers = [...fixtureTrackers(), tracker("t-drive", "Drive", "travel", [{ name: "miles", unit: "mi" }], [
      entry(daysAgo(3), { miles: 140 }), entry(daysAgo(12), { miles: 60 }),
    ])];
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    expect(text("wellness-activity-sessions")).toContain("5");
    expect(text("wellness-activity-distance")).toContain("10 mi");
    expect(text("wellness-activity-distance")).not.toContain("210");
    expect(text("wellness-tile-activity-value")).toBe("5 sessions");
    const trends = text("wellness-card-trends");
    expect(trends).not.toMatch(/140|60 mi|Drive/);
    // The distance trend is the run's, and opens the run's tracker.
    const row = screen.getByTestId("wellness-trend-distance");
    expect(row.textContent).toContain("2 → 2 mi");
    expect(row.getAttribute("href")).toContain("t-run");
  });

  it("never compares two trackers' readings as one trend; each row opens its own tracker", async () => {
    trackers = [...fixtureTrackers(), tracker("t-bike", "Cycling", "fitness", [{ name: "distance", unit: "mi" }], [
      entry(daysAgo(9), { distance: 10 }, { hour: 7 }), entry(daysAgo(1), { distance: 15 }, { hour: 7 }),
    ])];
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    expect(screen.queryByTestId("wellness-trend-distance")).toBeNull();
    const run = screen.getByTestId("wellness-trend-distance:t-run");
    const bike = screen.getByTestId("wellness-trend-distance:t-bike");
    expect(run.textContent).toContain("Distance · Running");
    expect(run.textContent).toContain("2 → 2 mi");
    expect(run.getAttribute("href")).toContain("t-run");
    expect(bike.textContent).toContain("Distance · Cycling");
    expect(bike.textContent).toContain("10 → 15 mi");
    expect(bike.getAttribute("href")).toContain("t-bike");
  });
});

// QA 2026-11-24: 7D, reload, and the tab was back on 30D. The picked range is
// the view's address (H4: not saved; Rule 4: never in browser storage).
describe("the picked range survives a reload through the URL only", () => {
  it("writes the range into the hash, and a fresh mount opens on it, with nothing stored", async () => {
    window.history.replaceState(null, "", "/#/wellness");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    fireEvent.click(screen.getByTestId("wellness-range-7d"));
    expect(window.location.hash).toBe("#/wellness?range=7d");
    expect(setItem.mock.calls.filter(([k]) => /wellness|range/i.test(String(k)))).toEqual([]);
    expect(writes).toEqual([]);
    setItem.mockRestore();

    // "Reload": a new page mount reads the address.
    cleanup();
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    expect(screen.getByTestId("wellness-dashboard").getAttribute("data-range")).toBe("7d");
    expect(screen.getByTestId("wellness-range-7d").getAttribute("aria-selected")).toBe("true");
  });

  it("an unknown range in the URL falls back to the saved default", async () => {
    window.history.replaceState(null, "", "/#/wellness?range=bogus");
    await openTab();
    await screen.findByTestId("wellness-tile-sleep-value");
    expect(screen.getByTestId("wellness-dashboard").getAttribute("data-range")).toBe("30d");
  });
});
