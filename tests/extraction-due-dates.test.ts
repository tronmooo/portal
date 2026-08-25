// tests/extraction-due-dates.test.ts
//
// POST /api/chat/confirm-extraction, for the DATES half of an extraction.
//
// The user's report (2026-08-25) was not "the UI didn't show a checkbox" — it
// was "I pressed Extract and the due date went nowhere". So this suite asserts
// what actually PERSISTED and what the calendar/Executive surfaces then derive
// from it, never merely that the route answered 200:
//
//   Document → Extract → Confirm → document saved
//     → date preserved as structured metadata
//     → calendar entry derived and linked back to the document
//     → Executive Dashboard shows it with the real days remaining
//
// …and the reverse decision: unticking "Add to Calendar" keeps the date on the
// document and takes it off the calendar, without deleting anything.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";

import {
  rulesFromAll,
  seriesFromDateRules,
  isDocumentAttentionRule,
  daysBetweenISO,
  CALENDAR_OPT_OUT_KEY,
} from "../shared/date-rules";
import { buildExecutiveSections } from "../shared/executive-sections";

const { stubState, stubStorage } = vi.hoisted(() => {
  const state = {
    profiles: new Map<string, any>(),
    documents: new Map<string, any>(),
    events: [] as any[],
  };
  const impl: any = {
    async getProfile(id: string) { return state.profiles.get(id); },
    async getProfiles() { return [...state.profiles.values()]; },
    async getProfilesLite() { return [...state.profiles.values()]; },
    async getAssetPartyLinks() { return []; },
    async updateProfile(id: string, patch: any) {
      const cur = state.profiles.get(id);
      if (!cur) return undefined;
      const updated = { ...cur, ...patch, fields: { ...(cur.fields || {}), ...(patch.fields || {}) } };
      state.profiles.set(id, updated);
      return updated;
    },
    async getDocument(id: string) { return state.documents.get(id); },
    async getDocuments() { return [...state.documents.values()]; },
    async updateDocument(id: string, patch: any) {
      const cur = state.documents.get(id);
      if (!cur) return undefined;
      const updated = { ...cur, ...patch };
      state.documents.set(id, updated);
      return updated;
    },
    async createEvent(data: any) {
      const row = { id: `evt-${state.events.length + 1}`, ...data };
      state.events.push(row);
      return row;
    },
    async getEvents() { return state.events; },
    async linkProfileTo() { return undefined; },
    async propagateDocumentToAncestors() { return []; },
  };
  const storage = new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async () => undefined;
    },
  });
  return { stubState: state, stubStorage: storage };
});

vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storage: stubStorage };
});

vi.mock("../server/ai-decide", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    aiDecide: vi.fn(async (opts: any) => ({ value: opts.fallback(), source: "fallback", durationMs: 0 })),
    aiPickIndex: vi.fn(async () => ({ value: { index: -1, confidence: 0, reason: "" }, source: "fallback", durationMs: 0 })),
  };
});

import { registerRoutes } from "../server/routes";

/** The citation exactly as the screenshot shows it, before confirmation. */
const citationDoc = () => ({
  id: "doc-citation",
  name: "Parking Violation Notice",
  title: "Parking Violation Notice",
  type: "parking_citation",
  mimeType: "image/jpeg",
  extractedData: {},
  linkedProfiles: [],
  tags: [],
});

const citationFields = [
  { key: "citationNumber", value: "RV62045871" },
  { key: "violationCode", value: "12.36.140" },
  { key: "fineAmount", value: "45" },
  { key: "amountDue", value: "45" },
  { key: "licensePlate", value: "QWE1234" },
  // The date the whole report is about, printed as the ticket prints it.
  { key: "dueDate", value: "09/25/2026" },
];

const post = (base: string, body: any) =>
  fetch(`${base}/api/chat/confirm-extraction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("confirm-extraction · due dates reach the calendar and the Executive tab", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    stubState.profiles.clear();
    stubState.documents.clear();
    stubState.events.length = 0;
    stubState.profiles.set("profile-self", { id: "profile-self", name: "Sarah", type: "self", fields: {}, tags: [] });
    stubState.documents.set("doc-citation", citationDoc());

    const app = express();
    app.use(express.json());
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it("persists the due date as structured metadata and derives the calendar entry from it", async () => {
    const res = await post(base, {
      extractionId: "doc-citation",
      targetProfileId: "profile-self",
      confirmedFields: citationFields,
      createCalendarEvents: [],
      calendarDates: [{
        field: "dueDate", path: "dueDate", date: "2026-09-25", ruleType: "due",
        title: "Due Date — Parking Violation Notice", category: "finance",
        addToCalendar: true, derived: true,
      }],
      trackerEntries: [],
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.failures).toEqual([]);
    // The response says what happened to the date, rather than silently
    // skipping it — "I pressed Confirm and nothing seemed to happen" is half
    // of the original report.
    expect(data.saved.join("; ")).toContain("Calendar: Due 2026-09-25");

    // 1. The document is saved, and the date is stored the ONE way every
    //    reader can parse — not "09/25/2026", which is invisible downstream.
    const doc = stubState.documents.get("doc-citation");
    expect(doc.extractedData.dueDate).toBe("2026-09-25");
    expect(doc.extractedData.citationNumber).toBe("RV62045871");

    // 2. Ticking "Add to Calendar" for a date the RECORD owns creates no
    //    second copy — the calendar is a view of the field, so a standalone
    //    event would be a duplicate that drifts the moment the date is edited.
    expect(stubState.events).toHaveLength(0);

    // 3. …and the calendar entry really is there, linked back to the document.
    const rules = rulesFromAll({ profiles: [], documents: [doc] });
    const due = rules.find((r) => r.ruleType === "due")!;
    expect(due.date).toBe("2026-09-25");
    expect(due.calendarVisible).toBe(true);
    const series = seriesFromDateRules(rules).find((s) => s.id === `rule:${due.id}`)!;
    expect(series.baseDate).toBe("2026-09-25");
    expect(series.source.id).toBe("doc-citation");     // links back to the document
    expect(series.source.field).toBe("dueDate");

    // 4. The Executive Dashboard shows it, with the REAL days remaining.
    const daysUntil = daysBetweenISO("2026-08-25", due.date);
    expect(daysUntil).toBe(31);
    expect(isDocumentAttentionRule(due)).toBe(true);
    const sections = buildExecutiveSections({
      today: "2026-08-25",
      documents: [{
        documentId: due.sourceEntityId, documentName: due.label, fieldName: due.sourceField,
        expirationDate: due.date, ruleId: due.id, ruleType: due.ruleType, daysUntil,
      }],
    } as any);
    const row = sections.flatMap((s: any) => s.items).find((i: any) => i.kind === "document")!;
    expect(row.reason).toBe("Due in 31d");
    expect(row.daysUntil).toBe(31);
  });

  it("unticking Add to Calendar keeps the date on the document and off the calendar", async () => {
    const res = await post(base, {
      extractionId: "doc-citation",
      targetProfileId: "profile-self",
      confirmedFields: citationFields,
      createCalendarEvents: [],
      calendarDates: [{
        field: "dueDate", path: "dueDate", date: "2026-09-25", ruleType: "due",
        addToCalendar: false, derived: true,
      }],
      trackerEntries: [],
    });
    expect(res.status).toBe(200);

    const doc = stubState.documents.get("doc-citation");
    // The date is NOT deleted — the document still carries it…
    expect(doc.extractedData.dueDate).toBe("2026-09-25");
    // …the decision is recorded on the record itself, so it survives edits.
    expect(doc.extractedData[CALENDAR_OPT_OUT_KEY]).toContain("dueDate");
    expect(stubState.events).toHaveLength(0);

    const rules = rulesFromAll({ profiles: [], documents: [doc] });
    const due = rules.find((r) => r.ruleType === "due")!;
    expect(due.calendarVisible).toBe(false);
    expect(due.importantVisible).toBe(true);   // still a date to watch
    expect(seriesFromDateRules(rules)).toHaveLength(0);
  });

  it("re-confirming with Add to Calendar ticked clears the earlier opt-out", async () => {
    await post(base, {
      extractionId: "doc-citation",
      confirmedFields: citationFields,
      createCalendarEvents: [],
      calendarDates: [{ field: "dueDate", date: "2026-09-25", addToCalendar: false }],
      trackerEntries: [],
    });
    expect(stubState.documents.get("doc-citation").extractedData[CALENDAR_OPT_OUT_KEY]).toContain("dueDate");

    await post(base, {
      extractionId: "doc-citation",
      confirmedFields: citationFields,
      createCalendarEvents: [],
      calendarDates: [{ field: "dueDate", date: "2026-09-25", addToCalendar: true }],
      trackerEntries: [],
    });
    const doc = stubState.documents.get("doc-citation");
    expect(doc.extractedData[CALENDAR_OPT_OUT_KEY]).toBeUndefined();
    expect(rulesFromAll({ profiles: [], documents: [doc] })
      .find((r) => r.ruleType === "due")!.calendarVisible).toBe(true);
  });

  it("editing the date later moves the calendar entry with it", async () => {
    await post(base, {
      extractionId: "doc-citation",
      confirmedFields: citationFields,
      createCalendarEvents: [],
      calendarDates: [{ field: "dueDate", date: "2026-09-25", addToCalendar: true }],
      trackerEntries: [],
    });
    const before = rulesFromAll({ profiles: [], documents: [stubState.documents.get("doc-citation")] })
      .find((r) => r.ruleType === "due")!;

    // The user corrects the date — the same door every editor uses.
    await post(base, {
      extractionId: "doc-citation",
      confirmedFields: [{ key: "dueDate", value: "2026-10-09" }],
      createCalendarEvents: [],
      calendarDates: [{ field: "dueDate", date: "2026-10-09", addToCalendar: true }],
      trackerEntries: [],
    });
    const doc = stubState.documents.get("doc-citation");
    const after = rulesFromAll({ profiles: [], documents: [doc] }).find((r) => r.ruleType === "due")!;

    expect(doc.extractedData.dueDate).toBe("2026-10-09");
    expect(after.id).toBe(before.id);                       // one date, one rule
    expect(seriesFromDateRules([after])[0].baseDate).toBe("2026-10-09");
    expect(stubState.events).toHaveLength(0);               // still no stray copy
  });

  it("a date no rule can be derived from still becomes a real calendar event", async () => {
    // The remaining uncovered case: a one-off the classifier does not
    // recognise. Nothing on the record can carry it, so an event is the only
    // home it has — and it is created.
    const res = await post(base, {
      extractionId: "doc-citation",
      confirmedFields: [{ key: "houseViewing", value: "2026-09-14" }],
      createCalendarEvents: [{
        field: "houseViewing", date: "2026-09-14", title: "📅 House Viewing", category: "other",
      }],
      calendarDates: [],
      trackerEntries: [],
    });
    expect(res.status).toBe(200);
    expect(stubState.events).toHaveLength(1);
    expect(stubState.events[0].date).toBe("2026-09-14");
    expect(stubState.events[0].linkedDocuments).toEqual(["doc-citation"]);
  });

  it("handles every actionable date type on one document", async () => {
    const dates = {
      expirationDate: "2026-09-10",
      renewalDate: "2026-09-18",
      filingDeadline: "2026-09-20",
      paymentDueDate: "2026-09-02",
      appointmentDate: "2026-09-06",
    };
    const res = await post(base, {
      extractionId: "doc-citation",
      confirmedFields: Object.entries(dates).map(([key, value]) => ({ key, value })),
      createCalendarEvents: [],
      calendarDates: Object.entries(dates).map(([key, date]) => ({
        field: key, path: key, date, addToCalendar: true, derived: true,
      })),
      trackerEntries: [],
    });
    expect(res.status).toBe(200);

    const doc = stubState.documents.get("doc-citation");
    for (const [key, value] of Object.entries(dates)) {
      expect(doc.extractedData[key]).toBe(value);
    }
    // Five dates, five derived calendar entries, no standalone events.
    const rules = rulesFromAll({ profiles: [], documents: [doc] });
    expect(rules.filter((r) => r.calendarVisible)).toHaveLength(5);
    expect(seriesFromDateRules(rules)).toHaveLength(5);
    expect(stubState.events).toHaveLength(0);
    expect(rules.every((r) => isDocumentAttentionRule(r) || r.ruleType === "appointment")).toBe(true);
  });

  it("one unticked date among several opts out only itself", async () => {
    const res = await post(base, {
      extractionId: "doc-citation",
      confirmedFields: [
        { key: "dueDate", value: "2026-09-25" },
        { key: "expirationDate", value: "2026-09-10" },
      ],
      createCalendarEvents: [],
      calendarDates: [
        { field: "dueDate", path: "dueDate", date: "2026-09-25", addToCalendar: false },
        { field: "expirationDate", path: "expirationDate", date: "2026-09-10", addToCalendar: true },
      ],
      trackerEntries: [],
    });
    expect(res.status).toBe(200);
    const doc = stubState.documents.get("doc-citation");
    expect(doc.extractedData[CALENDAR_OPT_OUT_KEY]).toEqual(["dueDate"]);

    const rules = rulesFromAll({ profiles: [], documents: [doc] });
    expect(rules.find((r) => r.ruleType === "due")!.calendarVisible).toBe(false);
    expect(rules.find((r) => r.ruleType === "expiration")!.calendarVisible).toBe(true);
    expect(seriesFromDateRules(rules)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The surfaces themselves, through real storage — not a hand-built row.
//
// The route tests above prove what PERSISTS. These prove that what the
// dashboard and the calendar actually serve from that stored document contains
// the due date, because "it's in extractedData" was true before this fix too.
// ─────────────────────────────────────────────────────────────────────────────
describe("stored document → dashboard and calendar payloads", () => {
  const oneMonthOut = () => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  };

  it("serves the citation as an upcoming due document and as a calendar item", async () => {
    const { MemStorage } = await import("../server/storage");
    const store = new MemStorage();
    const sarah = await store.createProfile({ name: "Sarah Miller", type: "self" } as any);
    const due = oneMonthOut();
    const doc = await store.createDocument({
      name: "Parking Violation Notice",
      type: "parking_citation",
      mimeType: "image/jpeg",
      fileData: "",
      extractedData: { citationNumber: "RV62045871", amountDue: 45, dueDate: due },
      linkedProfiles: [sarah.id],
      tags: [],
    } as any);

    // ── Executive Dashboard ──
    const enhanced: any = await store.getDashboardEnhanced();
    const row = (enhanced.expiringDocuments || []).find((d: any) => d.documentId === doc.id);
    expect(row).toBeDefined();
    expect(row.expirationDate).toBe(due);
    expect(row.ruleType).toBe("due");
    // The real remaining days, computed from the date — never a fixed label.
    expect(row.daysUntil).toBeGreaterThanOrEqual(28);
    expect(row.daysUntil).toBeLessThanOrEqual(31);
    expect(row.status).not.toBe("ok");

    // ── Calendar ──
    const from = new Date(); from.setUTCDate(from.getUTCDate() - 1);
    const timeline: any[] = await store.getCalendarTimeline(from.toISOString().slice(0, 10), due);
    const onCalendar = timeline.filter((i: any) => String(i.sourceId || "") === doc.id);
    expect(onCalendar).toHaveLength(1);
    expect(onCalendar[0].date.slice(0, 10)).toBe(due);
    // The calendar item names the document and links back to it — one date,
    // one entry, traceable to the record that owns it.
    expect(onCalendar[0].title).toContain("Parking Violation Notice");
    expect(onCalendar[0].meta.source).toBe("document");
    expect(String(onCalendar[0].meta.href)).toContain(doc.id);
  });

  it("takes it off the calendar — and only the calendar — when the user opted out", async () => {
    const { MemStorage } = await import("../server/storage");
    const store = new MemStorage();
    await store.createProfile({ name: "Sarah Miller", type: "self" } as any);
    const due = oneMonthOut();
    const doc = await store.createDocument({
      name: "Parking Violation Notice",
      type: "parking_citation",
      mimeType: "image/jpeg",
      fileData: "",
      extractedData: { dueDate: due, [CALENDAR_OPT_OUT_KEY]: ["dueDate"] },
      linkedProfiles: [],
      tags: [],
    } as any);

    const from = new Date(); from.setUTCDate(from.getUTCDate() - 1);
    const timeline: any[] = await store.getCalendarTimeline(from.toISOString().slice(0, 10), due);
    expect(timeline.filter((i: any) => String(i.sourceId || "") === doc.id)).toHaveLength(0);

    // The document itself still carries the date, and the Executive tab still
    // shows it: opting out of the calendar is not deleting the deadline.
    const enhanced: any = await store.getDashboardEnhanced();
    expect((enhanced.expiringDocuments || []).some((d: any) => d.documentId === doc.id)).toBe(true);
  });
});
