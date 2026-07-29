// tests/helpers/route-harness.ts
//
// Boots the REAL Express app — `registerRoutes` from server/routes.ts, every
// middleware, every handler — against an in-memory storage double, and returns
// an `api()` helper that speaks HTTP to it over a loopback port.
//
// Why this exists: the QA report of 2026-07-29 found bugs in what the ROUTES do
// (an amount that was accepted, an expense filed against the wrong profile, a
// reminder written at the wrong hour, a mirror event that outlived its source).
// Testing the pure helpers those routes call proves the helpers are right, not
// that the routes call them. This harness closes that gap without needing
// Supabase: `server/storage.ts` resolves every call through an AsyncLocalStorage
// context, so a per-request `requestStorageContext.run()` swaps the whole
// backend for a fake that the test can read and assert against.

import express, { type Express } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { requestStorageContext } from "../../server/storage";
import { registerRoutes } from "../../server/routes";

/** Every row the fake keeps, so assertions can read what the route wrote. */
export interface FakeDb {
  profiles: any[];
  expenses: any[];
  incomes: any[];
  obligations: any[];
  tasks: any[];
  events: any[];
  reminders: any[];
}

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

/**
 * A storage double covering the methods the routes under test touch.
 *
 * Unimplemented methods resolve to `[]` rather than throwing: `registerRoutes`
 * wires up hundreds of handlers and several middlewares, and a test for the
 * expense route must not fail because some unrelated cache-warm path called a
 * method nobody is asserting on. Anything a test actually depends on is
 * implemented explicitly below.
 */
export function makeFakeStorage(db: FakeDb) {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",

    getProfiles: async () => db.profiles,
    getProfilesLite: async () => db.profiles,
    getProfile: async (pid: string) => db.profiles.find(p => p.id === pid),
    linkProfileTo: async () => true,

    getExpenses: async () => db.expenses,
    createExpense: async (data: any) => {
      const row = { id: id("exp"), createdAt: new Date().toISOString(), ...data };
      db.expenses.push(row);
      return row;
    },
    updateExpense: async (rid: string, patch: any) => {
      const row = db.expenses.find(e => e.id === rid);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },
    deleteExpense: async (rid: string) => {
      db.expenses = db.expenses.filter(e => e.id !== rid);
      return true;
    },

    getIncomes: async () => db.incomes,
    createIncome: async (data: any) => {
      const row = { id: id("inc"), ...data };
      db.incomes.push(row);
      return row;
    },

    getObligations: async () => db.obligations,
    getObligation: async (rid: string) => db.obligations.find(o => o.id === rid),
    createObligation: async (data: any) => {
      const row = { id: id("obl"), ...data };
      db.obligations.push(row);
      return row;
    },
    materializeObligationOccurrences: async () => [],

    getTasks: async () => db.tasks,
    createTask: async (data: any) => {
      const row = { id: id("task"), status: "todo", ...data };
      db.tasks.push(row);
      return row;
    },

    getEvents: async () => db.events,
    createEvent: async (data: any) => {
      const row = { id: id("ev"), tags: [], linkedProfiles: [], ...data };
      db.events.push(row);
      return row;
    },
    updateEvent: async (rid: string, patch: any) => {
      const row = db.events.find(e => e.id === rid);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },
    deleteEvent: async (rid: string) => {
      const before = db.events.length;
      db.events = db.events.filter(e => e.id !== rid);
      return db.events.length < before;
    },

    listReminders: async () => db.reminders,
    createReminder: async (data: any) => {
      const row = { id: id("rem"), ...data };
      db.reminders.push(row);
      return row;
    },
    updateReminder: async (rid: string, patch: any) => {
      const row = db.reminders.find(r => r.id === rid);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },
    deleteReminder: async (rid: string) => {
      const before = db.reminders.length;
      db.reminders = db.reminders.filter(r => r.id !== rid);
      return db.reminders.length < before;
    },
  };

  return new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      // Unknown read → empty result, never a crash. See the note above.
      return async () => [];
    },
    set(target, prop: string, value) { target[prop] = value; return true; },
  });
}

export interface Harness {
  db: FakeDb;
  /** HTTP call against the booted app. `headers` go on the wire verbatim. */
  api: (method: string, path: string, body?: any, headers?: Record<string, string>) =>
    Promise<{ status: number; ok: boolean; data: any }>;
  close: () => Promise<void>;
}

export async function startHarness(seed: Partial<FakeDb> = {}): Promise<Harness> {
  const db: FakeDb = {
    profiles: [], expenses: [], incomes: [], obligations: [],
    tasks: [], events: [], reminders: [], ...seed,
  };
  const storage = makeFakeStorage(db);

  const app: Express = express();
  app.use(express.json());
  // Stand in for server/index.ts's authMiddleware: give every request a user
  // and bind the fake storage for the duration of the request, exactly the way
  // the real per-request scoped storage is bound in production.
  app.use((req, _res, next) => {
    (req as any).userId = "test-user";
    requestStorageContext.run(storage as any, () => next());
  });

  const httpServer: Server = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const api: Harness["api"] = async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Timezone": "America/Los_Angeles", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: r.status, ok: r.ok, data };
  };

  return {
    db,
    api,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
