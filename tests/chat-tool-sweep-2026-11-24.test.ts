// Defects found by sending one command per chat tool to the deployed app
// (scripts/verify-all-chat-tools.ts, 2026-11-24). Each test drives the REAL
// engine's executeTool against an in-memory store; the model is never called.
import { describe, it, expect, beforeEach, vi } from "vitest";

const db = { expenses: [] as any[], documents: [] as any[], modelCalls: 0 };

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/New_York",
    getProfiles: async () => [{ id: "p-self", name: "Robert", type: "self", fields: {} }, { id: "p-alice", name: "Alice", type: "person", fields: {} }],
    getDocuments: async () => db.documents,
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

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => { db.modelCalls++; throw new Error("model unavailable in this test"); },
      stream: () => { db.modelCalls++; throw new Error("model unavailable in this test"); },
    };
  },
}));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
let TOOL_ACTION_MAP: Record<string, string>;

beforeEach(async () => {
  db.expenses = [
    { id: "e-coffee", description: "Corner Coffee", amount: 14.5, category: "food", date: "2026-11-24", tags: [], linkedProfiles: ["p-self"] },
    { id: "e-shoes", description: "Trail Shoes", amount: 90, category: "shopping", date: "2026-11-20", tags: [], linkedProfiles: ["p-self"] },
  ];
  db.modelCalls = 0;
  db.documents = [
    // Types like these hold the letters "me": docuMEnt, stateMEnt, MEdical.
    { id: "d-warranty", name: "Truck Warranty 2026", type: "document", mimeType: "application/pdf", extractedData: {}, linkedProfiles: ["p-self", "p-alice"], tags: [] },
    { id: "d-statement", name: "Bank Statement October", type: "statement", mimeType: "application/pdf", extractedData: {}, linkedProfiles: ["p-self"], tags: [] },
    { id: "d-license", name: "Drivers License", type: "id", mimeType: "image/jpeg", extractedData: {}, linkedProfiles: ["p-self"], tags: [] },
  ];
  ({ executeTool, processMessage, TOOL_ACTION_MAP } = await import("../server/ai-engine") as any);
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

describe("\"show me …\" opens a document only when it names one", () => {
  const opened = (res: any): string[] =>
    (res?.actions || []).filter((a: any) => a?.type === "retrieve").map((a: any) => String(a?.data?.documentId));

  it("a chart request is not answered with a document (it was: \"Here's 'Zqhfxb Warranty 2026'\")", async () => {
    const res = await processMessage("Show me a bar chart of my expenses by category", [], "user-1");
    expect(opened(res)).toEqual([]);
    expect(String(res?.reply || "")).not.toMatch(/Here's "/);
  });

  it("the little words name no document: me, my, of, by, all", async () => {
    for (const msg of ["Show me all of my stuff", "Show me my tasks", "Show me what I have by month", "Get me everything"]) {
      const res = await processMessage(msg, [], "user-1");
      expect(opened(res), msg).toEqual([]);
    }
  });

  it("a document that IS named still opens at once, without the model", async () => {
    const warranty = await processMessage("Show me my warranty", [], "user-1");
    expect(opened(warranty)).toEqual(["d-warranty"]);
    const license = await processMessage("open my drivers license", [], "user-1");
    expect(opened(license)).toEqual(["d-license"]);
    const statement = await processMessage("Show me the bank statement", [], "user-1");
    expect(opened(statement)).toEqual(["d-statement"]);
    const alices = await processMessage("show Alice's warranty", [], "user-1");
    expect(opened(alices)).toEqual(["d-warranty"]);
    expect(db.modelCalls).toBe(0);
  });
});
