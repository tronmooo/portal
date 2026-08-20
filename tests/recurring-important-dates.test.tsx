// @vitest-environment jsdom
//
// The half of the Recurring & Important Dates screen that did not exist.
//
// A driver's licence expiring on 18 July 2034 belongs on this screen, and is
// not a recurrence. The old page had only one way in — be a recurrence rule —
// so either the licence was excluded (what shipped, and why the screen read
// "All 0" for an account that had just extracted one) or it would have had to
// be modelled as repeating yearly, which is false.
//
// These mounts prove the third option holds: the licence appears, as a
// one-time important date, with a countdown computed from the stored date.

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

vi.mock("wouter", () => ({
  Link: ({ children }: any) => <>{children}</>,
  useLocation: () => ["/", vi.fn()],
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/calendar-mutations", () => ({
  applyCalendarAction: vi.fn().mockResolvedValue(undefined),
  refreshCalendarSurfaces: vi.fn().mockResolvedValue(undefined),
}));

import { seriesFromAll } from "../shared/calendar-adapters";
import {
  dedupeSeries, generateSeriesOccurrences, onlyRulesAndImportantDates,
  type CalendarOccurrence,
} from "../shared/calendar-occurrences";

const TODAY = "2026-08-20";
const JANE = "jane-id";

// Exactly the account from the report: a person whose licence was extracted.
const RAW = {
  profiles: [{ id: JANE, name: "Jane Doe", type: "person", fields: { dateOfBirth: "1994-07-10" } }],
  documents: [{
    id: "doc-licence", name: "Sample Driver License", type: "drivers_license",
    linkedProfiles: [JANE], extractedData: { expiration_date: "2034-07-18", issueDate: "2026-07-18" },
  }],
  events: [] as any[],
  obligations: [] as any[],
  tasks: [] as any[],
};

const series = dedupeSeries(seriesFromAll(RAW)).map((d) => d.series);
const occBySeries = new Map<string, CalendarOccurrence[]>(
  series.map((s) => [s.id, generateSeriesOccurrences(s, { todayISO: TODAY, horizonDays: 366 * 12 })]),
);

vi.mock("@/hooks/useCalendarOccurrences", () => ({
  useCalendarOccurrences: () => ({
    occurrences: [...occBySeries.values()].flat()
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
    // What `recurringOnly` now yields: recurrence rules AND important one-offs.
    series: onlyRulesAndImportantDates(series),
    allSeries: series,
    duplicatesBySeries: new Map<string, string[]>(),
    occurrencesForSeries: (id: string) => occBySeries.get(id) || [],
    getEventRow: () => undefined,
    profileName: (id: string) => RAW.profiles.find((p) => p.id === id)?.name,
    todayISO: TODAY,
    isLoading: false,
  }),
}));

import { RecurringDatesPage } from "../client/src/components/recurring/RecurringDatesPage";

afterEach(cleanup);
const mount = () => render(<RecurringDatesPage filterIds={[]} filterMode="everyone" />);

const LICENCE = "rule:document:doc-licence:expirationdate:expiration";
const BIRTHDAY = `rule:profile:${JANE}:dateofbirth:birthday`;

describe("the screen shows both kinds of date, in their own halves", () => {
  it("is not empty for an account whose only dates were extracted", () => {
    mount();
    expect(screen.queryByTestId("recurring-empty")).toBeNull();
    expect(screen.getByTestId(`rule-card-${BIRTHDAY}`)).toBeTruthy();
    expect(screen.getByTestId(`rule-card-${LICENCE}`)).toBeTruthy();
  });

  it("labels the two groups", () => {
    mount();
    expect(screen.getByTestId("rules-heading-recurring").textContent).toContain("Recurring");
    expect(screen.getByTestId("rules-heading-important").textContent).toContain("Important dates");
  });

  it("does not put the licence's issue date on the screen", () => {
    // Metadata stays metadata: "issued on" is not something to act on.
    mount();
    expect(screen.queryByText(/issue/i)).toBeNull();
  });
});

describe("the licence card reads as a countdown, not as a schedule", () => {
  it("shows the stored date and how long is left, computed from today", () => {
    mount();
    const card = screen.getByTestId(`rule-card-${LICENCE}`);
    const line = within(card).getByTestId(`rule-next-${LICENCE}`).textContent || "";
    expect(line).toContain("July 18, 2034");
    expect(line).toContain("Expires in 7 years, 10 months");
  });

  it("says it is one-time, never that it repeats", () => {
    mount();
    const card = screen.getByTestId(`rule-card-${LICENCE}`);
    expect(within(card).getByText("One-time — important date")).toBeTruthy();
    // The old page's tell-tale caption, and the reason one-offs were banished
    // from this screen in the first place.
    expect(within(card).queryByText("Does not repeat")).toBeNull();
    // A one-time date has no end condition and no "1 upcoming" to report.
    expect(within(card).queryByText(/No end date/)).toBeNull();
  });

  it("keeps the birthday reading as a yearly rule", () => {
    mount();
    const card = screen.getByTestId(`rule-card-${BIRTHDAY}`);
    expect(within(card).getByText(/Every year on Jul 10/i)).toBeTruthy();
    expect(within(card).getByTestId(`rule-next-${BIRTHDAY}`).textContent).toContain("Next:");
  });
});
