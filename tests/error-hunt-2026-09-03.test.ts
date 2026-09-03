// Error hunt 2026-09-03 — budgets (D142–D146).
//
// D142  "Copy last month" replaced the destination month's list, so a cap set
//       for next month before the copy was lost.
// D143  A month written "2026-9" (or anything else) went to its own bucket no
//       reader looked at; now folded to "2026-09" or refused with a 400.
// D144  A budget/goal category was stored verbatim ("Groceries") while the
//       expenses carry the canonical "food", so the cap and the spending goal
//       never met their spend.
// D145  Renaming a cap onto an existing category left two caps for one bucket.
// D146  The AI budget tools defaulted the month to Los Angeles time for every
//       user; they now use the requesting user's timezone.
import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { readFileSync } from "node:fs";
import { requestStorageContext, MemStorage } from "../server/storage";
import { registerRoutes } from "../server/routes";
import { makeFakeStorage, type FakeDb, type Harness } from "./helpers/route-harness";
import {
  normalizeMonthKey, budgetMonthOrThrow, budgetCategoryKey, upsertBudget, applyBudgetUpdate, mergeBudgetsForCopy,
  type BudgetEntry,
} from "../shared/budget-ledger";
import { foldExpenseCategory } from "../shared/category-canon";
import { getUserCurrentMonth } from "../shared/timezone";
import { SupabaseStorage } from "../server/supabase-storage";

let n = 0;
const nextId = () => `id-${++n}`;

describe("D143: the month key", () => {
  it("folds a non-padded month and refuses anything that is not a month", () => {
    expect(normalizeMonthKey("2026-9")).toBe("2026-09");
    expect(normalizeMonthKey(" 2026-09 ")).toBe("2026-09");
    expect(normalizeMonthKey("2026-13")).toBeNull();
    expect(normalizeMonthKey("2026-00")).toBeNull();
    expect(normalizeMonthKey("not-a-month")).toBeNull();
    expect(normalizeMonthKey("2026-09-01")).toBeNull();
    expect(normalizeMonthKey(undefined)).toBeNull();
    expect(() => budgetMonthOrThrow("nope")).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(budgetMonthOrThrow("2026-1")).toBe("2026-01");
  });
});

describe("D144: the category bucket", () => {
  it("folds spellings the expense canon knows and keeps unknown words as their own bucket", () => {
    expect(foldExpenseCategory("Groceries")).toBe("food");
    expect(foldExpenseCategory("kids")).toBeNull();
    expect(budgetCategoryKey("Groceries")).toBe("food");
    expect(budgetCategoryKey("FOOD ")).toBe("food");
    expect(budgetCategoryKey("Misc")).toBe("general");
    // Two unknown words must not collapse into one "general" cap.
    expect(budgetCategoryKey("Kids")).toBe("kids");
    expect(budgetCategoryKey("Toys")).toBe("toys");
    expect(budgetCategoryKey("")).toBe("");
  });
  it("upsert treats 'Groceries' and 'food' as one cap per owner", () => {
    const list: BudgetEntry[] = [];
    upsertBudget(list, { category: "food", amount: 300 }, nextId);
    upsertBudget(list, { category: "Groceries", amount: 350 }, nextId);
    upsertBudget(list, { category: "Groceries", amount: 100, profileId: "p-1" }, nextId);
    expect(list.map((b) => [b.category, b.amount, b.profileId ?? null])).toEqual([["food", 350, null], ["food", 100, "p-1"]]);
  });
});

describe("D145: an edit cannot leave two caps for one bucket", () => {
  it("throws a 409 on a rename that collides and applies a clean edit", () => {
    const list: BudgetEntry[] = [
      { id: "a", category: "transport", amount: 150 },
      { id: "b", category: "travel", amount: 100 },
    ];
    expect(() => applyBudgetUpdate(list, "b", { category: "transport" })).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(list[1]).toEqual({ id: "b", category: "travel", amount: 100 });
    expect(applyBudgetUpdate(list, "b", { category: "Hobbies", amount: 120 })?.category).toBe("hobbies");
    expect(applyBudgetUpdate(list, "missing", { amount: 1 })).toBeNull();
    // Moving a cap to another owner is fine when that owner has no such cap.
    expect(applyBudgetUpdate(list, "a", { profileId: "p-1" })?.profileId).toBe("p-1");
    expect(() => applyBudgetUpdate(list, "a", { profileId: null })).not.toThrow();
  });
});

describe("D142: copying a month keeps what the destination already has", () => {
  it("adds only the buckets the destination lacks and reports that count", () => {
    const destination: BudgetEntry[] = [{ id: "d1", category: "entertainment", amount: 90 }, { id: "d2", category: "food", amount: 500 }];
    const source: BudgetEntry[] = [
      { id: "s1", category: "Groceries", amount: 400 },
      { id: "s2", category: "transport", amount: 150 },
      { id: "s3", category: "food", amount: 200, profileId: "p-1" },
    ];
    const { list, added } = mergeBudgetsForCopy(destination, source, nextId);
    expect(added).toBe(2);
    expect(list.map((b) => [b.category, b.amount, b.profileId ?? null])).toEqual([
      ["entertainment", 90, null], ["food", 500, null], ["transport", 150, null], ["food", 200, "p-1"],
    ]);
    expect(list.slice(2).every((b) => !["s1", "s2", "s3"].includes(b.id))).toBe(true);
    // The inputs are untouched.
    expect(destination).toHaveLength(2);
    expect(mergeBudgetsForCopy(list, source, nextId).added).toBe(0);
  });

  it("MemStorage copies additively, folds the month and refuses garbage", async () => {
    const s = new MemStorage();
    await s.addBudget("2026-08", "food", 400);
    await s.addBudget("2026-8", "transport", 150);
    expect((await s.getBudgets("2026-08")).map((b) => b.category).sort()).toEqual(["food", "transport"]);
    await s.addBudget("2026-09", "entertainment", 90);
    expect(await s.copyBudgetsToMonth("2026-08", "2026-09")).toBe(2);
    expect((await s.getBudgets("2026-09")).map((b) => b.category).sort()).toEqual(["entertainment", "food", "transport"]);
    expect(await s.copyBudgetsToMonth("2026-08", "2026-09")).toBe(0);
    expect((await s.getBudgets("2026-09"))).toHaveLength(3);
    await expect(s.getBudgets("2026-9-01")).rejects.toMatchObject({ statusCode: 400 });
    const travel = await s.addBudget("2026-09", "travel", 100);
    await expect(s.updateBudget("2026-09", travel.id, { category: "food" })).rejects.toMatchObject({ statusCode: 409 });
  });
});

// ─── The real routes over the in-memory storage ─────────────────────────────
const TZ = "America/Los_Angeles";
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
  const userId = `eh3-user-${++seq}`;
  app.use((req, _res, next) => { (req as any).userId = userId; requestStorageContext.run(storage, () => next()); });
  const httpServer: Server = createServer(app);
  await registerRoutes(httpServer, app);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const api: Harness["api"] = async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", "X-Timezone": TZ, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: r.status, ok: r.ok, data, headers: {} };
  };
  return { db, api, storage, close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())) };
}
let h: Booted;
afterEach(async () => { if (h) await h.close(); });

/** Route the budget methods to a real MemStorage so the list rules apply. */
function budgetsViaMem(storage: any) {
  const mem = new MemStorage();
  for (const k of ["getBudgets", "getAllBudgets", "setBudgets", "addBudget", "updateBudget", "deleteBudget", "copyBudgetsToMonth"] as const) {
    storage[k] = (...args: any[]) => (mem as any)[k](...args);
  }
  return mem;
}

describe("D142/D143/D145 through the routes", () => {
  it("normalises the month on every budget route and answers 400 for a non-month", async () => {
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => budgetsViaMem(storage));
    const created = await h.api("POST", "/api/budgets", { month: "2026-9", category: "pet", amount: 20 });
    expect(created.status).toBe(200);
    expect((await h.api("GET", "/api/budgets?month=2026-09")).data.budgets.map((b: any) => b.category)).toEqual(["pet"]);
    expect((await h.api("GET", "/api/budgets?month=2026-9")).data.month).toBe("2026-09");
    expect((await h.api("POST", "/api/budgets", { month: "not-a-month", category: "pet", amount: 20 })).status).toBe(400);
    expect((await h.api("GET", "/api/budgets?month=2026-13")).status).toBe(400);
    expect((await h.api("PATCH", `/api/budgets/${created.data.id}?month=garbage`, { amount: 30 })).status).toBe(400);
    expect((await h.api("DELETE", `/api/budgets/${created.data.id}?month=2026-9`)).status).toBe(200);
    expect((await h.api("GET", "/api/budgets?month=2026-09")).data.budgets).toEqual([]);
    expect((await h.api("POST", "/api/budgets/copy", { fromMonth: "2026-08", toMonth: "sept" })).status).toBe(400);
    // No month at all still means the caller's current month.
    const now = await h.api("GET", "/api/budgets");
    expect(now.data.month).toBe(getUserCurrentMonth(TZ));
  });

  it("copy keeps the destination's own caps and a colliding rename is a 409", async () => {
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => budgetsViaMem(storage));
    await h.api("POST", "/api/budgets", { month: "2026-08", category: "Groceries", amount: 400 });
    await h.api("POST", "/api/budgets", { month: "2026-08", category: "transport", amount: 150 });
    await h.api("POST", "/api/budgets", { month: "2026-10", category: "entertainment", amount: 90 });
    const copy = await h.api("POST", "/api/budgets/copy", { fromMonth: "2026-8", toMonth: "2026-10" });
    expect(copy.status).toBe(200);
    expect(copy.data).toEqual({ copied: 2, fromMonth: "2026-08", toMonth: "2026-10" });
    const after = await h.api("GET", "/api/budgets?month=2026-10");
    expect(after.data.budgets.map((b: any) => b.category).sort()).toEqual(["entertainment", "food", "transport"]);
    const travel = await h.api("POST", "/api/budgets", { month: "2026-10", category: "travel", amount: 100 });
    const clash = await h.api("PATCH", `/api/budgets/${travel.data.id}?month=2026-10`, { category: "transport" });
    expect(clash.status).toBe(409);
    expect(clash.data.error).toMatch(/transport budget already exists/);
    expect((await h.api("GET", "/api/budgets?month=2026-10")).data.budgets.filter((b: any) => b.category === "transport")).toHaveLength(1);
  });

  it("D144: a spending goal's category is folded like the budgets", async () => {
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage, db) => {
      storage.createGoal = async (g: any) => ({ id: "goal-1", status: "active", ...g });
      storage.updateGoal = async (_id: string, patch: any) => ({ id: "goal-1", ...patch });
    });
    const g = await h.api("POST", "/api/goals", { title: "Eat cheaper", type: "spending_limit", target: 300, unit: "$", category: "Groceries" });
    expect(g.status).toBe(200);
    expect(g.data.category).toBe("food");
    const p = await h.api("PATCH", "/api/goals/goal-1", { category: "Dining Out" });
    expect(p.status).toBe(200);
    expect(p.data.category).toBe(budgetCategoryKey("Dining Out"));
  });
});

describe("D146: the AI budget tools do not hard-code a Los Angeles month", () => {
  it("source guard: every month default goes through the user's timezone", () => {
    const src = readFileSync(new URL("../server/ai-engine.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/timeZone: 'America\/Los_Angeles' \}\)\.slice\(0, 7\)/);
    expect((src.match(/getUserCurrentMonth\(\(storage as any\)\._timezone/g) || []).length).toBeGreaterThanOrEqual(7);
  });
});

// ─── D147: a goal keeps its progress when its source goes away ───────────────
function bareStorage(over: Record<string, any> = {}): any {
  const s: any = Object.create(SupabaseStorage.prototype);
  s.userId = "22222222-2222-4222-8222-222222222222";
  s._timezone = TZ;
  s.memoEnabled = false;
  s.memoCache = new Map();
  s.logActivity = () => {};
  Object.assign(s, over);
  return s;
}
function chainClient(respond: (table: string, op: string, payload?: any) => any = () => ({ data: [], error: null })) {
  const calls: Array<{ table: string; op: string; payload?: any; filters: Array<[string, any]> }> = [];
  const from = (table: string) => {
    const rec = { table, op: "select", payload: undefined as any, filters: [] as Array<[string, any]> };
    calls.push(rec);
    const chain: any = {};
    for (const op of ["select", "update", "insert", "upsert", "delete"]) {
      chain[op] = (payload?: any) => { if (op !== "select") { rec.op = op; rec.payload = payload; } return chain; };
    }
    for (const f of ["eq", "is", "gte", "lte", "in", "not", "order", "limit", "ilike", "contains", "or", "range"]) {
      chain[f] = (...args: any[]) => { rec.filters.push([f, args]); return chain; };
    }
    const result = () => Promise.resolve(respond(table, rec.op, rec.payload));
    chain.maybeSingle = () => result().then((r: any) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data }));
    chain.single = chain.maybeSingle;
    chain.then = (res: any, rej?: any) => result().then(res, rej);
    return chain;
  };
  return { client: { from }, calls };
}
const GOAL_ROW = { id: "goal-1", title: "100 pushups", type: "tracker_target", target: 100, current: 0, unit: "reps", tracker_id: "tr-1", status: "active", linked_profiles: ["self-1"], created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" };

describe("D147: goal progress survives its source", () => {
  it("deleteTracker writes the live figure into every active goal reading that tracker before the row goes", async () => {
    const { client, calls } = chainClient((table, op) => table === "goals" && op === "select" ? { data: [GOAL_ROW], error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client, computeGoalProgress: async () => 120, cleanupEntityLinks: async () => undefined });
    expect(await s.deleteTracker("tr-1")).toBe(true);
    const goalWrite = calls.find((c) => c.table === "goals" && c.op === "update");
    expect(goalWrite?.payload).toEqual({ current: 120 });
    expect(goalWrite?.filters).toEqual(expect.arrayContaining([["eq", ["id", "goal-1"]]]));
    const trackerDelete = calls.findIndex((c) => c.table === "trackers" && c.op === "delete");
    expect(calls.indexOf(goalWrite!)).toBeLessThan(trackerDelete);
  });

  it("deleteHabit freezes habit-streak goals (and goals on the mirror tracker) before hiding the habit", async () => {
    const { client, calls } = chainClient((table, op) => {
      if (table === "goals" && op === "select") return { data: [{ ...GOAL_ROW, id: "goal-2", type: "habit_streak", tracker_id: null, habit_id: "h-1" }], error: null };
      if (table === "habits" && op === "select") return { data: [{ linked_tracker_id: null, name: "Read" }], error: null };
      if (table === "habits" && op === "update") return { data: [{ id: "h-1" }], error: null };
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, computeGoalProgress: async () => 14, cleanupEntityLinks: async () => undefined, habitMirrorTrackerId: async () => null });
    expect(await s.deleteHabit("h-1")).toBe(true);
    const goalWrite = calls.find((c) => c.table === "goals" && c.op === "update");
    expect(goalWrite?.payload).toEqual({ current: 14 });
  });

  it("nothing is written when the figure is unchanged or the goal is not active", async () => {
    const { client, calls } = chainClient((table, op) => table === "goals" && op === "select" ? { data: [{ ...GOAL_ROW, current: 40 }], error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client, computeGoalProgress: async () => 40, cleanupEntityLinks: async () => undefined });
    await s.deleteTracker("tr-1");
    expect(calls.some((c) => c.table === "goals" && c.op === "update")).toBe(false);
    // The select itself asks only for active, live goals of this user.
    const sel = calls.find((c) => c.table === "goals" && c.op === "select")!;
    expect(sel.filters).toEqual(expect.arrayContaining([["eq", ["status", "active"]], ["is", ["deleted_at", null]], ["eq", ["tracker_id", "tr-1"]]]));
  });

  it("updateGoal keeps the live figure when the goal leaves 'active' (target lowered under it, or paused)", async () => {
    const writes: any[] = [];
    const { client } = chainClient((table, op, payload) => { if (table === "goals" && op === "update") writes.push(payload); return { data: [], error: null }; });
    const live = { id: "goal-1", title: "100 pushups", type: "tracker_target", target: 100, current: 120, unit: "reps", trackerId: "tr-1", status: "active", linkedProfiles: ["self-1"], updatedAt: "2026-09-01T00:00:00Z" };
    let fetched = 0;
    const s = bareStorage({ supabase: client, getGoal: async () => (fetched++ === 0 ? { ...live } : { ...live, status: "completed" }) });
    await s.updateGoal("goal-1", { target: 50 });
    expect(writes[0]).toMatchObject({ target: 50, status: "completed", current: 120 });
    fetched = 0; writes.length = 0;
    await s.updateGoal("goal-1", { status: "paused" });
    expect(writes[0]).toMatchObject({ status: "paused", current: 120 });
    // An explicit current from the caller wins, and staying active writes none.
    fetched = 0; writes.length = 0;
    await s.updateGoal("goal-1", { status: "completed", current: 99 });
    expect(writes[0]).toMatchObject({ status: "completed", current: 99 });
    // A goal still short of its target stays active and writes no figure.
    const short = bareStorage({ supabase: client, getGoal: async () => ({ ...live, current: 40 }) });
    writes.length = 0;
    await short.updateGoal("goal-1", { title: "Push-ups" });
    expect(writes[0]).not.toHaveProperty("current");
    expect(writes[0]).not.toHaveProperty("status");
  });
});

// ─── D148: net-worth history for a multi-profile selection ──────────────────
describe("D148: /api/net-worth/history sums the selected profiles' own rows", () => {
  const rows = [
    { snapshot_date: "2026-09-02", profile_id: "self-1", assets_total: 10000, liabilities_total: 4000, net_worth: 6000 },
    { snapshot_date: "2026-09-02", profile_id: "linda-1", assets_total: 5000, liabilities_total: 1000, net_worth: 4000 },
    { snapshot_date: "2026-09-01", profile_id: "self-1", assets_total: 9000, liabilities_total: 4000, net_worth: 5000 },
  ];
  it("storage: several ids → per-day sums, newest first; one id → its rows; none → the aggregate", async () => {
    const { client, calls } = chainClient((table, op) => table === "net_worth_snapshots" && op === "select" ? { data: rows, error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client });
    const two = await s.getNetWorthHistory(["self-1", "linda-1"], 120);
    expect(two).toEqual([
      { snapshotDate: "2026-09-02", assetsTotal: 15000, liabilitiesTotal: 5000, netWorth: 10000 },
      { snapshotDate: "2026-09-01", assetsTotal: 9000, liabilitiesTotal: 4000, netWorth: 5000 },
    ]);
    expect(calls[0].filters).toEqual(expect.arrayContaining([["in", ["profile_id", ["self-1", "linda-1"]]]]));
    await s.getNetWorthHistory("self-1", 30);
    expect(calls[1].filters).toEqual(expect.arrayContaining([["eq", ["profile_id", "self-1"]]]));
    await s.getNetWorthHistory(undefined, 30);
    expect(calls[2].filters).toEqual(expect.arrayContaining([["is", ["profile_id", null]]]));
  });
  it("route: a two-profile selection asks the storage for both ids, not the aggregate", async () => {
    const asked: any[] = [];
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }, { id: "linda-1", type: "person", name: "Linda" }] }, (storage) => {
      storage.getNetWorthHistory = async (ids: any, days: number) => { asked.push([ids, days]); return [{ snapshotDate: "2026-09-02", assetsTotal: 1, liabilitiesTotal: 0, netWorth: 1 }]; };
    });
    const r = await h.api("GET", "/api/net-worth/history?profileIds=self-1,linda-1&lookbackDays=35");
    expect(r.status).toBe(200);
    expect(asked).toEqual([[["self-1", "linda-1"], 35]]);
    await h.api("GET", "/api/net-worth/history?profileId=linda-1");
    expect(asked[1]).toEqual([["linda-1"], 120]);
    await h.api("GET", "/api/net-worth/history");
    expect(asked[2]).toEqual([undefined, 120]);
  });
});

// ─── D149: legacy spellings and the AI budget tools ─────────────────────────
import { executeTool } from "../server/ai-engine";
describe("D149: caps stored before folding, and the AI tools, meet the same bucket", () => {
  it("getBudgets folds a legacy 'Groceries' cap to 'food' on read", async () => {
    const s = new MemStorage();
    await s.setBudgets("2026-09", [{ id: "legacy", category: "Groceries", amount: 300 }, { id: "k", category: "Kids", amount: 50 }]);
    expect((await s.getBudgets("2026-09")).map((b) => b.category)).toEqual(["food", "kids"]);
  });
  it("delete_budget finds the food cap when asked for 'groceries'; get_budget_summary matches its spend", async () => {
    const s = new MemStorage();
    (s as any)._timezone = TZ;
    const month = getUserCurrentMonth(TZ);
    await s.setBudgets(month, [{ id: "legacy", category: "Groceries", amount: 300 }]);
    await s.createExpense({ amount: 45, category: "food", description: "market", date: `${month}-03` } as any);
    const run = <T,>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => requestStorageContext.run(s, () => fn().then(resolve, reject)));
    const summary = await run(() => executeTool("get_budget_summary", {}, "u-1"));
    expect(summary.categories).toEqual([{ category: "food", budgeted: 300, actual: 45, remaining: 255, percentUsed: 15 }]);
    const deleted = await run(() => executeTool("delete_budget", { category: "groceries" }, "u-1"));
    expect(deleted).toMatchObject({ deleted: true, category: "food" });
    expect(await s.getBudgets(month)).toEqual([]);
    const missing = await run(() => executeTool("delete_budget", { category: "kids" }, "u-1"));
    expect(missing.error).toMatch(/No budget found/);
  });
});

// ─── D150: an extra-principal payment is all principal ──────────────────────
import { applyLiabilityPayment } from "../server/liability-payments";
describe("D150: paymentType 'extra_principal' without an explicit split", () => {
  const LOAN = { id: "liab-1", name: "Car loan", type: "liability", type_key: "auto_loan", fields: { currentBalance: 8000, annualInterestRate: 5.955, monthlyPayment: 300 } };
  function ledgerStorage(liability: any) {
    return {
      createLiabilityPayment: async (data: any) => ({ id: "pay-1", ...data }),
      updateProfile: async (_id: string, patch: any) => ({ ...liability, ...patch, fields: { ...liability.fields, ...patch.fields } }),
    } as any;
  }
  it("sends the whole payment to principal and drops the balance by the money sent", async () => {
    const out = await applyLiabilityPayment(ledgerStorage(LOAN), LOAN, { amount: 100, paymentType: "extra_principal" }, "UTC");
    expect(out.interest).toBe(0);
    expect(out.principal).toBe(100);
    expect(out.newBalance).toBeCloseTo(7900, 2);
    expect(out.payment.paymentType).toBe("extra_principal");
  });
  it("fees still come off the top, and a standard payment keeps the canonical split", async () => {
    const withFee = await applyLiabilityPayment(ledgerStorage(LOAN), LOAN, { amount: 100, fees: 5, paymentType: "extra_principal" }, "UTC");
    expect(withFee.principal).toBe(95);
    expect(withFee.interest).toBe(0);
    const standard = await applyLiabilityPayment(ledgerStorage(LOAN), LOAN, { amount: 100 }, "UTC");
    expect(standard.interest).toBeGreaterThan(0);
    expect(standard.principal + standard.interest).toBeCloseTo(100, 2);
  });
});
