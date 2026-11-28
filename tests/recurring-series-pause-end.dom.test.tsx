// @vitest-environment jsdom
//
// A repeating event that is paused can be resumed from the screen, and "End
// series" is offered only where it can be stored (integrity run 2026-11-27,
// ui-planning.recurring-event, desktop and phone):
//
//   • Calendar → a date → Edit series → Advanced → Pause stored rd:paused and
//     took every date off the Calendar. Recurring & Important then said
//     "Paused — resume to schedule dates", but its card menu had no Resume,
//     and "Open details" / "Edit" opened nothing (a paused series generates no
//     occurrence, and the page opened the detail only on one).
//   • "End series — Stops before <first date>" was offered on a series whose
//     first date was still the next one. A repeating event cannot stop before
//     its first date, so the route answered 400 and the screen said "Couldn't
//     complete that" (O4: an action that does not apply is not on the screen).
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({ Link: ({ children }: any) => <>{children}</>, useLocation: () => ["/", vi.fn()] }));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@/lib/cache-bus", () => ({ invalidateDomains: vi.fn().mockResolvedValue(undefined) }));

import { seriesFromEvents } from "../shared/calendar-adapters";
import { generateSeriesOccurrences, type CalendarOccurrence } from "../shared/calendar-occurrences";
import { canEndSeriesBefore, cardActionsFor, canPauseSeries } from "../shared/calendar-capabilities";

const TODAY = "2026-11-27";
const EVENTS = [
  // Weekly from Dec 1 — its first date is still ahead, and paused.
  { id: "ev-choir", title: "Choir", date: "2026-12-01", recurrence: "weekly", allDay: true,
    category: "personal", linkedProfiles: [], tags: ["rd:paused", "rd:skip:2026-12-08"] },
  // Weekly from Dec 1, live.
  { id: "ev-band", title: "Band", date: "2026-12-01", recurrence: "weekly", allDay: true,
    category: "personal", linkedProfiles: [], tags: [] },
];
const SERIES = seriesFromEvents(EVENTS);
const choir = SERIES.find((s) => s.source.id === "ev-choir")!;
const band = SERIES.find((s) => s.source.id === "ev-band")!;
const occBySeries = new Map<string, CalendarOccurrence[]>(SERIES.map((s) => [s.id, generateSeriesOccurrences(s, { todayISO: TODAY })]));

vi.mock("@/hooks/useCalendarOccurrences", () => ({
  useCalendarOccurrences: () => ({
    occurrences: [...occBySeries.values()].flat(),
    series: SERIES,
    allSeries: SERIES,
    duplicatesBySeries: new Map(),
    occurrencesForSeries: (id: string) => occBySeries.get(id) || [],
    getEventRow: (id: string) => EVENTS.find((e) => e.id === id),
    profileName: () => undefined,
    todayISO: TODAY,
    isLoading: false,
    sourceErrors: [],
  }),
}));

import { RecurringDatesPage } from "../client/src/components/recurring/RecurringDatesPage";
import { CalendarItemDetail } from "../client/src/components/calendar/CalendarItemDetail";

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => [] } } });
beforeEach(() => {
  toast.mockClear();
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(cleanup);
const writes = () => apiRequest.mock.calls.filter(([m]) => m !== "GET").map(([m, u, b]) => ({ m, u, b }));
const openMenu = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.keyDown(el, { key: "Enter" });
};

describe("the rules behind the screens", () => {
  it("End series is not offered before an event's first date, and is after it", () => {
    expect(choir.paused).toBe(true);
    expect(canEndSeriesBefore(band, "2026-12-01")).toBe(false);
    expect(canEndSeriesBefore(band, "2026-12-08")).toBe(true);
    expect(canPauseSeries(band)).toBe(true);
  });
  it("a card with no next date offers nothing that acts on one", () => {
    const actions = cardActionsFor(choir, null).map((c) => c.action);
    expect(actions).toEqual(["edit", "deleteSeries"]);
    const live = cardActionsFor(band, "2026-12-01").map((c) => c.action);
    expect(live).toContain("skip");
    expect(live).not.toContain("deleteFuture");
  });
});

describe("a paused series can be resumed from Recurring & Important", () => {
  it("the card says paused, and its menu offers Resume, which clears the flag on the stored row", async () => {
    render(<QueryClientProvider client={qc()}><RecurringDatesPage filterIds={[]} filterMode="everyone" /></QueryClientProvider>);
    const card = screen.getByTestId(`rule-card-${choir.id}`);
    expect(card.textContent).toMatch(/paused/i);
    openMenu(within(card).getByTestId(`rule-menu-${choir.id}`));
    const resume = await screen.findByTestId(`rule-resume-${choir.id}`);
    // nothing in the menu acts on a date the paused series does not have
    expect(screen.queryByTestId(`rule-action-${choir.id}-skip`)).toBeNull();
    expect(screen.queryByTestId(`rule-action-${choir.id}-deleteFuture`)).toBeNull();
    fireEvent.click(resume);
    await waitFor(() => expect(writes()).toEqual([{ m: "POST", u: "/api/events/ev-choir/series-flag", b: { flag: "paused", on: false } }]));
    // the live series' card has no Resume
    openMenu(within(screen.getByTestId(`rule-card-${band.id}`)).getByTestId(`rule-menu-${band.id}`));
    await screen.findByTestId(`rule-action-${band.id}-skip`);
    expect(screen.queryByTestId(`rule-resume-${band.id}`)).toBeNull();
  });

  it("Open details opens the paused series' detail, which offers Resume", async () => {
    render(<QueryClientProvider client={qc()}><RecurringDatesPage filterIds={[]} filterMode="everyone" /></QueryClientProvider>);
    fireEvent.click(screen.getByTestId(`rule-open-${choir.id}`));
    const sheet = await screen.findByTestId("calendar-item-detail");
    expect(within(sheet).getByTestId("cal-detail-paused")).toBeTruthy();
    // opening wrote nothing (Rule 3)
    expect(writes()).toEqual([]);
    fireEvent.click(within(sheet).getByTestId("cal-resume"));
    await waitFor(() => expect(writes()).toEqual([{ m: "POST", u: "/api/events/ev-choir/series-flag", b: { flag: "paused", on: false } }]));
  });

  it("the card's Edit opens the series editor in place, whose Advanced tab offers Resume", async () => {
    render(<QueryClientProvider client={qc()}><RecurringDatesPage filterIds={[]} filterMode="everyone" /></QueryClientProvider>);
    openMenu(within(screen.getByTestId(`rule-card-${choir.id}`)).getByTestId(`rule-menu-${choir.id}`));
    fireEvent.click(await screen.findByTestId(`rule-action-${choir.id}-edit`));
    await screen.findByTestId("cal-edit-screen");
    fireEvent.click(screen.getByTestId("cal-edit-tab-advanced"));
    expect(screen.queryByTestId("cal-edit-pause")).toBeNull();
    fireEvent.click(screen.getByTestId("cal-edit-resume"));
    await waitFor(() => expect(writes()).toContainEqual({ m: "POST", u: "/api/events/ev-choir/series-flag", b: { flag: "paused", on: false } }));
  });
});

describe("End series is offered only where it can be stored (O4)", () => {
  const mount = (events: any[]) => {
    const s = seriesFromEvents(events)[0];
    const occ = generateSeriesOccurrences(s, { todayISO: TODAY });
    const open = occ.find((o) => o.status !== "done" && o.status !== "skipped")!;
    render(<QueryClientProvider client={qc()}>
      <CalendarItemDetail occurrence={open} seriesOccurrences={occ} todayISO={TODAY}
        getEventRow={(id) => events.find((e) => e.id === id)} onClose={vi.fn()} />
    </QueryClientProvider>);
  };
  it("not while the next date is the series' first", () => {
    mount([EVENTS[1]]);
    fireEvent.click(screen.getByTestId("cal-action-more"));
    const sheet = screen.getByTestId("cal-action-sheet");
    expect(within(sheet).queryByTestId("cal-action-deleteFuture")).toBeNull();
    expect(within(sheet).getByTestId("cal-action-deleteSeries")).toBeTruthy();
  });
  it("once the first date is checked off, it ends the series the day before the next date", () => {
    mount([{ ...EVENTS[1], tags: ["rd:done:2026-12-01"] }]);
    fireEvent.click(screen.getByTestId("cal-action-more"));
    const sheet = screen.getByTestId("cal-action-sheet");
    expect(within(sheet).getByTestId("cal-action-deleteFuture").textContent).toContain("Dec 8");
  });
});
