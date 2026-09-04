// What the assistant is allowed to destroy without asking.
//
// A "delete X" whose text matches two records must be a question, never a
// coin flip — deleting the wrong expense is unrecoverable from the user's
// side. These drive the REAL executeTool dispatcher against an in-memory
// storage, so they exercise the decision the assistant actually makes.

import { describe, it, expect, beforeEach, vi } from "vitest";

const SELF = { id: "p-self", name: "Tester", type: "self" };

type Expense = { id: string; description: string; amount: number; category: string; date: string; linkedProfiles: string[]; tags?: string[] };
const db: { expenses: Expense[]; deleted: string[] } = { expenses: [], deleted: [] };

// Two debts that share a word — the shape that made "pay my Chase card"
// ambiguous. Kept beside the expense seed so both suites share one storage.
type Liab = { id: string; name: string; type: string; type_key: string; fields: any; tags: string[]; notes: string };
const liabDb = {
  rows: [] as Liab[],
  payments: [] as any[],
  balances() { return Object.fromEntries(this.rows.map((r) => [r.id, Number(r.fields.currentBalance ?? r.fields.balance)])); },
  reseed() {
    this.payments = [];
    this.rows = [
      { id: "l-sapphire", name: "Chase Sapphire", type: "liability", type_key: "credit_card", fields: { currentBalance: 1000, interestRate: 20, minimumPayment: 35 }, tags: [], notes: "" },
      { id: "l-freedom", name: "Chase Freedom", type: "liability", type_key: "credit_card", fields: { currentBalance: 2000, interestRate: 22, minimumPayment: 50 }, tags: [], notes: "" },
    ];
  },
};

const today = () => new Date().toLocaleDateString("en-CA");

function reseed() {
  liabDb.reseed();
  db.deleted = [];
  db.expenses = [
    { id: "e-coffee", description: "Coffee", amount: 4, category: "food", date: today(), linkedProfiles: [SELF.id] },
    { id: "e-coffee2", description: "Coffee", amount: 9, category: "food", date: today(), linkedProfiles: [SELF.id] },
    { id: "e-beans", description: "Coffee beans", amount: 15, category: "food", date: today(), linkedProfiles: [SELF.id] },
    { id: "e-rent", description: "Rent", amount: 1200, category: "housing", date: today(), linkedProfiles: [SELF.id] },
  ];
}

vi.mock("../server/storage", () => ({
  storage: {
    getProfiles: async () => [SELF, ...liabDb.rows],
    getHabits: async () => [], getHabit: async () => undefined,
    getTasks: async () => [], getGoals: async () => [], getEvents: async () => [],
    getTrackers: async () => [], getObligations: async () => [], getMemories: async () => [],
    getDocuments: async () => [], getJournalEntries: async () => [], getIncomes: async () => [],
    getExpenses: async () => db.expenses,
    getLiabilityPayment: async () => null,
    getProfile: async (id: string) => liabDb.rows.find((r) => r.id === id),
    updateProfile: async (id: string, patch: any) => {
      const r = liabDb.rows.find((x) => x.id === id);
      if (!r) return undefined;
      r.fields = { ...r.fields, ...(patch?.fields || {}) };
      return r;
    },
    mutateProfileFields: async (id: string, fn: any) => {
      const r = liabDb.rows.find((x) => x.id === id);
      if (!r) return undefined;
      r.fields = { ...r.fields, ...((fn(r) || {}).fields || {}) };
      return r;
    },
    createLiabilityPayment: async (row: any) => { const p = { id: `pay-${liabDb.payments.length + 1}`, ...row }; liabDb.payments.push(p); return p; },
    getLiabilityPayments: async () => liabDb.payments,
    updateOccurrenceOverride: async () => {},
    createExpense: async (e: any) => e,
    updateTask: async () => undefined,
    deleteExpense: async (id: string) => { db.deleted.push(id); db.expenses = db.expenses.filter((e) => e.id !== id); return true; },
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

describe("the assistant never deletes on an ambiguous match", () => {
  it("two expenses share a description: it asks, and deletes nothing", async () => {
    const res: any = await executeTool("delete_expense", { description: "Coffee" }, "u1");
    expect(res.error).toMatch(/multiple matches/i);
    expect(res.candidates?.length).toBeGreaterThan(1);
    expect(db.deleted).toEqual([]);
    expect(db.expenses).toHaveLength(4);
  });

  it("a description that only one expense contains is deleted, and only that one", async () => {
    const res: any = await executeTool("delete_expense", { description: "Coffee beans" }, "u1");
    expect(res.error).toBeUndefined();
    expect(res.deleted).toBe(true);
    expect(db.deleted).toEqual(["e-beans"]);
    expect(db.expenses.map((e) => e.id).sort()).toEqual(["e-coffee", "e-coffee2", "e-rent"]);
  });

  it("a description matching nothing deletes nothing and says so", async () => {
    const res: any = await executeTool("delete_expense", { description: "Helicopter" }, "u1");
    expect(res.error).toMatch(/not found/i);
    expect(db.deleted).toEqual([]);
  });

  it("an empty description is refused rather than matching the first row", async () => {
    const res: any = await executeTool("delete_expense", { description: "" }, "u1");
    expect(res.error).toBeTruthy();
    expect(db.deleted).toEqual([]);
  });

  it("the ambiguous answer names the candidates so the user can choose", async () => {
    const res: any = await executeTool("delete_expense", { description: "Coffee" }, "u1");
    const names = (res.candidates || []).map((c: any) => c.name);
    expect(names.every((n: string) => typeof n === "string" && n.length > 0)).toBe(true);
    expect(new Set((res.candidates || []).map((c: any) => c.id)).size).toBe((res.candidates || []).length);
  });
});

// ── Paying a debt is destructive too: the wrong balance is the wrong money.
describe("the assistant never pays an ambiguous debt", () => {
  it("two cards share a word: a payment naming only that word must ask, not pick one", async () => {
    const res: any = await executeTool("add_liability_payment", { liabilityName: "Chase", amount: 200 }, "u1");
    const paidOne = liabDb.payments.length > 0;
    expect(res.error, `paid ${JSON.stringify(liabDb.payments[0] || null)} without asking`).toMatch(/which|multiple|be more specific/i);
    expect(paidOne).toBe(false);
    expect(liabDb.balances()).toEqual({ "l-sapphire": 1000, "l-freedom": 2000 });
  });

  it("a payment naming one card exactly still goes through, to that card only", async () => {
    const res: any = await executeTool("add_liability_payment", { liabilityName: "Chase Freedom", amount: 200 }, "u1");
    expect(res.error).toBeUndefined();
    expect(liabDb.payments).toHaveLength(1);
    expect(liabDb.payments[0].liabilityProfileId).toBe("l-freedom");
    expect(liabDb.balances()["l-sapphire"]).toBe(1000);
  });

  it("a name that matches nothing is reported, not applied to whatever is first", async () => {
    const res: any = await executeTool("add_liability_payment", { liabilityName: "Barclays", amount: 50 }, "u1");
    expect(res.error).toMatch(/not found/i);
    expect(liabDb.payments).toHaveLength(0);
  });
});
