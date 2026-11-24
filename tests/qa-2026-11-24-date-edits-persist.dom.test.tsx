// @vitest-environment jsdom
//
// Owner report 2026-11-24, two dates that did not stay changed:
//   · Liabilities → a subscription's Edit → "Next Billing": the date read
//     blank when the dialog was reopened, although it had said "All changes
//     saved". The dialog's date box autosaved every keystroke the browser
//     reported — "0002-12-05", "0020-12-05", "0202-12-05" while 2026 was
//     typed, "" while a part was blank — so half-typed years were refused or
//     stored, and a blank part cleared the stored date.
//   · Calendar → Edit an event's date from Nov 24 to Nov 26: an event stored
//     with an end date could not be moved at all (the new start fell after
//     the old end and the edit was refused), and for any event the open
//     detail lost track of it — the item id carries the date — and fell back
//     to the tap's snapshot, still reading "Tuesday, November 24".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient(), apiRequest: (...a: any[]) => apiRequest(...a), BROWSER_TIMEZONE: "UTC", getQueryFn: () => async () => null };
});

import { EditProfileDialog } from "@/pages/profile-detail";
import { liveTimelineItem } from "@/lib/calendar-live-item";
import { carryEventSpan, eventSpanError } from "@shared/event-span";
import { MemStorage } from "../server/storage";

const ok = () => Promise.resolve({ ok: true, json: async () => ({}) });
const patches = () => apiRequest.mock.calls.filter((c) => c[0] === "PATCH").map((c) => c[2]);

const subscription = (fields: Record<string, any> = {}) => ({
  id: "sub-1", name: "Streaming Plus", type: "subscription", notes: "", fields: { cost: 12, frequency: "monthly", ...fields },
} as any);

function openDialog(profile = subscription()) {
  const onSaved = vi.fn();
  const r = render(<EditProfileDialog open profile={profile} onClose={() => {}} onSaved={onSaved} />);
  const field = () => document.querySelector('[data-testid="input-field-renewalDate"]') as HTMLInputElement;
  return { ...r, field, onSaved };
}

beforeEach(() => { apiRequest.mockReset(); apiRequest.mockImplementation(ok); });
afterEach(cleanup);

describe("Liabilities → Next Billing: a date is saved whole, or not at all", () => {
  it("the field is a date box, and opening the dialog writes nothing", async () => {
    const { field } = openDialog();
    expect(field()).toBeTruthy();
    expect(field().type).toBe("date");
    await new Promise((r) => setTimeout(r, 1000));
    expect(patches()).toEqual([]);
  });

  it("typing 12/05/2026 digit by digit sends the whole day once — never year 2, 20 or 202", async () => {
    const { field } = openDialog();
    fireEvent.focus(field());
    for (const v of ["0002-12-05", "0020-12-05", "0202-12-05"]) {
      fireEvent.change(field(), { target: { value: v } });
      await new Promise((r) => setTimeout(r, 900)); // longer than the autosave pause
    }
    expect(patches()).toEqual([]);
    fireEvent.change(field(), { target: { value: "2026-12-05" } });
    fireEvent.blur(field());
    await waitFor(() => expect(patches()).toEqual([{ fields: { renewalDate: "2026-12-05" } }]));
    await new Promise((r) => setTimeout(r, 1000));
    expect(patches()).toHaveLength(1);
  });

  it("a stored date is not cleared while a part of it is being retyped", async () => {
    const { field } = openDialog(subscription({ renewalDate: "2026-12-05" }));
    expect(field().value).toBe("2026-12-05");
    fireEvent.focus(field());
    // The browser reports "" while one part is blank, with badInput set.
    Object.defineProperty(field(), "validity", { configurable: true, value: { badInput: true } });
    fireEvent.change(field(), { target: { value: "" } });
    await new Promise((r) => setTimeout(r, 1000));
    expect(patches()).toEqual([]);
    fireEvent.blur(field());
    await new Promise((r) => setTimeout(r, 1000));
    expect(patches()).toEqual([]);
    expect(field().value).toBe("2026-12-05");
  });

  it("a value typed while a save is failing is still sent when the dialog closes", async () => {
    let fail!: (e: Error) => void;
    apiRequest.mockImplementationOnce(() => new Promise((_r, rej) => { fail = rej; }));
    const { field, getByTestId, unmount } = openDialog();
    fireEvent.change(field(), { target: { value: "2026-12-05" } });
    await waitFor(() => expect(patches()).toHaveLength(1));
    fireEvent.change(getByTestId("input-profile-notes"), { target: { value: "family plan" } });
    fireEvent.blur(getByTestId("input-profile-notes"));
    unmount(); // Done: no autosave timer is left to try again
    await act(async () => { fail(new Error("503: busy")); });
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]).toEqual({ notes: "family plan", fields: { renewalDate: "2026-12-05" } });
  });
});

describe("Calendar → moving an event", () => {
  it("moving the start carries the end with it, so the edit is not refused", () => {
    const stored = { date: "2026-11-24", endDate: "2026-11-24", allDay: true };
    const patch = carryEventSpan(stored, { title: "Renamed", date: "2026-11-26" });
    expect(patch).toEqual({ title: "Renamed", date: "2026-11-26", endDate: "2026-11-26" });
    expect(eventSpanError({ ...stored, ...patch })).toBeNull();
    // Without it the merged record runs backwards — the refusal the owner hit.
    expect(eventSpanError({ ...stored, title: "Renamed", date: "2026-11-26" })).toMatch(/cannot end/);
    // A multi-day span keeps its length; an explicit end date is the caller's.
    expect(carryEventSpan({ date: "2026-11-24", endDate: "2026-11-27" }, { date: "2026-11-30" }).endDate).toBe("2026-12-03");
    expect(carryEventSpan({ date: "2026-11-24", endDate: "2026-11-27" }, { date: "2026-11-26", endDate: "2026-11-26" }).endDate).toBe("2026-11-26");
    expect(carryEventSpan({ date: "2026-11-24" }, { date: "2026-11-26" })).toEqual({ date: "2026-11-26" });
  });

  it("the storage writes the moved event, title AND date", async () => {
    const s = new MemStorage();
    const ev = await s.createEvent({ title: "Dentist", date: "2026-11-24", endDate: "2026-11-24", allDay: true } as any);
    const out = await s.updateEvent(ev.id, { title: "Dentist (moved)", date: "2026-11-26" } as any);
    expect(out?.title).toBe("Dentist (moved)");
    expect(out?.date).toBe("2026-11-26");
    expect(out?.endDate).toBe("2026-11-26");
  });

  it("the open detail follows the event to its new day, not the tap's snapshot", () => {
    const opened = { id: "event-e1-2026-11-24", type: "event", sourceId: "e1", title: "Dentist", date: "2026-11-24" };
    const now = [
      { id: "task-t1", type: "task", sourceId: "t1", title: "Other", date: "2026-11-24" },
      { id: "event-e1-2026-11-26", type: "event", sourceId: "e1", title: "Dentist (moved)", date: "2026-11-26" },
    ];
    expect(liveTimelineItem(opened, now)).toEqual(now[1]);
    // A series: the occurrence nearest the one that was open.
    const series = [
      { id: "event-e2-2026-11-17", type: "event", sourceId: "e2", date: "2026-11-17" },
      { id: "event-e2-2026-11-25", type: "event", sourceId: "e2", date: "2026-11-25" },
      { id: "event-e2-2026-12-02", type: "event", sourceId: "e2", date: "2026-12-02" },
    ];
    expect(liveTimelineItem({ id: "event-e2-2026-11-24", type: "event", sourceId: "e2", date: "2026-11-24" }, series)?.id).toBe("event-e2-2026-11-25");
    // Gone from the window: the snapshot, as before.
    expect(liveTimelineItem(opened, [now[0]])).toBe(opened);
  });
});
