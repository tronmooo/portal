// tests/chat-history-replay.test.ts
//
// BUG-20260809-history-reexec (user screenshots): after a dropped stream the
// client appends "…the connection dropped. Some of the changes may still have
// been applied." On the NEXT message, the model read that as "the previous
// request failed" and RE-EXECUTED the entire earlier turn — duplicate
// expense/nutrition/hydration cards appeared under an unrelated paycheck
// reply (and duplicate rows landed in the database).
//
// The defense is context, not hope: processMessage now injects the action
// ledger's recent completed writes ("RECENT COMPLETED ACTIONS") into the
// system prompt, plus an explicit only-the-newest-message-is-actionable rule.
// This suite pins BOTH onto the wire: the Anthropic SDK is mocked to capture
// the exact `system` blocks the model receives.
import { describe, it, expect, vi, beforeAll } from "vitest";

const { modelCalls, modelScript } = vi.hoisted(() => ({
  modelCalls: [] as any[],
  modelScript: [] as any[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: async (args: any) => {
        modelCalls.push(args);
        return modelScript.shift() ?? {
          content: [{ type: "text", text: "Logged your paycheck." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    };
  },
}));

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key-mocked-sdk";

import { MemStorage, requestStorageContext } from "../server/storage";
import { processMessage, executeTool } from "../server/ai-engine";
import { finalizeToolResult, buildTurnVerifyContext, recordActionLog } from "../server/ai-envelope";

const USER = "history-replay-user";

/** The exact dropped-connection notice chat.tsx appends on a mid-stream failure. */
const DROPPED_NOTICE =
  "That took too long or the connection dropped. Some of the changes may still have been applied — I've refreshed your data, so check the dashboard, or ask me \"what did you just change?\"";

function capturedSystemText(): string {
  return modelCalls
    .map(c => Array.isArray(c?.system) ? c.system.map((b: any) => b?.text || "").join("\n") : String(c?.system || ""))
    .join("\n");
}

describe("dropped-stream history must not re-execute earlier turns", () => {
  const storage = new MemStorage();

  beforeAll(async () => {
    // The earlier turn's writes DID land server-side (that's what the dropped
    // stream hides). Execute + record them exactly as a chat turn does.
    await requestStorageContext.run(storage, async () => {
      const ctx = buildTurnVerifyContext(storage);
      const input = { amount: 100, description: "Dinner at Chili's", category: "Food" };
      const raw = await executeTool("create_expense", input, USER);
      expect(raw?.error).toBeUndefined();
      const envelope = await finalizeToolResult("create_expense", "log_expense", input, raw, ctx);
      await recordActionLog(ctx, "create_expense", "log_expense", input, envelope, null);
    });
  });

  it("feeds the model the ledger's completed actions and the newest-message-only rule", async () => {
    modelCalls.length = 0;
    modelScript.length = 0;
    await requestStorageContext.run(storage, () =>
      processMessage(
        "My paycheck is about $2000 a month for the next year",
        [
          { role: "user", content: "I had dinner at Chili's for $100 with baby back ribs and some water" },
          { role: "assistant", content: DROPPED_NOTICE },
        ],
        USER,
      ));

    expect(modelCalls.length).toBeGreaterThan(0);
    const system = capturedSystemText();

    // The durable record of what already happened, by name…
    expect(system).toContain("RECENT COMPLETED ACTIONS");
    expect(system).toContain("Dinner at Chili's");
    expect(system).toMatch(/ALREADY SUCCEEDED/i);

    // …and the rule that earlier turns are context, not pending work.
    expect(system).toContain("ONLY THE NEWEST USER MESSAGE IS ACTIONABLE");
    expect(system).toMatch(/connection dropped/i);
  });

  it("keeps the history turns themselves intact (alternation fix stays)", async () => {
    modelCalls.length = 0;
    modelScript.length = 0;
    await requestStorageContext.run(storage, () =>
      processMessage(
        "Add a task to call the dentist",
        [
          { role: "user", content: "log my weight at 180" },
          { role: "assistant", content: "Logged 180 lbs." },
        ],
        USER,
      ));
    const msgs = modelCalls[0]?.messages || [];
    // Strict user/assistant alternation ending on the new user message —
    // the BUG-20260529 shape (merged user turns) must not come back.
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(String(msgs[2].content)).toContain("call the dentist");
  });

  it("undone actions stay out of the completed-actions block", async () => {
    await requestStorageContext.run(storage, async () => {
      const ctx = buildTurnVerifyContext(storage);
      const input = { title: "Temp task to undo" };
      const raw = await executeTool("create_task", input, USER);
      const envelope = await finalizeToolResult("create_task", "create_task", input, raw, ctx);
      await recordActionLog(ctx, "create_task", "create_task", input, envelope, null);
      const undo = await executeTool("undo_last_action", {}, USER);
      expect(undo?.undone).toBe(true);
    });
    modelCalls.length = 0;
    modelScript.length = 0;
    await requestStorageContext.run(storage, () => processMessage("Any tasks today?", [], USER));
    const system = capturedSystemText();
    expect(system).not.toContain("Temp task to undo");
    // The surviving earlier write is still listed.
    expect(system).toContain("Dinner at Chili's");
  });
});
