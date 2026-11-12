// 2026-11-12 report: "Yesterday I spent $65 at Walmart, $42 on gas, and $18 on
// lunch. I also earned $230 doing deliveries." came back as "I wasn't able to
// complete that — nothing was saved." The model had answered in prose
// ("✅ Logged everything!") without calling a tool; the final claim gate
// correctly refused to show that as success, but the turn ended there and the
// user had to retype the message. The loop now gives the model one more round,
// told that nothing was saved, and the writes land in the same turn.
//
// Drives the REAL processMessage loop against an in-memory store; only the
// model's responses are scripted.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { shouldRetryUnbackedWriteClaim } from "../shared/ai-claim-check";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const SELF = { id: "p-self", name: "Robert", type: "self", fields: {} };
const MESSAGE = "Yesterday I spent $65 at Walmart, $42 on gas, and $18 on lunch. I also earned $230 doing deliveries.";

const db = {
  expenses: [] as any[],
  incomes: [] as any[],
  modelRequests: [] as any[],
  script: [] as Array<"prose" | "tools" | "summary" | "answer">,
};

vi.mock("../server/storage", () => {
  const uuid = (p: string, n: number) => `${p}${n}`.padEnd(8, "0") + "-0000-4000-8000-000000000000";
  const impl: Record<string, any> = {
    _timezone: "America/New_York",
    getProfiles: async () => [SELF],
    getSelfProfile: async () => SELF,
    getPreference: async () => null,
    getExpenses: async () => db.expenses,
    getExpense: async (id: string) => db.expenses.find((r) => r.id === id),
    getIncomes: async () => db.incomes,
    getIncome: async (id: string) => db.incomes.find((r) => r.id === id),
    createExpense: async (d: any) => {
      const r = { id: uuid("e", db.expenses.length + 1), createdAt: new Date().toISOString(), ...d };
      db.expenses.push(r);
      return r;
    },
    createIncome: async (d: any) => {
      const r = { id: uuid("1", db.incomes.length + 1), createdAt: new Date().toISOString(), ...d };
      db.incomes.push(r);
      return r;
    },
  };
  const storage = new Proxy(impl, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (/^(create|update|delete|log|checkin|complete|set|save)/.test(prop)) return async () => undefined;
      return async () => [];
    },
  });
  return { storage };
});

const msg = (stop_reason: string, content: any[]) => ({
  id: "m", type: "message", role: "assistant", model: "x", stop_reason, usage: { input_tokens: 1, output_tokens: 1 }, content,
});
const RESPONSES = {
  prose: () => msg("end_turn", [{ type: "text", text: "✅ Logged everything! I've added your 3 expenses from yesterday and recorded $230 income from deliveries." }]),
  tools: () => msg("tool_use", [
    { type: "tool_use", id: "t1", name: "create_expense", input: { amount: 65, description: "Walmart", vendor: "Walmart", category: "groceries", date: "2026-11-11" } },
    { type: "tool_use", id: "t2", name: "create_expense", input: { amount: 42, description: "Gas", category: "transportation", date: "2026-11-11" } },
    { type: "tool_use", id: "t3", name: "create_expense", input: { amount: 18, description: "Lunch", category: "food", date: "2026-11-11" } },
    { type: "tool_use", id: "t4", name: "log_income", input: { amount: 230, source: "Deliveries", date: "2026-11-11" } },
  ]),
  summary: () => msg("end_turn", [{ type: "text", text: "Logged 3 expenses ($125) and $230 income from deliveries for yesterday." }]),
  answer: () => msg("end_turn", [{ type: "text", text: "You spent $125 yesterday." }]),
};

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async (req: any) => {
        // Only the chat tool loop sends tools; any side call (classifiers) is unavailable.
        if (!req?.tools) throw new Error("side model call unavailable in this test");
        db.modelRequests.push(JSON.parse(JSON.stringify(req))); // the engine mutates its messages array
        const next = db.script.shift();
        if (!next) throw new Error("model script exhausted");
        return RESPONSES[next]();
      },
      stream: () => { throw new Error("streaming not used in this test"); },
    };
  },
}));

let processMessage: (msg: string, history?: any[], userId?: string) => Promise<any>;
beforeEach(async () => {
  db.expenses = [];
  db.incomes = [];
  db.modelRequests = [];
  db.script = [];
  ({ processMessage } = await import("../server/ai-engine"));
});

describe("a write the model claims in prose without calling a tool", () => {
  it("is retried in the same turn and every expense and the income are saved (the reported failure)", async () => {
    db.script = ["prose", "tools", "summary"];
    const res = await processMessage(MESSAGE, [], "u1");
    expect(db.expenses.map((e) => e.amount)).toEqual([65, 42, 18]);
    expect(db.incomes.map((i) => i.amount)).toEqual([230]);
    expect(String(res.reply)).not.toMatch(/nothing was saved|wasn't able|didn't actually/i);
    expect((res.actions as any[]).length).toBe(4);
    // The retry told the model nothing was saved.
    const retryTurn = db.modelRequests[1].messages.at(-1);
    expect(retryTurn.role).toBe("user");
    expect(String(retryTurn.content)).toMatch(/NOTHING was saved/);
  });

  it("retries only once: a model that keeps answering in prose ends in the honest failure", async () => {
    db.script = ["prose", "prose"];
    const res = await processMessage(MESSAGE, [], "u1");
    expect(db.modelRequests.length).toBe(2);
    expect(db.expenses).toEqual([]);
    expect(String(res.reply)).toMatch(/nothing was saved|didn't actually execute/i);
  });

  it("does not retry when the model called the tools the first time", async () => {
    db.script = ["tools", "summary"];
    await processMessage(MESSAGE, [], "u1");
    // No retry instruction was ever sent.
    expect(JSON.stringify(db.modelRequests)).not.toMatch(/NOTHING was saved/);
    expect(db.expenses.length).toBe(3);
    expect(db.incomes.length).toBe(1);
  });

  it("does not retry a plain answer to a question", async () => {
    db.script = ["answer"];
    await processMessage("how much did I spend yesterday?", [], "u1");
    expect(db.modelRequests.length).toBe(1);
  });
});

describe("shouldRetryUnbackedWriteClaim", () => {
  it("fires on a claimed write with zero tool calls", () => {
    expect(shouldRetryUnbackedWriteClaim({ reply: "✅ Logged everything!", toolCallsSoFar: 0, readOnlyTurn: false })).toBe(true);
    expect(shouldRetryUnbackedWriteClaim({ reply: "I've added your 3 expenses.", toolCallsSoFar: 0, readOnlyTurn: false })).toBe(true);
    expect(shouldRetryUnbackedWriteClaim({ reply: "Done!", toolCallsSoFar: 0, readOnlyTurn: false })).toBe(true);
  });
  it("does not fire on questions, offers, read turns, or after a tool ran", () => {
    expect(shouldRetryUnbackedWriteClaim({ reply: "Which day was the Walmart trip?", toolCallsSoFar: 0, readOnlyTurn: false })).toBe(false);
    expect(shouldRetryUnbackedWriteClaim({ reply: "Want me to log these as expenses?", toolCallsSoFar: 0, readOnlyTurn: false })).toBe(false);
    expect(shouldRetryUnbackedWriteClaim({ reply: "I've logged it.", toolCallsSoFar: 0, readOnlyTurn: true })).toBe(false);
    expect(shouldRetryUnbackedWriteClaim({ reply: "I've logged it.", toolCallsSoFar: 2, readOnlyTurn: false })).toBe(false);
  });
});
