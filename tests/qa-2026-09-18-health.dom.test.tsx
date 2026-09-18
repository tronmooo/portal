// @vitest-environment jsdom
//
// QA 2026-09-18 — the Wellness overview's rendered copy (F-32, F-38, F-39):
//   * with sources connected and nothing logged today, the score says
//     "Nothing logged today" with a log link — never "No connected source";
//   * the weekly brief's empty line makes the same distinction;
//   * the Water tile is part of Today, fed by the hydration signal;
//   * the score breakdown shows each component's score, then its share;
//   * a sleep delta reads in minutes (0.3 h → 18 min).
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WellnessOverview, type WellnessOverviewProps } from "../client/src/components/wellness/WellnessOverview";
import type { TodaySignal, SourceState } from "../shared/wellness-readout";

afterEach(cleanup);

const signal = (over: Partial<TodaySignal> & Pick<TodaySignal, "key">): TodaySignal => ({
  label: over.key, value: null, unit: "h", caption: null, avg30: null, series: [],
  at: null, lastAt: null, higherBetter: true, metricId: null, trackerId: null, ...over,
} as TodaySignal);

const connected: SourceState = { sleep: true, activity: true, recovery: false, labs: false, body: true, hydration: true };
const nothing: SourceState = { sleep: false, activity: false, recovery: false, labs: false, body: false, hydration: false };

const emptyScore = (connectedFlag: boolean) => ({
  value: null,
  connected: connectedFlag,
  components: [
    { key: "sleep" as const, label: "Sleep", score: null, weight: 0, detail: connectedFlag ? "No sleep recorded last night" : "No sleep source connected" },
    { key: "activity" as const, label: "Activity", score: null, weight: 0, detail: connectedFlag ? "No activity recorded today" : "No activity source connected" },
    { key: "recovery" as const, label: "Recovery", score: null, weight: 0, detail: "No recovery source connected" },
  ],
});

const base: WellnessOverviewProps = {
  score: emptyScore(true),
  signals: [
    signal({ key: "sleep", label: "Sleep", lastAt: "2026-09-17T06:00:00Z" }),
    signal({ key: "activity", label: "Activity", unit: "steps", lastAt: "2026-09-17T18:00:00Z" }),
    signal({ key: "recovery", label: "Recovery", unit: "bpm" }),
    signal({ key: "hydration", label: "Water", unit: "oz", value: 40, avg30: 56, series: [64, 48, 40], at: "2026-09-18T14:00:00Z", lastAt: "2026-09-18T14:00:00Z" }),
  ],
  brief: [],
  panels: [],
  body: [],
  medications: [], appointments: [], documents: [], allergies: [], conditions: [],
  workouts: [],
  sources: connected,
};

describe("Wellness overview — nothing logged today vs. nothing connected", () => {
  it("says 'Nothing logged today' with a log link when sources have data but today is empty", () => {
    render(<WellnessOverview {...base} />);
    const score = screen.getByTestId("wellness-score-empty").textContent || "";
    expect(score).toMatch(/Nothing logged today/);
    expect(score).not.toMatch(/No connected source/);
    expect(screen.getAllByTestId("wellness-log-cta")[0].getAttribute("href")).toBe("#/trackers");
    expect(screen.getByTestId("wellness-brief-empty").textContent).toMatch(/Nothing logged in the last week/);
    // The Sources block agrees with the copy above it.
    expect(screen.getByTestId("wellness-source-sleep").textContent).toMatch(/receiving data/);
  });

  it("still says 'connect a source' when there truly is none", () => {
    render(<WellnessOverview {...base} score={emptyScore(false)} sources={nothing}
      signals={base.signals.map((s) => ({ ...s, value: null, lastAt: null, series: [] }))} />);
    expect(screen.getByTestId("wellness-score").textContent).toMatch(/No connected source yet/);
    expect(screen.getByTestId("wellness-brief").textContent).toMatch(/connect a health source/);
    expect(screen.queryByTestId("wellness-log-cta")).toBeNull();
  });

  it("falls back to the Sources block when the score carries no connected flag", () => {
    render(<WellnessOverview {...base} score={{ ...emptyScore(true), connected: undefined }} />);
    expect(screen.getByTestId("wellness-score-empty").textContent).toMatch(/Nothing logged today/);
  });
});

describe("Wellness overview — hydration tile and score breakdown", () => {
  it("renders today's water as a Today tile and a Sources chip", () => {
    render(<WellnessOverview {...base} />);
    const tile = screen.getByTestId("wellness-signal-hydration");
    expect(tile.textContent).toMatch(/Water/);
    expect(tile.textContent).toMatch(/40/);
    expect(tile.textContent).toMatch(/oz/);
    expect(screen.getByTestId("wellness-source-water").textContent).toMatch(/receiving data/);
  });

  it("shows a component's score before its share, and a sleep delta in minutes", () => {
    render(<WellnessOverview {...base}
      score={{ value: 88, connected: true, components: [
        { key: "sleep", label: "Sleep", score: 88, weight: 1, detail: "6.7 h last night" },
        { key: "activity", label: "Activity", score: null, weight: 0, detail: "No activity recorded today" },
        { key: "recovery", label: "Recovery", score: null, weight: 0, detail: "No recovery source connected" },
      ] }}
      signals={[signal({ key: "sleep", label: "Sleep", value: 6.7, avg30: 7.0, series: [7.2, 7.0, 6.7], at: "2026-09-18T06:00:00Z", lastAt: "2026-09-18T06:00:00Z" })]}
    />);
    expect(screen.getByTestId("wellness-score-value").textContent).toBe("88");
    const breakdown = screen.getByTestId("wellness-score-breakdown").textContent || "";
    expect(breakdown).toMatch(/Sleep\s*88\/100/);
    expect(breakdown).toMatch(/100% of score/);
    expect(breakdown).not.toMatch(/Sleep\s*100%/);
    expect(screen.getByTestId("wellness-signal-sleep").textContent).toMatch(/18 min below your 30-day average/);
  });
});
