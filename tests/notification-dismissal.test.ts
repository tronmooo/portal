import { describe, it, expect } from "vitest";
import {
  deadlineDismissKey,
  dismissKeysFor,
  isNotificationDismissed,
  pruneDismissedNotifications,
} from "../server/notification-service";

/**
 * A deadline speaks three times as it approaches — "due in 3 days", "is due
 * today", "Overdue" — under three ids. Dismissing one used to silence exactly
 * that one, so the bell asked again tomorrow about a thing the user had already
 * acknowledged. These cover the grouping that fixes it, and the pruning that
 * keeps the dismissal list from growing without bound.
 */
describe("notification dismissal", () => {
  const soon = { id: "task-soon-t1-2026-09-10", dismissKey: deadlineDismissKey("task", "t1", "2026-09-10") };
  const today = { id: "task-today-t1-2026-09-10", dismissKey: deadlineDismissKey("task", "t1", "2026-09-10") };
  const overdue = { id: "task-overdue-t1-2026-09-10", dismissKey: deadlineDismissKey("task", "t1", "2026-09-10") };

  it("gives every phrasing of one deadline the same key", () => {
    expect(soon.dismissKey).toBe(today.dismissKey);
    expect(today.dismissKey).toBe(overdue.dismissKey);
  });

  it("dismissing 'due soon' also silences 'due today' and 'overdue'", () => {
    const dismissed = new Set(dismissKeysFor(soon));
    expect(isNotificationDismissed(soon, dismissed)).toBe(true);
    expect(isNotificationDismissed(today, dismissed)).toBe(true);
    expect(isNotificationDismissed(overdue, dismissed)).toBe(true);
  });

  it("does not silence the SAME task's next deadline", () => {
    const dismissed = new Set(dismissKeysFor(soon));
    const nextMonth = {
      id: "task-soon-t1-2026-10-10",
      dismissKey: deadlineDismissKey("task", "t1", "2026-10-10"),
    };
    expect(isNotificationDismissed(nextMonth, dismissed)).toBe(false);
  });

  it("does not silence a DIFFERENT entity sharing a due date", () => {
    const dismissed = new Set(dismissKeysFor(soon));
    const otherTask = {
      id: "task-soon-t2-2026-09-10",
      dismissKey: deadlineDismissKey("task", "t2", "2026-09-10"),
    };
    const bill = {
      id: "bill-soon-t1-2026-09-10",
      dismissKey: deadlineDismissKey("obligation", "t1", "2026-09-10"),
    };
    expect(isNotificationDismissed(otherTask, dismissed)).toBe(false);
    expect(isNotificationDismissed(bill, dismissed)).toBe(false);
  });

  it("still honours a bare id, so dismissals stored before the key existed hold", () => {
    const legacy = new Set(["task-today-t1-2026-09-10"]);
    expect(isNotificationDismissed(today, legacy)).toBe(true);
    // …and only that one, which is exactly the old behavior.
    expect(isNotificationDismissed(overdue, legacy)).toBe(false);
  });

  describe("pruning", () => {
    const now = new Date("2026-09-04T12:00:00Z");

    it("drops entries whose date is long past", () => {
      const kept = pruneDismissedNotifications(
        ["task-soon-t1-2020-01-01", "due:task:t1:2026-09-01"],
        now,
      );
      expect(kept).toEqual(["due:task:t1:2026-09-01"]);
    });

    it("keeps recent entries", () => {
      const entries = ["due:task:t1:2026-09-01", "bill-overdue-b2-2026-08-20"];
      expect(pruneDismissedNotifications(entries, now)).toEqual(entries);
    });

    it("reads the LAST date in a key, not a date inside an id", () => {
      // A uuid never contains a YYYY-MM-DD, but a name might; the trailing date
      // is the one the entry is about.
      const entry = "due:task:2020-01-01-abc:2026-09-01";
      expect(pruneDismissedNotifications([entry], now)).toEqual([entry]);
    });

    it("keeps entries it cannot date rather than un-dismissing them", () => {
      const entry = "custom:9f2b1c";
      expect(pruneDismissedNotifications([entry], now)).toEqual([entry]);
    });

    it("caps the list, keeping the most recently appended", () => {
      const many = Array.from({ length: 2100 }, (_, i) => `custom:${i}`);
      const kept = pruneDismissedNotifications(many, now);
      expect(kept).toHaveLength(2000);
      expect(kept[kept.length - 1]).toBe("custom:2099");
    });
  });
});
