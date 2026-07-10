// @vitest-environment jsdom
//
// Render test for the DYNAMIC Wellness overview. Proves: the KPI strip draws
// only tiles that have a value, a card renders for every dynamic metric the
// user tracks, aggregate cards (habits/meds/appointments/…) render ONLY when
// they have data (no empty placeholder cards), the quick-log row + AI Deep Dive
// fire their callbacks, and a truly empty account shows a single nudge.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { WellnessOverview, type WellnessOverviewProps } from "../client/src/components/wellness/WellnessOverview";
import type { WellnessCard } from "../client/src/lib/wellness-dynamic";

vi.mock("wouter", () => ({ Link: ({ children }: any) => <>{children}</> }));

afterEach(cleanup);

const card = (over: Partial<WellnessCard>): WellnessCard => ({
  id: "t1", name: "Weight", group: "Health", category: "health",
  value: 178, unit: "lbs", series: [180, 179, 178], changePct: -0.6,
  direction: "down", favorable: "good", lastLogged: new Date().toISOString(),
  entryCount: 10, ...over,
});

const base: WellnessOverviewProps = {
  wellnessScore: 80, wellnessScoreLabel: "Good",
  sleepHours: 7.4, sleepSeries: [6.8, 7.1, 7.4],
  steps: 7842, stepsSeries: [5000, 6000, 7842],
  restingHr: 54, restingHrSeries: [56, 55, 54],
  hydrationOz: 64, hydrationGoal: 100,
  calories: 1842, caloriesGoal: 2300,
  streak: 12,
  insights: ["Your sleep quality improved 12% this week."],
  habits: [
    { id: "h1", name: "Morning Stretch", done: true },
    { id: "h2", name: "Meditate", done: false },
  ],
  habitsCompleted: 1,
  schedule: [{ id: "e1", time: "8:00 AM", title: "Morning Run" }],
  medications: [
    { id: "m1", name: "Lisinopril", dose: "10mg", time: "8:00 AM", taken: true },
    { id: "m2", name: "Metformin", dose: "500mg", time: "9:00 PM", taken: false },
  ],
  vitals: [],
  sleep: { hours: 7.4 },
  nutrition: { calories: 1842, caloriesGoal: 2300 },
  mood: { value: 7, series: [6, 7, 7] },
  activity: { workouts: 4 },
  appointments: [{ id: "a1", date: "Jul 15", time: "10:00 AM", title: "General Checkup" }],
  reminders: ["Drink 36 more oz of water."],
  labs: [{ id: "l1", name: "Vitamin D", date: "Jun 28", status: "Optimal" }],
  supplements: [{ id: "s1", name: "Magnesium Glycinate", dose: "200mg", schedule: "nightly" }],
  documents: [{ id: "d1", name: "Insurance Card", date: "Jun 15, 2025" }],
  conditions: [{ id: "c1", name: "Seasonal Allergies", note: "Mild" }],
  allergies: [{ id: "al1", name: "Pollen", note: "Seasonal" }],
  recentActivity: [{ id: "r1", text: "Logged workout", when: "45m ago" }],
  weightUnit: "lbs",
  missedHabits: [],
  dynamicCards: [
    card({ id: "t1", name: "Weight", group: "Health" }),
    card({ id: "t2", name: "Running", group: "Fitness", category: "fitness", unit: "mi", value: 3, favorable: "good", direction: "up", changePct: 5 }),
    card({ id: "t3", name: "Guitar", group: "Other", category: "custom", value: 4, unit: "logs · 14d", series: [], changePct: null, isCount: true, favorable: "neutral" }),
  ],
};

describe("WellnessOverview (dynamic)", () => {
  it("renders only KPI tiles that have a value", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-kpi-score").textContent).toContain("80");
    expect(screen.getByTestId("wellness-kpi-sleep").textContent).toContain("7.4h");
    expect(screen.getByTestId("wellness-kpi-activity").textContent).toContain("7,842");
    // null KPI → tile absent
    cleanup();
    render(<WellnessOverview {...base} sleepHours={null} steps={null} restingHr={null} />);
    expect(screen.queryByTestId("wellness-kpi-sleep")).toBeNull();
    expect(screen.queryByTestId("wellness-kpi-activity")).toBeNull();
    expect(screen.getByTestId("wellness-kpi-score")).toBeTruthy();
  });

  it("renders a dynamic card for EVERY tracked metric (incl. custom ones)", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-metric-t1").textContent).toContain("Weight");
    expect(screen.getByTestId("wellness-metric-t2").textContent).toContain("Running");
    // custom non-numeric tracker still gets a card
    expect(screen.getByTestId("wellness-metric-t3").textContent).toContain("Guitar");
  });

  it("renders habits and toggles via callback", () => {
    const onToggleHabit = vi.fn();
    render(<WellnessOverview {...base} onToggleHabit={onToggleHabit} />);
    expect(screen.getByTestId("wellness-habits").textContent).toContain("1 / 2 done");
    fireEvent.click(screen.getByTestId("wellness-habit-h2"));
    expect(onToggleHabit).toHaveBeenCalledWith("h2", true);
  });

  it("renders medications with due/taken state and toggles", () => {
    const onToggleMed = vi.fn();
    render(<WellnessOverview {...base} onToggleMed={onToggleMed} />);
    const meds = screen.getByTestId("wellness-medications");
    expect(meds.textContent).toContain("Lisinopril 10mg");
    expect(meds.textContent).toContain("1 due");
    fireEvent.click(screen.getByTestId("wellness-med-toggle-m2"));
    expect(onToggleMed).toHaveBeenCalledWith("m2", true);
  });

  it("renders labs, supplements, conditions, allergies when present", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-labs").textContent).toContain("Vitamin D");
    expect(screen.getByTestId("wellness-supplements").textContent).toContain("Magnesium Glycinate");
    expect(screen.getByTestId("wellness-conditions").textContent).toContain("Seasonal Allergies");
    expect(screen.getByTestId("wellness-allergies").textContent).toContain("Pollen");
  });

  it("fires the quick-log row callbacks", () => {
    const onQuickLog = vi.fn();
    render(<WellnessOverview {...base} onQuickLog={onQuickLog} />);
    for (const kind of ["hydration", "weight", "sleep", "mood", "steps"] as const) {
      fireEvent.click(screen.getByTestId(`wellness-quicklog-${kind}`));
      expect(onQuickLog).toHaveBeenCalledWith(kind);
    }
  });

  it("hides the quick-log row when no handler is wired", () => {
    render(<WellnessOverview {...base} onQuickLog={undefined} />);
    expect(screen.queryByTestId("wellness-quicklog")).toBeNull();
    expect(screen.queryByTestId("wellness-quicklog-weight")).toBeNull();
  });

  it("fires AI Deep Dive and renders the narrative", () => {
    const onAiDeepDive = vi.fn();
    render(<WellnessOverview {...base} onAiDeepDive={onAiDeepDive} aiNarrative="You're trending well — keep it up." />);
    fireEvent.click(screen.getByTestId("wellness-ai-deepdive"));
    expect(onAiDeepDive).toHaveBeenCalled();
    expect(screen.getByTestId("wellness-insights").textContent).toContain("trending well");
  });

  it("hides empty aggregate cards instead of showing placeholders", () => {
    render(<WellnessOverview {...base}
      habits={[]} medications={[]} labs={[]} supplements={[]}
      appointments={[]} conditions={[]} allergies={[]} documents={[]}
      recentActivity={[]} reminders={[]} schedule={[]} missedHabits={[]} />);
    // Aggregate cards with no data are ABSENT (dynamic — "if they don't have any…").
    expect(screen.queryByTestId("wellness-habits")).toBeNull();
    expect(screen.queryByTestId("wellness-medications")).toBeNull();
    expect(screen.queryByTestId("wellness-labs")).toBeNull();
    expect(screen.queryByTestId("wellness-appointments")).toBeNull();
    // …but the dynamic metric cards still render.
    expect(screen.getByTestId("wellness-metric-t1")).toBeTruthy();
  });

  it("shows a single nudge for a truly empty account", () => {
    render(<WellnessOverview {...base}
      wellnessScore={null} sleepHours={null} steps={null} restingHr={null}
      hydrationOz={null} calories={null} streak={null}
      insights={[]} habits={[]} medications={[]} labs={[]} supplements={[]}
      appointments={[]} conditions={[]} allergies={[]} documents={[]}
      recentActivity={[]} reminders={[]} schedule={[]} missedHabits={[]}
      dynamicCards={[]} onAiDeepDive={undefined} />);
    expect(screen.getByTestId("wellness-empty").textContent).toContain("Nothing tracked yet");
    expect(screen.queryByTestId("wellness-metric-t1")).toBeNull();
  });
});
