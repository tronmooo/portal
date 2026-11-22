// OWNER REPORT (2026-11-22): Next Important read "Prilosec: 7 doses unlogged
// this week · (today)". The tile sorted by date alone and the dose-gap row is
// stamped "today". The rule (shared/next-important): the next thing really on
// the calendar; what it IS orders same-day items; never a tracker's reading or
// logging gap by default; nothing invented when nothing qualifies.
import { describe, it, expect } from "vitest";
import { pickNextImportant, isNextImportantCandidate } from "../shared/next-important";
import { buildExecutiveSections } from "../shared/executive-sections";
import type { AttentionItem } from "../shared/attention";

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  key: "k", sourceKey: "task:k", kind: "task", title: "T", reason: "", tier: "soon",
  daysUntil: 0, score: 0, href: "/", ...over,
});
const gap = item({ key: "adherence:tr1", sourceKey: "tracker:tr1", kind: "alert", title: "Prilosec: 7 doses unlogged this week" });
const reading = item({ key: "vital:tr2", sourceKey: "tracker:tr2", kind: "alert", title: "Blood pressure 139/80" });
const anomaly = item({ key: "anomaly:tr3", sourceKey: "tracker:tr3", kind: "alert", title: "Sleep is unusual" });

describe("pickNextImportant", () => {
  it("names nothing when nothing is on the calendar", () => {
    expect(pickNextImportant([])).toBeNull();
    expect(pickNextImportant(null)).toBeNull();
    expect(pickNextImportant([reading, anomaly])).toBeNull();
  });

  it("never names a tracker reading or anomaly", () => {
    expect(isNextImportantCandidate(reading)).toBe(false);
    expect(isNextImportantCandidate(anomaly)).toBe(false);
  });

  it("a dose gap (only raised when the user asked for it) yields to anything scheduled that day", () => {
    const appt = item({ key: "event:e1", sourceKey: "event:e1", kind: "event", title: "Dentist", reason: "3:00 PM" });
    expect(pickNextImportant([gap, appt])?.title).toBe("Dentist");
    const bill = item({ key: "bill:b1", sourceKey: "obligation:b1", kind: "bill", title: "Netflix" });
    expect(pickNextImportant([gap, bill])?.title).toBe("Netflix");
    // Alone, it is what the user asked to be told.
    expect(pickNextImportant([gap])?.title).toContain("Prilosec");
  });

  it("puts the nearer day first whatever the kind", () => {
    const billToday = item({ key: "bill:b1", sourceKey: "obligation:b1", kind: "bill", title: "Rent" });
    const apptTomorrow = item({ key: "event:e1", sourceKey: "event:e1", kind: "event", title: "Flight", daysUntil: 1 });
    expect(pickNextImportant([apptTomorrow, billToday])?.title).toBe("Rent");
  });

  it("orders same-day items by what they are: appointment, document, task, goal, dose, payment", () => {
    const rows = [
      item({ key: "bill:b", sourceKey: "obligation:b", kind: "bill", title: "payment" }),
      item({ key: "med:m", sourceKey: "obligation:m", kind: "reminder", title: "dose" }),
      item({ key: "goal:g", sourceKey: "goal:g", kind: "goal", title: "goal" }),
      item({ key: "task:t", sourceKey: "task:t", kind: "task", title: "task" }),
      item({ key: "doc:d", sourceKey: "rule:d", kind: "document", title: "document" }),
      item({ key: "event:e", sourceKey: "event:e", kind: "event", title: "appointment" }),
    ];
    const order: string[] = [];
    let pool = rows;
    while (pool.length) {
      const next = pickNextImportant(pool)!;
      order.push(next.title);
      pool = pool.filter((r) => r !== next);
    }
    expect(order).toEqual(["appointment", "document", "task", "goal", "dose", "payment"]);
  });

  it("skips overdue rows, undated rows and an event whose time has passed today", () => {
    expect(pickNextImportant([item({ daysUntil: -3 })])).toBeNull();
    expect(pickNextImportant([item({ daysUntil: null })])).toBeNull();
    const passed = item({ key: "event:p", sourceKey: "event:p", kind: "event", title: "Standup", reason: "9:00 AM · passed" });
    const later = item({ key: "task:t", sourceKey: "task:t", title: "Call mechanic", daysUntil: 2 });
    expect(pickNextImportant([passed, later])?.title).toBe("Call mechanic");
  });
});

describe("the owner's dashboard, end to end through the sections", () => {
  const NOW = new Date("2026-11-22T12:00:00");
  const prilosec = {
    id: "tr1", name: "Prilosec", category: "medication", unit: "daily",
    createdAt: "2026-10-01T00:00:00Z", fields: [{ name: "adherence", type: "select" }], entries: [],
  };
  const next = (cfg?: any, extra: any = {}) => {
    const secs = buildExecutiveSections({ now: NOW, today: "2026-11-22", trackers: [prilosec], ...extra } as any, cfg);
    return pickNextImportant(["today", "bills", "upcoming", "importantDates", "documents", "health"]
      .flatMap((id) => secs.find((s) => s.id === id)?.items ?? []));
  };

  it("an unlogged medication is not Next Important", () => {
    expect(next()).toBeNull();
  });
  it("…and with a task due Friday, the task is", () => {
    const got = next(undefined, { tasks: [{ id: "t1", title: "Call the insurance company", status: "todo", dueDate: "2026-11-27" }] });
    expect(got?.title).toBe("Call the insurance company");
  });
  it("switching alerts on for Prilosec lets its gap be named when nothing else is due", () => {
    expect(next({ medicationGapTrackerIds: ["tr1"] })?.title).toContain("Prilosec");
  });
});
