// @vitest-environment jsdom
//
// Regression guard for the calendar data-loss bug (audit 2026-07-25): clicking
// "Edit" in the event detail modal destroyed the event. Two things made that
// possible and both are asserted here:
//   1. The footer used <DialogFooter>, which is `flex-col-reverse` below the
//      `sm` breakpoint — it rendered Delete in the slot where Edit appears.
//      Edit must come before Delete in DOM order AND the container must not
//      reverse it.
//   2. Delete fired immediately with no confirmation, so a single mis-aimed
//      tap was unrecoverable. Delete must now be confirm-gated.
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { apiRequest } = vi.hoisted(() => ({
  apiRequest: vi.fn(async () => new Response("{}", { status: 200 })),
}));

vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest, recoverWedgedQueries: vi.fn() };
});

vi.mock("wouter", () => ({
  useLocation: () => ["/calendar", vi.fn()],
  Link: ({ children }: any) => <>{children}</>,
}));

import { EventDetailDialog } from "../client/src/components/CalendarView";

const item: any = {
  id: "t1",
  type: "event",
  sourceId: "evt-1",
  title: "QA Test Event - Recurring",
  date: "2026-07-22",
  time: "10:00",
  endTime: "11:00",
  category: "work",
  linkedProfiles: [],
  meta: {},
};

function renderDialog(onEdit = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <EventDetailDialog open onClose={vi.fn()} item={item} onEdit={onEdit} />
    </QueryClientProvider>,
  );
  return onEdit;
}

beforeEach(() => apiRequest.mockClear());
afterEach(cleanup);

describe("calendar event detail actions", () => {
  it("Edit calls onEdit and never issues a DELETE", () => {
    const onEdit = renderDialog();
    fireEvent.click(screen.getByTestId("btn-edit-event-detail"));

    expect(onEdit).toHaveBeenCalledTimes(1);
    const methods = apiRequest.mock.calls.map((c: any[]) => c[0]);
    expect(methods).not.toContain("DELETE");
    expect(screen.queryByTestId("dialog-confirm-delete-event")).toBeNull();
  });

  it("Delete only opens a confirmation — it does not delete on the first click", () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("btn-delete-event-detail"));

    const methods = apiRequest.mock.calls.map((c: any[]) => c[0]);
    expect(methods).not.toContain("DELETE");
    expect(screen.getByTestId("dialog-confirm-delete-event")).toBeTruthy();
  });

  it("Delete goes through only after the confirmation is accepted", async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId("btn-delete-event-detail"));
    fireEvent.click(screen.getByTestId("btn-confirm-delete-event"));
    await vi.waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith("DELETE", "/api/events/evt-1");
    });
  });

  it("Edit renders before Delete and the footer does not reverse child order", () => {
    renderDialog();
    const edit = screen.getByTestId("btn-edit-event-detail");
    const del = screen.getByTestId("btn-delete-event-detail");

    // Node.DOCUMENT_POSITION_FOLLOWING === 4
    expect(edit.compareDocumentPosition(del) & 4).toBeTruthy();
    const footer = del.parentElement!;
    expect(footer.className).not.toContain("flex-col-reverse");
  });
});
