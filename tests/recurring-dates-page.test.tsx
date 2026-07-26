// @vitest-environment jsdom
//
// Render tests for the redesigned Recurring Dates screen.
//
// The reported page mixed recurring RULES with generated OCCURRENCES in one
// scroll, so its three visible numbers ("All 4", "Upcoming 4", "UPCOMING ·
// 135") never answered "how many recurring items do I have?". These mounts
// prove the split holds: chips count unique rules, the Rules view shows one
// card per source, and a payment modelled as both a subscription and a
// liability renders exactly once.
import React from "react";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("wouter", () => ({
  Link: ({ children }: any) => <>{children}</>,
  useLocation: () => ["/", navigate],
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/calendar-mutations", () => ({
  applyCalendarAction: vi.fn().mockResolvedValue(undefined),
  refreshCalendarSurfaces: vi.fn().mockResolvedValue(undefined),
}));

import { seriesFromAll } from "../shared/calendar-adapters";
import {
  dedupeSeries, generateSeriesOccurrences, isRecurringRule,
  type CalendarOccurrence, type CalendarSeries,
} from "../shared/calendar-occurrences";

const TODAY = "2026-07-25";
const JOE = "joe-id";
const CHATGPT = "chatgpt-id";
const PROGRESSIVE = "progressive-id";

// The exact shape of the reported account.
const RAW = {
  profiles: [
    { id: JOE, name: "Joe", type: "person", fields: { birthday: "1990-02-11" } },
    { id: CHATGPT, name: "ChatGPT Pro", type: "liability", type_key: "subscription",
      fields: { nextDueDate: "2026-07-30", monthlyPayment: 20 } },
    { id: PROGRESSIVE, name: "Progressive Auto Insurance – Honda CR-V 2021", type: "liability",
      type_key: "insurance", fields: { nextDueDate: "2026-07-30", monthlyPayment: 155 } },
  ],
  events: [
    // The drifted birthday event from the first screenshot.
    { id: "evt-joe", title: "Joe's Birthday", date: "2029-02-11", recurrence: "yearly",
      linkedProfiles: [JOE], tags: ["rdate", "rd:kind:birthday"] },
    // A ONE-OFF date: excluded from Rules, present in Upcoming.
    { id: "evt-viewing", title: "House Viewing", date: "2026-08-05", recurrence: "none",
      linkedProfiles: [JOE] },
  ],
  obligations: [
    { id: "ob-chatgpt", name: "ChatGPT Pro", amount: 20, frequency: "monthly",
      category: "subscription", nextDueDate: "2026-07-30", linkedLiabilityId: CHATGPT },
    { id: "ob-prog", name: "Progressive Auto Insurance – Honda CR-V 2021", amount: 155,
      frequency: "monthly", category: "insurance", nextDueDate: "2026-07-30",
      linkedLiabilityId: PROGRESSIVE },
  ],
  tasks: [
    { id: "t-refill", title: "Refill Propranolol prescription (100mg)", dueDate: "2026-08-08",
      tags: ["recur:monthly"], linkedProfiles: ["robert-id"] },
  ],
  reminders: [] as any[],
  documents: [] as any[],
};

const series = dedupeSeries(seriesFromAll(RAW)).map((d) => d.series);
const occBySeries = new Map<string, CalendarOccurrence[]>(
  series.map((s) => [s.id, generateSeriesOccurrences(s, { todayISO: TODAY })]),
);
const allOccurrences = [...occBySeries.values()].flat()
  .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

vi.mock("@/hooks/useCalendarOccurrences", () => ({
  useCalendarOccurrences: () => ({
    occurrences: allOccurrences,
    // `series` is the RULES list (recurring only); `allSeries` is every date,
    // which is what the Upcoming view and the calendar grid share.
    series: series.filter(isRecurringRule),
    allSeries: series,
    duplicatesBySeries: new Map<string, string[]>(
      dedupeSeries(seriesFromAll(RAW))
        .filter((d) => d.duplicateIds.length)
        .map((d) => [d.series.id, d.duplicateIds]),
    ),
    occurrencesForSeries: (id: string) => occBySeries.get(id) || [],
    getEventRow: () => undefined,
    profileName: (id: string) => RAW.profiles.find((p) => p.id === id)?.name,
    todayISO: TODAY,
    isLoading: false,
  }),
}));

import { RecurringDatesPage } from "../client/src/components/recurring/RecurringDatesPage";

afterEach(cleanup);
beforeEach(() => navigate.mockClear());

const mount = () =>
  render(<RecurringDatesPage filterIds={[]} filterMode="everyone" />);

describe("category chips count unique rules, not occurrences", () => {
  it("shows one chip per category with a rule count", () => {
    mount();
    const chips = screen.getByTestId("category-chips");
    for (const id of ["all", "birthdays", "important", "bills", "subscriptions", "liabilities", "tasks", "reminders"]) {
      expect(within(chips).getByTestId(`chip-${id}`)).toBeTruthy();
    }
  });

  it("counts the reported account correctly", () => {
    mount();
    const chips = screen.getByTestId("category-chips");
    // 1 birthday + 2 merged payments + 1 task = 4 rules.
    expect(within(chips).getByTestId("chip-birthdays").textContent).toContain("1");
    expect(within(chips).getByTestId("chip-tasks").textContent).toContain("1");
    expect(within(chips).getByTestId("chip-all").textContent).toContain("4");
    // Crucially NOT the occurrence count — the old page showed 135.
    expect(within(chips).getByTestId("chip-all").textContent).not.toContain("135");
    expect(allOccurrences.length).toBeGreaterThan(20);
  });

  it("never counts a merged payment under both of its labels", () => {
    mount();
    const chips = screen.getByTestId("category-chips");
    const subs = Number(within(chips).getByTestId("chip-subscriptions").textContent!.replace(/\D/g, ""));
    const liab = Number(within(chips).getByTestId("chip-liabilities").textContent!.replace(/\D/g, ""));
    const bills = Number(within(chips).getByTestId("chip-bills").textContent!.replace(/\D/g, ""));
    expect(subs + liab + bills).toBe(2); // ChatGPT Pro + Progressive, once each
  });
});

describe("Rules view: one compact card per source", () => {
  it("renders one card per rule and no duplicates", () => {
    mount();
    const list = screen.getByTestId("rules-list");
    expect(within(list).getAllByText("ChatGPT Pro")).toHaveLength(1);
    expect(within(list).getAllByText(/Progressive Auto Insurance/)).toHaveLength(1);
    expect(within(list).getAllByText("Joe's Birthday")).toHaveLength(1);
  });

  it("shows the earliest birthday after today, not the drifted 2029 date", () => {
    mount();
    const card = screen.getByTestId(`rule-card-profile:${JOE}:birthday`);
    expect(card.textContent).toContain("February 11, 2027");
    expect(card.textContent).not.toContain("2029");
  });

  it("does NOT put a Done button on a birthday", () => {
    mount();
    const card = screen.getByTestId(`rule-card-profile:${JOE}:birthday`);
    expect(within(card).queryByTestId(`rule-primary-profile:${JOE}:birthday`)).toBeNull();
  });

  it("labels the payment primary action 'Mark paid', never 'Done'", () => {
    mount();
    const card = screen.getByTestId("rule-card-obligation:ob-chatgpt");
    const primary = within(card).getByTestId("rule-primary-obligation:ob-chatgpt");
    expect(primary.textContent).toContain("Mark paid");
    expect(primary.textContent).not.toContain("Done");
  });

  it("surfaces the liability as metadata on the merged payment", () => {
    mount();
    const card = screen.getByTestId("rule-card-obligation:ob-chatgpt");
    expect(card.textContent).toContain("Subscription");
    expect(card.textContent).toContain("Linked financial record");
  });
});

describe("category filtering", () => {
  it("narrows the Rules list to the chosen chip", () => {
    mount();
    fireEvent.click(screen.getByTestId("chip-birthdays"));
    const list = screen.getByTestId("rules-list");
    expect(within(list).getByText("Joe's Birthday")).toBeTruthy();
    expect(within(list).queryByText("ChatGPT Pro")).toBeNull();
  });

  it("shows an empty state for a category with no rules", () => {
    mount();
    fireEvent.click(screen.getByTestId("chip-reminders"));
    expect(screen.getByTestId("recurring-empty")).toBeTruthy();
  });
});

describe("Upcoming dates view", () => {
  it("groups generated dates by day", () => {
    mount();
    fireEvent.click(screen.getByTestId("view-upcoming"));
    const list = screen.getByTestId("upcoming-list");
    expect(list.textContent).toContain("JULY 30");
  });

  it("lists each payment ONCE per due date", () => {
    mount();
    fireEvent.click(screen.getByTestId("view-upcoming"));
    const list = screen.getByTestId("upcoming-list");
    // The reported bug listed ChatGPT Pro twice on Jul 30 (liability + subscription).
    const jul30 = within(list).getAllByText("ChatGPT Pro");
    const onJul30 = jul30.filter((n) => n.closest("[data-testid^='occ-row-']"));
    const dates = new Set(
      onJul30.map((n) => n.closest("[data-testid^='occ-row-']")!.getAttribute("data-testid")),
    );
    expect(dates.size).toBe(onJul30.length); // no two rows share an id/date
  });

  it("keeps rules and occurrences in separate views", () => {
    mount();
    expect(screen.queryByTestId("upcoming-list")).toBeNull();
    fireEvent.click(screen.getByTestId("view-upcoming"));
    expect(screen.queryByTestId("rules-list")).toBeNull();
    expect(screen.getByTestId("upcoming-list")).toBeTruthy();
  });
});

describe("opening an item", () => {
  it("opens the detail sheet for that exact item", () => {
    mount();
    fireEvent.click(screen.getByTestId(`rule-open-profile:${JOE}:birthday`));
    const sheet = screen.getByTestId("calendar-item-detail");
    expect(within(sheet).getByTestId("cal-detail-title").textContent).toContain("Joe's Birthday");
    expect(within(sheet).getByTestId("cal-detail-type").textContent).toContain("Birthday");
  });

  it("links the birthday to Joe's profile, not a generic list", () => {
    mount();
    fireEvent.click(screen.getByTestId(`rule-open-profile:${JOE}:birthday`));
    const link = screen.getByTestId("cal-detail-source-link");
    expect(link.textContent).toContain("Joe");
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith(`/profiles/${JOE}`);
  });

  it("shows five years of birthdays in the detail schedule", () => {
    mount();
    fireEvent.click(screen.getByTestId(`rule-open-profile:${JOE}:birthday`));
    const occ = screen.getByTestId("cal-detail-occurrences");
    for (const y of ["2027", "2028", "2029", "2030", "2031"]) {
      expect(occ.textContent, y).toContain(y);
    }
  });

  it("shows twelve months of dates for a subscription", () => {
    mount();
    fireEvent.click(screen.getByTestId("rule-open-obligation:ob-chatgpt"));
    const rows = within(screen.getByTestId("cal-detail-occurrences"))
      .getAllByTestId(/^cal-occ-/);
    expect(rows.length).toBeGreaterThanOrEqual(12);
  });
});

describe("Rules are recurring-only; Upcoming is every date", () => {
  it("keeps a one-off out of the Rules list", () => {
    mount();
    expect(within(screen.getByTestId("rules-list")).queryByText("House Viewing")).toBeNull();
  });

  it("keeps the one-off out of Upcoming too — the whole SCREEN is recurring", () => {
    // Corrected 2026-07-25: an earlier pass let one-off dates into this
    // Upcoming list on the reasoning that "dates" is broader than "rules".
    // That was wrong — a driver's-licence expiry is not a recurring date on
    // any view of it. One-off dates live on the Calendar tab.
    mount();
    fireEvent.click(screen.getByTestId("view-upcoming"));
    expect(within(screen.getByTestId("upcoming-list")).queryByText("House Viewing")).toBeNull();
  });

  it("labels a recurring date with its actual pattern, not 'One-time'", () => {
    mount();
    fireEvent.click(screen.getByTestId("view-upcoming"));
    const list = screen.getByTestId("upcoming-list");
    const row = within(list).getAllByText("ChatGPT Pro")[0].closest("[data-testid^='occ-row-']")!;
    expect(row.textContent).toMatch(/Monthly/i);
    expect(row.textContent).not.toContain("One-time");
  });
});
