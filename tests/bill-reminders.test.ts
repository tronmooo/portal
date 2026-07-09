import { describe, it, expect } from "vitest";
import { normalizeReminderLeads, reminderFireDate, reminderLeadsLabel } from "../shared/bill-reminders";

// Multi-offset bill reminders: "remind me 7 days, 3 days, and the morning of
// the due date" → reminderLeadDays [7,3,0]. One create_obligation call carries
// the whole reminder schedule; the due-scan cron fans out one reminder per
// offset per occurrence. These helpers are shared by the AI handler, storage,
// the cron, and the client schedule UI.
describe("normalizeReminderLeads", () => {
  it("returns [] for unset values", () => {
    expect(normalizeReminderLeads(null)).toEqual([]);
    expect(normalizeReminderLeads(undefined)).toEqual([]);
  });

  it("wraps a legacy single integer", () => {
    expect(normalizeReminderLeads(3)).toEqual([3]);
    expect(normalizeReminderLeads(0)).toEqual([0]); // morning-of only
    expect(normalizeReminderLeads("5")).toEqual([5]); // string-typed field data
  });

  it("normalizes the multi-offset request shape [7,3,0]", () => {
    expect(normalizeReminderLeads([7, 3, 0])).toEqual([7, 3, 0]);
  });

  it("dedupes, sorts descending, and drops out-of-range offsets", () => {
    expect(normalizeReminderLeads([0, 3, 3, 7, -1, 90, NaN as any])).toEqual([7, 3, 0]);
  });

  it("caps at 5 offsets", () => {
    expect(normalizeReminderLeads([1, 2, 3, 4, 5, 6, 7])).toEqual([7, 6, 5, 4, 3]);
  });

  it("returns [] for garbage", () => {
    expect(normalizeReminderLeads("soon")).toEqual([]);
    expect(normalizeReminderLeads([-4, 999])).toEqual([]);
  });
});

describe("reminderFireDate", () => {
  it("subtracts lead days from the due date", () => {
    expect(reminderFireDate("2026-08-18", 7)).toBe("2026-08-11");
    expect(reminderFireDate("2026-08-18", 3)).toBe("2026-08-15");
    expect(reminderFireDate("2026-08-18", 0)).toBe("2026-08-18"); // morning of
  });

  it("crosses month and year boundaries", () => {
    expect(reminderFireDate("2026-03-02", 7)).toBe("2026-02-23");
    expect(reminderFireDate("2027-01-01", 3)).toBe("2026-12-29");
  });

  it("handles leap-day arithmetic", () => {
    expect(reminderFireDate("2028-03-01", 1)).toBe("2028-02-29");
  });
});

describe("reminderLeadsLabel", () => {
  it("is null when no reminders configured", () => {
    expect(reminderLeadsLabel(null)).toBeNull();
    expect(reminderLeadsLabel([])).toBeNull();
  });

  it("labels legacy single lead", () => {
    expect(reminderLeadsLabel(3)).toBe("3d before due");
  });

  it("labels the [7,3,0] shape with 'morning of'", () => {
    expect(reminderLeadsLabel([7, 3, 0])).toBe("7d, 3d, morning of before due");
  });
});
