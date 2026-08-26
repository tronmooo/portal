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
 * Every canonical destination a piece of information about a person can have.
 *
 * The first five are the GENERIC kinds — they hold information no typed record
 * claims. Everything after them is a STRUCTURED domain: a typed record that
 * already owns this class of fact, and which must win, because a birthday
 * buried in note prose never becomes a birthday on the calendar.
 *
 * `structured` is retained as a coarse alias for "some typed record owns this"
 * so callers that only care about generic-vs-typed keep working; `isStructured`
 * is the test, and `structuredDomain` carries the specific answer.
 */
export type DomainKind =
  // Generic content
  | "note" | "journal" | "task" | "habit" | "event"
  // Structured domains
  | "profile_field" | "asset" | "liability" | "income" | "expense"
  | "subscription" | "document" | "health" | "pet" | "tracker"
  // Artifacts (documents/checklists the app generates) — never produced by the
  // classifier, only used to name what create_artifact writes so the routing
  // guard can refuse it when the user asked for something else.
  | "artifact"
  // Escape hatches
  | "structured" | "unknown";

/** Back-compatible alias — the router's kind vocabulary is now the full taxonomy. */
export type ContentKind = DomainKind;

/** The generic kinds: content with no typed record of its own. */
export const GENERIC_KINDS: ReadonlySet<DomainKind> = new Set<DomainKind>([
  "note", "journal", "task", "habit", "event",
]);

export function isStructured(kind: DomainKind): boolean {
  return kind !== "unknown" && !GENERIC_KINDS.has(kind);
}

/**
 * Which typed record claims the information, and — for profile data — WHICH
 * FIELD of it. The field matters: "my email is x@y.com" and "my birthday is
 * July 10" are both profile writes, but only one of them produces a Date Rule.
 */
export type StructuredDomain =
  // Profile attributes
  | "profile_dob"
  | "profile_contact"
  | "profile_address"
  | "profile_employment"
  | "profile_identifier"
  | "profile_attribute"
  // Records
  | "document_expiration"
  | "expense"
  | "income"
  | "payment_schedule"
  | "subscription"
  | "appointment"
  | "asset"
  | "liability"
  | "health"
  | "pet"
  | "tracker";

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

const EXPLICIT_HABIT: RegExp[] = [
  /\bhabits?\b/,
  /\broutines?\b/,
  /\bstreaks?\b/,
  /\bmake\s+(?:this|that|it)\s+(?:a\s+)?(?:daily|weekly)?\s*(?:habit|routine)\b/,
];

const EXPLICIT_EVENT: RegExp[] = [
  /\b(?:create|add|make|new|put|schedule)\s+(?:me\s+)?(?:an?|the)?\s*(?:calendar\s+)?(?:event|appointment|meeting)\b/,
  /\bon\s+(?:my|his|her|the)\s+calendar\b/,
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
  // Habit is considered LAST at equal position on purpose: "remind me to
  // stretch every day" names a task AND carries a habit cue, and the named
  // object is what the user asked for. `consider` keeps the earliest match, so
  // a habit only wins when its word comes first.
  consider("habit", EXPLICIT_HABIT);
  consider("event", EXPLICIT_EVENT);
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

/**
 * Typed records, in priority order. The FIRST rule that matches wins, so the
 * most specific claims are listed before the broader ones.
 *
 * `kind` is where the information is written; `domain` says which part of that
 * record, which is what tells "my email is x@y.com" (no date) apart from "my
 * birthday is July 10" (a yearly Date Rule) even though both are profile writes.
 */
const STRUCTURED_RULES: Array<{
  kind: DomainKind;
  domain: StructuredDomain;
  re: RegExp;
  /** Also require a date-shaped token in the clause. */
  needsDate?: boolean;
  weight: number;
}> = [
  // ── Profile attributes ────────────────────────────────────────────────────
  // These are the ones that used to become notes. An email address filed as
  // note prose is not on the person's record, does not show in their Info tab,
  // and cannot be looked up — which is the whole complaint.
  { kind: "profile_field", domain: "profile_dob", re: /\b(?:birthday|date\s+of\s+birth|dob|was\s+born|born\s+on)\b/, needsDate: true, weight: 0.92 },
  { kind: "profile_field", domain: "profile_contact", re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/, weight: 0.94 },
  { kind: "profile_field", domain: "profile_contact", re: /\b(?:phone|cell|mobile|number\s+is)\b[^.]{0,20}(?:\+?\d[\d\s().-]{7,})|\b\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/, weight: 0.9 },
  { kind: "profile_field", domain: "profile_address", re: /\b(?:address\s+is|lives?\s+at|moved\s+to\s+\d|mailing\s+address)\b|\b\d{1,6}\s+[A-Za-z][\w'-]*\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pl|place|pkwy|parkway|cir|circle|ter|terrace)\b/i, weight: 0.88 },
  { kind: "profile_field", domain: "profile_employment", re: /\b(?:works?\s+(?:at|for)|employer\s+is|employed\s+(?:at|by)|job\s+is\s+at|company\s+is)\b/, weight: 0.88 },
  { kind: "profile_field", domain: "profile_identifier", re: /\b(?:license|licence|passport|policy|member|account|vin|badge|employee|student|medicaid|medicare|insurance)\s*(?:#|no\.?|number|id)\b|\bssn\b/, weight: 0.88 },
  { kind: "profile_field", domain: "profile_attribute", re: /\b(?:blood\s+type|allerg(?:y|ic|ies)|height\s+is|weight\s+is|shoe\s+size|shirt\s+size|ring\s+size|eye\s+colou?r|hair\s+colou?r)\b/, weight: 0.86 },

  // ── Records ───────────────────────────────────────────────────────────────
  { kind: "document", domain: "document_expiration", re: /\b(?:expires?|expiration|expiry|renewal\s+date|valid\s+(?:through|until))\b/, needsDate: true, weight: 0.9 },
  // Income is tested BEFORE expense: "I got paid $2,400" contains the word
  // "paid", and money coming IN filed as money going OUT is not a near miss.
  { kind: "income", domain: "income", re: /\b(?:got\s+paid|paid\s+me|paycheck|received\s+\$|deposited|salary\s+is|earn(?:ed)?\s+\$|make\s+\$[\d,]+\s+(?:a|per)\s+(?:year|month|hour))\b/, weight: 0.86 },
  { kind: "expense", domain: "expense", re: /\b(?:spent|paid)\b[^.]*\$\s?\d|\$\s?\d[\d,.]*\s+(?:at|on|for)\b/, weight: 0.88 },
  { kind: "subscription", domain: "subscription", re: /\bsubscri(?:ption|be[ds]?)\b|\b(?:netflix|spotify|hulu|disney\+|youtube\s+premium|icloud|dropbox)\b[^.]{0,30}\$\s?\d/, weight: 0.85 },
  { kind: "liability", domain: "payment_schedule", re: /\bpayment\s+is\s+\$?\d|\$\s?\d[\d,.]*\s+(?:on\s+the\s+\d{1,2}(?:st|nd|rd|th)?|every\s+month|monthly)\b/, weight: 0.85 },
  { kind: "liability", domain: "liability", re: /\b(?:owes?\s+\$|balance\s+(?:is|of)\s+\$|loan\s+(?:is|of|for)\s+\$|mortgage|car\s+note)\b/, weight: 0.84 },
  { kind: "asset", domain: "asset", re: /\b(?:worth|valued\s+at|appraised\s+at)\b[^.]{0,20}\$\s?\d|\bbought\s+(?:a|an|my)\b[^.]{0,40}\bfor\s+\$\s?\d/, weight: 0.82 },
  { kind: "health", domain: "health", re: /\b(?:blood\s+pressure|a1c|cholesterol|prescribed|diagnos(?:ed|is)|dosage|mg\s+(?:of|daily)|symptoms?)\b/, weight: 0.8 },
  { kind: "pet", domain: "pet", re: /\b(?:breed\s+is|microchip|vet\s+(?:is|said)|spayed|neutered|litter\s+box)\b/, weight: 0.8 },
  { kind: "event", domain: "appointment", re: /\bappointment\b/, needsDate: true, weight: 0.8 },
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

export function detectStructuredDomain(
  clause: string,
): { kind: DomainKind; domain: StructuredDomain; confidence: number } | null {
  const raw = String(clause ?? "");
  const c = lc(raw);
  if (!c) return null;
  // Work about a structured record is a Task, not an edit to the record.
  if (OBLIGATION_MODALITY.test(c)) return null;

  for (const rule of STRUCTURED_RULES) {
    // Email/address/phone patterns are case-sensitive-ish; test the raw text
    // for those and the lowered text for the word-based rules.
    if (!rule.re.test(c) && !rule.re.test(raw)) continue;
    if (rule.needsDate && !DATEY.test(c)) continue;
    return { kind: rule.kind, domain: rule.domain, confidence: rule.weight };
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

// ─── Habit vs recurring Task ─────────────────────────────────────────────────
//
// Both repeat. The app models them differently and the difference is real:
//
//   HABIT — a BEHAVIOUR you are building or maintaining. It has a streak, a
//     per-day target, and check-ins; missing one is not "overdue", it is a gap
//     in a streak. "Take my medication every day at 8", "meditate each morning".
//
//   RECURRING TASK — a CHORE that comes due. It has a due date, it goes
//     overdue, and completing one occurrence spawns the next. "Take out the
//     trash every Tuesday", "pay rent on the first".
//
// The test that separates them is not the cadence — both have one — it is
// whether the sentence describes a personal practice or an errand against the
// outside world. A chore verb with an external object is a task; a
// self-directed behaviour on a cadence is a habit.
//
// NOTE ON A SPEC CONFLICT: the earlier routing spec asked for "take medication
// every day at 8 AM" as a recurring TASK. The later one asks for behaviours on
// a schedule to become HABITS. This module implements the later rule, and
// leaves chores ("take out the trash every Tuesday", "buy dog food every
// Saturday") as recurring tasks, which both specs agree on. Explicit wording —
// "add a task to…" or "make it a habit" — overrides either way.

/** Does the clause state a repeating cadence at all? */
const RECURRENCE_CUE =
  /\b(?:every|each)\s+(?:day|morning|afternoon|evening|night|week|weekday|weekend|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|other\s+day|\d+\s+(?:days?|weeks?|months?))\b|\b(?:daily|nightly|weekly|biweekly|monthly|twice\s+a\s+day|\d+x\s*(?:a|per)\s*day)\b/;

/** Self-directed practices — the things people build streaks around. */
const HABIT_BEHAVIOURS =
  /\b(?:medication|medicine|meds|pill|vitamin|supplement|insulin|inhaler|meditat\w*|exercise|workout|work\s+out|gym|run|running|jog\w*|walk|walking|stretch\w*|yoga|pushups?|situps?|steps|water|hydrate|drink\s+water|read|reading|journal\w*|floss\w*|brush\s+(?:my|his|her|their)?\s*teeth|skincare|sunscreen|practice|study|studying|breathe|breathing|weigh\s+(?:myself|in)|track)\b/;

/** Errands against the outside world — chores that come due. */
const CHORE_OBJECTS =
  /\b(?:trash|garbage|recycling|bins?|rent|bill|bills|mortgage|dishes|laundry|lawn|grass|groceries|dog\s+food|cat\s+food|litter|mail|oil\s+change|filter|car\s+wash|invoice|timesheet|report)\b/;

export interface HabitReadResult {
  isHabit: boolean;
  reason: string;
}

/**
 * Is this repeating clause a HABIT rather than a recurring task?
 *
 * Returns false when there is no cadence at all — a one-off is never a habit —
 * and false for chores, which stay tasks.
 */
export function readsAsHabit(clause: string): HabitReadResult {
  const c = lc(clause);
  if (!c) return { isHabit: false, reason: "empty" };
  if (!RECURRENCE_CUE.test(c)) return { isHabit: false, reason: "no repeating cadence — a one-off is never a habit" };
  if (CHORE_OBJECTS.test(c)) return { isHabit: false, reason: "a recurring chore against the outside world is a task, not a streak" };
  if (HABIT_BEHAVIOURS.test(c)) return { isHabit: true, reason: "a self-directed behaviour on a cadence — this is what habits and streaks are for" };
  return { isHabit: false, reason: "repeats, but reads as an errand rather than a practice" };
}

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
      kind: structured.kind,
      explicit: false,
      confidence: structured.confidence,
      structuredDomain: structured.domain,
      reason: `information owned by the ${structured.kind} record (${structured.domain}) — not generic content`,
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
    // A repeating self-directed behaviour is a HABIT, not a task that respawns.
    const habit = readsAsHabit(raw);
    if (habit.isHabit) {
      return { kind: "habit", explicit: false, confidence: 0.85, reason: habit.reason, ...base };
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
  if (ACTION_VERBS.test(c) || RECURRENCE_CUE.test(c)) {
    const habit = readsAsHabit(raw);
    if (habit.isHabit) {
      return { kind: "habit", explicit: false, confidence: 0.82, reason: habit.reason, ...base };
    }
    if (ACTION_VERBS.test(c)) {
      return { kind: "task", explicit: false, confidence: 0.72, reason: "action verb with no reflective or reference framing", ...base };
    }
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

/**
 * Which GENERIC content type each chat tool writes.
 *
 * Only the generic kinds are listed. A structured write (update_profile,
 * create_expense, create_liability…) is never gated here: those tools are how
 * the router's structured verdict gets ACTED on, and refusing them would block
 * the very routing this module asks for.
 */
export const CONTENT_TOOL_KIND: Record<string, DomainKind> = {
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
  create_habit: "habit",
  update_habit: "habit",
  delete_habit: "habit",
  create_event: "event",
  update_event: "event",
  delete_event: "event",
  // User report 2026-08-22: "TSA PreCheck note was routed through Create
  // Artifact." The classifier read "note" correctly and with high confidence —
  // nothing refused the artifact write, because these tools were missing here.
  // An artifact is a generated document, not a place to put a note.
  create_artifact: "artifact",
  update_artifact: "artifact",
  duplicate_artifact: "artifact",
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
  const explicitKinds = new Set(
    plan.actions.filter((a) => a.explicit && GENERIC_KINDS.has(a.kind)).map((a) => a.kind),
  );
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
      : requestedKind === "habit" ? "create_habit"
        : requestedKind === "event" ? "create_event"
          : "create_task";
  return {
    tool: toolName,
    requestedKind,
    toolKind,
    modelDirective:
      `The user explicitly asked for a ${requestedKind.toUpperCase()}, and ${toolName} writes ${/^[aeiou]/.test(toolKind) ? "an" : "a"} ${toolKind}. ` +
      `Explicit intent is never overridden. Call ${right} instead. If the content ALSO deserves a ${toolKind}, ` +
      `create that as a SECOND object in addition to the ${requestedKind} — never in place of it.`,
    userMessage: `You asked for a ${requestedKind}, so I saved it as a ${requestedKind}.`,
  };
}
