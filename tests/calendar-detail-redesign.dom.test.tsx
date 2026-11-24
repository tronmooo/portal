// @vitest-environment jsdom
//
// The calendar detail screen, rendered for real (owner request 2026-11-21).
//
// The panel it replaces printed the same seven buttons for every kind of date
// and greyed out the ones that did not apply — a birthday showed five dead
// buttons. These mounts pin the redesign's promises:
//
//   • an action that does not apply is not on the screen;
//   • each per-date action says how far it reaches, and acts on THAT date;
//   • skipping is a skip, never a delete; a delete takes two taps (Rule 8);
//   • opening Edit writes nothing (Rule 3), and Save sends only what changed.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigate = vi.fn();
vi.mock("wouter", () => ({ useLocation: () => ["/", navigate] }));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
const applyCalendarAction = vi.fn().mockResolvedValue(undefined);
const restoreOccurrence = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/calendar-mutations", () => ({
  applyCalendarAction: (...a: any[]) => applyCalendarAction(...a),
  applyCalendarMoneyAction: vi.fn().mockResolvedValue(undefined),
  restoreOccurrence: (...a: any[]) => restoreOccurrence(...a),
  refreshCalendarSurfaces: vi.fn().mockResolvedValue(undefined),
}));
const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: { invalidateQueries: vi.fn() },
}));

import { CalendarItemDetail } from "../client/src/components/calendar/CalendarItemDetail";
import { seriesFromEvents, seriesFromTasks } from "../shared/calendar-adapters";
import { generateSeriesOccurrences, type CalendarSeries } from "../shared/calendar-occurrences";

const TODAY = "2026-11-21";

const EVENTS = [
  { id: "ev-kelly", title: "Kelly's Birthday", date: "2027-09-22", recurrence: "yearly", allDay: true,
    category: "family", description: "Plan celebration.", linkedProfiles: [],
    tags: ["rdate", "rd:kind:birthday", "rd:remind:7"] },
  { id: "ev-trash", title: "Trash day", date: "2026-10-05", recurrence: "weekly", allDay: true,
    category: "other", linkedProfiles: [],
    tags: ["rdate", "rd:kind:maintenance", "rd:require", "rd:done:2026-11-09", "rd:skip:2026-11-16"] },
];
const TASKS = [
  { id: "t-mow", title: "Mow the Lawn", status: "todo", priority: "medium", dueDate: "2026-12-15",
    tags: ["recur:monthly", "ranchor:15", "rskip:2026-10-15"], linkedProfiles: [] },
  { id: "t-done", title: "Mow the Lawn", status: "done", dueDate: "2026-11-15",
    tags: ["recur:monthly", "ranchor:15"], linkedProfiles: [] },
];

const ALL: CalendarSeries[] = [...seriesFromEvents(EVENTS), ...seriesFromTasks(TASKS)];
const onClose = vi.fn();

function mount(seriesId: string, tappedDate?: string) {
  const series = ALL.find((s) => s.id === seriesId)!;
  const occ = generateSeriesOccurrences(series, {
    todayISO: TODAY, lookbackDays: 62, requireComplete: seriesId === "event:ev-trash",
  });
  const open = tappedDate
    ? occ.find((o) => o.date === tappedDate)!
    : occ.find((o) => o.effectiveDate >= TODAY && o.status !== "done" && o.status !== "skipped")!;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => [] } } })}>
      <CalendarItemDetail occurrence={open} seriesOccurrences={occ} todayISO={TODAY}
        getEventRow={(id) => EVENTS.find((e) => e.id === id)} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { series, occ, open };
}

beforeEach(() => {
  for (const m of [navigate, toast, applyCalendarAction, restoreOccurrence, apiRequest, onClose]) m.mockClear();
  apiRequest.mockImplementation(async (method: string, url: string) => ({
    json: async () => (method === "GET" && url === "/api/tasks/t-mow" ? TASKS[0] : {}),
  }));
});
afterEach(cleanup);

const writes = () => apiRequest.mock.calls.filter(([m]) => m !== "GET").map(([m, u, b]) => ({ m, u, b }));

describe("a birthday shows only what applies", () => {
  it("has Edit and More — no check-off, no skip, no per-date actions", () => {
    mount("event:ev-kelly");
    expect(screen.getByTestId("cal-detail-title").textContent).toBe("Kelly's Birthday");
    expect(screen.getByTestId("cal-detail-next").textContent).toContain("Sep 22, 2027");
    expect(screen.getByTestId("cal-detail-recurrence").textContent).toContain("Every year on Sep 22");
    expect(screen.getByTestId("cal-detail-ends").textContent).toContain("Never");
    expect(screen.getByTestId("cal-detail-reminders").textContent).toContain("1 active");
    expect(screen.getByTestId("cal-action-edit")).toBeTruthy();
    expect(screen.queryByTestId("cal-action-complete")).toBeNull();
    // The next-date card leads nowhere: there is nothing to do to a birthday.
    expect((screen.getByTestId("cal-detail-next") as HTMLButtonElement).disabled).toBe(true);
    // A birthday has no history to show.
    expect(screen.queryByTestId("cal-detail-history")).toBeNull();

    fireEvent.click(screen.getByTestId("cal-action-more"));
    const sheet = screen.getByTestId("cal-action-sheet");
    expect(within(sheet).getByTestId("cal-more-edit")).toBeTruthy();
    expect(within(sheet).queryByTestId("cal-action-deleteFuture")).toBeNull();
    expect(within(sheet).getByTestId("cal-action-deleteSeries").textContent).toContain("Remove from calendar");
  });
});

describe("a recurring task: one date at a time", () => {
  it("lists each action with how far it reaches", () => {
    mount("task:t-mow");
    expect(screen.getByTestId("cal-action-complete").textContent).toContain("Mark complete");
    fireEvent.click(screen.getByTestId("cal-view-all"));
    fireEvent.click(screen.getByTestId("cal-occ-2026-12-15"));
    expect(screen.getByTestId("cal-action-sheet-title").textContent).toBe("Dec 15, 2026");
    expect(screen.getByTestId("cal-menu-complete").textContent).toContain("the next one stays scheduled");
    expect(screen.getByTestId("cal-menu-skip").textContent).toContain("Keep future schedule");
    expect(screen.getByTestId("cal-menu-move").textContent).toContain("Move just this occurrence");
    expect(screen.getByTestId("cal-menu-editFuture").textContent).toContain("from this date forward");
    expect(screen.getByTestId("cal-menu-deleteOccurrence").textContent).toContain("Remove only this date");
  });

  it("a later date can be skipped or moved but not completed", () => {
    mount("task:t-mow");
    fireEvent.click(screen.getByTestId("cal-view-all"));
    fireEvent.click(screen.getByTestId("cal-occ-2027-01-15"));
    expect(screen.getByTestId("cal-menu-skip")).toBeTruthy();
    expect(screen.queryByTestId("cal-menu-complete")).toBeNull();
  });

  it("Skip skips THAT date and nothing else", async () => {
    mount("task:t-mow");
    fireEvent.click(screen.getByTestId("cal-view-all"));
    fireEvent.click(screen.getByTestId("cal-occ-2027-01-15"));
    fireEvent.click(screen.getByTestId("cal-menu-skip"));
    await waitFor(() => expect(applyCalendarAction).toHaveBeenCalledTimes(1));
    const call = applyCalendarAction.mock.calls[0][0];
    expect(call.action).toBe("skip");
    expect(call.occurrence.date).toBe("2027-01-15");
    // Skipping one date does not close the screen: the series is still there.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Change date moves only the chosen occurrence", async () => {
    mount("task:t-mow");
    fireEvent.click(screen.getByTestId("cal-view-all"));
    fireEvent.click(screen.getByTestId("cal-occ-2026-12-15"));
    fireEvent.click(screen.getByTestId("cal-menu-move"));
    // Unchanged date: nothing to do.
    expect((screen.getByTestId("cal-move-confirm") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("cal-move-date"), { target: { value: "2026-12-18" } });
    fireEvent.click(screen.getByTestId("cal-move-confirm"));
    await waitFor(() => expect(applyCalendarAction).toHaveBeenCalledTimes(1));
    expect(applyCalendarAction.mock.calls[0][0]).toMatchObject({ action: "move", newDate: "2026-12-18" });
    expect(applyCalendarAction.mock.calls[0][0].occurrence.date).toBe("2026-12-15");
  });

  it("Delete this occurrence takes two taps (Rule 8)", async () => {
    mount("task:t-mow");
    fireEvent.click(screen.getByTestId("cal-view-all"));
    fireEvent.click(screen.getByTestId("cal-occ-2026-12-15"));
    fireEvent.click(screen.getByTestId("cal-menu-deleteOccurrence"));
    expect(applyCalendarAction).not.toHaveBeenCalled();
    expect(screen.getByTestId("cal-menu-deleteOccurrence").textContent).toContain("Tap again");
    fireEvent.click(screen.getByTestId("cal-menu-deleteOccurrence"));
    await waitFor(() => expect(applyCalendarAction).toHaveBeenCalledTimes(1));
    expect(applyCalendarAction.mock.calls[0][0].action).toBe("deleteOccurrence");
  });

  it("deleting the whole series also takes two taps, from More", async () => {
    mount("task:t-mow");
    fireEvent.click(screen.getByTestId("cal-action-more"));
    fireEvent.click(screen.getByTestId("cal-action-deleteSeries"));
    expect(applyCalendarAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("cal-action-deleteSeries"));
    await waitFor(() => expect(applyCalendarAction).toHaveBeenCalledTimes(1));
    expect(applyCalendarAction.mock.calls[0][0].action).toBe("deleteSeries");
  });

  it("History lists what was completed and skipped, newest first", () => {
    mount("task:t-mow");
    expect(screen.getByTestId("cal-detail-completion").textContent).toContain("1 of 2");
    fireEvent.click(screen.getByTestId("cal-detail-history"));
    const rows = within(screen.getByTestId("cal-detail-history-list")).getAllByTestId(/^cal-history-/);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Nov 15, 2026"),
      expect.stringContaining("Oct 15, 2026"),
    ]);
    expect(rows[0].textContent).toContain("Completed");
    expect(rows[1].textContent).toContain("Skipped");
  });
});

describe("a weekly event", () => {
  it("shows a skipped date as Skipped and offers to bring it back", async () => {
    // Opened ON the skipped date, as when it is tapped in a list.
    const series = ALL.find((s) => s.id === "event:ev-trash")!;
    const occ = generateSeriesOccurrences(series, { todayISO: "2026-11-14", lookbackDays: 62, requireComplete: true });
    const skipped = occ.find((o) => o.date === "2026-11-16")!;
    expect(skipped.status).toBe("skipped");
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CalendarItemDetail occurrence={skipped} seriesOccurrences={occ} todayISO="2026-11-14"
          getEventRow={(id) => EVENTS.find((e) => e.id === id)} onClose={onClose} />
      </QueryClientProvider>,
    );
    const selected = screen.getByTestId("cal-detail-selected");
    expect(selected.textContent).toContain("Skipped");
    // The headline NEXT date steps over the skipped one.
    expect(screen.getByTestId("cal-detail-next").textContent).toContain("Nov 23, 2026");
    fireEvent.click(selected);
    expect(screen.queryByTestId("cal-menu-skip")).toBeNull();
    fireEvent.click(screen.getByTestId("cal-menu-restore"));
    await waitFor(() => expect(restoreOccurrence).toHaveBeenCalledTimes(1));
    expect(restoreOccurrence.mock.calls[0][1].date).toBe("2026-11-16");
  });
});

describe("Edit Event", () => {
  const openEdit = () => {
    mount("event:ev-kelly");
    fireEvent.click(screen.getByTestId("cal-action-edit"));
    expect((screen.getByTestId("cal-edit-title") as HTMLInputElement).value).toBe("Kelly's Birthday");
  };

  it("opens without writing anything, and Save is off until something changes", () => {
    openEdit();
    expect(writes()).toEqual([]);
    expect((screen.getByTestId("cal-edit-save") as HTMLButtonElement).disabled).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("previews the next five dates of the schedule", () => {
    openEdit();
    fireEvent.click(screen.getByTestId("cal-edit-tab-repeat"));
    expect((screen.getByTestId("cal-edit-repeat-yearly")).getAttribute("aria-checked")).toBe("true");
    const preview = within(screen.getByTestId("cal-edit-preview")).getAllByTestId(/^cal-edit-preview-/);
    expect(preview.map((p) => p.dataset.testid)).toEqual(
      ["2027", "2028", "2029", "2030", "2031"].map((y) => `cal-edit-preview-${y}-09-22`),
    );
  });

  it("adding a reminder saves the reminders alone", async () => {
    openEdit();
    fireEvent.click(screen.getByTestId("cal-edit-tab-reminders"));
    expect((screen.getByTestId("cal-edit-reminder-0") as HTMLSelectElement).value).toBe("7");
    fireEvent.click(screen.getByTestId("cal-edit-reminder-add"));
    expect((screen.getByTestId("cal-edit-reminder-1") as HTMLSelectElement).value).toBe("1");
    expect(screen.getByTestId("cal-edit-config").textContent).toContain("2 reminders");
    fireEvent.click(screen.getByTestId("cal-edit-save"));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({
      m: "POST", u: "/api/events/ev-kelly/series-settings",
      b: { kind: "birthday", reminders: [7, 1], requireComplete: false },
    });
  });

  it("'ends after 3 occurrences' is saved as the date of the third", async () => {
    openEdit();
    fireEvent.click(screen.getByTestId("cal-edit-tab-repeat"));
    fireEvent.click(screen.getByTestId("cal-edit-end-count"));
    // No number yet: the form says what is missing and will not save.
    expect(screen.getByTestId("cal-edit-problem").textContent).toContain("how many");
    expect((screen.getByTestId("cal-edit-save") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("cal-edit-end-count-input"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("cal-edit-save"));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ m: "PATCH", u: "/api/events/ev-kelly", b: { recurrenceEnd: "2029-09-22" } });
  });

  it("renaming sends the name only", async () => {
    openEdit();
    fireEvent.change(screen.getByTestId("cal-edit-title"), { target: { value: "Kelly's Bday" } });
    fireEvent.click(screen.getByTestId("cal-edit-save"));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({ m: "PATCH", u: "/api/events/ev-kelly", b: { title: "Kelly's Bday" } });
  });
});

// QA 2026-11-24: the December 8 date of a weekly series was tapped; More →
// Edit opened the series' editor dated December 1, with nothing saying the
// change was for every date and no way to the one date that was opened.
describe("one date of a series was tapped: Edit says how far it reaches (O4)", () => {
  it("More offers changing only that date, and names the other Edit as the series", () => {
    mount("event:ev-trash", "2026-12-07");
    expect(screen.getByTestId("cal-detail-selected").textContent).toContain("Dec 7, 2026");
    fireEvent.click(screen.getByTestId("cal-action-more"));
    expect(screen.getByTestId("cal-more-edit-one").textContent).toContain("Change only Dec 7, 2026");
    expect(screen.getByTestId("cal-more-edit").textContent).toContain("Edit series");
    expect(screen.getByTestId("cal-more-edit").textContent).toContain("for every date");

    // It leads to that date's own actions, and the list says whose they are.
    fireEvent.click(screen.getByTestId("cal-more-edit-one"));
    expect(screen.getByTestId("cal-action-sheet-title").textContent).toBe("Dec 7, 2026");
    expect(screen.getByTestId("cal-action-sheet-scope").textContent).toBe("Only this date");
    expect(screen.getByTestId("cal-menu-move").textContent).toContain("Move just this occurrence");
    expect(writes()).toEqual([]);
  });

  it("the series editor says it changes every date and leads back to the one date", async () => {
    mount("event:ev-trash", "2026-12-07");
    fireEvent.click(screen.getByTestId("cal-action-more"));
    fireEvent.click(screen.getByTestId("cal-more-edit"));
    await waitFor(() => expect((screen.getByTestId("cal-edit-title") as HTMLInputElement).value).toBe("Trash day"));
    expect(screen.getByTestId("cal-edit-scope").textContent).toContain("every date in this series");
    expect(screen.getByText("Series starts")).toBeTruthy();

    fireEvent.click(screen.getByTestId("cal-edit-only-date"));
    // Still the same sheet, on that date's actions — nothing closed, nothing written.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("cal-action-sheet-title").textContent).toBe("Dec 7, 2026");
    fireEvent.click(screen.getByTestId("cal-menu-move"));
    expect((screen.getByTestId("cal-move-date") as HTMLInputElement).value).toBe("2026-12-07");
    expect(writes()).toEqual([]);
  });

  it("a one-time item keeps a plain Edit and offers no per-date row", () => {
    mount("event:ev-kelly");
    fireEvent.click(screen.getByTestId("cal-action-more"));
    // A birthday has nothing to do to one date: no row that leads nowhere.
    expect(screen.queryByTestId("cal-more-edit-one")).toBeNull();
  });
});

describe("Edit Task", () => {
  it("changing the schedule goes through the schedule endpoint, not a tag rewrite", async () => {
    mount("task:t-mow");
    fireEvent.click(screen.getByTestId("cal-action-more"));
    fireEvent.click(screen.getByTestId("cal-more-edit"));
    await waitFor(() => expect((screen.getByTestId("cal-edit-title") as HTMLInputElement).value).toBe("Mow the Lawn"));
    // A task has no lead-time reminders: that tab is not offered.
    expect(screen.queryByTestId("cal-edit-tab-reminders")).toBeNull();
    fireEvent.click(screen.getByTestId("cal-edit-tab-repeat"));
    expect(screen.getByTestId("cal-edit-repeat-monthly").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("cal-edit-repeat-custom"));
    fireEvent.change(screen.getByTestId("cal-edit-interval"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("cal-edit-save"));
    await waitFor(() => expect(writes().length).toBe(1));
    expect(writes()[0]).toEqual({
      m: "POST", u: "/api/tasks/t-mow/schedule", b: { freq: "every-10-days", until: null, count: null },
    });
  });
});
