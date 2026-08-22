// @vitest-environment jsdom
//
// Regression guard for the QA 2026-08-22 report "event saved but the Month view
// never renders it".
//
// What actually happened: the appointment was created from chat (which is
// deliberately unscoped and therefore linked it to Self), while the calendar
// was scoped to another person's profile. The grid and the day panel were
// correct to hide it — but they said only "Nothing scheduled · 0 items", which
// is indistinguishable from a broken query, so a working filter was reported as
// a rendering bug.
//
// The empty state must therefore name the active filter, say how many items it
// is hiding, and offer one click to clear it.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequest, setFilterEveryone } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  setFilterEveryone: vi.fn(),
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, recoverWedgedQueries: vi.fn() };
});

vi.mock("wouter", () => ({
  useLocation: () => ["/calendar", vi.fn()],
  Link: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/lib/profileFilter", () => ({
  setFilterEveryone,
  getProfileFilter: () => ({ mode: "selected", selectedIds: ["p-sarah"], selectedNames: ["Sarah Miller"] }),
}));

import CalendarView from "../client/src/components/CalendarView";

const SARAH = { id: "p-sarah", name: "Sarah Miller", type: "person" };
const SELF = { id: "p-self", name: "Poop", type: "self" };

/** Two items the scoped view can't show: both belong to Self, not to Sarah. */
const SELF_ITEMS = [
  { id: "event-a-2026-08-22", type: "event", title: "Gym Workout", date: "2026-08-22", color: "#4F98A3", category: "personal", linkedProfiles: [SELF.id], sourceId: "a" },
  { id: "event-b-2026-08-28", type: "event", title: "Dentist Appointment", date: "2026-08-28", time: "15:00", color: "#4F98A3", category: "health", linkedProfiles: [SELF.id], sourceId: "b" },
];

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function renderCalendar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CalendarView externalFilterMode="selected" externalFilterIds={[SARAH.id]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-22T12:00:00"));
  apiRequest.mockReset();
  setFilterEveryone.mockReset();
  apiRequest.mockImplementation(async (_method: string, url: string) => {
    if (url.startsWith("/api/profiles")) return json([SELF, SARAH]);
    if (url.startsWith("/api/calendar/timeline")) {
      // Scoped request (Sarah) → nothing. Unscoped → both of Self's items.
      return json(url.includes("profileIds=") ? [] : SELF_ITEMS);
    }
    return json([]);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("calendar empty states under an active profile filter", () => {
  it("names the filter and counts what it is hiding, on the day panel and the month", async () => {
    renderCalendar();

    // Day panel for today (2026-08-22): one Self item exists, none for Sarah.
    expect(await screen.findByText("Nothing scheduled for Sarah Miller")).toBeTruthy();
    const dayNote = await screen.findByTestId("day-agenda-scope-note");
    await waitFor(() =>
      expect(dayNote.textContent).toContain("1 item hidden by the Sarah Miller filter"));

    // Month banner: both Self items fall inside August.
    const monthNote = await screen.findByTestId("month-empty-scope-note");
    await waitFor(() =>
      expect(monthNote.textContent).toContain("2 items hidden by the Sarah Miller filter"));
    expect(screen.getByText("No events this month for Sarah Miller")).toBeTruthy();
  });

  it("clears the profile filter from the empty state", async () => {
    renderCalendar();
    const btn = (await screen.findAllByTestId("btn-clear-profile-filter"))[0];
    fireEvent.click(btn);
    expect(setFilterEveryone).toHaveBeenCalledTimes(1);
  });

  it("never fires the unscoped lookup when no filter is active", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <CalendarView externalFilterMode="everyone" externalFilterIds={[]} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Nothing scheduled")).toBeTruthy();
    expect(screen.queryByTestId("day-agenda-scope-note")).toBeNull();
    // Exactly one timeline request: the view's own. No shadow fetch.
    await waitFor(() => {
      const timelineCalls = apiRequest.mock.calls.filter((c: any[]) =>
        String(c[1]).startsWith("/api/calendar/timeline"));
      expect(timelineCalls.length).toBe(1);
    });
  });
});
