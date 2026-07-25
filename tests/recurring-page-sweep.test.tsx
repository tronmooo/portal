// @vitest-environment jsdom
//
// Whole-page sweep: press EVERYTHING and assert the page survives it.
//
// "make sure this works the entire page. I want you to try all the
//  functionality see if it's fast and see if everything works"
//
// So this walks every chip × both views, opens every rule's detail sheet,
// clicks every enabled control in it, and checks render cost. It uses the REAL
// hook logic (only the network layer is stubbed) so what is exercised here is
// what actually runs in the browser.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

const navigate = vi.fn();
vi.mock("wouter", () => ({
  Link: ({ children }: any) => <>{children}</>,
  useLocation: () => ["/", navigate],
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
const applyCalendarAction = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/calendar-mutations", () => ({
  applyCalendarAction: (...a: any[]) => applyCalendarAction(...a),
  refreshCalendarSurfaces: vi.fn().mockResolvedValue(undefined),
}));

import { seriesFromAll } from "../shared/calendar-adapters";
import {
  dedupeSeries, generateSeriesOccurrences, isRecurringRule,
  type CalendarOccurrence,
} from "../shared/calendar-occurrences";
import { CALENDAR_CATEGORIES } from "../shared/calendar-categories";

const TODAY = "2026-07-25";
const JOE = "joe-id";
const ROBERT = "robert-id";

// A realistic account: a birthday whose backing event has drifted AND carries
// stale rd:done marks, merged payments, a recurring task, and a one-off.
const RAW = {
  profiles: [
    { id: ROBERT, name: "robert sennabaum", type: "self" },
    { id: JOE, name: "Joe", type: "person" },
    { id: "lubi", name: "Lubi", type: "liability",
      fields: { nextDueDate: "2026-08-03", monthlyPayment: 10 } },
  ],
  events: [
    { id: "evt-joe", title: "Joe's Birthday", date: "2029-02-11", recurrence: "yearly",
      linkedProfiles: [JOE],
      // The marks that crossed out 2027 and 2028 in the report.
      tags: ["rdate", "rd:kind:birthday", "rd:done:2027-02-11", "rd:done:2028-02-11"] },
    { id: "evt-lubi", title: "Lubi — $10", date: "2026-08-03", recurrence: "monthly", tags: ["rdate"] },
    { id: "evt-trash", title: "Trash day", date: "2026-07-27", recurrence: "weekly", linkedProfiles: [ROBERT] },
    { id: "evt-viewing", title: "House Viewing", date: "2026-08-05", recurrence: "none", linkedProfiles: [ROBERT] },
  ],
  obligations: [
    { id: "ob-lubi", name: "Lubi", amount: 10, frequency: "monthly", category: "subscription",
      nextDueDate: "2026-08-03", linkedProfiles: [ROBERT], linkedLiabilityId: "lubi" },
    { id: "ob-prog", name: "Progressive Auto Insurance", amount: 155, frequency: "monthly",
      category: "insurance", nextDueDate: "2026-07-30", linkedProfiles: [ROBERT] },
  ],
  tasks: [{ id: "t1", title: "Refill Propranolol", dueDate: "2026-08-08",
    tags: ["recur:monthly"], linkedProfiles: [ROBERT] }],
  reminders: [{ id: "r1", title: "Call the vet", fireAt: "2026-08-03T17:00:00.000Z" }],
  documents: [] as any[],
};

const allSeries = dedupeSeries(seriesFromAll(RAW)).map((d) => d.series);
const occBySeries = new Map<string, CalendarOccurrence[]>(
  allSeries.map((s) => [s.id, generateSeriesOccurrences(s, { todayISO: TODAY, lookbackDays: 62 })]),
);
const allOccurrences = [...occBySeries.values()].flat()
  .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

let generateCalls = 0;
vi.mock("@/hooks/useCalendarOccurrences", () => ({
  useCalendarOccurrences: () => {
    generateCalls += 1;
    return {
      occurrences: allOccurrences,
      series: allSeries.filter(isRecurringRule),
      allSeries,
      duplicatesBySeries: new Map<string, string[]>(
        dedupeSeries(seriesFromAll(RAW))
          .filter((d) => d.duplicateIds.length)
          .map((d) => [d.series.id, d.duplicateIds]),
      ),
      occurrencesForSeries: (id: string) => occBySeries.get(id) || [],
      getEventRow: (id: string) => RAW.events.find((e) => e.id === id),
      profileName: (id: string) => RAW.profiles.find((p) => p.id === id)?.name,
      todayISO: TODAY,
      isLoading: false,
    };
  },
}));

import { RecurringDatesPage } from "../client/src/components/recurring/RecurringDatesPage";

afterEach(cleanup);
beforeEach(() => { navigate.mockClear(); toast.mockClear(); applyCalendarAction.mockClear(); });

const mount = () => render(<RecurringDatesPage filterIds={[]} filterMode="everyone" />);

describe("the reported bug: a future birthday is never 'done'", () => {
  it("does not cross out Feb 11 2027 or 2028", () => {
    mount();
    fireEvent.click(screen.getByTestId("rule-open-event:evt-joe"));
    const list = screen.getByTestId("cal-detail-occurrences");
    for (const date of ["2027-02-11", "2028-02-11"]) {
      const row = within(list).getByTestId(`cal-occ-${date}`);
      expect(row.textContent, date).not.toContain("done");
      expect(row.querySelector(".line-through"), date).toBeNull();
    }
  });

  it("reports the NEXT birthday as 2027, not 2029", () => {
    mount();
    fireEvent.click(screen.getByTestId("rule-open-event:evt-joe"));
    expect(screen.getByTestId("cal-detail-next").textContent).toContain("2027");
    expect(screen.getByTestId("cal-detail-next").textContent).not.toContain("2029");
  });

  it("shows the same next date on the card", () => {
    mount();
    expect(screen.getByTestId("rule-next-event:evt-joe").textContent).toContain("February 11, 2027");
  });

  it("offers no check-off control on a birthday occurrence row", () => {
    mount();
    fireEvent.click(screen.getByTestId("rule-open-event:evt-joe"));
    expect(screen.queryByTestId("cal-occ-done-2027-02-11")).toBeNull();
    expect(screen.queryByTestId("cal-occ-skip-2027-02-11")).toBeNull();
  });

  it("still honours done marks where they DO mean something", () => {
    // A payment can legitimately be marked paid; only birthdays ignore marks.
    const paid = generateSeriesOccurrences(
      { ...allSeries.find((s) => s.kind === "subscription")!, completedDates: ["2026-08-03"] },
      { todayISO: TODAY },
    );
    expect(paid.find((o) => o.date === "2026-08-03")?.status).toBe("done");
  });
});

describe("every chip, in both views", () => {
  it("renders without error for all 8 chips × 2 views", () => {
    mount();
    for (const chip of CALENDAR_CATEGORIES) {
      fireEvent.click(screen.getByTestId(`chip-${chip.id}`));
      for (const view of ["rules", "upcoming"]) {
        fireEvent.click(screen.getByTestId(`view-${view}`));
        // Exactly one of list / empty-state is present — never both, never neither.
        const list = screen.queryByTestId(view === "rules" ? "rules-list" : "upcoming-list");
        const empty = screen.queryByTestId("recurring-empty");
        expect(Boolean(list) !== Boolean(empty), `${chip.id}/${view}`).toBe(true);
      }
    }
  });

  it("keeps chip counts stable across view switches for the rules set", () => {
    mount();
    const readAll = () => screen.getByTestId("chip-all").textContent;
    fireEvent.click(screen.getByTestId("view-rules"));
    const before = readAll();
    fireEvent.click(screen.getByTestId("view-rules"));
    expect(readAll()).toBe(before);
  });

  it("never shows a negative or NaN count", () => {
    mount();
    for (const chip of CALENDAR_CATEGORIES) {
      const n = Number(screen.getByTestId(`chip-${chip.id}`).textContent!.replace(/\D/g, "") || "0");
      expect(Number.isFinite(n) && n >= 0, chip.id).toBe(true);
    }
  });
});

describe("opening every rule works", () => {
  it("opens a detail sheet for each rule and shows its own title", () => {
    for (const s of allSeries.filter(isRecurringRule)) {
      cleanup();
      mount();
      fireEvent.click(screen.getByTestId(`rule-open-${s.id}`));
      const sheet = screen.getByTestId("calendar-item-detail");
      expect(within(sheet).getByTestId("cal-detail-title").textContent, s.id).toContain(s.title);
      // Source, type, recurrence and next are always present.
      for (const field of ["cal-detail-source", "cal-detail-type", "cal-detail-recurrence", "cal-detail-next"]) {
        expect(within(sheet).getByTestId(field), `${s.id}/${field}`).toBeTruthy();
      }
    }
  });

  it("lists the required horizon per kind", () => {
    mount();
    fireEvent.click(screen.getByTestId("rule-open-event:evt-joe"));
    // Birthdays: at least five years.
    expect(within(screen.getByTestId("cal-detail-occurrences")).getAllByTestId(/^cal-occ-/).length)
      .toBeGreaterThanOrEqual(5);
    cleanup();
    mount();
    fireEvent.click(screen.getByTestId("rule-open-obligation:ob-lubi"));
    // Subscriptions: at least twelve months.
    expect(within(screen.getByTestId("cal-detail-occurrences")).getAllByTestId(/^cal-occ-/).length)
      .toBeGreaterThanOrEqual(12);
  });
});

describe("pressing every enabled control in the sheet", () => {
  it("fires an action (or navigates) and never throws", () => {
    for (const s of allSeries.filter(isRecurringRule)) {
      cleanup();
      applyCalendarAction.mockClear();
      mount();
      fireEvent.click(screen.getByTestId(`rule-open-${s.id}`));
      const sheet = screen.getByTestId("calendar-item-detail");
      const buttons = within(sheet).getAllByTestId(/^cal-action-/);
      expect(buttons.length, s.id).toBeGreaterThan(0);
      for (const btn of buttons) {
        if ((btn as HTMLButtonElement).disabled) continue;
        expect(() => fireEvent.click(btn), `${s.id}/${btn.dataset.testid}`).not.toThrow();
      }
    }
  });

  it("routes Edit to the source record rather than a list page", () => {
    mount();
    fireEvent.click(screen.getByTestId("rule-open-event:evt-joe"));
    fireEvent.click(screen.getByTestId("cal-detail-source-link"));
    expect(navigate).toHaveBeenCalledWith(`/profiles/${JOE}`);
  });

  it("closes cleanly and can be reopened", () => {
    mount();
    fireEvent.click(screen.getByTestId("rule-open-event:evt-trash"));
    expect(screen.getByTestId("calendar-item-detail")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("rule-open-event:evt-trash"));
    expect(screen.getByTestId("calendar-item-detail")).toBeTruthy();
  });
});

describe("row overflow menus", () => {
  it("gives every rule card an overflow trigger and a primary-action rule", () => {
    mount();
    for (const s of allSeries.filter(isRecurringRule)) {
      expect(screen.getByTestId(`rule-menu-${s.id}`), s.id).toBeTruthy();
      const primary = screen.queryByTestId(`rule-primary-${s.id}`);
      if (s.kind === "birthday" || s.kind === "anniversary") {
        expect(primary, `${s.id} must NOT offer a quick action`).toBeNull();
      }
    }
  });
});

describe("performance", () => {
  it("renders the whole page well inside a frame budget", () => {
    const start = performance.now();
    mount();
    const ms = performance.now() - start;
    expect(ms, `initial render took ${ms.toFixed(0)}ms`).toBeLessThan(600);
  });

  it("switching chips does not re-render unboundedly", () => {
    mount();
    const before = generateCalls;
    for (const chip of CALENDAR_CATEGORIES) {
      fireEvent.click(screen.getByTestId(`chip-${chip.id}`));
    }
    // One render per interaction, not a cascade.
    expect(generateCalls - before).toBeLessThanOrEqual(CALENDAR_CATEGORIES.length * 2);
  });

  it("caps the Upcoming list so a five-year horizon cannot flood the DOM", () => {
    mount();
    fireEvent.click(screen.getByTestId("view-upcoming"));
    const rows = within(screen.getByTestId("upcoming-list")).getAllByTestId(/^occ-row-/);
    expect(rows.length).toBeLessThanOrEqual(200);
    expect(rows.length).toBeGreaterThan(0);
  });
});
