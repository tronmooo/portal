// @vitest-environment jsdom
//
// The Habits page's summary and per-habit visuals (client/src/lib/habit-visuals.ts
// + client/src/pages/habits.tsx). The numbers are aggregates of
// shared/habit-progress's per-day answer — these tests pin the window rules
// (an open today is not a miss, days before a habit existed are not misses,
// unscheduled days don't count) and that the real page renders them.
import React from "react";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import {
  habitAccent, hexToHueSat, habitCompletion, habitsCompletion, dailyCompletionSeries,
  habitCheckinPoints, habitFirstDay, heatmapStartDay, HABIT_PALETTE,
} from "../client/src/lib/habit-visuals";

vi.mock("../client/src/lib/auth", () => ({ useAuth: () => ({ getAuthHeader: () => ({}) }) }));

beforeAll(() => {
  (globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as any;
});

const TZ = "UTC";
const TODAY = "2026-10-21"; // a Wednesday
let n = 0;
const ci = (date: string, hour = 9) => ({ id: `c${++n}`, date, timestamp: `${date}T${String(hour).padStart(2, "0")}:00:00.000Z` });
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10));
  return out;
};

// "Read": daily, created Oct 1, done every day Oct 12 → today.
const read = {
  id: "h-read", name: "Read", frequency: "daily", targetPerDay: 1, color: "#4F98A3",
  createdAt: "2026-10-01T08:00:00.000Z", currentStreak: 10, longestStreak: 10, linkedProfiles: [],
  checkins: days("2026-10-12", TODAY).map((d) => ci(d)),
};
// "Water": twice a day, created Oct 15; full on 15th and 17th, half on 16th, half today.
const water = {
  id: "h-water", name: "Water", frequency: "daily", targetPerDay: 2, color: "#2E9EBF",
  createdAt: "2026-10-15T08:00:00.000Z", currentStreak: 0, longestStreak: 1, linkedProfiles: [],
  checkins: [ci("2026-10-15", 8), ci("2026-10-15", 18), ci("2026-10-16"), ci("2026-10-17", 8), ci("2026-10-17", 19), ci(TODAY)],
};

describe("habit accent", () => {
  it("keeps a chosen color's hue and gives the default color a fixed palette slot", () => {
    expect(hexToHueSat("#E8545A")).toEqual({ h: 358, s: 76 });
    expect(hexToHueSat("not a color")).toBeNull();
    const chosen = habitAccent({ id: "x", color: "#E8545A" });
    expect(chosen.hs).toBe("358 76%");
    expect(chosen.hs2).toBe("33 76%");
    const def = habitAccent({ id: "abc", color: "#4F98A3" });
    expect(HABIT_PALETTE.map((p) => p[0])).toContain(def.hs);
    // Stable per id — the same habit is the same color on every render/device.
    expect(habitAccent({ id: "abc", color: "#4f98a3" })).toEqual(def);
    // A grey pick isn't a color; it falls back to the palette too.
    expect(HABIT_PALETTE.map((p) => p[0])).toContain(habitAccent({ id: "abc", color: "#888888" }).hs);
  });
});

describe("completion over a window", () => {
  it("counts only days since the habit existed, and today only once it's done", () => {
    expect(habitFirstDay(read as any, TZ)).toBe("2026-10-01");
    // Oct 1 → Oct 21 is 21 scheduled days; today is done, so it counts.
    expect(habitCompletion(read as any, TODAY, 30, TZ)).toEqual({ scheduled: 21, complete: 10, percent: 48 });
    // Water: today is half done → left out, not a miss. Oct 15–20 = 6 days, 2 met.
    expect(habitCompletion(water as any, TODAY, 30, TZ)).toEqual({ scheduled: 6, complete: 2, percent: 33 });
    // Across habits every habit-day weighs the same.
    expect(habitsCompletion([read, water] as any, TODAY, 30, TZ)).toEqual({ scheduled: 27, complete: 12, percent: 44 });
  });

  it("a back-dated check-in pulls the first day earlier", () => {
    const h = { ...read, checkins: [ci("2026-09-28"), ...read.checkins] };
    expect(habitFirstDay(h as any, TZ)).toBe("2026-09-28");
  });

  it("skips days the habit isn't scheduled on", () => {
    // Weekly with no target days = Mondays. Oct 15–21 holds one Monday (Oct 19).
    const weekly = { ...read, frequency: "weekly", createdAt: "2026-09-01T00:00:00Z", checkins: [ci("2026-10-19")] };
    expect(habitCompletion(weekly as any, TODAY, 7, TZ)).toEqual({ scheduled: 1, complete: 1, percent: 100 });
  });

  it("returns null, not 0%, when nothing could be judged yet", () => {
    const fresh = { ...read, createdAt: `${TODAY}T07:00:00Z`, checkins: [] };
    expect(habitCompletion(fresh as any, TODAY, 30, TZ).percent).toBeNull();
  });

  it("the daily series stops at yesterday and starts when the first habit did", () => {
    const s = dailyCompletionSeries([read, water] as any, TODAY, 30, TZ);
    expect(s[0].day).toBe("2026-10-01");
    expect(s[s.length - 1].day).toBe("2026-10-20");
    const oct16 = s.find((p) => p.day === "2026-10-16")!;
    expect(oct16).toMatchObject({ value: 50, entries: 2 }); // Read done, Water half
  });

  it("heatmap points are check-ins per day inside the window", () => {
    const pts = habitCheckinPoints(water as any, "2026-10-16", TODAY);
    expect(pts.map((p) => [p.day, p.value])).toEqual([["2026-10-16", 1], ["2026-10-17", 2], [TODAY, 1]]);
    expect(heatmapStartDay(TODAY, 14)).toBe("2026-07-20"); // a Monday, 13 weeks before this week's
  });
});

describe("the Habits page", () => {
  let fetchStub: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${TODAY}T15:00:00Z`));
    fetchStub = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      let body: unknown = [];
      if (method === "GET" && u.includes("/api/habits")) body = [read, water];
      if (method === "POST" && u.includes("/checkin")) body = { ...water, checkins: [...water.checkins, ci(TODAY, 20)] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchStub);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  async function renderPage() {
    const { default: HabitsPage } = await import("../client/src/pages/habits");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Router hook={() => ["/habits", () => {}] as any}><HabitsPage /></Router>
      </QueryClientProvider>,
    );
    await screen.findByTestId("card-habit-h-read");
  }

  it("shows today's x/y, the period's completion, the best streak and a heatmap per habit", async () => {
    await renderPage();
    const hero = screen.getByTestId("td-hero");
    expect(screen.getByTestId("td-hero-value").textContent).toBe("1/2");
    expect(hero.textContent).toContain("1 check-in left today");
    expect(screen.getByTestId("text-habits-today-pct").textContent).toBe("67%");
    expect(screen.getByTestId("text-habits-completion").textContent).toBe("44%");
    expect(screen.getByTestId("text-habits-best-streak").textContent).toBe("10");
    expect(screen.getAllByTestId("td-heatmap")).toHaveLength(2);

    const card = screen.getByTestId("card-habit-h-water");
    expect(within(card).getByTestId("stat-rate-h-water").textContent).toContain("33%");
    expect(within(card).getByTestId("text-habit-today-h-water").textContent).toBe("1 of 2 completed");
    expect(within(screen.getByTestId("card-habit-h-read")).getByTestId("text-habit-today-h-read").textContent).toBe("Done today");
    // The consistency list ranks habits by rate.
    const list = screen.getByTestId("habits-consistency").textContent || "";
    expect(list.indexOf("Read")).toBeGreaterThanOrEqual(0);
    expect(list.indexOf("Read")).toBeLessThan(list.indexOf("Water"));
  });

  it("the time frame changes the rates", async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId("habits-range-7d"));
    // Oct 15–21: Read 7/7; Water Oct 15–20 → 2/6. Together 9/13.
    await waitFor(() => expect(screen.getByTestId("text-habits-completion").textContent).toBe("69%"));
    expect(screen.getByTestId("stat-rate-h-read").textContent).toContain("100%");
  });

  it("the next check-in dot still posts a check-in for today", async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId("button-seg-h-water-1"));
    await waitFor(() => {
      const posted = fetchStub.mock.calls.find(([u, init]) => String(u).includes("/api/habits/h-water/checkin") && String(init?.method).toUpperCase() === "POST");
      expect(posted).toBeTruthy();
      expect(JSON.parse(String(posted![1].body))).toEqual({ date: TODAY });
    });
  });
});
