// Rule 37 — every calendar item carries WHAT it came from, and renders that.
//
// The timeline used to stamp paychecks, birthdays, document expirations,
// renewals and appointments all as type "event" (their real kind hidden in
// meta.kind), so the calendar's badge read "Event" for every one of them. Now
// each builder stamps `sourceType` and the label comes from
// shared/calendar-occurrences KIND_LABELS: a paycheck is "Income", a licence
// "Document Expiration", a birthday "Birthday". "Event" is only ever the
// label of a plain event.
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { MemStorage } from "../server/storage";
import { calendarItemLabel, calendarSourceKind, KIND_LABELS } from "../shared/calendar-occurrences";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (n: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const WINDOW_START = plusDays(-40);
const WINDOW_END = `${new Date().getUTCFullYear() + 20}-12-31`;

let storage: MemStorage;
beforeEach(() => { storage = new MemStorage(); });

describe("the timeline stamps sourceType on every item", () => {
  it("MemStorage: income → income, document → expiration, task → task, event → event, bill → bill, habit → habit", async () => {
    const jane = await storage.createProfile({ name: "Jane Doe", type: "person" } as any);
    await storage.createIncome({ description: "Paycheck", amount: 2000, frequency: "monthly", category: "salary", date: plusDays(-10) } as any);
    await storage.createDocument({
      name: "Sample Driver License", type: "drivers_license", mimeType: "image/jpeg", fileData: "",
      extractedData: { expiration_date: `${new Date().getUTCFullYear() + 8}-07-18` }, linkedProfiles: [jane.id], tags: [],
    } as any);
    await storage.createTask({ title: "Trash", status: "todo", priority: "medium", dueDate: plusDays(3), linkedProfiles: [jane.id], tags: [] } as any);
    await storage.createEvent({ title: "Dentist", date: plusDays(4), allDay: true, category: "health", recurrence: "none", linkedProfiles: [jane.id] } as any);
    await storage.createObligation({ name: "Rent", amount: 1200, frequency: "monthly", nextDueDate: plusDays(5), category: "housing", autopay: false, linkedProfiles: [jane.id] } as any);
    await storage.createHabit({ name: "Read", frequency: "daily", targetPerDay: 1, linkedProfiles: [jane.id] } as any);

    const items: any[] = await storage.getCalendarTimeline(WINDOW_START, WINDOW_END);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.sourceType, `${it.id} (${it.title}) has no sourceType`).toBeTruthy();

    const byTitle = (t: string) => items.filter(i => String(i.title).includes(t));
    expect(byTitle("Paycheck").length).toBeGreaterThan(0);
    for (const i of byTitle("Paycheck")) {
      expect(i.type).toBe("event");
      expect(i.sourceType).toBe("income");
      expect(calendarItemLabel(i)).toBe("Income");
    }
    const licence = items.filter(i => i.sourceType === "expiration" || i.sourceType === "document");
    expect(licence.length).toBeGreaterThan(0);
    for (const i of licence) expect(calendarItemLabel(i)).not.toBe("Event");
    expect(byTitle("Trash")[0].sourceType).toBe("task");
    expect(byTitle("Dentist")[0].sourceType).toBe("event");
    expect(byTitle("Rent")[0].sourceType).toBe("bill");
    expect(calendarItemLabel(byTitle("Rent")[0])).toBe("Bill");
    expect(byTitle("Read")[0]?.sourceType).toBe("habit");
  });

  it("SupabaseStorage: every items.push in getCalendarTimeline stamps sourceType", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../server/supabase-storage.ts"), "utf8");
    const start = src.indexOf("async getCalendarTimeline(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n  async ", start + 10);
    const body = src.slice(start, end);
    const pushes = (body.match(/items\.push\(\{/g) || []).length;
    const stamped = (body.match(/sourceType:/g) || []).length;
    expect(pushes).toBeGreaterThan(0);
    expect(stamped, "every items.push({ ... }) carries a sourceType").toBeGreaterThanOrEqual(pushes);
  });
});

describe("the label map never yields 'Event' for income or document kinds", () => {
  it("labels by sourceType, then legacy meta.kind, then coarse type", () => {
    expect(calendarItemLabel({ type: "event", sourceType: "income" })).toBe("Income");
    expect(calendarItemLabel({ type: "event", meta: { kind: "income" } })).toBe("Income");
    expect(calendarItemLabel({ type: "event", sourceType: "birthday" })).toBe("Birthday");
    expect(calendarItemLabel({ type: "event", sourceType: "anniversary" })).toBe("Anniversary");
    expect(calendarItemLabel({ type: "event", sourceType: "document" })).toBe("Document Expiration");
    expect(calendarItemLabel({ type: "event", sourceType: "expiration", meta: { source: "document" } })).toBe("Document Expiration");
    expect(calendarItemLabel({ type: "event", sourceType: "expiration", meta: { source: "profile" } })).toBe("Expiration");
    expect(calendarItemLabel({ type: "event", sourceType: "renewal" })).toBe("Renewal");
    expect(calendarItemLabel({ type: "event", sourceType: "appointment" })).toBe("Appointment");
    expect(calendarItemLabel({ type: "obligation", sourceType: "bill" })).toBe("Bill");
    expect(calendarItemLabel({ type: "obligation" })).toBe("Bill Due");
    expect(calendarItemLabel({ type: "task" })).toBe("Task");
    expect(calendarItemLabel({ type: "habit" })).toBe("Habit");
    expect(calendarItemLabel({ type: "event" })).toBe("Event");
    expect(calendarItemLabel({ type: "event", sourceType: "reminder" })).toBe("Reminder");
    expect(calendarSourceKind({ type: "event", sourceType: "income" })).toBe("income");
  });

  it("every OccurrenceKind other than 'event' has a label that is not 'Event'", () => {
    for (const [kind, label] of Object.entries(KIND_LABELS)) {
      if (kind === "event") continue;
      expect(label, kind).not.toBe("Event");
      expect(calendarItemLabel({ type: "event", sourceType: kind }), kind).not.toBe("Event");
    }
  });

  it("CalendarView labels and icons from the source kind, not TYPE_LABELS[item.type]", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../client/src/components/CalendarView.tsx"), "utf8");
    expect(src).not.toMatch(/\{TYPE_LABELS\[item\.type\]\}/);
    expect(src).not.toMatch(/const Icon = TYPE_ICONS\[item\.type\] \|\| CalendarIcon/);
    expect(src).toContain("calendarItemLabel");
    expect(src).not.toContain(">{item.meta.kind}<");
  });
});
