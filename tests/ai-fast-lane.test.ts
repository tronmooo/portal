// ── Single-action fast lane guards ───────────────────────────────────────────
// Pins the two deterministic gates that keep the fast lane accuracy-safe:
//   • fastLaneEligible — only short single-intent WRITE commands are admitted;
//     anything destructive, editing, read-shaped, question-shaped, or
//     chitchat stays on the Sonnet loop.
//   • assessFastLaneResponse — every escalation branch fires BEFORE any tool
//     executes: no tools (the documented Haiku silent-drop failure mode),
//     too many tools, any off-allowlist tool.
// Key-free, deterministic, no API calls.
import { describe, it, expect, afterEach } from "vitest";
import {
  fastLaneEligible,
  fastLaneEnabled,
  assessFastLaneResponse,
  FAST_LANE_TOOLS,
  FAST_LANE_MAX_TOOL_CALLS,
} from "../server/ai-fast-lane";

const tu = (name: string, input: Record<string, any> = {}) => ({ type: "tool_use", id: "t1", name, input });

describe("fastLaneEligible", () => {
  it("admits short single-intent write commands", () => {
    for (const msg of [
      "log $5 coffee",
      "remind me to call mom at 5",
      "add a task to buy milk",
      "I ate a chicken sandwich",
      "took my multivitamin",
      "ran 2 miles",
      "weight 183",
      "spent $40 on gas",
      "mark the dentist task done",
    ]) {
      expect(fastLaneEligible(msg).eligible, msg).toBe(true);
    }
  });

  it("rejects questions, reads, and analysis", () => {
    for (const msg of [
      "how much did I spend this month?",
      "show my expenses",
      "what's my net worth",
      "did I take my meds today",
      "list my tasks",
      "find my insurance card",
    ]) {
      const g = fastLaneEligible(msg);
      expect(g.eligible, msg).toBe(false);
    }
  });

  it("rejects destructive and edit intents", () => {
    for (const msg of [
      "delete my Netflix subscription",
      "remove the gym expense",
      "update my weight to 183",
      "rename my running tracker",
      "undo that",
      "cancel the dentist appointment",
      "change my rent to $2000",
    ]) {
      const g = fastLaneEligible(msg);
      expect(g.eligible, msg).toBe(false);
      expect(g.reason, msg).toBe("destructive-or-edit");
    }
  });

  it("rejects chitchat without a write signal", () => {
    for (const msg of ["thanks!", "sounds good", "hello", "ok great"]) {
      const g = fastLaneEligible(msg);
      expect(g.eligible, msg).toBe(false);
      expect(g.reason, msg).toBe("no-write-signal");
    }
  });

  it("rejects long, multiline, and empty messages", () => {
    expect(fastLaneEligible("").eligible).toBe(false);
    expect(fastLaneEligible("log coffee\nand also I ran").eligible).toBe(false);
    expect(fastLaneEligible("log " + "x".repeat(220)).eligible).toBe(false);
  });
});

describe("fastLaneEnabled kill switch", () => {
  const prev = process.env.AI_FAST_LANE;
  afterEach(() => {
    if (prev === undefined) delete process.env.AI_FAST_LANE;
    else process.env.AI_FAST_LANE = prev;
  });

  it("is on by default and off with AI_FAST_LANE=0", () => {
    delete process.env.AI_FAST_LANE;
    expect(fastLaneEnabled()).toBe(true);
    process.env.AI_FAST_LANE = "0";
    expect(fastLaneEnabled()).toBe(false);
  });
});

describe("assessFastLaneResponse", () => {
  it("escalates on zero tool_use blocks (the Haiku silent-drop failure mode)", () => {
    const a = assessFastLaneResponse([{ type: "text", text: "✅ Logged everything!" }]);
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("no-tools");
  });

  it("escalates when a tool is outside the allowlist", () => {
    const a = assessFastLaneResponse([tu("delete_expense", { id: "x" })]);
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("off-allowlist:delete_expense");
  });

  it("escalates when even ONE of several tools is off-allowlist", () => {
    const a = assessFastLaneResponse([tu("create_expense", { amount: 5 }), tu("delete_task", { id: "x" })]);
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("off-allowlist:delete_task");
  });

  it("escalates on too many tool calls", () => {
    const many = Array.from({ length: FAST_LANE_MAX_TOOL_CALLS + 1 }, () => tu("create_expense", { amount: 1 }));
    const a = assessFastLaneResponse(many);
    expect(a.ok).toBe(false);
    expect(a.reason).toBe("too-many-tools");
  });

  it("passes allowlisted tool calls through with inputs intact", () => {
    const a = assessFastLaneResponse([
      { type: "text", text: "Logging that now." },
      tu("create_expense", { amount: 5, description: "coffee" }),
    ]);
    expect(a.ok).toBe(true);
    expect(a.toolUses).toHaveLength(1);
    expect(a.toolUses[0].name).toBe("create_expense");
    expect(a.toolUses[0].input).toEqual({ amount: 5, description: "coffee" });
  });

  it("allowlist is write-only bulk tools plus complete_task", () => {
    expect(FAST_LANE_TOOLS.has("log_tracker_entry")).toBe(true);
    expect(FAST_LANE_TOOLS.has("create_expense")).toBe(true);
    expect(FAST_LANE_TOOLS.has("complete_task")).toBe(true);
    expect(FAST_LANE_TOOLS.has("delete_expense")).toBe(false);
    expect(FAST_LANE_TOOLS.has("update_liability")).toBe(false);
    expect(FAST_LANE_TOOLS.has("create_profile")).toBe(false);
  });
});
