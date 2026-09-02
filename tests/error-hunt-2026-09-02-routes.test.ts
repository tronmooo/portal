// Route-level regressions for the 2026-09-02 error-hunting round — the ten
// items that live in server/routes.ts. Each `describe` drives the REAL Express
// app (tests/helpers/route-harness's storage double, booted here so a test can
// extend the double with the methods its route touches) and then reads what
// the route wrote, so it fails if a handler stops calling the guard.
//
// Every `it` below fails on the pre-fix code unless it says otherwise.

import { describe, it, expect, afterEach, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { requestStorageContext } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { makeFakeStorage, type FakeDb, type Harness } from "./helpers/route-harness";
import { ACTIVE_PROFILE_HEADER } from "../shared/active-scope";
import { getUserCurrentMonth } from "../shared/timezone";

const TZ = "America/Los_Angeles";
const SELF = { id: "self-1", type: "self", name: "Test" };
const MIKE = { id: "mike-1", type: "person", name: "Mike" };
const JANE = { id: "jane-1", type: "person", name: "Jane" };
const asMike = { [ACTIVE_PROFILE_HEADER]: MIKE.id };

// ─── Harness: the real app over the shared double, with the double exposed ───
let seq = 0;
interface Booted extends Harness { storage: any }
async function boot(seed: Partial<FakeDb> = {}, extend?: (storage: any, db: FakeDb) => void): Promise<Booted> {
  const db: FakeDb = {
    profiles: [], liabilityPayments: [], expenses: [], incomes: [], obligations: [],
    tasks: [], events: [], documents: [], getDocumentCalls: 0,
    bumpDataVersionCalls: 0, domainVersions: {}, lastBumpedDomains: [], ...seed,
  };
  const storage: any = makeFakeStorage(db);
  extend?.(storage, db);
  const app = express();
  app.use(express.json());
  const userId = `eh-user-${++seq}`;
  app.use((req, _res, next) => {
    (req as any).userId = userId;
    requestStorageContext.run(storage, () => next());
  });
  const httpServer: Server = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const api: Harness["api"] = async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Timezone": TZ, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    const responseHeaders: Record<string, string> = {};
    r.headers.forEach((v, k) => { responseHeaders[k] = v; });
    return { status: r.status, ok: r.ok, data, headers: responseHeaders };
  };
  return { db, api, storage, close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())) };
}

let h: Booted;
afterEach(async () => { if (h) await h.close(); });

/** A recurring bill both the obligations surface and payBillOccurrence accept. */
const BILL = {
  id: "bbbbbbbb-1111-4111-8111-111111111111", name: "Power", type: "liability", type_key: "utility",
  fields: { amount: 80, monthlyAmount: 80, frequency: "monthly", dueDate: "2026-09-10", nextDueDate: "2026-09-10" },
  linkedProfiles: [],
};
const BILL_OBLIGATION = { id: BILL.id, name: "Power", amount: 80, frequency: "monthly", nextDueDate: "2026-09-10" };

/**
 * The occurrence stamp + row delete the real storage provides. The shared
 * double answers unknown methods with `[]` (truthy), which makes pay believe
 * it claimed an occurrence it never stamped — so the items that read the stamp
 * back (8) install these.
 */
function liabilityLedger(storage: any, db: FakeDb) {
  storage.getLiabilityPayment = async (pid: string) => db.liabilityPayments.find(p => p.id === pid);
  storage.deleteLiabilityPayment = async (pid: string) => {
    const before = db.liabilityPayments.length;
    db.liabilityPayments = db.liabilityPayments.filter(p => p.id !== pid);
    return db.liabilityPayments.length < before;
  };
  storage.updateLiabilityPayment = async (pid: string, patch: any) => {
    const row = db.liabilityPayments.find(p => p.id === pid);
    if (!row) return undefined;
    Object.assign(row, patch);
    return row;
  };
  storage.claimBillOccurrence = async (liabilityId: string, date: string, stamp: any, extra: any) => {
    const p = db.profiles.find(x => x.id === liabilityId);
    if (!p) throw new Error("Liability not found");
    const prior = { ...((p.fields || {}).occurrences || {}) };
    if (prior[date]?.status === "paid") return { status: "already-paid", occurrences: prior };
    p.fields = { ...(p.fields || {}), ...extra, occurrences: { ...prior, [date]: { ...(prior[date] || {}), ...stamp } } };
    return { status: "claimed", occurrences: prior };
  };
  storage.updateOccurrenceOverride = async (liabilityId: string, date: string, patch: any) => {
    const p = db.profiles.find(x => x.id === liabilityId);
    if (!p) return undefined;
    const occ = { ...((p.fields || {}).occurrences || {}) };
    occ[date] = { ...(occ[date] || {}), ...patch };
    p.fields = { ...(p.fields || {}), occurrences: occ };
    return p;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 — POST /api/obligations/:id/pay: a failed first tap poisoned the dedupe
//     window, so the retry got {ok:true, deduped:true} and no payment.
// ─────────────────────────────────────────────────────────────────────────────
describe("1: pay dedupe never answers success without a real prior payment", () => {
  it("a retry after a thrown first attempt performs the payment", async () => {
    let failOnce = true;
    h = await boot({ profiles: [SELF, { ...BILL, fields: { ...BILL.fields } }], obligations: [BILL_OBLIGATION] }, (storage, db) => {
      storage.getProfile = async (pid: string) => {
        if (failOnce && pid === BILL.id) { failOnce = false; throw new Error("transient db error"); }
        return db.profiles.find(p => p.id === pid);
      };
    });
    const first = await h.api("POST", `/api/obligations/${BILL.id}/pay`, {});
    expect(first.status).toBe(500);
    expect(h.db.liabilityPayments).toHaveLength(0);

    const retry = await h.api("POST", `/api/obligations/${BILL.id}/pay`, {});
    expect(retry.status).toBe(201);
    expect(retry.data?.deduped).toBeFalsy();
    expect(retry.data?.id).toBeTruthy();
    expect(h.db.liabilityPayments).toHaveLength(1);
  });

  it("a ledger failure is reported as a server error, and the retry pays", async () => {
    let failOnce = true;
    h = await boot({ profiles: [SELF, { ...BILL, fields: { ...BILL.fields } }], obligations: [BILL_OBLIGATION] }, (storage, db) => {
      const real = storage.createLiabilityPayment;
      storage.createLiabilityPayment = async (data: any) => {
        if (failOnce) { failOnce = false; throw new Error("insert failed"); }
        return real(data);
      };
    });
    const first = await h.api("POST", `/api/obligations/${BILL.id}/pay`, {});
    expect(first.status).toBe(500);           // was 404 "Obligation not found"
    expect(first.data?.deduped).toBeFalsy();
    const retry = await h.api("POST", `/api/obligations/${BILL.id}/pay`, {});
    expect(retry.status).toBe(201);
    expect(h.db.liabilityPayments).toHaveLength(1);
  });

  it("still folds a genuine double tap into the first payment (pre-fix behaviour kept)", async () => {
    h = await boot({ profiles: [SELF, { ...BILL, fields: { ...BILL.fields } }], obligations: [BILL_OBLIGATION] });
    const first = await h.api("POST", `/api/obligations/${BILL.id}/pay`, {});
    expect(first.status).toBe(201);
    const second = await h.api("POST", `/api/obligations/${BILL.id}/pay`, {});
    expect(second.status).toBe(200);
    expect(second.data?.deduped).toBe(true);
    expect(second.data?.id).toBe(first.data.id);
    expect(h.db.liabilityPayments).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 — Active-profile scope on the creates that never applied it.
// ─────────────────────────────────────────────────────────────────────────────
describe("2: every create lands on the profile in scope", () => {
  const rows: Record<string, any[]> = {};
  const record = (name: string) => async (data: any) => {
    const row = { id: `${name}-${(rows[name] ||= []).length + 1}`, ...data };
    rows[name].push(row);
    return row;
  };
  const withCreates = (storage: any) => {
    for (const k of Object.keys(rows)) delete rows[k];
    storage.createHabit = record("habit");
    storage.getTrackers = async () => [];
    storage.createTracker = record("tracker");
    storage.createGoal = record("goal");
    storage.createArtifact = record("artifact");
    storage.createCapture = record("capture");
    storage.getSelfProfile = async () => SELF;
    storage.getJournalEntries = async () => rows.journal || [];
    storage.createJournalEntry = record("journal");
    storage.updateJournalEntry = async (jid: string, patch: any) => {
      const row = (rows.journal || []).find(j => j.id === jid);
      if (row) Object.assign(row, patch);
      return row;
    };
  };

  it("events", async () => {
    h = await boot({ profiles: [SELF, MIKE, JANE] }, withCreates);
    const r = await h.api("POST", "/api/events", { title: "Dentist", date: "2026-09-10" }, asMike);
    expect(r.status).toBe(201);
    expect(h.db.events[0].linkedProfiles).toEqual([MIKE.id]);
  });

  it("habits, trackers, goals, artifacts, journal", async () => {
    h = await boot({ profiles: [SELF, MIKE, JANE] }, withCreates);
    expect((await h.api("POST", "/api/habits", { name: "Floss" }, asMike)).status).toBe(201);
    expect((await h.api("POST", "/api/trackers", { name: "Weight" }, asMike)).status).toBe(201);
    expect((await h.api("POST", "/api/goals", { title: "Run", type: "custom", target: 10, unit: "km" }, asMike)).status).toBe(200);
    expect((await h.api("POST", "/api/artifacts", { type: "note", title: "Plan" }, asMike)).status).toBe(201);
    expect((await h.api("POST", "/api/journal", { content: "A good day", entryDate: "2026-09-01" }, asMike)).status).toBe(201);
    expect(rows.habit[0].linkedProfiles).toEqual([MIKE.id]);
    expect(rows.tracker[0].linkedProfiles).toEqual([MIKE.id]);
    expect(rows.goal[0].linkedProfiles).toEqual([MIKE.id]);
    expect(rows.artifact[0].linkedProfiles).toEqual([MIKE.id]);
    expect(rows.journal[0].linkedProfiles).toEqual([MIKE.id]);
  });

  it("documents (the scope wins over the AI auto-link guess)", async () => {
    h = await boot({ profiles: [SELF, MIKE, JANE] }, withCreates);
    const r = await h.api("POST", "/api/documents", { name: "Lease.pdf", type: "other" }, asMike);
    expect(r.status).toBe(201);
    expect(h.db.documents[0].linkedProfiles).toEqual([MIKE.id]);
  });

  it("captures (ownerProfileId column)", async () => {
    const MIKE_UUID = "11111111-1111-4111-8111-111111111111";
    const JANE_UUID = "22222222-2222-4222-8222-222222222222";
    h = await boot({ profiles: [SELF, { ...MIKE, id: MIKE_UUID }, { ...JANE, id: JANE_UUID }] }, withCreates);
    const scoped = await h.api("POST", "/api/captures", { rawInput: "hello" }, { [ACTIVE_PROFILE_HEADER]: MIKE_UUID });
    expect(scoped.status).toBe(200);
    expect(rows.capture[0].ownerProfileId).toBe(MIKE_UUID);
    // Explicit owner wins; no scope still defaults to self (unchanged).
    await h.api("POST", "/api/captures", { rawInput: "x", ownerProfileId: JANE_UUID }, { [ACTIVE_PROFILE_HEADER]: MIKE_UUID });
    expect(rows.capture[1].ownerProfileId).toBe(JANE_UUID);
    await h.api("POST", "/api/captures", { rawInput: "y" });
    expect(rows.capture[2].ownerProfileId).toBe(SELF.id);
  });

  it("explicit owners win; several or no active profiles leave the body unchanged", async () => {
    h = await boot({ profiles: [SELF, MIKE, JANE] }, withCreates);
    await h.api("POST", "/api/events", { title: "Explicit", date: "2026-09-10", linkedProfiles: [JANE.id] }, asMike);
    expect(h.db.events[0].linkedProfiles).toEqual([JANE.id]);
    await h.api("POST", "/api/events", { title: "Shared", date: "2026-09-10" }, { [ACTIVE_PROFILE_HEADER]: `${MIKE.id},${JANE.id}` });
    expect(h.db.events[1].linkedProfiles).toEqual([]);
    await h.api("POST", "/api/events", { title: "Everyone", date: "2026-09-10" });
    expect(h.db.events[2].linkedProfiles).toEqual([]);
    await h.api("POST", "/api/habits", { name: "Read", linkedProfiles: [JANE.id] }, asMike);
    expect(rows.habit[0].linkedProfiles).toEqual([JANE.id]);
    await h.api("POST", "/api/goals", { title: "Save", type: "savings", target: 1, unit: "$" }, { [ACTIVE_PROFILE_HEADER]: `${MIKE.id},${JANE.id}` });
    expect(rows.goal[0].linkedProfiles ?? []).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 — POST /api/incomes skipped insertIncomeSchema.
// ─────────────────────────────────────────────────────────────────────────────
describe("3: POST /api/incomes validates like its siblings", () => {
  it("rejects a string tags field with a 400, not a 500", async () => {
    h = await boot({ profiles: [SELF] });
    const r = await h.api("POST", "/api/incomes", { description: "Salary", amount: 5000, tags: "salary" });
    expect(r.status).toBe(400);
    expect(h.db.incomes).toHaveLength(0);
  });

  it("rejects an unknown frequency and a non-array linkedProfiles", async () => {
    h = await boot({ profiles: [SELF, MIKE] });
    expect((await h.api("POST", "/api/incomes", { description: "Salary", amount: 5000, frequency: "hourly" })).status).toBe(400);
    expect((await h.api("POST", "/api/incomes", { description: "Salary", amount: 5000, linkedProfiles: MIKE.id })).status).toBe(400);
    expect(h.db.incomes).toHaveLength(0);
  });

  it("keeps the amount ceiling message and accepts a normal income with schema defaults", async () => {
    h = await boot({ profiles: [SELF] });
    const big = await h.api("POST", "/api/incomes", { description: "X", amount: 1e10 });
    expect(big.status).toBe(400);
    expect(String(big.data?.error)).toMatch(/less than/i);
    const ok = await h.api("POST", "/api/incomes", { description: "Salary", amount: "5000", frequency: "Biweekly" });
    expect(ok.status).toBe(201);
    expect(h.db.incomes[0]).toMatchObject({ amount: 5000, category: "salary", frequency: "biweekly", tags: [], linkedProfiles: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 — /api/tracker-entries/:entryId resolved the entry by scanning the
//     120-day tracker window, so an older entry was a 404.
// ─────────────────────────────────────────────────────────────────────────────
describe("4: tracker-entry by-id routes find entries older than the tracker window", () => {
  const OLD = { id: "old-1", values: { weight: 180 }, computed: {}, timestamp: "2025-01-15T20:00:00.000Z" };
  const TRACKER = { id: "t-1", name: "Weight", category: "health", fields: [{ name: "weight", type: "number", isPrimary: true }], entries: [] as any[], linkedProfiles: [] };
  const calls: any[] = [];
  const withEntries = (storage: any) => {
    calls.length = 0;
    // The production shape: the by-id read carries NO trackerId, and the
    // default window omits the old entry; only a wider window includes it.
    storage.getTrackerEntry = async (eid: string) => (eid === OLD.id ? { ...OLD } : undefined);
    storage.getTracker = async (tid: string) => (tid === TRACKER.id ? { ...TRACKER } : undefined);
    storage.getTrackers = async (daysBack?: number) => {
      calls.push(["getTrackers", daysBack]);
      const wide = typeof daysBack === "number" && daysBack > 365;
      return [{ ...TRACKER, entries: wide ? [OLD] : [] }];
    };
    storage.updateTrackerEntry = async (tid: string, eid: string, patch: any) => {
      calls.push(["updateTrackerEntry", tid, eid, patch]);
      return tid === TRACKER.id && eid === OLD.id ? { ...OLD, ...patch } : undefined;
    };
    storage.deleteTrackerEntry = async (tid: string, eid: string) => {
      calls.push(["deleteTrackerEntry", tid, eid]);
      return tid === TRACKER.id && eid === OLD.id;
    };
  };

  it("PATCH updates the old entry on its own tracker", async () => {
    h = await boot({ profiles: [SELF] }, withEntries);
    const r = await h.api("PATCH", `/api/tracker-entries/${OLD.id}`, { notes: "corrected" });
    expect(r.status).toBe(200);
    const upd = calls.find(c => c[0] === "updateTrackerEntry");
    expect(upd?.[1]).toBe(TRACKER.id);
    expect(upd?.[3]).toMatchObject({ notes: "corrected" });
  });

  it("PATCH still runs the value gate against the resolved tracker", async () => {
    h = await boot({ profiles: [SELF] }, withEntries);
    const r = await h.api("PATCH", `/api/tracker-entries/${OLD.id}`, { values: { weight: -5 } });
    expect(r.status).toBe(400);
    expect(calls.some(c => c[0] === "updateTrackerEntry")).toBe(false);
  });

  it("DELETE removes the old entry", async () => {
    h = await boot({ profiles: [SELF] }, withEntries);
    const r = await h.api("DELETE", `/api/tracker-entries/${OLD.id}`);
    expect(r.status).toBe(200);
    expect(calls.find(c => c[0] === "deleteTrackerEntry")?.[1]).toBe(TRACKER.id);
  });

  it("an unknown entry is still a 404", async () => {
    h = await boot({ profiles: [SELF] }, withEntries);
    expect((await h.api("PATCH", "/api/tracker-entries/nope", { notes: "x" })).status).toBe(404);
    expect((await h.api("DELETE", "/api/tracker-entries/nope")).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 — Tracker entry `timestamp` edits were stored verbatim.
// ─────────────────────────────────────────────────────────────────────────────
describe("5: a zone-less entry timestamp is read in the user's zone", () => {
  const ENTRY = { id: "e-1", values: { weight: 180 }, computed: {}, timestamp: "2026-09-01T19:00:00.000Z" };
  const TRACKER = { id: "t-1", name: "Weight", category: "health", fields: [{ name: "weight", type: "number", isPrimary: true }], entries: [ENTRY], linkedProfiles: [] };
  const calls: any[] = [];
  const withEntry = (storage: any) => {
    calls.length = 0;
    storage.getTracker = async (tid: string) => (tid === TRACKER.id ? { ...TRACKER } : undefined);
    storage.getTrackers = async () => [{ ...TRACKER }];
    storage.getTrackerEntry = async (eid: string) => (eid === ENTRY.id ? { ...ENTRY } : undefined);
    storage.updateTrackerEntry = async (tid: string, eid: string, patch: any) => {
      calls.push(["updateTrackerEntry", tid, eid, patch]);
      return { ...ENTRY, ...patch };
    };
    storage.logEntry = async (data: any) => { calls.push(["logEntry", data]); return { id: "e-new", ...data }; };
  };

  it("PATCH /api/trackers/:id/entries/:eid stores the instant 22:30 Los Angeles means", async () => {
    h = await boot({ profiles: [SELF] }, withEntry);
    const r = await h.api("PATCH", `/api/trackers/${TRACKER.id}/entries/${ENTRY.id}`, { timestamp: "2026-09-02T22:30" });
    expect(r.status).toBe(200);
    expect(calls[0][3].timestamp).toBe("2026-09-03T05:30:00.000Z"); // was "2026-09-02T22:30" verbatim (= 3:30pm LA)
  });

  it("the by-id PATCH applies the same rule", async () => {
    h = await boot({ profiles: [SELF] }, withEntry);
    const r = await h.api("PATCH", `/api/tracker-entries/${ENTRY.id}`, { timestamp: "2026-09-02 22:30" }, { "X-Timezone": "Europe/Berlin" });
    expect(r.status).toBe(200);
    expect(calls.find(c => c[0] === "updateTrackerEntry")[3].timestamp).toBe("2026-09-02T20:30:00.000Z");
  });

  it("junk is a 400 and nothing is written; a qualified instant passes through", async () => {
    h = await boot({ profiles: [SELF] }, withEntry);
    const bad = await h.api("PATCH", `/api/trackers/${TRACKER.id}/entries/${ENTRY.id}`, { timestamp: "last tuesday-ish" });
    expect(bad.status).toBe(400);
    expect(calls).toHaveLength(0);
    const ok = await h.api("PATCH", `/api/trackers/${TRACKER.id}/entries/${ENTRY.id}`, { timestamp: "2026-09-02T22:30:00Z" });
    expect(ok.status).toBe(200);
    expect(calls[0][3].timestamp).toBe("2026-09-02T22:30:00.000Z");
  });

  it("POST /api/trackers/:id/entries applies the same rule on create", async () => {
    h = await boot({ profiles: [SELF] }, withEntry);
    const r = await h.api("POST", `/api/trackers/${TRACKER.id}/entries`, { values: { weight: 181 }, timestamp: "2026-09-02T22:30" });
    expect(r.status).toBe(201);
    expect(calls.find(c => c[0] === "logEntry")[1].timestamp).toBe("2026-09-03T05:30:00.000Z");
    expect((await h.api("POST", `/api/trackers/${TRACKER.id}/entries`, { values: { weight: 181 }, timestamp: "nonsense" })).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6 — GET /api/cashflow defaulted the month in storage (UTC), not the user's zone.
// ─────────────────────────────────────────────────────────────────────────────
describe("6: GET /api/cashflow defaults month to the user's current month", () => {
  it("passes the zone-resolved month explicitly when the client sends none", async () => {
    const seen: any[] = [];
    h = await boot({ profiles: [SELF] }, (storage) => { storage.getCashflow = async (m?: string) => { seen.push(m); return []; }; });
    const r = await h.api("GET", "/api/cashflow", undefined, { "X-Timezone": "Pacific/Kiritimati" });
    expect(r.status).toBe(200);
    expect(seen[0]).toBe(getUserCurrentMonth("Pacific/Kiritimati"));
    await h.api("GET", "/api/cashflow?month=2026-01");
    expect(seen[1]).toBe("2026-01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7 — PATCH /api/accounts/:id {ownerProfileId} bypassed the parent guards.
// ─────────────────────────────────────────────────────────────────────────────
describe("7: an account's owner change runs the same parent guards as a profile", () => {
  const ACC = { id: "acc-1", type: "account", name: "Checking", fields: { accountKind: "checking", balance: 100 } };
  const CHILD = { id: "sub-1", type: "vehicle", name: "Car", parentProfileId: ACC.id, fields: {} };
  const withAccounts = (storage: any, db: FakeDb) => {
    storage.wouldCreateCycle = async (_uid: string, profileId: string, newParentId: string | null) => {
      if (!newParentId) return false;
      if (newParentId === profileId) return true;
      const seen = new Set<string>();
      let cur = db.profiles.find(p => p.id === newParentId);
      while (cur) {
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        if (!cur.parentProfileId) break;
        if (cur.parentProfileId === profileId) return true;
        cur = db.profiles.find(p => p.id === cur!.parentProfileId);
      }
      return false;
    };
    storage.updateAccount = async (aid: string, changes: any) => {
      const row = db.profiles.find(p => p.id === aid && p.type === "account");
      if (!row) return undefined;
      if (changes.ownerProfileId !== undefined) row.parentProfileId = changes.ownerProfileId || null;
      if (changes.name) row.name = changes.name;
      return row;
    };
  };

  it("rejects a self-parent with 400 and leaves the row alone", async () => {
    h = await boot({ profiles: [SELF, MIKE, { ...ACC }] }, withAccounts);
    const r = await h.api("PATCH", `/api/accounts/${ACC.id}`, { ownerProfileId: ACC.id });
    expect(r.status).toBe(400);
    expect(h.db.profiles.find(p => p.id === ACC.id).parentProfileId).toBeUndefined();
  });

  it("rejects a descendant as owner (cycle) with 400", async () => {
    h = await boot({ profiles: [SELF, MIKE, { ...ACC }, { ...CHILD }] }, withAccounts);
    const r = await h.api("PATCH", `/api/accounts/${ACC.id}`, { ownerProfileId: CHILD.id });
    expect(r.status).toBe(400);
  });

  it("rejects an unknown owner with 404, accepts a real one", async () => {
    h = await boot({ profiles: [SELF, MIKE, { ...ACC }] }, withAccounts);
    expect((await h.api("PATCH", `/api/accounts/${ACC.id}`, { ownerProfileId: "nope" })).status).toBe(404);
    const ok = await h.api("PATCH", `/api/accounts/${ACC.id}`, { ownerProfileId: MIKE.id });
    expect(ok.status).toBe(200);
    expect(h.db.profiles.find(p => p.id === ACC.id).parentProfileId).toBe(MIKE.id);
    // Clearing the owner is still allowed.
    expect((await h.api("PATCH", `/api/accounts/${ACC.id}`, { ownerProfileId: null })).status).toBe(200);
    expect(h.db.profiles.find(p => p.id === ACC.id).parentProfileId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8 — PATCH /api/liability-payments/:id edited the ledger row unvalidated and
//     left the balance / occurrence stamp / expense pointing at the old row.
// ─────────────────────────────────────────────────────────────────────────────
describe("8: editing a payment validates and keeps the pipeline in sync", () => {
  async function bootPaid() {
    h = await boot({ profiles: [SELF, { ...BILL, fields: { ...BILL.fields } }] }, liabilityLedger);
    const paid = await h.api("POST", `/api/liabilities/${BILL.id}/payments`, { amount: 80, paymentDate: "2026-09-10", occurrenceDate: "2026-09-10" });
    expect(paid.status).toBe(200);
    expect(h.db.liabilityPayments).toHaveLength(1);
    expect(h.db.expenses).toHaveLength(1);
    return h.db.liabilityPayments[0];
  }

  it("rejects a non-numeric, oversized or non-positive amount and a junk date", async () => {
    const row = await bootPaid();
    for (const body of [{ amount: "abc" }, { amount: 1e10 }, { amount: 0 }, { amount: -5 }, { paymentDate: "not-a-date" }]) {
      const r = await h.api("PATCH", `/api/liability-payments/${row.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.db.liabilityPayments[0].amount).toBe(80);
  });

  it("rejects the fields the ledger derives (they would desync balance and stamp)", async () => {
    const row = await bootPaid();
    for (const body of [{ principalPortion: 1 }, { interestPortion: 1 }, { remainingBalanceAfter: 1 }, { liabilityProfileId: "other" }, { paymentType: "payoff" }]) {
      const r = await h.api("PATCH", `/api/liability-payments/${row.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("a notes-only edit updates the row in place", async () => {
    const row = await bootPaid();
    const r = await h.api("PATCH", `/api/liability-payments/${row.id}`, { notes: "paid online" });
    expect(r.status).toBe(200);
    expect(h.db.liabilityPayments[0].id).toBe(row.id);
    expect(h.db.liabilityPayments[0].notes).toBe("paid online");
  });

  it("an amount edit re-syncs the stamp and the logged expense", async () => {
    const row = await bootPaid();
    const r = await h.api("PATCH", `/api/liability-payments/${row.id}`, { amount: 95 });
    expect(r.status).toBe(200);
    expect(h.db.liabilityPayments).toHaveLength(1);
    const now = h.db.liabilityPayments[0];
    expect(now.amount).toBe(95);
    expect(r.data?.id).toBe(now.id);
    // One expense, for the new amount, keyed to the current row.
    expect(h.db.expenses).toHaveLength(1);
    expect(h.db.expenses[0].amount).toBe(95);
    expect(h.db.expenses[0].tags).toContain(`payment:${now.id}`);
    // The occurrence stamp names the current row and the due date stayed advanced.
    const bill = h.db.profiles.find(p => p.id === BILL.id);
    expect(bill.fields.occurrences["2026-09-10"]).toMatchObject({ status: "paid", paymentId: now.id, amount: 95 });
    expect(bill.fields.dueDate).toBe("2026-10-10");
  });

  it("unknown id is a 404", async () => {
    await bootPaid();
    expect((await h.api("PATCH", "/api/liability-payments/nope", { notes: "x" })).status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9 — PATCH /api/loans/payment/:id/mark flagged the row paid before the ledger
//     write and swallowed the ledger failure.
// ─────────────────────────────────────────────────────────────────────────────
describe("9: an amortization row is flagged paid only after the payment succeeds", () => {
  const LOAN = { id: "loan-1", name: "Car loan", type: "liability", type_key: "auto_loan", fields: { currentBalance: 10000, annualInterestRate: 6, monthlyPayment: 400 }, linkedProfiles: [] };
  const ROW = { id: "am-1", loan_id: LOAN.id, loan_name: "Car loan", payment_number: 1, payment_date: "2026-09-15", principal_amount: 350, interest_amount: 50, total_payment: 400, remaining_balance: 9650, paid: false };
  const order: string[] = [];
  const withSchedule = (failLedger: boolean) => (storage: any, db: FakeDb) => {
    order.length = 0;
    const rows = [{ ...ROW }];
    storage.getAllLoanSchedules = async () => rows.map(r => ({ ...r }));
    storage.markLoanPayment = async (rid: string) => {
      order.push("markLoanPayment");
      const r = rows.find(x => x.id === rid);
      if (r) r.paid = true;
      return r ? { ...r } : undefined;
    };
    const real = storage.createLiabilityPayment;
    storage.createLiabilityPayment = async (data: any) => {
      order.push("createLiabilityPayment");
      if (failLedger) throw new Error("insert failed");
      return real(data);
    };
    (db as any).scheduleRows = rows;
  };

  it("returns an error and leaves the row unpaid when the ledger write fails", async () => {
    h = await boot({ profiles: [SELF, { ...LOAN, fields: { ...LOAN.fields } }] }, withSchedule(true));
    const r = await h.api("PATCH", `/api/loans/payment/${ROW.id}/mark`, {});
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(order).not.toContain("markLoanPayment");
    expect((h.db as any).scheduleRows[0].paid).toBe(false);
    expect(h.db.liabilityPayments).toHaveLength(0);
  });

  it("pays first, flags second, and reports the flagged row", async () => {
    h = await boot({ profiles: [SELF, { ...LOAN, fields: { ...LOAN.fields } }] }, withSchedule(false));
    const r = await h.api("PATCH", `/api/loans/payment/${ROW.id}/mark`, {});
    expect(r.status).toBe(200);
    expect(order).toEqual(["createLiabilityPayment", "markLoanPayment"]);
    expect(r.data?.paid).toBe(true);
    expect(h.db.liabilityPayments).toHaveLength(1);
    expect(h.db.profiles.find(p => p.id === LOAN.id).fields.currentBalance).toBeCloseTo(9650, 2);
  });

  it("an unknown row is a 404, and a row already paid is not paid twice", async () => {
    h = await boot({ profiles: [SELF, { ...LOAN, fields: { ...LOAN.fields } }] }, withSchedule(false));
    expect((await h.api("PATCH", "/api/loans/payment/nope/mark", {})).status).toBe(404);
    await h.api("PATCH", `/api/loans/payment/${ROW.id}/mark`, {});
    const again = await h.api("PATCH", `/api/loans/payment/${ROW.id}/mark`, {});
    expect(again.status).toBe(200);
    expect(h.db.liabilityPayments).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10 — Budgets: the route already surfaces a thrown storage error as a 500 and a
//      missing budget as a 404. (Storage's setBudgets swallows the Supabase
//      error itself — outside this file's scope; see the report.)
// ─────────────────────────────────────────────────────────────────────────────
describe("10: budget routes surface what storage tells them (passes pre-fix; documents the boundary)", () => {
  it("POST answers 500 when addBudget throws; PATCH answers 404 when updateBudget reports no row", async () => {
    h = await boot({ profiles: [SELF] }, (storage) => {
      storage.addBudget = async () => { throw new Error("preferences write failed"); };
      storage.updateBudget = async () => false;
    });
    expect((await h.api("POST", "/api/budgets", { category: "food", amount: 300 })).status).toBe(500);
    expect((await h.api("PATCH", "/api/budgets/b-1", { amount: 200 })).status).toBe(404);
  });
});


// D72 — a delete the storage could not perform must not answer success.
// deleteProfile returns false when the cascade RPC rolls back; the obligation,
// tracker, habit, event and artifact routes all discarded that boolean and
// answered `{ success: true }`, so the client dropped a row every list still
// showed.
describe("D72: a failed storage delete is not reported as success", () => {
  const seed = { obligations: [{ id: "obl-1", name: "Rent", amount: 100, frequency: "monthly", nextDueDate: "2026-10-01" }] };
  it("DELETE /api/obligations/:id answers 500 when the cascade reports failure", async () => {
    h = await boot(seed, (storage) => { storage.deleteObligation = async () => false; });
    const r = await h.api("DELETE", "/api/obligations/obl-1");
    expect(r.status).toBe(500);
    expect(String(r.data?.error)).toMatch(/could not be deleted/i);
  });
  it("…and 200 when the storage really removed it", async () => {
    h = await boot(seed, (storage) => { storage.deleteObligation = async () => true; });
    const r = await h.api("DELETE", "/api/obligations/obl-1");
    expect(r.status).toBe(200);
  });
  it("the same rule holds for events, habits, trackers and artifacts", async () => {
    h = await boot({ events: [{ id: "ev-1", title: "X", date: "2026-10-01" }] }, (storage) => {
      storage.deleteEvent = async () => false;
      storage.getHabit = async () => ({ id: "h-1", name: "Floss" });
      storage.deleteHabit = async () => false;
      storage.getTracker = async () => ({ id: "t-1", name: "Weight", fields: [], entries: [] });
      storage.deleteTracker = async () => false;
      storage.getArtifact = async () => ({ id: "a-1", title: "Note" });
      storage.deleteArtifact = async () => false;
    });
    expect((await h.api("DELETE", "/api/events/ev-1")).status).toBe(500);
    expect((await h.api("DELETE", "/api/habits/h-1")).status).toBe(500);
    expect((await h.api("DELETE", "/api/trackers/t-1")).status).toBe(500);
    expect((await h.api("DELETE", "/api/artifacts/a-1")).status).toBe(500);
  });
});

// D76 — the obligation surface speaks active|paused|cancelled, but the pay
// path stamps the liability with "upcoming"; a client that round-tripped the
// record could never resume a paused bill (400 "Invalid enum value").
describe("D76: lifecycle words on a bill are folded into the obligation status enum", () => {
  it("PATCH status 'upcoming' resumes the bill instead of answering 400", async () => {
    const updates: any[] = [];
    h = await boot({ obligations: [{ id: "obl-1", name: "Gym", amount: 40, frequency: "monthly", nextDueDate: "2026-10-01", status: "paused" }] },
      (storage) => { storage.updateObligation = async (_id: string, patch: any) => { updates.push(patch); return { id: "obl-1", ...patch }; }; });
    const r = await h.api("PATCH", "/api/obligations/obl-1", { status: "upcoming" });
    expect(r.status).toBe(200);
    expect(updates[0]?.status).toBe("active");
    expect((await h.api("PATCH", "/api/obligations/obl-1", { status: "paused" })).status).toBe(200);
    expect(updates[1]?.status).toBe("paused");
  });
});

// D78 — a malformed id must be a 404, never a 500 (three routes leaked the
// Postgres "invalid input syntax for type uuid" error as a server error).
describe("D78: a malformed id is Not found, not Internal server error", () => {
  it("maps Postgres 22P02 from any handler to 404", async () => {
    h = await boot({}, (storage) => {
      storage.getLiabilityPayments = async () => { throw { code: "22P02", message: 'invalid input syntax for type uuid: "undefined"' }; };
      storage.deleteJournalEntry = async () => { throw { code: "22P02", message: "invalid input syntax for type uuid" }; };
      storage.updateIncome = async () => { throw new Error('invalid input syntax for type uuid: "not-a-uuid"'); };
    });
    expect((await h.api("GET", "/api/liabilities/undefined/payments")).status).toBe(404);
    expect((await h.api("DELETE", "/api/journal/undefined")).status).toBe(404);
    expect((await h.api("PATCH", "/api/incomes/not-a-uuid", { amount: 5 })).status).toBe(404);
  });
});

// D85 — PATCH /api/expenses/:id took any string as `date`; "yesterdayish" and
// "2026-13-45" reached the date column and came back as 500s. The create route
// only ran `new Date()` on it, so the same words made a 400 there and a 500
// here. One rule now lives on insertExpenseSchema for both.
describe("D85: an expense date must be a real calendar day on create and edit", () => {
  it("answers 400 for a non-date, 400 for an impossible day, and keeps the day of a timestamp", async () => {
    h = await boot({ expenses: [{ id: "exp-1", amount: 12, description: "Coffee", category: "food", date: "2026-09-01", tags: [] }] });
    for (const bad of ["yesterdayish", "2026-13-45", "2026-09-31"]) {
      const r = await h.api("PATCH", "/api/expenses/exp-1", { date: bad });
      expect(r.status, bad).toBe(400);
      const c = await h.api("POST", "/api/expenses", { amount: 5, description: "Tea", date: bad });
      expect(c.status, `create ${bad}`).toBe(400);
    }
    expect(h.db.expenses[0].date).toBe("2026-09-01");
    const ts = await h.api("PATCH", "/api/expenses/exp-1", { date: "2026-09-10T00:00:00.000Z" });
    expect(ts.status).toBe(200);
    expect(h.db.expenses[0].date).toBe("2026-09-10");
    // A form's blank date input means "leave it alone", not "set it to nothing".
    expect((await h.api("PATCH", "/api/expenses/exp-1", { date: "", amount: 13 })).status).toBe(200);
    expect(h.db.expenses[0].date).toBe("2026-09-10");
    expect(h.db.expenses[0].amount).toBe(13);
  });
});

// D86 — a bill's nextDueDate was `z.string()`, so "next week" was stored as
// the schedule anchor on both create and edit; the bill then had no derivable
// occurrences and showed "Invalid Date" everywhere it was listed.
describe("D86: a bill's due date must be a real calendar day on create and edit", () => {
  it("rejects free text on POST and PATCH, keeps the day of a timestamp", async () => {
    const updates: any[] = [];
    h = await boot({ obligations: [{ id: "obl-1", name: "Internet", amount: 60, frequency: "monthly", nextDueDate: "2026-09-05", status: "active" }] },
      (storage, db) => {
        storage.updateObligation = async (rid: string, patch: any) => {
          const row = db.obligations.find(o => o.id === rid);
          if (!row) return undefined;
          updates.push(patch); Object.assign(row, patch); return row;
        };
      });
    for (const bad of ["next week", "2026-13-45", "not-a-date"]) {
      expect((await h.api("PATCH", "/api/obligations/obl-1", { nextDueDate: bad })).status, bad).toBe(400);
      expect((await h.api("POST", "/api/obligations", { name: "Water", amount: 20, nextDueDate: bad })).status, `create ${bad}`).toBe(400);
    }
    expect(updates).toHaveLength(0);
    expect(h.db.obligations).toHaveLength(1);
    expect((await h.api("PATCH", "/api/obligations/obl-1", { nextDueDate: "2026-10-05T07:00:00.000Z" })).status).toBe(200);
    expect(updates[0]?.nextDueDate).toBe("2026-10-05");
    const created = await h.api("POST", "/api/obligations", { name: "Water", amount: 20, nextDueDate: "2026-09-20" });
    expect(created.status).toBe(201);
    expect(created.data.nextDueDate).toBe("2026-09-20");
  });
});

// D88 — the server's scoped lists share the rule: the car's insurance bill
// is listed under Self because the car is Self's.
describe("D88: GET /api/obligations?profileIds=self lists bills owned through the user's car", () => {
  it("includes the vehicle-linked bill and still excludes another person's", async () => {
    h = await boot({
      profiles: [SELF, MIKE, { id: "car-1", type: "vehicle", name: "Honda", parentProfileId: SELF.id }],
      obligations: [
        { id: "obl-ins", name: "Car insurance", amount: 118, frequency: "monthly", nextDueDate: "2026-09-22", status: "active", linkedProfiles: ["car-1"] },
        { id: "obl-net", name: "Internet", amount: 60, frequency: "monthly", nextDueDate: "2026-09-05", status: "active", linkedProfiles: [SELF.id] },
        { id: "obl-mike", name: "Mike's gym", amount: 40, frequency: "monthly", nextDueDate: "2026-09-10", status: "active", linkedProfiles: [MIKE.id] },
      ],
    });
    const r = await h.api("GET", `/api/obligations?profileIds=${SELF.id}`);
    expect(r.status).toBe(200);
    expect(r.data.map((o: any) => o.name).sort()).toEqual(["Car insurance", "Internet"]);
    const m = await h.api("GET", `/api/obligations?profileIds=${MIKE.id}`);
    expect(m.data.map((o: any) => o.name)).toEqual(["Mike's gym"]);
  });
});

// D97 — the bill-create dedupe was written only after the insert finished,
// so two identical creates arriving together both inserted.
describe("D97: two identical bill creates arriving together insert once", () => {
  it("the second waits for the first and answers deduped", async () => {
    let creates = 0;
    h = await boot({ profiles: [SELF] }, (storage, db) => {
      storage.createObligation = async (data: any) => {
        creates++;
        await new Promise((r) => setTimeout(r, 150));
        const row = { id: `obl-${creates}`, ...data };
        db.obligations.push(row);
        return row;
      };
    });
    const body = { name: "Water", amount: 20, frequency: "monthly", nextDueDate: "2026-09-20" };
    const [a, b] = await Promise.all([h.api("POST", "/api/obligations", body), h.api("POST", "/api/obligations", body)]);
    expect(creates).toBe(1);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const deduped = a.status === 200 ? a : b;
    expect(deduped.data.deduped).toBe(true);
    expect(deduped.data.id).toBe("obl-1");
    expect(h.db.obligations).toHaveLength(1);
  });
  it("a failed first create does not poison the fingerprint", async () => {
    let n = 0;
    h = await boot({ profiles: [SELF] }, (storage, db) => {
      storage.createObligation = async (data: any) => {
        if (++n === 1) throw new Error("db hiccup");
        const row = { id: `obl-${n}`, ...data }; db.obligations.push(row); return row;
      };
    });
    const body = { name: "Gas", amount: 30, frequency: "monthly", nextDueDate: "2026-09-21" };
    expect((await h.api("POST", "/api/obligations", body)).status).toBe(500);
    expect((await h.api("POST", "/api/obligations", body)).status).toBe(201);
  });
});

// D98 — an unknown /api path fell through to the SPA shell with 200.
describe("D98: unknown API paths are 404 JSON for every method", () => {
  it("answers 404 JSON and leaves real routes alone", async () => {
    h = await boot({ profiles: [SELF] });
    for (const [m, p] of [["GET", "/api/profiles/self-1/restore"], ["POST", "/api/profiles/self-1/restore"], ["DELETE", "/api/liabilities/x/payments/y"], ["PATCH", "/api/nope"]] as const) {
      const r = await h.api(m, p, m === "GET" ? undefined : {});
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(typeof r.data?.error, `${m} ${p} body`).toBe("string");
      expect(r.headers["content-type"] || "").toMatch(/json/);
    }
    expect((await h.api("GET", "/api/profiles")).status).toBe(200);
  });
});

const LOAN_ID = "33333333-3333-4333-8333-333333333333";
const ACCT_ID = "44444444-4444-4444-8444-444444444444";
// D99 — the loan/card payment route dropped accountId. The pay pipeline
// reads the account through storage.getProfile(accountId), so the fake
// records which profiles were asked for: before the fix ACCT_ID never was.
describe("D99: POST /api/liabilities/:id/payments passes accountId to the pay pipeline", () => {
  it("forwards a string accountId and rejects a non-string one", async () => {
    const asked: string[] = [];
    h = await boot({ profiles: [SELF,
      { id: LOAN_ID, type: "liability", type_key: "auto_loan", name: "Loan", fields: { currentBalance: 1000, annualInterestRate: 0, monthlyPayment: 50 } },
      { id: ACCT_ID, type: "account", type_key: "checking", name: "Checking", fields: { accountKind: "checking", balance: 500 } },
    ] }, (storage, db) => {
      const orig = storage.getProfile;
      storage.getProfile = async (id: string) => { asked.push(id); return orig(id); };
      storage.createLiabilityPayment = async (data: any) => { const row = { id: "pay-1", ...data }; db.liabilityPayments.push(row); return row; };
      storage.getLiabilityPayments = async () => db.liabilityPayments;
      storage.updateProfile = async (id: string, patch: any) => { const p = db.profiles.find((x: any) => x.id === id); if (p) Object.assign(p, patch, { fields: { ...(p.fields || {}), ...(patch.fields || {}) } }); return p; };
      storage.adjustAccountBalance = async (id: string) => db.profiles.find((x: any) => x.id === id);
      storage.updateOccurrenceOverride = async () => null;
    });
    const r = await h.api("POST", `/api/liabilities/${LOAN_ID}/payments`, { amount: 50, paymentDate: "2026-09-02", accountId: ACCT_ID });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(asked).toContain(ACCT_ID);
    const bad = await h.api("POST", `/api/liabilities/${LOAN_ID}/payments`, { amount: 50, paymentDate: "2026-09-02", accountId: 42 });
    expect(bad.status).toBe(400);
  });
});

// D104 — the backup export left out incomes, goals, paychecks, budgets and
// liability payments; the import could not take them back.
describe("D104: export carries the whole money model and import restores it", () => {
  function moneyStorage(storage: any, db: FakeDb) {
    const stub = (v: any) => async () => v;
    for (const m of ["getTrackers", "getEvents", "getDocuments", "getHabits", "getArtifacts", "getJournalEntries", "getMemories", "getDomains"]) if (typeof storage[m] !== "function") storage[m] = stub([]);
    storage.getGoals = async () => (db as any).goals || [];
    storage.getPaychecks = async () => [{ id: "pc-1", source: "Acme", amount: 2600, expected_date: "2026-09-12" }];
    storage.getAllBudgets = async () => ({ "2026-09": [{ id: "b-1", category: "food", amount: 300 }] });
    storage.getLiabilityPayments = async (id: string) => db.liabilityPayments.filter((p: any) => p.liabilityProfileId === id);
    storage.createGoal = async (g: any) => { const row = { id: `goal-${((db as any).goals ||= []).length + 1}`, status: "active", ...g }; (db as any).goals.push(row); return row; };
    storage.createPaycheck = async (p: any) => ({ id: "pc-new", ...p });
    storage.addBudget = async (month: string, category: string, amount: number) => ({ id: `b-${month}-${category}`, category, amount });
  }
  it("exports every section with the live rows", async () => {
    h = await boot({
      profiles: [SELF, { id: "loan-1", type: "liability", type_key: "auto_loan", name: "Loan", fields: {} }],
      incomes: [{ id: "inc-1", description: "Salary", amount: 2600, frequency: "biweekly", linkedProfiles: [SELF.id] }],
      liabilityPayments: [{ id: "pay-1", liabilityProfileId: "loan-1", amount: 400, paymentDate: "2026-09-02" }],
    }, (storage, db) => { moneyStorage(storage, db); (db as any).goals = [{ id: "goal-1", title: "Save", type: "savings", target: 1000, unit: "$", linkedProfiles: [SELF.id] }]; });
    const r = await h.api("GET", "/api/export");
    expect(r.status).toBe(200);
    expect(r.data.incomes.map((i: any) => i.id)).toEqual(["inc-1"]);
    expect(r.data.goals.map((g: any) => g.id)).toEqual(["goal-1"]);
    expect(r.data.paychecks.map((p: any) => p.id)).toEqual(["pc-1"]);
    expect(r.data.budgets).toEqual({ "2026-09": [{ id: "b-1", category: "food", amount: 300 }] });
    expect(r.data.liabilityPayments.map((p: any) => p.id)).toEqual(["pay-1"]);
  });
  it("imports incomes, goals, paychecks and budgets from such a file", async () => {
    h = await boot({ profiles: [SELF] }, (storage, db) => moneyStorage(storage, db));
    const r = await h.api("POST", "/api/import", {
      version: 1,
      incomes: [{ description: "Salary", amount: 2600, frequency: "biweekly", date: "2026-08-28" }],
      goals: [{ title: "Save", type: "savings", target: 1000, unit: "$" }],
      paychecks: [{ source: "Acme", amount: 2600, expected_date: "2026-09-12" }],
      budgets: { "2026-09": [{ category: "food", amount: 300 }], "bad-month": [{ category: "x", amount: 1 }] },
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.imported).toMatchObject({ incomes: 1, goals: 1, paychecks: 1, budgets: 1 });
    expect(h.db.incomes.map((i: any) => i.description)).toEqual(["Salary"]);
    expect((h.db as any).goals.map((g: any) => g.title)).toEqual(["Save"]);
  });
});

// D105 — imported rows kept the exporting account's profile ids.
describe("D105: import remaps profiles, parents, Self and every link", () => {
  it("maps the file's Self to this account's Self, creates parents first, and rewrites links", async () => {
    h = await boot({ profiles: [SELF] }, (storage, db) => {
      storage.getSelfProfile = async () => SELF;
      let n = 0;
      storage.createProfile = async (data: any) => { const row = { id: `new-${++n}`, ...data }; db.profiles.push(row); return row; };
      storage.getTrackers = async () => []; storage.getHabits = async () => []; storage.getEvents = async () => db.events;
      storage.createEvent = async (data: any) => { const row = { id: `ev-${db.events.length + 1}`, ...data }; db.events.push(row); return row; };
    });
    const r = await h.api("POST", "/api/import", {
      version: 1,
      profiles: [
        { id: "old-car", type: "vehicle", name: "Civic", parentProfileId: "old-self" },   // child listed before its parent
        { id: "old-self", type: "self", name: "Old Me" },
        { id: "old-linda", type: "person", name: "Linda" },
      ],
      tasks: [{ title: "Oil change", linkedProfiles: ["old-car"] }, { title: "Call Linda", linkedProfiles: ["old-linda", "ghost-id"] }, { title: "Mine", linkedProfiles: ["old-self"] }],
      events: [{ title: "Dentist", date: "2026-09-10", linkedProfiles: ["old-self"] }],
    });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.failed?.profiles).toBeUndefined();
    const byName = Object.fromEntries(h.db.profiles.map((p: any) => [p.name, p]));
    expect(byName["Old Me"]).toBeUndefined();                       // no second Self
    expect(byName["Civic"].parentProfileId).toBe(SELF.id);           // parent remapped to this account's Self
    expect(byName["Linda"].id).not.toBe("old-linda");
    const t = Object.fromEntries(h.db.tasks.map((x: any) => [x.title, x.linkedProfiles]));
    expect(t["Oil change"]).toEqual([byName["Civic"].id]);
    expect(t["Call Linda"]).toEqual([byName["Linda"].id]);            // unknown id dropped
    expect(t["Mine"]).toEqual([SELF.id]);
    expect(h.db.events[0].linkedProfiles).toEqual([SELF.id]);
  });
});

// D106 — a refused delete-all attempt spent the hourly allowance.
describe("D106: a mistyped delete-all confirmation does not spend the hourly allowance", () => {
  it("400 first, then the real request runs", async () => {
    let deleted = 0;
    h = await boot({ profiles: [SELF] }, (storage) => { storage.deleteAllUserData = async () => { deleted++; return { errors: {} }; }; });
    expect((await h.api("DELETE", "/api/data/all", { confirmation: "yes" })).status).toBe(400);
    const ok = await h.api("DELETE", "/api/data/all", { confirmation: "DELETE" });
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(deleted).toBe(1);
    expect((await h.api("DELETE", "/api/data/all", { confirmation: "DELETE" })).status).toBe(429);
  });
});

// D109/D110 — the journal edit answered 500 for an impossible date and for
// a move onto a day that already has an entry.
describe("D109/D110: journal edits fail cleanly", () => {
  it("rejects an impossible date with 400 and maps a unique violation to 409, a bad date column value to 400", async () => {
    h = await boot({}, (storage) => {
      storage.updateJournalEntry = async (_id: string, patch: any) => {
        if (patch.date === "2026-09-10") throw { code: "23505", message: 'duplicate key value violates unique constraint "journal_entries_unique_day"' };
        if (patch.content === "boom-date") throw { code: "22008", message: "date/time field value out of range" };
        return { id: "j1", ...patch };
      };
    });
    expect((await h.api("PATCH", "/api/journal/j1", { date: "2026-13-45" })).status).toBe(400);
    expect((await h.api("PATCH", "/api/journal/j1", { date: "next week" })).status).toBe(400);
    const dup = await h.api("PATCH", "/api/journal/j1", { date: "2026-09-10" });
    expect(dup.status).toBe(409);
    expect(typeof dup.data.error).toBe("string");
    expect((await h.api("PATCH", "/api/journal/j1", { content: "boom-date" })).status).toBe(400);
    expect((await h.api("PATCH", "/api/journal/j1", { date: "2026-09-11" })).status).toBe(200);
  });
});

// D111 — pay and adjust routes answer 400, not 500 or 200, to an impossible day.
describe("D111: payment and adjustment dates are validated as calendar days", () => {
  it("bills pay, liability payments and account adjust reject 2026-13-45", async () => {
    h = await boot({ profiles: [SELF, { id: LOAN_ID, type: "liability", type_key: "auto_loan", name: "Loan", fields: {} }, { id: ACCT_ID, type: "account", type_key: "checking", name: "Checking", fields: { balance: 100, accountKind: "checking" } }],
      obligations: [{ id: "obl-1", name: "Water", amount: 20, frequency: "monthly", nextDueDate: "2026-09-20", status: "active" }] });
    expect((await h.api("POST", "/api/obligations/obl-1/pay", { date: "2026-13-45" })).status).toBe(400);
    expect((await h.api("POST", `/api/liabilities/${LOAN_ID}/payments`, { amount: 5, paymentDate: "2026-13-45" })).status).toBe(400);
    expect((await h.api("POST", `/api/accounts/${ACCT_ID}/adjust`, { delta: 1, date: "2026-13-45" })).status).toBe(400);
  });
});

// D112/D113 — malformed bodies: a JSON string body was a 500 with the
// parser's message; a non-string title threw inside sanitize; captures
// PATCH accepted an array.
describe("D112/D113: malformed bodies are 400s", () => {
  it("a JSON string body, an array title and an array capture patch answer 400", async () => {
    h = await boot({ profiles: [SELF] }, (storage) => { storage.updateCapture = async () => ({ id: "c1" }); });
    const raw = async (m: string, p: string, body: string) => {
      const r = await fetch(`http://127.0.0.1:${(h as any).port ?? ""}${p}`, { method: m, headers: { "Content-Type": "application/json" }, body }).catch(() => null);
      return r;
    };
    const s = await h.api("POST", "/api/artifacts", { type: "note", title: ["a"], content: "x" });
    expect(s.status).toBe(400);
    expect((await h.api("PATCH", "/api/captures/c1", [] as any)).status).toBe(400);
    // a bare JSON string body: the harness's api() stringifies, so "text" arrives as the JSON string "text"
    const t = await h.api("POST", "/api/tasks", "text" as any);
    expect(t.status).toBe(400);
    expect(t.data?.error).toBe("Invalid JSON body");
    const n = await h.api("POST", "/api/tasks", 42 as any);
    expect(n.status).toBe(400);
  });
  it("a value the column cannot hold is a 400, a bad uuid stays a 404", async () => {
    h = await boot({}, (storage) => {
      storage.updateIncome = async (_id: string, patch: any) => { if (patch.amount === 7) throw { code: "22P02", message: 'invalid input syntax for type numeric: "abc"' }; throw { code: "22P02", message: 'invalid input syntax for type uuid: "x"' }; };
    });
    expect((await h.api("PATCH", "/api/incomes/i1", { amount: 7 })).status).toBe(400);
    expect((await h.api("PATCH", "/api/incomes/i1", { amount: 8 })).status).toBe(404);
  });
});
