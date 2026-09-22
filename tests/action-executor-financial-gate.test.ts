// tests/action-executor-financial-gate.test.ts — Rules 3 and 4 at the write.
//
// RULE 3: never turn extracted information into a financial transaction
// without transaction evidence. The planner marks a non-paid expense action
// unsavable and the UI refuses to tick it, but the executor is the one gate
// an edited request body cannot get past — so it is tested directly, through
// the real confirm route against a stub storage, with bodies that claim
// `savable: true` and `selected: true` on money that was never paid.
//
// RULE 4: an explicit "do not create an expense" from the user vetoes even a
// paid one. The instruction reaches executeActions as `userMessage`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import type { ProposedAction } from "../shared/extraction-actions";

const { stubState, stubStorage } = vi.hoisted(() => {
  const state = {
    profiles: new Map<string, any>(),
    documents: new Map<string, any>(),
    expenses: [] as any[],
    links: [] as any[],
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
    async createExpense(data: any) { const row = { id: id("exp"), ...data }; state.expenses.push(row); return row; },
    async getExpenses() { return state.expenses; },
    async createEntityLink(data: any) { state.links.push(data); return data; },
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
import { executeActions } from "../server/action-executor";

const DOC = "doc-estimate";
const PERSON = "person-1";

/** An expense action exactly as a hostile or stale client would send it: savable, selected. */
const expenseAction = (over: Partial<ProposedAction> & { payload: Record<string, any> }): ProposedAction => ({
  id: "a-expense",
  operation: "CREATE",
  destination: "expense",
  destinationOptions: [],
  target: { kind: "expense", id: null, name: "Northside Auto Body" },
  roles: ["financial"],
  title: "Record expense — $549.50",
  factIds: [],
  itemIds: [],
  origin: "stated",
  selected: true,
  confidence: 0.95,
  warnings: [],
  stage: 2,
  savable: true,
  kind: "create_expense",
  kindLabel: "Create expense",
  dedupeKey: "k-expense",
  ...over,
} as ProposedAction);

describe("executeActions — Rule 3 at the write", () => {
  beforeEach(() => {
    stubState.expenses.length = 0;
    stubState.links.length = 0;
    stubState.profiles.clear();
    stubState.documents.clear();
    stubState.profiles.set(PERSON, { id: PERSON, name: "Jane Ortiz", type: "person", fields: {}, tags: [], notes: "" });
    stubState.documents.set(DOC, {
      id: DOC, name: "Auto body estimate", type: "auto_repair_estimate",
      mimeType: "application/pdf", extractedData: { totalAmount: 549.5, financialStatus: "unpaid", documentKind: "estimate" },
      linkedProfiles: [], tags: [],
    });
  });

  it("refuses an expense action whose payload says the money is NOT paid — even when the body claims it is savable", async () => {
    for (const status of ["estimated", "quoted", "invoiced", "unpaid", "scheduled", "pending", "refunded"]) {
      stubState.expenses.length = 0;
      const out = await executeActions({
        documentId: DOC,
        actions: [expenseAction({
          id: `a-${status}`,
          payload: { description: "Body work", amount: 549.5, date: "2026-09-14", financialStatus: status, _source: { documentId: DOC } },
        })],
      });
      expect(stubState.expenses, status).toHaveLength(0);
      const r = out.results.find((x) => x.actionId === `a-${status}`);
      expect(r?.status, status).toBe("skipped");
      expect(r?.message, status).toMatch(/not saved/i);
    }
  });

  it("refuses an expense action with NO financialStatus at all — absence of evidence is not evidence", async () => {
    const out = await executeActions({
      documentId: DOC,
      actions: [expenseAction({
        payload: { description: "Body work", amount: 549.5, date: "2026-09-14", _source: { documentId: DOC } },
      })],
    });
    expect(stubState.expenses).toHaveLength(0);
    expect(out.results[0]).toEqual(expect.objectContaining({ actionId: "a-expense", status: "skipped" }));
    expect(out.results[0].message).toMatch(/no evidence this was paid/i);
    expect(out.failures).toHaveLength(0);
  });

  it("writes an expense action whose payload says paid", async () => {
    const out = await executeActions({
      documentId: DOC,
      actions: [expenseAction({
        payload: { description: "Body work", amount: 549.5, date: "2026-09-14", financialStatus: "paid", _source: { documentId: DOC } },
      })],
    });
    expect(stubState.expenses).toHaveLength(1);
    expect(stubState.expenses[0].amount).toBe(549.5);
    expect(out.results[0].status).toBe("ok");
  });

  it("uses the planner's own reason when the action carries one", async () => {
    const out = await executeActions({
      documentId: DOC,
      actions: [expenseAction({
        savable: true,
        unsupportedReason: "This is an unpaid invoice — it stays on the document until you record the payment",
        payload: { description: "Plumbing", amount: 300, date: "2026-09-14", financialStatus: "invoiced" },
      })],
    });
    expect(stubState.expenses).toHaveLength(0);
    expect(out.results[0].message).toMatch(/unpaid invoice/i);
  });
});

describe("executeActions — Rule 4: the user's word outranks the plan", () => {
  beforeEach(() => {
    stubState.expenses.length = 0;
    stubState.documents.clear();
    stubState.documents.set(DOC, {
      id: DOC, name: "Oil change receipt", type: "vehicle_service_receipt",
      mimeType: "image/png", extractedData: { totalAmount: 118.14, amountPaid: 118.14, financialStatus: "paid" },
      linkedProfiles: [], tags: [],
    });
  });

  it("'Do not create an expense' vetoes a PAID expense action", async () => {
    const out = await executeActions({
      documentId: DOC,
      userMessage: "Nothing has been paid. Do not create an expense.",
      actions: [expenseAction({
        payload: { description: "Oil change", amount: 118.14, date: "2026-07-22", financialStatus: "paid" },
      })],
    });
    expect(stubState.expenses).toHaveLength(0);
    expect(out.results[0].status).toBe("skipped");
    expect(out.results[0].message).toMatch(/you said not to record an expense/i);
  });

  it("an ordinary upload message does not veto a paid expense", async () => {
    await executeActions({
      documentId: DOC,
      userMessage: "Here is the receipt from the oil change, file it under the Honda",
      actions: [expenseAction({
        payload: { description: "Oil change", amount: 118.14, date: "2026-07-22", financialStatus: "paid" },
      })],
    });
    expect(stubState.expenses).toHaveLength(1);
  });

  it("the veto only touches expenses — other actions still run", async () => {
    const out = await executeActions({
      documentId: DOC,
      userMessage: "Do not create an expense.",
      actions: [
        expenseAction({ payload: { description: "Oil change", amount: 118.14, date: "2026-07-22", financialStatus: "paid" } }),
        expenseAction({
          id: "a-field", destination: "entity_field", kind: "update_profile_field", kindLabel: "Update profile field",
          target: { kind: "profile", id: PERSON, name: "Jane Ortiz", profileType: "person" } as any,
          operation: "UPDATE", stage: 1, dedupeKey: "k-field",
          payload: { profileId: PERSON, fields: { mileage: "43120" } },
        }),
      ],
    });
    expect(stubState.expenses).toHaveLength(0);
    expect(out.results.find((r) => r.actionId === "a-expense")?.status).toBe("skipped");
    expect(out.results.find((r) => r.actionId === "a-field")?.status).toBe("ok");
  });
});

describe("POST /api/chat/confirm-extraction — the legacy body path is gated too", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    stubState.expenses.length = 0;
    stubState.profiles.clear();
    stubState.documents.clear();
    stubState.profiles.set("profile-self", { id: "profile-self", name: "Robert", type: "self", fields: {}, tags: [] });
    stubState.documents.set(DOC, {
      id: DOC, name: "Auto body estimate", type: "auto_repair_estimate",
      mimeType: "application/pdf",
      extractedData: { vendorName: "Northside Auto Body", totalAmount: 549.5, financialStatus: "unpaid", documentKind: "estimate" },
      linkedProfiles: [], tags: [],
    });
    stubState.documents.set("doc-receipt", {
      id: "doc-receipt", name: "Oil change receipt", type: "vehicle_service_receipt",
      mimeType: "image/png", extractedData: { totalAmount: 118.14, amountPaid: 118.14 },
      linkedProfiles: [], tags: [],
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

  const confirm = (body: Record<string, any>) => fetch(`${base}/api/chat/confirm-extraction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmedFields: [], createCalendarEvents: [], trackerEntries: [], ...body }),
  });

  it("the regression: `createExpense` for an unpaid $549.50 estimate is refused with a 200, not written", async () => {
    const res = await confirm({
      extractionId: DOC,
      createExpense: { description: "Northside Auto Body - vehicle", amount: 549.5, category: "vehicle", date: "2026-09-14" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(stubState.expenses).toHaveLength(0);
    expect(data.expenseSkipped).toBe(true);
    expect(data.financialStatus).toBe("unpaid");
    expect(String(data.expenseSkippedReason)).toMatch(/stays on the document/i);
    expect(data.failures).toEqual([]);
  });

  it("a paid receipt still creates the expense through the same body", async () => {
    const res = await confirm({
      extractionId: "doc-receipt",
      createExpense: { description: "Oil change", amount: 118.14, category: "vehicle", date: "2026-07-22" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.expenseSkipped).toBeUndefined();
    expect(stubState.expenses).toHaveLength(1);
  });

  it("'Do not create an expense' in the request vetoes even the paid receipt", async () => {
    const res = await confirm({
      extractionId: "doc-receipt",
      userMessage: "Do not create an expense.",
      createExpense: { description: "Oil change", amount: 118.14, category: "vehicle", date: "2026-07-22" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(stubState.expenses).toHaveLength(0);
    expect(data.expenseSkipped).toBe(true);
  });

  it("'log this as an expense' in the request creates one from the unpaid estimate — the user's call", async () => {
    const res = await confirm({
      extractionId: DOC,
      userMessage: "I paid this in cash, log it as an expense",
      createExpense: { description: "Body work", amount: 549.5, category: "vehicle", date: "2026-09-14" },
    });
    expect(res.status).toBe(200);
    expect(stubState.expenses).toHaveLength(1);
  });

  it("a stored financialStatus on the document outranks the body's claim", async () => {
    const res = await confirm({
      extractionId: DOC,
      createExpense: { description: "Body work", amount: 549.5, category: "vehicle", date: "2026-09-14", financialStatus: "paid" },
    });
    expect(res.status).toBe(200);
    expect(stubState.expenses).toHaveLength(0);
    expect((await res.json()).expenseSkipped).toBe(true);
  });
});
