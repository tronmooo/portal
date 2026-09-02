// Bulk multi-action extraction — pure pieces (prompt, schema, parsing,
// reply building). No imports from ai-engine so this module stays
// unit-testable (tests/bulk-extraction-normalize.test.ts) and free of
// circular dependencies; the executor lives in server/ai-engine.ts
// (runBulkLogPath) because it needs the engine's private tool plumbing.
import type Anthropic from "@anthropic-ai/sdk";

/** Write tools the extractor may emit. Anything else is dropped. */
export const BULK_ACTION_TOOLS = [
  "log_tracker_entry",
  "create_expense",
  "create_task",
  "create_event",
  "create_reminder",
  "checkin_habit",
  "journal_entry",
  "log_medication_dose",
  "log_income",
] as const;
export type BulkActionTool = (typeof BULK_ACTION_TOOLS)[number];

export interface ExtractedOperation {
  tool: BulkActionTool;
  input: Record<string, any>;
  raw: string;
}

export interface OperationOutcome {
  index: number;
  raw: string;
  tool: string;
  status: "ok" | "failed" | "skipped" | "deduped";
  error?: string;
  /** Debug-only (request sent `debug:true`): the tool's raw, model-facing
   *  error and the arguments it was called with — never shown in the UI. */
  rawError?: string;
  toolInput?: Record<string, unknown>;
  entityId?: string;
  trackerName?: string;
  createdTracker?: { id: string; name: string };
  /** Compact human-readable summary of what was recorded ("duration 60, method blunt, at 8:15 AM"). */
  detail?: string;
  /** Which chat turn produced this operation. The client renders an operation
   *  only under the assistant message carrying the same turnId, so an older
   *  turn's outcome can never reappear beneath a newer answer (spec item 8). */
  turnId?: string;
  /** The user message id this operation traces back to. */
  sourceMessageId?: string;
}

/** Compact "duration 60, method blunt, at 8:15 AM" summary of an operation's
 * input — proves in the reply that no stated detail was dropped. */
export function summarizeOpDetail(input: Record<string, any>): string {
  const parts: string[] = [];
  const values = (input?.values && typeof input.values === "object") ? input.values : {};
  for (const [k, v] of Object.entries(values)) {
    if (k === "_notes" || v == null || typeof v === "object") continue;
    parts.push(`${k} ${v}`);
    if (parts.length >= 4) break;
  }
  if (input?.amount != null) parts.push(`$${input.amount}`);
  if (input?.at) parts.push(`at ${input.at}`);
  return parts.join(", ");
}

/** Hard cap on operations per message — matches the engine's MAX_TOOL_CALLS. */
export const MAX_BULK_OPERATIONS = 60;

export const EXTRACT_ACTIONS_TOOL: Anthropic.Messages.Tool = {
  name: "extract_actions",
  description:
    "Extract EVERY independent action from the user's message as a separate operation. Never merge, drop, or skip an action.",
  input_schema: {
    type: "object" as const,
    properties: {
      operations: {
        type: "array",
        description: "One entry per independent action in the message, in order.",
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              enum: [...BULK_ACTION_TOOLS],
              description: "Which write tool handles this action.",
            },
            input: {
              type: "object",
              description: "The exact input object for that tool.",
            },
            raw: {
              type: "string",
              description: "The clause from the user's message this operation came from, verbatim.",
            },
          },
          required: ["tool", "input", "raw"],
        },
      },
    },
    required: ["operations"],
  },
};

export function buildExtractionSystemPrompt(opts: {
  nowISO: string;
  timezone?: string;
  trackerNames: string[];
  profileNames: string[];
  habitNames: string[];
}): string {
  const trackers = opts.trackerNames.slice(0, 150).join(", ") || "(none yet)";
  const habits = opts.habitNames.slice(0, 60).join(", ") || "(none)";
  const profiles = opts.profileNames.slice(0, 60).join(", ") || "(none)";
  return `You are the action extractor for Portol, a life-tracking OS. The user sent one message describing MANY things they did. Convert EVERY independent action into one operation via the extract_actions tool. NEVER drop, merge, or refuse an action — there is no list of "supported" activities; anything the user did is loggable.

NOW: ${opts.nowISO}${opts.timezone ? ` (user timezone: ${opts.timezone})` : ""}

ROUTING RULES:
- Default: log_tracker_entry(trackerName, values, at?, notes?, forProfile?). trackerName = the literal activity, capitalized ("Soccer", "Cannabis", "Shower", "Bathroom Visits", "Guitar Practice", "Reading", "Vacuuming", "Dishes"). Reuse an EXISTING tracker name from the list below when the activity matches it.
- values: include ONLY what the user stated — duration (minutes), distance, quantity, intensity. Do NOT compute or guess derived numbers for walking/running/hydration/sleep; the server's estimation engine converts units and estimates steps/distance/duration/pace/calories deterministically with confidence labels. Walking/running variants are ONE canonical tracker: "walked 1 mile"/"2,100 steps"/"22 minutes"/"1.6 kilometers" → trackerName "Walking" with { distance: 1 } / { steps: 2100 } / { duration: 22 } / { distanceKm: 1.6 }. Other sports need { activityType, duration?, caloriesBurned?, intensity? }. Water/hydration → trackerName "Hydration", values:{ ounces } (or { containerCount, containerType } for "3 bottles"). Food eaten → trackerName "Nutrition", values:{ item, calories? }. Coffee/caffeine drunk → "Coffee", values:{ cups:1 }. Sleep ("went to bed at X", "woke up at Y", "slept N hours") → trackerName "Sleep", values:{ hours? , bedtime?, wakeTime? }. Weight reading → "Weight", values:{ weight }.
- Counts default to 1: a bare "took a shower" → values:{ count: 1 }.
- Medications/supplements ("took lisinopril", "took fish oil") → log_tracker_entry with trackerName EXACTLY the item name ("Lisinopril", "Fish Oil"), values:{ taken: true, dosage?, unit? }. One operation PER item.
- Money spent or a bill paid ("paid my electric bill", "bought groceries $40") → create_expense({ amount?, description, category? }). If no amount is stated, omit amount... if the tool requires an amount, still emit the operation with your best reading of the clause.
- A future to-do ("need to call the dentist") → create_task({ title, dueDate? }). An appointment with a time → create_event.
- "at 8:15 AM" style times → pass through the at parameter (bare time strings are fine).
- Journaling as an activity ("journaled") → log_tracker_entry trackerName "Journaling". An actual journal passage ("journal that today was great: ...") → journal_entry.
- checkin_habit ONLY on explicit habit language ("mark off X", "checked in X", "completed my X habit"). A plain activity report ("I did/took/smoked/went/played X") is ALWAYS log_tracker_entry — even when a habit with a similar name exists.
- NEVER drop a stated detail: every number, unit, duration, count, method, and timestamp must land in values/at ("for an hour" → duration:60; "once" → count:1; "a blunt" → method:"blunt"; "at 8:15 AM" → at:"8:15 AM").
- forProfile: set ONLY when THIS message names someone else ("Rex", "Mom"). Never infer a profile from anything else.

EXISTING TRACKERS: ${trackers}
EXISTING HABITS: ${habits}
PROFILES: ${profiles}

Return EVERY action — a 20-sentence message yields ~20 operations. Echo each source clause in raw.`;
}

/** Validate + normalize whatever the model returned. Drops non-whitelisted
 * tools and malformed rows; caps the total. */
export function parseExtractedOperations(toolInput: any): ExtractedOperation[] {
  const rows = Array.isArray(toolInput?.operations) ? toolInput.operations : [];
  const ops: ExtractedOperation[] = [];
  for (const row of rows) {
    if (ops.length >= MAX_BULK_OPERATIONS) break;
    if (!row || typeof row !== "object") continue;
    const tool = String(row.tool || "");
    if (!(BULK_ACTION_TOOLS as readonly string[]).includes(tool)) continue;
    if (!row.input || typeof row.input !== "object" || Array.isArray(row.input)) continue;
    ops.push({
      tool: tool as BulkActionTool,
      input: row.input as Record<string, any>,
      raw: typeof row.raw === "string" && row.raw.trim() ? row.raw.trim() : summarizeInput(row.input),
    });
  }
  return ops;
}

function summarizeInput(input: Record<string, any>): string {
  return String(input.trackerName || input.title || input.description || input.name || "action");
}

function opLabel(op: OperationOutcome): string {
  const name = op.trackerName || op.raw || op.tool;
  return op.detail ? `${name} — ${op.detail}` : name;
}

/** Deterministic reply enumerating every operation — never claims more or
 * less than what actually happened. */
export function buildBulkReply(ops: OperationOutcome[], createdTrackers: Array<{ id: string; name: string }>): string {
  const ok = ops.filter((o) => o.status === "ok");
  const deduped = ops.filter((o) => o.status === "deduped");
  const failed = ops.filter((o) => o.status === "failed");
  const skipped = ops.filter((o) => o.status === "skipped");

  const lines: string[] = [];
  if (ok.length > 0) {
    lines.push(`Logged ${ok.length} of ${ops.length} actions:`);
    for (const o of ok) lines.push(`✅ ${opLabel(o)}`);
  }
  if (deduped.length > 0) {
    for (const o of deduped) lines.push(`↩️ ${opLabel(o)} — already logged just now, kept the existing entry`);
  }
  if (createdTrackers.length > 0) {
    lines.push(`Created ${createdTrackers.length} new tracker${createdTrackers.length > 1 ? "s" : ""}: ${createdTrackers.map((t) => t.name).join(", ")}.`);
  }
  if (failed.length > 0) {
    lines.push(`⚠️ ${failed.length} failed:`);
    for (const o of failed) lines.push(`✗ ${opLabel(o)} — ${o.error || "failed"}`);
  }
  if (skipped.length > 0) {
    lines.push(`⏸ ${skipped.length} not run (time limit): ${skipped.map(opLabel).join(", ")}. Send them again and I'll log them.`);
  }
  if (lines.length === 0) return "I couldn't extract any actions from that — try rephrasing?";
  return lines.join("\n");
}
