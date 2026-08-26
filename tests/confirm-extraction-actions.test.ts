// tests/confirm-extraction-actions.test.ts — the reviewed plan, actually written.
//
// tests/extraction-actions.test.ts proves the PLAN is right. This proves the
// route does what the plan says, in an order that respects the dependencies
// between the writes, and reports honestly when part of it fails.
//
// The document under test is the homeowners declarations page from the bug
// report, whose whole point is that it is about THREE records at once: the
// property (year built, square feet), the policy terms (namespaced under the
// house), and the mortgage it is linked to. The old route resolved one
// `resolvedProfileId` and merged everything onto it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import { mergeFieldWrite } from "../shared/profile-field-identity";
import type { ProposedAction } from "../shared/extraction-actions";

const { stubState, stubStorage } = vi.hoisted(() => {
  const state = {
    profiles: new Map<string, any>(),
    documents: new Map<string, any>(),
    obligations: [] as any[],
    liabilityPayments: [] as any[],
    tasks: [] as any[],
    expenses: [] as any[],
    trackers: [] as any[],
    entries: [] as any[],
    artifacts: [] as any[],
    events: [] as any[],
    entityLinks: [] as any[],
    liabilityAssetLinks: [] as any[],
    /** Set to a profile id to make every write to it fail. */
    failProfileWrite: null as string | null,
  };
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;

  const impl: any = {
    async getProfile(pid: string) { return state.profiles.get(pid); },
    async getProfiles() { return [...state.profiles.values()]; },
    async getProfilesLite() { return [...state.profiles.values()]; },
    async updateProfile(pid: string, patch: any) {
      if (state.failProfileWrite === pid) throw new Error("storage is down");
      const cur = state.profiles.get(pid);
      if (!cur) return undefined;
      const incoming: Record<string, any> = {};
      for (const [k, v] of Object.entries(patch.fields || {})) {
        if (v !== null && v !== undefined) incoming[k] = v;
      }
      const write = mergeFieldWrite(cur.fields || {}, incoming);
      const fields: Record<string, any> = { ...write.fields };
      for (const k of write.superseded) delete fields[k];
      const updated = { ...cur, ...patch, fields };
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
    async getObligations() { return state.obligations; },
    async getLiabilityPayments() { return state.liabilityPayments; },
    async createLiabilityPayment(data: any) {
      const row = { id: id("pay"), ...data };
      state.liabilityPayments.push(row);
      return row;
    },
    async updateLiabilityPayment(pid: string, patch: any) {
      const row = state.liabilityPayments.find((x) => x.id === pid);
      if (row) Object.assign(row, patch);
      return row;
    },
    async getTasks() { return state.tasks; },
    async createTask(data: any) {
      const row = { id: id("task"), ...data };
      state.tasks.push(row);
      return row;
    },
    async createObligation(data: any) {
      const row = { id: id("obl"), fields: {}, ...data };
      state.obligations.push(row);
      return row;
    },
    async updateObligation(oid: string, patch: any) {
      const o = state.obligations.find((x) => x.id === oid);
      if (!o) return undefined;
      Object.assign(o, patch);
      return o;
    },
    async getExpenses() { return state.expenses; },
    async createExpense(data: any) {
      const row = { id: id("exp"), ...data };
      state.expenses.push(row);
      return row;
    },
    async getTrackers() { return state.trackers; },
    async createTracker(data: any) {
      const row = { id: id("trk"), entries: [], linkedProfiles: [], ...data };
      state.trackers.push(row);
      return row;
    },
    async updateTracker(tid: string, patch: any) {
      const t = state.trackers.find((x) => x.id === tid);
      if (t) Object.assign(t, patch);
      return t;
    },
    async logEntry(data: any) {
      const row = { id: id("ent"), ...data };
      state.entries.push(row);
      const t = state.trackers.find((x) => x.id === data.trackerId);
      if (t) t.entries.push(row);
      return row;
    },
    async createArtifact(data: any) {
      const row = { id: id("art"), ...data };
      state.artifacts.push(row);
      return row;
    },
    async getArtifacts() { return state.artifacts; },
    async listArtifacts() { return state.artifacts; },
    async createEvent(data: any) {
      const row = { id: id("evt"), ...data };
      state.events.push(row);
      return row;
    },
    async getEvents() { return state.events; },
    async getEntityLinks(entityType: string, entityId: string) {
      return state.entityLinks.filter(
        (l) => (l.sourceType === entityType && l.sourceId === entityId) ||
               (l.targetType === entityType && l.targetId === entityId),
      );
    },
    async createEntityLink(data: any) {
      const row = { id: id("lnk"), ...data };
      state.entityLinks.push(row);
      return row;
    },
    // Deliberately throws, exactly as MemStorage does (server/storage.ts:2642).
    // The executor must fall back to the generic entity_links table rather than
    // losing the relationship — and a dev run must not differ from production
    // in whether a mortgage-bearing document can be confirmed at all.
    async createLiabilityAssetLink() { throw new Error("not implemented in MemStorage"); },
    async getLiabilityAssetLinks() { return state.liabilityAssetLinks; },
    async getAssetPartyLinks() { return []; },
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

// ── The reviewed plan, as the review pane would send it ─────────────────────

const DOC = "doc-declarations";

const action = (over: Partial<ProposedAction> & Pick<ProposedAction, "id" | "destination">): ProposedAction => ({
  operation: "UPDATE",
  destinationOptions: [],
  target: { kind: "profile", id: null, name: "" },
  roles: [],
  title: over.id,
  factIds: [],
  itemIds: [],
  payload: {},
  origin: "stated",
  selected: true,
  confidence: 0.9,
  warnings: [],
  stage: 2,
  dedupeKey: `k-${over.id}`,
  ...over,
} as ProposedAction);

function declarationsPlan(): ProposedAction[] {
  return [
    action({
      id: "a-property", destination: "entity_field", operation: "UPDATE",
      target: { kind: "profile", id: "prop-1", name: "123 Evergreen Ln", profileType: "property" },
      title: "Update 3 fields on 123 Evergreen Ln",
      itemIds: ["field-yearbuilt", "field-squarefeet", "field-rooftype"],
      payload: {
        profileId: "prop-1",
        fields: { yearBuilt: "2018", squareFeet: "2450", roofType: "Composition Single" },
        _source: { documentId: DOC },
      },
    }),
    action({
      id: "a-policy", destination: "entity_record", operation: "UPDATE",
      target: { kind: "profile", id: "prop-1", name: "123 Evergreen Ln", profileType: "property", group: "insurance" },
      title: "Update 2 fields on 123 Evergreen Ln",
      itemIds: ["field-policynumber", "field-carrier"],
      payload: {
        profileId: "prop-1", group: "insurance",
        fields: { policyNumber: "SPI-24-87654321", carrier: "Summit Peak Insurance Group" },
        _source: { documentId: DOC },
      },
    }),
    action({
      id: "a-person", destination: "profile", operation: "UPDATE",
      target: { kind: "profile", id: "person-1", name: "Johnathan A. Doe", profileType: "self" },
      title: "Update 1 field on Johnathan A. Doe",
      itemIds: ["field-mailingaddress"],
      payload: {
        profileId: "person-1",
        fields: { mailingAddress: "123 Evergreen Lane, Springfield, CO 80501" },
        _source: { documentId: DOC },
      },
    }),
    action({
      id: "a-payment", destination: "liability_payment", operation: "RECORD",
      target: { kind: "liability_payment", id: "liab-1", name: "Pinnacle Home Loans Mortgage" },
      title: "Record payment — $1,428",
      itemIds: ["field-annualpremium"],
      payload: {
        liabilityId: "liab-1", amount: 1428, date: "2024-06-01",
        _source: { documentId: DOC },
      },
      dedupeKey: "k-payment",
    }),
    action({
      id: "a-renewal", destination: "task", operation: "CREATE",
      target: { kind: "task", id: null, name: "Renew homeowners policy" },
      title: "Repeating task — Renew homeowners policy",
      itemIds: ["field-paymentplan", "field-paymentduedate"],
      payload: {
        title: "Renew homeowners policy", dueDate: "2025-06-01",
        recurrence: "yearly", linkedProfileId: "prop-1",
        _source: { documentId: DOC },
      },
      dedupeKey: "k-renewal",
    }),
    action({
      id: "a-expiry", destination: "calendar", operation: "UPDATE",
      target: { kind: "profile", id: "prop-1", name: "123 Evergreen Ln", profileType: "property" },
      title: "Expiration rule — Expiration Date",
      itemIds: ["field-expirationdate"],
      payload: {
        key: "expirationDate", date: "2025-06-01", ruleType: "expiration",
        profileId: "prop-1", group: "insurance", derived: true,
        fields: { expirationDate: "2025-06-01" },
        _source: { documentId: DOC },
      },
      stage: 4,
    }),
    action({
      id: "a-link", destination: "relationship_link", operation: "LINK",
      target: { kind: "relationship", id: null, name: "123 Evergreen Ln → Pinnacle Home Loans" },
      title: "Link 123 Evergreen Ln financed_by Pinnacle Home Loans",
      payload: { fromId: "prop-1", toId: "liab-1", type: "financed_by", _source: { documentId: DOC } },
      stage: 3,
    }),
    action({
      id: "a-attach", destination: "document_attach", operation: "LINK",
      target: { kind: "document", id: "prop-1", name: "123 Evergreen Ln" },
      title: "File this document under 123 Evergreen Ln",
      payload: { profileId: "prop-1", documentId: DOC },
      stage: 3,
    }),
    action({
      id: "a-signature", destination: "reference", operation: "NO_ACTION",
      target: { kind: "document", id: DOC, name: "declarations page" },
      title: "Authorized Representative Signature Date",
      itemIds: ["field-signaturedate"],
      payload: { key: "signatureDate", value: "2024-05-20", calendarOptOut: true },
      stage: 4,
    }),
  ];
}

async function post(base: string, body: any) {
  return fetch(`${base}/api/chat/confirm-extraction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat/confirm-extraction — the reviewed plan", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    stubState.profiles.clear();
    stubState.documents.clear();
    stubState.obligations.length = 0;
    stubState.liabilityPayments.length = 0;
    stubState.tasks.length = 0;
    stubState.expenses.length = 0;
    stubState.trackers.length = 0;
    stubState.entries.length = 0;
    stubState.artifacts.length = 0;
    stubState.events.length = 0;
    stubState.entityLinks.length = 0;
    stubState.failProfileWrite = null;

    stubState.profiles.set("prop-1", {
      id: "prop-1", name: "123 Evergreen Ln", type: "property", fields: {}, tags: [], notes: "",
    });
    stubState.profiles.set("person-1", {
      id: "person-1", name: "Johnathan A. Doe", type: "self", fields: {}, tags: [], notes: "",
    });
    stubState.profiles.set("liab-1", {
      id: "liab-1", name: "Pinnacle Home Loans Mortgage", type: "liability",
      fields: { loanNumber: "PHL-4471903" }, tags: [], notes: "",
    });
    stubState.documents.set(DOC, {
      id: DOC, name: "Summit Peak — Declarations Page", type: "insurance_policy",
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

  const confirm = (actions: ProposedAction[] = declarationsPlan()) =>
    post(base, { extractionId: DOC, actions });

  it("writes one document to three different records", async () => {
    const res = await confirm();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.failures).toEqual([]);

    // The property got its own attributes...
    const prop = stubState.profiles.get("prop-1").fields;
    expect(prop.yearBuilt).toBe("2018");
    expect(prop.squareFeet).toBe("2450");
    expect(prop.roofType).toBe("Composition Single");

    // ...the policy terms are namespaced under it, not loose beside them...
    expect(prop.insurance.policyNumber).toBe("SPI-24-87654321");
    expect(prop.insurance.carrier).toBe("Summit Peak Insurance Group");
    expect(prop.policyNumber).toBeUndefined();

    // ...and the person got only what is about the person.
    const person = stubState.profiles.get("person-1").fields;
    expect(person.mailingAddress).toBe("123 Evergreen Lane, Springfield, CO 80501");
    expect(person.yearBuilt).toBeUndefined();
  });

  it("records provenance per profile, so deleting the document can undo exactly its own work", async () => {
    await confirm();
    const prop = stubState.profiles.get("prop-1").fields;
    const person = stubState.profiles.get("person-1").fields;
    expect(Object.keys(prop._docFields[DOC])).toEqual(
      expect.arrayContaining(["yearBuilt", "squareFeet", "roofType", "insurance.policyNumber"]),
    );
    expect(Object.keys(person._docFields[DOC])).toEqual(["mailingAddress"]);
  });

  it("records the payment through the existing liability-payment path", async () => {
    await confirm();
    expect(stubState.liabilityPayments).toHaveLength(1);
    const pay = stubState.liabilityPayments[0];
    expect(pay.liabilityProfileId).toBe("liab-1");
    expect(pay.amount).toBe(1428);
    // Not filed as an expense: a payment against a debt and a charge are
    // different things, and counting it as both doubles the month's outgoings.
    expect(stubState.expenses).toHaveLength(0);
  });

  it("creates a repeating task for the renewal, tagged the way every other one is", async () => {
    await confirm();
    const task = stubState.tasks.find((t: any) => t.title === "Renew homeowners policy");
    expect(task).toBeTruthy();
    expect(task.dueDate).toBe("2025-06-01");
    expect(task.tags).toContain("recur:yearly");
    expect(task.linkedProfiles).toEqual(["prop-1"]);
  });

  it("RULE 1 — the legacy path cannot create one either", async () => {
    // This is the path that runs when the understanding stage degraded, or for
    // a chat message rendered from history. It used to call createObligation
    // directly, which mints a liability profile — so confirming a declarations
    // page would leave a liability beside the house. It updates or it reports;
    // it never creates.
    const res = await post(base, {
      extractionId: DOC,
      targetProfileId: "prop-1",
      createObligation: { name: "Homeowners premium", amount: 1428, frequency: "yearly", nextDueDate: "2024-06-01" },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(stubState.obligations).toHaveLength(0);
    expect(stubState.profiles.size).toBe(3);
    expect(data.skipped.join(" ")).toMatch(/never creates one/i);
  });

  it("the legacy path DOES update a bill that already exists", async () => {
    stubState.obligations.push({
      id: "obl-1", name: "Homeowners premium", amount: 1200,
      linkedProfiles: ["prop-1"], fields: {},
    });
    const res = await post(base, {
      extractionId: DOC,
      targetProfileId: "prop-1",
      createObligation: { name: "Homeowners premium", amount: 1428, frequency: "yearly", nextDueDate: "2024-06-01" },
    });
    expect(res.status).toBe(200);
    expect(stubState.obligations).toHaveLength(1);
    expect(stubState.obligations[0].amount).toBe(1428);
    expect(stubState.obligations[0].nextDueDate).toBe("2024-06-01");
  });

  it("RULE 1 — refuses to create a liability even when asked to", async () => {
    // The planner will not mark this savable and the UI will not tick it. This
    // asserts the third gate: a hand-edited request body still writes nothing.
    const rogue = action({
      id: "a-rogue", destination: "obligation", operation: "CREATE",
      target: { kind: "obligation", id: null, name: "Homeowners premium" },
      title: "Create recurring bill",
      payload: { name: "Homeowners premium", amount: 1428, frequency: "yearly", nextDueDate: "2024-06-01" },
      dedupeKey: "k-rogue",
      selected: true,
    });
    const res = await post(base, { extractionId: DOC, actions: [rogue] });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(stubState.obligations).toHaveLength(0);
    expect(stubState.profiles.size).toBe(3);   // exactly the three we seeded
    const r = data.actionResults.find((x: any) => x.actionId === "a-rogue");
    expect(r.status).toBe("skipped");
    expect(r.message).toMatch(/never creates profiles|liabilit/i);
  });

  it("puts the expiration on the record instead of creating a second copy of it", async () => {
    await confirm();
    const prop = stubState.profiles.get("prop-1").fields;
    expect(prop.insurance.expirationDate).toBe("2025-06-01");
    // A date the record derives needs no standalone event, and creating one
    // would be the app's second date system: a copy that drifts when the field
    // is edited and outlives the document that made it.
    expect(stubState.events).toHaveLength(0);
  });

  it("keeps the signature date on the document and opts it out of the calendar", async () => {
    await confirm();
    const doc = stubState.documents.get(DOC);
    expect(doc.extractedData._calendarOptOut).toContain("signatureDate");
    expect(stubState.events).toHaveLength(0);
  });

  it("falls back to the generic link table when the typed one is unavailable", async () => {
    // MemStorage throws on createLiabilityAssetLink. Losing the relationship
    // there would mean a dev run and a route test behave differently from
    // production for every mortgage-bearing document.
    const res = await confirm();
    expect(res.status).toBe(200);
    expect(stubState.entityLinks).toHaveLength(1);
    expect(stubState.entityLinks[0]).toMatchObject({
      sourceId: "prop-1", targetId: "liab-1", relationship: "financed_by",
    });
  });

  it("reports an outcome for every action", async () => {
    const data = await (await confirm()).json();
    const ids = declarationsPlan().filter((a) => a.operation !== "NO_ACTION").map((a) => a.id);
    for (const id of ids) {
      const r = data.actionResults.find((x: any) => x.actionId === id);
      expect(r, `no result for ${id}`).toBeTruthy();
      expect(r.status).toBe("ok");
    }
  });

  it("confirming twice changes nothing and still reports clean", async () => {
    await confirm();
    const afterFirst = JSON.stringify({
      prop: stubState.profiles.get("prop-1").fields,
      person: stubState.profiles.get("person-1").fields,
      payments: stubState.liabilityPayments.length,
      tasks: stubState.tasks.length,
      links: stubState.entityLinks.length,
    });

    const res = await confirm();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.failures).toEqual([]);

    expect(stubState.liabilityPayments).toHaveLength(1);
    expect(stubState.tasks).toHaveLength(1);
    expect(stubState.expenses).toHaveLength(0);
    expect(stubState.events).toHaveLength(0);
    const afterSecond = JSON.stringify({
      prop: stubState.profiles.get("prop-1").fields,
      person: stubState.profiles.get("person-1").fields,
      payments: stubState.liabilityPayments.length,
      tasks: stubState.tasks.length,
      links: stubState.entityLinks.length,
    });
    expect(afterSecond).toBe(afterFirst);
  });

  it("skips what depended on a record it could not write, instead of cascading errors", async () => {
    stubState.failProfileWrite = "prop-1";
    const res = await confirm();
    const data = await res.json();

    const propertyResult = data.actionResults.find((r: any) => r.actionId === "a-property");
    expect(propertyResult.status).toBe("failed");

    // Everything else about the property is reported as SKIPPED — not attempted
    // and not failed. A cascade of secondary errors buries the one real cause.
    for (const id of ["a-policy", "a-expiry"]) {
      const r = data.actionResults.find((x: any) => x.actionId === id);
      expect(r.status, `${id} should be skipped, not attempted`).toBe("skipped");
    }
    // And the writes that had nothing to do with the property still happened.
    expect(stubState.profiles.get("person-1").fields.mailingAddress).toBeTruthy();
    expect(stubState.liabilityPayments).toHaveLength(1);
  });

  it("an unticked action is not written", async () => {
    const p = declarationsPlan().map((a) =>
      a.id === "a-payment" ? { ...a, selected: false } : a);
    await confirm(p);
    expect(stubState.liabilityPayments).toHaveLength(0);
    expect(stubState.profiles.get("prop-1").fields.yearBuilt).toBe("2018");
  });

  it("a row a selected action already owns is not also written by the legacy path", async () => {
    // The client partitions `items` and `actions`, but a row reaching both
    // paths would write the same fact twice — so the route enforces the
    // partition rather than trusting it.
    const res = await post(base, {
      extractionId: DOC,
      targetProfileId: "person-1",
      actions: declarationsPlan(),
      items: [{
        id: "field-yearbuilt", key: "yearBuilt", label: "Year Built", value: "1999",
        destination: "profile", destinationOptions: [], selected: true, source: "field",
      }],
    });
    expect(res.status).toBe(200);
    // The action's value stands; the legacy row for the same id wrote nothing.
    expect(stubState.profiles.get("prop-1").fields.yearBuilt).toBe("2018");
    expect(stubState.profiles.get("person-1").fields.yearBuilt).toBeUndefined();
  });
});
