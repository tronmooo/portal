// Consistency layer — date status engine (req. tests 12, 13).
import { describe, expect, it } from "vitest";
import { resolveDateStatus, nextImportantItem, dateInputFromTask, dateInputFromEvent, DATE_STATUS_LABEL, clockFor } from "../shared/domain";

const clock = { today: "2026-09-22", minutes: 10 * 60 + 30 }; // 10:30 AM

describe("12. Past incomplete tasks become overdue", () => {
  it("'Mow the lawn' due 9 AM, open at 10:30, is Overdue — not Due today", () => {
    const s = resolveDateStatus(dateInputFromTask({ title: "Mow the lawn", dueDate: "2026-09-22", dueTime: "09:00", status: "todo" }), clock);
    expect(s.status).toBe("overdue");
    expect(s.label).toBe("Overdue");
  });
  it("an all-day task today is due today; yesterday's open task is overdue; done is completed", () => {
    expect(resolveDateStatus(dateInputFromTask({ dueDate: "2026-09-22", status: "todo" }), clock).status).toBe("due_today");
    expect(resolveDateStatus(dateInputFromTask({ dueDate: "2026-09-21", status: "todo" }), clock).status).toBe("overdue");
    expect(resolveDateStatus(dateInputFromTask({ dueDate: "2026-09-21", status: "done" }), clock).status).toBe("completed");
    expect(resolveDateStatus(dateInputFromTask({ dueDate: "2026-09-25", status: "todo" }), clock)).toMatchObject({ status: "upcoming", daysUntil: 3 });
  });
});

describe("13. Past events stop appearing as upcoming", () => {
  it("Soccer at 7 AM is not the next event at 10:30", () => {
    const soccer = { ...dateInputFromEvent({ title: "Soccer", date: "2026-09-22", time: "07:00", endTime: "08:00" }), record: "Soccer" };
    const dentist = { ...dateInputFromEvent({ title: "Dentist", date: "2026-09-22", time: "14:00" }), record: "Dentist" };
    expect(resolveDateStatus(soccer, clock).status).toBe("completed");
    const next = nextImportantItem([soccer, dentist], clock);
    expect(next?.item.record).toBe("Dentist");
    expect(next?.status.status).toBe("upcoming");
  });
  it("an event in progress is happening now and wins", () => {
    const standup = { ...dateInputFromEvent({ date: "2026-09-22", time: "10:00", endTime: "11:00" }), record: "Standup" };
    const later = { ...dateInputFromEvent({ date: "2026-09-22", time: "12:00" }), record: "Lunch" };
    expect(nextImportantItem([later, standup], clock)?.item.record).toBe("Standup");
    expect(resolveDateStatus(standup, clock).status).toBe("happening_now");
  });
  it("documents expire, bills go overdue, and every status has one label", () => {
    expect(resolveDateStatus({ kind: "document", start: "2026-06-01" }, clock).status).toBe("expired");
    expect(resolveDateStatus({ kind: "bill", start: "2026-09-01" }, clock).status).toBe("overdue");
    expect(resolveDateStatus({ kind: "bill", start: "2026-09-01", completed: true }, clock).status).toBe("completed");
    expect(resolveDateStatus({ kind: "bill", start: "2026-09-01", status: "paused" }, clock).status).toBe("inactive");
    expect(Object.keys(DATE_STATUS_LABEL)).toHaveLength(8);
    expect(clockFor(new Date("2026-09-22T17:30:00Z"), "UTC")).toEqual({ today: "2026-09-22", minutes: 17 * 60 + 30 });
  });
});
