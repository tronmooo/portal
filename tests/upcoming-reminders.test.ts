// Pins reminders in the cross-app Upcoming Dates feed. Regression source
// (user report 2026-07-15): reminders created via chat ("remind me to take
// evening medication") never appeared on the dashboard — the aggregator
// didn't consume /api/reminders at all, and the Executive briefing row read
// a nonexistent `dueDate` field (reminders only carry `fireAt`).
import { describe, it, expect } from "vitest";
import { aggregateUpcomingDates, CATEGORY_LABELS, CATEGORY_ICONS } from "@shared/upcoming-dates";

function isoAt(daysFromNow: number, hour = 18): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

const reminder = (over: Record<string, any> = {}) => ({
  id: "rem-1",
  title: "Take evening medication",
  fireAt: isoAt(0),
  firedAt: null,
  profileId: null,
  ...over,
});

describe("aggregateUpcomingDates — reminders", () => {
  it("surfaces an un-fired reminder with its fire day and time", () => {
    const items = aggregateUpcomingDates({ reminders: [reminder()] });
    const r = items.find((i) => i.category === "reminder");
    expect(r, "reminder appears in the Upcoming feed").toBeTruthy();
    expect(r!.title).toBe("Take evening medication");
    expect(r!.daysUntil).toBe(0);
    expect(r!.timeframe).toBe("today");
    expect(r!.subtitle).toMatch(/\d{1,2}:\d{2}/); // fire time shown
    expect(r!.icon).toBe(CATEGORY_ICONS.reminder);
    expect(CATEGORY_LABELS.reminder).toBe("Reminder");
  });

  it("excludes fired, deleted, past, and beyond-window reminders", () => {
    const items = aggregateUpcomingDates({
      reminders: [
        reminder({ id: "fired", firedAt: isoAt(-1) }),
        reminder({ id: "past", fireAt: isoAt(-3) }),
        reminder({ id: "far", fireAt: isoAt(90) }),
        reminder({ id: "invalid", fireAt: "banana" }),
        reminder({ id: "keep", fireAt: isoAt(2) }),
      ],
    });
    const cats = items.filter((i) => i.category === "reminder");
    expect(cats.length).toBe(1);
    expect(cats[0].sourceId).toBe("keep");
  });

  it("dedupes a reminder against its mirrored calendar event (same title, same day)", () => {
    const today = new Date();
    const evDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const items = aggregateUpcomingDates({
      events: [{ id: "ev-1", title: "Take evening medication", date: evDate }],
      reminders: [reminder()],
    });
    const matching = items.filter((i) => i.title.toLowerCase() === "take evening medication");
    expect(matching.length).toBe(1);
    expect(matching[0].category).not.toBe("reminder"); // the event wins
  });

  it("carries the reminder's profile for scope filtering", () => {
    const items = aggregateUpcomingDates({ reminders: [reminder({ profileId: "prof-9" })] });
    const r = items.find((i) => i.category === "reminder");
    expect(r!.relatedProfileId).toBe("prof-9");
  });
});
