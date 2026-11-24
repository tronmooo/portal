// Defects found by sending one command per chat tool to the deployed app
// (scripts/verify-all-chat-tools.ts, 2026-11-24). Each test drives the REAL
// engine's executeTool against an in-memory store; the model is never called.
import { describe, it, expect, beforeEach, vi } from "vitest";

const db = { expenses: [] as any[] };

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/New_York",
    getProfiles: async () => [{ id: "p-self", name: "Robert", type: "self", fields: {} }],
    getSelfProfile: async () => ({ id: "p-self", name: "Robert", type: "self", fields: {} }),
    getPreference: async () => null,
    getExpenses: async () => db.expenses,
    getExpense: async (id: string) => db.expenses.find((e) => e.id === id),
    deleteExpense: async (id: string) => {
      const had = db.expenses.some((e) => e.id === id);
      db.expenses = db.expenses.filter((e) => e.id !== id);
      return had;
    },
    updateExpense: async (id: string, patch: any) => {
      const e = db.expenses.find((x) => x.id === id);
      if (!e) return undefined;
      Object.assign(e, patch);
      return e;
    },
  };
  const storage = new Proxy(impl, { get: (target, prop: string) => (prop in target ? target[prop] : async () => []) });
  return { storage };
});

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
let TOOL_ACTION_MAP: Record<string, string>;

beforeEach(async () => {
  db.expenses = [
    { id: "e-coffee", description: "Corner Coffee", amount: 14.5, category: "food", date: "2026-11-24", tags: [], linkedProfiles: ["p-self"] },
    { id: "e-shoes", description: "Trail Shoes", amount: 90, category: "shopping", date: "2026-11-20", tags: [], linkedProfiles: ["p-self"] },
  ];
  ({ executeTool, TOOL_ACTION_MAP } = await import("../server/ai-engine") as any);
});

describe("a refund says what it did", () => {
  it("a full refund removes the expense and says so (it read \"Updated expense.\")", async () => {
    const res = await executeTool("refund_expense", { expenseDescription: "Corner Coffee" });
    expect(res.error).toBeUndefined();
    expect(db.expenses.map((e) => e.id)).toEqual(["e-shoes"]);
    expect(res.result).toMatchObject({ fullRefund: true, refunded: 14.5, expenseId: "e-coffee" });
    expect(res.message).toBe('Refunded $14.50 in full for "Corner Coffee". It is no longer counted in your spending.');
  });

  it("a partial refund lowers the expense and names both figures", async () => {
    const res = await executeTool("refund_expense", { expenseDescription: "Trail Shoes", amount: 40 });
    expect(db.expenses.find((e) => e.id === "e-shoes")?.amount).toBe(50);
    expect(res.result).toMatchObject({ fullRefund: false, refunded: 40, newAmount: 50 });
    expect(res.message).toBe('Refunded $40.00 of "Trail Shoes". It now counts as $50.00.');
    // The other expense is untouched.
    expect(db.expenses.find((e) => e.id === "e-coffee")?.amount).toBe(14.5);
  });

  it("its card is a refund's, not \"Log Expense\"", async () => {
    const { genericActionLabel, actionCardSubject } = await import("../shared/chat-action-card");
    const type = TOOL_ACTION_MAP.refund_expense;
    expect(type).not.toBe("log_expense");
    const data = { expenseDescription: "Corner Coffee", _tool: "refund_expense" };
    expect(genericActionLabel(type, data)).toBe("Refund recorded");
    expect(actionCardSubject(data)).toBe("Corner Coffee");
  });
});
