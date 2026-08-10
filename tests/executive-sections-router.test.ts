// tests/executive-sections-router.test.ts
//
// The Executive tab is ten named sections again, and the whole risk of that
// shape is the one the 2026-07-29 report was about: the same record showing up
// in several places at once. The router's contract is that every record is
// claimed by EXACTLY ONE section, so these tests mostly ask "where did it go,
// and is it only there?".

import { describe, it, expect } from "vitest";
import {
  buildExecutiveSections,
  SECTION_DISPLAY_ORDER,
  isHealthText,
  isBirthdayText,
  type ExecSectionId,
} from "../shared/executive-sections";

const TODAY = "2026-07-29";       // a Wednesday
const NOW = new Date("2026-07-29T09:58:00");

function day(offset: number): string {
  const d = new Date(`${TODAY}T12:00:00`);
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("en-CA");
}

function run(input: any = {}, cfg?: any) {
  return buildExecutiveSections({ now: NOW, today: TODAY, ...input }, cfg);
}

const byId = (secs: any[]) => Object.fromEntries(secs.map(s => [s.id, s]));
const titles = (secs: any[], id: ExecSectionId) => (byId(secs)[id]?.items || []).map((i: any) => i.title);

/** Every sourceKey across every section, to prove nothing is listed twice. */
function allKeys(secs: any[]): string[] {
  return secs.flatMap(s => s.items.map((i: any) => i.sourceKey));
}

// ─────────────────────────────────────────────────────────────────────────────
describe("one record, one section", () => {
  it("never emits the same sourceKey in two sections", () => {
    const secs = run({
      tasks: [
        { id: "t1", title: "Overdue thing", status: "todo", dueDate: day(-2) },
        { id: "t2", title: "Due today", status: "todo", dueDate: TODAY },
        { id: "t3", title: "This week", status: "todo", dueDate: day(3) },
        // A medication is a TIMED TASK since reminders were retired 2026-08-09.
        { id: "t4", title: "Take Amoxicillin 500mg", status: "todo", dueDate: TODAY, dueTime: "08:00" },
      ],
      bills: [
        { id: "b1", name: "Electric", amount: 140, daysUntil: -3 },
        { id: "b2", name: "Internet", amount: 80, daysUntil: 4 },
      ],
      documents: [
        { documentId: "d1", documentName: "Passport", daysUntil: -5 },
        { documentId: "d2", documentName: "Insurance card", daysUntil: 12 },
      ],
      habits: [{ id: "h1", name: "Stretch", frequency: "daily", targetPerDay: 1, checkins: [] }],
      events: [
        { id: "e1", type: "event", title: "Dentist", date: TODAY, time: "15:00" },
        { id: "e2", type: "event", title: "Standup", date: TODAY, time: "09:00" },
        { id: "e3", type: "event", title: "Mom's Birthday", date: day(4) },
        { id: "e4", type: "event", title: "Team offsite", date: day(5), time: "10:00" },
      ],
      notifications: [
        { id: "task-overdue-t1", severity: "critical", title: "Overdue: Overdue thing", entityId: "t1", entityType: "task" },
        { id: "bill-overdue-b1", severity: "critical", title: "Overdue bill: Electric", entityId: "b1", entityType: "obligation" },
      ],
    });
    const keys = allKeys(secs);
    expect(keys.length, "a record was claimed by two sections").toBe(new Set(keys).size);
  });

  it("routes each kind to the section a person would look in", () => {
    const secs = run({
      tasks: [
        { id: "t1", title: "Overdue thing", status: "todo", dueDate: day(-2) },
        { id: "t2", title: "Due today", status: "todo", dueDate: TODAY },
        { id: "t3", title: "This week", status: "todo", dueDate: day(3) },
        // A medication is a TIMED TASK since reminders were retired 2026-08-09.
        { id: "t4", title: "Take Amoxicillin 500mg", status: "todo", dueDate: TODAY, dueTime: "08:00" },
      ],
      bills: [
        { id: "b1", name: "Electric", amount: 140, daysUntil: -3 },
        { id: "b2", name: "Internet", amount: 80, daysUntil: 4 },
      ],
      documents: [
        { documentId: "d1", documentName: "Passport", daysUntil: -5 },
        { documentId: "d2", documentName: "Insurance card", daysUntil: 12 },
      ],
      habits: [{ id: "h1", name: "Stretch", frequency: "daily", targetPerDay: 1, checkins: [] }],
      events: [
        { id: "e1", type: "event", title: "Dentist", date: TODAY, time: "15:00" },
        { id: "e2", type: "event", title: "Standup", date: TODAY, time: "09:00" },
        { id: "e3", type: "event", title: "Mom's Birthday", date: day(4) },
        { id: "e4", type: "event", title: "Team offsite", date: day(5), time: "10:00" },
      ],
    });
    // On fire: past-date task, past-date bill, expired document.
    expect(titles(secs, "immediate").sort()).toEqual(["Electric", "Overdue thing", "Passport"]);
    // Scheduled today, minus what Health and Important Dates took.
    expect(titles(secs, "today").sort()).toEqual(["Due today", "Standup"]);
    expect(titles(secs, "habits")).toEqual(["Stretch"]);
    expect(titles(secs, "bills")).toEqual(["Internet"]);
    expect(titles(secs, "upcoming").sort()).toEqual(["Team offsite", "This week"]);
    expect(titles(secs, "importantDates")).toEqual(["Mom's Birthday"]);
    expect(titles(secs, "documents")).toEqual(["Insurance card"]);
    // Dentist is an appointment AND health — Health wins over Today's Agenda.
    expect(titles(secs, "health").sort()).toEqual(["Dentist", "Take Amoxicillin 500mg"]);
  });

  it("collapses a derived alert onto the record it came from", () => {
    // notification-service synthesizes these from the same tables.
    const secs = run({
      bills: [{ id: "b1", name: "Electric", amount: 140, daysUntil: -3 }],
      notifications: [{
        id: "bill-overdue-b1", severity: "critical", title: "Overdue bill: Electric",
        entityId: "b1", entityType: "obligation",
      }],
    });
    expect(titles(secs, "immediate")).toEqual(["Electric"]);
    expect(allKeys(secs)).toEqual(["obligation:b1"]);
  });

  it("keeps an alert that represents nothing else", () => {
    const secs = run({
      notifications: [{ id: "custom:1", severity: "critical", title: "Two profiles share one VIN" }],
    });
    expect(titles(secs, "immediate")).toEqual(["Two profiles share one VIN"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("section behaviour", () => {
  it("hides empty sections", () => {
    const secs = run({ habits: [{ id: "h1", name: "Stretch", frequency: "daily", targetPerDay: 1, checkins: [] }] });
    expect(secs.map(s => s.id)).toEqual(["habits"]);
  });

  it("returns nothing at all on a genuinely clear day", () => {
    expect(run({})).toEqual([]);
  });

  it("renders in the order the user reads, not the order sections claim", () => {
    const secs = run({
      habits: [{ id: "h1", name: "Stretch", frequency: "daily", targetPerDay: 1, checkins: [] }],
      bills: [{ id: "b1", name: "Electric", amount: 140, daysUntil: -3 }],
      events: [{ id: "e1", type: "event", title: "Mom's Birthday", date: day(2) }],
    });
    // immediate < habits < importantDates in display order, even though
    // importantDates claims before habits.
    const order = secs.map(s => s.id);
    expect(order.indexOf("immediate")).toBeLessThan(order.indexOf("habits"));
    expect(order.indexOf("habits")).toBeLessThan(order.indexOf("importantDates"));
    for (let i = 1; i < order.length; i++) {
      expect(SECTION_DISPLAY_ORDER.indexOf(order[i] as any))
        .toBeGreaterThan(SECTION_DISPLAY_ORDER.indexOf(order[i - 1] as any));
    }
  });

  it("says where the overdue bills went, so Bills doesn't look broken", () => {
    const secs = run({
      bills: [
        { id: "b1", name: "Electric", amount: 140, daysUntil: -3 },
        { id: "b2", name: "Internet", amount: 80, daysUntil: 4 },
      ],
    });
    expect(byId(secs).bills.subtitle).toBe("1 overdue — see Immediate Attention");
    expect(byId(secs).documents).toBeUndefined();
  });

  it("shows habit progress for the day", () => {
    const secs = run({
      habits: [
        { id: "h1", name: "Done one", frequency: "daily", targetPerDay: 1, checkins: [{ date: TODAY }] },
        { id: "h2", name: "Not yet", frequency: "daily", targetPerDay: 1, checkins: [] },
      ],
    });
    expect(byId(secs).habits.subtitle).toBe("1 of 2 done today");
    expect(titles(secs, "habits")).toEqual(["Not yet"]);
  });

  it("is complete within its own window, unlike Immediate Attention", () => {
    // Ten events this week all show (capped for display, counted honestly),
    // where the attention threshold would have dropped most of them.
    const events = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`, type: "event", title: `Event ${i}`, date: day(1 + (i % 7)), time: "10:00",
    }));
    const secs = run({ events });
    expect(byId(secs).upcoming.total).toBe(10);
    // Every row ships; the UI collapses to DISPLAY_CAP and "+N more" expands to
    // the rest. Truncating here is what left that button with nothing to reveal
    // (QA report 2026-08-05).
    expect(byId(secs).upcoming.items.length).toBe(10);
  });

  it("does not count a weekly habit on a day it isn't scheduled", () => {
    const secs = run({
      habits: [{ id: "h1", name: "Weigh in", frequency: "weekly", targetDays: [1], targetPerDay: 1, checkins: [] }],
    });
    expect(byId(secs).habits).toBeUndefined();
  });

  it("sorts soonest first inside a section", () => {
    const secs = run({
      tasks: [
        { id: "t1", title: "Friday", status: "todo", dueDate: day(3) },
        { id: "t2", title: "Tomorrow", status: "todo", dueDate: day(1) },
        { id: "t3", title: "Next week", status: "todo", dueDate: day(6) },
      ],
    });
    expect(titles(secs, "upcoming")).toEqual(["Tomorrow", "Friday", "Next week"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("health, activity and insights", () => {
  it("puts medications, refills and medical appointments under Health", () => {
    // Medications and refills are TIMED TASKS since reminders were retired
    // (2026-08-09) — the routing rule is the text, not the entity.
    const secs = run({
      tasks: [
        { id: "t1", title: "Take Amoxicillin 500mg", status: "todo", dueDate: TODAY, dueTime: "08:00" },
        { id: "t2", title: "Refill Lisinopril at CVS", status: "todo", dueDate: TODAY, dueTime: "08:30" },
        { id: "t3", title: "Move the car", status: "todo", dueDate: TODAY, dueTime: "08:45" },
      ],
      events: [{ id: "e1", type: "event", title: "Annual physical", date: day(3), time: "11:00" }],
    });
    expect(titles(secs, "health").sort()).toEqual(["Annual physical", "Refill Lisinopril at CVS", "Take Amoxicillin 500mg"]);
    // A non-health task stays on Today's Agenda.
    expect(titles(secs, "today")).toEqual(["Move the car"]);
  });

  it("drops a task whose due date is long past the attention window", () => {
    const secs = run({
      tasks: [{ id: "t1", title: "Take Amoxicillin 500mg", status: "todo", dueDate: day(-40) }],
    });
    // Overdue by more than a month — surfaced as on-fire, not silently lost.
    expect(titles(secs, "immediate")).toEqual(["Take Amoxicillin 500mg"]);
  });

  it("lists what was finished today and what was recently added", () => {
    const secs = run({
      tasks: [{ id: "t1", title: "Filed taxes", status: "done", completedAt: `${TODAY}T08:00:00` }],
      recentActivity: [{ id: "a1", type: "habit", description: "Logged weight 179 lbs", timestamp: `${TODAY}T07:00:00` }],
    });
    expect(titles(secs, "activity").sort()).toEqual(["Filed taxes", "Logged weight 179 lbs"]);
  });

  it("surfaces the insights engine's output", () => {
    const secs = run({
      insights: [
        { id: "i1", title: "Grocery spend up 31%", description: "vs last month", severity: "warning" },
        { id: "i2", title: "7-day journal streak", description: "Keep going", severity: "positive" },
      ],
    });
    expect(titles(secs, "insights")).toEqual(["Grocery spend up 31%", "7-day journal streak"]);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Health: the tab reads the medical data the app already holds, and reads it
  // once. The recurring failure mode here is a medication renting space in two
  // sections at the same time.
  describe("health", () => {
    const med = (over: any = {}) => ({
      id: "o1", name: "Lisinopril 10mg", kind: "medication", status: "active",
      nextDueDate: TODAY, payments: [], ...over,
    });

    it("claims a medication for Health so it never renders as a bill", () => {
      // upcomingBills carries every obligation within 30 days regardless of
      // kind, so the same record arrives on both inputs. It must land once.
      const secs = run({
        obligations: [med()],
        bills: [{ id: "o1", name: "Lisinopril 10mg", amount: 0, daysUntil: 0 }],
      });
      expect(titles(secs, "health")).toEqual(["Lisinopril 10mg"]);
      expect(byId(secs).bills).toBeUndefined();
      const keys = allKeys(secs);
      expect(keys.length).toBe(new Set(keys).size);
    });

    it("drops a dose that is already logged today, and one not yet due", () => {
      expect(byId(run({ obligations: [med({ payments: [{ date: TODAY }] })] })).health).toBeUndefined();
      expect(byId(run({ obligations: [med({ nextDueDate: day(3) })] })).health).toBeUndefined();
      // Yesterday's unlogged dose is still the user's problem.
      expect(titles(run({ obligations: [med({ nextDueDate: day(-1) })] }), "health")).toEqual(["Lisinopril 10mg"]);
    });

    it("offers a Taken action, never the task-completing one", () => {
      const [item] = byId(run({ obligations: [med()] })).health.items;
      // `complete` routes to PATCH /api/tasks/:id — firing that against an
      // obligation id would update an unrelated record.
      expect(item.action).toEqual({ kind: "taken", label: "Taken" });
      expect(item.sourceKey).toBe("obligation:o1");
    });

    it("surfaces a reading the server flagged out of range, but not a normal one", () => {
      const tracker = (cat: string) => ({
        id: "tr1", name: "Blood Pressure", category: "health",
        entries: [{
          id: "e1", timestamp: `${TODAY}T08:00:00`,
          values: { systolic: 148, diastolic: 96 },
          computed: { bloodPressureCategory: cat },
        }],
      });
      expect(titles(run({ trackers: [tracker("high_stage2")] }), "health"))
        .toEqual(["Blood Pressure reading is stage 2 high"]);
      expect(byId(run({ trackers: [tracker("normal")] })).health).toBeUndefined();
    });

    it("ignores a flagged reading that has gone stale", () => {
      const secs = run({
        trackers: [{
          id: "tr1", name: "Blood Pressure", category: "health",
          entries: [{
            id: "e1", timestamp: `${day(-40)}T08:00:00`,
            values: { systolic: 148, diastolic: 96 },
            computed: { bloodPressureCategory: "high_stage2" },
          }],
        }],
      });
      expect(byId(secs).health).toBeUndefined();
    });

    it("surfaces a statistical outlier on its own", () => {
      // Guards the test below: if the anomaly engine never fired, the
      // "clinical band wins" assertion would be passing for the wrong reason.
      // A real baseline has spread — with a flat one the stdev is 0 and the
      // >2σ gate correctly declines to call anything an outlier.
      const entries = Array.from({ length: 15 }, (_, i) => ({
        id: `e${i}`, timestamp: `${day(-20 + i)}T08:00:00`, values: { value: 60 + (i % 4) },
      }));
      entries.push({ id: "spike", timestamp: `${TODAY}T08:00:00`, values: { value: 121 } });
      const secs = run({ trackers: [{ id: "tr1", name: "Resting Heart Rate", category: "health", unit: "bpm", entries }] });
      expect(titles(secs, "health")[0]).toContain("unusually high");
    });

    it("shows the clinical band rather than the statistical outlier when both fire", () => {
      // A settled baseline then a spike: >2σ anomaly AND a stamped crisis band.
      const entries = Array.from({ length: 15 }, (_, i) => ({
        id: `e${i}`, timestamp: `${day(-20 + i)}T08:00:00`,
        values: { value: 118 + (i % 4) }, computed: { bloodPressureCategory: "normal" },
      }));
      entries.push({
        id: "spike", timestamp: `${TODAY}T08:00:00`,
        values: { value: 190 }, computed: { bloodPressureCategory: "crisis" },
      } as any);
      const secs = run({ trackers: [{ id: "tr1", name: "Blood Pressure", category: "health", unit: "mmHg", entries }] });
      expect(secs.find(s => s.id === "health")!.items).toHaveLength(1);
      expect(titles(secs, "health")[0]).toContain("hypertensive crisis");
    });

    it("calls an unlogged dose a gap, not a confirmed miss", () => {
      const secs = run({
        trackers: [{
          id: "tr1", name: "Metformin", category: "medication", unit: "twice daily",
          createdAt: `${day(-30)}T00:00:00Z`,
          fields: [{ name: "adherence", type: "select" }],
          entries: [],
        }],
      });
      const [item] = byId(secs).health.items;
      expect(item.title).toContain("unlogged this week");
      expect(item.reason).toContain("not a confirmed miss");
      expect(item.reason).not.toMatch(/\bmissed\b(?! doses)/);
    });

    it("renders nothing at all when no medical data is registered", () => {
      const secs = run({
        tasks: [{ id: "t1", title: "Due today", status: "todo", dueDate: TODAY }],
      });
      expect(byId(secs).health).toBeUndefined();
    });

    it("collapses the insights engine's tracker alert onto the Health row", () => {
      // analyzeHealth derives its BP alert from the same latest entry the
      // Health section reads. Keyed on the insight's own uuid these were
      // invisible to each other and the reading rendered under both headings.
      const secs = run({
        trackers: [{
          id: "tr1", name: "Blood Pressure", category: "health",
          entries: [{
            id: "e1", timestamp: `${TODAY}T08:00:00`,
            values: { systolic: 148, diastolic: 96 },
            computed: { bloodPressureCategory: "high_stage2" },
          }],
        }],
        insights: [{
          id: "i1", title: "Blood pressure elevated", description: "148/96",
          severity: "warning", relatedEntityType: "tracker", relatedEntityId: "tr1",
        }],
      });
      expect(byId(secs).insights).toBeUndefined();
      expect(secs.find(s => s.id === "health")!.items).toHaveLength(1);
      const keys = allKeys(secs);
      expect(keys.length).toBe(new Set(keys).size);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("important dates", () => {
    it("splits the week from the long tail in the subtitle and unfolds for it", () => {
      const secs = run({
        events: [
          { id: "e1", type: "event", title: "Mom's Birthday", date: day(2) },
          { id: "e2", type: "event", title: "Wedding Anniversary", date: day(30) },
        ],
      });
      const s = byId(secs).importantDates;
      expect(s.subtitle).toBe("1 this week · 1 more within 45 days");
      expect(s.emphasis).toBe("working");
      // Soonest first, so the week leads.
      expect(s.items[0].title).toBe("Mom's Birthday");
    });

    it("stays folded away when nothing lands inside the week", () => {
      const s = byId(run({
        events: [{ id: "e1", type: "event", title: "Mom's Birthday", date: day(30) }],
      })).importantDates;
      expect(s.subtitle).toBe("1 within the next 45 days");
      expect(s.emphasis).toBeUndefined();
    });

    it("trusts the profile's stamped kind over the title", () => {
      // A profile date-of-birth arrives stamped; "Nan's 90th" says nothing the
      // regex can see.
      const secs = run({
        events: [{ id: "e1", type: "event", title: "Nan's 90th", date: day(3), meta: { kind: "birthday" } }],
      });
      expect(titles(secs, "importantDates")).toEqual(["Nan's 90th"]);
      expect(byId(secs).importantDates.items[0].reason).toContain("Birthday");
    });

    it("labels an anniversary as one", () => {
      const secs = run({
        events: [{ id: "e1", type: "event", title: "Dave & Sam", date: day(3), meta: { kind: "anniversary" } }],
      });
      expect(byId(secs).importantDates.items[0].reason).toContain("Anniversary");
    });

    // A managed Recurring Date carries its type as an `rd:kind:` tag, which
    // reaches us on meta.tags. Before this the title regex was the only signal,
    // so anything not literally called a birthday fell through to Upcoming.
    const rdate = (over: any = {}) => ({
      id: "e1", type: "event", title: "Maya's Graduation", date: day(3),
      sourceId: "ev1", meta: { tags: ["rdate", "rd:kind:custom"] }, ...over,
    });

    it("claims a custom recurring date and labels it by its kind", () => {
      const secs = run({ events: [rdate()] });
      expect(titles(secs, "importantDates")).toEqual(["Maya's Graduation"]);
      expect(byId(secs).importantDates.items[0].reason).toContain("Custom");
      // Not left in the generic bucket.
      expect(titles(secs, "upcoming")).toEqual([]);
    });

    it("labels a holiday as a holiday, not a birthday", () => {
      const secs = run({
        events: [{ id: "e1", type: "event", title: "Christmas Day", date: day(5) }],
      });
      expect(byId(secs).importantDates.items[0].reason).toContain("Holiday");
      expect(byId(secs).importantDates.items[0].reason).not.toContain("Birthday");
    });

    // The claim-order guard. importantDates claims BEFORE bills, so admitting
    // every recurring kind here would quietly empty the Bills section.
    it("does NOT claim a recurring bill — Bills keeps it", () => {
      const secs = run({
        events: [rdate({ title: "Rent", meta: { tags: ["rdate", "rd:kind:bill"] } })],
        bills: [{ id: "b1", name: "Rent", amount: 2500, daysUntil: 3 }],
      });
      expect(byId(secs).importantDates).toBeUndefined();
      expect(titles(secs, "bills")).toEqual(["Rent"]);
      const keys = allKeys(secs);
      expect(keys.length).toBe(new Set(keys).size);
    });

    it("does NOT claim a recurring appointment — Health keeps it", () => {
      const secs = run({
        events: [rdate({ title: "Dentist", meta: { tags: ["rdate", "rd:kind:appointment"] } })],
      });
      expect(byId(secs).importantDates).toBeUndefined();
      expect(titles(secs, "health")).toEqual(["Dentist"]);
    });

    it("drops an occurrence that is already checked off", () => {
      expect(byId(run({ events: [rdate({ completed: true })] })).importantDates).toBeUndefined();
    });

    it("offers Done only where an occurrence can actually be written", () => {
      // A managed series is a real event row — it can take the tag edit.
      expect(byId(run({ events: [rdate()] })).importantDates.items[0].action)
        .toEqual({ kind: "markdone", label: "Done" });
      // A profile birthday's sourceId is `profile:<id>:birthday`, not an event
      // id — PATCHing /api/events with it would 404, so it stays read-only.
      const profileBday = byId(run({
        events: [{
          id: "birthday-profile:p1:birthday-2026-08-01", type: "event",
          title: "Mom's Birthday", date: day(3),
          sourceId: "profile:p1:birthday", meta: { kind: "birthday", recurrence: "yearly" },
        }],
      })).importantDates;
      expect(profileBday.items[0].action).toEqual({ kind: "open", label: "Open" });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("ai recommendations", () => {
    it("renders nothing until recommendations are supplied", () => {
      expect(byId(run({})).recommendations).toBeUndefined();
      expect(byId(run({ recommendations: [] })).recommendations).toBeUndefined();
    });

    it("renders supplied rows in order, with no action to fire", () => {
      const secs = run({
        recommendations: [
          { title: "Link 3 documents", body: "They have no profile.", action: "Link", priority: "high" },
          { title: "Re-categorize 8 expenses", body: "Filed as other.", action: "Review", priority: "low" },
        ],
      });
      expect(titles(secs, "recommendations")).toEqual(["Link 3 documents", "Re-categorize 8 expenses"]);
      expect(byId(secs).recommendations.items.every((i: any) => !i.action)).toBe(true);
    });

    it("drops a row the model returned without a title", () => {
      const secs = run({ recommendations: [{ body: "orphan" }, { title: "Real one" }] });
      expect(titles(secs, "recommendations")).toEqual(["Real one"]);
    });
  });

  it("classifies health and occasion text", () => {
    expect(isHealthText("Take Amoxicillin 500mg")).toBe(true);
    expect(isHealthText("Dentist appointment")).toBe(true);
    expect(isHealthText("Refill prescription")).toBe(true);
    expect(isHealthText("Take Lisinopril")).toBe(true);        // -pril drug name
    expect(isHealthText("Pay the electric bill")).toBe(false);
    // "April" ends in -pril and must not read as a drug.
    expect(isHealthText("April planning meeting")).toBe(false);
    expect(isHealthText("Book the tennis court")).toBe(false);
    expect(isBirthdayText("Mom's Birthday")).toBe(true);
    expect(isBirthdayText("Wedding Anniversary")).toBe(true);
    expect(isBirthdayText("Thanksgiving")).toBe(true);
    expect(isBirthdayText("Team offsite")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Income Expected — the positive mirror of Bills", () => {
  const occ = (over: any = {}) => ({
    occurrenceId: `inc-1:${over.effectiveDate || day(3)}`,
    incomeId: "inc-1",
    description: "Acme paycheck",
    amount: 2400,
    status: "expected",
    ...over,
  });

  it("lists expected pay dates in their own section, never under Bills", () => {
    const secs = run({ incomeOccurrences: [occ({ effectiveDate: day(3) })] });
    expect(titles(secs, "income")).toEqual(["Acme paycheck"]);
    expect(titles(secs, "bills")).toEqual([]);
  });

  it("says a passed pay date was NOT received rather than counting it as money in", () => {
    const secs = run({
      incomeOccurrences: [occ({ effectiveDate: day(-3), status: "overdue" })],
    });
    const all = secs.flatMap((s: any) => s.items);
    const item = all.find((i: any) => i.kind === "income")!;
    expect(item.reason).toContain("not received");
    expect(item.tier).toBe("immediate");
  });

  it("keeps already-received money out of the action list but in the headline", () => {
    const secs = run({
      incomeOccurrences: [
        occ({ effectiveDate: day(-2), status: "received", receivedAmount: 2400 }),
        occ({ occurrenceId: "inc-1:x", effectiveDate: day(4), amount: 1000 }),
      ],
    });
    const income = byId(secs).income;
    // Only the outstanding one is actionable…
    expect(income.items).toHaveLength(1);
    expect(income.items[0].amount).toBe(1000);
    // …and the section says what has already landed.
    expect(income.subtitle).toContain("received so far");
  });

  it("ignores skipped occurrences entirely", () => {
    const secs = run({
      incomeOccurrences: [occ({ effectiveDate: day(3), status: "skipped" })],
    });
    expect(titles(secs, "income")).toEqual([]);
  });

  it("offers a Received action, not Pay", () => {
    const secs = run({ incomeOccurrences: [occ({ effectiveDate: day(2) })] });
    expect(byId(secs).income.items[0].action).toEqual({ kind: "received", label: "Received" });
  });

  it("reads immediately after Bills, so the month's two halves sit together", () => {
    const order = SECTION_DISPLAY_ORDER;
    expect(order[order.indexOf("bills") + 1]).toBe("income");
  });
});
