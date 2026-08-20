// shared/content-routing.ts — THE SEMANTIC LAYER.
//
// Why this exists (user report, 2026-08-20, four screenshots):
//
//   "jane doe note: I have the look that one gives somebody"
//        → the chat answered "Journal entry saved for Jane Doe."
//
// The user typed the word NOTE. They got a Journal Entry. The cause was not a
// model mistake — it was the tool contract: `journal_entry` described itself as
// "the ONLY tool for notes", so the correct tool for the request did not exist.
// There was nowhere else for the model to go.
//
// This module is the deterministic half of the fix. It answers ONE question
// about a user message, before any model call and without any I/O:
//
//   WHAT is the user trying to create — a Note, a Journal Entry, a Task, or a
//   structured domain record that owns this information already?
//
// It is deliberately NOT a general parser. Three rules govern every answer:
//
//   1. EXPLICIT INTENT ALWAYS WINS. If the user names the object ("create a
//      note", "journal this", "add a task"), that is the answer, full stop —
//      even when the text also looks like something else. "Create a note that
//      I need to call Progressive tomorrow" is a NOTE. The temporal layer may
//      additionally notice the actionable date; it may never replace the Note.
//
//   2. STRUCTURED DOMAIN OBJECTS TAKE PRIORITY over the three generic kinds.
//      "My birthday is July 10, 1994" is a profile date of birth, not a note
//      about a birthday. Only when no structured home is confidently
//      identified do Note / Journal / Task compete.
//
//   3. SILENCE WHEN UNSURE. `kind: "unknown"` at confidence 0 is a valid and
//      common answer. A low-confidence classification is advisory: it informs
//      the model, it never blocks a tool call.
//
// Pure, dependency-free, no I/O. Pinned by tests/content-routing.test.ts.

import { splitIntentClauses } from "./ai-intent";

// ─── What can a message be? ──────────────────────────────────────────────────

/**
 * The three generic content types, plus the two escape hatches.
 *
 * `structured` means "this belongs to a typed domain record (a profile field, a
 * document expiration, an expense, a liability payment) that already owns it" —
 * the caller routes to that system instead of filing generic content.
 */
export type ContentKind = "note" | "journal" | "task" | "structured" | "unknown";

/** Which typed system claims the information, when `kind` is "structured". */
export type StructuredDomain =
  | "profile_dob"
  | "document_expiration"
  | "expense"
  | "income"
  | "payment_schedule"
  | "appointment";

export interface ContentClassification {
  kind: ContentKind;
  /** True when the user NAMED the object. Explicit intent is never overridden. */
  explicit: boolean;
  /** 0..1. Below CONTENT_CONFIDENCE_FLOOR this is advisory only. */
  confidence: number;
  /** Which typed system owns this, when kind === "structured". */
  structuredDomain?: StructuredDomain;
  /** The person/profile named in the clause ("Robert", "Jane Doe"), or null. */
  profileHint: string | null;
  /** Human-readable justification — goes into logs and the model directive. */
  reason: string;
  /** The clause this classification was built from. */
  clause: string;
}

/** Below this a classification informs the model but never gates a tool call. */
export const CONTENT_CONFIDENCE_FLOOR = 0.7;

const lc = (s: unknown): string => String(s ?? "").toLowerCase();

// ─── Explicit object naming ──────────────────────────────────────────────────
//
// Each pattern must match the user NAMING THE OBJECT, not merely using the
// word. "Note that Robert moved to California" names a note. "I noted the
// mileage" does not, and neither does "the journal of a plague year".

const EXPLICIT_NOTE: RegExp[] = [
  // "create/make/save/add/write a note", "new note"
  /\b(?:create|make|save|add|write|start|jot(?:\s+down)?|leave|put)\s+(?:me\s+)?(?:a|an|the|another|new)?\s*(?:quick\s+|short\s+|little\s+)?note\b/,
  // "note for Robert", "note to self", "note about the car"
  /\bnotes?\s+(?:for|to|about|on|re)\b/,
  // "note that X", "note: X"
  /\bnote\s*(?:that|:)/,
  // "<name> note: ..." — the shape from the bug report ("jane doe note: ...")
  /\b\w[\w\s'.-]{0,40}\bnote\s*:/,
  // "jot this down", "jot down that"
  /\bjot\s+(?:this|that|it)?\s*down\b/,
  // "add this to my notes", "in my notes"
  /\b(?:to|in|under)\s+(?:my|his|her|their|the)\s+notes\b/,
];

const EXPLICIT_JOURNAL: RegExp[] = [
  /\bjournals?\b/,
  /\bdiar(?:y|ies)\b/,
  /\bdaily\s+log\b/,
];

const EXPLICIT_TASK: RegExp[] = [
  /\b(?:create|make|add|new|set\s+up)\s+(?:me\s+)?(?:a|an|the|another)?\s*(?:new\s+)?(?:task|to-?do|chore)\b/,
  /\btasks?\s+(?:for|to)\b/,
  /\bto-?do\s+(?:list|item|for)\b/,
  // "remind me to X", "remind Robert to X", "set a reminder"
  /\bremind\s+(?:me|him|her|them|us|\w+)\s+(?:to|about|that)\b/,
  /\b(?:set|create|add)\s+(?:a|an)?\s*reminder\b/,
];

/**
 * A clause that only says WHERE to file the message, with no content of its
 * own: "Journal this.", "Save this in my journal", "Make a note of that".
 *
 * These are directives ABOUT the rest of the message, not separate objects, so
 * the router folds them back onto the surrounding narrative rather than
 * emitting an empty second action. Without this, "I bought dog food Saturday
 * and my dog loved it. Journal this." produced a task for the purchase and an
 * empty journal entry.
 */
const BARE_DIRECTIVE =
  /^(?:please\s+)?(?:can\s+you\s+)?(?:add|save|put|file|record|write|keep|make|log)?\s*(?:this|that|it|the\s+above)?\s*(?:down)?\s*(?:in|to|into|as|on|under)?\s*(?:my|his|her|their|the)?\s*(?:journal|diary|notes?)\b[\s.!]*$/;

/** "journal this", "note this" — verb-first bare directives. */
const BARE_DIRECTIVE_VERBED =
  /^(?:please\s+)?(?:journal|note|jot)\s+(?:this|that|it|the\s+above)\b[\s.!]*$/;

export function isBareFilingDirective(clause: string): boolean {
  const c = lc(clause).trim();
  if (!c) return false;
  return BARE_DIRECTIVE.test(c) || BARE_DIRECTIVE_VERBED.test(c);
}

/** Which object did the user NAME in this clause, if any? Earliest wins. */
export function detectExplicitKind(clause: string): { kind: ContentKind; at: number } | null {
  const c = lc(clause);
  if (!c) return null;

  let best: { kind: ContentKind; at: number } | null = null;
  const consider = (kind: ContentKind, res: RegExp[]) => {
    for (const re of res) {
      const at = c.search(re);
      if (at === -1) continue;
      if (!best || at < best.at) best = { kind, at };
    }
  };
  consider("note", EXPLICIT_NOTE);
  consider("journal", EXPLICIT_JOURNAL);
  consider("task", EXPLICIT_TASK);
  return best;
}

// ─── Structured domains ──────────────────────────────────────────────────────
//
// Information that a typed record already owns. Routing these to a Note is the
// failure mode the spec calls out by name: a birthday buried in note text does
// not produce a birthday on the calendar, because the calendar reads the
// profile's date-of-birth field, not prose.

const DATEY =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/;

const STRUCTURED_RULES: Array<{
  domain: StructuredDomain;
  re: RegExp;
  /** Also require a date-shaped token in the clause. */
  needsDate?: boolean;
  weight: number;
}> = [
  { domain: "profile_dob", re: /\b(?:birthday|date\s+of\s+birth|dob|was\s+born|born\s+on)\b/, needsDate: true, weight: 0.92 },
  { domain: "document_expiration", re: /\b(?:expires?|expiration|expiry|renewal\s+date|valid\s+(?:through|until))\b/, needsDate: true, weight: 0.9 },
  { domain: "expense", re: /\b(?:spent|paid)\b[^.]*\$\s?\d|\$\s?\d[\d,.]*\s+(?:at|on|for)\b/, weight: 0.88 },
  { domain: "income", re: /\b(?:got\s+paid|paycheck|received\s+\$|deposited)\b/, weight: 0.85 },
  { domain: "payment_schedule", re: /\bpayment\s+is\s+\$?\d|\$\s?\d[\d,.]*\s+(?:on\s+the\s+\d{1,2}(?:st|nd|rd|th)?|every\s+month|monthly)\b/, weight: 0.85 },
  { domain: "appointment", re: /\bappointment\b/, needsDate: true, weight: 0.8 },
];

/**
 * Obligation modality — the user is describing WORK, not a fact.
 *
 * This is checked BEFORE structured domains on purpose. "My registration
 * expires October 10" is an expiration field; "I need to renew my registration
 * before October 10" is a task ABOUT that expiration, and the two legitimately
 * coexist (the spec says so explicitly). The modality is what tells them apart.
 */
const OBLIGATION_MODALITY =
  /\b(?:needs?\s+to|need\s+to|have\s+to|has\s+to|must|should|don'?t\s+forget|remember\s+to|make\s+sure\s+to|gotta|got\s+to|remind)\b/;

export function detectStructuredDomain(clause: string): { domain: StructuredDomain; confidence: number } | null {
  const c = lc(clause);
  if (!c) return null;
  // Work about a structured record is a Task, not an edit to the record.
  if (OBLIGATION_MODALITY.test(c)) return null;

  for (const rule of STRUCTURED_RULES) {
    if (!rule.re.test(c)) continue;
    if (rule.needsDate && !DATEY.test(c)) continue;
    return { domain: rule.domain, confidence: rule.weight };
  }
  return null;
}

// ─── Implicit classification ─────────────────────────────────────────────────

/** Verbs that name WORK. Something has to happen for this to be satisfied. */
const ACTION_VERBS =
  /\b(?:call|phone|email|text|message|buy|purchase|order|pick\s+up|drop\s+off|pay|submit|file|mail|send|schedule|book|renew|register|cancel|return|fix|repair|replace|clean|wash|mow|water|feed|walk|take\s+out|take|bring|check|confirm|follow\s+up|reach\s+out|apply|sign|print|deposit|withdraw|refill|change|install|update|finish|complete|start|review)\b/;

/** First word is a bare imperative — "Call Progressive.", "Buy dog food." */
const LEADING_IMPERATIVE =
  /^\s*(?:please\s+)?(?:call|phone|email|text|message|buy|purchase|order|pay|submit|file|mail|send|schedule|book|renew|register|cancel|return|fix|repair|replace|clean|wash|mow|water|feed|walk|take|bring|check|confirm|apply|sign|print|refill|install|finish|pick)\b/;

/** Experience, reflection, memory, narrative. */
const JOURNAL_SIGNALS: RegExp[] = [
  /\b(?:today|tonight|yesterday|this\s+(?:morning|afternoon|evening|weekend)|last\s+night)\s+(?:was|felt|has\s+been|i|we|he|she|they)\b/,
  /\b(?:i|we|he|she|they)\s+(?:felt|feel|was|were|had|have\s+been|has\s+been|went|got|spent|enjoyed|struggled|loved|hated)\b/,
  /\b(?:i'?ve|i\s+have)\s+been\s+(?:thinking|feeling|wondering)\b/,
  /\bseemed\b|\bwas\s+a\s+(?:really\s+)?(?:good|bad|great|rough|long|hard|exhausting|stressful)\s+day\b/,
  /\b(?:exhausting|stressful|frustrating|wonderful|amazing)\s+day\b/,
  /\bwhat\s+a\s+day\b/,
];

/** Reference information: a fact stated for later recall. */
const NOTE_SIGNALS: RegExp[] = [
  /\bremember\s+that\b/,
  /\bkeep\s+in\s+mind\b/,
  /\bfor\s+(?:future\s+)?reference\b/,
  /\bfyi\b/,
  /\b(?:prefers?|likes?|dislikes?|hates?|is\s+allergic\s+to)\b/,
  /\b(?:code|password|combination|pin|wifi|address|phone\s+number)\s+is\b/,
  /\bmakes?\s+a\s+\w+\s+(?:sound|noise)\b/,
];

const score = (clause: string, signals: RegExp[]): number => {
  const c = lc(clause);
  let hits = 0;
  for (const re of signals) if (re.test(c)) hits++;
  return hits;
};

// ─── Person resolution hint ──────────────────────────────────────────────────

/**
 * The person the clause is ABOUT, when the clause says so in a shape we can
 * read without a database. Returns null far more often than not — the model
 * still resolves the profile, and the server still matches it against real
 * rows. This exists so the deterministic layer can be TESTED end to end and so
 * a wrong profile is caught, not so it replaces resolution.
 */
export function extractProfileHint(clause: string): string | null {
  const raw = String(clause ?? "").trim();
  if (!raw) return null;

  // "for Robert", "for Jane Doe" — stop before a filing noun or punctuation.
  const forHit = raw.match(
    /\bfor\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,2})\b(?!\s*(?:note|journal|task|entry)\b)/,
  );
  if (forHit) return cleanName(forHit[1]);

  // "add to Mike's journal", "Robert's gate code"
  const possessive = raw.match(/\b([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*){0,1})'s\b/);
  if (possessive) return cleanName(possessive[1]);

  // "jane doe note: ..." — a leading name followed by the object word. The bug
  // report's exact shape, and lowercase, so the capital-letter rules miss it.
  const leading = raw.match(/^\s*([\w'-]+(?:\s+[\w'-]+){0,2})\s+(?:note|journal|task)\s*:/i);
  if (leading) return cleanName(leading[1]);

  // "Robert needs to …", "Sarah has to …" — the subject of an obligation.
  const subject = raw.match(/^\s*([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)\s+(?:needs?|has|have|must|should)\s+to\b/);
  if (subject) return cleanName(subject[1]);

  // "Remind Robert to …" — sentence-initial, so the verb needs /i while the
  // name still has to look like a name.
  const remind = raw.match(/\bremind\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)?)\s+(?:to|about)\b/i);
  if (remind && /^[A-Z]/.test(remind[1])) return cleanName(remind[1]);

  return null;
}

const STOP_NAMES = new Set([
  "i", "me", "my", "mine", "myself", "self", "us", "we", "our",
  "today", "tomorrow", "yesterday", "note", "journal", "task", "the", "a", "an",
]);

function cleanName(raw: string): string | null {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return null;
  if (STOP_NAMES.has(name.toLowerCase())) return null;
  if (name.length > 60) return null;
  return name;
}

// ─── One clause → one classification ─────────────────────────────────────────

export function classifyClause(clause: string): ContentClassification {
  const raw = String(clause ?? "").trim();
  const base = { profileHint: extractProfileHint(raw), clause: raw };
  if (!raw) {
    return { kind: "unknown", explicit: false, confidence: 0, reason: "empty clause", ...base };
  }

  // 1. EXPLICIT INTENT ALWAYS WINS.
  const explicit = detectExplicitKind(raw);
  if (explicit) {
    return {
      kind: explicit.kind,
      explicit: true,
      confidence: 0.98,
      reason: `user named the object ("${explicit.kind}") — explicit intent is never overridden`,
      ...base,
    };
  }

  // 2. STRUCTURED DOMAIN OBJECTS TAKE PRIORITY over the generic three.
  const structured = detectStructuredDomain(raw);
  if (structured) {
    return {
      kind: "structured",
      explicit: false,
      confidence: structured.confidence,
      structuredDomain: structured.domain,
      reason: `information owned by the ${structured.domain} record, not by generic content`,
      ...base,
    };
  }

  // 3. IMPLICIT: does something need to be DONE?
  const c = lc(raw);
  const taskish = OBLIGATION_MODALITY.test(c) || LEADING_IMPERATIVE.test(c);
  const journalHits = score(raw, JOURNAL_SIGNALS);
  const noteHits = score(raw, NOTE_SIGNALS);

  if (taskish) {
    // "Remember that I want to research gym franchises" carries `remember
    // that` — a NOTE marker — and no work. The modality word alone is not a
    // task when the sentence is plainly a fact being filed.
    if (noteHits > 0 && !LEADING_IMPERATIVE.test(c) && !/\bremind\b/.test(c)) {
      return { kind: "note", explicit: false, confidence: 0.78, reason: "reference information, stated for later recall", ...base };
    }
    return {
      kind: "task",
      explicit: false,
      confidence: LEADING_IMPERATIVE.test(c) ? 0.9 : 0.88,
      reason: "something needs to be done — obligation modality or leading imperative",
      ...base,
    };
  }

  // Reflection beats reference when the sentence is about EXPERIENCE.
  if (journalHits > 0 && journalHits >= noteHits) {
    return {
      kind: "journal",
      explicit: false,
      confidence: journalHits >= 2 ? 0.86 : 0.76,
      reason: "experience, reflection or narrative rather than reference information",
      ...base,
    };
  }

  if (noteHits > 0) {
    return { kind: "note", explicit: false, confidence: 0.84, reason: "reference information worth remembering", ...base };
  }

  // A bare action verb with no modality — "Buy dog food every Saturday".
  if (ACTION_VERBS.test(c)) {
    return { kind: "task", explicit: false, confidence: 0.72, reason: "action verb with no reflective or reference framing", ...base };
  }

  // A plain declarative fact about someone ("Robert likes Italian food") is a
  // note; it is the app's least destructive home for information.
  if (/\b(?:is|are|was|were|has|have)\b/.test(c)) {
    return { kind: "note", explicit: false, confidence: 0.68, reason: "declarative fact with no action and no reflection", ...base };
  }

  return { kind: "unknown", explicit: false, confidence: 0, reason: "no confident read", ...base };
}

// ─── One message → 0..N classifications ──────────────────────────────────────

export interface ContentRoutingPlan {
  message: string;
  /** One entry per independently-actionable clause, message order preserved. */
  actions: ContentClassification[];
  /** True when EVERY clause produced a confident read. */
  exhaustive: boolean;
}

/**
 * Route a whole user message. ONE MESSAGE CAN PRODUCE MULTIPLE OBJECTS —
 * "Journal this: I had a stressful day. Remind me to call my landlord
 * tomorrow." is a Journal Entry AND a Task, and forcing it into one object
 * loses half of what the user said.
 *
 * A trailing bare filing directive ("… Journal this.") is not a second object:
 * it re-files the clause before it.
 */
export function routeContent(message: string): ContentRoutingPlan {
  const raw = String(message ?? "").trim();
  if (!raw) return { message: raw, actions: [], exhaustive: false };

  const clauses = splitIntentClauses(raw).filter((c) => c.trim().length > 0);
  if (clauses.length <= 1) {
    const one = classifyClause(raw);
    return { message: raw, actions: [one], exhaustive: one.confidence >= CONTENT_CONFIDENCE_FLOOR };
  }

  const actions: ContentClassification[] = [];
  for (const clause of clauses) {
    if (isBareFilingDirective(clause)) {
      // Re-file the preceding clause under the named object, keeping ITS text.
      const target = detectExplicitKind(clause)?.kind ?? "journal";
      const prev = actions.pop();
      const merged = prev ?? classifyClause(raw);
      actions.push({
        ...merged,
        kind: target,
        explicit: true,
        confidence: 0.95,
        structuredDomain: undefined,
        reason: `filing directive ("${clause.trim()}") applies to the preceding text`,
      });
      continue;
    }
    actions.push(classifyClause(clause));
  }

  const confident = actions.filter((a) => a.confidence >= CONTENT_CONFIDENCE_FLOOR);
  return { message: raw, actions, exhaustive: actions.length > 0 && confident.length === actions.length };
}

/** Convenience: the single best read of a message, for logging and gating. */
export function classifyContent(message: string): ContentClassification {
  const plan = routeContent(message);
  if (plan.actions.length === 0) {
    return { kind: "unknown", explicit: false, confidence: 0, profileHint: null, reason: "empty message", clause: "" };
  }
  // An explicit read anywhere in the message outranks an inferred one.
  return plan.actions.find((a) => a.explicit) ?? plan.actions[0];
}

// ─── The gate ────────────────────────────────────────────────────────────────

/** Which of the three content types each chat tool writes. */
export const CONTENT_TOOL_KIND: Record<string, Exclude<ContentKind, "structured" | "unknown">> = {
  create_note: "note",
  update_note: "note",
  delete_note: "note",
  journal_entry: "journal",
  append_journal_entry: "journal",
  update_journal: "journal",
  delete_journal: "journal",
  create_task: "task",
  update_task: "task",
  delete_task: "task",
  complete_task: "task",
};

export interface ContentRoutingViolation {
  tool: string;
  requestedKind: ContentKind;
  toolKind: ContentKind;
  /** Handed back to the model as a tool error so it can correct itself. */
  modelDirective: string;
  /** Safe to show the user if the turn ends here. */
  userMessage: string;
}

/**
 * THE FIX FOR THE REPORTED BUG.
 *
 * When the user NAMED one of the three content types, a tool that writes a
 * different one is refused — deterministically, before the write. "jane doe
 * note: …" can no longer become a journal entry no matter what the model
 * decides, because this gate does not consult the model.
 *
 * Deliberately narrow:
 *   · only fires on EXPLICIT naming (the classifier's `explicit` flag);
 *   · only against the three generic content tools — everything else, including
 *     a task created ALONGSIDE the note, passes freely, because one message
 *     legitimately produces several objects;
 *   · silent when the message names more than one kind, since then every one of
 *     them is legitimately requested.
 */
export function checkContentRouting(toolName: string, message: string): ContentRoutingViolation | null {
  const toolKind = CONTENT_TOOL_KIND[toolName];
  if (!toolKind) return null;

  const plan = routeContent(message);
  const explicitKinds = new Set(plan.actions.filter((a) => a.explicit).map((a) => a.kind));
  if (explicitKinds.size === 0) return null;
  // Several objects were named — this tool serves one of them, or serves an
  // implicit clause we did not gate. Either way, not a routing error.
  if (explicitKinds.size > 1) return null;
  const [requestedKind] = Array.from(explicitKinds);
  if (requestedKind === toolKind) return null;
  // The message also carries an unnamed clause that this tool could be serving
  // ("Journal this: … Remind me to call the landlord tomorrow." → create_task
  // serves the second clause). Only refuse when every clause was the named one.
  if (plan.actions.some((a) => !a.explicit && a.kind === toolKind)) return null;

  const right = requestedKind === "note" ? "create_note"
    : requestedKind === "journal" ? "journal_entry"
      : "create_task";
  return {
    tool: toolName,
    requestedKind,
    toolKind,
    modelDirective:
      `The user explicitly asked for a ${requestedKind.toUpperCase()}, and ${toolName} writes a ${toolKind}. ` +
      `Explicit intent is never overridden. Call ${right} instead. If the content ALSO deserves a ${toolKind}, ` +
      `create that as a SECOND object in addition to the ${requestedKind} — never in place of it.`,
    userMessage: `You asked for a ${requestedKind}, so I saved it as a ${requestedKind}.`,
  };
}
