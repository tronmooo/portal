// ============================================================
// ai-fast-lane.ts — single-action fast lane (pure pieces)
// ============================================================
// The main chat agent runs EVERY message through claude-sonnet-4-6 —
// a deliberate 2026-05-21 reliability decision after Haiku silently
// dropped tool calls ("✅ Logged everything!" with zero DB writes).
// That decision stands for the general case; this module carves out a
// narrow, guarded exception for the highest-volume message class:
// short, single-intent write commands ("log $5 coffee", "remind me to
// call mom at 5", "add a task to buy milk").
//
// The safety model is escalate-don't-trust:
//   1. A deterministic eligibility gate (below) only admits short,
//      question-free, non-destructive, non-read messages.
//   2. The fast model gets the IDENTICAL system prompt and full tool
//      schema as the main agent — same grounding, no trimmed context.
//   3. Its response is assessed BEFORE anything executes: zero
//      tool_use blocks (the documented Haiku failure mode), too many
//      tool calls, any tool outside the small write allowlist, or any
//      input validation failure → the message transparently re-runs on
//      the normal Sonnet agentic loop. Nothing was written, so the
//      retry is side-effect free.
//   4. Tools that do execute go through the exact same validate →
//      before-rows → executeTool → envelope-verify → action-log
//      pipeline as the main loop (shared executor in ai-engine.ts).
//   5. After a write has happened, failures are reported honestly —
//      never re-run on Sonnet (double-write risk).
//
// Worst case = today's latency + one bounded fast-model attempt.
// Expected case = one small-model round + deterministic recap.
//
// This module is pure (no imports from ai-engine) so it stays
// unit-testable — tests/ai-fast-lane.test.ts. The executor lives in
// server/ai-engine.ts (runFastLanePath) because it needs the engine's
// private tool plumbing; same layout as ai-bulk-log.ts.

import { BULK_ACTION_TOOLS } from "./ai-bulk-log";

export const FAST_LANE_MODEL = "claude-haiku-4-5-20251001";
/** Hard wall-clock cap for the fast-model round. The first fast-lane call in
 * a cache window pays a COLD prompt-cache write over the ~60K-token prefix,
 * which can legitimately take many seconds — the streaming inactivity timer
 * below is the real hang detector, so this cap only needs to bound the
 * worst-case total. A breach just escalates to the Sonnet loop. */
export const FAST_LANE_TIMEOUT_MS = 12_000;
/** Inactivity cutoff between stream events. A healthy-but-cold ingest keeps
 * emitting stream progress and is allowed to run to the hard cap; a hung
 * connection goes silent and dies fast. */
export const FAST_LANE_IDLE_TIMEOUT_MS = 4_000;
/** A "simple command" that fans out into more tool calls than this is not
 * simple — the full agent handles it better. */
export const FAST_LANE_MAX_TOOL_CALLS = 3;

/** Write tools the fast lane may execute. Everything else escalates.
 * Deliberately the bulk path's battle-tested whitelist plus complete_task —
 * no deletes, no updates, no profile/liability surgery, no reads (a read
 * needs a second model round to compose the answer, which defeats the lane). */
export const FAST_LANE_TOOLS: ReadonlySet<string> = new Set<string>([
  ...BULK_ACTION_TOOLS,
  "complete_task",
]);

/** Kill switch: AI_FAST_LANE=0 disables the lane entirely. */
export function fastLaneEnabled(): boolean {
  return process.env.AI_FAST_LANE !== "0";
}

// Destructive / edit intents never enter the lane — entity matching and
// confirmation flows belong to the full agent.
const DESTRUCTIVE_OR_EDIT =
  /\b(delete|remove|clear|merge|undo|revert|rename|update|change|edit|cancel|reschedule|refund|split|move|reassign|uncomplete|unmark)\b/i;

// Read/question intents (leading position) — the lane is write-only.
const READ_INTENT =
  /^(?:show|list|search|find|open|pull\s+up|view|get|what|what's|whats|how|when|where|why|who|which|is|are|am|do|does|did|can|could|should|would|tell|give|summarize|explain|compare|analyze)\b/i;

// Positive write signal: the message must actually look like a loggable
// command/statement before we spend a fast-model round on it. Greetings and
// chitchat ("thanks!", "sounds good") skip straight to the normal loop.
const WRITE_SIGNAL =
  /\b(log|logged|add|create|new|remind|reminder|track|record|note|mark|done|did|finish|finished|complete|completed|took|take|ate|eat|drank|drink|had|ran|run|walked|walk|jogged|swam|biked|lifted|exercised|worked\s+out|workout|slept|napped|weigh|weighed|weight|bp|blood\s+pressure|spent|paid|bought|earned|received|deposited|journal|check(?:ed)?\s+(?:in|off)|meditated|smoked|vaped|felt|feeling|mood|task|expense|habit|event|income|dose|medication|meds)\b|\$\s*\d|\b\d+(?:\.\d+)?\s*(?:mg|ml|g|oz|lbs?|kg|miles?|mi|km|steps?|min|minutes?|hours?|hrs?|reps?|sets?|cal|calories)\b/i;

export interface FastLaneEligibility {
  eligible: boolean;
  /** Telemetry label for why the gate rejected (undefined when eligible). */
  reason?: string;
}

/**
 * Deterministic admission gate. Biased hard toward rejection: a false
 * negative only costs speed (the message runs on the normal loop), while a
 * false positive risks the fast model mishandling a complex request — so
 * anything ambiguous stays out.
 */
export function fastLaneEligible(message: string): FastLaneEligibility {
  const t = String(message || "").trim();
  if (!t) return { eligible: false, reason: "empty" };
  if (t.length > 200) return { eligible: false, reason: "too-long" };
  if (t.includes("\n")) return { eligible: false, reason: "multiline" };
  if (t.includes("?")) return { eligible: false, reason: "question-mark" };
  if (READ_INTENT.test(t)) return { eligible: false, reason: "read-intent" };
  if (DESTRUCTIVE_OR_EDIT.test(t)) return { eligible: false, reason: "destructive-or-edit" };
  if (!WRITE_SIGNAL.test(t)) return { eligible: false, reason: "no-write-signal" };
  return { eligible: true };
}

export interface FastLaneToolUse {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface FastLaneAssessment {
  ok: boolean;
  /** Escalation label when !ok: "no-tools" | "too-many-tools" | "off-allowlist:<tool>". */
  reason?: string;
  toolUses: FastLaneToolUse[];
}

/**
 * Assess the fast model's response BEFORE anything executes. Any rejection
 * here is side-effect free — the caller falls through to the Sonnet loop.
 */
export function assessFastLaneResponse(content: Array<{ type: string; [k: string]: any }>): FastLaneAssessment {
  const toolUses: FastLaneToolUse[] = (content || [])
    .filter((b) => b && b.type === "tool_use")
    .map((b: any) => ({ id: String(b.id || ""), name: String(b.name || ""), input: (b.input && typeof b.input === "object") ? b.input : {} }));
  if (toolUses.length === 0) {
    // The documented Haiku failure mode: a chatty confirmation with zero
    // tool calls. The eligibility gate only admits write commands, so a
    // tool-less reply here means the model dropped the action — escalate.
    return { ok: false, reason: "no-tools", toolUses: [] };
  }
  if (toolUses.length > FAST_LANE_MAX_TOOL_CALLS) {
    return { ok: false, reason: "too-many-tools", toolUses: [] };
  }
  const offTool = toolUses.find((t) => !FAST_LANE_TOOLS.has(t.name));
  if (offTool) {
    return { ok: false, reason: `off-allowlist:${offTool.name}`, toolUses: [] };
  }
  return { ok: true, toolUses };
}
