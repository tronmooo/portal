// tests/ai-chat-loop-sweep.test.ts
//
// "Can the CHAT do all the tools?" — proven at the chat layer, not just the
// executor layer.
//
// tests/ai-executor-sweep.test.ts proves every registered tool executes when
// called directly, and tests/mcp-server.test.ts proves the same over MCP. This
// suite closes the remaining gap: the in-app chat pipeline itself. It runs the
// REAL processMessage — context build, input validation (validateToolInput),
// executeTool dispatch, write envelope + verification, undo-ledger recording,
// reply assembly — for EVERY tool in the registry, with only the Anthropic SDK
// mocked: the "model" is scripted to answer each turn with exactly one
// tool_use for the scenario under test, then an end_turn recap. Everything
// after the model's choice is production code.
//
// What this cannot prove: that the live model picks the right tool from free
// text. That needs a real API key and is covered on demand by the live suites
// (npm run test:multiaction / test:live against a deployment). Everything
// downstream of the model's choice — the part the app owns — is proven here.
import { describe, it, expect, vi, beforeAll } from "vitest";

// Queue of scripted model responses; hoisted so the module mock can see it.
const { modelScript } = vi.hoisted(() => ({ modelScript: [] as any[] }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: async () =>
        modelScript.shift() ?? {
          content: [{ type: "text", text: "All done." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      stream: () => {
        throw new Error("streaming path must not be used without onEvent");
      },
    };
  },
}));

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key-mocked-sdk";

import { MemStorage, requestStorageContext } from "../server/storage";
import { processMessage, TOOL_DEFINITIONS, READ_ONLY_TOOLS } from "../server/ai-engine";
import { SCENARIOS, SWEEP_USER, seedLoanSchedule } from "./helpers/ai-sweep-scenarios";

/** One scripted chat turn: the model "chooses" this tool, then wraps up. */
function scriptToolTurn(tool: string, input: Record<string, any>) {
  modelScript.length = 0;
  modelScript.push(
    {
      content: [{ type: "tool_use", id: `tu_${tool}`, name: tool, input }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    {
      content: [{ type: "text", text: "All done." }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  );
}

// Neutral driver text: has letters (passes the gibberish guard), doesn't start
// with open/view/show/get (skips the doc-open fast path), and contains a
// single clause (skips the bulk multi-action path).
const DRIVER = "Please handle my request now.";

describe("AI chat loop sweep — processMessage runs every tool end-to-end", () => {
  const storage = new MemStorage();

  beforeAll(async () => {
    await requestStorageContext.run(storage, () => seedLoanSchedule(storage));
  });

  it("covers every registered tool (list shared with the executor sweep)", () => {
    const covered = new Set(SCENARIOS.map(s => s.tool));
    const uncovered = TOOL_DEFINITIONS.map(t => t.name).filter(n => !covered.has(n));
    expect(uncovered, `Tools with no chat-loop scenario: ${uncovered.join(", ")}`).toEqual([]);
  });

  for (const [i, sc] of SCENARIOS.entries()) {
    it(`${String(i + 1).padStart(3, "0")} ${sc.tool}${sc.note ? ` (${sc.note})` : ""}`, async () => {
      await requestStorageContext.run(storage, async () => {
        // Resolve profile-id placeholders from storage by name (this suite has
        // no raw executor results to capture ids from).
        const input = JSON.parse(JSON.stringify(sc.input));
        for (const k of Object.keys(input)) {
          const m = typeof input[k] === "string" && input[k].match(/^__PROFILE_ID:(.+)__$/);
          if (m) {
            const profiles = await storage.getProfiles();
            const hit = profiles.find((p: any) => p.name === m[1]);
            input[k] = hit?.id || `unresolved:${m[1]}`;
          }
        }

        scriptToolTurn(sc.tool, input);
        const resp = await processMessage(sc.utterance ?? DRIVER, [], SWEEP_USER);

        // The loop must have completed both scripted rounds: tool round-trip,
        // then the model's recap becoming the user-facing reply.
        expect(resp.reply, `${sc.tool}: loop did not complete`).toBe("All done.");

        if (sc.expect !== "soft" && !READ_ONLY_TOOLS.has(sc.tool)) {
          // Write tools surface per-operation outcomes; the scenario's input
          // must clear validateToolInput AND the executor AND the envelope.
          const op = (resp.operations || []).find(o => o.tool === sc.tool);
          expect(op, `${sc.tool}: no operation outcome recorded`).toBeTruthy();
          expect(op!.status, `${sc.tool}: ${op!.error || ""}`).toBe("ok");
        }
      });
    });
  }
});
