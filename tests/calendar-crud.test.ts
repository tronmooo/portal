// Full CRUD sweep: every action, against every kind of record.
//
// "test it crud to see if everything works especially when I press everything."
//
// So this presses everything. For each source system it asserts which HTTP
// calls an action actually makes, that enabled actions never throw, and that
// disabled ones refuse loudly instead of silently doing nothing. The two
// destructive special cases — a birthday must not delete the person, a
// liability must not delete the debt — are pinned explicitly.
import { describe, it, expect, vi, beforeEach } from "vitest";

const requests: Array<{ method: string; url: string; body?: any }> = [];
vi.mock("@/lib/queryClient", () => ({
  apiRequest: vi.fn(async (method: string, url: string, body?: any) => {
    requests.push({ method, url, body });
    return { json: async () => ({}) };
  }),
}));
const invalidated: string[][] = [];
vi.mock("@/lib/cache-bus", () => ({
  invalidateDomains: vi.fn(async (...d: string[]) => { invalidated.push(d); }),
}));

import {
  applyCalendarAction, UnsupportedCalendarAction,
} from "../client/src/lib/calendar-mutations";
import {
  CALENDAR_ACTIONS, capabilitiesFor, can, type CalendarAction,
} from "../shared/calendar-capabilities";
import {
  generateSeriesOccurrences, type CalendarSeries, type CalendarOccurrence,
} from "../shared/calendar-occurrences";

const TODAY = "2026-07-25";

const SERIES: Record<string, CalendarSeries> = {
  subscription: {
    id: "obligation:ob-lubi", kind: "subscription", title: "Lubi",
    source: {
      system: "obligation", id: "ob-lubi", profileId: "lubi-liab",
      ownerIds: ["robert", "lubi-liab"], href: "#/profiles/lubi-liab",
      linkedRecordId: "lubi-liab", linkedLabel: "Liability",
    },
    baseDate: "2026-08-03", recurrence: "monthly", amount: 10,
  },
  liability: {
    id: "liability:mortgage", kind: "liability", title: "Mortgage",
    source: { system: "liability", id: "mortgage", profileId: "mortgage", href: "#/profiles/mortgage" },
    baseDate: "2026-08-01", recurrence: "monthly", amount: 1850, recurrenceEnd: "2041-08-01",
  },
  event: {
    id: "event:ev-trash", kind: "event", title: "Trash day",
    source: { system: "event", id: "ev-trash", profileId: "robert", href: "#/profiles/robert" },
    baseDate: "2026-07-27", recurrence: "weekly",
  },
  birthday: {
    id: "profile:joe:birthday", kind: "birthday", title: "Joe's Birthday",
    source: { system: "profile", id: "joe", profileId: "joe", href: "#/profiles/joe" },
    baseDate: "1990-02-11", recurrence: "yearly",
  },
  task: {
    id: "task:t1", kind: "task", title: "Refill prescription",
    source: { system: "task", id: "t1", profileId: "robert", href: "#/profiles/robert" },
    baseDate: "2026-08-08", recurrence: "monthly",
  },
  // A one-off TIMED task — the shape that used to be a reminder, before
  // reminders were retired on 2026-08-09.
  timedTask: {
    id: "task:t2", kind: "task", title: "Call the vet",
    source: { system: "task", id: "t2", href: "#/tasks" },
    baseDate: "2026-08-03", recurrence: "none",
  },
};

const firstOcc = (s: CalendarSeries): CalendarOccurrence =>
  generateSeriesOccurrences(s, { todayISO: TODAY })[0];

const run = (series: CalendarSeries, action: CalendarAction, newDate?: string) =>
  applyCalendarAction({
    action, series, occurrence: firstOcc(series), newDate, todayISO: TODAY,
    getEventRow: () => ({ id: series.source.id, tags: [], category: "personal", linkedProfiles: ["robert"] }),
  });

beforeEach(() => { requests.length = 0; invalidated.length = 0; });

describe("pressing everything: no enabled action throws, no disabled action lies", () => {
  for (const [name, series] of Object.entries(SERIES)) {
    it(`${name}: every enabled action completes and every disabled one refuses`, async () => {
      for (const action of CALENDAR_ACTIONS) {
        const enabled = can(series, action);
        if (enabled) {
          await expect(
            run(series, action, action === "move" ? "2026-09-09" : undefined),
            `${name}.${action}`,
          ).resolves.toBeUndefined();
        } else {
          await expect(run(series, action), `${name}.${action}`)
            .rejects.toBeInstanceOf(UnsupportedCalendarAction);
        }
      }
    });
  }

  it("every disabled action explains where to do it instead", () => {
    for (const series of Object.values(SERIES)) {
      for (const cap of capabilitiesFor(series)) {
        if (!cap.enabled) expect(cap.reason, `${series.kind}.${cap.action}`).toBeTruthy();
      }
    }
  });
});

describe("each action hits the right API", () => {
  it("checks off a subscription payment via its occurrence endpoint", async () => {
    await run(SERIES.subscription, "complete");
    expect(requests).toEqual([{
      method: "POST",
      url: "/api/obligation-occurrences/ob-lubi:2026-08-03/status",
      body: { status: "done" },
    }]);
  });

  it("skips a payment without touching the series", async () => {
    await run(SERIES.subscription, "skip");
    expect(requests[0].body).toEqual({ status: "skipped" });
    expect(requests).toHaveLength(1);
  });

  it("reschedules one payment occurrence", async () => {
    await run(SERIES.subscription, "move", "2026-09-09");
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/api/obligation-occurrences/ob-lubi:2026-08-03/reschedule",
      body: { newDueAt: "2026-09-09" },
    });
  });

  it("ends a payment series the day BEFORE the chosen occurrence", async () => {
    await run(SERIES.subscription, "deleteFuture");
    expect(requests[0]).toMatchObject({
      method: "PATCH", url: "/api/obligations/ob-lubi",
      body: { recurrenceEnd: "2026-08-02" },
    });
  });

  it("deletes a payment series outright", async () => {
    await run(SERIES.subscription, "deleteSeries");
    expect(requests[0]).toMatchObject({ method: "DELETE", url: "/api/obligations/ob-lubi" });
  });

  it("checks off a recurring event by writing an rd:done tag", async () => {
    await run(SERIES.event, "complete");
    expect(requests[0].method).toBe("PATCH");
    expect(requests[0].url).toBe("/api/events/ev-trash");
    expect(requests[0].body.tags).toContain("rd:done:2026-07-27");
  });

  it("moves a recurring event by skipping the slot and creating a one-off", async () => {
    await run(SERIES.event, "move", "2026-07-29");
    expect(requests).toHaveLength(2);
    expect(requests[0].body.tags).toContain("rd:skip:2026-07-27");
    expect(requests[1]).toMatchObject({
      method: "POST", url: "/api/events",
      body: { date: "2026-07-29", recurrence: "none", title: "Trash day" },
    });
  });

  it("completes a task-backed date at its own endpoint", async () => {
    // Tasks have no per-occurrence storage, so completion is disabled and the
    // user is told to do it on the task.
    expect(can(SERIES.task, "complete")).toBe(false);
    await run(SERIES.task, "deleteFuture");
    expect(requests[0]).toMatchObject({ method: "PATCH", url: "/api/tasks/t1" });
  });

  it("deletes a one-off timed task rather than pretending it has a series", async () => {
    await run(SERIES.timedTask, "deleteOccurrence");
    expect(requests[0]).toMatchObject({ method: "DELETE", url: "/api/tasks/t2" });
  });
});

describe("destructive actions never destroy the wrong record", () => {
  it("removing a birthday clears the DATE, never the person", async () => {
    await run(SERIES.birthday, "deleteSeries");
    // Via `fieldsToDelete`, the app's universal delete: it matches on field
    // IDENTITY across the top level and every nested group, so it reaches a
    // date wherever it is stored. A `fields` patch for a nested group would
    // REPLACE that group and take every sibling field with it.
    expect(requests).toEqual([{
      method: "PATCH", url: "/api/profiles/joe", body: { fieldsToDelete: ["birthday"] },
    }]);
    // Emphatically not a DELETE on the profile.
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("clears the anniversary field for an anniversary", async () => {
    await run({ ...SERIES.birthday, kind: "anniversary" }, "deleteSeries");
    expect(requests[0].body).toEqual({ fieldsToDelete: ["anniversary"] });
  });

  it("clears the field the date actually came from, not a guessed one", async () => {
    // A profile-sourced series used to only ever be a birthday. It can now be
    // any date a person carries, and guessing wiped their date of birth while
    // leaving the date they asked to remove.
    await run(
      { ...SERIES.birthday, kind: "expiration", recurrence: "none",
        source: { ...SERIES.birthday.source, field: "identity.passportExpiration" } } as any,
      "deleteSeries",
    );
    expect(requests[0].body).toEqual({ fieldsToDelete: ["passportExpiration"] });
  });

  it("stopping a liability pauses the schedule, never deletes the debt", async () => {
    await run(SERIES.liability, "deleteSeries");
    expect(requests).toEqual([{
      method: "PATCH", url: "/api/profiles/mortgage", body: { fields: { paused: true } },
    }]);
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("deleting ONE occurrence of a recurring series is a skip, not a delete", async () => {
    await run(SERIES.event, "deleteOccurrence");
    expect(requests[0].method).toBe("PATCH");
    expect(requests[0].body.tags).toContain("rd:skip:2026-07-27");
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
  });
});

describe("every mutation refreshes the calendar", () => {
  it("invalidates the shared domains so the grid updates without a reload", async () => {
    await run(SERIES.subscription, "complete");
    expect(invalidated).toHaveLength(1);
    for (const d of ["events", "obligations", "liabilities", "profiles", "tasks", "notifications", "dashboard"]) {
      expect(invalidated[0], d).toContain(d);
    }
  });

  it("does not fire a request or an invalidation for edit (it is navigation)", async () => {
    await run(SERIES.subscription, "edit");
    expect(requests).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
  });
});

describe("guard rails", () => {
  it("refuses a per-occurrence action with no occurrence", async () => {
    await expect(applyCalendarAction({
      action: "complete", series: SERIES.subscription, todayISO: TODAY,
    })).rejects.toThrow(/needs an occurrence/i);
  });

  it("refuses a move with no target date", async () => {
    await expect(applyCalendarAction({
      action: "move", series: SERIES.subscription,
      occurrence: firstOcc(SERIES.subscription), todayISO: TODAY,
    })).rejects.toThrow(/target date/i);
  });

  it("makes no partial write when an action is rejected", async () => {
    await expect(run(SERIES.birthday, "skip")).rejects.toBeInstanceOf(UnsupportedCalendarAction);
    expect(requests).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
  });
});
