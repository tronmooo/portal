// ── Fast-lane escalation, end to end through the REAL processMessage ─────────
// The user's (justified) skepticism: "we tried Haiku before and it didn't
// work" — in May 2026 Haiku replied "✅ Logged everything!" with ZERO tool
// calls and the loop trusted the text, so nothing hit the database.
//
// This test reproduces that exact failure with a scripted fake Anthropic
// client and proves the fast lane's guard converts it into a transparent
// Sonnet re-run instead of a fake confirmation:
//   1. Haiku returns text-only  → Sonnet is called, Haiku's words discarded.
//   2. Haiku picks a forbidden tool (delete) → Sonnet is called, no delete runs.
//   3. Haiku behaves → ONE model call total, a real (stubbed) DB write, and a
//      recap generated from the verified write — not from model text.
//   4. A complex question never touches Haiku — first call is Sonnet.
//   5. A Haiku API failure escalates instead of failing the message.
// No API key, no network: the Anthropic SDK and the storage layer are mocked.
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.mock factories are hoisted above top-level code, so everything they
// touch must live in vi.hoisted().
const h = vi.hoisted(() => {
  const HAIKU = "claude-haiku-4-5-20251001";
  const SONNET = "claude-sonnet-4-6";

  type FakeResponse = { content: any[]; stop_reason: string };
  const state = {
    modelCalls: [] as string[],
    // Scripted response per (model, nth call of that model); may throw to
    // simulate an API failure.
    script: ((_model: string, _nth: number) => ({ content: [], stop_reason: "end_turn" })) as (model: string, nth: number) => FakeResponse,
    writes: { createExpense: 0, deleteExpense: 0 },
    expenses: [] as any[],
  };

  const fakeCreate = async (params: any) => {
    const model = String(params.model);
    state.modelCalls.push(model);
    const nth = state.modelCalls.filter((m) => m === model).length;
    const scripted = state.script(model, nth);
    return {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model,
      usage: { input_tokens: 10, output_tokens: 10 },
      ...scripted,
    };
  };

  class FakeAnthropic {
    // The fast lane calls messages.stream (inactivity-timer streaming); the
    // agent loop uses messages.create when SSE is off. Both are scripted from
    // the same per-model responses; stream returns the MessageStream surface
    // the code touches (.on + .finalMessage).
    messages = {
      create: fakeCreate,
      stream: (params: any, _opts?: any) => {
        const done = fakeCreate(params);
        return { on: (_ev: string, _cb: any) => { /* no-op */ }, finalMessage: () => done };
      },
    };
    constructor(_opts: any) { /* apiKey ignored */ }
  }

  // Stateful storage stub. The envelope read-back (finalizeToolResult)
  // verifies a create by re-listing the entity type, so createExpense must
  // make the row visible to getExpenses.
  const explicit: Record<string, any> = {
    getPreference: async () => null,
    getSelfProfile: async () => null,
    getProfiles: async () => [],
    getExpenses: async () => state.expenses,
    createExpense: async (input: any) => {
      state.writes.createExpense++;
      const row = { id: `exp-${state.writes.createExpense}`, createdAt: new Date().toISOString(), linkedProfiles: [], ...input };
      state.expenses.push(row);
      return row;
    },
    deleteExpense: async () => { state.writes.deleteExpense++; return { ok: true }; },
    createAiActionLog: async () => ({ id: "log-1" }),
  };

  // Everything else (context getters, link tables, …) returns an empty list.
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

  return { HAIKU, SONNET, state, FakeAnthropic, stubStorage };
});

vi.mock("@anthropic-ai/sdk", () => ({ default: h.FakeAnthropic }));

vi.mock("../server/storage", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, storage: h.stubStorage };
});

import { processMessage } from "../server/ai-engine";

const { HAIKU, SONNET, state } = h;
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (name: string, input: any) => ({ type: "tool_use", id: `tu-${name}`, name, input });

beforeEach(() => {
  state.modelCalls.length = 0;
  state.writes.createExpense = 0;
  state.writes.deleteExpense = 0;
  state.expenses.length = 0;
});

describe("fast-lane escalation through the real processMessage", () => {
  it("May-2026 failure mode: Haiku returns text-only → Sonnet re-run completes the write, fake confirmation discarded", async () => {
    // Haiku lies ("Logged!" with no tool calls). The scripted Sonnet behaves
    // like a real turn: round 1 emits the tool call, round 2 recaps.
    state.script = (model, nth) => {
      if (model === HAIKU) return { content: [text("✅ Logged everything!")], stop_reason: "end_turn" }; // the lie
      return nth === 1
        ? { content: [toolUse("create_expense", { amount: 5, description: "coffee" })], stop_reason: "tool_use" }
        : { content: [text("Logged your $5 coffee — saved to Finance.")], stop_reason: "end_turn" };
    };

    const result = await processMessage("log a $5 coffee expense", undefined, "user-1");

    expect(state.modelCalls[0]).toBe(HAIKU);      // fast lane tried first
    expect(state.modelCalls).toContain(SONNET);   // and escalated to the real loop
    expect(result.reply).toBe("Logged your $5 coffee — saved to Finance.");
    expect(result.reply).not.toContain("Logged everything"); // Haiku's lie never reaches the user
    expect(state.writes.createExpense).toBe(1);   // the write came from the Sonnet round, not Haiku
    expect((result as any).meta?.route).not.toBe("fast-lane");
  });

  it("off-allowlist tool: Haiku tries delete_expense → escalates, delete never executes", async () => {
    state.script = (model, nth) => {
      if (model === HAIKU) return { content: [toolUse("delete_expense", { description: "bagel" })], stop_reason: "tool_use" };
      return nth === 1
        ? { content: [toolUse("create_expense", { amount: 7, description: "bagel" })], stop_reason: "tool_use" }
        : { content: [text("Logged the bagel expense.")], stop_reason: "end_turn" };
    };

    const result = await processMessage("log a $7 bagel expense", undefined, "user-1");

    expect(state.modelCalls[0]).toBe(HAIKU);
    expect(state.modelCalls).toContain(SONNET);
    expect(state.writes.deleteExpense).toBe(0);   // the forbidden delete never ran
    expect(state.writes.createExpense).toBe(1);   // Sonnet handled it properly instead
    expect(result.reply).toBe("Logged the bagel expense.");
  });

  it("happy path: valid create_expense → ONE model call, real write, recap built from the verified write", async () => {
    state.script = (model) =>
      model === HAIKU
        ? { content: [text("On it."), toolUse("create_expense", { amount: 6, description: "latte" })], stop_reason: "tool_use" }
        : { content: [text("SONNET SHOULD NOT RUN")], stop_reason: "end_turn" };

    const result = await processMessage("log a $6 latte expense", undefined, "user-1");

    expect(state.modelCalls).toEqual([HAIKU]);    // no Sonnet round at all
    expect(state.writes.createExpense).toBe(1);   // the write actually happened
    expect(state.expenses[0].amount).toBe(6);
    expect(state.expenses[0].description).toBe("latte");
    expect((result as any).meta?.route).toBe("fast-lane");
    // Reply is the deterministic recap from the verified operation — NOT the
    // model's own words ("On it.") and NOT a fabricated confirmation.
    expect(result.reply).toContain("✅");
    expect(result.reply).toContain("latte");
    expect(result.reply).not.toContain("On it.");
    // The per-operation report the client renders shows a verified ok.
    const ops = (result as any).operations;
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("ok");
    expect(ops[0].tool).toBe("create_expense");
    expect(ops[0].entityId).toBe("exp-1");
  });

  it("complex question: never touches Haiku — first model call is Sonnet", async () => {
    state.script = () => ({ content: [text("You spent $123 this month.")], stop_reason: "end_turn" });

    const result = await processMessage("how much did I spend this month?", undefined, "user-1");

    expect(state.modelCalls.length).toBeGreaterThan(0);
    expect(state.modelCalls[0]).toBe(SONNET);
    expect(state.modelCalls).not.toContain(HAIKU);
    expect(result.reply).toBe("You spent $123 this month.");
  });

  it("Haiku API failure → escalates instead of failing the message", async () => {
    state.script = (model, nth) => {
      if (model === HAIKU) throw new Error("simulated network failure");
      return nth === 1
        ? { content: [toolUse("create_expense", { amount: 4, description: "green tea" })], stop_reason: "tool_use" }
        : { content: [text("Logged the green tea.")], stop_reason: "end_turn" };
    };

    const result = await processMessage("log a $4 green tea expense", undefined, "user-1");

    expect(state.modelCalls[0]).toBe(HAIKU);
    expect(state.modelCalls).toContain(SONNET);
    expect(result.reply).toBe("Logged the green tea.");
  });
});
