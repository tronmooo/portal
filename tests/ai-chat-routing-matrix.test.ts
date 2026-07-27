// ── Chat routing matrix — every query class through the REAL processMessage ──
// Proves the dispatch "deciphers" correctly with a scripted fake model:
//   • multi-action within fast-lane capacity → ONE Haiku round, both writes land
//   • Haiku fans out too wide → escalates, Sonnet completes the work
//   • 4+ action recap → bulk extraction path (Sonnet), Haiku never called
//   • command + question in one message → straight to Sonnet
//   • destructive command → straight to Sonnet, delete executes there
//   • read query → straight to Sonnet
//   • chitchat → straight to Sonnet
//   • follow-up with history → fast lane still sees the conversation
// No API key, no network: Anthropic SDK and storage are mocked; everything
// between (eligibility gate, guard, executors, envelope verify) is real code.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const HAIKU = "claude-haiku-4-5-20251001";
  const SONNET = "claude-sonnet-4-6";

  type FakeResponse = { content: any[]; stop_reason: string };
  interface CallRecord { model: string; toolChoice?: string; messagesLen: number }
  const state = {
    calls: [] as CallRecord[],
    script: ((_model: string, _nth: number, _params: any) => ({ content: [], stop_reason: "end_turn" })) as (model: string, nth: number, params: any) => FakeResponse,
    writes: { createExpense: 0, createTask: 0, deleteExpense: 0 },
    expenses: [] as any[],
    tasks: [] as any[],
  };
  const models = () => state.calls.map((c) => c.model);

  const fakeCreate = async (params: any) => {
    const model = String(params.model);
    state.calls.push({
      model,
      toolChoice: params.tool_choice?.name,
      messagesLen: Array.isArray(params.messages) ? params.messages.length : 0,
    });
    const nth = state.calls.filter((c) => c.model === model).length;
    const scripted = state.script(model, nth, params);
    return { id: "msg_fake", type: "message", role: "assistant", model, usage: { input_tokens: 10, output_tokens: 10 }, ...scripted };
  };

  class FakeAnthropic {
    messages = { create: fakeCreate, stream: () => { throw new Error("stream not scripted"); } };
    constructor(_opts: any) { /* apiKey ignored */ }
  }

  const explicit: Record<string, any> = {
    getPreference: async () => null,
    getSelfProfile: async () => null,
    getProfiles: async () => [],
    getExpenses: async () => state.expenses,
    getTasks: async () => state.tasks,
    createExpense: async (input: any) => {
      state.writes.createExpense++;
      const row = { id: `exp-${state.writes.createExpense}`, createdAt: new Date().toISOString(), linkedProfiles: [], ...input };
      state.expenses.push(row);
      return row;
    },
    createTask: async (input: any) => {
      state.writes.createTask++;
      const row = { id: `task-${state.writes.createTask}`, createdAt: new Date().toISOString(), status: "todo", linkedProfiles: [], ...input };
      state.tasks.push(row);
      return row;
    },
    deleteExpense: async (id: string) => {
      state.writes.deleteExpense++;
      state.expenses = state.expenses.filter((e) => e.id !== id);
      return { ok: true };
    },
    createAiActionLog: async () => ({ id: "log-1" }),
  };

  const stubStorage: any = new Proxy(
    { _timezone: "America/New_York" },
    {
      get(target: any, prop: string | symbol) {
        if (typeof prop !== "string") return (target as any)[prop];
        if (prop in explicit) return explicit[prop];
        if (prop in target) return target[prop];
        return async () => [];
      },
      set(target: any, prop: string | symbol, value: any) { (target as any)[prop] = value; return true; },
    },
  );

  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  delete process.env.AI_FAST_LANE;
  delete process.env.AI_CHAT_FRONTDOOR;
  delete process.env.ANTHROPIC_MODEL;

  return { HAIKU, SONNET, state, models, FakeAnthropic, stubStorage };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: h.FakeAnthropic }));
vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storage: h.stubStorage };
});

import { processMessage } from "../server/ai-engine";

const { HAIKU, SONNET, state, models } = h;
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (name: string, input: any, id = `tu-${name}`) => ({ type: "tool_use", id, name, input });

beforeEach(() => {
  state.calls.length = 0;
  state.writes.createExpense = 0;
  state.writes.createTask = 0;
  state.writes.deleteExpense = 0;
  state.expenses.length = 0;
  state.tasks.length = 0;
});

describe("chat routing matrix", () => {
  it("multiple actions in one simple message → ONE Haiku round, both writes land, recap lists both", async () => {
    state.script = (model) =>
      model === HAIKU
        ? {
            content: [
              toolUse("create_expense", { amount: 9, description: "sushi" }, "tu-1"),
              toolUse("create_task", { title: "call the bank" }, "tu-2"),
            ],
            stop_reason: "tool_use",
          }
        : { content: [text("SONNET SHOULD NOT RUN")], stop_reason: "end_turn" };

    const result = await processMessage("log $9 sushi and add a task to call the bank", undefined, "user-1");

    expect(models()).toEqual([HAIKU]);
    expect(state.writes.createExpense).toBe(1);
    expect(state.writes.createTask).toBe(1);
    expect((result as any).meta?.route).toBe("fast-lane");
    expect(result.reply).toContain("sushi");
    expect(result.reply).toContain("call the bank");
    const ops = (result as any).operations;
    expect(ops.map((o: any) => [o.tool, o.status])).toEqual([
      ["create_expense", "ok"],
      ["create_task", "ok"],
    ]);
  });

  it("Haiku fans out too wide (4 tool calls) → escalates, Sonnet completes the work instead", async () => {
    state.script = (model, nth) => {
      if (model === HAIKU) {
        return {
          content: [1, 2, 3, 4].map((i) => toolUse("create_expense", { amount: i, description: `overfan-${i}` }, `tu-${i}`)),
          stop_reason: "tool_use",
        };
      }
      return nth === 1
        ? { content: [toolUse("create_expense", { amount: 12, description: "groceries run" })], stop_reason: "tool_use" }
        : { content: [text("Logged the groceries.")], stop_reason: "end_turn" };
    };

    const result = await processMessage("log the $12 groceries", undefined, "user-1");

    expect(models()[0]).toBe(HAIKU);
    expect(models()).toContain(SONNET);
    // None of Haiku's over-fanned writes executed — only Sonnet's single one.
    expect(state.writes.createExpense).toBe(1);
    expect(state.expenses[0].description).toBe("groceries run");
    expect(result.reply).toBe("Logged the groceries.");
  });

  it("4+ action recap → bulk extraction path on Sonnet; Haiku never called", async () => {
    state.script = (model, _nth, params) => {
      if (params.tool_choice?.name === "extract_actions") {
        return {
          content: [
            toolUse("extract_actions", {
              operations: [
                { tool: "create_expense", input: { amount: 4, description: "breakfast burrito" }, raw: "ate breakfast" },
                { tool: "create_expense", input: { amount: 30, description: "water bill" }, raw: "paid the water bill" },
                { tool: "create_expense", input: { amount: 15, description: "pharmacy meds" }, raw: "took my meds" },
                { tool: "create_expense", input: { amount: 2, description: "post-run smoothie" }, raw: "ran 3 miles" },
              ],
            }),
          ],
          stop_reason: "tool_use",
        };
      }
      return { content: [text("unused")], stop_reason: "end_turn" };
    };

    const result = await processMessage(
      "I ate breakfast. I ran 3 miles. I took my meds. I paid the water bill.",
      undefined,
      "user-1",
    );

    // Exactly one model call: the Sonnet extraction. No Haiku, no agent loop.
    expect(models()).toEqual([SONNET]);
    expect(state.calls[0].toolChoice).toBe("extract_actions");
    expect(state.writes.createExpense).toBe(4);
    expect(result.reply).toContain("4 of 4");
    expect((result as any).operations.every((o: any) => o.status === "ok")).toBe(true);
  });

  it("command + question in one message → straight to Sonnet (fast lane never guesses)", async () => {
    state.script = (model, nth) => {
      if (model === HAIKU) throw new Error("HAIKU MUST NOT BE CALLED");
      return nth === 1
        ? { content: [toolUse("create_expense", { amount: 5, description: "espresso" })], stop_reason: "tool_use" }
        : { content: [text("Logged the espresso. You've spent $210 this month.")], stop_reason: "end_turn" };
    };

    const result = await processMessage("log a $5 espresso and how much did I spend this month?", undefined, "user-1");

    expect(models()[0]).toBe(SONNET);
    expect(models()).not.toContain(HAIKU);
    expect(state.writes.createExpense).toBe(1);
    expect(result.reply).toContain("Logged the espresso");
  });

  it("destructive command → straight to Sonnet, and the delete executes there", async () => {
    state.expenses.push({ id: "exp-gym", description: "gym membership", amount: 50, createdAt: new Date().toISOString(), linkedProfiles: [] });
    state.script = (model, nth) => {
      if (model === HAIKU) throw new Error("HAIKU MUST NOT BE CALLED");
      return nth === 1
        ? { content: [toolUse("delete_expense", { description: "gym membership" })], stop_reason: "tool_use" }
        : { content: [text("Deleted the gym membership expense.")], stop_reason: "end_turn" };
    };

    const result = await processMessage("delete my gym membership expense", undefined, "user-1");

    expect(models()[0]).toBe(SONNET);
    expect(models()).not.toContain(HAIKU);
    expect(state.writes.deleteExpense).toBe(1);
    expect(state.expenses.find((e) => e.id === "exp-gym")).toBeUndefined();
    expect(result.reply).toBe("Deleted the gym membership expense.");
  });

  it("read query → straight to Sonnet", async () => {
    state.script = (model) => {
      if (model === HAIKU) throw new Error("HAIKU MUST NOT BE CALLED");
      return { content: [text("You have 3 open tasks.")], stop_reason: "end_turn" };
    };

    const result = await processMessage("show my tasks", undefined, "user-1");

    expect(models()[0]).toBe(SONNET);
    expect(models()).not.toContain(HAIKU);
    expect(result.reply).toBe("You have 3 open tasks.");
  });

  it("chitchat → straight to Sonnet (no wasted Haiku round)", async () => {
    state.script = (model) => {
      if (model === HAIKU) throw new Error("HAIKU MUST NOT BE CALLED");
      return { content: [text("You're welcome!")], stop_reason: "end_turn" };
    };

    const result = await processMessage("thanks, that was great", undefined, "user-1");

    expect(models()[0]).toBe(SONNET);
    expect(models()).not.toContain(HAIKU);
    expect(result.reply).toBe("You're welcome!");
  });

  it("follow-up with history → fast lane sees the conversation, not just the last message", async () => {
    state.script = (model) =>
      model === HAIKU
        ? { content: [toolUse("create_expense", { amount: 6, description: "second latte" })], stop_reason: "tool_use" }
        : { content: [text("SONNET SHOULD NOT RUN")], stop_reason: "end_turn" };

    const history = [
      { role: "user" as const, content: "log a $6 latte" },
      { role: "assistant" as const, content: "✅ latte — $6" },
    ];
    const result = await processMessage("log another $6 latte", history, "user-1");

    expect(models()).toEqual([HAIKU]);
    // The Haiku call carried the prior turns (history + current = 3 messages).
    expect(state.calls[0].messagesLen).toBe(3);
    expect(state.writes.createExpense).toBe(1);
    expect((result as any).meta?.route).toBe("fast-lane");
  });
});
