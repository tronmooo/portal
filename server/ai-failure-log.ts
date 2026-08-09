// server/ai-failure-log.ts — production error detection for the chat pipeline.
//
// The seven failure classes from the 2026-08-09 remediation spec, each logged
// with enough context to reconstruct the turn without a repro:
//
//   turn_id · user_message · parsed_intent · tool_selected · tool_result ·
//   assistant_claim · mismatch_type
//
// Detection is the point. These are not user-visible errors — every one of
// them is a case where the pipeline already did something wrong and the user
// either saw a lie or saw someone else's action card. Logging them turns a
// screenshot-driven bug report into a metric.

import { logger } from "./logger";
import type { ParsedIntent } from "../shared/ai-intent";
import type { RoutingMismatch } from "../shared/ai-tool-routing";
import type { ClaimMismatch } from "../shared/ai-claim-check";

export type ChatMismatchType =
  | RoutingMismatch
  | ClaimMismatch
  | "internal_text_leaked";

export interface ChatFailureRecord {
  turnId: string;
  sourceMessageId?: string;
  userId?: string;
  userMessage: string;
  parsedIntent: Pick<ParsedIntent, "entity" | "operation" | "target" | "confidence"> | null;
  toolSelected?: string;
  toolResult?: string;
  assistantClaim?: string;
  mismatchType: ChatMismatchType;
  detail?: string;
  at: string;
}

/**
 * Bounded in-memory ring. Serverless instances are short-lived, so this is a
 * debugging aid and a test seam — `logger.error` is the durable record.
 */
const RING_SIZE = 200;
const ring: ChatFailureRecord[] = [];

const clip = (v: unknown, n: number): string => {
  const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export function recordChatFailure(
  input: Omit<ChatFailureRecord, "at"> & { at?: string },
): ChatFailureRecord {
  const record: ChatFailureRecord = {
    ...input,
    userMessage: clip(input.userMessage, 500),
    toolResult: input.toolResult ? clip(input.toolResult, 300) : undefined,
    assistantClaim: input.assistantClaim ? clip(input.assistantClaim, 300) : undefined,
    detail: input.detail ? clip(input.detail, 300) : undefined,
    at: input.at ?? new Date().toISOString(),
  };

  ring.push(record);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  try {
    logger.error(
      "ai",
      `[chat-mismatch] ${record.mismatchType} turn=${record.turnId} tool=${record.toolSelected ?? "-"} ` +
        `intent=${record.parsedIntent ? `${record.parsedIntent.entity}/${record.parsedIntent.operation}@${record.parsedIntent.confidence}` : "-"} ` +
        `msg=${JSON.stringify(record.userMessage)} claim=${JSON.stringify(record.assistantClaim ?? "")} ` +
        `result=${JSON.stringify(record.toolResult ?? "")}${record.detail ? ` detail=${JSON.stringify(record.detail)}` : ""}`,
    );
  } catch {
    /* logging must never break a chat turn */
  }
  return record;
}

/** Newest first. Test/observability seam. */
export function getChatFailures(limit = 50): ChatFailureRecord[] {
  return ring.slice(-limit).reverse();
}

export function clearChatFailures(): void {
  ring.length = 0;
}

/** Counts by mismatch type, for a health endpoint or a dashboard. */
export function chatFailureCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of ring) out[r.mismatchType] = (out[r.mismatchType] ?? 0) + 1;
  return out;
}
