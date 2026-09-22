// shared/ai-operation-ids.ts — Rule 2: every AI turn has a request id, every
// write inside it an operation id, and a replayed operation returns the
// existing result instead of running again.
//
//   request_9281
//     · operation_income_1
//     · operation_expense_1
//     · operation_task_1
//
// The operation id is a pure function of (requestId, tool, normalized input,
// ordinal). The request id is the CLIENT's id for the message (it re-sends the
// same id on retry), so a retry after a lost response, a reconnect or a
// navigation derives exactly the ids the first run derived, and the ledger
// rows the first run wrote answer instead of the tool. The ordinal keeps two
// genuinely identical calls in one request ("log water" twice) as two
// operations.
//
// Pure and dependency-free so both the engine and the tests can pin it.

import { createHash } from "crypto";
import type { RoutingViolation } from "./ai-tool-routing";

/** Keys the engine adds to a tool input that are not part of what was asked. */
const CONTEXT_KEYS = new Set(["__userMessage", "confirmDuplicate", "__allowDuplicate", "__requestId", "__operationId"]);

/** Stable JSON: sorted keys, context keys dropped, undefined removed. */
export function canonicalizeToolInput(input: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        if (CONTEXT_KEYS.has(k)) continue;
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined) continue;
        out[k] = walk(val);
      }
      return out;
    }
    if (typeof v === "string") return v.trim();
    return v;
  };
  return JSON.stringify(walk(input ?? {}));
}

export interface OperationIdInput {
  requestId: string;
  tool: string;
  input: unknown;
  /** 1-based position among identical (tool, input) calls in this request. */
  ordinal: number;
}

/** `op_<tool>_<12 hex>` — readable in a log line, unique per request. */
export function operationIdFor({ requestId, tool, input, ordinal }: OperationIdInput): string {
  const digest = createHash("sha256")
    .update(`${requestId}\u0000${tool}\u0000${canonicalizeToolInput(input)}\u0000${ordinal}`)
    .digest("hex")
    .slice(0, 16);
  return `op_${tool}_${digest}`;
}

/**
 * The refusal handed to the model when it calls a write tool on a READ turn.
 * Shape-compatible with the routing gate's other violations so the same
 * plumbing (tool error, failure log, no user-facing card) carries it.
 */
export function readOnlyTurnViolation(toolName: string, label: string): RoutingViolation {
  return {
    mismatchType: "read_only_turn",
    tool: toolName,
    expectedEntity: "unknown",
    actualEntity: "unknown",
    expectedOperation: "read",
    actualOperation: "create",
    modelDirective:
      `Blocked: this message is a QUESTION, so no records may be created, updated or deleted during it` +
      (label ? ` (${toolName} on "${label}" refused)` : ` (${toolName} refused)`) +
      `. Answer from the data you already have. Do not re-run anything from earlier messages — earlier requests were already handled. ` +
      `If the user wants a change, they will ask for it in a new message.`,
    // Nothing for the user: a refused write on a question is not an event the
    // user asked about, and the answer to their question follows.
    userMessage: "",
  };
}
