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

// ─── D180: trashed records keep their links until purged ─────────────────────
describe("D180: a restore brings a record's entity links back with it", () => {
  const mk = () => chainClient((_t, op) => op === "update" || op === "delete" ? { data: [{ id: "x" }], error: null } : { data: [], error: null });
  it("soft deletes never touch entity_links; the hard deletes still wipe them", async () => {
    const soft: Array<[string, (s: any) => Promise<any>]> = [
      ["task", (s) => s.deleteTask("t-1")], ["expense", (s) => s.deleteExpense("e-1")], ["event", (s) => s.deleteEvent("ev-1")],
      ["habit", (s) => s.deleteHabit("h-1")], ["document", (s) => s.deleteDocument("d-1")],
    ];
    for (const [name, call] of soft) {
      const { client, calls } = mk();
      const s = bareStorage({ supabase: client, getEvent: async () => ({ id: "ev-1" }), habitMirrorTrackerId: async () => null, freezeGoalProgress: async () => undefined, getDocumentMeta: async () => null });
      expect(await call(s), name).toBe(true);
      expect(calls.some((c) => c.table === "entity_links"), name).toBe(false);
    }
    for (const [name, call] of [["purgeTask", (s: any) => s.purgeTask("t-1")], ["deleteTracker", (s: any) => s.deleteTracker("tr-1")]] as const) {
      const { client, calls } = mk();
      const s = bareStorage({ supabase: client, freezeGoalProgress: async () => undefined });
      await call(s);
      const wipe = calls.find((c) => c.table === "entity_links" && c.op === "delete");
      expect(wipe, name).toBeTruthy();
      expect(wipe!.filters, name).toEqual(expect.arrayContaining([["eq", ["user_id", s.userId]]]));
    }
  });
  it("getEntityLinks hides a link whose other end sits in the trash and keeps the live ones", async () => {
    const T = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222", E = "33333333-3333-4333-8333-333333333333";
    const row = (id: string, tt: string, tid: string) => ({ id, source_type: "task", source_id: T, target_type: tt, target_id: tid, relationship: "related_to", confidence: 1, created_at: "2026-09-03T00:00:00Z" });
    const { client, calls } = chainClient((table) => {
      if (table === "entity_links") return { data: [row("l1", "profile", P), row("l2", "expense", E)], error: null };
      if (table === "tasks") return { data: [{ id: T }], error: null };
      if (table === "profiles") return { data: [{ id: P }], error: null };
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client });
    const links = await s.getEntityLinks("task", T);
    expect(links.map((l: any) => l.id)).toEqual(["l1"]);
    for (const tbl of ["tasks", "profiles", "expenses"]) {
      const c = calls.find((c) => c.table === tbl)!;
      expect(c, tbl).toBeTruthy();
      expect(c.filters, tbl).toEqual(expect.arrayContaining([["is", ["deleted_at", null]], ["eq", ["user_id", s.userId]]]));
    }
  });
  it("a trashed record itself lists no links", async () => {
    const T = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222";
    const { client } = chainClient((table) => {
      if (table === "entity_links") return { data: [{ id: "l1", source_type: "task", source_id: T, target_type: "profile", target_id: P, relationship: "related_to", confidence: 1, created_at: "x" }], error: null };
      if (table === "profiles") return { data: [{ id: P }], error: null };
      return { data: [], error: null };
    });
    expect(await bareStorage({ supabase: client }).getEntityLinks("profile", P)).toEqual([]);
  });
});

// ─── D181: parallel field edits to one tracker entry both land ───────────────
describe("D181: a tracker entry edit is a compare-and-swap on updated_at", () => {
  const BP = { id: "t1", name: "BP", category: "health", unit: "mmHg", fields: [{ name: "systolic", type: "number", isPrimary: true }, { name: "diastolic", type: "number" }] };
  const base = { id: "e1", tracker_id: "t1", entry_values: { systolic: 120, diastolic: 80 }, computed: { validated: true }, timestamp: "2026-09-01T12:00:00Z", updated_at: "2026-09-01T12:00:00Z" };
  it("retries from the fresh row when the swap misses, keeping the other writer's field", async () => {
    let reads = 0, updates = 0;
    const { client, calls } = chainClient((table, op, payload) => {
      if (table !== "tracker_entries") return { data: [], error: null };
      if (op === "update") { updates++; return updates === 1 ? { data: [], error: null } : { data: [{ ...base, ...payload }], error: null }; }
      reads++;
      return { data: [reads === 1 ? base : { ...base, entry_values: { systolic: 120, diastolic: 91 }, updated_at: "2026-09-01T12:00:05Z" }], error: null };
    });
    const s = bareStorage({ supabase: client, getTracker: async () => BP });
    const out = await s.updateTrackerEntry("t1", "e1", { values: { systolic: 131 } });
    expect(out.values).toEqual({ systolic: 131, diastolic: 91 });
    const ups = calls.filter((c) => c.table === "tracker_entries" && c.op === "update");
    expect(ups).toHaveLength(2);
    expect(ups[0].filters).toEqual(expect.arrayContaining([["eq", ["updated_at", "2026-09-01T12:00:00Z"]], ["eq", ["user_id", s.userId]]]));
    expect(ups[1].filters).toEqual(expect.arrayContaining([["eq", ["updated_at", "2026-09-01T12:00:05Z"]]]));
    expect(ups[1].payload.entry_values).toEqual({ systolic: 131, diastolic: 91 });
  });
  it("gives up with an error, never a silent overwrite, when the row keeps moving", async () => {
    const { client } = chainClient((table, op) => table === "tracker_entries" && op === "update" ? { data: [], error: null } : { data: [base], error: null });
    const s = bareStorage({ supabase: client, getTracker: async () => BP });
    await expect(s.updateTrackerEntry("t1", "e1", { values: { systolic: 131 } })).rejects.toThrow(/colliding/);
  });
});

// ─── D182–D184: money writes plan against the balance the write lands on ────
import { payBillOccurrence } from "../server/liability-payments";
function payStorage(seed: any) {
  const profiles = new Map<string, any>([[seed.id, structuredClone(seed)]]);
  const payments: any[] = [];
  const s: any = {
    getProfile: async (id: string) => (profiles.get(id) ? structuredClone(profiles.get(id)) : undefined),
    updateProfile: async (id: string, patch: any) => {
      const p = profiles.get(id); if (!p) return undefined;
      const next = { ...p, ...patch, fields: { ...p.fields, ...(patch.fields || {}) } };
      profiles.set(id, next); return structuredClone(next);
    },
    mutateProfileFields: async (id: string, fn: any) => {
      const p = profiles.get(id); if (!p) return undefined;
      const patch = fn(structuredClone(p)); return patch ? s.updateProfile(id, patch) : structuredClone(p);
    },
    claimBillOccurrence: async (id: string, date: string, stamp: any, extra: any) => {
      const p = profiles.get(id); const prior = p.fields.occurrences || {};
      if (prior[date]?.status === "paid") return { status: "already-paid", occurrences: prior };
      await s.updateProfile(id, { fields: { ...extra, occurrences: { ...prior, [date]: { ...(prior[date] || {}), ...stamp } } } });
      return { status: "claimed", occurrences: prior };
    },
    createLiabilityPayment: async (d: any) => { const row = { id: d.id || `pay-${payments.length + 1}`, ...d }; payments.push(row); return row; },
    getLiabilityPayment: async (id: string) => payments.find((p) => p.id === id),
    getLiabilityPayments: async () => payments.slice(),
    getTasks: async () => [],
    createExpense: async () => ({ id: "exp-1" }),
  };
  return { s, payments, profiles };
}
describe("D184: a loan payment leaves the advanced due date and the occurrence stamp in place", () => {
  it("standard payment: due date moves one cycle and STAYS moved after the balance write", async () => {
    const { s, profiles } = payStorage({ id: "loan-1", name: "Loan", type: "liability", type_key: "loan", fields: { currentBalance: 5000, interestRate: 6, monthlyPayment: 200, dueDate: "2026-09-06", nextDueDate: "2026-09-06", frequency: "monthly" } });
    const out = await payBillOccurrence(s, "loan-1", { amount: 200, paymentDate: "2026-09-03" }, "UTC");
    expect(out.ok).toBe(true);
    const f = profiles.get("loan-1").fields;
    expect(f.dueDate).toBe("2026-10-06");
    expect(f.occurrences["2026-09-06"].status).toBe("paid");
    expect(f.currentBalance).toBeLessThan(5000);
    expect(f.currentBalance).toBeGreaterThan(4800);
  });
});
describe("D183: a second, different payment on a settled occurrence is recorded, not folded into the first", () => {
  it("an extra-principal payment after the regular one: two rows, balance down by both, due date untouched", async () => {
    const { s, payments, profiles } = payStorage({ id: "loan-1", name: "Loan", type: "liability", type_key: "loan", fields: { currentBalance: 5000, interestRate: 6, monthlyPayment: 200, dueDate: "2026-09-06", nextDueDate: "2026-09-06", frequency: "monthly" } });
    const first = await payBillOccurrence(s, "loan-1", { amount: 200, paymentDate: "2026-09-03" }, "UTC");
    const after1 = profiles.get("loan-1").fields.currentBalance;
    const extra = await payBillOccurrence(s, "loan-1", { amount: 100, paymentDate: "2026-09-03", paymentType: "extra_principal" }, "UTC");
    expect(extra.ok).toBe(true);
    expect(extra.deduped).toBeFalsy();
    expect(extra.dueDateAdvanced).toBe(false);
    expect(payments).toHaveLength(2);
    expect(profiles.get("loan-1").fields.dueDate).toBe("2026-10-06");
    expect(profiles.get("loan-1").fields.currentBalance).toBeCloseTo(after1 - 100, 2);
    expect(first.payment.id).not.toBe(extra.payment.id);
  });
  it("loan without a due date: 100 then 300 the same day are two payments; the same 300 again seconds later is the double tap", async () => {
    const { s, payments, profiles } = payStorage({ id: "loan-2", name: "Loan", type: "liability", type_key: "loan", fields: { currentBalance: 5000, interestRate: 6, monthlyPayment: 200 } });
    await payBillOccurrence(s, "loan-2", { amount: 100, paymentDate: "2026-09-03", paymentType: "extra_principal" }, "UTC");
    const second = await payBillOccurrence(s, "loan-2", { amount: 300, paymentDate: "2026-09-03" }, "UTC");
    expect(second.deduped).toBeFalsy();
    const tap = await payBillOccurrence(s, "loan-2", { amount: 300, paymentDate: "2026-09-03" }, "UTC");
    expect(tap.deduped).toBe(true);
    expect(tap.payment?.id).toBe(second.payment?.id);
    expect(payments).toHaveLength(2);
    expect(profiles.get("loan-2").fields.currentBalance).toBeCloseTo(5000 - 100 - second.payment.principalPortion, 2);
  });
  it("automation re-paying a settled occurrence stays idempotent (extraction, ai, autopay)", async () => {
    for (const source of ["extraction", "ai", "autopay"] as const) {
      const { s, payments } = payStorage({ id: "bill-2", name: "Water", type: "liability", type_key: "utility", fields: { monthlyAmount: 40, amount: 40, dueDate: "2026-09-10", nextDueDate: "2026-09-10", frequency: "monthly", autoLogExpense: false } });
      const first = await payBillOccurrence(s, "bill-2", { occurrenceDate: "2026-09-10", paymentDate: "2026-09-01", source: "route" }, "UTC");
      // Well past the double-tap window, a different amount: still the same occurrence for automation.
      s.getProfile = (((orig) => async (id: string) => { const p = await orig(id); if (p?.fields?.occurrences?.["2026-09-10"]) p.fields.occurrences["2026-09-10"].postedAt = "2026-09-01T00:00:00Z"; return p; })(s.getProfile));
      const again = await payBillOccurrence(s, "bill-2", { occurrenceDate: "2026-09-10", amount: 45, paymentDate: "2026-09-02", source }, "UTC");
      expect(again.deduped, source).toBe(true);
      expect(again.payment?.id, source).toBe(first.payment.id);
      expect(payments, source).toHaveLength(1);
    }
  });
  it("a repeated one-tap 'Mark paid' (no amount) on a settled occurrence stays the same payment", async () => {
    const { s, payments } = payStorage({ id: "bill-3", name: "Water", type: "liability", type_key: "utility", fields: { monthlyAmount: 40, amount: 40, dueDate: "2026-09-10", nextDueDate: "2026-09-10", frequency: "monthly", autoLogExpense: false } });
    const first = await payBillOccurrence(s, "bill-3", { occurrenceDate: "2026-09-10", source: "route" }, "UTC");
    s.getProfile = (((orig) => async (id: string) => { const p = await orig(id); if (p?.fields?.occurrences?.["2026-09-10"]) p.fields.occurrences["2026-09-10"].postedAt = "2026-09-01T00:00:00Z"; return p; })(s.getProfile));
    const again = await payBillOccurrence(s, "bill-3", { occurrenceDate: "2026-09-10", source: "route" }, "UTC");
    expect(again.deduped).toBe(true);
    expect(again.payment?.id).toBe(first.payment.id);
    expect(payments).toHaveLength(1);
  });
  it("a bill paid in two goes: the second part is a payment of its own on the same occurrence", async () => {
    const { s, payments, profiles } = payStorage({ id: "bill-1", name: "Power", type: "liability", type_key: "utility", fields: { monthlyAmount: 100, amount: 100, dueDate: "2026-09-10", nextDueDate: "2026-09-10", frequency: "monthly", autoLogExpense: false } });
    const a = await payBillOccurrence(s, "bill-1", { amount: 60, occurrenceDate: "2026-09-10", paymentDate: "2026-09-03" }, "UTC");
    const b = await payBillOccurrence(s, "bill-1", { amount: 40, occurrenceDate: "2026-09-10", paymentDate: "2026-09-04" }, "UTC");
    expect(a.ok && b.ok).toBe(true);
    expect(b.deduped).toBeFalsy();
    expect(b.additional).toBe(true);
    expect(payments.map((p) => p.amount)).toEqual([60, 40]);
    expect(profiles.get("bill-1").fields.dueDate).toBe("2026-10-10");
  });
});
describe("D182: an account adjustment applies its delta to the balance the write lands on", () => {
  it("mutateProfileFields re-plans from the fresh row when the guarded write misses", async () => {
    let reads = 0;
    const at = (balance: number, updatedAt: string) => ({ id: "acct-1", type: "account", name: "Checking", fields: { balance, currentValue: balance, accountKind: "checking" }, updatedAt });
    // read 1: the account guard; read 2: the first plan (1000); read 3: after the miss (another writer left 900)
    const rows = [at(1000, "2026-09-03T00:00:00Z"), at(1000, "2026-09-03T00:00:00Z"), at(900, "2026-09-03T00:00:01Z")];
    let updates = 0;
    const { client, calls } = chainClient((table, op) => {
      if (table !== "profiles") return { data: [], error: null };
      if (op === "update") { updates++; return updates === 1 ? { data: [], error: null } : { data: [{ id: "acct-1" }], error: null }; }
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, getProfile: async () => rows[Math.min(reads++, 2)], clearRequestMemo: () => {}, healOwnerPrefixedProfileNames: (x: any) => x, setOwners: async () => undefined, applyOwnershipPatch: async () => undefined, bumpDataVersion: async () => undefined });
    await s.adjustAccountBalance("acct-1", { delta: -50, source: "user" });
    const ups = calls.filter((c) => c.table === "profiles" && c.op === "update");
    expect(ups).toHaveLength(2);
    expect(ups[0].payload.fields.balance).toBe(950);
    expect(ups[0].filters).toEqual(expect.arrayContaining([["eq", ["updated_at", "2026-09-03T00:00:00Z"]]]));
    expect(ups[1].payload.fields.balance).toBe(850);
    expect(ups[1].filters).toEqual(expect.arrayContaining([["eq", ["updated_at", "2026-09-03T00:00:01Z"]]]));
    expect(ups[1].payload.fields.balanceHistory).toHaveLength(1);
    expect(ups[1].payload.fields.balanceHistory[0]).toMatchObject({ previousBalance: 900, newBalance: 850, delta: -50 });
  });
});

// ─── D185: a snapshot write-back names only what it changed ─────────────────
import { fieldPatchBetween } from "../shared/field-patch";
import { cleanupStoredProfileFields } from "../shared/profile-field-identity";
describe("D185: a read's alias cleanup (and every other snapshot write-back) writes only what changed", () => {
  it("fieldPatchBetween: changed keys carry the new value, vanished keys null, untouched keys absent", () => {
    const before = { address: "1 Old St", currentValue: 400000, value: 400000, personal: { phone: "1" }, tags: ["a"] };
    const after = { address: "1 Old St", currentValue: 400000, personal: { phone: "2" }, tags: ["a"], note: "x" };
    expect(fieldPatchBetween(before, after)).toEqual({ value: null, personal: { phone: "2" }, note: "x" });
    expect(fieldPatchBetween(before, before)).toEqual({});
    expect(fieldPatchBetween(undefined, { a: 1 })).toEqual({ a: 1 });
  });
  it("the detail read's cleanup patch drops the redundant alias and says nothing about the address", () => {
    const stored = { currentValue: 400000, value: 400000, marketValue: 400000, address: "1 Old St" };
    const cleanup = cleanupStoredProfileFields(stored);
    expect(cleanup.changed).toBe(true);
    const patch: Record<string, any> = fieldPatchBetween(stored, cleanup.fields);
    for (const path of cleanup.removed) if (!path.includes(".")) patch[path] = null;
    expect(patch).not.toHaveProperty("address");
    expect(patch).not.toHaveProperty("currentValue");
    expect(Object.values(patch).every((v) => v === null)).toBe(true);
    expect(Object.keys(patch).length).toBeGreaterThan(0);
  });
});

// ─── D186: an undone payment restores its principal onto the live balance ───
import { unpayBillOccurrence } from "../server/liability-payments";
describe("D186: unpay adds the principal back to the balance as it is when the write lands", () => {
  it("an undo beside another payment keeps that payment's effect", async () => {
    const { s, payments, profiles } = payStorage({ id: "loan-3", name: "Loan", type: "liability", type_key: "loan", fields: { currentBalance: 5000, interestRate: 6, monthlyPayment: 200 } });
    const first = await payBillOccurrence(s, "loan-3", { amount: 100, paymentDate: "2026-09-03", paymentType: "extra_principal" }, "UTC");
    expect(profiles.get("loan-3").fields.currentBalance).toBe(4900);
    // The undo reads the loan at 4900; a 300 payment lands before its write.
    const realGet = s.getProfile;
    let stale = 0;
    s.getProfile = async (id: string) => { const p = await realGet(id); if (id === "loan-3" && stale++ === 0) { profiles.get("loan-3").fields.currentBalance = 4600; payments.push({ id: "pay-other", liabilityProfileId: "loan-3", paymentDate: "2026-09-03", amount: 300, principalPortion: 300, paymentType: "extra_principal" }); } return p; };
    s.deleteLiabilityPayment = async (id: string) => { const i = payments.findIndex((p) => p.id === id); if (i < 0) return false; payments.splice(i, 1); return true; };
    s.getLiabilityPayments = async () => payments.slice();
    const undone = await unpayBillOccurrence(s, "loan-3", { paymentId: first.payment.id, source: "route" }, "UTC");
    expect(undone.ok).toBe(true);
    expect(undone.balanceRestored).toBe(true);
    expect(profiles.get("loan-3").fields.currentBalance).toBe(4700);
    expect(payments.map((p) => p.id)).toEqual(["pay-other"]);
  });
});

// ─── D187: spending is keyed like the caps it is measured against ───────────
import { spendByCategory } from "../shared/budget-ledger";
describe("D187: spendByCategory folds every spelling onto the budget key", () => {
  it("'transportation', 'Transport' and 'transport' rows meet under one key; unknown words keep their own", () => {
    const out = spendByCategory([
      { category: "transportation", amount: 40 }, { category: "Transport", amount: 12.1 }, { category: "transport", amount: 5 },
      { category: "Groceries", amount: 30 }, { category: "food", amount: 20 }, { category: "Lego", amount: 9 }, { category: null, amount: 1 },
    ]);
    expect(out).toEqual({ transport: 57.1, food: 50, lego: 9, general: 1 });
  });
});

// ─── D188: a second payment the same day belongs to the occurrence just paid ─
describe("D188: an implicit payment dated on or before the last paid occurrence attaches to it", () => {
  const LOAN = { id: "loan-4", name: "Loan", type: "liability", type_key: "loan", fields: { currentBalance: 5000, interestRate: 6, monthlyPayment: 200, dueDate: "2026-09-08", nextDueDate: "2026-09-08", frequency: "monthly" } };
  it("regular 200 on the 3rd, then 100 the same day: due date moves once, both rows recorded", async () => {
    const { s, payments, profiles } = payStorage(LOAN);
    await payBillOccurrence(s, "loan-4", { amount: 200, paymentDate: "2026-09-03", source: "route" }, "UTC");
    expect(profiles.get("loan-4").fields.dueDate).toBe("2026-10-08");
    const second = await payBillOccurrence(s, "loan-4", { amount: 100, paymentDate: "2026-09-03", source: "route" }, "UTC");
    expect(second.ok).toBe(true);
    expect(second.deduped).toBeFalsy();
    expect(second.additional).toBe(true);
    expect(second.occurrenceDate).toBe("2026-09-08");
    expect(profiles.get("loan-4").fields.dueDate).toBe("2026-10-08");
    expect(payments).toHaveLength(2);
  });
  it("catching up two overdue months claims them one after another", async () => {
    const { s, profiles } = payStorage({ ...LOAN, id: "loan-5", fields: { ...LOAN.fields, dueDate: "2026-07-08", nextDueDate: "2026-07-08" } });
    await payBillOccurrence(s, "loan-5", { amount: 200, paymentDate: "2026-09-03", source: "route" }, "UTC");
    expect(profiles.get("loan-5").fields.dueDate).toBe("2026-08-08");
    const again = await payBillOccurrence(s, "loan-5", { amount: 201, paymentDate: "2026-09-03", source: "route" }, "UTC");
    expect(again.additional).toBeFalsy();
    expect(again.occurrenceDate).toBe("2026-08-08");
    expect(profiles.get("loan-5").fields.dueDate).toBe("2026-09-08");
  });
  it("a payment dated after the last paid occurrence is the next cycle's", async () => {
    const { s, profiles } = payStorage({ ...LOAN, id: "loan-6" });
    await payBillOccurrence(s, "loan-6", { amount: 200, paymentDate: "2026-09-03", source: "route" }, "UTC");
    const next = await payBillOccurrence(s, "loan-6", { amount: 210, paymentDate: "2026-09-20", source: "route" }, "UTC");
    expect(next.additional).toBeFalsy();
    expect(next.occurrenceDate).toBe("2026-10-08");
    expect(profiles.get("loan-6").fields.dueDate).toBe("2026-11-08");
  });
});

// ─── D190: an owner that names no profile is a 404, not a 500 ───────────────
import { setOwners } from "../server/ownership-writer";
describe("D190: the ownership writer maps the guard's rejection to a 404", () => {
  it("rejects with statusCode 404 naming the profile", async () => {
    const { client } = chainClient((table, op) => {
      if (op === "update") return { data: null, error: { message: "linked_profiles on public.tasks references profile 11111111-2222-4333-8444-555555555555 which does not exist" } };
      if (table === "tasks") return { data: [{ id: "t-1", linked_profiles: ["22222222-2222-4222-8222-222222222222"] }], error: null };
      return { data: [], error: null };
    });
    await expect(setOwners(client as any, "u-1", "task", "t-1", ["11111111-2222-4333-8444-555555555555"], "22222222-2222-4222-8222-222222222222"))
      .rejects.toMatchObject({ statusCode: 404, message: expect.stringContaining("11111111-2222-4333-8444-555555555555") });
  });
});

// ─── D192: a reversal after a payoff restores the balance ───────────────────
describe("D192: a reversal moves the balance even when the debt sits at 0", () => {
  it("payoff to 0, then a 100 reversal → balance 100, row carries remainingBalanceAfter", async () => {
    const { s, profiles } = payStorage({ id: "card-1", name: "Card", type: "liability", type_key: "credit_card", fields: { currentBalance: 1200, interestRate: 22, monthlyPayment: 35 } });
    await payBillOccurrence(s, "card-1", { amount: 1210, paymentDate: "2026-09-03", paymentType: "payoff", source: "route" }, "UTC");
    expect(profiles.get("card-1").fields.currentBalance).toBe(0);
    const rev = await payBillOccurrence(s, "card-1", { amount: 100, paymentDate: "2026-09-04", paymentType: "reversal", source: "route" }, "UTC");
    expect(rev.ok).toBe(true);
    // The row stores the magnitude (the table refuses a negative principal); the type carries the direction.
    expect(rev.payment.principalPortion).toBe(100);
    expect(rev.payment.paymentType).toBe("reversal");
    expect(rev.payment.remainingBalanceAfter).toBe(100);
    expect(profiles.get("card-1").fields.currentBalance).toBe(100);
  });
});

// ─── D193: chat undo touches only what the tool changed ─────────────────────
describe("D193: 'undo' with the post-write row re-applies only the keys the tool changed", () => {
  it("a field edited from a form after the chat edit survives the undo; the tool's field goes back", async () => {
    const s = new MemStorage();
    const p = await s.createProfile({ type: "person", name: "Mike", fields: { phone: "111", city: "Austin" } } as any);
    const before = JSON.parse(JSON.stringify(await s.getProfile(p.id)));
    const after = JSON.parse(JSON.stringify(await s.updateProfile(p.id, { fields: { city: "Dallas", email: "m@example.com" } } as any)));
    await s.updateProfile(p.id, { fields: { phone: "222" } } as any); // the form, later
    const out = await executeReversePlan(s, { entityType: "profile", entityId: p.id, entityName: "Mike", reversible: true, after, reversePlan: { op: "reapply_before", before } } as any);
    expect(out.ok).toBe(true);
    const f = (await s.getProfile(p.id))!.fields as Record<string, any>;
    expect(f.city).toBe("Austin");
    expect(f).not.toHaveProperty("email");
    expect(f.phone).toBe("222");
  });
  it("a balance the chat moved is undone as the opposite move, keeping a debit that landed since", async () => {
    const s = new MemStorage();
    const acct = await s.createProfile({ type: "account", name: "Checking", fields: { balance: 1000, currentValue: 1000, accountKind: "checking" } } as any);
    const before = JSON.parse(JSON.stringify(await s.getProfile(acct.id)));
    const after = JSON.parse(JSON.stringify(await s.adjustAccountBalance(acct.id, { newBalance: 1200, source: "ai" })));
    await s.adjustAccountBalance(acct.id, { delta: -50, reason: "bill", source: "payment" }); // a bill, later
    const out = await executeReversePlan(s, { entityType: "profile", entityId: acct.id, entityName: "Checking", reversible: true, after, reversePlan: { op: "reapply_before", before } } as any);
    expect(out.ok).toBe(true);
    const f = (await s.getProfile(acct.id))!.fields as Record<string, any>;
    expect(Number(f.balance ?? f.currentValue)).toBe(950);
  });
});

// ─── D194: un-completing a chore spares a next occurrence the user edited ───
describe("D194: retracting a spawned occurrence only removes an untouched clone", () => {
  const prev = { id: "t-1", title: "Weekly bins", description: "", priority: "medium", dueDate: "2026-09-03", dueTime: null, status: "done", tags: ["recur:weekly"], linkedProfiles: ["self-1"] };
  const cloneOf = (extra: Record<string, any>) => ({ id: "t-1-next", title: "Weekly bins", description: "", priority: "medium", dueDate: "2026-09-10", dueTime: null, status: "todo", tags: ["recur:weekly", "rdone:1"], linkedProfiles: ["self-1"], ...extra });
  function retractWith(clone: any) {
    const purged: string[] = [];
    const s = bareStorage({ getTask: async () => clone, recurringCloneId: () => "t-1-next", purgeTask: async (id: string) => { purged.push(id); return true; } });
    return { s, purged };
  }
  it("an untouched clone is purged", async () => {
    const { s, purged } = retractWith(cloneOf({}));
    expect(await s.retractSpawnedRecurringTask(prev)).toBe(true);
    expect(purged).toEqual(["t-1-next"]);
  });
  it("a clone the user edited (a note, a priority, a time, an owner) stays", async () => {
    for (const edit of [{ description: "bring the recycling too" }, { priority: "high" }, { dueTime: "08:00" }, { linkedProfiles: ["self-1", "linda-1"] }, { tags: ["recur:weekly", "rdone:1", "outside"] }]) {
      const { s, purged } = retractWith(cloneOf(edit));
      expect(await s.retractSpawnedRecurringTask(prev), JSON.stringify(edit)).toBe(false);
      expect(purged, JSON.stringify(edit)).toEqual([]);
    }
  });
});

// ─── D195: a version conflict on a habit or goal edit answers 409, not 500 ──
describe("D195: habit and goal edit routes pass a typed refusal through", () => {
  it("a 409 from the storage reaches the client as 409 with its message", async () => {
    const conflict = () => { throw Object.assign(new Error("This record was changed by someone else; reload and try again"), { statusCode: 409 }); };
    const booted = await boot({}, (storage) => { storage.updateHabit = async () => conflict(); storage.updateGoal = async () => conflict(); storage.getHabit = async () => ({ id: "h-1", name: "Stretch", frequency: "daily" }); storage.getGoal = async () => ({ id: "g-1", title: "Read", type: "custom", target: 10, current: 0, status: "active" }); });
    try {
      const h = await booted.api("PATCH", "/api/habits/h-1", { name: "Stretch more", expectedUpdatedAt: "2026-09-01T00:00:00Z" });
      expect(h.status).toBe(409);
      expect(h.data?.error).toMatch(/changed by someone else/);
      const g = await booted.api("PATCH", "/api/goals/g-1", { title: "Read more", expectedUpdatedAt: "2026-09-01T00:00:00Z" });
      expect(g.status).toBe(409);
      expect(g.data?.error).toMatch(/changed by someone else/);
    } finally { await booted.close(); }
  });
});

// ─── D196: artifact and bill edits honour the version the caller read ───────
describe("D196: updateArtifact and updateObligation refuse a stale expectedUpdatedAt", () => {
  it("updateArtifact: stale → 409 before any write; fresh → writes", async () => {
    const row = { id: "a-1", type: "note", title: "Note", content: "a", items: [], tags: [], pinned: false, metadata: {}, updated_at: "2026-09-03T10:00:00Z", created_at: "2026-09-03T09:00:00Z", linked_profiles: [] };
    const { client, calls } = chainClient((table, op) => table === "artifacts" ? { data: op === "update" ? [{ ...row, title: "New" }] : [row], error: null } : { data: [], error: null });
    const s = bareStorage({ supabase: client, bumpDataVersion: async () => undefined });
    await expect(s.updateArtifact("a-1", { title: "New", expectedUpdatedAt: "2026-09-03T09:59:00Z" })).rejects.toMatchObject({ statusCode: 409 });
    expect(calls.some((c) => c.table === "artifacts" && c.op === "update")).toBe(false);
    await s.updateArtifact("a-1", { title: "New", expectedUpdatedAt: "2026-09-03T10:00:00Z" });
    const upd = calls.find((c) => c.table === "artifacts" && c.op === "update");
    expect(upd?.payload).toMatchObject({ title: "New" });
    expect(upd?.payload).not.toHaveProperty("expectedUpdatedAt");
  });
  it("updateObligation passes the version through to the profile write", async () => {
    const seen: any[] = [];
    const s = bareStorage({
      getProfile: async () => ({ id: "b-1", type: "liability", type_key: "utility", name: "Water", fields: { monthlyAmount: 20 }, updatedAt: "2026-09-03T10:00:00Z" }),
      updateProfile: async (_id: string, patch: any) => { seen.push(patch); return {}; },
      getObligation: async () => ({ id: "b-1" }),
    });
    await s.updateObligation("b-1", { amount: 21, expectedUpdatedAt: "2026-09-03T09:59:00Z" } as any);
    expect(seen[0]).toMatchObject({ expectedUpdatedAt: "2026-09-03T09:59:00Z", fields: { monthlyAmount: 21 } });
  });
});

// ─── D197: a document read carries its version so a stale-tab edit can be refused ─
describe("D197: documents expose updatedAt like every other editable record", () => {
  it("rowToDocument carries updated_at (falling back to created_at)", () => {
    const s = bareStorage({});
    const d = s.rowToDocument({ id: "d-1", name: "Passport", type: "identity", linked_profiles: [], created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-03T10:00:00Z" });
    expect(d.updatedAt).toBe("2026-09-03T10:00:00Z");
    const d2 = s.rowToDocument({ id: "d-2", name: "Old", type: "other", linked_profiles: [], created_at: "2026-09-01T00:00:00Z" });
    expect(d2.updatedAt).toBe("2026-09-01T00:00:00Z");
  });
});

// ─── D198: a reversal row never carries a negative principal; readers apply the sign ─
import { signedPrincipal } from "../server/liability-payments";
describe("D198: reversal rows store magnitudes and readers apply the direction by type", () => {
  it("signedPrincipal: a reversal counts as money put back", () => {
    expect(signedPrincipal({ principalPortion: 75, paymentType: "standard" })).toBe(75);
    expect(signedPrincipal({ principalPortion: 50, paymentType: "reversal" })).toBe(-50);
    expect(signedPrincipal({ principalPortion: -50, paymentType: "reversal" })).toBe(-50);
  });
  it("undoing a reversal takes the money back off the balance", async () => {
    const { s, payments, profiles } = payStorage({ id: "card-2", name: "Card", type: "liability", type_key: "credit_card", fields: { currentBalance: 300, interestRate: 22, monthlyPayment: 25 } });
    const rev = await payBillOccurrence(s, "card-2", { amount: 50, paymentDate: "2026-09-03", paymentType: "reversal", source: "route" }, "UTC");
    expect(profiles.get("card-2").fields.currentBalance).toBe(350);
    expect(rev.payment.principalPortion).toBe(50);
    s.deleteLiabilityPayment = async (id: string) => { const i = payments.findIndex((p) => p.id === id); if (i < 0) return false; payments.splice(i, 1); return true; };
    const undone = await unpayBillOccurrence(s, "card-2", { paymentId: rev.payment.id, source: "route" }, "UTC");
    expect(undone.ok).toBe(true);
    expect(profiles.get("card-2").fields.currentBalance).toBe(300);
  });
});

// ─── D200: "delete all data" covers every table that carries a user_id ──────
describe("D200: the account wipe covers captures", () => {
  it("ALL_USER_TABLES lists captures ahead of profiles", () => {
    const list = (SupabaseStorage as any).ALL_USER_TABLES as string[];
    expect(list).toContain("captures");
    expect(list.indexOf("captures")).toBeLessThan(list.indexOf("profiles"));
    // Every table the app writes per user (production schema, 2026-09-03).
    for (const t of ["ai_action_log", "artifacts", "captures", "cashflow_projections", "documents", "entity_links", "events", "expenses", "finance_imports", "goals", "habit_checkins", "habits", "incomes", "journal_entries", "liability_payments", "memories", "net_worth_snapshots", "paychecks", "preferences", "profiles", "tasks", "tracker_entries", "trackers", "user_notifications"]) {
      expect(list, t).toContain(t);
    }
  });
});

// ─── D201: "delete all data" removes uploaded files, not only rows ──────────
describe("D201: the account wipe sweeps the user's folder in the documents bucket", () => {
  it("lists the folder, removes every file (and preview) under the user's prefix, and reports the count", async () => {
    const removed: string[][] = []; const listed: any[] = [];
    const { client } = chainClient((_t, op) => op === "delete" ? { data: null, error: null, count: 0 } : { data: [], error: null });
    (client as any).storage = { from: (bucket: string) => ({
      list: async (prefix: string, opts: any) => { listed.push([bucket, prefix, opts]); return { data: opts.offset === 0 ? [{ name: "doc-1.pdf" }, { name: "doc-1.pdf.prev.jpg" }, { name: "doc-2.png" }] : [], error: null }; },
      remove: async (paths: string[]) => { removed.push(paths); return { data: paths, error: null }; },
    }) };
    const s = bareStorage({ supabase: client });
    const out = await s.deleteAllUserData();
    expect(listed[0]).toEqual(["documents", s.userId, { limit: 1000, offset: 0 }]);
    expect(removed.flat()).toEqual([`${s.userId}/doc-1.pdf`, `${s.userId}/doc-1.pdf.prev.jpg`, `${s.userId}/doc-2.png`]);
    expect(out.deleted.storage_files).toBe(3);
    expect(out.errors.storage_files).toBeUndefined();
  });
  it("a bucket failure is reported loudly and does not stop the table sweep", async () => {
    let tables = 0;
    const { client } = chainClient((_t, op) => { if (op === "delete") tables++; return { data: null, error: null, count: 0 }; });
    (client as any).storage = { from: () => ({ list: async () => ({ data: null, error: { message: "bucket offline" } }), remove: async () => ({ data: null, error: null }) }) };
    const out = await bareStorage({ supabase: client }).deleteAllUserData();
    expect(out.errors.storage_files).toMatch(/bucket offline/);
    expect(tables).toBeGreaterThan(10);
  });
});

// ─── D202: a wipe that errors elsewhere still gives the account its Self back ─
describe("D202: the Self is recreated whenever the profiles table was swept", () => {
  it("one failing table (the file sweep) → 500 with the error named, profiles gone, and a Self recreated", async () => {
    const created: any[] = [];
    const booted = await boot({}, (storage) => {
      storage.deleteAllUserData = async () => ({ deleted: { profiles: 3, tasks: 2 }, errors: { storage_files: "bucket offline" } });
      storage.createProfile = async (d: any) => { created.push(d); return { id: "self-new", ...d }; };
    });
    try {
      const r = await booted.api("DELETE", "/api/data/all", { confirmation: "DELETE" });
      expect(r.status).toBe(500);
      expect(r.data?.success).toBe(false);
      expect(r.data?.errors?.storage_files).toMatch(/bucket offline/);
      expect(created.map((c) => c.type)).toEqual(["self"]);
      expect(r.data?.selfRecreated ?? true).toBe(true);
    } finally { await booted.close(); }
  });
  it("when the profiles table itself failed, no Self is created on top of the surviving one", async () => {
    const created: any[] = [];
    const booted = await boot({}, (storage) => {
      storage.deleteAllUserData = async () => ({ deleted: { tasks: 2 }, errors: { profiles: "locked" } });
      storage.createProfile = async (d: any) => { created.push(d); return { id: "self-new", ...d }; };
    });
    try {
      await booted.api("DELETE", "/api/data/all", { confirmation: "DELETE" });
      expect(created).toEqual([]);
    } finally { await booted.close(); }
  });
});

// ─── D203: a backup carries captures, and an import brings them back ────────
describe("D203: export and import cover captures", () => {
  it("GET /api/export lists the account's captures; POST /api/import recreates them with the owner remapped", async () => {
    const created: any[] = [];
    const booted = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me", fields: {}, linked_profiles: [], documents: [] }] }, (storage) => {
      storage.getCaptures = async () => [{ id: "c-1", type: "note", title: "Dentist", rawInput: "call the dentist", status: "pending", source: "manual", ownerProfileId: "self-1" }];
      storage.createCapture = async (d: any) => { created.push(d); return { id: "c-new", ...d }; };
    });
    try {
      const ex = await booted.api("GET", "/api/export");
      expect(ex.status).toBe(200);
      expect(ex.data.captures).toHaveLength(1);
      expect(ex.data.captures[0].rawInput).toBe("call the dentist");
      const im = await booted.api("POST", "/api/import", { version: 1, captures: [{ ...ex.data.captures[0], ownerProfileId: "someone-elses-self" }] });
      expect(im.status).toBe(200);
      expect(im.data?.success).toBe(true);
      expect(created).toHaveLength(1);
      expect(created[0].rawInput).toBe("call the dentist");
      expect(created[0].source).toBe("manual");
      // The foreign owner did not remap: the capture lands on this account's Self, never ownerless.
      expect(created[0].ownerProfileId).toBe("self-1");
    } finally { await booted.close(); }
  });
});

// ─── D204: a deleted or merged person's captures never end up ownerless ─────
describe("D204: captures follow their owner on delete (to the Self) and on merge (to the target, and back)", () => {
  it("deleteProfile re-homes the person's captures to the Self before the cascade runs", async () => {
    const { client, calls } = chainClient((table, op) => {
      if (table === "captures" && op === "update") return { data: [{ id: "c-1" }, { id: "c-2" }], error: null };
      return { data: [], error: null };
    });
    let rpcAt = -1;
    (client as any).rpc = async () => { rpcAt = calls.length; return { data: { profiles_deleted: 1 }, error: null }; };
    const s = bareStorage({
      supabase: client,
      getProfile: async () => ({ id: "pat-1", type: "person", name: "Pat", fields: {}, documents: [], tags: [] }),
      getProfiles: async () => [],
      getSelfProfile: async () => ({ id: "self-1", type: "self", name: "Me" }),
      cleanupEntityLinks: async () => undefined, bumpDataVersion: async () => undefined, logActivity: () => {},
    });
    await s.deleteProfile("pat-1");
    const move = calls.find((c) => c.table === "captures" && c.op === "update");
    expect(move?.payload).toEqual({ owner_profile_id: "self-1" });
    expect(move?.filters).toEqual(expect.arrayContaining([["eq", ["owner_profile_id", "pat-1"]], ["eq", ["user_id", s.userId]]]));
    expect(calls.indexOf(move!)).toBeLessThan(rpcAt);
  });
});

// ─── D205: an imported cadence spelled the human way folds onto the import enum ─
import { validateFinanceImport } from "../shared/finance-import-schema";
describe("D205: finance import folds cadence spellings before validating", () => {
  it("'fortnightly' and 'every 2 weeks' become biweekly; an unknown word still fails naming the field", () => {
    const ok = validateFinanceImport(JSON.stringify({ version: "1.0", recurring_bills: [{ unique_id: "b1", name: "Gas", amount: 45, frequency: "fortnightly", category: "Utility" }], income: [{ unique_id: "i1", source_name: "Acme", amount: 2000, frequency: "every 2 weeks" }] }));
    expect(ok.ok).toBe(true);
    expect((ok as any).data.recurring_bills[0].frequency).toBe("biweekly");
    expect((ok as any).data.income[0].frequency).toBe("biweekly");
    const bad = validateFinanceImport(JSON.stringify({ version: "1.0", income: [{ unique_id: "i1", source_name: "Acme", amount: 2000, frequency: "whenever" }] }));
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toContain("income[0].frequency");
  });
});

// ─── D206: an imported cap for a known category updates the month's existing cap ─
import { planImport, applyImport } from "../server/finance-import";
describe("D206: the importer matches caps by the budget bucket, not the raw word", () => {
  function capStore() {
    const caps = [{ id: "cap-food", category: "food", amount: 300 }];
    const updates: any[] = []; const adds: any[] = [];
    const store: any = {
      getExpenses: async () => [], getIncomes: async () => [], getObligations: async () => [], getProfiles: async () => [{ id: "self-1", type: "self", name: "Me" }],
      getBudgets: async () => caps,
      updateBudget: async (month: string, id: string, u: any) => { updates.push([month, id, u]); return true; },
      addBudget: async (month: string, category: string, amount: number, notes?: string, profileId?: string) => { adds.push([month, category, amount, profileId]); return { id: "cap-new", category, amount }; },
      createFinanceImport: async (d: any) => ({ id: "batch-1", ...d }), deleteBudget: async () => true,
    };
    return { store, updates, adds };
  }
  const parsed = validateFinanceImport(JSON.stringify({ version: "1.0", budgets: [{ unique_id: "bg1", category: "Groceries", amount: 450, month: "2031-03" }] }));
  if (!parsed.ok) throw new Error("fixture payload invalid: " + JSON.stringify(parsed));
  const payload: any = (parsed as any).data;
  it("plan: 'Groceries' beside an existing 'food' cap is an update", async () => {
    const { store } = capStore();
    const plan = await planImport(store, payload, "self-1");
    const op = plan.ops.find((o: any) => o.section === "budgets");
    expect(op?.action).toBe("update");
  });
  it("apply: the existing food cap is updated to 450; no second cap is added", async () => {
    const { store, updates, adds } = capStore();
    const plan = await planImport(store, payload, "self-1");
    await applyImport(store, payload, "self-1", plan, { month: "2031-03" });
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toBe("cap-food");
    expect(updates[0][2]).toMatchObject({ amount: 450 });
    expect(adds).toHaveLength(0);
  });
});

// ─── D207: a bill's owners include the parties on it ────────────────────────
describe("D207: a co-signed bill lists its parties among its owners", () => {
  it("getObligation adds the party ids to the parent", async () => {
    const bill = { id: "bill-1", user_id: "u", type: "liability", type_key: "utility", name: "Internet", parent_profile_id: "self-1", fields: { monthlyAmount: 60, dueDate: "2026-09-05", nextDueDate: "2026-09-05", frequency: "monthly" }, linked_profiles: [], documents: [], tags: [] };
    const { client } = chainClient((table) => {
      if (table === "profiles") return { data: [bill], error: null };
      if (table === "liability_profile_links") return { data: [{ id: "l-1", user_id: "u", liability_profile_id: "bill-1", party_profile_id: "linda-1", role: "co_signer", ownership_percentage: 50 }], error: null };
      return { data: [], error: null };
    });
    const s = bareStorage({ supabase: client, getProfile: async () => ({ id: "bill-1", type: "liability", type_key: "utility", name: "Internet", parentProfileId: "self-1", fields: bill.fields, documents: [], tags: [] }) });
    const ob = await s.getObligation("bill-1");
    expect(ob?.linkedProfiles).toEqual(["self-1", "linda-1"]);
  });
});

// ─── D208: the bell reads the same date vocabulary as the calendar ──────────
import { buildNotifications } from "../server/notification-service";
import { addDays as tzAddDays2 } from "../shared/timezone";
describe("D208: a policy's renewal_date reaches the bell like a document's expirationDate", () => {
  const tz = "America/Los_Angeles";
  const today = getUserToday(tz);
  const bell = (overrides: Record<string, any>) => buildNotifications({
    getDocuments: async () => [],
    getProfiles: async () => [],
    getTasks: async () => [],
    getObligations: async () => [],
    getHabits: async () => [],
    listReminders: async () => [],
    listUserNotifications: async () => [],
    getPreference: async () => null,
    ...overrides,
  } as any, tz);
  it("renewal in 2 days → warning; renewal 3 days past → critical; contract end in 20 days → info", async () => {
    const list = await bell({
      getProfiles: async () => [
        { id: "p-auto", type: "asset", type_key: "auto_insurance", name: "Geico", fields: { renewal_date: tzAddDays2(today, 2) } },
        { id: "p-home", type: "asset", type_key: "home_insurance", name: "Lemonade", fields: { renewal_date: tzAddDays2(today, -3) } },
        { id: "p-gym", type: "asset", type_key: "gym_membership", name: "24 Hour", fields: { contract_end_date: tzAddDays2(today, 20) } },
        { id: "p-far", type: "asset", type_key: "software", name: "Adobe", fields: { renewal_date: tzAddDays2(today, 200) } },
        { id: "p-start", type: "asset", type_key: "utility", name: "Water", fields: { start_date: tzAddDays2(today, 1) } },
      ],
    });
    const byId = Object.fromEntries(list.map((n) => [n.id, n]));
    expect(byId[`profile-exp-p-auto-renewal_date-${tzAddDays2(today, 2)}`]).toMatchObject({ severity: "warning", type: "document_expiring", entityType: "profile" });
    expect(byId[`profile-exp-p-auto-renewal_date-${tzAddDays2(today, 2)}`].message).toMatch(/renews in 2 days/);
    expect(byId[`profile-exp-p-home-renewal_date-${tzAddDays2(today, -3)}`]).toMatchObject({ severity: "critical" });
    expect(byId[`profile-exp-p-home-renewal_date-${tzAddDays2(today, -3)}`].message).toMatch(/3 days ago/);
    expect(byId[`profile-exp-p-gym-contract_end_date-${tzAddDays2(today, 20)}`]).toMatchObject({ severity: "info" });
    expect(Object.keys(byId).some((k) => k.startsWith("profile-exp-p-far-"))).toBe(false);
    expect(list.some((n) => n.entityId === "p-start")).toBe(false);
  });
  it("documents keep their ids, and a due date on a citation now counts", async () => {
    const list = await bell({
      getDocuments: async () => [
        { id: "d-pass", name: "Passport", type: "identity", extractedData: { expirationDate: tzAddDays2(today, 2) } },
        { id: "d-cite", name: "Parking ticket", type: "other", extractedData: { dueDate: tzAddDays2(today, 5) } },
        { id: "d-old", name: "Receipt", type: "other", extractedData: { purchaseDate: tzAddDays2(today, -2) } },
      ],
    });
    const ids = list.map((n) => n.id);
    expect(ids).toContain(`doc-exp-d-pass-expirationDate-${tzAddDays2(today, 2)}`);
    expect(ids).toContain(`doc-exp-d-cite-dueDate-${tzAddDays2(today, 5)}`);
    expect(ids.some((i) => i.includes("d-old"))).toBe(false);
  });
  it("a licence expiration copied from its document is one bell row, not two", async () => {
    const exp = tzAddDays2(today, 4);
    const list = await bell({
      getDocuments: async () => [{ id: "d-lic", name: "Driver License", type: "drivers_license", linkedProfiles: ["p-me"], extractedData: { expirationDate: exp } }],
      getProfiles: async () => [{ id: "p-me", type: "self", name: "Me", fields: { expirationDate: exp, _docFields: { "d-lic": { expirationDate: exp } } } }],
    });
    expect(list.filter((n) => n.type === "document_expiring")).toHaveLength(1);
  });
});

// ─── D209/D210: the insight cards read the same dates, in the user's day, in scope ─
import { vi } from "vitest";
import { generateSmartInsights } from "../server/insights-engine";
describe("D209: insight cards read the date-rules engine, in the user's day", () => {
  const empty = { profiles: [], trackers: [], tasks: [], expenses: [], habits: [], obligations: [], journal: [], documents: [], goals: [], events: [] };
  it("a policy's renewal_date and a membership's contract end raise cards; a start date does not", () => {
    const today = getUserToday(TZ);
    const insights = generateSmartInsights({ ...empty, profiles: [
      { id: "p-auto", type: "asset", type_key: "auto_insurance", name: "Geico", fields: { renewal_date: tzAddDays(today, 2) } },
      { id: "p-gym", type: "asset", type_key: "gym_membership", name: "24 Hour", fields: { contract_end_date: tzAddDays(today, -1) } },
      { id: "p-water", type: "asset", type_key: "utility", name: "Water", fields: { start_date: tzAddDays(today, 1) } },
    ] } as any, TZ);
    const titles = insights.filter((i) => i.type === "reminder").map((i) => i.title);
    expect(titles).toContain("Renews soon: Geico");
    expect(titles).toContain("Ended: 24 Hour");
    expect(titles.some((t) => t.includes("Water"))).toBe(false);
  });
  it("counts the days from the user's today, not the server clock", () => {
    vi.useFakeTimers();
    try {
      // 02:00 UTC on Sep 4 is 7 PM on Sep 3 in Los Angeles.
      vi.setSystemTime(new Date("2026-09-04T02:00:00Z"));
      const insights = generateSmartInsights({ ...empty, documents: [
        { id: "d-1", name: "Passport", type: "identity", extractedData: { expirationDate: "2026-09-03" } },
      ] } as any, TZ);
      const card = insights.find((i) => i.relatedEntityId === "d-1");
      expect(card?.severity).toBe("warning");
      expect(card?.description).toMatch(/expires today/);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("D210: /api/insights scopes profile dates like everything else", () => {
  it("under Linda's scope, Self's laptop warranty is not a card", async () => {
    const today = getUserToday(TZ);
    h = await boot({ profiles: [
      { id: "self-1", type: "self", name: "Me" },
      { id: "linda-1", type: "person", name: "Linda", parentProfileId: "self-1", fields: {} },
      { id: "laptop-1", type: "asset", type_key: "electronics", name: "Laptop", parentProfileId: "self-1", fields: { warranty_expiry: tzAddDays(today, 3) } },
    ] });
    const all = await h.api("GET", "/api/insights");
    expect(all.status).toBe(200);
    expect(all.data.some((i: any) => i.relatedEntityId === "laptop-1")).toBe(true);
    const scoped = await h.api("GET", "/api/insights?profileIds=linda-1");
    expect(scoped.status).toBe(200);
    expect(scoped.data.some((i: any) => i.relatedEntityId === "laptop-1")).toBe(false);
  });
});

// ─── D211: the document viewer's expiry badge counts calendar days in the user's zone ─
import { fieldExpiryStatus } from "../shared/date-rules";
describe("D211: fieldExpiryStatus", () => {
  it("a passport expiring tomorrow is 'soon', not 'expired', whatever the UTC clock says", () => {
    expect(fieldExpiryStatus("expirationDate", "2026-09-03", "2026-09-02")).toBe("soon");
    expect(fieldExpiryStatus("expirationDate", "2026-09-03", "2026-09-03")).toBe("soon");
    expect(fieldExpiryStatus("expirationDate", "2026-09-03", "2026-09-04")).toBe("expired");
    expect(fieldExpiryStatus("expirationDate", "2026-12-01", "2026-09-04")).toBe("valid");
  });
  it("renewals and lease ends wear the badge; purchase dates, birthdays and due dates do not", () => {
    expect(fieldExpiryStatus("renewal_date", "2026-09-10", "2026-09-03")).toBe("soon");
    expect(fieldExpiryStatus("lease_end_date", "2026-08-30", "2026-09-03")).toBe("expired");
    expect(fieldExpiryStatus("purchase_date", "2026-08-30", "2026-09-03")).toBeNull();
    expect(fieldExpiryStatus("date_of_birth", "1990-08-30", "2026-09-03")).toBeNull();
    expect(fieldExpiryStatus("dueDate", "2026-09-05", "2026-09-03")).toBeNull();
    expect(fieldExpiryStatus("expirationDate", "not a date", "2026-09-03")).toBeNull();
  });
});

// ─── D212: a goal's deadline card counts days in the user's zone ─────────────
describe("D212: goal deadline card on its last day", () => {
  it("at 7 PM Pacific on the deadline day the card still shows '0 days left'", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-04T02:00:00Z"));
      const empty = { profiles: [], trackers: [], tasks: [], expenses: [], habits: [], obligations: [], journal: [], documents: [], goals: [], events: [] };
      const insights = generateSmartInsights({ ...empty, goals: [
        { id: "g-1", title: "Read 10 books", status: "active", target: 10, current: 1, unit: "books", deadline: "2026-09-03" },
      ] } as any, TZ);
      const card = insights.find((i) => i.relatedEntityId === "g-1" && /deadline approaching/i.test(i.title));
      expect(card?.description).toMatch(/Only 0 days left/);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── D213/D214: an edit dialog writes only what the user changed ─────────────
import { changedFieldsOnly } from "../shared/field-patch";
describe("D213: changedFieldsOnly", () => {
  it("keeps only the keys whose value differs; a key missing from the form is not a deletion", () => {
    const seeded = { title: "Renew passport", description: "old note", priority: "medium", dueDate: "2026-09-08", tags: ["admin"], time: "09:00" };
    const next = { title: "Renew passport", description: "new note", priority: "medium", dueDate: "2026-09-08", tags: ["admin"] };
    expect(changedFieldsOnly(seeded, next)).toEqual({ description: "new note" });
    expect(changedFieldsOnly(seeded, { ...next, description: "", tags: ["admin", "travel"] })).toEqual({ description: "", tags: ["admin", "travel"] });
    expect(changedFieldsOnly(seeded, { ...seeded })).toEqual({});
    expect(changedFieldsOnly(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

// ─── D215: this month's income leaves out a job that starts next month ───────
import { sumMonthlyIncome, sumMonthlyIncomeNow } from "../shared/obligation-windows";
import { getUserCurrentMonth as curMonth } from "../shared/timezone";
describe("D215: sumMonthlyIncomeNow", () => {
  it("counts undated and already-started incomes, not one first dated next month", () => {
    const ym = curMonth(TZ);
    const [y, m] = ym.split("-").map(Number);
    const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-05`;
    const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}-05`;
    const incomes = [
      { amount: 4000, frequency: "monthly", date: prev },
      { amount: 1000, frequency: "monthly" },
      { amount: 5000, frequency: "monthly", date: next },
    ];
    expect(sumMonthlyIncome(incomes)).toBe(10000);
    expect(sumMonthlyIncomeNow(incomes, TZ)).toBe(5000);
  });
});

// ─── D216: the AI's monthly income figure is the tile's figure ───────────────
describe("D216: get_summary incomes.monthlyRecurring", () => {
  it("counts every started or undated income and leaves out a job first dated next month", async () => {
    const s = new MemStorage();
    (s as any)._timezone = TZ;
    const ym = curMonth(TZ);
    const [y, m] = ym.split("-").map(Number);
    const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-05`;
    const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, "0")}-05`;
    for (let i = 0; i < 16; i++) await s.createIncome({ description: `gig ${i}`, amount: 100, frequency: "monthly", category: "other", date: prev } as any);
    await s.createIncome({ description: "stipend", amount: 1000, frequency: "monthly", category: "other" } as any);
    await s.createIncome({ description: "new job", amount: 5000, frequency: "monthly", category: "salary", date: next } as any);
    const run = <T,>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => requestStorageContext.run(s, () => fn().then(resolve, reject)));
    const summary = await run(() => executeTool("get_summary", { entity_type: "incomes" }, "u-1"));
    expect(summary.incomes.count).toBe(18);
    expect(Math.round(summary.incomes.monthlyRecurring)).toBe(2600);
  });
});

// ─── D217: the AI's financial snapshot is the dashboard's ────────────────────
import { financialSnapshot } from "../server/ai-financial-snapshot";
import { computeNetWorth as nwCompute } from "../shared/net-worth";
describe("D217: financialSnapshot", () => {
  const self = { id: "self", type: "self", name: "Me", fields: {} };
  const linda = { id: "linda", type: "person", name: "Linda", parentProfileId: "self", fields: {} };
  const car = { id: "car", type: "asset", type_key: "vehicle", name: "Civic", parentProfileId: "linda", fields: { value: 12000 } };
  const house = { id: "house", type: "asset", type_key: "primary_residence", name: "House", parentProfileId: "self", fields: { currentValue: 400000 } };
  const card = { id: "card", type: "liability", type_key: "credit_card", name: "Visa", parentProfileId: "self", fields: { currentBalance: 2500 } };
  const profiles = [self, linda, car, house, card];
  // As the API writes them: every asset/liability gets its parent's owner
  // link on creation (s160), so the car is Linda's outright.
  const ownership = { assetLinks: [
    { assetProfileId: "car", partyProfileId: "linda", ownershipPercentage: 100, role: "owner" },
    { assetProfileId: "house", partyProfileId: "self", ownershipPercentage: 50, role: "owner" },
    { assetProfileId: "house", partyProfileId: "linda", ownershipPercentage: 50, role: "co_owner" },
  ], liabilityLinks: [{ liabilityProfileId: "card", partyProfileId: "self", ownershipPercentage: 100, role: "owner" }], selfProfileId: "self" };
  it("matches computeNetWorth for everyone, nested car and co-owned house included", () => {
    const tile = nwCompute(profiles, { mode: "everyone", selectedIds: [], ownership });
    const s = financialSnapshot({ allProfiles: profiles, obligations: [], expenses: [], ownership, timezone: TZ });
    expect(s.assets).toBe(tile.assets);
    expect(s.liabilities).toBe(tile.liabilities);
    expect(s.netWorth).toBe(tile.netWorth);
    expect(s.assets).toBe(412000);
    expect(s.liabilities).toBe(2500);
  });
  it("scopes to Linda like the tile does and counts this month's spend in the user's zone", () => {
    const tile = nwCompute(profiles, { mode: "selected", selectedIds: ["linda"], ownership });
    const ym = curMonth(TZ);
    const s = financialSnapshot({ allProfiles: profiles, selectedIds: ["linda"], obligations: [{ amount: 120, frequency: "yearly", status: "active" }], expenses: [{ amount: 40, date: `${ym}-02` }, { amount: 99, date: "2020-01-02" }], ownership, timezone: TZ });
    expect(s.netWorth).toBe(tile.netWorth);
    expect(s.assets).toBe(212000);
    expect(s.monthlySubs).toBe(10);
    expect(s.thisMonthSpend).toBe(40);
  });
});

// ─── D218: the AI engine has no Los Angeles clock of its own ─────────────────
describe("D218: no hard-coded Los Angeles clock in the AI engine", () => {
  it("every 'today' and every imported event time reads the user's timezone", () => {
    const src = readFileSync(new URL("../server/ai-engine.ts", import.meta.url), "utf8");
    const literal = src.split("\n").filter((l) => /timeZone:\s*['"]America\/Los_Angeles['"]|_timezone \|\| ['"]America\/Los_Angeles['"]/.test(l));
    expect(literal).toEqual([]);
    // The routes file too: an expense created from a document with no date
    // was stamped with the Los Angeles day.
    const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    expect(routes.split("\n").filter((l) => /timeZone:\s*['"]America\/Los_Angeles['"]/.test(l))).toEqual([]);
  });
});

// ─── D219: the crons run each user's own day ─────────────────────────────────
import { rememberUserTimezone, userTimezoneFor, USER_TIMEZONE_PREF } from "../server/routes";
import { DEFAULT_TIMEZONE as DEFAULT_TZ } from "../shared/timezone";
describe("D219: remembered timezone", () => {
  it("rememberUserTimezone writes once per zone per hour, and again when the zone changes", async () => {
    const writes: Array<[string, string]> = [];
    const store: any = { setPreference: async (k: string, v: string) => { writes.push([k, v]); } };
    await rememberUserTimezone(store, "u-tz-1", "Asia/Tokyo");
    await rememberUserTimezone(store, "u-tz-1", "Asia/Tokyo");
    await rememberUserTimezone(store, "u-tz-1", "Europe/Paris");
    expect(writes).toEqual([[USER_TIMEZONE_PREF, "Asia/Tokyo"], [USER_TIMEZONE_PREF, "Europe/Paris"]]);
  });
  it("userTimezoneFor reads the preference and falls back to the default", async () => {
    expect(await userTimezoneFor({ getPreference: async () => "Asia/Tokyo" } as any)).toBe("Asia/Tokyo");
    expect(await userTimezoneFor({ getPreference: async () => null } as any)).toBe(DEFAULT_TZ);
    expect(await userTimezoneFor({ getPreference: async () => { throw new Error("no table"); } } as any)).toBe(DEFAULT_TZ);
  });
  it("an authenticated request's X-Timezone header is remembered as the preference", async () => {
    const writes: Array<[string, string]> = [];
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.setPreference = async (k: string, v: string) => { writes.push([k, v]); };
    });
    const r = await h.api("GET", "/api/tasks", undefined, { "X-Timezone": "Asia/Tokyo" });
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 20));
    expect(writes).toContainEqual([USER_TIMEZONE_PREF, "Asia/Tokyo"]);
  });
});

// ─── D220: the journal create answers with the owner it stored ───────────────
import { upsertJournalEntry } from "../server/content-service";
describe("D220: journal create response carries the linked profile", () => {
  it("upsertJournalEntry returns the row as linked", async () => {
    const s = new MemStorage();
    const { entry, appended } = await upsertJournalEntry(s, { content: "Linda had a good day", mood: "good", entryDate: "2025-01-15", profileId: "linda-1" } as any);
    expect(appended).toBe(false);
    expect(entry.linkedProfiles).toEqual(["linda-1"]);
    const stored = (await s.getJournalEntries()).find((e) => e.id === entry.id);
    expect(stored?.linkedProfiles).toEqual(["linda-1"]);
  });
  it("POST /api/journal under an active profile answers with that owner", async () => {
    const mem = new MemStorage();
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }, { id: "linda-1", type: "person", name: "Linda" }] }, (storage) => {
      storage.getJournalEntries = () => mem.getJournalEntries();
      storage.createJournalEntry = (e: any) => mem.createJournalEntry(e);
      storage.updateJournalEntry = (id: string, p: any) => mem.updateJournalEntry(id, p);
      storage.linkProfileTo = async () => undefined;
    });
    const r = await h.api("POST", "/api/journal", { content: "Linda had a good day", mood: "good", date: "2025-01-16" }, { "x-active-profile-ids": "linda-1" });
    expect(r.status).toBeLessThan(300);
    expect(r.data.linkedProfiles).toEqual(["linda-1"]);
  });
});

// ─── D221: a rescheduled occurrence is due on the day it was moved to ────────
import { effectiveDueDate, readEffectiveDueDate, resolveOccurrenceKey } from "../shared/liability-recurrence";
describe("D221: rescheduled occurrence", () => {
  const fields = { monthlyAmount: 50, dueDate: "2026-09-05", nextDueDate: "2026-09-05", frequency: "monthly", occurrences: { "2026-09-05": { movedTo: "2026-09-12" } } };
  it("the shared readers apply movedTo and resolve the moved day back to its anchor", () => {
    expect(effectiveDueDate(fields, "2026-09-05")).toBe("2026-09-12");
    expect(effectiveDueDate(fields, "2026-10-05")).toBe("2026-10-05");
    expect(readEffectiveDueDate(fields)).toBe("2026-09-12");
    expect(resolveOccurrenceKey(fields, "2026-09-12")).toBe("2026-09-05");
    expect(resolveOccurrenceKey(fields, "2026-09-05")).toBe("2026-09-05");
    expect(resolveOccurrenceKey({}, "2026-09-12")).toBe("2026-09-12");
  });
  it("the bills list says the bill is next due on the moved day", async () => {
    const bill = { id: "bill-1", user_id: "u", type: "liability", type_key: "utility", name: "Gas", parent_profile_id: "self-1", fields, linked_profiles: [], documents: [], tags: [] };
    const { client } = chainClient((table) => (table === "profiles" ? { data: [bill], error: null } : { data: [], error: null }));
    const s = bareStorage({ supabase: client, getProfile: async () => ({ id: "bill-1", type: "liability", type_key: "utility", name: "Gas", parentProfileId: "self-1", fields, documents: [], tags: [] }) });
    const ob = await s.getObligation("bill-1");
    expect(ob?.nextDueDate).toBe("2026-09-12");
  });
  it("paying the moved day settles the occurrence under its anchor and advances the bill", async () => {
    const { s, profiles } = payStorage({ id: "bill-1", type: "liability", type_key: "utility", name: "Gas", fields: { ...fields, occurrences: { "2026-09-05": { movedTo: "2026-09-12" } } } });
    const r = await payBillOccurrence(s, "bill-1", { occurrenceDate: "2026-09-12", paymentDate: "2026-09-12", amount: 50, source: "occurrence_route" } as any, TZ);
    expect(r.ok).toBe(true);
    const after = profiles.get("bill-1")!.fields;
    expect(after.occurrences["2026-09-05"].status).toBe("paid");
    expect(String(after.nextDueDate ?? after.dueDate).slice(0, 10)).toBe("2026-10-05");
  });
});

// ─── D221 (route): rescheduling closes the old day's reminder right away ─────
describe("D221: POST /obligation-occurrences/:occ/reschedule closes the stale reminder", () => {
  it("marks the 'Bill due' task for the old day done", async () => {
    const updates: Array<[string, any]> = [];
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }, { id: "bill-1", type: "liability", type_key: "utility", name: "Gas", parentProfileId: "self-1", fields: { monthlyAmount: 50, dueDate: "2026-09-05", frequency: "monthly" } }] }, (storage) => {
      storage.rescheduleOccurrence = async () => ({ occurrences: [] });
      storage.getTasks = async () => [
        { id: "t-old", title: "Bill due: Gas", status: "todo", dueDate: "2026-09-05", linkedProfiles: ["bill-1"] },
        { id: "t-other", title: "Bill due: Gas", status: "todo", dueDate: "2026-10-05", linkedProfiles: ["bill-1"] },
      ];
      storage.updateTask = async (id: string, patch: any) => { updates.push([id, patch]); return { id, ...patch }; };
    });
    const r = await h.api("POST", "/api/obligation-occurrences/bill-1:2026-09-05/reschedule", { newDueAt: "2026-09-12" });
    expect(r.status).toBe(200);
    expect(updates.map(([id, p]) => `${id}:${p.status}`)).toEqual(["t-old:done"]);
    // The other entry point (the liability page's move) goes through the same helper.
    updates.length = 0;
    const r2 = await h.api("PATCH", "/api/liabilities/bill-1/occurrences/2026-09-05", { movedTo: "2026-09-12" });
    expect(r2.status).toBe(200);
    expect(updates.map(([id, p]) => `${id}:${p.status}`)).toEqual(["t-old:done"]);
  });
});

// ─── D221 (timeline): a moved occurrence answers only for the day it falls on ─
describe("D221: calendar timeline and a rescheduled occurrence", () => {
  const fields = { monthlyAmount: 50, dueDate: "2026-09-05", nextDueDate: "2026-09-05", frequency: "monthly", occurrences: { "2026-09-05": { movedTo: "2026-09-12" } } };
  const bill = { id: "bill-1", user_id: "u", type: "liability", type_key: "utility", name: "Gas", parent_profile_id: "self-1", fields, linked_profiles: [], documents: [], tags: [] };
  const self = { id: "self-1", user_id: "u", type: "self", name: "Me", fields: {}, linked_profiles: [], documents: [], tags: [] };
  const make = () => {
    const { client } = chainClient((table) => (table === "profiles" ? { data: [self, bill], error: null } : { data: [], error: null }));
    const toProfile = (r: any) => ({ id: r.id, type: r.type, type_key: r.type_key, name: r.name, parentProfileId: r.parent_profile_id, fields: r.fields, linkedProfiles: r.linked_profiles, documents: [], tags: [] });
    return bareStorage({ supabase: client, _timezone: TZ, getProfiles: async () => [self, bill].map(toProfile), getProfile: async (id: string) => [self, bill].filter((x) => x.id === id).map(toProfile)[0] });
  };
  it("the old day has no bill item; the moved day has it", async () => {
    const s = make();
    const old = (await s.getCalendarTimeline("2026-09-05", "2026-09-05")).filter((i: any) => i.type === "obligation" && i.sourceId === "bill-1");
    const moved = (await s.getCalendarTimeline("2026-09-12", "2026-09-12")).filter((i: any) => i.type === "obligation" && i.sourceId === "bill-1");
    expect(old).toEqual([]);
    expect(moved.map((i: any) => i.date)).toEqual(["2026-09-12"]);
  });
});

// ─── D222: a paused bill is not due anywhere ─────────────────────────────────
import { isPausedBillFields } from "../shared/liability-recurrence";
describe("D222: paused bill", () => {
  it("isPausedBillFields reads the pause flag and the paused/cancelled status", () => {
    expect(isPausedBillFields({ paused: true })).toBe(true);
    expect(isPausedBillFields({ status: "paused" })).toBe(true);
    expect(isPausedBillFields({ status: "cancelled" })).toBe(true);
    expect(isPausedBillFields({ status: "upcoming", paused: false })).toBe(false);
    expect(isPausedBillFields(undefined)).toBe(false);
  });
  it("the bell raises no notice for a paused or cancelled bill", async () => {
    const today = getUserToday(TZ);
    const list = await buildNotifications({
      getDocuments: async () => [], getProfiles: async () => [], getTasks: async () => [], getHabits: async () => [],
      getObligations: async () => [
        { id: "ob-paused", name: "Gym", amount: 30, frequency: "monthly", status: "paused", nextDueDate: tzAddDays(today, 2) },
        { id: "ob-cancelled", name: "Old cable", amount: 60, frequency: "monthly", status: "cancelled", nextDueDate: tzAddDays(today, -3) },
        { id: "ob-live", name: "Water", amount: 40, frequency: "monthly", status: "active", nextDueDate: tzAddDays(today, 2) },
      ],
      listReminders: async () => [], listUserNotifications: async () => [], getPreference: async () => null,
    } as any, TZ);
    const bills = list.filter((n) => n.type === "bill_due").map((n) => n.entityId);
    expect(bills).toEqual(["ob-live"]);
  });
});

// ─── D223: a paid bill's expense belongs to everyone on the bill ─────────────
describe("D223: the logged expense carries the bill's parties", () => {
  it("parent and co-signer both own the expense", async () => {
    const { s } = payStorage({ id: "bill-1", type: "liability", type_key: "utility", name: "Rent", parentProfileId: "self-1", fields: { monthlyAmount: 1000, dueDate: "2026-09-04", nextDueDate: "2026-09-04", frequency: "monthly" } });
    const created: any[] = [];
    s.createExpense = async (e: any) => { created.push(e); return { id: "exp-1", ...e }; };
    s.getLiabilityProfileLinks = async () => [{ liabilityProfileId: "bill-1", partyProfileId: "linda-1", role: "co_signer", ownershipPercentage: 50 }];
    const r = await payBillOccurrence(s, "bill-1", { occurrenceDate: "2026-09-04", paymentDate: "2026-09-03", source: "route" } as any, TZ);
    expect(r.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].linkedProfiles).toEqual(["self-1", "linda-1"]);
  });
});

// ─── D224: removing a co-owner's link hands their share to the survivors ─────
import { scaleSharesTo100 } from "../shared/ownership-model";
describe("D224: scaleSharesTo100 and link removal", () => {
  it("scales survivors pro rata to exactly 100 and leaves complete or empty sets alone", () => {
    expect(scaleSharesTo100([{ partyProfileId: "self", ownershipPercentage: 40 }, { partyProfileId: "bob", ownershipPercentage: 30 }]))
      .toEqual([{ partyProfileId: "self", ownershipPercentage: 57.14 }, { partyProfileId: "bob", ownershipPercentage: 42.86 }]);
    expect(scaleSharesTo100([{ partyProfileId: "self", ownershipPercentage: 40 }])).toEqual([{ partyProfileId: "self", ownershipPercentage: 100 }]);
    expect(scaleSharesTo100([{ partyProfileId: "self", ownershipPercentage: 100 }])).toBeNull();
    expect(scaleSharesTo100([])).toBeNull();
    expect(scaleSharesTo100([{ partyProfileId: "x", ownershipPercentage: 0 }])).toBeNull();
  });
  it("deleteAssetPartyLink rewrites the survivors' shares", async () => {
    const link = { id: "l-linda", user_id: "u", asset_profile_id: "boat-1", party_profile_id: "linda-1", ownership_percentage: 30, role: "co_owner" };
    const { client, calls } = chainClient((table, op) => (table === "asset_party_links" && op === "select" ? { data: link, error: null } : { data: null, error: null }));
    const written: any[] = [];
    const s = bareStorage({
      supabase: client,
      recordOwnershipHistory: async () => undefined,
      getAssetPartyLinks: async () => [{ id: "l-self", assetProfileId: "boat-1", partyProfileId: "self-1", ownershipPercentage: 40 }, { id: "l-bob", assetProfileId: "boat-1", partyProfileId: "bob-1", ownershipPercentage: 30 }],
      setAssetOwners: async (id: string, owners: any[]) => { written.push([id, owners]); return owners; },
    });
    expect(await s.deleteAssetPartyLink("l-linda")).toBe(true);
    expect(calls.some((c: any) => c.table === "asset_party_links" && c.op === "delete")).toBe(true);
    expect(written).toEqual([["boat-1", [{ partyProfileId: "self-1", ownershipPercentage: 57.14 }, { partyProfileId: "bob-1", ownershipPercentage: 42.86 }]]]);
  });
});

// ─── D225: an off-schedule habit check-in is kept, not silently dropped ──────
describe("D225: off-schedule check-in", () => {
  it("a weekly habit (Mondays by default) checked in on a Friday keeps the check-in, flagged not_scheduled, streak untouched", async () => {
    const s = new MemStorage();
    (s as any)._timezone = TZ;
    const h = await s.createHabit({ name: "Run", frequency: "weekly", targetPerDay: 1 } as any);
    const friday = "2026-08-28"; // a Friday, in the past
    const r = await completeHabitOccurrence(s, { habitId: h.id, date: friday, source: "habit_ui", timezone: TZ, ensureTracker: false } as any);
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("not_scheduled");
    expect(r.recorded).toBe(1);
    const fresh = await s.getHabit(h.id);
    expect((fresh?.checkins || []).map((c: any) => c.date)).toEqual([friday]);
    expect(fresh?.currentStreak || 0).toBe(0);
  });
});

// ─── D226: a tracker-logged entry that completed a habit un-completes it when removed ─
import { autoCheckinLinkedHabits, HABIT_MIRROR_KEY } from "../server/habit-completion";
import { removeTrackerEntry } from "../server/tracker-entries";
describe("D226: tracker entry ↔ habit pairing in both directions", () => {
  it("logging on the linked tracker completes the habit and pairs the entry; removing the entry un-completes it", async () => {
    const s = new MemStorage();
    (s as any)._timezone = TZ;
    const today = getUserToday(TZ);
    const tracker = await s.createTracker({ name: "Meditation", category: "wellness", unit: "min", fields: [{ name: "minutes", type: "number" }] } as any);
    const habit = await s.createHabit({ name: "Meditate", frequency: "daily", targetPerDay: 1, linkedTrackerId: tracker.id } as any);
    const entry = await s.logEntry({ trackerId: tracker.id, values: { minutes: 10 }, timestamp: new Date().toISOString() } as any);
    let h = await s.getHabit(habit.id);
    expect((h?.checkins || []).map((c: any) => c.date)).toEqual([today]);
    const stored = await s.getTrackerEntry(entry!.id);
    expect((stored?.values as any)?.[HABIT_MIRROR_KEY]).toBe(habit.id);
    const removed = await removeTrackerEntry(s, { trackerId: tracker.id, entryId: entry!.id }, TZ);
    expect(removed.ok).toBe(true);
    expect(removed.habitId).toBe(habit.id);
    h = await s.getHabit(habit.id);
    expect(h?.checkins || []).toEqual([]);
  });
});

// ─── D227: a tracker two habits share pairs one entry with both ──────────────
import { mirrorHabitIds, HABIT_MIRROR_IDS_KEY, uncompleteHabitOccurrence } from "../server/habit-completion";
describe("D227: shared tracker, two habits", () => {
  it("one entry completes both; removing it un-completes both; un-completing one habit keeps the shared entry", async () => {
    const s = new MemStorage();
    (s as any)._timezone = TZ;
    const today = getUserToday(TZ);
    const tracker = await s.createTracker({ name: "Run", category: "fitness", unit: "km", fields: [{ name: "km", type: "number" }] } as any);
    const a = await s.createHabit({ name: "Run daily", frequency: "daily", targetPerDay: 1, linkedTrackerId: tracker.id } as any);
    const b = await s.createHabit({ name: "Move daily", frequency: "daily", targetPerDay: 1, linkedTrackerId: tracker.id } as any);
    const e1 = await s.logEntry({ trackerId: tracker.id, values: { km: 5 }, timestamp: new Date().toISOString() } as any);
    expect((await s.getHabit(a.id))?.checkins?.map((c: any) => c.date)).toEqual([today]);
    expect((await s.getHabit(b.id))?.checkins?.map((c: any) => c.date)).toEqual([today]);
    expect(mirrorHabitIds((await s.getTrackerEntry(e1!.id))?.values).sort()).toEqual([a.id, b.id].sort());
    // Un-complete A from the habit side: the shared entry stays, paired with B only.
    const un = await uncompleteHabitOccurrence(s, { habitId: a.id, date: today, source: "habit_ui", timezone: TZ } as any);
    expect(un.ok).toBe(true);
    expect(await s.getTrackerEntry(e1!.id)).toBeTruthy();
    expect(mirrorHabitIds((await s.getTrackerEntry(e1!.id))?.values)).toEqual([b.id]);
    expect((await s.getHabit(b.id))?.checkins?.length).toBe(1);
    // Now remove the entry: B is un-completed too.
    const removed = await removeTrackerEntry(s, { trackerId: tracker.id, entryId: e1!.id }, TZ);
    expect(removed.ok).toBe(true);
    expect((await s.getHabit(b.id))?.checkins || []).toEqual([]);
    expect(HABIT_MIRROR_IDS_KEY).toBe("_habitIds");
  });
});

// ─── D228: deleting a habit takes its mirror entries off the user's own tracker ─
describe("D228: habit deletion and the user's own tracker", () => {
  it("removes the habit's mirror entries, keeps the user's log, and unpairs a shared entry", async () => {
    const s = new MemStorage();
    (s as any)._timezone = TZ;
    const tracker = await s.createTracker({ name: "Runs", category: "fitness", unit: "km", fields: [{ name: "km", type: "number" }] } as any);
    const own = await s.logEntry({ trackerId: tracker.id, values: { km: 4 }, timestamp: new Date(Date.now() - 3 * 86400000).toISOString() } as any);
    const a = await s.createHabit({ name: "Run", frequency: "daily", targetPerDay: 1, linkedTrackerId: tracker.id } as any);
    const b = await s.createHabit({ name: "Move", frequency: "daily", targetPerDay: 1, linkedTrackerId: tracker.id } as any);
    await completeHabitOccurrence(s, { habitId: a.id, source: "habit_ui", timezone: TZ } as any);          // A's own mirror
    const shared = await s.logEntry({ trackerId: tracker.id, values: { km: 2 }, timestamp: new Date().toISOString() } as any); // paired with A and B
    expect(await s.deleteHabit(a.id)).toBe(true);
    const entries = ((await s.getTracker(tracker.id))?.entries || []) as any[];
    expect(entries.some((e) => e.id === own!.id)).toBe(true);
    expect(entries.some((e) => e.id === shared!.id)).toBe(true);
    expect(entries.some((e) => mirrorHabitIds(e.values).includes(a.id))).toBe(false);
    expect(mirrorHabitIds(entries.find((e) => e.id === shared!.id)?.values)).toEqual([b.id]);
    expect(entries).toHaveLength(2);
  });
});

// ─── D229: a backup restores habit↔tracker links, entry pairings and co-signer rows ─
describe("D229: POST /api/import keeps the links a backup carries", () => {
  it("remaps the habit's tracker, rewrites the entry pairing to the new habit ids, and keeps a co-signer row", async () => {
    const created: Record<string, any[]> = { trackers: [], habits: [], entries: [], entryUpdates: [], liabLinks: [], owners: [] };
    let seq = 0; const nid = (p: string) => `${p}-${++seq}`;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.getProfiles = async () => [{ id: "self-1", type: "self", name: "Me", fields: {} }];
      storage.getSelfProfile = async () => ({ id: "self-1", type: "self", name: "Me", fields: {} });
      storage.createProfile = async (p: any) => ({ id: nid("p"), ...p });
      storage.createTracker = async (t: any) => { const row = { id: nid("tr"), ...t, entries: [] }; created.trackers.push(row); return row; };
      storage.logEntry = async (e: any) => { const row = { id: nid("en"), ...e }; created.entries.push(row); return row; };
      storage.updateTrackerEntry = async (trackerId: string, entryId: string, patch: any) => { created.entryUpdates.push([trackerId, entryId, patch]); return { id: entryId, ...patch }; };
      storage.createHabit = async (hb: any) => { const row = { id: nid("hb"), ...hb, checkins: [] }; created.habits.push(row); return row; };
      storage.checkinHabit = async () => ({ id: nid("ck") });
      storage.setLiabilityOwners = async (id: string, owners: any[]) => { created.owners.push([id, owners]); return owners; };
      storage.createLiabilityProfileLink = async (l: any) => { created.liabLinks.push(l); return { id: nid("ll"), ...l }; };
    });
    const payload = {
      version: "2",
      profiles: [
        { id: "old-self", type: "self", name: "Me", fields: {} },
        { id: "old-linda", type: "person", name: "Linda", parentProfileId: "old-self", fields: {} },
        { id: "old-bill", type: "liability", type_key: "utility", name: "Gas", parentProfileId: "old-self", fields: { monthlyAmount: 40 } },
      ],
      liabilityProfileLinks: [
        { liabilityProfileId: "old-bill", partyProfileId: "old-self", role: "owner", ownershipPercentage: 100 },
        { liabilityProfileId: "old-bill", partyProfileId: "old-linda", role: "co_signer", ownershipPercentage: 50 },
      ],
      trackers: [{ id: "old-tr", name: "Run", category: "fitness", unit: "km", fields: [], entries: [{ values: { km: 3, _habitId: "old-a", _habitIds: ["old-a", "old-b"] }, timestamp: "2026-09-01T10:00:00Z" }] }],
      habits: [
        { id: "old-a", name: "Run daily", frequency: "daily", targetPerDay: 1, linkedTrackerId: "old-tr", checkins: [] },
        { id: "old-b", name: "Move daily", frequency: "daily", targetPerDay: 1, linkedTrackerId: "old-tr", checkins: [] },
      ],
    };
    const r = await h.api("POST", "/api/import", payload);
    expect(r.status).toBe(200);
    const tr = created.trackers[0];
    expect(created.habits.map((x) => x.linkedTrackerId)).toEqual([tr.id, tr.id]);
    expect(mirrorHabitIds(created.entries[0].values)).toEqual([]);
    const [a, b] = created.habits;
    expect(created.entryUpdates).toEqual([[tr.id, created.entries[0].id, { values: { _habitId: a.id, _habitIds: [a.id, b.id] } }]]);
    expect(created.owners).toHaveLength(1);
    expect(created.owners[0][1]).toEqual([{ partyProfileId: expect.any(String), ownershipPercentage: 100 }]);
    expect(created.liabLinks).toHaveLength(1);
    expect(created.liabLinks[0]).toMatchObject({ role: "co_signer", ownershipPercentage: 50 });
  });
});

// ─── D230: a document's edited fields move the copies it wrote onto profiles ─
//
// confirm-extraction copies a licence's expiration onto the person and records
// the write in `_docFields`. Editing the document afterwards (viewer field
// editor, the calendar's edit/clear of a document date, a re-upload) changed
// the document alone: the person's copy kept the old date, so the calendar
// showed two expirations for one licence, the bell warned about the wrong day,
// and a date cleared from the calendar came back from the copy.
import { propagateDocumentFieldChange } from "../server/document-provenance";

describe("D230: editing a document's fields moves the copies it wrote onto profiles", () => {
  const silent = { info: () => {}, warn: () => {}, error: () => {} };
  async function person(fields: Record<string, any>) {
    const s = new MemStorage();
    const p = await s.createProfile({ name: "Kim", type: "person", fields } as any);
    return { s, id: p.id };
  }
  it("a corrected date moves the copy and its provenance record", async () => {
    const { s, id } = await person({ expirationDate: "2026-09-08", city: "Austin", _docFields: { "doc-1": { expirationDate: "2026-09-08" } } });
    const out = await propagateDocumentFieldChange(s, "doc-1", { expirationDate: "2026-09-08" }, { expirationDate: "2026-09-11" }, silent);
    const f = (await s.getProfile(id))!.fields as any;
    expect(f.expirationDate).toBe("2026-09-11");
    expect(f._docFields["doc-1"]).toEqual({ expirationDate: "2026-09-11" });
    expect(f.city).toBe("Austin");
    expect(out.affectedProfileIds).toEqual([id]);
  });
  it("a date cleared from the document is taken back from the copy, like the delete cascade", async () => {
    const { s, id } = await person({ expirationDate: "2026-09-08", _docFields: { "doc-1": { expirationDate: "2026-09-08" } } });
    await propagateDocumentFieldChange(s, "doc-1", { expirationDate: "2026-09-08" }, {}, silent);
    const f = (await s.getProfile(id))!.fields as any;
    expect(f.expirationDate).toBeUndefined();
    expect(f._docFields).toBeUndefined();
  });
  it("a copy the user edited since is theirs and stays; a value the document never carried is left alone", async () => {
    const { s, id } = await person({ expirationDate: "2027-01-01", policyNumber: "P-1", _docFields: { "doc-1": { expirationDate: "2026-09-08", policyNumber: "P-1" } } });
    const out = await propagateDocumentFieldChange(s, "doc-1", { expirationDate: "2026-09-08" }, { expirationDate: "2026-09-11", policyNumber: "P-2" }, silent);
    const f = (await s.getProfile(id))!.fields as any;
    expect(f.expirationDate).toBe("2027-01-01");
    expect(f.policyNumber).toBe("P-1");
    expect(out.affectedProfileIds).toEqual([]);
  });
  it("matches by field identity inside nested groups and only the profiles this document wrote", async () => {
    const s = new MemStorage();
    const kim = await s.createProfile({ name: "Kim", type: "person", fields: { identity: { expirationDate: "2026-09-08" }, _docFields: { "doc-1": { expirationDate: "2026-09-08" } } } } as any);
    const lee = await s.createProfile({ name: "Lee", type: "person", fields: { expirationDate: "2026-09-08" } } as any);
    await propagateDocumentFieldChange(s, "doc-1", { expirationDate: "2026-09-08" }, { expirationDate: "2026-09-11" }, silent);
    expect(((await s.getProfile(kim.id))!.fields as any).identity.expirationDate).toBe("2026-09-11");
    expect(((await s.getProfile(lee.id))!.fields as any).expirationDate).toBe("2026-09-08");
  });
  it("route: PATCH /api/documents/:id with new extractedData moves the copy; a rename does not touch profiles", async () => {
    const profileWrites: any[] = [];
    h = await boot({
      profiles: [{ id: "kim-1", type: "person", name: "Kim", fields: { expirationDate: "2026-09-08", _docFields: { "doc-1": { expirationDate: "2026-09-08" } } } }],
      documents: [{ id: "doc-1", name: "Licence", type: "identity", extractedData: { expirationDate: "2026-09-08" }, linkedProfiles: ["kim-1"], tags: [] }],
    }, (storage, db) => {
      const base = storage.updateProfile;
      storage.updateProfile = async (pid: string, patch: any) => { profileWrites.push(patch); return base(pid, patch); };
    });
    const renamed = await h.api("PATCH", "/api/documents/doc-1", { name: "Kim's licence" });
    expect(renamed.status).toBe(200);
    expect(profileWrites).toEqual([]);
    const edited = await h.api("PATCH", "/api/documents/doc-1", { extractedData: { expirationDate: "2026-09-11" } });
    expect(edited.status).toBe(200);
    const kim = (await h.api("GET", "/api/profiles/kim-1")).data;
    expect(kim.fields.expirationDate).toBe("2026-09-11");
    expect(kim.fields._docFields["doc-1"].expirationDate).toBe("2026-09-11");
  });
});

// ─── D231: the relationships graph carried edges to nodes it never returned ─
describe("D231: /api/relationships/graph returns only edges whose both ends are nodes", () => {
  const links = {
    assetParty: [{ id: "ap-1", assetProfileId: "car-1", partyProfileId: "self-1", role: "owner", ownershipPercentage: 100 }],
    liabParty: [{ id: "lp-1", liabilityProfileId: "loan-1", partyProfileId: "self-1", role: "owner", ownershipPercentage: 100 }],
  };
  function wire(storage: any) {
    storage.getLiabilityAssetLinks = async () => [];
    storage.getLiabilityAssetLinksForAsset = async () => [];
    storage.getAssetPartyLinks = async (pid: string) => links.assetParty.filter((l) => l.assetProfileId === pid);
    storage.getAssetPartyLinksForParty = async (pid: string) => links.assetParty.filter((l) => l.partyProfileId === pid);
    storage.getLiabilityProfileLinks = async (pid: string) => links.liabParty.filter((l) => l.liabilityProfileId === pid);
    storage.getLiabilityProfileLinksForParty = async (pid: string) => links.liabParty.filter((l) => l.partyProfileId === pid);
  }
  const seed = { profiles: [
    { id: "self-1", type: "self", name: "Me", fields: {} },
    { id: "car-1", type: "asset", name: "Car", fields: {} },
    { id: "loan-1", type: "liability", name: "Auto loan", fields: {} },
  ] };
  it("one hop from the car: the owner edge stays, the owner's loan is not an edge to nowhere", async () => {
    h = await boot(seed, wire);
    const g = (await h.api("GET", "/api/relationships/graph/car-1")).data;
    const ids = new Set(g.nodes.map((n: any) => n.id));
    expect([...ids].sort()).toEqual(["car-1", "self-1"]);
    expect(g.edges.map((e: any) => e.linkId)).toEqual(["ap-1"]);
    for (const e of g.edges) { expect(ids.has(e.from)).toBe(true); expect(ids.has(e.to)).toBe(true); }
  });
  it("D245: a root the caller cannot see is 404, not an empty graph", async () => {
    h = await boot(seed, wire);
    const r = await h.api("GET", "/api/relationships/graph/someone-elses-car");
    expect(r.status).toBe(404);
  });
  it("two hops: the loan becomes a node and its edge is kept", async () => {
    h = await boot(seed, wire);
    const g = (await h.api("GET", "/api/relationships/graph/car-1?hops=2")).data;
    expect(g.nodes.map((n: any) => n.id).sort()).toEqual(["car-1", "loan-1", "self-1"]);
    expect(g.edges.map((e: any) => e.linkId).sort()).toEqual(["ap-1", "lp-1"]);
  });
});

// ─── D232: goal "days left" / "Due …" parsed a bare day as UTC midnight ──────
import { daysUntilISO } from "../shared/date-rules";
describe("D232: days until a stored day are counted as days in the user's zone", () => {
  it("today is 0, tomorrow 1, yesterday -1, a timestamp counts by its day, junk is null", () => {
    expect(daysUntilISO("2026-09-03", "2026-09-03")).toBe(0);
    expect(daysUntilISO("2026-09-08", "2026-09-03")).toBe(5);
    expect(daysUntilISO("2026-09-02", "2026-09-03")).toBe(-1);
    expect(daysUntilISO("2026-09-08T00:00:00Z", "2026-09-03")).toBe(5);
    expect(daysUntilISO("next month", "2026-09-03")).toBeNull();
    expect(daysUntilISO("", "2026-09-03")).toBeNull();
    expect(daysUntilISO("2026-09-08", "")).toBeNull();
  });
  it("the old epoch arithmetic is what it replaces: a goal due today read overdue after dark in Los Angeles", () => {
    const eveningLA = new Date("2026-09-03T20:30:00-07:00").getTime();
    const old = Math.ceil((new Date("2026-09-03").getTime() - eveningLA) / 86400000);
    expect(old).toBe(-1);
    expect(daysUntilISO("2026-09-03", "2026-09-03")).toBe(0);
  });
});

// ─── D233: a mirror entry re-dated to another day takes its check-in along ──
import { updateTrackerEntryEverywhere } from "../server/tracker-entries";
import { DEFAULT_TIMEZONE as HABIT_TZ } from "../shared/timezone";
describe("D233: moving a habit's mirror tracker entry moves the check-in with it", () => {
  const silent = { warn: () => {} };
  const run = <T,>(s: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(s, fn);
  async function fixture() {
    const s = new MemStorage();
    const tr = await run(s, () => s.createTracker({ name: "Water", category: "health", fields: [{ name: "ml", type: "number" }] } as any));
    const h = await run(s, () => s.createHabit({ name: "Drink", frequency: "daily", targetPerDay: 1, linkedTrackerId: tr.id } as any));
    const done = await run(s, () => completeHabitOccurrence(s, { habitId: h.id, source: "manual", timezone: HABIT_TZ }, silent));
    expect(done.recorded).toBe(1);
    const entries = (await run(s, () => s.getTracker(tr.id)))!.entries;
    expect(entries).toHaveLength(1);
    return { s, tr, h, entry: entries[0], today: getUserToday(HABIT_TZ) };
  }
  const days = async (s: MemStorage, id: string) => ((await run(s, () => s.getHabit(id)))!.checkins || []).map((c: any) => String(c.date).slice(0, 10));
  it("re-dating the mirror to yesterday leaves one check-in, on yesterday; the entry keeps its mirror key", async () => {
    const { s, tr, h, entry, today } = await fixture();
    const y = tzAddDays(today, -1);
    const out = await run(s, () => updateTrackerEntryEverywhere(s, { trackerId: tr.id, entryId: entry.id, patch: { timestamp: `${y}T20:00:00.000Z` } }, HABIT_TZ, silent));
    expect(out.ok).toBe(true);
    expect(out.movedHabitIds).toEqual([h.id]);
    expect(await days(s, h.id)).toEqual([y]);
    const entries = (await run(s, () => s.getTracker(tr.id)))!.entries;
    expect(entries).toHaveLength(1);
    expect((entries[0].values as any)._habitId).toBe(h.id);
  });
  it("an edit that keeps the day, or an entry that mirrors nothing, moves no check-in", async () => {
    const { s, tr, h, entry, today } = await fixture();
    const same = await run(s, () => updateTrackerEntryEverywhere(s, { trackerId: tr.id, entryId: entry.id, patch: { values: { ml: 300, _habitId: h.id } } }, HABIT_TZ, silent));
    expect(same.movedHabitIds).toEqual([]);
    expect(await days(s, h.id)).toEqual([today]);
    const own = (await run(s, () => s.logEntry({ trackerId: tr.id, values: { ml: 100 }, timestamp: `${today}T20:00:00.000Z`, __skipHabitSync: true } as any)))!;
    const moved = await run(s, () => updateTrackerEntryEverywhere(s, { trackerId: tr.id, entryId: own.id, patch: { timestamp: `${tzAddDays(today, -2)}T20:00:00.000Z` } }, HABIT_TZ, silent));
    expect(moved.ok).toBe(true);
    expect(moved.movedHabitIds).toEqual([]);
    expect(await days(s, h.id)).toEqual([today]);
  });
  it("a day the habit refuses (the future) keeps the old check-in rather than losing the completion", async () => {
    const { s, tr, h, entry, today } = await fixture();
    const out = await run(s, () => updateTrackerEntryEverywhere(s, { trackerId: tr.id, entryId: entry.id, patch: { timestamp: `${tzAddDays(today, 3)}T20:00:00.000Z` } }, HABIT_TZ, silent));
    expect(out.ok).toBe(true);
    expect(out.movedHabitIds).toEqual([]);
    expect(await days(s, h.id)).toEqual([today]);
  });
});

// ─── D234: editing a bill-payment expense's amount re-prices the payment ────
import { repriceBillPaymentFromExpense, paymentIdOfExpense } from "../server/liability-payments";
describe("D234: the payment behind an edited bill-payment expense follows the new amount", () => {
  function stubs(over: Record<string, any> = {}) {
    const writes: any[] = [];
    const liability = { id: "bill-1", name: "Power", type: "liability", fields: { occurrences: { "2026-09-06": { status: "paid", paymentId: "pay-1", amount: 40, actualAmount: 40, paidAmount: 40, accountId: "acct-1" } } } };
    const account = { id: "acct-1", name: "Checking", type: "account", fields: { accountKind: "checking", balance: 960 } };
    const s: any = {
      getLiabilityPayment: async (id: string) => id === "pay-1" ? { id: "pay-1", liabilityProfileId: "bill-1", amount: 40, principalPortion: 40, interestPortion: 0 } : undefined,
      updateLiabilityPayment: async (id: string, patch: any) => { writes.push(["payment", id, patch]); return { id, amount: 40, ...patch }; },
      getProfile: async (id: string) => id === "bill-1" ? liability : id === "acct-1" ? account : undefined,
      mutateProfileFields: async (id: string, fn: any) => { const p = fn(liability); writes.push(["stamp", id, p]); return { ...liability, ...p }; },
      adjustAccountBalance: async (id: string, adj: any) => { writes.push(["account", id, adj]); return account; },
      ...over,
    };
    return { s, writes };
  }
  it("finds the payment by tag", () => {
    expect(paymentIdOfExpense({ tags: ["bill-payment", "liability:bill-1", "payment:pay-1"] })).toBe("pay-1");
    expect(paymentIdOfExpense({ tags: ["bill-payment"] })).toBeNull();
    expect(paymentIdOfExpense({})).toBeNull();
  });
  it("40 → 45 moves the ledger row, the paid stamp and the paying account by 5", async () => {
    const { s, writes } = stubs();
    const out = await repriceBillPaymentFromExpense(s, { id: "exp-1", tags: ["payment:pay-1"], amount: 40 }, 45, { warn: () => {}, error: () => {} });
    expect(out).toMatchObject({ ok: true, previousAmount: 40, amount: 45, stampMoved: true, accountAdjusted: true });
    expect(writes[0]).toEqual(["payment", "pay-1", { amount: 45, principalPortion: 45 }]);
    expect(writes[1][2].fields.occurrences["2026-09-06"]).toMatchObject({ amount: 45, actualAmount: 45, paidAmount: 45, status: "paid", paymentId: "pay-1" });
    expect(writes[2][2]).toMatchObject({ delta: -5, source: "payment", linkedRecordId: "pay-1" });
  });
  it("an unchanged amount, an unknown payment or an untagged expense writes nothing", async () => {
    const { s, writes } = stubs();
    expect((await repriceBillPaymentFromExpense(s, { tags: ["payment:pay-1"] }, 40)).reason).toBe("unchanged");
    expect((await repriceBillPaymentFromExpense(s, { tags: ["payment:pay-9"] }, 45)).reason).toBe("not_found");
    expect((await repriceBillPaymentFromExpense(s, { tags: ["bill-payment"] }, 45)).ok).toBe(false);
    expect(writes).toEqual([]);
  });
  it("route: PATCH /api/expenses/:id amount on a bill-payment expense re-prices; a description edit does not", async () => {
    const { s: st, writes } = stubs();
    h = await boot({ expenses: [{ id: "exp-1", description: "Power — 2026-09-06", amount: 40, category: "bills", date: "2026-09-03", tags: ["bill-payment", "liability:bill-1", "payment:pay-1"], linkedProfiles: [] }] }, (storage) => {
      for (const k of ["getLiabilityPayment", "updateLiabilityPayment", "mutateProfileFields", "adjustAccountBalance"]) storage[k] = st[k];
      const baseGet = storage.getProfile; storage.getProfile = async (id: string) => (await st.getProfile(id)) ?? baseGet(id);
    });
    const r1 = await h.api("PATCH", "/api/expenses/exp-1", { description: "Power bill" });
    expect(r1.status).toBe(200);
    expect(writes).toEqual([]);
    const r2 = await h.api("PATCH", "/api/expenses/exp-1", { amount: 45 });
    expect(r2.status).toBe(200);
    expect(r2.data.amount).toBe(45);
    expect(writes.map((w) => w[0])).toEqual(["payment", "stamp", "account"]);
  });
});

describe("D234: the AI's update_expense re-prices a bill payment the same way", () => {
  it("chat 'the power bill was actually 45' moves the payment row and stamp", async () => {
    const s = new MemStorage();
    (s as any)._timezone = TZ;
    const writes: any[] = [];
    const bill = await s.createProfile({ name: "Power", type: "liability", fields: { occurrences: { "2026-09-06": { status: "paid", paymentId: "pay-1", amount: 40, actualAmount: 40, paidAmount: 40 } } } } as any);
    await s.createExpense({ amount: 40, category: "bills", description: "Power — 2026-09-06", date: "2026-09-03", tags: ["bill-payment", `liability:${bill.id}`, "payment:pay-1"] } as any);
    (s as any).getLiabilityPayment = async (id: string) => id === "pay-1" ? { id: "pay-1", liabilityProfileId: bill.id, amount: 40, principalPortion: 40 } : undefined;
    (s as any).updateLiabilityPayment = async (id: string, patch: any) => { writes.push([id, patch]); return { id, ...patch }; };
    const run = <T,>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => requestStorageContext.run(s, () => fn().then(resolve, reject)));
    const out = await run(() => executeTool("update_expense", { description: "Power", changes: { amount: 45 } }, "u-1"));
    expect(out.updated).toBe(true);
    expect(writes).toEqual([["pay-1", { amount: 45, principalPortion: 45 }]]);
    const stamp = ((await s.getProfile(bill.id))!.fields as any).occurrences["2026-09-06"];
    expect(stamp).toMatchObject({ amount: 45, actualAmount: 45, paidAmount: 45, status: "paid" });
  });
});

// ─── D235: a bill payment edited from the bill page re-logged its expense ──
import { repriceBillPayment } from "../server/liability-payments";
describe("D235: editing a bill payment's amount or date re-prices in place and keeps the logged expense", () => {
  const silent = { warn: () => {}, error: () => {} };
  function world() {
    const writes: any[] = [];
    const liability: any = { id: "bill-1", name: "Power", type: "liability", type_key: "utility", fields: { lastPaidDate: "2026-09-03", occurrences: { "2026-09-06": { status: "paid", paymentId: "pay-1", amount: 40, actualAmount: 40, paidAmount: 40 } } } };
    const expense: any = { id: "exp-1", amount: 40, date: "2026-09-03", category: "utilities", description: "Power (September)", tags: ["bill-payment", "liability:bill-1", "payment:pay-1"], linkedProfiles: [] };
    const row: any = { id: "pay-1", liabilityProfileId: "bill-1", amount: 40, principalPortion: 40, interestPortion: 0, paymentDate: "2026-09-03" };
    const s: any = {
      getLiabilityPayment: async (id: string) => id === "pay-1" ? row : undefined,
      updateLiabilityPayment: async (id: string, patch: any) => { writes.push(["payment", patch]); Object.assign(row, patch); return row; },
      getProfile: async (id: string) => id === "bill-1" ? liability : undefined,
      mutateProfileFields: async (_id: string, fn: any) => { const p = fn(liability); writes.push(["liability", p]); if (p?.fields) liability.fields = { ...liability.fields, ...p.fields }; return liability; },
      getExpenses: async () => [expense],
      updateExpense: async (id: string, patch: any) => { writes.push(["expense", id, patch]); Object.assign(expense, patch); return expense; },
      adjustAccountBalance: async () => undefined,
    };
    return { s, writes, liability, expense, row };
  }
  it("amount 40 → 45: ledger row, stamp and the expense's amount move; its category and description stay", async () => {
    const { s, expense, liability } = world();
    const out = await repriceBillPayment(s, "pay-1", { amount: 45 }, { expense: "sync" }, silent);
    expect(out).toMatchObject({ ok: true, stampMoved: true, expenseUpdated: true, amount: 45 });
    expect(expense).toMatchObject({ id: "exp-1", amount: 45, category: "utilities", description: "Power (September)" });
    expect(liability.fields.occurrences["2026-09-06"]).toMatchObject({ paidAmount: 45, status: "paid" });
  });
  it("date 09-03 → 09-04: the row, the expense date and lastPaidDate follow; the stamp's amount is untouched", async () => {
    const { s, expense, liability, row, writes } = world();
    const out = await repriceBillPayment(s, "pay-1", { paymentDate: "2026-09-04" }, { expense: "sync" }, silent);
    expect(out).toMatchObject({ ok: true, stampMoved: false, expenseUpdated: true, paymentDate: "2026-09-04" });
    expect(row.paymentDate).toBe("2026-09-04");
    expect(expense.date).toBe("2026-09-04");
    expect(liability.fields.lastPaidDate).toBe("2026-09-04");
    expect(writes.filter((w) => w[0] === "payment")).toEqual([["payment", { paymentDate: "2026-09-04" }]]);
  });
  it("route: PATCH /api/liability-payments/:id on a recurring bill keeps the expense the user edited", async () => {
    const { s: st, expense, writes } = world();
    h = await boot({ profiles: [{ id: "bill-1", name: "Power", type: "liability", type_key: "utility", fields: { lastPaidDate: "2026-09-03", occurrences: { "2026-09-06": { status: "paid", paymentId: "pay-1", amount: 40 } } } }] }, (storage) => {
      for (const k of ["getLiabilityPayment", "updateLiabilityPayment", "mutateProfileFields", "getExpenses", "updateExpense", "adjustAccountBalance"]) storage[k] = st[k];
      storage.unpayBillOccurrence = () => { throw new Error("unpay must not run for a bill re-price"); };
    });
    const r = await h.api("PATCH", "/api/liability-payments/pay-1", { amount: 45 });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ id: "pay-1", amount: 45 });
    expect(expense).toMatchObject({ id: "exp-1", amount: 45, category: "utilities", description: "Power (September)" });
    expect(writes.some((w) => w[0] === "expense")).toBe(true);
  });
});

// ─── D236: profile detail served a small tracker's entries newest-first ─────
import { capProfileDetailLists } from "../server/supabase-storage";
describe("D236: profile detail embeds tracker entries oldest → newest whether or not the cap applies", () => {
  const entry = (weight: number, day: string) => ({ id: `e-${weight}`, trackerId: "tr-1", values: { weight }, timestamp: `${day}T15:00:00.000Z` });
  const base = { relatedExpenses: [], relatedEvents: [], relatedDocuments: [], relatedJournal: [], timeline: [], profileId: "kim-1" } as any;
  it("two entries delivered newest-first come back oldest-first, so entries[length-1] is today's value", () => {
    const out = capProfileDetailLists({ ...base, relatedTrackers: [{ id: "tr-1", name: "Weight", fields: [], entries: [entry(178, "2026-09-03"), entry(180, "2026-08-31")] } as any] });
    const entries = out.relatedTrackers[0].entries;
    expect(entries.map((e: any) => e.values.weight)).toEqual([180, 178]);
    expect(entries[entries.length - 1].values.weight).toBe(178);
    expect(out.relatedTrackers[0].entriesTotal).toBe(2);
  });
  it("over the cap: the newest N, oldest-first", () => {
    const many = Array.from({ length: 60 }, (_, i) => entry(100 + i, `2026-0${i < 30 ? 7 : 8}-${String((i % 30) + 1).padStart(2, "0")}`));
    const out = capProfileDetailLists({ ...base, relatedTrackers: [{ id: "tr-1", name: "W", fields: [], entries: many.slice().reverse() } as any] });
    const w = out.relatedTrackers[0].entries.map((e: any) => e.values.weight);
    expect(w).toHaveLength(50);
    expect(w[0]).toBe(110);
    expect(w[49]).toBe(159);
    expect(out.relatedTrackers[0].entriesTotal).toBe(60);
  });
});

// ─── D237: a backup's document provenance named the source account's ids ────
describe("D237: POST /api/import re-keys `_docFields` to the restored documents' ids", () => {
  it("writes the provenance after the documents exist, keyed by their new ids; unknown documents drop out", async () => {
    const created: Record<string, any[]> = { profiles: [], documents: [], profileUpdates: [] };
    let seq = 0; const nid = (p: string) => `${p}-${++seq}`;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.getProfiles = async () => [{ id: "self-1", type: "self", name: "Me", fields: {} }];
      storage.getSelfProfile = async () => ({ id: "self-1", type: "self", name: "Me", fields: {} });
      storage.createProfile = async (p: any) => { const row = { id: nid("p"), ...p }; created.profiles.push(row); return row; };
      storage.createDocument = async (d: any) => { const row = { id: nid("doc"), ...d }; created.documents.push(row); return row; };
      storage.updateProfile = async (id: string, patch: any) => { created.profileUpdates.push([id, patch]); return { id, ...patch }; };
    });
    const payload = {
      version: "2",
      profiles: [
        { id: "old-self", type: "self", name: "Me", fields: {} },
        { id: "old-kim", type: "person", name: "Kim", parentProfileId: "old-self", fields: { expirationDate: "2026-09-08", _docFields: { "old-doc": { expirationDate: "2026-09-08" }, "gone-doc": { policyNumber: "P-1" } } } },
      ],
      documents: [{ id: "old-doc", name: "Licence", type: "identity", mimeType: "image/jpeg", fileData: "", extractedData: { expirationDate: "2026-09-08" }, tags: [], linkedProfiles: ["old-kim"] }],
    };
    const r = await h.api("POST", "/api/import", payload);
    expect(r.status).toBe(200);
    const kim = created.profiles.find((p) => p.name === "Kim")!;
    expect(kim.fields).toEqual({ expirationDate: "2026-09-08" });
    const doc = created.documents[0];
    expect(doc.linkedProfiles).toEqual([kim.id]);
    expect(created.profileUpdates).toEqual([[kim.id, { fields: { _docFields: { [doc.id]: { expirationDate: "2026-09-08" } } } }]]);
  });
});

// ─── D238/D239: a backup's goals lost their source; journal entries their people ─
describe("D238/D239: POST /api/import keeps a goal's tracker/habit and a journal entry's people, remapped", () => {
  it("goal sources point at the restored tracker and habit; the journal entry links the restored person", async () => {
    const created: Record<string, any[]> = { goals: [], journal: [], trackers: [], habits: [] };
    let seq = 0; const nid = (p: string) => `${p}-${++seq}`;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.getProfiles = async () => [{ id: "self-1", type: "self", name: "Me", fields: {} }];
      storage.getSelfProfile = async () => ({ id: "self-1", type: "self", name: "Me", fields: {} });
      storage.createProfile = async (p: any) => ({ id: nid("p"), ...p });
      storage.createTracker = async (t: any) => { const row = { id: nid("tr"), ...t, entries: [] }; created.trackers.push(row); return row; };
      storage.createHabit = async (hb: any) => { const row = { id: nid("hb"), ...hb, checkins: [] }; created.habits.push(row); return row; };
      storage.createGoal = async (g: any) => { const row = { id: nid("g"), current: 0, status: "active", ...g }; created.goals.push(row); return row; };
      storage.updateGoal = async (id: string, patch: any) => ({ id, ...patch });
      storage.createJournalEntry = async (j: any) => { const row = { id: nid("j"), ...j }; created.journal.push(row); return row; };
    });
    const payload = {
      version: "2",
      profiles: [
        { id: "old-self", type: "self", name: "Me", fields: {} },
        { id: "old-kim", type: "person", name: "Kim", parentProfileId: "old-self", fields: {} },
      ],
      trackers: [{ id: "old-tr", name: "Weight", category: "health", unit: "lbs", fields: [], entries: [] }],
      habits: [{ id: "old-hb", name: "Walk", frequency: "daily", targetPerDay: 1, checkins: [] }],
      goals: [
        { id: "old-g1", title: "Get to 170", type: "weight_loss", unit: "lbs", target: 170, trackerId: "old-tr", linkedProfiles: ["old-kim"] },
        { id: "old-g2", title: "30-day walk", type: "habit_streak", unit: "days", target: 30, habitId: "old-hb" },
      ],
      journalEntries: [{ id: "old-j", date: "2026-09-03", content: "Kim's day", linkedProfiles: ["old-kim"] }],
    };
    const r = await h.api("POST", "/api/import", payload);
    expect(r.status).toBe(200);
    const tr = created.trackers[0], hb = created.habits[0];
    expect(created.goals.map((g) => [g.title, g.trackerId, g.habitId])).toEqual([["Get to 170", tr.id, undefined], ["30-day walk", undefined, hb.id]]);
    expect(created.goals[0].linkedProfiles).toEqual([expect.stringMatching(/^p-/)]);
    expect(created.journal[0].linkedProfiles).toEqual([expect.stringMatching(/^p-/)]);
  });
});

// ─── D240: a restored bill's paid stamp and expense tags named the source ids ─
describe("D240: POST /api/import re-keys paid stamps and bill-payment expense tags to the restored ids", () => {
  it("restores the payment ledger, rewrites stamp paymentId/accountId and the expense's liability:/payment: tags", async () => {
    const created: Record<string, any[]> = { profiles: [], payments: [], profileUpdates: [], expenses: [], expenseUpdates: [] };
    let seq = 0; const nid = (p: string) => `${p}-${++seq}`;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.getProfiles = async () => [{ id: "self-1", type: "self", name: "Me", fields: {} }];
      storage.getSelfProfile = async () => ({ id: "self-1", type: "self", name: "Me", fields: {} });
      storage.createProfile = async (p: any) => { const row = { id: nid("p"), ...p }; created.profiles.push(row); return row; };
      storage.updateProfile = async (id: string, patch: any) => { created.profileUpdates.push([id, patch]); return { id, ...patch }; };
      storage.createLiabilityPayment = async (d: any) => { const row = { id: nid("pay"), ...d }; created.payments.push(row); return row; };
      storage.createExpense = async (e: any) => { const row = { id: nid("exp"), ...e }; created.expenses.push(row); return row; };
      storage.updateExpense = async (id: string, patch: any) => { created.expenseUpdates.push([id, patch]); return { id, ...patch }; };
    });
    const payload = {
      version: "2",
      profiles: [
        { id: "old-self", type: "self", name: "Me", fields: {} },
        { id: "old-acct", type: "account", name: "Checking", parentProfileId: "old-self", fields: { accountKind: "checking", balance: 960 } },
        { id: "old-bill", type: "liability", type_key: "utility", name: "Power", parentProfileId: "old-self", fields: { monthlyAmount: 40, occurrences: { "2026-09-06": { status: "paid", paymentId: "old-pay", accountId: "old-acct", amount: 40 } } } },
      ],
      expenses: [{ id: "old-exp", amount: 40, category: "bills", description: "Power — 2026-09-06", date: "2026-09-03", tags: ["bill-payment", "liability:old-bill", "payment:old-pay"], linkedProfiles: ["old-self"] }],
      liabilityPayments: [{ id: "old-pay", liabilityProfileId: "old-bill", paymentDate: "2026-09-03", amount: 40, principalPortion: 40, interestPortion: 0, fees: 0, paymentType: "standard" }],
    };
    const r = await h.api("POST", "/api/import", payload);
    expect(r.status).toBe(200);
    const bill = created.profiles.find((p) => p.name === "Power")!, acct = created.profiles.find((p) => p.name === "Checking")!;
    expect(created.payments).toHaveLength(1);
    const pay = created.payments[0];
    expect(pay.liabilityProfileId).toBe(bill.id);
    const stampWrite = created.profileUpdates.find((u) => u[0] === bill.id && u[1].fields?.occurrences);
    expect(stampWrite![1].fields.occurrences["2026-09-06"]).toMatchObject({ status: "paid", paymentId: pay.id, accountId: acct.id, amount: 40 });
    expect(created.expenseUpdates).toEqual([[created.expenses[0].id, { tags: ["bill-payment", `liability:${bill.id}`, `payment:${pay.id}`] }]]);
  });
});

// ─── D241: a restored document-derived event lost its document link ─────────
describe("D241: POST /api/import re-links restored events to the restored documents", () => {
  it("writes linkedDocuments after the documents exist, keyed by their new ids", async () => {
    const created: Record<string, any[]> = { events: [], documents: [], eventUpdates: [] };
    let seq = 0; const nid = (p: string) => `${p}-${++seq}`;
    h = await boot({ profiles: [{ id: "self-1", type: "self", name: "Me" }] }, (storage) => {
      storage.getProfiles = async () => [{ id: "self-1", type: "self", name: "Me", fields: {} }];
      storage.getSelfProfile = async () => ({ id: "self-1", type: "self", name: "Me", fields: {} });
      storage.createEvent = async (e: any) => { const row = { id: nid("ev"), ...e }; created.events.push(row); return row; };
      storage.createDocument = async (d: any) => { const row = { id: nid("doc"), ...d }; created.documents.push(row); return row; };
      storage.updateEvent = async (id: string, patch: any) => { created.eventUpdates.push([id, patch]); return { id, ...patch }; };
    });
    const payload = {
      version: "2",
      profiles: [{ id: "old-self", type: "self", name: "Me", fields: {} }],
      events: [
        { id: "old-ev", title: "Permit expires", date: "2026-09-09", category: "other", tags: ["document-extraction"], linkedProfiles: ["old-self"], linkedDocuments: ["old-doc", "gone-doc"] },
        { id: "old-ev2", title: "Dinner", date: "2026-09-10", category: "social", linkedProfiles: ["old-self"], linkedDocuments: [] },
      ],
      documents: [{ id: "old-doc", name: "Permit", type: "other", mimeType: "application/pdf", fileData: "", extractedData: { expirationDate: "2026-09-09" }, tags: [], linkedProfiles: ["old-self"] }],
    };
    const r = await h.api("POST", "/api/import", payload);
    expect(r.status).toBe(200);
    const ev = created.events.find((e) => e.title === "Permit expires")!, doc = created.documents[0];
    expect(created.eventUpdates).toEqual([[ev.id, { linkedDocuments: [doc.id] }]]);
  });
});

// ─── D242: the generic owners route wrote asset rows for a liability ────────
describe("D242: PUT /api/profiles/:id/owners and /liability-owners write the table the profile's type uses", () => {
  function wire(storage: any, calls: any[]) {
    storage.setAssetOwners = async (id: string, owners: any[]) => { calls.push(["asset", id, owners]); return owners.map((o) => ({ assetProfileId: id, ...o })); };
    storage.setLiabilityOwners = async (id: string, owners: any[]) => { calls.push(["liability", id, owners]); return owners.map((o) => ({ liabilityProfileId: id, ...o })); };
  }
  const seed = { profiles: [
    { id: "self-1", type: "self", name: "Me", fields: {} },
    { id: "linda-1", type: "person", name: "Linda", fields: {} },
    { id: "loan-1", type: "liability", type_key: "auto_loan", name: "Auto loan", fields: {} },
    { id: "car-1", type: "asset", type_key: "vehicle", name: "Car", fields: {} },
  ] };
  const owners = [{ partyProfileId: "self-1", ownershipPercentage: 50 }, { partyProfileId: "linda-1", ownershipPercentage: 50, role: "co_signer" }];
  it("a loan sent to /owners lands in liability_profile_links", async () => {
    const calls: any[] = [];
    h = await boot(seed, (s) => wire(s, calls));
    const r = await h.api("PUT", "/api/profiles/loan-1/owners", { owners });
    expect(r.status).toBe(200);
    expect(r.data.liabilityProfileId).toBe("loan-1");
    expect(calls.map((c) => c[0])).toEqual(["liability"]);
  });
  it("an asset sent to /liability-owners lands in asset_party_links; each type on its own route is unchanged", async () => {
    const calls: any[] = [];
    h = await boot(seed, (s) => wire(s, calls));
    expect((await h.api("PUT", "/api/profiles/car-1/liability-owners", { owners })).data.ownerProfileId).toBe("car-1");
    expect((await h.api("PUT", "/api/profiles/car-1/owners", { owners })).data.ownerProfileId).toBe("car-1");
    expect((await h.api("PUT", "/api/profiles/loan-1/liability-owners", { owners })).data.liabilityProfileId).toBe("loan-1");
    expect(calls.map((c) => c[0])).toEqual(["asset", "asset", "liability"]);
  });
});

// ─── D243: a typed name inside an existing name was taken for it ─────────────
import { nameLooselyMatches } from "../shared/name-match";
describe("D243: the AI's name fallback matches whole names and word starts, never a fragment inside a word", () => {
  it("rule", () => {
    expect(nameLooselyMatches("Joanna", "joanna")).toBe(true);
    expect(nameLooselyMatches("Joanna", "joan")).toBe(true);
    expect(nameLooselyMatches("Joanna", "ann")).toBe(false);
    expect(nameLooselyMatches("Honda Civic", "civic")).toBe(true);
    expect(nameLooselyMatches("Honda Civic", "vic")).toBe(false);
    expect(nameLooselyMatches("Car Loan (Toyota)", "car loan")).toBe(true);
    expect(nameLooselyMatches("Car Loan (Toyota)", "toyota")).toBe(true);
    expect(nameLooselyMatches("Ann", "ann")).toBe(true);
    expect(nameLooselyMatches("Joanna", "")).toBe(false);
  });
  it("update_expense 'for Ann' no longer files the lunch under Joanna; 'for Joan' still does", async () => {
    const s = new MemStorage();
    const run = <T,>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => requestStorageContext.run(s, () => fn().then(resolve, reject)));
    await s.createProfile({ name: "Me", type: "self", fields: {} } as any);
    const joanna = await s.createProfile({ name: "Joanna", type: "person", fields: {} } as any);
    const lunch = await s.createExpense({ amount: 12, category: "food", description: "lunch", date: "2026-09-03", linkedProfiles: [] } as any);
    const ann = await run(() => executeTool("update_expense", { description: "lunch", changes: { amount: 13 }, forProfile: "Ann" }, "u-1"));
    expect(ann.error).toMatch(/couldn't find a profile named "Ann"/);
    expect((await s.getExpense(lunch.id))!.amount).toBe(12);
    const joan = await run(() => executeTool("update_expense", { description: "lunch", changes: { amount: 13 }, forProfile: "Joan" }, "u-1"));
    expect(joan.updated).toBe(true);
    expect((await s.getExpense(lunch.id))!.linkedProfiles).toContain(joanna.id);
  });
});

// ─── D250: deleting a person deleted the trackers she shared with Self ──────
describe("D250: a shared tracker survives one owner's deletion; a sole-owner tracker goes with them", () => {
  it("MemStorage applies the multi-owner rule to trackers", async () => {
    const s = new MemStorage();
    const self = await s.createProfile({ name: "Me", type: "self", fields: {} } as any);
    const kim = await s.createProfile({ name: "Kim", type: "person", fields: {} } as any);
    const shared = await s.createTracker({ name: "Family steps", category: "fitness", fields: [{ name: "steps", type: "number" }], linkedProfiles: [self.id, kim.id] } as any);
    const own = await s.createTracker({ name: "Kim weight", category: "health", fields: [{ name: "weight", type: "number" }], linkedProfiles: [kim.id] } as any);
    await s.logEntry({ trackerId: shared.id, values: { steps: 8000 }, __skipHabitSync: true } as any);
    expect(await s.deleteProfile(kim.id)).toBe(true);
    const kept = await s.getTracker(shared.id);
    expect(kept?.linkedProfiles).toEqual([self.id]);
    expect(kept?.entries).toHaveLength(1);
    expect(await s.getTracker(own.id)).toBeUndefined();
  });
  it("the cascade migration deletes only sole-owner trackers and unlinks the rest", () => {
    const sql = readFileSync("migrations/20260903_shared_tracker_cascade.sql", "utf8");
    const trackerDelete = sql.match(/DELETE FROM trackers[\s\S]*?;/)?.[0] ?? "";
    expect(trackerDelete).toMatch(/jsonb_array_length\(linked_profiles\) <= 1/);
    expect(sql).toMatch(/UPDATE trackers[\s\S]*?linked_profiles @> jsonb_build_array\(v_pid\)/);
    const entryDelete = sql.match(/DELETE FROM tracker_entries te[\s\S]*?;/)?.[0] ?? "";
    expect(entryDelete).toMatch(/jsonb_array_length\(t\.linked_profiles\) <= 1/);
  });
});

// ─── D251: two profiles sharing a name — the first one silently won ─────────
describe("D251: a name shared by two profiles is a question, not a guess", () => {
  it("update_expense for 'Max' with a son and a dog both named Max asks which; a unique name still resolves", async () => {
    const s = new MemStorage();
    (s as any)._timezone = TZ;
    const run = <T,>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => requestStorageContext.run(s, () => fn().then(resolve, reject)));
    await s.createProfile({ name: "Me", type: "self", fields: {} } as any);
    const son = await s.createProfile({ name: "Max", type: "person", fields: {} } as any);
    await s.createProfile({ name: "Max", type: "pet", fields: {} } as any);
    const lunch = await s.createExpense({ amount: 12, category: "food", description: "lunch", date: "2026-09-03", linkedProfiles: [] } as any);
    const out = await run(() => executeTool("update_expense", { description: "lunch", changes: { amount: 13 }, forProfile: "Max" }, "u-1"));
    expect(out.error).toMatch(/Several profiles match "Max"/);
    expect((await s.getExpense(lunch.id))!.amount).toBe(12);
    const ok = await run(() => executeTool("update_expense", { description: "lunch", changes: { amount: 13 }, forProfile: "Me" }, "u-1"));
    expect(ok.updated).toBe(true);
    expect(son.id).toBeTruthy();
  });
});

describe("D251: the ownership tools ask too when two people share a name", () => {
  it("link_asset_owner with two people named Max asks which, and creates no link", async () => {
    const s = new MemStorage();
    const run = <T,>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => requestStorageContext.run(s, () => fn().then(resolve, reject)));
    await s.createProfile({ name: "Me", type: "self", fields: {} } as any);
    await s.createProfile({ name: "Max", type: "person", fields: {} } as any);
    await s.createProfile({ name: "Max", type: "person", fields: { relationship: "nephew" } } as any);
    await s.createProfile({ name: "Honda Civic", type: "asset", fields: {} } as any);
    const calls: any[] = [];
    (s as any).createAssetPartyLink = async (l: any) => { calls.push(l); return { id: "l1", ...l }; };
    const out = await run(() => executeTool("link_asset_owner", { assetName: "Civic", partyName: "Max", ownershipPct: 50, role: "co_owner" }, "u-1"));
    expect(out.error).toMatch(/Several profiles match "Max"/);
    expect(calls).toEqual([]);
    expect((await s.getProfiles()).filter((p) => p.name === "Max")).toHaveLength(2);
  });
});

describe("D251: the legacy name matcher behind forty tools asks on an exact duplicate", () => {
  it("create_expense for 'Max' with two people named Max asks and creates nothing", async () => {
    const s = new MemStorage();
    (s as any)._timezone = TZ;
    const run = <T,>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => requestStorageContext.run(s, () => fn().then(resolve, reject)));
    await s.createProfile({ name: "Me", type: "self", fields: {} } as any);
    await s.createProfile({ name: "Max", type: "person", fields: {} } as any);
    await s.createProfile({ name: "Max", type: "pet", fields: {} } as any);
    const out = await run(() => executeTool("create_expense", { amount: 20, category: "food", description: "treats", forProfile: "Max" }, "u-1"));
    expect(out.error).toMatch(/Several profiles match "Max"/);
    expect(await s.getExpenses()).toHaveLength(0);
  });
});

// ─── D252: a bill whose series ended kept coming due ────────────────────────
import { isEndedBillFields } from "../shared/liability-recurrence";
import { isActiveObligation } from "../shared/obligation-windows";
describe("D252: a finite series past its recurrenceEnd is ended everywhere, not just on the calendar", () => {
  it("rule: ended when the next occurrence falls after recurrenceEnd", () => {
    expect(isEndedBillFields({ recurrenceEnd: "2026-08-14", dueDate: "2026-09-05" })).toBe(true);
    expect(isEndedBillFields({ recurrenceEnd: "2026-09-30", dueDate: "2026-09-05" })).toBe(false);
    expect(isEndedBillFields({ dueDate: "2026-09-05" })).toBe(false);
    expect(isEndedBillFields({ recurrenceEnd: "2026-08-14" }, "2026-09-05")).toBe(true);
    expect(isActiveObligation({ status: "ended", nextDueDate: "" })).toBe(false);
    // D253: a fixed number of occurrences, all settled
    const two = { count: 2, dueDate: "2026-11-05", occurrences: { "2026-09-05": { status: "paid" }, "2026-10-05": { status: "paid" } } };
    expect(isEndedBillFields(two)).toBe(true);
    expect(isEndedBillFields({ ...two, occurrences: { "2026-09-05": { status: "paid" } } })).toBe(false);
    expect(isEndedBillFields({ ...two, count: 3 })).toBe(false);
  });
  it("the bills projection reports it ended with no next due date", () => {
    const s = bareStorage();
    const gym = { id: "g1", name: "Old gym", type: "liability", type_key: "subscription", fields: { monthlyAmount: 25, frequency: "monthly", dueDate: "2026-09-05", nextDueDate: "2026-09-05", recurrenceEnd: "2026-08-14" } };
    const o = s.liabilityToObligation(gym);
    expect(o.status).toBe("ended");
    expect(o.nextDueDate).toBe("");
    const live = { ...gym, fields: { ...gym.fields, recurrenceEnd: "2026-12-31" } };
    expect(s.liabilityToObligation(live)).toMatchObject({ status: "active", nextDueDate: "2026-09-05" });
    // D253: two of two payments made → ended, no next due date
    const plan = { id: "p1", name: "Sofa", type: "liability", type_key: "utility", fields: { monthlyAmount: 100, frequency: "monthly", dueDate: "2026-11-05", nextDueDate: "2026-11-05", count: 2, occurrences: { "2026-09-05": { status: "paid" }, "2026-10-05": { status: "paid" } } } };
    expect(s.liabilityToObligation(plan)).toMatchObject({ status: "ended", nextDueDate: "" });
  });
});

// ── D254: a ChatGPT finance import that overwrites a budget cap must be undoable,
// and the preview must plan against the user's month, not the host's UTC month.
describe("D254 finance-import budgets: undo restores overwritten caps; plan uses the user's month", async () => {
  const { planImport, applyImport, undoImport } = await import("../server/finance-import");
  const { validateFinanceImport } = await import("../shared/finance-import-schema");
  function budgetStore(seed: Record<string, any[]>) {
    const months: Record<string, any[]> = JSON.parse(JSON.stringify(seed));
    const imports = new Map<string, any>();
    const asked: string[] = [];
    const created: any[] = [];
    const store: any = {
      getExpenses: async () => [], getObligations: async () => [], getIncomes: async () => [],
      getProfiles: async () => [{ id: "p1", type: "self", name: "Me" }],
      getBudgets: async (m: string) => { asked.push(m); return (months[m] ||= []).map((b) => ({ ...b })); },
      createExpense: async (d: any) => ({ id: "e", ...d }),
      createObligation: async (d: any) => { created.push(d); return { id: "o", ...d }; },
      createIncome: async (d: any) => ({ id: "i", ...d }), createProfile: async (d: any) => ({ id: "pr", ...d }),
      addBudget: async (m: string, category: string, amount: number, notes?: string, profileId?: string) => {
        const list = (months[m] ||= []);
        const hit = list.find((b) => b.category === category && (b.profileId || null) === (profileId || null));
        if (hit) { hit.amount = amount; hit.notes = notes; return { ...hit }; }
        const row = { id: `b${list.length + 1}`, category, amount, notes, profileId }; list.push(row); return { ...row };
      },
      updateBudget: async (m: string, id: string, u: any) => {
        const hit = (months[m] || []).find((b) => b.id === id); if (!hit) return false;
        if (u.amount !== undefined) hit.amount = u.amount; if (u.notes !== undefined) hit.notes = u.notes ?? undefined; return true;
      },
      deleteBudget: async (m: string, id: string) => { const l = months[m] || []; const i = l.findIndex((b) => b.id === id); if (i < 0) return false; l.splice(i, 1); return true; },
      deleteExpense: async () => true, deleteObligation: async () => true, deleteIncome: async () => true, deleteProfile: async () => true,
      createFinanceImport: async (r: any) => { imports.set(r.id, { ...r, createdAt: "" }); return imports.get(r.id); },
      listFinanceImports: async () => [...imports.values()],
      getFinanceImport: async (id: string) => imports.get(id) || null,
      setFinanceImportStatus: async (id: string, status: string) => { imports.get(id).status = status; },
    };
    return { store, months, asked, created };
  }
  const payload = (budgets: any[], extra: any = {}) => validateFinanceImport(JSON.stringify({ version: "1.0", base_currency: "USD", budgets, ...extra })).data!;

  it("undo puts an overwritten cap back to its hand-set amount and note", async () => {
    const { store, months } = budgetStore({ "2026-09": [{ id: "food", category: "food", amount: 300, notes: "hand-set" }] });
    const p = payload([{ unique_id: "b1", category: "Groceries", amount: 500, month: "2026-09" }]);
    const plan = await planImport(store, p, "p1");
    expect(plan.ops[0].action).toBe("update");
    const res = await applyImport(store, p, "p1", plan, { month: "2026-09" });
    expect(months["2026-09"][0]).toMatchObject({ id: "food", amount: 500 });
    expect(res.record.createdRecords.budgets[0]).toEqual({ month: "2026-09", id: "food", previous: { amount: 300, notes: "hand-set" } });
    const undo = await undoImport(store, res.batchId);
    expect(undo).toEqual({ removed: 0, restored: 1 });
    expect(months["2026-09"]).toEqual([{ id: "food", category: "food", amount: 300, notes: "hand-set" }]);
  });

  it("a plan that called the write a create still keeps the cap it lands on (undo restores, never deletes)", async () => {
    // The plan was built against a month with no cap; the commit month has one.
    const { store, months } = budgetStore({ "2026-09": [{ id: "food", category: "food", amount: 300, profileId: "p1" }] });
    const p = payload([{ unique_id: "b1", category: "food", amount: 500 }]);
    const plan = await planImport(store, p, "p1", { month: "2026-10" });
    expect(plan.ops[0].action).toBe("create");
    const res = await applyImport(store, p, "p1", plan, { month: "2026-09" });
    expect(months["2026-09"]).toHaveLength(1);
    expect(res.record.createdRecords.budgets[0].previous).toEqual({ amount: 300, notes: undefined });
    await undoImport(store, res.batchId);
    expect(months["2026-09"]).toEqual([{ id: "food", category: "food", amount: 300, profileId: "p1", notes: undefined }]);
  });

  it("a cap the import created is removed on undo", async () => {
    const { store, months } = budgetStore({});
    const p = payload([{ unique_id: "b1", category: "travel", amount: 120, month: "2026-09" }]);
    const plan = await planImport(store, p, "p1");
    const res = await applyImport(store, p, "p1", plan, { month: "2026-09" });
    expect(months["2026-09"]).toHaveLength(1);
    expect(await undoImport(store, res.batchId)).toEqual({ removed: 1, restored: 0 });
    expect(months["2026-09"]).toEqual([]);
  });

  it("the preview plans a month-less cap against the caller's month, the same month the commit writes", async () => {
    const { store, asked } = budgetStore({ "2026-08": [{ id: "food", category: "food", amount: 300 }] });
    const p = payload([{ unique_id: "b1", category: "food", amount: 500 }]);
    const plan = await planImport(store, p, "p1", { month: "2026-08" });
    expect(asked).toContain("2026-08");
    expect(plan.ops[0]).toMatchObject({ action: "update", label: "food $500 (2026-08)" });
  });

  it("a bill without a due date falls due one cadence out from the caller's today", async () => {
    const { store, created } = budgetStore({});
    const p = payload([], { recurring_bills: [{ unique_id: "r1", name: "Water", amount: 40, frequency: "monthly" }] });
    const plan = await planImport(store, p, "p1", { today: "2026-08-31" });
    await applyImport(store, p, "p1", plan, { month: "2026-08", today: "2026-08-31" });
    expect(created[0].nextDueDate).toBe("2026-09-30");
  });
});

// ── D255: the Sunday weekly-review cron must build each user's review in that
// user's saved timezone, like the daily-maintenance cron does.
describe("D255 weekly-review cron pins each user's timezone", () => {
  const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const start = src.indexOf("const cronWeeklyReview");
  const end = src.indexOf('app.get("/api/cron/weekly-review"');
  const block = src.slice(start, end);
  it("sets the scoped storage's timezone from the user's preference before generating", () => {
    expect(start).toBeGreaterThan(0);
    const pin = block.indexOf("_timezone = await userTimezoneFor(scoped)");
    const gen = block.indexOf("generateWeeklyReview(scoped)");
    expect(pin).toBeGreaterThan(0);
    expect(gen).toBeGreaterThan(pin);
  });
});

// ── D256: the dashboard warm-up computes the cached stats in the user's
// timezone (header, else saved preference), never the server default.
describe("D256 warm-up pins the user's timezone before warming stats", () => {
  it("server: the scoped storage gets the header timezone or the saved preference before getStats", () => {
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const start = src.indexOf('app.get("/api/warmup"');
    const warmStats = src.indexOf("scoped.getStats(", start);
    const pin = src.indexOf("_timezone =", start);
    expect(start).toBeGreaterThan(0);
    expect(pin).toBeGreaterThan(start);
    expect(pin).toBeLessThan(warmStats);
    expect(src.slice(pin, pin + 200)).toMatch(/x-timezone|userTimezoneFor/);
  });
  it("client: an authed warm-up sends the browser timezone", () => {
    const src = readFileSync(new URL("../client/src/lib/warmup.ts", import.meta.url), "utf8");
    expect(src).toMatch(/"X-Timezone": BROWSER_TIMEZONE/);
  });
});

// ── D257: every cron that writes for a user bumps that user's data version and
// busts the instance caches, so the lists served right after are fresh.
describe("D257 cron writes invalidate the user's caches", () => {
  const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const between = (from: string, to: string) => { const a = src.indexOf(from); const b = src.indexOf(to, a); expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a); return src.slice(a, b); };
  it("the helper bumps the version and busts the per-user caches", () => {
    const helper = between("async function afterCronWrites", "const cronWeeklyReview");
    expect(helper).toContain("bumpDataVersionNow(uid)");
    expect(helper).toContain("bustUserCaches(uid)");
  });
  it("weekly review, net-worth snapshot and the due scan call it after writing", () => {
    expect(between("const cronWeeklyReview", 'app.get("/api/cron/weekly-review"')).toContain("await afterCronWrites(u.id)");
    expect(between("async function runNetWorthSnapshot", "const cronSnapshotNetWorth")).toContain("await afterCronWrites(u.id)");
    const scan = between("async function runLiabilityDueScan", "const cronLiabilityDueScan");
    expect(scan).toMatch(/if \(userWrote\) \{[\s\S]{0,400}await afterCronWrites\(u\.id\)/);
    // Every write path in the scan marks the user as written to.
    expect(scan.indexOf("userWrote = true")).toBeLessThan(scan.indexOf("closeBillReminderTasksWhere("));
    expect((scan.match(/userWrote = true/g) || []).length).toBe(4);
  });
});

// ── D258: no user-facing default reads the host's clock — "today" and "this
// month" come from the user's timezone in the AI engine, the cashflow default,
// the connected-finance routes and the finance chat tool.
describe("D258 host-clock defaults", () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
  it("ai-engine: document extraction and delete_journal use the user's today", () => {
    const src = read("../server/ai-engine.ts");
    expect(src).not.toMatch(/today: getUserToday\(\)/);
    expect(src).not.toMatch(/const today = new Date\(\)\.toLocaleDateString\('en-CA'\)/);
    expect((src.match(/getUserToday\(aiUserTimezone\(\)\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });
  it("storage: getCashflow defaults to the user's month", () => {
    const src = read("../server/supabase-storage.ts");
    const i = src.indexOf("async getCashflow(month?: string)");
    expect(src.slice(i, i + 500)).toContain("month || getUserCurrentMonth(this._timezone)");
  });
  it("finance routes and the finance chat tool default the month from the user's zone", () => {
    const fr = read("../server/finance-routes.ts");
    // The host's month survives only as buildSummary's last resort behind the caller's month.
    expect((fr.match(/new Date\(\)\.toISOString\(\)\.slice\(0, 7\)/g) || []).length).toBe(1);
    expect(fr).toContain("scope.startDate?.slice(0, 7) ?? opts.month ?? new Date().toISOString().slice(0, 7)");
    expect((fr.match(/currentMonthFor\(req\)/g) || []).length).toBe(3);
    expect(fr).toContain('const tz = req.headers["x-timezone"]');
    const tool = read("../server/finance-ai-tools.ts");
    expect(tool).toContain("buildSummary(userId, scope, { month: getUserCurrentMonth(");
  });
});

// ── D259: the admin tracker-entry cleanup only treats negatives as garbage in
// health-type trackers; finance/custom trackers record them on purpose.
describe("D259 tracker cleanup keeps legitimate negative entries", () => {
  it("the negative-value rule is gated on a health category", () => {
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const i = src.indexOf('app.post("/api/cleanup/tracker-entries"');
    const block = src.slice(i, i + 4000);
    expect(src.slice(i - 400, i)).toContain('HEALTH_TRACKER_CATEGORIES = new Set(["health", "fitness", "nutrition", "sleep", "medication"])');
    expect(block).toContain("healthType && Object.values(vals).some((v: any) => typeof v === 'number' && v < 0)");
  });
});

// ── D260: two overlapping due-scan runs must not leave two "Bill due" reminders.
describe("D260 duplicate bill reminders collapse to one", async () => {
  const { pickDuplicateBillReminders, collapseDuplicateBillReminders } = await import("../server/liability-payments");
  const t = (id: string, title: string, dueDate: string, createdAt: string, status = "pending") => ({ id, title, dueDate, createdAt, status, linkedProfiles: ["bill1"] });
  it("keeps the earliest copy (ties by id) and names the rest", () => {
    const tasks = [
      t("b", "Bill due: Water", "2026-09-05", "2026-09-03T10:00:01Z"),
      t("a", "Bill due: Water", "2026-09-05", "2026-09-03T10:00:00Z"),
      t("c", "Bill due: Water", "2026-09-05", "2026-09-03T10:00:00Z"),
      t("d", "Bill due: Water", "2026-10-05", "2026-09-03T10:00:00Z"), // another day: not a duplicate
      t("e", "Bill due: Gas", "2026-09-05", "2026-09-03T10:00:00Z"),
      t("f", "Bill due: Water", "2026-09-05", "2026-09-01T10:00:00Z", "done"), // closed: ignored
      { id: "g", title: "Call mom", dueDate: "2026-09-05", createdAt: "", status: "pending" },
    ];
    expect(pickDuplicateBillReminders(tasks).sort()).toEqual(["b", "c"]);
    // Both overlapping runs compute the same survivor whatever order they read the rows in.
    expect(pickDuplicateBillReminders([...tasks].reverse()).sort()).toEqual(["b", "c"]);
  });
  it("deletes only the surplus copies", async () => {
    const deleted: string[] = [];
    const storage: any = { getTasks: async () => [t("a", "Bill due: Water", "2026-09-05", "1"), t("b", "Bill due: Water", "2026-09-05", "2")], deleteTask: async (id: string) => { deleted.push(id); return true; } };
    expect(await collapseDuplicateBillReminders(storage)).toBe(1);
    expect(deleted).toEqual(["b"]);
  });
  it("the due scan collapses duplicates for a user it wrote for, before invalidating", () => {
    const src = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const a = src.indexOf("async function runLiabilityDueScan"); const b = src.indexOf("const cronLiabilityDueScan", a);
    const scan = src.slice(a, b);
    const c = scan.indexOf("await collapseDuplicateBillReminders(scoped, log)");
    expect(c).toBeGreaterThan(0);
    expect(scan.indexOf("await afterCronWrites(u.id)")).toBeGreaterThan(c);
    // Legacy doubles heal at the start of the user's loop from the list already read.
    expect(scan).toContain("collapseDuplicateBillReminders(scoped, log, existingTasks)");
  });
});
