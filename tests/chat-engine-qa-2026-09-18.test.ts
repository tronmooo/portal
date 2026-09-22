// QA 2026-09-18 — chat-engine cluster regressions (BUG-02, BUG-03, BUG-04,
// BUG-19, BUG-33 and the "1 completions" feed row).
//
// The tool tests drive the REAL executeTool against an in-memory storage mock
// (same harness shape as tests/error-hunt-2026-09-02-ai.test.ts); the rest are
// pure shared helpers.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { looksLikeObjectPhrase, looksLikePersonName, suggestObjectProfileType } from "../shared/entity-naming";
import { isFabricatedAppointment, bookingErrands, statesAppointment } from "../shared/appointment-intent";
import { buildTurnRecap } from "../shared/quick-log";
import { buildBulkReply } from "../server/ai-bulk-log";
import { isInternalMemory, userVisibleMemories } from "../shared/memory-visibility";
import { describeTrackerEntry, dedupeActivityRows, countWithUnit } from "../shared/activity-description";
import { planExtractionActions, type EntityIndex } from "../shared/extraction-actions";
import { parkingTicket } from "./document-fixtures";

const SELF = { id: "p-self", name: "Poop", type: "self", fields: {} };
const DANA = { id: "p-dana", name: "Dana", type: "person", fields: { birthday: "2027-03-12" } };
const db: any = {};

function reseed() {
  db.profiles = [SELF, { ...DANA, fields: { ...DANA.fields } }];
  db.events = [];
  db.tasks = [];
  db.expenses = [];
}

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => db.profiles,
    getProfile: async (id: string) => db.profiles.find((p: any) => p.id === id),
    getSelfProfile: async () => SELF,
    updateProfile: async (id: string, patch: any) => { const p = db.profiles.find((x: any) => x.id === id); Object.assign(p, patch); return p; },
    createProfile: async (data: any) => { const row = { id: `prof${db.profiles.length + 1}`, ...data }; db.profiles.push(row); return row; },
    getEvents: async () => db.events,
    createEvent: async (data: any) => { const row = { id: `ev${db.events.length + 1}`, ...data }; db.events.push(row); return row; },
    getTasks: async () => db.tasks,
    createTask: async (data: any) => { const row = { id: `t${db.tasks.length + 1}`, status: "todo", ...data }; db.tasks.push(row); return row; },
    linkProfileTo: async () => undefined,
    getExpenses: async () => db.expenses,
    getMemories: async () => [],
    getDocuments: async () => [],
    getTrackers: async () => [],
    getHabits: async () => [],
    getObligations: async () => [],
    getIncomes: async () => [],
    getPreference: async () => null,
    wouldCreateCycle: async () => false,
    createAiActionLog: async (row: any) => ({ id: "log1", ...row }),
  };
  const storage = new Proxy(impl, { get(target, prop: string) { return prop in target ? target[prop] : async () => []; } });
  return { storage };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => { throw new Error("model must not be called"); },
      stream: () => { throw new Error("model must not be called"); },
    };
  },
}));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

// ─── BUG-02 ──────────────────────────────────────────────────────────────────
describe("BUG-02: a person's name looks like a name", () => {
  it("object phrases are never people", () => {
    for (const n of [
      "tires for my Dodge ram", "my MacBook Pro M4 Financing", "MacBook Pro M4 Financing",
      "Bob's MacBook", "new set of winter tires", "Gas $60", "Honda Civic", "my sister Dana",
    ]) expect(looksLikeObjectPhrase(n), n).toBe(true);
  });
  it("real names pass, including particles, hyphens and 'Bill'", () => {
    for (const n of ["Dana", "Bill Gates", "Bill", "Dodge", "Rob Card", "Dr. James Park", "Mary-Kate van der Berg", "Ludwig van Beethoven", "Luna", "mom", "Northwind Logistics"]) {
      expect(looksLikePersonName(n), n).toBe(true);
    }
  });
  it("suggests the thing's own type for the model's retry", () => {
    expect(suggestObjectProfileType("my MacBook Pro M4 Financing")).toBe("liability");
    expect(suggestObjectProfileType("tires for my Dodge ram")).toBe("vehicle");
    expect(suggestObjectProfileType("Netflix subscription")).toBe("subscription");
  });
  it("create_profile refuses an object phrase typed as a person and writes nothing", async () => {
    const before = db.profiles.length;
    const res = await executeTool("create_profile", { type: "person", name: "tires for my Dodge ram", __userMessage: "I bought tires for my Dodge Ram" }, "u1");
    expect(res.error).toMatch(/NOT_A_PERSON/);
    expect(res.suggestedType).toBe("vehicle");
    expect(db.profiles.length).toBe(before);
    // The determiner strip must not hide the evidence.
    const res2 = await executeTool("create_profile", { type: "person", name: "my MacBook Pro M4 Financing", __userMessage: "financing my macbook" }, "u1");
    expect(res2.error).toMatch(/NOT_A_PERSON/);
    expect(db.profiles.length).toBe(before);
    expect(db.profiles.some((p: any) => /macbook|tires/i.test(p.name))).toBe(false);
  });
  it("create_profile still creates a real person", async () => {
    const res = await executeTool("create_profile", { type: "person", name: "Tim", fields: {}, __userMessage: "create a profile for Tim he's a human" }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.profiles.some((p: any) => p.name === "Tim" && p.type === "person")).toBe(true);
  });
  it("an ownership link never mints a person out of the thing's name", async () => {
    const before = db.profiles.length;
    const res = await executeTool("link_asset_owner", { assetName: "Dodge Ram", partyName: "tires for my Dodge ram", __userMessage: "x" }, "u1");
    expect(String(res.error || "")).toMatch(/NOT_A_PERSON|not found/i);
    expect(db.profiles.length).toBe(before);
  });
});

// ─── BUG-03 ──────────────────────────────────────────────────────────────────
describe("BUG-03: one birthday → one yearly event, on the day the user said", () => {
  const msg = "hey i just started a new job at Northwind Logistics, first day is oct 5. salary is 95k. also my sister Dana lives in austin, her bday is march 12 — can you remember all that?";

  it("a birthday event on a day that contradicts the profile is refused", async () => {
    const res = await executeTool("create_event", { title: "🎂 Dana's Birthday", date: "2027-03-04", recurrence: "yearly", __userMessage: msg }, "u1");
    expect(res.error).toMatch(/BIRTHDAY_MISMATCH/);
    expect(db.events.length).toBe(0);
  });

  it("the matching birthday is created once, linked to Dana, yearly — and a second one is deduped whatever its date", async () => {
    const first = await executeTool("create_event", { title: "🎂 Dana's Birthday", date: "2027-03-12", recurrence: "yearly", __userMessage: msg }, "u1");
    expect(first.error).toBeUndefined();
    expect(db.events.length).toBe(1);
    expect(db.events[0].linkedProfiles).toEqual([DANA.id]);
    expect(db.events[0].recurrence).toBe("yearly");
    expect(db.events[0].date).toBe("2027-03-12");

    const again = await executeTool("create_event", { title: "Dana's Birthday", date: "2027-03-12", recurrence: "yearly", __userMessage: msg }, "u1");
    expect(again.deduped).toBe(true);
    expect(db.events.length).toBe(1);
  });

  it("with no birthday on file, a second birthday event for the same person is still a duplicate", async () => {
    db.profiles = [SELF, { id: "p-dana", name: "Dana", type: "person", fields: {} }];
    const a = await executeTool("create_event", { title: "🎂 Dana's Birthday", date: "2027-03-12", recurrence: "yearly", __userMessage: msg }, "u1");
    expect(a.error).toBeUndefined();
    const b = await executeTool("create_event", { title: "🎂 Dana's Birthday", date: "2027-03-04", recurrence: "yearly", __userMessage: msg }, "u1");
    expect(b.deduped).toBe(true);
    expect(db.events.length).toBe(1);
    expect(db.events[0].date).toBe("2027-03-12");
  });

  it("an unrelated event is untouched", async () => {
    const res = await executeTool("create_event", { title: "Team standup", date: "2026-09-25", time: "15:00", __userMessage: "standup friday 3pm" }, "u1");
    expect(res.error).toBeUndefined();
    expect(db.events.length).toBe(1);
  });
});

// ─── BUG-04 ──────────────────────────────────────────────────────────────────
describe("BUG-04: 'call X to book Y' is a task, never an appointment", () => {
  const msg = "i spent like 60 bucks on gas yesterdya and i need to rember to call the dentist next tuesdya to book a cleaning";

  it("reads the errand and sees no stated appointment", () => {
    expect(bookingErrands(msg)).toHaveLength(1);
    expect(bookingErrands(msg)[0].what).toMatch(/cleaning/);
    expect(statesAppointment(msg)).toBe(false);
    expect(isFabricatedAppointment(msg, "Dentist cleaning")).toBe(true);
    expect(isFabricatedAppointment(msg, "Dentist appointment")).toBe(true);
  });
  it("a stated appointment is real, and an unrelated event in the same message is untouched", () => {
    expect(isFabricatedAppointment("I have a dentist cleaning Tuesday at 2:30", "Dentist cleaning")).toBe(false);
    expect(isFabricatedAppointment("booked a cleaning for the 24th at 2:30", "Dentist cleaning")).toBe(false);
    expect(isFabricatedAppointment(`${msg}. also standup friday 3pm`, "Standup")).toBe(false);
    expect(isFabricatedAppointment("remind me to call mom tomorrow", "Call mom")).toBe(false);
  });
  it("create_event refuses the fabricated appointment; create_task still records the call", async () => {
    const ev = await executeTool("create_event", { title: "Dentist cleaning", date: "2026-09-24", time: "14:30", category: "health", __userMessage: msg }, "u1");
    expect(ev.error).toMatch(/NOT_BOOKED_YET/);
    expect(db.events.length).toBe(0);
    const task = await executeTool("create_task", { title: "Call dentist to book a cleaning", dueDate: "2026-09-22", __userMessage: msg }, "u1");
    expect(task.error).toBeUndefined();
    expect(db.tasks.length).toBe(1);
  });
});

// ─── BUG-33 ──────────────────────────────────────────────────────────────────
describe("BUG-33: the recap reads as a sentence", () => {
  it("a full success is a count, a partial one a ratio", () => {
    const full = buildTurnRecap([
      { status: "ok", tool: "create_expense", label: "Gas", detail: "$60" },
      { status: "ok", tool: "create_task", label: "Call dentist to book a cleaning" },
    ]);
    expect(full.split("\n")[0]).toBe("Logged 2 items:");
    expect(full).not.toContain("2 of 2");
    expect(full).toContain("- Added expense: Gas — $60");
    expect(full).toContain("- Added task: Call dentist to book a cleaning");
    const partial = buildTurnRecap([
      { status: "ok", tool: "create_expense", label: "Gas" },
      { status: "failed", tool: "create_task", label: "Call dentist", error: "no title" },
    ]);
    expect(partial).toContain("Logged 1 of 2:");
    const bulk = buildBulkReply([
      { index: 0, raw: "Soccer", tool: "log_tracker_entry", status: "ok", trackerName: "Soccer" },
    ], []);
    expect(bulk).toContain("Logged 1 action:");
  });
});

// ─── BUG-19 ──────────────────────────────────────────────────────────────────
describe("BUG-19: a document's own dates stay off the person; internal memories stay hidden", () => {
  it("a citation's dueDate is not written onto the person it names", () => {
    const personIndex: EntityIndex = { ...parkingTicket.index, profiles: [{ id: "person-1", type: "person", name: "Sarah Miller", fields: {} } as any] };
    const p = planExtractionActions({
      semantic: {
        ...parkingTicket.semantic,
        primarySubject: "e-person",
        entities: [{ ref: "e-person", kind: "person", name: "Sarah Miller", identifiers: {}, confidence: 0.9 }],
        facts: parkingTicket.semantic.facts.map((f) => ({ ...f, subject: { entityRef: "e-person", confidence: 0.9 } })) as any,
      },
      items: parkingTicket.items,
      index: personIndex,
      primaryProfileId: "person-1",
      documentId: "doc-1",
      documentName: parkingTicket.name,
      today: "2026-08-25",
    });
    const due = p.actions.find((a) => a.destination === "calendar" && a.factIds.includes("f-due"));
    expect(due).toBeTruthy();
    expect(due!.payload.date).toBe("2026-09-25");
    expect(due!.payload.fields).toBeUndefined();
    expect(due!.payload.profileId).toBeUndefined();
    expect(due!.target.kind).toBe("event");
    // No action of any kind proposes writing dueDate onto the person.
    for (const a of p.actions) {
      const fields = (a.payload && a.payload.fields) || {};
      expect(Object.keys(fields)).not.toContain("dueDate");
    }
  });
  it("the same due date still lands on a vehicle's record", () => {
    const p = planExtractionActions({ semantic: parkingTicket.semantic, items: parkingTicket.items, index: parkingTicket.index, primaryProfileId: parkingTicket.primaryProfileId, documentId: "doc-1", today: "2026-08-25" });
    const due = p.actions.find((a) => a.destination === "calendar" && a.factIds.includes("f-due"))!;
    expect(due.payload.profileId).toBe("vehicle-1");
    expect(due.payload.fields).toEqual({ dueDate: "2026-09-25" });
  });
  it("tracker-category tokens are internal, not facts from chat", () => {
    expect(isInternalMemory({ key: "tracker-category:video games", value: "lifestyle", category: "system" })).toBe(true);
    expect(isInternalMemory({ key: "tracker-category:video games", value: "lifestyle", category: "general" })).toBe(true);
    expect(isInternalMemory({ key: "favorite color", value: "blue", category: "general" })).toBe(false);
    const rows = userVisibleMemories([
      { key: "tracker-category:video games", value: "lifestyle", category: "system" },
      { key: "coffee order", value: "oat latte", category: "general" },
    ]);
    expect(rows.map((r) => r.key)).toEqual(["coffee order"]);
  });
});

// ─── Recent Activity wording ─────────────────────────────────────────────────
describe("Recent Activity: '1 completion', once", () => {
  it("pluralises by count and keeps real units", () => {
    expect(countWithUnit(1, "completions")).toBe("1 completion");
    expect(countWithUnit(2, "completions")).toBe("2 completions");
    expect(describeTrackerEntry({ name: "Brush Teeth", fields: [{ name: "completions", unit: "×", isPrimary: true }] }, { completions: 1, _habit: "h1" })).toBe("Brush Teeth: 1 completion");
    expect(describeTrackerEntry({ name: "Weight", unit: "lbs", fields: [{ name: "weight", unit: "lbs" }] }, { weight: 181.2 })).toBe("Weight: 181.2 lbs");
    expect(describeTrackerEntry({ name: "Glucose", unit: "mg/dL", fields: [{ name: "value" }] }, { value: 140 })).toBe("Glucose: 140 mg/dL");
  });
  it("collapses identical rows at the same moment", () => {
    const rows = dedupeActivityRows([
      { type: "tracker_entry", description: "Brush Teeth: 1 completion", timestamp: "2026-09-18T10:00:00.000Z" },
      { type: "tracker_entry", description: "Brush Teeth: 1 completion", timestamp: "2026-09-18T10:00:00.000Z" },
      { type: "tracker_entry", description: "Brush Teeth: 1 completion", timestamp: "2026-09-18T21:00:00.000Z" },
    ]);
    expect(rows).toHaveLength(2);
  });
  // Rule 36: the feed dedupes on the canonical event id, not on the text.
  it("keeps two distinct events whose text is identical", () => {
    const rows = dedupeActivityRows([
      { id: "e1", type: "expense", description: "$4.00 — Coffee", timestamp: "2026-09-18T10:00:00.000Z" },
      { id: "e2", type: "expense", description: "$4.00 — Coffee", timestamp: "2026-09-18T10:00:00.000Z" },
    ]);
    expect(rows.map(r => r.id)).toEqual(["e1", "e2"]);
  });
  it("renders one event once, however many times it reaches the feed", () => {
    const rows = dedupeActivityRows([
      { id: "t1", type: "task_completed", description: "Completed: Trash", timestamp: "2026-09-18T10:00:00.000Z" },
      { id: "t1", type: "task_completed", description: "Completed: Trash (Sep 18)", timestamp: "2026-09-18T10:00:05.000Z" },
      // Same id under another type is another event (an expense and a task can share an id space only by accident).
      { id: "t1", type: "expense", description: "$9.00 — Trash bags", timestamp: "2026-09-18T10:00:00.000Z" },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].description).toBe("Completed: Trash");
  });
  it("both storages stamp the source entity's id on every Recent Activity row", () => {
    const fs = require("fs"); const path = require("path");
    for (const f of ["../server/supabase-storage.ts", "../server/storage.ts"]) {
      const src = fs.readFileSync(path.resolve(__dirname, f), "utf8");
      const start = src.indexOf("recentActivity: dedupeActivityRows([");
      expect(start, f).toBeGreaterThan(-1);
      const block = src.slice(start, src.indexOf("].sort(", start));
      const types = [...block.matchAll(/type: '([a-z_]+)'/g)].map((m: any) => m[1]);
      expect(types.length, f).toBeGreaterThan(0);
      const ids = [...block.matchAll(/id: String\((\w+)\.id\)/g)].length;
      expect(ids, `${f}: every row kind carries id: String(x.id)`).toBe(types.length);
    }
  });
});
