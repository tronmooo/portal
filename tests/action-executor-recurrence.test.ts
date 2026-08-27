// tests/action-executor-recurrence.test.ts — the writes the plan promises.
//
// USER REQUEST (2026-08-27): a birthday "should create a reoccurring event
// every year ... and it should be in the calendar under reoccurring."
//
// It could not. `CalendarEvent.recurrence` has always been a real column and
// `storage.createEvent` has always accepted it, but the extraction executor's
// only createEvent call passed title/date/category/tags and nothing else — so
// every event a document produced was a single day, once, forever. Same story
// for `Expense.isRecurring` and `Income.frequency`, and for `Income.description`,
// which the executor never sent at all (it sent `source`, which the insert
// schema does not declare, so extracted income arrived with an empty
// description).
//
// These tests drive the real confirm route against a stub storage and assert on
// what actually reached it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import type { ProposedAction } from "../shared/extraction-actions";

const { stubState, stubStorage } = vi.hoisted(() => {
  const state = {
    profiles: new Map<string, any>(),
    documents: new Map<string, any>(),
    events: [] as any[],
    expenses: [] as any[],
    incomes: [] as any[],
    habits: [] as any[],
    journal: [] as any[],
  };
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;

  const impl: any = {
    async getProfile(pid: string) { return state.profiles.get(pid); },
    async getProfiles() { return [...state.profiles.values()]; },
    async getProfilesLite() { return [...state.profiles.values()]; },
    async updateProfile(pid: string, patch: any) {
      const cur = state.profiles.get(pid);
      if (!cur) return undefined;
      const updated = { ...cur, ...patch, fields: { ...(cur.fields || {}), ...(patch.fields || {}) } };
      state.profiles.set(pid, updated);
      return updated;
    },
    async getDocument(did: string) { return state.documents.get(did); },
    async updateDocument(did: string, patch: any) {
      const cur = state.documents.get(did);
      if (!cur) return undefined;
      const updated = { ...cur, ...patch };
      state.documents.set(did, updated);
      return updated;
    },
    async createEvent(data: any) { const row = { id: id("evt"), ...data }; state.events.push(row); return row; },
    async getEvents() { return state.events; },
    async createExpense(data: any) { const row = { id: id("exp"), ...data }; state.expenses.push(row); return row; },
    async getExpenses() { return state.expenses; },
    async createIncome(data: any) { const row = { id: id("inc"), ...data }; state.incomes.push(row); return row; },
    async getIncomes() { return state.incomes; },
    async createHabit(data: any) { const row = { id: id("hab"), ...data }; state.habits.push(row); return row; },
    async getHabits() { return state.habits; },
    async createJournalEntry(data: any) { const row = { id: id("jrn"), ...data }; state.journal.push(row); return row; },
    async getJournalEntries() { return state.journal; },
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

const DOC = "doc-1";
const PERSON = "person-1";

const action = (over: Partial<ProposedAction> & Pick<ProposedAction, "id" | "destination">): ProposedAction => ({
  operation: "CREATE",
  destinationOptions: [],
  target: { kind: "none", id: null, name: "" },
  roles: [],
  title: over.id,
  factIds: [],
  itemIds: [],
  payload: {},
  origin: "implied",
  selected: true,
  confidence: 0.9,
  warnings: [],
  stage: 4,
  savable: true,
  kind: "create_calendar_event",
  kindLabel: "Create calendar event",
  dedupeKey: `k-${over.id}`,
  ...over,
} as ProposedAction);

describe("what the executor actually writes", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    stubState.profiles.clear();
    stubState.documents.clear();
    stubState.events.length = 0;
    stubState.expenses.length = 0;
    stubState.incomes.length = 0;
    stubState.habits.length = 0;
    stubState.journal.length = 0;

    stubState.profiles.set(PERSON, {
      id: PERSON, name: "Jane Ortiz", type: "person", fields: {}, tags: [], notes: "",
    });
    stubState.documents.set(DOC, {
      id: DOC, name: "Lab report", type: "medical_report",
      mimeType: "application/pdf", extractedData: {}, linkedProfiles: [], tags: [],
    });

    const app = express();
    app.use(express.json());
    server = createServer(app);
    await registerRoutes(server, app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const confirm = (actions: ProposedAction[]) => fetch(`${base}/api/chat/confirm-extraction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ extractionId: DOC, actions }),
  });

  it("a birthday writes the date to the person AND creates a yearly event", async () => {
    const res = await confirm([action({
      id: "a-birthday", destination: "calendar", operation: "UPDATE",
      target: { kind: "profile", id: PERSON, name: "Jane Ortiz", profileType: "person" },
      title: "Birthday — Date Of Birth (every year)",
      payload: {
        key: "dateOfBirth", date: "1975-04-12", ruleType: "birthday",
        recurrence: "yearly", profileId: PERSON, derived: true,
        fields: { dateOfBirth: "1975-04-12" },
        createEvent: true, title: "🎂 Jane Ortiz's Birthday",
        _source: { documentId: DOC },
      },
    })]);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.failures).toEqual([]);

    // Half one — the record owns the date, which is what derives the rule.
    expect(stubState.profiles.get(PERSON).fields.dateOfBirth).toBe("1975-04-12");

    // Half two — the event, repeating, linked to that same person so the
    // calendar's shadow guard can dedupe it against the derived rule.
    expect(stubState.events).toHaveLength(1);
    const ev = stubState.events[0];
    expect(ev.recurrence).toBe("yearly");
    expect(ev.date).toBe("1975-04-12");
    expect(ev.linkedProfiles).toEqual([PERSON]);
    expect(String(ev.title).toLowerCase()).toContain("birthday");
    expect(ev.category).toBe("family");
    expect(ev.tags).toContain("recurring");
  });

  it("a one-off derived date still creates no event — nothing to fall out of step", async () => {
    await confirm([action({
      id: "a-expiry", destination: "calendar", operation: "UPDATE",
      target: { kind: "profile", id: PERSON, name: "Jane Ortiz", profileType: "person" },
      payload: {
        key: "expirationDate", date: "2027-01-31", ruleType: "expiration",
        recurrence: "none", profileId: PERSON, derived: true,
        fields: { expirationDate: "2027-01-31" },
        createEvent: false,
        _source: { documentId: DOC },
      },
    })]);
    expect(stubState.profiles.get(PERSON).fields.expirationDate).toBe("2027-01-31");
    expect(stubState.events).toHaveLength(0);
  });

  it("a standalone date gets an event carrying its rule type as a category", async () => {
    await confirm([action({
      id: "a-return", destination: "calendar", operation: "CREATE",
      target: { kind: "event", id: null, name: "Return deadline" },
      payload: {
        title: "Return deadline — TechMart", date: "2026-08-18",
        ruleType: "expiration", periodKind: "Return deadline", createEvent: true,
        _source: { documentId: DOC },
      },
    })]);
    expect(stubState.events).toHaveLength(1);
    expect(stubState.events[0].category).toBe("personal");
    expect(stubState.events[0].recurrence).toBe("none");
    expect(stubState.events[0].tags).toContain("rule:expiration");
  });

  it("a recurring charge is stored as a recurring expense", async () => {
    await confirm([action({
      id: "a-rent", destination: "expense", operation: "CREATE",
      target: { kind: "expense", id: null, name: "Rent" },
      stage: 2,
      payload: {
        description: "Rent", amount: 2150, date: "2026-09-01",
        frequency: "monthly", isRecurring: true, category: "housing",
        _source: { documentId: DOC },
      },
    })]);
    expect(stubState.expenses).toHaveLength(1);
    expect(stubState.expenses[0].isRecurring).toBe(true);
    expect(stubState.expenses[0].frequency).toBe("monthly");
  });

  it("income carries a description and its frequency", async () => {
    await confirm([action({
      id: "a-pay", destination: "income", operation: "CREATE",
      target: { kind: "income", id: null, name: "Salary" },
      stage: 2,
      payload: {
        name: "Salary", amount: 3200, date: "2026-09-01", frequency: "biweekly",
        _source: { documentId: DOC },
      },
    })]);
    expect(stubState.incomes).toHaveLength(1);
    // `description` is the field insertIncomeSchema declares; sending only
    // `source` is what left extracted income blank.
    expect(stubState.incomes[0].description).toBe("Salary");
    expect(stubState.incomes[0].frequency).toBe("biweekly");
  });

  it("a repeating practice becomes a habit", async () => {
    await confirm([action({
      id: "a-habit", destination: "habit", operation: "CREATE",
      target: { kind: "habit", id: null, name: "Take 500mg with food" },
      stage: 2,
      payload: { name: "Take 500mg with food", frequency: "daily", profileId: PERSON, _source: { documentId: DOC } },
    })]);
    expect(stubState.habits).toHaveLength(1);
    expect(stubState.habits[0].name).toBe("Take 500mg with food");
    expect(stubState.habits[0].frequency).toBe("daily");
  });

  it("a past event becomes a journal entry with a neutral mood", async () => {
    await confirm([action({
      id: "a-history", destination: "journal", operation: "CREATE",
      target: { kind: "journal", id: null, name: "Inspection Completed" },
      stage: 2,
      payload: {
        title: "Inspection Completed", content: "Passed", date: "2026-08-01",
        mood: "neutral", profileId: PERSON, _source: { documentId: DOC },
      },
    })]);
    expect(stubState.journal).toHaveLength(1);
    expect(stubState.journal[0].mood).toBe("neutral");
    expect(stubState.journal[0].date).toBe("2026-08-01");
  });
});
