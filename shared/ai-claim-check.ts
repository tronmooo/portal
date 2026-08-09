// shared/ai-claim-check.ts — TOOL-RESULT-GROUNDED RESPONSES.
//
// "THE AI MUST DESCRIBE WHAT THE SYSTEM ACTUALLY DID, NOT WHAT THE MODEL
// THINKS IT DID."
//
// The model writes its summary in the same turn it requests tool calls, and it
// writes that summary from its own plan. When the plan and the execution
// diverge the prose follows the plan:
//
//   "Updated the Dodge Ram 2025 — color: white, drive type: 4WD."
//        …on a turn where the user said CREATE.
//   "'Walk the Dog' habit created (daily). Note: habits are binary daily
//    check-ins…"
//        …a capability claim about the system that stopped being true.
//
// This module re-reads the finished reply against the operations that actually
// executed and reports every divergence. It is pure: the caller decides what
// to do with a mismatch (downgrade the reply, log it, or both).

import { toolOperation, TOOL_INTENT_ENTITY } from "./ai-tool-routing";
import type { IntentEntity, IntentOperation } from "./ai-intent";

/** One executed write, as the engine records it. */
export interface ExecutedOperation {
  tool: string;
  status: "ok" | "failed" | "skipped" | "deduped";
  entityId?: string;
  /** Human label for the record touched ("Dodge Ram 2025"). */
  raw?: string;
}

export type ClaimMismatch =
  | "claimed_success_without_write"
  | "claimed_create_but_updated"
  | "claimed_stale_capability"
  | "claimed_entity_not_written";

export interface ClaimViolation {
  mismatchType: ClaimMismatch;
  /** The sentence fragment that triggered it, for the failure log. */
  claim: string;
  detail: string;
}

const lc = (s: unknown) => String(s ?? "").toLowerCase();

// ── Success verbs the assistant may only use after a confirmed write ────────
// Ordered longest-first so "marked complete" is not swallowed by "marked".
const SUCCESS_VERBS: Array<{ re: RegExp; operation: IntentOperation }> = [
  { re: /\b(?:marked\s+(?:it\s+)?(?:complete|completed|done|off)|checked\s+(?:it\s+)?(?:in|off))\b/i, operation: "complete" },
  { re: /\b(?:created|added|made|set\s+up|scheduled|logged|saved|recorded|started)\b/i, operation: "create" },
  { re: /\b(?:updated|changed|edited|modified|renamed|adjusted|revised)\b/i, operation: "update" },
  { re: /\b(?:deleted|removed|cleared|erased)\b/i, operation: "delete" },
];

/**
 * Does the reply assert that something was written? Present/past tense only —
 * "I'll create…", "want me to create…", "to create a habit you…" are offers
 * and questions, not claims.
 */
export function extractSuccessClaims(reply: string): Array<{ claim: string; operation: IntentOperation }> {
  const out: Array<{ claim: string; operation: IntentOperation }> = [];
  const sentences = String(reply ?? "")
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    // Skip conditionals, offers and questions.
    if (/\b(?:i(?:'| wi)ll|i can|would you|want me to|should i|do you want|if you)\b/i.test(sentence)) continue;
    if (sentence.trimEnd().endsWith("?")) continue;
    if (/\bcould\s+not|couldn'?t|failed|didn'?t\s+(?:go|save|work)|nothing\s+was\s+saved\b/i.test(sentence)) continue;
    for (const { re, operation } of SUCCESS_VERBS) {
      if (re.test(sentence)) {
        out.push({ claim: sentence.slice(0, 200), operation });
        break;
      }
    }
  }
  return out;
}

// ── Capability claims that are no longer true ───────────────────────────────
//
// Habits gained targetPerDay (shared/schema.ts), scheduled times, and multiple
// check-ins per day (shared/habit-schedule.ts). Any reply that tells the user
// otherwise is describing a system that no longer exists — and in the report
// that opened this work, it talked the user out of the feature that would have
// served them.
const STALE_CAPABILITY_CLAIMS: Array<{ re: RegExp; detail: string }> = [
  {
    re: /habits?\s+are\s+(?:only\s+)?binary|binary\s+(?:daily\s+)?check-?ins?|habits?\s+(?:can\s+)?only\s+(?:be\s+)?(?:checked|marked)\s+(?:off\s+)?once/i,
    detail: "Habits support targetPerDay and multiple check-ins per day — the binary-habit limitation no longer exists.",
  },
  {
    re: /(?:you'?ll|you\s+(?:can|must|have\s+to|need\s+to))\s+(?:check|mark)\s+it\s+off\s+(?:\w+\s+){0,3}manually/i,
    detail: "Multiple check-ins per day are counted against the habit's daily target automatically.",
  },
  {
    re: /(?:create|make)\s+two\s+separate\s+habits?|two\s+separate\s+habits?\s+\(/i,
    detail: "A twice-a-day habit is ONE habit with dailyTarget 2, not two habits.",
  },
  {
    re: /habits?\s+(?:don'?t|do\s+not|can'?t)\s+(?:support|have)\s+(?:a\s+)?(?:daily\s+)?(?:targets?|counts?|goals?)/i,
    detail: "Habits do support a per-day target (targetPerDay 1-10).",
  },
];

/**
 * Remove the sentences that assert a limitation the app no longer has, keeping
 * the rest of the answer. Used when the write itself succeeded — the user
 * should still hear about their new habit, just without being told it can only
 * be checked off once a day.
 */
export function stripStaleCapabilityClaims(reply: string): string {
  const s = String(reply ?? "");
  if (!s) return "";
  const kept = s
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !STALE_CAPABILITY_CLAIMS.some(({ re }) => re.test(sentence)))
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  // A "Note:" lead-in whose body we just removed reads as a dangling fragment.
  return kept.replace(/\bNote:\s*$/i, "").trim();
}

export function findStaleCapabilityClaims(reply: string): ClaimViolation[] {
  const s = String(reply ?? "");
  const out: ClaimViolation[] = [];
  for (const { re, detail } of STALE_CAPABILITY_CLAIMS) {
    const hit = s.match(re);
    if (hit) {
      out.push({ mismatchType: "claimed_stale_capability", claim: hit[0].slice(0, 200), detail });
    }
  }
  return out;
}

// ── The check ───────────────────────────────────────────────────────────────

export interface ClaimCheckInput {
  reply: string;
  operations: ExecutedOperation[];
  /** The turn's parsed intent, when one was confidently derived. */
  intentEntity?: IntentEntity;
  intentOperation?: IntentOperation;
}

export interface ClaimCheckResult {
  violations: ClaimViolation[];
  /** True when the reply asserts a write that no successful tool performed. */
  unsupportedSuccess: boolean;
}

/**
 * RESPONSE MUST MATCH TOOL RESULT.
 *
 * Rules, in order of severity:
 *  1. The reply claims a write and NOTHING succeeded → unsupported success.
 *  2. The reply says "created" but only an update-class tool ran → the
 *     create-became-update swap, described as if it were a create.
 *  3. The reply claims an entity nothing was written to.
 *  4. The reply repeats a capability limitation that no longer exists.
 */
export function checkClaims(input: ClaimCheckInput): ClaimCheckResult {
  const { reply, operations } = input;
  const violations: ClaimViolation[] = [];
  const claims = extractSuccessClaims(reply);
  // "deduped" landed in the database exactly as much as "ok" did — the tool
  // found the record already there and merged into it. The honesty question
  // here is "was anything saved", and for a dedup the answer is yes. Whether
  // the reply should have said "created" or "already existed" is the tool's
  // own message to relay, not a missing write.
  const succeeded = operations.filter((o) => o.status === "ok" || o.status === "deduped");

  violations.push(...findStaleCapabilityClaims(reply));

  if (claims.length === 0) {
    return { violations, unsupportedSuccess: false };
  }

  // 1. Claimed a write with nothing confirmed.
  if (succeeded.length === 0) {
    for (const c of claims) {
      violations.push({
        mismatchType: "claimed_success_without_write",
        claim: c.claim,
        detail:
          operations.length === 0
            ? "The reply reports an action but no tool ran."
            : `The reply reports an action but all ${operations.length} tool call(s) failed.`,
      });
    }
    return { violations, unsupportedSuccess: true };
  }

  const executedOps = new Set(succeeded.map((o) => toolOperation(o.tool)));
  const executedEntities = new Set(
    succeeded.map((o) => TOOL_INTENT_ENTITY[o.tool]).filter(Boolean) as IntentEntity[],
  );

  // 2. "Created …" with only update-class writes behind it.
  const claimsCreate = claims.some((c) => c.operation === "create");
  if (claimsCreate && !executedOps.has("create") && executedOps.has("update")) {
    const c = claims.find((x) => x.operation === "create")!;
    violations.push({
      mismatchType: "claimed_create_but_updated",
      claim: c.claim,
      detail: `The reply says something was created, but the only writes were update-class tools: ${succeeded.map((o) => o.tool).join(", ")}.`,
    });
  }

  // 3. "Updated …" when the turn's intent — and the writes — were creates.
  const claimsUpdate = claims.some((c) => c.operation === "update");
  if (claimsUpdate && !executedOps.has("update") && executedOps.has("create")) {
    const c = claims.find((x) => x.operation === "update")!;
    violations.push({
      mismatchType: "claimed_entity_not_written",
      claim: c.claim,
      detail: `The reply says something was updated, but every write was a create: ${succeeded.map((o) => o.tool).join(", ")}.`,
    });
  }

  // 4. The turn's intent entity was never written to.
  if (
    input.intentEntity &&
    input.intentEntity !== "unknown" &&
    executedEntities.size > 0 &&
    !executedEntities.has(input.intentEntity) &&
    // asset/profile are the same table
    !(input.intentEntity === "asset" && executedEntities.has("profile")) &&
    !(input.intentEntity === "profile" && executedEntities.has("asset"))
  ) {
    violations.push({
      mismatchType: "claimed_entity_not_written",
      claim: claims[0].claim,
      detail: `The user asked about a ${input.intentEntity}, but the writes touched: ${[...executedEntities].join(", ")}.`,
    });
  }

  return { violations, unsupportedSuccess: false };
}

/**
 * The honest reply to send when a claim could not be grounded. Used instead of
 * rendering success — never alongside it.
 */
export function honestFailureReply(operations: ExecutedOperation[]): string {
  const failed = operations.filter((o) => o.status !== "ok" && o.status !== "deduped").length;
  if (operations.length === 0) {
    return "I wasn't able to complete that — nothing was saved. Could you rephrase it and I'll try again?";
  }
  return `I couldn't complete that${failed ? ` — ${failed} step${failed > 1 ? "s" : ""} didn't go through` : ""}. Nothing was saved, so please try again.`;
}

const OP_VERB: Record<IntentOperation, string> = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
  complete: "Marked complete",
  read: "Read",
  unknown: "Saved",
};

const ENTITY_NOUN: Partial<Record<IntentEntity, string>> = {
  asset: "asset", profile: "profile", habit: "habit", task: "task",
  event: "event", tracker: "tracker entry",
  expense: "expense", income: "income", obligation: "bill",
  liability: "liability", goal: "goal", journal: "journal entry",
  memory: "memory", artifact: "artifact", document: "document",
};

/**
 * A summary built ONLY from what executed — used to replace prose whose verb
 * or entity contradicted the tool results. Deliberately plain: its job is to
 * be true, and the action cards below it carry the detail.
 */
export function groundedSummary(operations: ExecutedOperation[]): string {
  const ok = operations.filter((o) => o.status === "ok" || o.status === "deduped");
  if (ok.length === 0) return honestFailureReply(operations);

  const parts = ok.slice(0, 6).map((o) => {
    // A dedup is not a create: say what actually happened to the record.
    const verb = o.status === "deduped" ? "Updated the existing" : OP_VERB[toolOperation(o.tool)];
    const noun = ENTITY_NOUN[TOOL_INTENT_ENTITY[o.tool]] ?? "record";
    const label = o.raw && o.raw !== o.tool ? ` "${o.raw}"` : "";
    return `${verb} ${noun}${label}`;
  });
  const more = ok.length > parts.length ? ` (+${ok.length - parts.length} more)` : "";
  const failed = operations.length - ok.length;
  const tail = failed ? ` ${failed} step${failed > 1 ? "s" : ""} didn't go through.` : "";
  return `${parts.join(". ")}.${more}${tail}`;
}

/** Human label for a mismatch, used in logs and dashboards. */
export function describeMismatch(type: ClaimMismatch): string {
  switch (type) {
    case "claimed_success_without_write": return "assistant claimed success without backend confirmation";
    case "claimed_create_but_updated": return "assistant claimed CREATE but tool executed UPDATE";
    case "claimed_stale_capability": return "assistant claimed a capability limitation that no longer exists";
    case "claimed_entity_not_written": return "assistant described a different entity than was written";
  }
}
