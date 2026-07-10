// @vitest-environment jsdom
//
// Render test for the Wellness-tab overview. Proves the KPI strip + card grid
// draw from real props, habits toggle, quick-log fires, and empty cards show an
// honest empty state instead of fabricated numbers.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { WellnessOverview, type WellnessOverviewProps } from "../client/src/components/wellness/WellnessOverview";

vi.mock("wouter", () => ({ Link: ({ children }: any) => <>{children}</> }));

afterEach(cleanup);

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
  vitals: [
    { label: "Blood Pressure", value: "118/76 mmHg", change: null },
    { label: "Heart Rate", value: "54 bpm", change: -2 },
  ],
  sleep: { hours: 7.4, deep: 1.2, rem: 1.6, efficiency: 92 },
  nutrition: { calories: 1842, caloriesGoal: 2300, protein: 112, carbs: 198, fats: 67 },
  mood: { value: 7, series: [6, 7, 7] },
  activity: { workouts: 4, activeMin: 384, caloriesBurned: 2180 },
  appointments: [{ id: "a1", date: "Jul 15", time: "10:00 AM", title: "General Checkup" }],
  reminders: ["Drink 36 more oz of water."],
  labs: [{ id: "l1", name: "Vitamin D", date: "Jun 28", status: "Optimal" }],
  supplements: [{ id: "s1", name: "Magnesium Glycinate", dose: "200mg", schedule: "nightly" }],
  documents: [{ id: "d1", name: "Insurance Card", date: "Jun 15, 2025" }],
  conditions: [{ id: "c1", name: "Seasonal Allergies", note: "Mild" }],
  allergies: [{ id: "al1", name: "Pollen", note: "Seasonal" }],
  recentActivity: [{ id: "r1", text: "Logged workout", when: "45m ago" }],
  weightUnit: "lbs",
};

describe("WellnessOverview", () => {
  it("renders the KPI strip from props", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-kpi-score").textContent).toContain("80");
    expect(screen.getByTestId("wellness-kpi-sleep").textContent).toContain("7.4h");
    expect(screen.getByTestId("wellness-kpi-activity").textContent).toContain("7,842");
    expect(screen.getByTestId("wellness-kpi-hr").textContent).toContain("54");
    expect(screen.getByTestId("wellness-kpi-streak").textContent).toContain("12");
  });

  it("renders habits and toggles via callback", () => {
    const onToggleHabit = vi.fn();
    render(<WellnessOverview {...base} onToggleHabit={onToggleHabit} />);
    expect(screen.getByTestId("wellness-habits").textContent).toContain("1 / 2 done");
    fireEvent.click(screen.getByTestId("wellness-habit-h2"));
    expect(onToggleHabit).toHaveBeenCalledWith("h2", true); // was not done → toggling on
  });

  it("renders medications with due/taken state", () => {
    render(<WellnessOverview {...base} />);
    const meds = screen.getByTestId("wellness-medications");
    expect(meds.textContent).toContain("Lisinopril 10mg");
    expect(meds.textContent).toContain("Taken");
    expect(meds.textContent).toContain("Due");
    expect(meds.textContent).toContain("1 due");
  });

  it("renders vitals, labs, supplements, conditions, allergies", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-vitals").textContent).toContain("118/76 mmHg");
    expect(screen.getByTestId("wellness-labs").textContent).toContain("Vitamin D");
    expect(screen.getByTestId("wellness-supplements").textContent).toContain("Magnesium Glycinate");
    expect(screen.getByTestId("wellness-conditions").textContent).toContain("Seasonal Allergies");
    expect(screen.getByTestId("wellness-allergies").textContent).toContain("Pollen");
  });

  it("fires quick-log for hydration, weight, sleep, mood, steps", () => {
    const onQuickLog = vi.fn();
    render(<WellnessOverview {...base} onQuickLog={onQuickLog} />);
    fireEvent.click(screen.getByTestId("wellness-log-hydration"));
    expect(onQuickLog).toHaveBeenCalledWith("hydration");
    fireEvent.click(screen.getByTestId("wellness-log-weight"));
    expect(onQuickLog).toHaveBeenCalledWith("weight");
    fireEvent.click(screen.getByTestId("wellness-log-sleep"));
    expect(onQuickLog).toHaveBeenCalledWith("sleep");
    fireEvent.click(screen.getByTestId("wellness-log-mood"));
    expect(onQuickLog).toHaveBeenCalledWith("mood");
    fireEvent.click(screen.getByTestId("wellness-log-steps"));
    expect(onQuickLog).toHaveBeenCalledWith("steps");
  });

  it("toggles medication taken state via callback", () => {
    const onToggleMed = vi.fn();
    render(<WellnessOverview {...base} onToggleMed={onToggleMed} />);
    // m2 (Metformin) is not taken → clicking marks it taken (next=true)
    fireEvent.click(screen.getByTestId("wellness-med-toggle-m2"));
    expect(onToggleMed).toHaveBeenCalledWith("m2", true);
    // m1 (Lisinopril) is taken → clicking un-marks it (next=false)
    fireEvent.click(screen.getByTestId("wellness-med-toggle-m1"));
    expect(onToggleMed).toHaveBeenCalledWith("m1", false);
  });

  it("disables the med toggle that is mid-flight", () => {
    const onToggleMed = vi.fn();
    render(<WellnessOverview {...base} onToggleMed={onToggleMed} togglingMedId="m1" />);
    expect((screen.getByTestId("wellness-med-toggle-m1") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("wellness-med-toggle-m2") as HTMLButtonElement).disabled).toBe(false);
  });

  it("hides quick-log buttons when no handler is wired", () => {
    render(<WellnessOverview {...base} onQuickLog={undefined} />);
    expect(screen.queryByTestId("wellness-log-weight")).toBeNull();
    expect(screen.queryByTestId("wellness-log-sleep")).toBeNull();
  });

  it("renders Missed Habits, Mental Wellness, and Recovery sections", () => {
    render(<WellnessOverview {...base}
      missedHabits={[{ id: "h2", name: "Meditate", done: false }]}
      meditationMin={15} recoveryScore={null} />);
    // Missed habits list the un-done habit and check it in on click
    const onToggleHabit = vi.fn();
    cleanup();
    render(<WellnessOverview {...base}
      missedHabits={[{ id: "h2", name: "Meditate", done: false }]}
      meditationMin={15} recoveryScore={72} onToggleHabit={onToggleHabit} />);
    expect(screen.getByTestId("wellness-missed-habits").textContent).toContain("Meditate");
    fireEvent.click(screen.getByTestId("wellness-missed-h2"));
    expect(onToggleHabit).toHaveBeenCalledWith("h2", true);
    expect(screen.getByTestId("wellness-mental").textContent).toContain("15 min");
    expect(screen.getByTestId("wellness-recovery")).toBeTruthy();
  });

  it("Mental Wellness / Recovery / Missed show empty states with no data", () => {
    render(<WellnessOverview {...base} missedHabits={[]} meditationMin={null} recoveryScore={null} />);
    expect(screen.getByTestId("wellness-missed-habits").textContent).toContain("on track");
    expect(screen.getByTestId("wellness-mental").textContent).toContain("No mindfulness");
    expect(screen.getByTestId("wellness-recovery").textContent).toContain("No recovery");
  });

  it("shows honest empty states when data is missing", () => {
    render(<WellnessOverview {...base}
      habits={[]} medications={[]} labs={[]} supplements={[]}
      appointments={[]} conditions={[]} allergies={[]} documents={[]}
      recentActivity={[]} insights={[]} schedule={[]}
      sleep={{ hours: null }} nutrition={{ calories: null, caloriesGoal: 2300 }}
      mood={{ value: null, series: [] }} activity={{}} vitals={[]} />);
    expect(screen.getByTestId("wellness-habits").textContent).toContain("No habits");
    expect(screen.getByTestId("wellness-medications").textContent).toContain("No medications");
    expect(screen.getByTestId("wellness-vitals").textContent).toContain("No vitals");
    expect(screen.getByTestId("wellness-labs").textContent).toContain("No lab results");
  });
});
