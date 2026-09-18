// @vitest-environment jsdom
//
// Render test for the REBUILT Wellness overview (2026-09). What it proves:
//   * the page is five sections, not ninety cards;
//   * a signal with no connected source says so instead of showing a zero or a
//     goal ring the user is failing;
//   * the score shows what it is made of and what it left out;
//   * labs render by panel, flagged and with their trend;
//   * nothing on the page asks the user to log anything.
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { WellnessOverview, type WellnessOverviewProps } from "../client/src/components/wellness/WellnessOverview";
import type { TodaySignal, LabPanel } from "../shared/wellness-readout";

afterEach(cleanup);

const signal = (over: Partial<TodaySignal> & Pick<TodaySignal, "key">): TodaySignal => ({
  label: over.key, value: 7.2, unit: "h", caption: null, avg30: 7.8,
  series: [7.9, 7.6, 7.2], at: new Date().toISOString(), higherBetter: true,
  metricId: "sleep_hours", trackerId: "t1", ...over,
} as TodaySignal);

const lipids: LabPanel = {
  panel: "lipids", label: "Lipids", outOfRange: 1,
  rows: [
    { metricId: "ldl", label: "LDL", value: 138, unit: "mg/dL", at: "2026-08-01T00:00:00Z",
      flag: "high", reference: "< 100 mg/dL", previous: 128, trackerId: "t-ldl", mergedFrom: 3 },
    { metricId: "hdl", label: "HDL", value: 58, unit: "mg/dL", at: "2026-08-01T00:00:00Z",
      flag: "normal", reference: "> 40 mg/dL", previous: null, trackerId: "t-hdl", mergedFrom: 1 },
  ],
};

const base: WellnessOverviewProps = {
  score: {
    value: 78,
    components: [
      { key: "sleep", label: "Sleep", score: 82, weight: 0.57, detail: "7.2 h last night" },
      { key: "activity", label: "Activity", score: 71, weight: 0.43, detail: "8,400 steps" },
      { key: "recovery", label: "Recovery", score: null, weight: 0, detail: "No recovery source connected" },
    ],
  },
  signals: [
    signal({ key: "sleep", label: "Sleep" }),
    signal({ key: "activity", label: "Activity", value: 8400, unit: "steps", avg30: 7200, caption: "Steps", series: [7000, 7600, 8400] }),
    signal({ key: "recovery", label: "Recovery", value: null, avg30: null, series: [] }),
  ],
  brief: ["Sleep is 36 min down vs. your average.", "You ran twice this week."],
  panels: [lipids],
  body: [{
    panel: "body", label: "Body", outOfRange: 0,
    rows: [{ metricId: "weight", label: "Weight", value: 184.6, unit: "lbs", at: "2026-09-14T00:00:00Z",
      flag: "unknown", reference: undefined, previous: 186.2, trackerId: "t-w", mergedFrom: 1 }],
  }, {
    panel: "vitals", label: "Vitals", outOfRange: 1,
    rows: [{ metricId: "bp_systolic", label: "Systolic", value: 82, unit: "mmHg", at: "2026-09-15T00:00:00Z",
      flag: "low", reference: "90–120 mmHg", previous: 118, trackerId: "t-bp", mergedFrom: 1 }],
  }],
  medications: [{ id: "m1", name: "Lisinopril", dose: "10mg", refill: "Refills Oct 4" }],
  appointments: [{ id: "a1", title: "Dentist", date: "Oct 2", time: "9:00 AM" }],
  documents: [{ id: "d1", name: "Lab report — August", date: "Aug 1", type: "lab_result" }],
  allergies: [{ id: "al1", name: "Penicillin" }],
  conditions: [],
  workouts: [{ type: "Running", sessions: 2, minutes: 54, distance: 6.2, reps: null, lastAt: new Date().toISOString(), trackerId: "t-run" }],
  sources: { sleep: true, activity: true, recovery: false, labs: true, body: false },
  duplicates: [{ label: "HDL", sources: ["HDL", "HDL Cholesterol", "Lipid Panel — HDL"] }],
};

describe("Wellness overview — the readout", () => {
  it("renders the five sections and nothing else", () => {
    render(<WellnessOverview {...base} />);
    for (const id of ["wellness-brief", "wellness-labs", "wellness-care", "wellness-activity"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getAllByTestId(/^wellness-signal-/).length).toBeGreaterThanOrEqual(3);
  });

  it("asks the user to log nothing", () => {
    const { container } = render(<WellnessOverview {...base} />);
    expect(container.textContent).not.toMatch(/log |streak|hydration|missed habit/i);
    expect(container.querySelector('[data-testid^="wellness-quicklog"]')).toBeNull();
  });

  it("tells a signal with no source apart from a signal of zero", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-signal-recovery-empty").textContent).toMatch(/Connect a wearable/i);
    expect(screen.queryByTestId("wellness-signal-sleep-empty")).toBeNull();
  });

  it("reads each signal against the 30-day average, not a goal", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-signal-sleep").textContent).toMatch(/below your 30-day average/);
    expect(screen.getByTestId("wellness-signal-activity").textContent).toMatch(/above your 30-day average/);
  });

  it("shows what the score is made of and what it left out", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-score-value").textContent).toBe("78");
    const breakdown = screen.getByTestId("wellness-score-breakdown").textContent || "";
    // The component's own score first, then its share of the total — "Sleep
    // 100%" used to be the share, read as the score (QA 2026-09-18 F-39).
    expect(breakdown).toMatch(/Sleep\s*82\/100.*57% of score/);
    expect(breakdown).toMatch(/Activity\s*71\/100.*43% of score/);
    expect(breakdown).toMatch(/Recovery not counted — no recovery source connected/);
  });

  it("groups labs by panel, flags out-of-range values and shows the trend", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-panel-lipids")).toBeTruthy();
    const ldl = screen.getByTestId("wellness-lab-ldl");
    expect(ldl.textContent).toMatch(/High/);
    expect(ldl.textContent).toMatch(/Ref < 100 mg\/dL/);
    expect(screen.getByTestId("wellness-lab-ldl-trend").textContent).toBe("128 → 138");
    // A normal value carries no flag.
    expect(screen.getByTestId("wellness-lab-hdl").textContent).not.toMatch(/High|Low/);
  });

  it("shows body and vitals, with their precision and their flags", () => {
    render(<WellnessOverview {...base} />);
    const body = screen.getByTestId("wellness-body");
    expect(body.textContent).toMatch(/184\.6 lbs/);      // not "185"
    expect(body.textContent).toMatch(/186\.2 → 184\.6/);
    const sys = screen.getByTestId("wellness-lab-bp_systolic");
    expect(sys.textContent).toMatch(/Low/);
    expect(sys.textContent).toMatch(/Ref 90–120 mmHg/);
  });

  it("keeps a lab value's measured precision", () => {
    render(<WellnessOverview {...base} panels={[{
      ...lipids, rows: [{ ...lipids.rows[0], metricId: "hemoglobin", label: "Hemoglobin", value: 15.1, unit: "g/dL", flag: "normal", previous: null }],
    }]} />);
    expect(screen.getByTestId("wellness-lab-hemoglobin").textContent).toMatch(/15\.1 g\/dL/);
  });

  it("links a value read off a lab report to the document, not a tracker", () => {
    render(<WellnessOverview {...base} panels={[{
      ...lipids, rows: [{ ...lipids.rows[0], metricId: "vitamin_d", label: "Vitamin D", trackerId: "doc:doc-vitd" }],
    }]} />);
    expect(screen.getByTestId("wellness-lab-vitamin_d").getAttribute("href")).toBe("#/documents?doc=doc-vitd");
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-lab-ldl").getAttribute("href")).toBe("#/trackers?tracker=t-ldl");
  });

  it("shows medications as refill dates, not daily check-offs", () => {
    render(<WellnessOverview {...base} />);
    const med = screen.getByTestId("wellness-med-m1");
    expect(med.textContent).toMatch(/Refills Oct 4/);
    expect(med.querySelector("input,button")).toBeNull();
  });

  it("renders care, activity and sources from real records only", () => {
    render(<WellnessOverview {...base} />);
    expect(screen.getByTestId("wellness-appt-a1").textContent).toMatch(/Dentist/);
    expect(screen.getByTestId("wellness-doc-d1").textContent).toMatch(/Lab report/);
    expect(screen.getByTestId("wellness-workout-t-run").textContent).toMatch(/2 sessions · 54 min · 6.2 mi/);
    expect(screen.getByTestId("wellness-source-recovery").textContent).toMatch(/not connected/);
    expect(screen.getByTestId("wellness-duplicates").textContent).toMatch(/HDL \(3 trackers\)/);
  });

  it("fires the AI brief and renders its narrative in place of the computed one", () => {
    const onAiBrief = vi.fn();
    const { rerender } = render(<WellnessOverview {...base} onAiBrief={onAiBrief} />);
    fireEvent.click(screen.getByTestId("wellness-ai-brief"));
    expect(onAiBrief).toHaveBeenCalled();
    rerender(<WellnessOverview {...base} onAiBrief={onAiBrief} aiNarrative="Sleep dipped; heart rate held steady." />);
    expect(screen.getByTestId("wellness-brief-ai").textContent).toMatch(/Sleep dipped/);
  });

  it("says what is missing instead of rendering empty shells", () => {
    render(<WellnessOverview
      {...base}
      brief={[]} panels={[]} body={[]} workouts={[]} medications={[]} appointments={[]}
      documents={[]} allergies={[]} conditions={[]}
      score={{ value: null, components: base.score.components.map((c) => ({ ...c, score: null, weight: 0 })) }}
      sources={{ sleep: false, activity: false, recovery: false, labs: false, body: false }}
    />);
    expect(screen.getByTestId("wellness-labs").textContent).toMatch(/Photograph a lab report/);
    expect(screen.getByTestId("wellness-body").textContent).toMatch(/No body measurements yet/);
    expect(screen.getByTestId("wellness-care").textContent).toMatch(/No medications, appointments or health documents/);
    expect(screen.getByTestId("wellness-activity").textContent).toMatch(/No workouts recorded/);
    expect(screen.getByTestId("wellness-score").textContent).toMatch(/nothing to score/);
  });

  it("names the person when the data is not the user's own", () => {
    render(<WellnessOverview {...base} subjectName="Linda" />);
    expect(screen.getByTestId("wellness-subject").textContent).toMatch(/Linda's health data/);
  });
});
