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

// ─── D151: a chore finished late does not spawn an already-overdue next ─────
import { nextRecurringTaskSpawn } from "../shared/recurrence";
describe("D151: the next occurrence of a late-completed chore lands on today or later, on the series' own anchor", () => {
  it("weekly, due 10 days ago, done today → the first anchor date on/after today", () => {
    expect(nextRecurringTaskSpawn({ dueDate: "2026-08-23", tags: ["recur:weekly"] }, "2026-09-02")?.dueDate).toBe("2026-09-06");
    // Exactly a week ago → due today (today counts, it is not overdue).
    expect(nextRecurringTaskSpawn({ dueDate: "2026-08-26", tags: ["recur:weekly"] }, "2026-09-02")?.dueDate).toBe("2026-09-02");
    // On time: unchanged.
    expect(nextRecurringTaskSpawn({ dueDate: "2026-09-02", tags: ["recur:weekly"] }, "2026-09-02")?.dueDate).toBe("2026-09-09");
    // Ahead of time: the series' next date, in the future, unchanged.
    expect(nextRecurringTaskSpawn({ dueDate: "2026-09-10", tags: ["recur:weekly"] }, "2026-09-02")?.dueDate).toBe("2026-09-17");
  });
  it("monthly on the 31st, done months late, keeps the anchor day", () => {
    expect(nextRecurringTaskSpawn({ dueDate: "2026-05-31", tags: ["recur:monthly"] }, "2026-09-02")?.dueDate).toBe("2026-09-30");
  });
  it("a series that would end before catching up spawns nothing; no today → the plain step", () => {
    expect(nextRecurringTaskSpawn({ dueDate: "2026-08-01", tags: ["recur:weekly", "runtil:2026-08-20"] }, "2026-09-02")).toBeNull();
    expect(nextRecurringTaskSpawn({ dueDate: "2026-08-23", tags: ["recur:weekly"] })?.dueDate).toBe("2026-08-30");
  });
});

// ─── D152: a habit check-in cannot be dated in the future ───────────────────
import { completeHabitOccurrence } from "../server/habit-completion";
import { addDays as tzAddDays, getUserToday } from "../shared/timezone";
describe("D152: completeHabitOccurrence refuses a day that has not happened yet", () => {
  function habitStorage() {
    const habit: any = { id: "h1", name: "Stretch", frequency: "daily", targetPerDay: 1, checkins: [], linkedProfiles: [], currentStreak: 2 };
    const storage: any = {
      getHabit: async () => habit, getHabits: async () => [habit],
      checkinHabit: async (_id: string, date: string) => { const c = { id: `c${habit.checkins.length + 1}`, date, timestamp: new Date().toISOString() }; habit.checkins.push(c); return c; },
      deleteHabitCheckin: async () => true, updateHabit: async () => habit,
      getTracker: async () => undefined, getTrackers: async () => [], createTracker: async () => ({ id: "t1", name: "Stretch", fields: [] }),
      updateTracker: async () => undefined, logEntry: async (d: any) => ({ id: "e1", values: d.values, timestamp: d.timestamp }),
      deleteTrackerEntry: async () => true, getProfiles: async () => [],
    };
    return { habit, storage };
  }
  it("tomorrow in the user's zone is refused with reason in_future and nothing recorded", async () => {
    const { habit, storage } = habitStorage();
    const tz = "Pacific/Kiritimati"; // UTC+14: "tomorrow" here is still today in most of the world
    const tomorrow = tzAddDays(getUserToday(tz), 1);
    const res = await completeHabitOccurrence(storage, { habitId: "h1", date: tomorrow, source: "habit_ui", timezone: tz });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("in_future");
    expect(res.recorded).toBe(0);
    expect(res.currentStreak).toBe(2);
    expect(habit.checkins).toHaveLength(0);
  });
  it("today and yesterday still record", async () => {
    const { habit, storage } = habitStorage();
    const tz = "America/Los_Angeles";
    const today = getUserToday(tz);
    expect((await completeHabitOccurrence(storage, { habitId: "h1", date: today, source: "habit_ui", timezone: tz })).recorded).toBe(1);
    expect((await completeHabitOccurrence(storage, { habitId: "h1", date: tzAddDays(today, -1), source: "habit_ui", timezone: tz })).recorded).toBe(1);
    expect(habit.checkins.map((c: any) => c.date)).toEqual([today, tzAddDays(today, -1)]);
  });
});

// ─── D153–D155: edits go through the same gates as creates ──────────────────
import { canonicalIncomeFrequency } from "../shared/obligation-windows";
describe("D153/D154: expense PATCH folds the category and refuses a blank description", () => {
  it("routes", async () => {
    const rows: any[] = [{ id: "x-1", amount: 12.5, category: "food", description: "milk", date: "2026-09-02", linkedProfiles: ["self-1"] }];
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.getExpense = async (id: string) => rows.find((r) => r.id === id);
      storage.updateExpense = async (id: string, patch: any) => { const r = rows.find((x) => x.id === id); Object.assign(r, patch); return r; };
    });
    const folded = await h.api("PATCH", "/api/expenses/x-1", { category: "Utility Bill" });
    expect(folded.status).toBe(200);
    expect(folded.data.category).toBe("utilities");
    expect((await h.api("PATCH", "/api/expenses/x-1", { category: "Subscriptions" })).data.category).toBe("subscription");
    const blank = await h.api("PATCH", "/api/expenses/x-1", { description: "   " });
    expect(blank.status).toBe(400);
    expect(rows[0].description).toBe("milk");
    expect((await h.api("PATCH", "/api/expenses/x-1", { description: "  oat milk " })).data.description).toBe("oat milk");
  });
});
describe("D155: income frequencies are stored as one word", () => {
  it("canonicalIncomeFrequency folds every alias the converter knows and refuses the rest", () => {
    expect(canonicalIncomeFrequency("bi-weekly")).toBe("biweekly");
    expect(canonicalIncomeFrequency("Fortnightly")).toBe("biweekly");
    expect(canonicalIncomeFrequency("one_time")).toBe("once");
    expect(canonicalIncomeFrequency("Annually")).toBe("yearly");
    expect(canonicalIncomeFrequency("twice a month")).toBe("semimonthly");
    expect(canonicalIncomeFrequency("hourly")).toBeNull();
    expect(canonicalIncomeFrequency("")).toBeNull();
  });
  it("POST and PATCH /api/incomes store the canonical word and refuse an unknown cadence", async () => {
    const rows: any[] = [];
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.createIncome = async (d: any) => { const r = { id: `inc-${rows.length + 1}`, ...d }; rows.push(r); return r; };
      storage.getIncome = async (id: string) => rows.find((r) => r.id === id);
      storage.updateIncome = async (id: string, patch: any) => { const r = rows.find((x) => x.id === id); Object.assign(r, patch); return r; };
    });
    const created = await h.api("POST", "/api/incomes", { description: "Salary", amount: 2600, frequency: "bi-weekly" });
    expect(created.status).toBe(201);
    expect(created.data.frequency).toBe("biweekly");
    expect((await h.api("PATCH", `/api/incomes/${created.data.id}`, { frequency: "fortnightly" })).data.frequency).toBe("biweekly");
    expect((await h.api("PATCH", `/api/incomes/${created.data.id}`, { frequency: "Monthly" })).data.frequency).toBe("monthly");
    expect((await h.api("PATCH", `/api/incomes/${created.data.id}`, { frequency: "hourly" })).status).toBe(400);
    expect((await h.api("POST", "/api/incomes", { description: "Tips", amount: 50, frequency: "hourly" })).status).toBe(400);
  });
});

// ─── D156: an event's span runs forwards ────────────────────────────────────
import { eventSpanError } from "../shared/event-span";
describe("D156: events cannot end before they start", () => {
  it("eventSpanError names the impossible span and accepts the possible ones", () => {
    expect(eventSpanError({ date: "2026-09-05", time: "15:00", endTime: "14:00" })).toMatch(/cannot end \(14:00\) before it starts \(15:00\)/);
    expect(eventSpanError({ date: "2026-09-05", endDate: "2026-09-03" })).toMatch(/cannot end \(2026-09-03\) before/);
    expect(eventSpanError({ date: "2026-09-05", recurrence: "weekly", recurrenceEnd: "2026-09-02" })).toMatch(/cannot stop/);
    expect(eventSpanError({ date: "2026-09-05", time: "15:00", endTime: "15:00" })).toBeNull();
    expect(eventSpanError({ date: "2026-09-05", time: "23:00", endTime: "01:00", endDate: "2026-09-06" })).toBeNull(); // overnight
    expect(eventSpanError({ date: "2026-09-05", time: "15:00", endTime: "14:00", allDay: true })).toBeNull(); // clock ignored
    expect(eventSpanError({ date: "2026-09-05", recurrence: "none", recurrenceEnd: "2026-09-02" })).toBeNull();
    expect(eventSpanError({ date: "not-a-day", time: "15:00", endTime: "14:00" })).toBeNull(); // the schema owns that
  });
  it("both create and edit refuse through the routes with a 400, and the record is left as it was", async () => {
    const mem = new MemStorage();
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      for (const k of ["createEvent", "updateEvent", "getEvent", "getEvents", "deleteEvent"] as const) storage[k] = (...a: any[]) => (mem as any)[k](...a);
    });
    expect((await h.api("POST", "/api/events", { title: "Dentist", date: "2026-09-05", time: "15:00", endTime: "14:00" })).status).toBe(400);
    expect((await h.api("POST", "/api/events", { title: "Trip", date: "2026-09-05", endDate: "2026-09-03" })).status).toBe(400);
    expect((await h.api("POST", "/api/events", { title: "Yoga", date: "2026-09-05", recurrence: "weekly", recurrenceEnd: "2026-09-02" })).status).toBe(400);
    const ok = await h.api("POST", "/api/events", { title: "Dentist", date: "2026-09-05", time: "15:00", endTime: "15:45" });
    expect(ok.status).toBe(201);
    const bad = await h.api("PATCH", `/api/events/${ok.data.id}`, { endTime: "14:00" });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/cannot end/);
    expect((await h.api("GET", `/api/events/${ok.data.id}`)).data.endTime).toBe("15:45");
    // Moving the start past the end is refused too; moving both together is fine.
    expect((await h.api("PATCH", `/api/events/${ok.data.id}`, { time: "16:00" })).status).toBe(400);
    expect((await h.api("PATCH", `/api/events/${ok.data.id}`, { time: "16:00", endTime: "16:30" })).status).toBe(200);
  });
});

// ─── D157: a day-shaped value that is not a day ─────────────────────────────
import { isRealCalendarDay, impossibleCalendarDays } from "../shared/date-rules";
describe("D157: an impossible calendar day is refused on documents and profile fields", () => {
  it("detector: dated keys only, real days pass", () => {
    expect(isRealCalendarDay("2026-02-28")).toBe(true);
    expect(isRealCalendarDay("2026-02-30")).toBe(false);
    expect(isRealCalendarDay("2026-13-01")).toBe(false);
    expect(isRealCalendarDay("2024-02-29")).toBe(true);
    expect(impossibleCalendarDays({ expirationDate: "2026-02-30", dob: "2026-04-31", issued: "2026-02-28", notes: "2026-02-30", nested: { renewalDate: "2026-06-31" } }))
      .toEqual(["expirationDate", "dob", "nested.renewalDate"]);
    expect(impossibleCalendarDays({ expirationDate: "2027-09-02" })).toEqual([]);
    expect(impossibleCalendarDays(null)).toEqual([]);
  });
  it("routes: document create/edit and profile field edits answer 400 and store nothing", async () => {
    const writes: any[] = [];
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me", fields: {} }] }, (storage) => {
      storage.getDocumentMeta = async () => ({ id: "doc-1", name: "Passport", type: "identity", extractedData: { expirationDate: "2027-09-02" } });
      storage.updateDocument = async (_id: string, patch: any) => { writes.push(patch); return { id: "doc-1", ...patch }; };
      storage.createDocument = async (d: any) => { writes.push(d); return { id: "doc-2", ...d }; };
      storage.updateProfile = async (_id: string, patch: any) => { writes.push(patch); return { id: "self-1", type: "self", name: "Me", ...patch }; };
    });
    const bad = await h.api("PATCH", "/api/documents/doc-1", { extractedData: { expirationDate: "2026-02-30" } });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/expirationDate must be a real calendar day/);
    const badCreate = await h.api("POST", "/api/documents", { name: "Visa", type: "identity", fileData: "", extractedData: { expirationDate: "2026-11-31" } });
    expect(badCreate.status).toBe(400);
    const badDob = await h.api("PATCH", "/api/profiles/self-1", { fields: { dateOfBirth: "1990-02-30" } });
    expect(badDob.status).toBe(400);
    expect(writes).toEqual([]);
    const ok = await h.api("PATCH", "/api/documents/doc-1", { extractedData: { expirationDate: "2028-02-29" } });
    expect(ok.status).toBe(200);
    expect(writes[0].extractedData.expirationDate).toBe("2028-02-29");
  });
});

// ─── D158: a restored backup keeps what the backup carries ──────────────────
describe("D158: /api/import restores status, times, ends, progress, schedule and the journal", () => {
  it("passes every carried field to the storage writers", async () => {
    const calls: Record<string, any[]> = {};
    const rec = (k: string) => (...a: any[]) => { (calls[k] ||= []).push(a); return { id: `${k}-${calls[k].length}`, current: 0, status: "active", ...a[0] }; };
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.createTask = async (d: any) => rec("createTask")(d);
      storage.createEvent = async (d: any) => rec("createEvent")(d);
      storage.createGoal = async (d: any) => ({ ...rec("createGoal")(d), current: 0, status: "active" });
      storage.updateGoal = async (id: string, patch: any) => rec("updateGoal")(id, patch);
      storage.createJournalEntry = async (d: any) => rec("createJournalEntry")(d);
      storage.createHabit = async (d: any) => rec("createHabit")(d);
      storage.createIncome = async (d: any) => rec("createIncome")(d);
    });
    const r = await h.api("POST", "/api/import", {
      version: 1,
      tasks: [{ title: "Chore", dueDate: "2026-09-01", dueTime: "09:30", status: "done", completedAt: "2026-09-01T17:00:00.000Z", linkedProfiles: ["self-1"] }],
      events: [{ title: "Trip", date: "2026-09-05", endDate: "2026-09-07", allDay: true, recurrence: "none" }, { title: "Yoga", date: "2026-09-03", time: "07:00", endTime: "08:00", recurrence: "weekly", recurrenceEnd: "2026-09-24" }],
      goals: [{ title: "Pts", type: "custom", target: 100, current: 40, unit: "pts", status: "completed" }, { title: "Fresh", type: "custom", target: 10, unit: "x" }],
      journal: [{ date: "2026-08-30", mood: "good", content: "restored" }],
      habits: [{ name: "Gym", frequency: "weekly", targetDays: [1, 3], targetPerDay: 1, timeOfDay: "morning", scheduledTime: "07:00", checkins: [] }],
    });
    expect(r.status).toBe(200);
    expect(calls.createTask[0][0]).toMatchObject({ title: "Chore", dueTime: "09:30", status: "done", completedAt: "2026-09-01T17:00:00.000Z" });
    expect(calls.createEvent[0][0]).toMatchObject({ title: "Trip", endDate: "2026-09-07" });
    expect(calls.createEvent[1][0]).toMatchObject({ title: "Yoga", recurrence: "weekly", recurrenceEnd: "2026-09-24" });
    expect(calls.updateGoal).toEqual([["createGoal-1", { current: 40, status: "completed" }]]);
    expect(calls.createJournalEntry[0][0]).toMatchObject({ date: "2026-08-30", mood: "good", content: "restored" });
    expect(calls.createHabit[0][0]).toMatchObject({ name: "Gym", targetDays: [1, 3], timeOfDay: "morning", scheduledTime: "07:00" });
  });
  it("storage folds a category and a cadence whichever door they come through", async () => {
    const s = new MemStorage();
    const e = await s.createExpense({ amount: 20, category: "Groceries", description: "milk", date: "2026-09-02" } as any);
    expect(e.category).toBe("food");
    expect((await s.updateExpense(e.id, { category: "Utility Bill" } as any))?.category).toBe("utilities");
    const i = await s.createIncome({ description: "Salary", amount: 1000, frequency: "bi-weekly" } as any);
    expect(i.frequency).toBe("biweekly");
    expect((await s.updateIncome(i.id, { frequency: "Annually" } as any))?.frequency).toBe("yearly");
  });
});

// ─── D160: undoing a profile edit removes the fields that edit added ────────
import { executeReversePlan } from "../server/ai-envelope";
describe("D160: 'undo' of a profile edit re-applies the before-state including absent fields", () => {
  it("a field the undone edit added is gone afterwards; the before values are back", async () => {
    const s = new MemStorage();
    const p = await s.createProfile({ type: "person", name: "Mike", fields: { phone: "111", city: "Austin" } } as any);
    const before = JSON.parse(JSON.stringify(await s.getProfile(p.id)));
    await s.updateProfile(p.id, { fields: { email: "mike@example.com", city: "Dallas" } } as any);
    expect((await s.getProfile(p.id))!.fields).toMatchObject({ phone: "111", city: "Dallas", email: "mike@example.com" });
    const out = await executeReversePlan(s, { entityType: "profile", entityId: p.id, entityName: "Mike", reversible: true, reversePlan: { op: "reapply_before", before } });
    expect(out.ok).toBe(true);
    const after = (await s.getProfile(p.id))!.fields as Record<string, any>;
    expect(after.city).toBe("Austin");
    expect(after.phone).toBe("111");
    expect(after).not.toHaveProperty("email");
  });
});

// ─── D161: a capture that could not be stored is not reported as saved ──────
describe("D161: POST /api/captures answers 503 when the storage could only keep the row in memory", () => {
  it("ephemeral → 503 and no id; a persisted row → 201/200 with the row", async () => {
    let ephemeral = true;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.getSelfProfile = async () => ({ id: "self-1", type: "self", name: "Me" });
      storage.createCapture = async (d: any) => ({ id: "cap-1", ...d, ...(ephemeral ? { ephemeral: true } : {}) });
    });
    const lost = await h.api("POST", "/api/captures", { type: "note", title: "x", rawInput: "hello" });
    expect(lost.status).toBe(503);
    expect(lost.data.error).toMatch(/captures table is missing/);
    expect(lost.data.id).toBeUndefined();
    ephemeral = false;
    const kept = await h.api("POST", "/api/captures", { type: "note", title: "x", rawInput: "hello" });
    expect([200, 201]).toContain(kept.status);
    expect(kept.data.id).toBe("cap-1");
  });
});

// ─── D162: deleting a capture that is not yours reports false ───────────────
describe("D162: deleteCapture answers what the database did", () => {
  it("no matching row → false; one row → true; the user filter is on the delete", async () => {
    const { client, calls } = chainClient((table, op) => table === "captures" && op === "delete" ? { data: [], error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client, _captures: new Map() });
    expect(await s.deleteCapture("cap-1")).toBe(false);
    const del = calls.find((c) => c.table === "captures" && c.op === "delete")!;
    expect(del.filters).toEqual(expect.arrayContaining([["eq", ["id", "cap-1"]], ["eq", ["user_id", s.userId]]]));
    const { client: c2 } = chainClient((table, op) => table === "captures" && op === "delete" ? { data: [{ id: "cap-1" }], error: null } : { data: [], error: null });
    expect(await bareStorage({ supabase: c2, _captures: new Map() }).deleteCapture("cap-1")).toBe(true);
  });
});

// ─── D163/D164: a failing import record does not abort the batch; cashflow month ─
import { validateFinanceImport } from "../shared/finance-import-schema";
import { planImport, applyImport } from "../server/finance-import";
describe("D163: finance import — impossible dates are refused up front, a failing write does not abort the batch", () => {
  it("validateFinanceImport rejects 2026-02-30 and accepts a real day", () => {
    const bad = validateFinanceImport(JSON.stringify({ version: "1.0", transactions: [{ unique_id: "t1", date: "2026-02-30", merchant: "X", amount: 5 }] }));
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].path).toBe("transactions[0].date");
    expect(validateFinanceImport(JSON.stringify({ version: "1.0", transactions: [{ unique_id: "t1", date: "2026-02-28", merchant: "X", amount: 5 }] })).ok).toBe(true);
  });
  it("applyImport writes the batch record for what landed, reports the failure, and the rest still commits", async () => {
    const created: any[] = []; let imports: any[] = [];
    const store: any = {
      getExpenses: async () => [], getObligations: async () => [], getIncomes: async () => [], getProfiles: async () => [], getBudgets: async () => [],
      createExpense: async (d: any) => { if (d.description === "Boom") throw new Error("Invalid date or time value"); const r = { id: `e${created.length + 1}`, ...d }; created.push(r); return r; },
      createIncome: async (d: any) => { const r = { id: `i${created.length + 1}`, ...d }; created.push(r); return r; },
      createObligation: async (d: any) => { const r = { id: `o${created.length + 1}`, ...d }; created.push(r); return r; },
      createProfile: async (d: any) => { const r = { id: `p${created.length + 1}`, ...d }; created.push(r); return r; },
      addBudget: async (month: string, category: string, amount: number) => { const r = { id: `b${created.length + 1}`, month, category, amount }; created.push(r); return r; },
      updateBudget: async () => true,
      createFinanceImport: async (rec: any) => { imports.push(rec); return rec; },
    };
    const validated = validateFinanceImport(JSON.stringify({ version: "1.0",
      transactions: [{ unique_id: "t1", date: "2026-09-01", merchant: "Boom", amount: 5 }, { unique_id: "t2", date: "2026-09-01", merchant: "Fine", amount: 7 }],
      income: [{ unique_id: "i1", source_name: "Acme", amount: 3000, frequency: "biweekly" }],
      budgets: [{ unique_id: "bg1", category: "Groceries", amount: 400 }],
    }));
    expect(validated.ok, JSON.stringify(validated.errors)).toBe(true);
    const payload = validated.data!;
    const plan = await planImport(store, payload, "self-1");
    const out = await applyImport(store, payload, "self-1", plan, { month: "2026-10" });
    expect(out.failed).toEqual([{ section: "transactions", uniqueId: "t1", label: "Boom $5", error: "Invalid date or time value" }]);
    expect(created.map((r) => r.description || r.category)).toEqual(["Fine", "Acme", "food"]);
    expect(created[2].month).toBe("2026-10"); // the caller's month, not the host's UTC month
    expect(imports).toHaveLength(1);
    expect(imports[0].createdRecords.expenses).toEqual(["e1"]);
    expect(imports[0].summary.failed).toBe(1);
  });
});
describe("D164: /api/cashflow stores and reads the month as YYYY-MM", () => {
  it("POST folds 2026-9, refuses garbage and a non-integer week; GET folds too", async () => {
    const rows: any[] = [];
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.upsertCashflow = async (d: any) => { rows.push(d); return { id: "cf-1", ...d }; };
      storage.getCashflow = async (month: string) => rows.filter((r) => r.month === month);
    });
    const ok = await h.api("POST", "/api/cashflow", { month: "2026-9", week: "1", projected_income: 100 });
    expect(ok.status).toBe(200);
    expect(rows[0]).toMatchObject({ month: "2026-09", week: 1, projected_income: 100 });
    expect((await h.api("POST", "/api/cashflow", { month: "sept", week: 1 })).status).toBe(400);
    expect((await h.api("POST", "/api/cashflow", { month: "2026-09", week: "x" })).status).toBe(400);
    expect((await h.api("POST", "/api/cashflow", { month: "2026-09", week: 1.5 })).status).toBe(400);
    const got = await h.api("GET", "/api/cashflow?month=2026-9");
    expect(got.status).toBe(200);
    expect((await h.api("GET", "/api/cashflow?month=2026-13")).status).toBe(400);
  });
});

// ─── D165: an obligation's category is folded whichever door it comes through ─
describe("D165: createObligation folds the category", () => {
  it("MemStorage stores 'Utility' as utilities and 'fortnightly' as biweekly", async () => {
    const s = new MemStorage();
    const o = await s.createObligation({ name: "Water", amount: 30, frequency: "fortnightly", category: "Utility", nextDueDate: "2026-09-10" } as any);
    expect(o.category).toBe("utilities");
    expect(o.frequency).toBe("biweekly");
    // A cadence outside the bill vocabulary is left as given rather than mislabelled.
    expect((await s.createObligation({ name: "Twice", amount: 5, frequency: "semimonthly", category: "general", nextDueDate: "2026-09-10" } as any)).frequency).toBe("semimonthly");
  });
});

// ─── D166/D167: the loan amortization schedule ──────────────────────────────
import { unpayBillOccurrence } from "../server/liability-payments";
describe("D166: POST /api/loans/schedule validates its rows and the loan", () => {
  it("empty / junk rows are 400, an unknown loan is 404, a valid row is stored", async () => {
    const stored: any[] = [];
    h = await boot({ profiles: [{ id: "11111111-1111-4111-8111-111111111111", type: "liability", type_key: "auto_loan", name: "Civic Loan", fields: {} }] }, (storage) => {
      storage.createLoanSchedule = async (rows: any[]) => { stored.push(...rows); return rows; };
    });
    const row = { loan_id: "11111111-1111-4111-8111-111111111111", loan_name: "Civic Loan", payment_number: 1, payment_date: "2026-09-10", principal_amount: 250, interest_amount: 39.7, total_payment: 289.7, remaining_balance: 7750 };
    expect((await h.api("POST", "/api/loans/schedule", { entries: [{}] })).status).toBe(400);
    expect((await h.api("POST", "/api/loans/schedule", { entries: [{ ...row, principal_amount: "abc" }] })).status).toBe(400);
    expect((await h.api("POST", "/api/loans/schedule", { entries: [{ ...row, payment_date: "2026-02-30" }] })).status).toBe(400);
    expect((await h.api("POST", "/api/loans/schedule", { entries: [{ ...row, loan_id: "00000000-0000-4000-8000-000000000000" }] })).status).toBe(404);
    expect((await h.api("POST", "/api/loans/schedule", { entries: [] })).status).toBe(400);
    expect(stored).toEqual([]);
    expect((await h.api("POST", "/api/loans/schedule", { entries: [row] })).status).toBe(200);
    expect(stored).toEqual([row]);
  });
});
describe("D167: retracting a payment re-opens the amortization row it had marked", () => {
  it("unpayBillOccurrence calls unmarkLoanPayment with the number from the note", async () => {
    const unmarks: any[] = [];
    const loan = { id: "loan-1", name: "Civic Loan", type: "liability", type_key: "auto_loan", fields: { currentBalance: 7750, annualInterestRate: 6, monthlyPayment: 289.7, occurrences: {} } };
    const storage: any = {
      getProfile: async () => loan,
      getLiabilityPayments: async () => [{ id: "pay-1", liabilityProfileId: "loan-1", amount: 289.7, principalPortion: 250, interestPortion: 39.7, paymentDate: "2026-09-10", notes: "Amortization payment #1", createdAt: "2026-09-03T00:00:00Z" }],
      deleteLiabilityPayment: async () => true,
      unmarkLoanPayment: async (loanId: string, match: any) => { unmarks.push([loanId, match]); return 1; },
      updateProfile: async (_id: string, patch: any) => ({ ...loan, ...patch, fields: { ...loan.fields, ...patch.fields } }),
      getExpenses: async () => [], deleteExpense: async () => true, getAccountAdjustments: async () => [],
    };
    const out = await unpayBillOccurrence(storage, "loan-1", { paymentId: "pay-1" } as any, "UTC");
    expect(out.ok).toBe(true);
    expect(unmarks).toEqual([["loan-1", { paymentNumber: 1, paymentDate: "2026-09-10" }]]);
    expect(out.steps.some((s) => s.step === "schedule_unmark" && s.ok)).toBe(true);
  });
});

// ─── D168: a refused create hands the draft back to the calendar manager ────
describe("D168: CalendarManagerPanel restores the typed form when a create is refused", () => {
  it("source guard: every create mutation's onError restores the draft from its variables", () => {
    const src = readFileSync(new URL("../client/src/components/CalendarManagerPanel.tsx", import.meta.url), "utf8");
    // The three create forms (event, obligation, task) each clear their fields
    // right after mutate(); their onError must put the values back.
    expect((src.match(/restoreDraft\(vars\)/g) || []).length).toBe(2);
    expect(src).toMatch(/onError: \(err, vars: any, ctx\) => \{[\s\S]{0,200}setTitle\(String\(vars\.title/);
    expect(src).toMatch(/onError: \(err, vars: any, ctx\) => \{[\s\S]{0,200}setName\(String\(vars\.title/);
    // Every create form's onError names its variables; only deletes and the
    // quick-add (which restores its own preview snapshot) keep `_v`.
    const ignoring = (src.match(/onError: \(err, _v, ctx\)/g) || []).length;
    expect(ignoring).toBeLessThanOrEqual(4);
  });
});

// ─── D169: a shared artifact page must not be CDN-cached past its unshare ───
describe("D169: /api/public/artifacts/:token is not cacheable by the CDN", () => {
  it("source guard: the public viewer answers with a no-store policy, never public max-age", () => {
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const start = src.indexOf('app.get("/api/public/artifacts/:token"');
    const body = src.slice(start, start + 4000);
    expect(body).toContain('res.setHeader("Cache-Control", "private, no-store")');
    expect(body).not.toMatch(/Cache-Control", "public, max-age=/);
  });
});

// ─── D171: deleting a paycheck that is not yours is not a success ───────────
describe("D171: deletePaycheck reports the row count and the route maps none to 404", () => {
  it("storage: no row → false; one row → true; user filter present", async () => {
    const { client, calls } = chainClient((table, op) => table === "paychecks" && op === "delete" ? { data: [], error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client });
    expect(await s.deletePaycheck("pc-1")).toBe(false);
    const del = calls.find((c) => c.table === "paychecks" && c.op === "delete")!;
    expect(del.filters).toEqual(expect.arrayContaining([["eq", ["id", "pc-1"]], ["eq", ["user_id", s.userId]]]));
    const { client: c2 } = chainClient((table, op) => table === "paychecks" && op === "delete" ? { data: [{ id: "pc-1" }], error: null } : { data: [], error: null });
    expect(await bareStorage({ supabase: c2 }).deletePaycheck("pc-1")).toBe(true);
  });
  it("route: 404 when nothing was removed, 200 otherwise", async () => {
    let removed = false;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => { storage.deletePaycheck = async () => removed; });
    expect((await h.api("DELETE", "/api/paychecks/pc-1")).status).toBe(404);
    removed = true;
    expect((await h.api("DELETE", "/api/paychecks/pc-1")).status).toBe(200);
  });
});

// ─── D172: every delete answers what the database did ───────────────────────
describe("D172: deletes of tasks, expenses, events, tracker entries and entity links report the row count", () => {
  it("storage: no matching row → false, one row → true, user filter on every delete", async () => {
    const rec = (table: string, rows: any[]) => chainClient((t, op) => t === table && (op === "delete" || op === "update") ? { data: rows, error: null } : { data: [], error: null });
    for (const [table, call] of [
      ["tracker_entries", (s: any) => s.deleteTrackerEntry("tr-1", "en-1")],
      ["events", (s: any) => s.deleteEvent("ev-1")],
      ["entity_links", (s: any) => s.deleteEntityLink("ln-1")],
    ] as const) {
      const none = rec(table, []);
      const s0 = bareStorage({ supabase: none.client, cleanupEntityLinks: async () => undefined, getEvent: async () => ({ id: "ev-1" }) });
      expect(await call(s0), table).toBe(false);
      const op = none.calls.find((c) => c.table === table && (c.op === "delete" || c.op === "update"))!;
      expect(op.filters, table).toEqual(expect.arrayContaining([["eq", ["user_id", s0.userId]]]));
      const one = rec(table, [{ id: "x" }]);
      expect(await call(bareStorage({ supabase: one.client, cleanupEntityLinks: async () => undefined, getEvent: async () => ({ id: "ev-1" }) })), table).toBe(true);
    }
  });
  it("routes: DELETE /api/tasks/:id and /api/expenses/:id answer 404 when the storage removed nothing", async () => {
    let removed = false;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => { storage.deleteTask = async () => removed; storage.deleteExpense = async () => removed; });
    expect((await h.api("DELETE", "/api/tasks/t-1")).status).toBe(404);
    expect((await h.api("DELETE", "/api/expenses/e-1")).status).toBe(404);
    removed = true;
    expect((await h.api("DELETE", "/api/tasks/t-1")).status).toBe(200);
    expect((await h.api("DELETE", "/api/expenses/e-1")).status).toBe(200);
  });
});

// ─── D173: deleting a document that is not yours is a 404, not a cascade ────
describe("D173: DELETE /api/documents/:id checks ownership before the cascade", () => {
  it("404 when the document is not this user's; the cascade is not run", async () => {
    let cascaded = 0;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.getDocumentMeta = async (id: string) => (id === "doc-mine" ? { id, name: "Mine", type: "other" } : undefined);
      storage.getDocument = storage.getDocumentMeta;
      storage.deleteDocument = async () => { cascaded++; return true; };
      storage.getProfiles = async () => [];
      storage.getEvents = async () => [];
    });
    expect((await h.api("DELETE", "/api/documents/doc-theirs")).status).toBe(404);
    expect(cascaded).toBe(0);
  });
});

// ─── D174: unlink and materialize check the profile is the caller's ─────────
describe("D174: POST /api/profiles/:id/unlink and /api/obligations/:id/materialize are 404 for a foreign id", () => {
  it("unlink is not run for a profile that is not this user's", async () => {
    let unlinked = 0;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.unlinkProfileFrom = async () => { unlinked++; };
      storage.getObligation = async (id: string) => (id === "bill-mine" ? { id, name: "Mine" } : undefined);
    });
    expect((await h.api("POST", "/api/profiles/theirs-1/unlink", { targetId: "x", targetType: "profile" })).status).toBe(404);
    expect(unlinked).toBe(0);
    expect((await h.api("POST", "/api/obligations/bill-theirs/materialize")).status).toBe(404);
    expect((await h.api("POST", "/api/obligations/bill-mine/materialize")).status).toBe(200);
  });
});


// ─── D176: concurrent budget writes do not lose caps ─────────────────────────
describe("D176: budget writes are a compare-and-swap on the month's row", () => {
  it("a write that lost the race re-reads and re-applies; the final list holds both caps", async () => {
    // Row state as another writer would leave it: first read sees [], the CAS
    // update matches nothing (someone wrote "food" meanwhile), the re-read
    // sees [food], and the second CAS succeeds.
    let reads = 0; const updates: any[] = [];
    const foodRow = { id: "row-1", value: JSON.stringify([{ id: "f", category: "food", amount: 100 }]) };
    const { client } = chainClient((table, op, payload) => {
      if (table !== "preferences") return { data: [], error: null };
      if (op === "select") { reads++; return { data: [reads === 1 ? { id: "row-1", value: "[]" } : foodRow], error: null }; }
      if (op === "update") { updates.push(payload); return { data: updates.length === 1 ? [] : [{ id: "row-1" }], error: null }; }
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client });
    const added = await s.addBudget("2026-10", "transport", 150);
    expect(added.category).toBe("transport");
    expect(updates).toHaveLength(2);
    const final = JSON.parse(updates[1].value).map((b: any) => b.category).sort();
    expect(final).toEqual(["food", "transport"]);
  });
  it("two rows for one month (an insert race) are merged into the oldest and the extra removed", async () => {
    const calls: any[] = [];
    const { client } = chainClient((table, op, payload) => {
      calls.push([table, op]);
      if (table === "preferences" && op === "select") return { data: [{ id: "a", value: JSON.stringify([{ id: "1", category: "food", amount: 100 }]) }, { id: "b", value: JSON.stringify([{ id: "2", category: "pet", amount: 20 }, { id: "3", category: "food", amount: 999 }]) }], error: null };
      return { data: [], error: null };
    });
    const list = await bareStorage({ supabase: client }).getBudgets("2026-10");
    expect(list.map((b) => [b.category, b.amount])).toEqual([["food", 100], ["pet", 20]]);
    expect(calls.some(([t, op]) => t === "preferences" && op === "update")).toBe(true);
    expect(calls.some(([t, op]) => t === "preferences" && op === "delete")).toBe(true);
  });
});

// ─── D177: parallel skips on one bill do not lose each other ────────────────
describe("D177: updateOccurrenceOverride is an optimistic-concurrency write", () => {
  it("a write that lost the race re-reads the fresh map and re-applies its own change", async () => {
    let reads = 0; const updates: any[] = [];
    const first = { fields: { occurrences: {} }, updated_at: "t1" };
    const second = { fields: { occurrences: { "2026-09-10": { status: "skipped" } } }, updated_at: "t2" };
    const { client } = chainClient((table, op, payload) => {
      if (table !== "profiles") return { data: [], error: null };
      if (op === "select") { reads++; return { data: [reads === 1 ? first : second], error: null }; }
      if (op === "update") { updates.push(payload); return { data: updates.length === 1 ? [] : [{ id: "bill-1" }], error: null }; }
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, getProfile: async () => ({ id: "bill-1", type: "liability", fields: {} }), getLiabilitySchedule: async () => ({ ok: true }), clearRequestMemo: () => {} });
    const out = await s.updateOccurrenceOverride("bill-1", "2026-09-17", { status: "skipped" });
    expect(out).toEqual({ ok: true });
    expect(updates).toHaveLength(2);
    expect(updates[1].fields.occurrences).toEqual({ "2026-09-10": { status: "skipped" }, "2026-09-17": { status: "skipped" } });
  });
  it("a function patch sees the fresh occurrence (a second charge keeps the first)", async () => {
    const updates: any[] = [];
    const row = { fields: { occurrences: { "2026-09-10": { charges: [{ id: "c1", amount: 5 }] } } }, updated_at: "t1" };
    const { client } = chainClient((table, op, payload) => {
      if (table !== "profiles") return { data: [], error: null };
      if (op === "select") return { data: [row], error: null };
      if (op === "update") { updates.push(payload); return { data: [{ id: "bill-1" }], error: null }; }
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, getProfile: async () => ({ id: "bill-1", type: "liability", fields: {} }), getLiabilitySchedule: async () => ({ ok: true }), clearRequestMemo: () => {} });
    await s.updateOccurrenceOverride("bill-1", "2026-09-10", (cur: any) => ({ charges: [...(cur.charges || []), { id: "c2", amount: 7 }] }));
    expect(updates[0].fields.occurrences["2026-09-10"].charges.map((c: any) => c.id)).toEqual(["c1", "c2"]);
  });
});

// ─── D178: edits write only the columns they name; profile fields are CAS-guarded ─
describe("D178: partial edits do not overwrite each other", () => {
  it("updateTask writes only the patched column, not the whole row it had read", async () => {
    const updates: any[] = [];
    const { client } = chainClient((table, op, payload) => {
      if (table === "tasks" && op === "select") return { data: [{ id: "t-1", title: "Milk", status: "todo", priority: "medium", due_date: "2026-09-10", tags: [], linked_profiles: ["self-1"], updated_at: "u1" }], error: null };
      if (table === "tasks" && op === "update") { updates.push(payload); return { data: [{ id: "t-1" }], error: null }; }
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, assertNoWriteConflictFor: async () => undefined, guardedWrite: async (q: any) => q, getTask: async () => ({ id: "t-1", title: "Milk", status: "todo", priority: "medium", dueDate: "2026-09-10", tags: [], linkedProfiles: ["self-1"] }), applyOwnershipPatch: async () => undefined, clearRequestMemo: () => {} });
    await s.updateTask("t-1", { priority: "high" });
    expect(Object.keys(updates[0]).filter((k) => k !== "updated_at").sort()).toEqual(["priority"]);
    expect(updates[0].priority).toBe("high");
  });
  it("updateProfile: a name edit leaves `fields` alone; a field edit that lost the race re-reads and re-merges", async () => {
    const updates: any[] = []; let reads = 0;
    const rowA = { id: "p-1", type: "person", name: "Mike", fields: { city: "Austin" }, tags: [], notes: "", documents: [], updated_at: "u1" };
    const rowB = { ...rowA, fields: { city: "Austin", phone: "+1 512 555 0100" }, updated_at: "u2" };
    const { client } = chainClient((table, op, payload) => {
      if (table === "profiles" && op === "select") { reads++; return { data: [reads === 1 ? rowA : rowB], error: null }; }
      if (table === "profiles" && op === "update") { updates.push(payload); return { data: updates.length === 1 ? [] : [{ id: "p-1" }], error: null }; }
      return { data: [], error: null };
    });
    const profiles: any[] = [rowA, rowB];
    const s = bareStorage({ supabase: client, getProfile: async () => { const r = profiles[Math.min(reads, 1)]; reads++; return { id: r.id, type: r.type, name: r.name, fields: r.fields, tags: r.tags, notes: r.notes, documents: r.documents, updatedAt: r.updated_at }; }, clearRequestMemo: () => {}, healOwnerPrefixedProfileNames: (x: any) => x, setOwners: async () => undefined, applyOwnershipPatch: async () => undefined, bumpDataVersion: async () => undefined });
    await s.updateProfile("p-1", { fields: { email: "m@example.com" } });
    expect(updates).toHaveLength(2);
    expect(updates[1].fields).toEqual({ city: "Austin", phone: "+1 512 555 0100", email: "m@example.com" });
    expect(Object.keys(updates[1]).sort()).toEqual(["fields", "updated_at"]);
  });
});

// ─── D179: artifact edits and checklist toggles in flight together ──────────
describe("D179: an artifact rename does not rewrite items; a toggle is a compare-and-swap", () => {
  it("updateArtifact with only a title writes only title (and updated_at)", async () => {
    const updates: any[] = [];
    const { client } = chainClient((table, op, payload) => {
      if (table === "artifacts" && op === "select") return { data: [{ metadata: {} }], error: null };
      if (table === "artifacts" && op === "update") { updates.push(payload); return { data: [{ id: "a-1" }], error: null }; }
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, getArtifact: async () => ({ id: "a-1", type: "checklist", title: "List", content: "", items: [{ id: "i1", text: "milk", checked: false }], tags: [], pinned: false, linkedProfiles: [] }), applyOwnershipPatch: async () => undefined, clearRequestMemo: () => {} });
    await s.updateArtifact("a-1", { title: "List renamed" });
    expect(Object.keys(updates[0]).sort()).toEqual(["title", "updated_at"]);
  });
  it("toggleChecklistItem re-reads when it lost the race and flips the fresh list", async () => {
    let reads = 0; const updates: any[] = [];
    const rows = [
      { items: [{ id: "i1", text: "milk", checked: false }, { id: "i2", text: "eggs", checked: false }], updated_at: "u1" },
      { items: [{ id: "i1", text: "milk", checked: false }, { id: "i2", text: "eggs", checked: true }], updated_at: "u2" },
    ];
    const { client } = chainClient((table, op, payload) => {
      if (table !== "artifacts") return { data: [], error: null };
      if (op === "select") { reads++; return { data: [rows[Math.min(reads - 1, 1)]], error: null }; }
      if (op === "update") { updates.push(payload); return { data: updates.length === 1 ? [] : [{ id: "a-1" }], error: null }; }
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, getArtifact: async () => ({ id: "a-1" }), clearRequestMemo: () => {} });
    await s.toggleChecklistItem("a-1", "i1");
    expect(updates).toHaveLength(2);
    expect(updates[1].items).toEqual([{ id: "i1", text: "milk", checked: true }, { id: "i2", text: "eggs", checked: true }]);
  });
});
