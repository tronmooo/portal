// shared/turn-scope.ts — Rule 1: reads can never mutate data.
//
// Every AI request is classified BEFORE any tool runs into one of
//   READ · CREATE · UPDATE · DELETE · MIXED · UNKNOWN
// and the classification decides the turn's mutation budget:
//
//   intent = READ  →  allowedMutations = "none"
//   anything else  →  allowedMutations = "all"
//
// A read-only turn is then made TECHNICALLY incapable of writing: the engine
// refuses write tools before they execute, and the storage proxy refuses
// write methods even if some path reaches them (server/mutation-scope.ts).
// Nothing about a read turn is inferred from conversation history: previous
// actions are context, not authorization, and every user message receives a
// fresh scope.
//
// WHY THE CLASSIFIER IS CONSERVATIVE. The routing gates that used to refuse
// tool calls on a regex reading of the user's prose were removed because they
// refused real work (see tests/no-intent-veto.test.ts). This classifier only
// says READ when the whole message is question-shaped and NO clause carries a
// request for a change. "Can you add a task?" is a request that happens to end
// in a question mark — it is not READ. "Where did this expense save?" is READ.
// When in doubt the answer is UNKNOWN, which never blocks anything.

import { isBareConfirmation, isCorrection, splitIntentClauses } from "./ai-intent";

export type TurnIntent = "READ" | "CREATE" | "UPDATE" | "DELETE" | "MIXED" | "UNKNOWN";
export type MutationBudget = "none" | "all";

export interface TurnScope {
  intent: TurnIntent;
  allowedMutations: MutationBudget;
  /** Why the classifier decided what it did — logged, never shown. */
  reason: string;
  /** Per-clause reads, in message order. */
  clauses: Array<{ text: string; kind: "read" | "write" | "neutral" }>;
}

const lc = (s: unknown): string => String(s ?? "").toLowerCase();

/** Clause openings that are asking, not telling. */
const INQUIRY_LEAD =
  /^\s*(?:so\s+|and\s+|also\s+|hey\s+|hi\s+|ok\s+|okay\s+|please\s+)?(?:what|whats|what's|when|when's|where|where's|which|who|whose|why|how|do\s+i|did\s+i|did\s+you|did\s+it|did\s+that|does|is|are|was|were|has|have\s+i|have\s+you|had|am\s+i|should\s+i|can\s+i\s+see|can\s+you\s+(?:show|tell|list|find|look|check|give|remind\s+me\s+what|explain|summari[sz]e|pull\s+up)|could\s+you\s+(?:show|tell|list|find|look|check|give|explain|summari[sz]e|pull\s+up)|would\s+you\s+(?:show|tell|list|find|explain)|show|list|display|tell\s+me|give\s+me|find|look\s+up|lookup|search|pull\s+up|summari[sz]e|recap|explain|check\s+(?:my|the|on|whether|if)|any\s+(?:idea|chance)|remind\s+me\s+(?:what|when|where|which|who|how))\b/;

/**
 * Verbs that ask for a change. Deliberately broad — a false "write" here only
 * means the turn is NOT read-only, which is the safe direction.
 */
const WRITE_VERB =
  /\b(?:create|creating|add|adding|make|making|new|register|set\s+up|setting\s+up|schedule|scheduling|book|booking|update|updating|change|changing|edit|editing|modify|modifying|rename|renaming|delete|deleting|remove|removing|drop|erase|clear|log|logging|track|tracking|record|recording|remind|reminder|note\s+(?:that|down)|jot|save|saving|upload|attach|link|unlink|move|moving|transfer|split|merge|assign|reassign|mark|complete|completed|finish|finished|done|check\s*(?:-|\s)?(?:in|off)|pay|paid|paying|cancel|undo|redo|revert|restore|archive|duplicate|copy|import|export|sync|refresh|revalue|adjust|increase|decrease|bump|top\s+up|start|stop|pause|resume|snooze|dismiss|remember\s+(?:that|to|this)|forget)\b/;

/** Past-tense / auxiliary framings that make a write verb part of a question. */
const PAST_INQUIRY =
  /\b(?:did|didn't|have|haven't|has|hasn't|had|was|were|is|are|been|already|ever|when|where|whether|if)\s+(?:i|you|it|that|this|we|they|the|my|a|an)?\s*(?:\w+\s+){0,2}(?:create|created|add|added|make|made|log|logged|track|tracked|record|recorded|save|saved|update|updated|change|changed|delete|deleted|remove|removed|pay|paid|mark|marked|complete|completed|finish|finished|schedule|scheduled|upload|uploaded|attach|attached|link|linked|move|moved|book|booked|set)\b/;

/** Polite-request framings: "can you add", "could you please log", "would you mind creating". */
const POLITE_REQUEST =
  /^\s*(?:hey\s+|hi\s+|ok\s+|okay\s+|so\s+|and\s+|also\s+)?(?:please\s+)?(?:can|could|would|will|may)\s+(?:you|u|ya|we)\s+(?:please\s+|maybe\s+|just\s+|also\s+|go\s+ahead\s+and\s+)?(?:mind\s+)?(?!(?:show|tell|list|find|look|check|give|explain|summari[sz]e|pull\s+up|remind\s+me\s+what)\b)/;

const ACTION_BACKREF = /\b(?:again|undo|redo|revert|do\s+(?:it|that|those|them|the\s+same)|make\s+(?:it|that)|try\s+(?:again|that))\b/;

function classifyClause(clause: string): "read" | "write" | "neutral" {
  const c = lc(clause).trim();
  if (!c) return "neutral";
  if (isBareConfirmation(c)) return "write";
  if (isCorrection(c)) return "write";
  if (ACTION_BACKREF.test(c)) return "write";
  // A polite request that is not one of the "show/tell/list" shapes is a
  // request for work whenever it names a change.
  if (POLITE_REQUEST.test(c) && WRITE_VERB.test(c)) return "write";
  const inquiry = INQUIRY_LEAD.test(c) || c.endsWith("?");
  if (inquiry) {
    // "Where did this expense save?" / "Did I log my run?" — the write verb is
    // the subject of the question, not a request.
    if (!WRITE_VERB.test(c)) return "read";
    if (PAST_INQUIRY.test(c)) return "read";
    if (INQUIRY_LEAD.test(c)) {
      // Question-led, but a change is named later in the same clause
      // ("what's due? also add rent" is split before we get here; "how do I
      // add an expense?" stays a read — it asks HOW).
      if (/^\s*(?:how\s+(?:do|can|would|should)\s+i)\b/.test(c)) return "read";
      // "What should I add?" asks; "what about adding X" asks. A bare
      // question-led clause with a write verb is a question unless it is an
      // imperative tail after a comma/dash.
      if (/[,;—–-]\s*(?:and\s+)?(?:please\s+)?(?:add|create|log|make|set|update|change|delete|remove|mark|pay|save|schedule|book|remind|track|record)\b/.test(c)) return "write";
      return "read";
    }
    // Ends with "?" but not question-led and names a change: "add a task?" —
    // treat as a request (the safe direction).
    return "write";
  }
  if (WRITE_VERB.test(c)) return "write";
  return "neutral";
}

/**
 * Classify one user message. Pure; safe to call before any I/O.
 */
export function classifyTurnScope(message: string): TurnScope {
  const raw = String(message ?? "");
  const trimmed = raw.trim();
  if (!trimmed) {
    return { intent: "UNKNOWN", allowedMutations: "all", reason: "empty message", clauses: [] };
  }
  const parts = splitIntentClauses(raw);
  const list = parts.length > 0 ? parts : [raw];
  // The splitter treats "?" as a boundary and drops it; a message that ends in
  // a question mark asked its last clause as a question.
  if (trimmed.endsWith("?") && !list[list.length - 1].endsWith("?")) {
    list[list.length - 1] = `${list[list.length - 1]}?`;
  }
  const clauses = list.map((text) => ({ text, kind: classifyClause(text) }));
  const reads = clauses.filter((c) => c.kind === "read").length;
  const writes = clauses.filter((c) => c.kind === "write").length;

  if (writes === 0 && reads > 0) {
    return {
      intent: "READ",
      allowedMutations: "none",
      reason: `${reads} question-shaped clause(s), no request for a change`,
      clauses,
    };
  }
  if (writes > 0 && reads > 0) {
    return { intent: "MIXED", allowedMutations: "all", reason: "question and request in one message", clauses };
  }
  if (writes > 0) {
    const m = lc(trimmed);
    const intent: TurnIntent =
      /\b(?:delete|deleting|remove|removing|drop|erase|get\s+rid\s+of)\b/.test(m) ? "DELETE"
      : /\b(?:update|updating|change|changing|edit|editing|modify|rename|renaming|correct|fix|adjust|revise|amend|mark|complete|finish|pay|paid)\b/.test(m) || isCorrection(m) ? "UPDATE"
      : "CREATE";
    return { intent, allowedMutations: "all", reason: `request for a change (${intent.toLowerCase()})`, clauses };
  }
  return { intent: "UNKNOWN", allowedMutations: "all", reason: "no question and no named change — not gated", clauses };
}

/** True when this turn may not write anything. */
export function isReadOnlyTurn(message: string): boolean {
  return classifyTurnScope(message).allowedMutations === "none";
}
