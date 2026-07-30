// @vitest-environment jsdom
//
// The Wellness tab's detail popups. Before this they didn't exist — every KPI
// tile and section card was a dead end.
//
// Two contracts matter beyond "it renders":
//   * A popup must never fetch. It is handed data the page already loaded, so
//     opening one has no loading state and issues no request.
//   * A row is pressable only when it goes somewhere. A row that lifts under
//     the cursor and does nothing is worse than a flat one.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Router } from "wouter";
import { WellnessPopup, type WellnessPopupData } from "../client/src/components/wellness/WellnessPopups";

function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
}

let fetchStub: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stubMatchMedia();
  fetchStub = vi.fn(async () => new Response("[]", { status: 200 }));
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const BASE: WellnessPopupData = {
  wellnessScore: 82, wellnessScoreLabel: "Good",
  sleepHours: 7.4, sleepSeries: [6, 7, 8, 7.5, 6.5, 7, 7.4],
  steps: 8200, stepsSeries: [5000, 9000, 7000, 8200],
  restingHr: 58, restingHrSeries: [60, 59, 58],
  hydrationOz: 64, hydrationGoal: 100,
  calories: 1800, caloriesGoal: 2300,
  streak: 12,
  checkinDates: ["2026-07-29", "2026-07-28", "2026-07-27"],
  insights: ["Sleep improved 12% this week"],
  habits: [
    { id: "h1", name: "Drink water", done: true },
    { id: "h2", name: "Stretch", done: false },
  ],
  missedHabits: [{ id: "h2", name: "Stretch", done: false }],
  schedule: [{ id: "e1", time: "3:00pm", title: "Dentist" }],
  medications: [
    { id: "m1", name: "Lisinopril", dose: "10mg", time: "8:00am", taken: true },
    { id: "m2", name: "Vitamin D", dose: "2000IU", time: "8:00am", taken: false },
  ],
  appointments: [{ id: "a1", date: "Aug 4", time: "10:00am", title: "Annual physical" }],
  reminders: ["Refill Lisinopril"],
  labs: [{ id: "l1", name: "Lipid panel", date: "Jul 2", status: "Normal" }],
  supplements: [{ id: "s1", name: "Creatine", dose: "5g", schedule: "Daily" }],
  documents: [{ id: "d1", name: "Insurance card", date: "Jan 3" }],
  conditions: [{ id: "c1", name: "Hypertension", note: "Managed" }],
  allergies: [{ id: "al1", name: "Penicillin", note: "Severe" }],
  recentActivity: [{ id: "r1", text: "Logged weight 179 lbs", when: "2h ago" }],
};

function open(kind: any, over: Partial<WellnessPopupData> = {}) {
  const onClose = vi.fn();
  render(
    <Router hook={() => ["/wellness", () => {}] as any}>
      <WellnessPopup kind={kind} onClose={onClose} d={{ ...BASE, ...over }} />
    </Router>,
  );
  return onClose;
}

const ALL_KINDS = [
  "score", "sleep", "activity", "hr", "hydration", "calories", "streak",
  "habits", "missed", "schedule", "meds", "appts", "reminders",
  "labs", "supps", "docs", "conditions", "allergies", "recent", "insights",
] as const;

describe("every wellness popup", () => {
  it.each(ALL_KINDS)("%s renders with a titled shell and no network call", (kind) => {
    open(kind);
    expect(screen.getByTestId(`wellness-popup-${kind}`)).toBeTruthy();
    // A popup is handed data that's already loaded — it must not fetch.
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each(ALL_KINDS)("%s degrades to an honest empty state, never a blank panel", (kind) => {
    // Everything emptied out — a brand-new account.
    open(kind, {
      wellnessScore: null, sleepHours: null, sleepSeries: [], steps: null, stepsSeries: [],
      restingHr: null, restingHrSeries: [], hydrationOz: null, calories: null, streak: 0,
      checkinDates: [], insights: [], aiNarrative: null, habits: [], missedHabits: [],
      schedule: [], medications: [], appointments: [], reminders: [], labs: [],
      supplements: [], documents: [], conditions: [], allergies: [], recentActivity: [],
    });
    const panel = screen.getByTestId(`wellness-popup-${kind}`);
    expect(panel.textContent?.trim().length, `${kind} rendered nothing`).toBeGreaterThan(0);
  });
});

describe("content and interaction", () => {
  it("the score popup breaks down what fed it, rather than restating the number", () => {
    open("score");
    const t = screen.getByTestId("wellness-popup-score").textContent || "";
    expect(t).toContain("Sleep");
    expect(t).toContain("Activity");
    expect(t).toContain("Hydration");
    expect(t).toContain("Habits");
  });

  it("a metric popup shows latest, average and best off the same series", () => {
    open("sleep");
    const t = screen.getByTestId("wellness-popup-sleep").textContent || "";
    expect(t).toContain("Latest");
    expect(t).toContain("Average");
    expect(t).toContain("Best");
  });

  it("resting heart rate treats lower as better", () => {
    open("hr");
    expect(screen.getByTestId("wellness-popup-hr").textContent).toContain("Lowest");
  });

  it("the streak popup draws the history, not just the run length", () => {
    open("streak");
    const heat = screen.getByRole("img", { name: /check-ins in the last 8 weeks/i });
    expect(heat).toBeTruthy();
    expect(heat.children.length).toBe(56); // 8 weeks × 7 days
  });

  it("checking off a habit calls back with the flipped state", () => {
    const onToggleHabit = vi.fn();
    render(
      <Router hook={() => ["/wellness", () => {}] as any}>
        <WellnessPopup kind="habits" onClose={() => {}} d={{ ...BASE, onToggleHabit }} />
      </Router>,
    );
    fireEvent.click(screen.getByTestId("wellness-popup-habit-h2"));
    expect(onToggleHabit).toHaveBeenCalledWith("h2", true);
  });

  it("medications show adherence and can be toggled", () => {
    const onToggleMed = vi.fn();
    render(
      <Router hook={() => ["/wellness", () => {}] as any}>
        <WellnessPopup kind="meds" onClose={() => {}} d={{ ...BASE, onToggleMed }} />
      </Router>,
    );
    expect(screen.getByTestId("wellness-popup-meds").textContent).toContain("1 of 2 taken today");
    fireEvent.click(screen.getByTestId("wellness-popup-med-m1"));
    expect(onToggleMed).toHaveBeenCalledWith("m1", false);
  });

  it("a document row links to the record, not to a list", () => {
    open("docs");
    const row = screen.getByTestId("wellness-popup-doc-d1");
    expect(row.closest("a")?.getAttribute("href")).toBe("/documents/d1");
  });

  it("rows that go nowhere are not dressed up as pressable", () => {
    open("reminders");
    const row = screen.getByTestId("wellness-popup-reminder-0");
    expect(row.className).not.toContain("pressable");
    expect(row.getAttribute("role")).toBeNull();
  });

  it("closes through the shell", () => {
    const onClose = open("labs");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
