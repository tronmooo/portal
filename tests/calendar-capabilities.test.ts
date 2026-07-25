// Pins the calendar action matrix: one panel, one action list, honest state.
//
// The requirement is that every calendar item uses "the exact same layout
// regardless of type" with the same actions. The systems behind those items
// are not equally capable, so the contract enforced here is: the SAME seven
// actions always appear in the SAME order, and anything a source genuinely
// cannot do is disabled with a reason pointing at where it can be done.
import { describe, it, expect } from "vitest";
import {
  CALENDAR_ACTIONS,
  ACTION_LABELS,
  capabilitiesFor,
  can,
  reasonFor,
} from "../shared/calendar-capabilities";
import type { CalendarSeries } from "../shared/calendar-occurrences";

const birthday: CalendarSeries = {
  id: "profile:joe:birthday", kind: "birthday", title: "Joe's Birthday",
  source: { system: "profile", id: "joe", profileId: "joe", href: "#/profiles/joe" },
  baseDate: "1990-02-11", recurrence: "yearly",
};

const subscription: CalendarSeries = {
  id: "obligation:n", kind: "subscription", title: "Netflix",
  source: { system: "obligation", id: "n", profileId: "me", href: "#/profiles/me" },
  baseDate: "2026-08-02", recurrence: "monthly", amount: 9.99,
};

const recurringEvent: CalendarSeries = {
  id: "event:e", kind: "appointment", title: "Dentist",
  source: { system: "event", id: "e", profileId: "me", href: "#/profiles/me" },
  baseDate: "2026-09-01", recurrence: "yearly",
};

const oneOffReminder: CalendarSeries = {
  id: "reminder:r", kind: "reminder", title: "Call mom",
  source: { system: "reminder", id: "r", href: "#/calendar" },
  baseDate: "2026-08-03", recurrence: "none",
};

const liability: CalendarSeries = {
  id: "liability:l", kind: "liability", title: "Mortgage",
  source: { system: "liability", id: "l", profileId: "l", href: "#/profiles/l" },
  baseDate: "2026-08-01", recurrence: "monthly", recurrenceEnd: "2041-08-01",
};

const everySeries = [birthday, subscription, recurringEvent, oneOffReminder, liability];

describe("the panel is identical for every type", () => {
  it("returns all seven actions, in the same order, for every series", () => {
    for (const s of everySeries) {
      expect(capabilitiesFor(s).map((c) => c.action)).toEqual([...CALENDAR_ACTIONS]);
    }
  });

  it("labels every action", () => {
    for (const a of CALENDAR_ACTIONS) {
      expect(ACTION_LABELS[a]).toBeTruthy();
    }
  });

  it("gives a reason for every disabled action — never a dead button", () => {
    for (const s of everySeries) {
      for (const c of capabilitiesFor(s)) {
        if (!c.enabled) {
          expect(c.reason, `${s.kind}/${c.action}`).toBeTruthy();
          expect(c.reason!.length).toBeGreaterThan(10);
        } else {
          expect(c.reason).toBeUndefined();
        }
      }
    }
  });

  it("always allows editing and deleting at the source", () => {
    for (const s of everySeries) {
      expect(can(s, "edit"), `${s.kind} edit`).toBe(true);
      expect(can(s, "deleteSeries"), `${s.kind} deleteSeries`).toBe(true);
    }
  });
});

describe("per-occurrence actions follow real storage", () => {
  it("enables the full set for obligations, liabilities and events", () => {
    for (const s of [subscription, liability, recurringEvent]) {
      expect(can(s, "move"), `${s.id} move`).toBe(true);
      expect(can(s, "complete"), `${s.id} complete`).toBe(true);
      expect(can(s, "skip"), `${s.id} skip`).toBe(true);
      expect(can(s, "deleteOccurrence"), `${s.id} deleteOccurrence`).toBe(true);
      expect(can(s, "deleteFuture"), `${s.id} deleteFuture`).toBe(true);
    }
  });

  it("disables per-occurrence actions for a birthday and says where to go", () => {
    expect(can(birthday, "skip")).toBe(false);
    expect(can(birthday, "complete")).toBe(false);
    expect(can(birthday, "move")).toBe(false);
    expect(reasonFor(birthday, "move")).toMatch(/profile/i);
    expect(reasonFor(birthday, "skip")).toMatch(/profile/i);
    // But it can still be edited and removed at its source.
    expect(can(birthday, "edit")).toBe(true);
    expect(can(birthday, "deleteSeries")).toBe(true);
  });

  it("treats anniversaries exactly like birthdays", () => {
    const anniversary = { ...birthday, kind: "anniversary" as const, id: "profile:joe:anniversary" };
    expect(can(anniversary, "skip")).toBe(false);
    expect(reasonFor(anniversary, "complete")).toMatch(/anniversary/i);
  });
});

describe("one-off dates have no series", () => {
  it("offers deleteOccurrence but not skip or deleteFuture", () => {
    expect(can(oneOffReminder, "deleteOccurrence")).toBe(true);
    expect(can(oneOffReminder, "skip")).toBe(false);
    expect(can(oneOffReminder, "deleteFuture")).toBe(false);
    expect(reasonFor(oneOffReminder, "deleteFuture")).toMatch(/once/i);
  });

  it("still allows editing and deleting it", () => {
    expect(can(oneOffReminder, "edit")).toBe(true);
    expect(can(oneOffReminder, "deleteSeries")).toBe(true);
  });
});
