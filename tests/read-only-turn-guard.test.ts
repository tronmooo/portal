// Rule 1 (enforced) + Rule 2 (idempotent operations), end to end through the
// engine with a scripted model and an in-memory storage.
//
//   · A READ message on which the model still emits a write tool writes
//     NOTHING, and the user's question is answered.
//   · The same request id replayed does not run its write a second time; the
//     ledger row from the first run answers.
//   · The storage proxy refuses write methods inside a read-only scope even
//     when called directly (the backstop under every fast path).
import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.ANTHROPIC_API_KEY = "test-key-not-used";

const SELF = { id: "p-self", name: "Me", type: "self", fields: {} };

type Row = Record<string, any>;
const db: { tasks: Row[]; incomes: Row[]; expenses: Row[]; ledger: Row[] } = { tasks: [], incomes: [], expenses: [], ledger: [] };
const calls: string[] = [];

function reseed() {
  db.tasks = []; db.incomes = []; db.expenses = []; db.ledger = []; calls.length = 0;
}

vi.mock("../server/storage", () => {
  const impl: Record<string, any> = {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF],
    getSelfProfile: async () => SELF,
    getTasks: async () => db.tasks,
    getTask: async (id: string) => db.tasks.find((t) => t.id === id),
    createTask: async (data: Row) => { calls.push("createTask"); const t = { id: `task${db.tasks.length + 1}`, ...data }; db.tasks.push(t); return t; },
    getIncomes: async () => db.incomes,
    getIncome: async (id: string) => db.incomes.find((t) => t.id === id),
    createIncome: async (data: Row) => { calls.push("createIncome"); const t = { id: `inc${db.incomes.length + 1}`, ...data }; db.incomes.push(t); return t; },
    getExpenses: async () => db.expenses,
    createExpense: async (data: Row) => { calls.push("createExpense"); const e = { id: `exp${db.expenses.length + 1}`, ...data }; db.expenses.push(e); return e; },
    createAiActionLog: async (entry: Row) => {
      const existing = entry.operationId && db.ledger.find((r) => r.operationId === entry.operationId);
      if (existing) return existing;
      const row = { id: `log${db.ledger.length + 1}`, createdAt: new Date().toISOString(), undoneAt: null, ...entry };
      db.ledger.push(row);
      return row;
    },
    findAiActionByOperationId: async (operationId: string) => db.ledger.find((r) => r.operationId === operationId),
    listAiActionLog: async () => db.ledger,
    getPreference: async () => null,
    getMemories: async () => [],
    getHabits: async () => [],
    getGoals: async () => [],
    getObligations: async () => [],
    getDocuments: async () => [],
    getJournalEntries: async () => [],
    getTrackers: async () => [],
    getEvents: async () => [],
  };
  return { storage: new Proxy(impl, { get: (t, p: string) => (p in t ? t[p] : async () => []) }) };
});

let script: Array<{ content: any[]; stop_reason?: string }> = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: async () => script.shift() ?? { content: [{ type: "text", text: "" }], stop_reason: "end_turn" },
    };
  },
}));

const use = (name: string, input: Row, id = `tu_${name}_${Math.random().toString(36).slice(2, 7)}`) =>
  ({ type: "tool_use", id, name, input });
const round = (...c: Row[]) => ({ content: c, stop_reason: "tool_use" });
const done = (text = "") => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

let processMessage: (msg: string, history?: any[], userId?: string, options?: any) => Promise<any>;
beforeEach(async () => {
  reseed();
  script = [];
  ({ processMessage } = await import("../server/ai-engine"));
});

describe("Rule 1 — a READ turn cannot write, whatever the model decides", () => {
  it("refuses a replayed log_income on a read-only follow-up and still answers", async () => {
    script = [
      round(use("log_income", { amount: 2500, source: "Acme paycheck" })),
      done("Your Acme paycheck of $2,500 was saved under Income on the Finance page."),
    ];
    const res = await processMessage("Where did that income save?", [
      { role: "user", content: "log my $2500 Acme paycheck" },
      { role: "assistant", content: "Logged $2,500 from Acme." },
    ], "u1", { requestId: "req_read_1" });
    expect(calls).toEqual([]);
    expect(db.incomes).toHaveLength(0);
    expect(res.reply).toMatch(/Finance page/);
    // Nothing is reported to the user as a failed action — the refusal is the
    // model's business, the answer is the user's.
    expect((res.operations || []).filter((o: Row) => o.status === "failed")).toHaveLength(0);
    expect(res.mutations ?? []).toHaveLength(0);
  });

  it("still writes on a request for a change", async () => {
    script = [
      round(use("create_task", { title: "Call mom" })),
      done("Added the task."),
    ];
    await processMessage("add a task to call mom", [], "u1", { requestId: "req_write_1" });
    expect(calls).toEqual(["createTask"]);
    expect(db.tasks).toHaveLength(1);
  });
});

describe("Rule 2 — the same request replayed does not write twice", () => {
  it("returns the ledger row instead of re-running the tool", async () => {
    const turn = () => [
      round(use("create_task", { title: "Call mom" })),
      done("Added the task."),
    ];
    script = turn();
    const first = await processMessage("add a task to call mom", [], "u1", { requestId: "req_same", sourceMessageId: "req_same" });
    expect(db.tasks).toHaveLength(1);
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0].requestId).toBe("req_same");
    expect(db.ledger[0].operationId).toMatch(/^op_create_task_/);
    expect(db.ledger[0].turnId).toBe(first.turnId);

    script = turn();
    const second = await processMessage("add a task to call mom", [], "u1", { requestId: "req_same", sourceMessageId: "req_same" });
    expect(calls.filter((c) => c === "createTask")).toHaveLength(1);
    expect(db.tasks).toHaveLength(1);
    expect(db.ledger).toHaveLength(1);
    const replayed = (second.operations || []).find((o: Row) => o.tool === "create_task");
    expect(replayed?.status).toBe("deduped");
  });

  it("keeps two identical calls in ONE request as two operations", async () => {
    script = [
      round(use("create_task", { title: "Drink water" }), use("create_task", { title: "Drink water" })),
      done("Added both."),
    ];
    await processMessage("add a task to drink water twice", [], "u1", { requestId: "req_two" });
    const ids = db.ledger.map((r) => r.operationId);
    // The duplicate-create-in-turn gate may refuse the second identical
    // create; what must NOT happen is the two collapsing to one operation id.
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Rule 1 — the storage-level backstop", () => {
  it("refuses a write-shaped storage method inside a read-only scope and logs the anomaly", async () => {
    const { runWithMutationScope, assertMutationAllowed, isReadOnlyTurnError } = await import("../server/mutation-scope");
    const { getIntegrityRecords, clearIntegrityRecords } = await import("../server/integrity-log");
    clearIntegrityRecords();
    expect(() => assertMutationAllowed("createExpense")).not.toThrow();
    let caught: unknown;
    runWithMutationScope({ intent: "READ", allowedMutations: "none", turnId: "t1", requestId: "r1", userId: "u1" }, () => {
      try { assertMutationAllowed("createExpense"); } catch (e) { caught = e; }
      expect(() => assertMutationAllowed("getExpenses")).not.toThrow(); // reads are never refused
    });
    expect(isReadOnlyTurnError(caught)).toBe(true);
    const anomalies = getIntegrityRecords(10, "ai_read_triggered_write");
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].detail).toMatchObject({ method: "createExpense" });
    // A write scope refuses nothing.
    runWithMutationScope({ intent: "CREATE", allowedMutations: "all" }, () => {
      expect(() => assertMutationAllowed("createExpense")).not.toThrow();
    });
  });
});
