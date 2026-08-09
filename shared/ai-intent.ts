// shared/ai-intent.ts — the PRE-EXECUTION INTENT OBJECT.
//
// Why this exists (production report 2026-08-09, four screenshots):
//
//   "Create an asset for my Dodge Ram 2025. It's white four-wheel-drive."
//        → the model called update_profile and the chat said
//          "Updated the Dodge Ram 2025 — color: white, drive type: 4WD."
//
//   "Create me a habit to walk the dog twice a day"
//        → the chat volunteered "habits are binary daily check-ins", a
//          limitation that stopped being true when habits gained
//          targetPerDay, and offered to create TWO habits instead of one.
//
// Both failures share a root cause: tool selection was driven by free-form
// model text with nothing structured to check it against. This module builds
// that structure — entity / operation / target / fields / confidence — from
// the CURRENT user message alone, using deterministic rules. It is pure and
// dependency-free so the server can gate tool calls with it and the tests can
// pin it without a database or an API key.
//
// It deliberately does NOT try to be a parser for everything. Its job is to be
// RIGHT when it is confident and SILENT (entity "unknown", confidence 0) when
// it is not — a low-confidence intent never blocks a tool call.

import { detectPossessiveOwner } from "./entity-naming";

export type IntentEntity =
  | "habit"
  | "task"
  | "event"
  | "tracker"
  | "expense"
  | "income"
  | "obligation"
  | "liability"
  | "goal"
  | "asset"
  | "profile"
  | "document"
  | "journal"
  | "memory"
  | "artifact"
  | "unknown";

export type IntentOperation =
  | "create"
  | "update"
  | "delete"
  | "complete"
  | "read"
  | "unknown";

/**
 * The structured object tool selection is checked against. Mirrors the shape
 * in the remediation spec:
 *   { entity, operation, target, fields, confidence }
 */
export interface ParsedIntent {
  entity: IntentEntity;
  operation: IntentOperation;
  /** The existing record the user is pointing at, for update/delete. null for creates. */
  target: string | null;
  /** Field values stated in THIS message (name, color, driveType, dailyTarget, …). */
  fields: Record<string, any>;
  /** 0..1. Anything under CONFIDENCE_FLOOR is advisory only and never gates a tool. */
  confidence: number;
  /** The message the intent was parsed from — carried so logs are self-contained. */
  sourceMessage: string;
}

/** Below this, an intent is advisory: it is logged but never blocks a tool call. */
export const CONFIDENCE_FLOOR = 0.7;

const lc = (s: unknown): string => String(s ?? "").toLowerCase();

// ── Per-day targets ─────────────────────────────────────────────────────────
// "twice a day", "2x daily", "three times per day", "twice daily".
// Habits carry targetPerDay (shared/schema.ts) and count check-ins against it
// (shared/habit-schedule.ts), so this number has a real home — it is NOT a
// reason to create N habits.

const NUMBER_WORDS: Record<string, number> = {
  once: 1, one: 1, single: 1,
  twice: 2, two: 2, double: 2,
  thrice: 3, three: 3, triple: 3,
  four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/**
 * How many times per day did the user ask for? Returns null when they didn't
 * say — a habit with no stated cadence is a plain daily habit (target 1).
 *
 * Deliberately conservative: it only fires on an explicit per-DAY phrase, so
 * "twice a week" and "three times this month" return null rather than being
 * mistaken for a daily target.
 */
export function parseDailyTarget(message: string): number | null {
  const m = lc(message);
  if (!m) return null;

  const perDay = String.raw`(?:a|per|each|every|the)\s+day|daily|(?:a|per|each|every)\s+(?:24\s*(?:hours|hrs)|morning\s+and\s+(?:night|evening))`;

  // "twice a day" / "twice daily" / "two times per day"
  const wordAlt = Object.keys(NUMBER_WORDS).join("|");
  const wordRe = new RegExp(
    String.raw`\b(${wordAlt})\b(?:\s+times?)?\s*(?:${perDay})\b`,
  );
  const wordHit = m.match(wordRe);
  if (wordHit) {
    const n = NUMBER_WORDS[wordHit[1]];
    if (n) return clampTarget(n);
  }

  // "2x a day" / "3 times daily" / "2 x per day"
  const numRe = new RegExp(
    String.raw`\b(\d{1,2})\s*(?:x|times?)?\s*(?:${perDay})\b`,
  );
  const numHit = m.match(numRe);
  if (numHit) {
    const n = Number(numHit[1]);
    if (Number.isFinite(n) && n > 0) return clampTarget(n);
  }

  // "morning and night" / "morning and evening" with no count — two slots.
  if (/\b(morning|am)\s+and\s+(night|evening|pm|bedtime)\b/.test(m)) return 2;

  return null;
}

/** insertHabitSchema caps targetPerDay at 10 — clamp here so the intent can
 *  never describe a habit the storage layer would reject. */
function clampTarget(n: number): number {
  return Math.max(1, Math.min(10, Math.round(n)));
}

// ── Operation ───────────────────────────────────────────────────────────────

/**
 * Explicit UPDATE language. This is the ONLY thing that turns a "create" into
 * an "update" — a same-named record already existing never does (see
 * shared/ai-tool-routing.ts).
 */
const UPDATE_VERBS =
  /\b(update|updating|change|changing|edit|editing|modify|modifying|rename|renaming|set|correct|correcting|fix|fixing|adjust|adjusting|revise|revising|amend)\b/;

/** "my existing X", "the X I already have", "the X I just made". */
const EXISTING_REFERENCE =
  /\b(existing|already\s+(?:have|added|created|got)|i\s+(?:just|already)\s+(?:made|created|added)|that\s+i\s+(?:have|own|added|created))\b/;

const CREATE_VERBS =
  /\b(create|creating|add|adding|make|making|new|start|starting|set\s+up|setting\s+up|register|log|logging|track|record|open)\b/;

/** Question shapes. A question is a READ even when it contains a write verb. */
const QUESTION_LEAD =
  /^\s*(what|whats|when|where|which|who|whose|why|how|do\s+i|did\s+i|does|is|are|was|were|can\s+you\s+(?:show|tell|list)|show|list|tell\s+me|give\s+me)\b/;

const DELETE_VERBS =
  /\b(delete|deleting|remove|removing|drop|get\s+rid\s+of|erase|cancel\s+the)\b/;

const COMPLETE_VERBS =
  /\b(complete|completed|finish|finished|mark\s+(?:off|as\s+)?(?:done|complete)|check\s*(?:-|\s)?(?:in|off)|done\s+with)\b/;

const READ_VERBS =
  /\b(what|when|where|which|who|how\s+(?:much|many|long)|show|list|tell\s+me|do\s+i\s+have|did\s+i|summar|report on)\b/;

/**
 * True when the user used explicit update/edit language, or pointed at a record
 * they say already exists. "Create an asset for my Dodge Ram" is false even
 * though a Dodge Ram profile may exist.
 */
export function hasExplicitUpdateIntent(message: string): boolean {
  const m = lc(message);
  if (!m) return false;
  return UPDATE_VERBS.test(m) || EXISTING_REFERENCE.test(m);
}

export function detectOperation(message: string): IntentOperation {
  const m = lc(message).trim();
  if (!m) return "unknown";
  // Questions are reads even when they contain a write verb ("how much did I
  // log this week?"). Reads are never gated, so misreading one costs nothing;
  // misreading a question as a write would gate a tool on a guess.
  if (QUESTION_LEAD.test(m) || m.endsWith("?")) return "read";
  if (DELETE_VERBS.test(m)) return "delete";
  if (COMPLETE_VERBS.test(m)) return "complete";
  // Create wins over update when BOTH appear ("create an asset and set its
  // color") — the head verb of the sentence is what the user asked for.
  const createAt = m.search(CREATE_VERBS);
  const updateAt = m.search(UPDATE_VERBS);
  if (createAt !== -1 && (updateAt === -1 || createAt < updateAt)) return "create";
  if (updateAt !== -1) return "update";
  if (EXISTING_REFERENCE.test(m)) return "update";
  if (READ_VERBS.test(m)) return "read";
  return "unknown";
}

// ── Entity ──────────────────────────────────────────────────────────────────
// Ordered: the FIRST matching rule wins, so more specific nouns are listed
// before the generic ones they'd otherwise be swallowed by.

const ENTITY_RULES: Array<{ entity: IntentEntity; re: RegExp; weight: number }> = [
  { entity: "habit", re: /\bhabits?\b|\broutines?\b|\bstreaks?\b/, weight: 0.98 },
  { entity: "liability", re: /\bliabilit(?:y|ies)\b|\bdebts?\b|\bloans?\b|\bmortgages?\b|\bcredit\s+cards?\b/, weight: 0.9 },
  { entity: "obligation", re: /\b(?:recurring\s+)?bills?\b|\bsubscriptions?\b|\bobligations?\b/, weight: 0.9 },
  { entity: "asset", re: /\bassets?\b/, weight: 0.98 },
  { entity: "event", re: /\bevents?\b|\bappointments?\b|\bmeetings?\b|\bon\s+my\s+calendar\b/, weight: 0.95 },
  // "Remind me to X" is a TASK. Reminders were retired 2026-08-09 — Portol has
  // events (things that happen) and tasks (things you do), and a task carries
  // its own clock time, so the word no longer names an entity of its own.
  { entity: "task", re: /\bremind(?:er|ers)?\b|\bremind\s+me\b/, weight: 0.9 },
  { entity: "task", re: /\btasks?\b|\bto-?dos?\b|\bchores?\b/, weight: 0.95 },
  { entity: "goal", re: /\bgoals?\b|\bprojects?\b|\btargets?\b/, weight: 0.9 },
  { entity: "tracker", re: /\btrackers?\b/, weight: 0.95 },
  { entity: "expense", re: /\bexpenses?\b|\bspent\b|\bpurchases?\b|\$\s?\d/, weight: 0.85 },
  { entity: "income", re: /\bincomes?\b|\bpaychecks?\b|\bgot\s+paid\b/, weight: 0.85 },
  { entity: "document", re: /\bdocuments?\b|\bfiles?\b|\breceipts?\b/, weight: 0.85 },
  { entity: "journal", re: /\bjournals?\b|\bdiary\b/, weight: 0.9 },
  { entity: "memory", re: /\bremember\s+that\b|\bmemor(?:y|ies)\b/, weight: 0.85 },
  { entity: "artifact", re: /\bartifacts?\b|\bchecklists?\b/, weight: 0.85 },
  { entity: "profile", re: /\bprofiles?\b/, weight: 0.9 },
];

/**
 * Physical things that ARE assets in this app even when the user never says
 * the word "asset" — a vehicle/property/valuable is stored as a profile row,
 * so `asset` and `profile` are the same table with different intent.
 */
const ASSET_NOUNS =
  /\b(car|truck|suv|vehicle|motorcycle|boat|trailer|rv|house|home|condo|apartment|property|land|laptop|computer|phone|tv|television|watch|jewelry|bike|bicycle|tractor|mower)\b/;

export function detectEntity(message: string): { entity: IntentEntity; confidence: number } {
  const m = lc(message);
  if (!m) return { entity: "unknown", confidence: 0 };

  let best: { entity: IntentEntity; confidence: number; at: number } | null = null;
  for (const rule of ENTITY_RULES) {
    const at = m.search(rule.re);
    if (at === -1) continue;
    // Earliest explicit noun wins; ties break toward the higher-weight rule.
    if (!best || at < best.at || (at === best.at && rule.weight > best.confidence)) {
      best = { entity: rule.entity, confidence: rule.weight, at };
    }
  }
  if (best) return { entity: best.entity, confidence: best.confidence };

  // No entity NOUN — fall back to a physical-object read, at lower confidence.
  if (ASSET_NOUNS.test(m)) return { entity: "asset", confidence: 0.6 };
  return { entity: "unknown", confidence: 0 };
}

// ── Field extraction ────────────────────────────────────────────────────────

const COLORS =
  /\b(white|black|red|blue|silver|gray|grey|green|brown|beige|gold|yellow|orange|purple|tan|maroon|navy|charcoal)\b/;

const DRIVE_TYPES: Array<[RegExp, string]> = [
  [/\bfour[-\s]?wheel[-\s]?drive\b|\b4wd\b|\b4x4\b/, "4WD"],
  [/\ball[-\s]?wheel[-\s]?drive\b|\bawd\b/, "AWD"],
  [/\brear[-\s]?wheel[-\s]?drive\b|\brwd\b/, "RWD"],
  [/\bfront[-\s]?wheel[-\s]?drive\b|\bfwd\b/, "FWD"],
  [/\btwo[-\s]?wheel[-\s]?drive\b|\b2wd\b/, "2WD"],
];

/**
 * The entity NAME the user gave, for asset/profile-shaped requests.
 *
 * "Create an asset for my Dodge Ram 2025. It's white four-wheel-drive."
 *   → "Dodge Ram 2025"
 *
 * Stops at the first sentence/clause boundary so trailing attributes
 * ("it's white …") never end up inside the name. Returns null when nothing
 * name-shaped follows the verb — a wrong name is worse than no name.
 */
export function extractEntityName(message: string): string | null {
  const raw = String(message ?? "").trim();
  if (!raw) return null;

  const re = new RegExp(
    String.raw`\b(?:create|add|make|new|register|set\s+up|start)\b` +
      String.raw`\s+(?:an?|the|some)?\s*` +
      String.raw`(?:new\s+)?` +
      // optional entity noun, optionally followed by a connector
      String.raw`(?:asset|profile|vehicle|car|truck|habit|task|event|tracker|goal|obligation|liability|document|artifact)?` +
      String.raw`\s*(?:for|called|named|titled|to\s+track|entry\s+for)?\s*` +
      // The determiner is optional AND so is the space after it. Requiring the
      // space meant "Add Robert's truck" — no determiner — matched nothing at
      // all, so an owned asset arrived with no name to attribute.
      String.raw`(?:(?:my|our|the|a|an)\s+)?` +
      String.raw`(.+)`,
    "i",
  );
  const hit = raw.match(re);
  if (!hit) return null;

  let name = hit[1];
  // Cut at the first clause boundary — sentence end, "it's/that's/which/with".
  name = name.split(/(?:[.;!?\n]|,\s*(?:it|that|which|and\s+it)\b|\bit'?s\b|\bthat'?s\b|\bwhich\b|\bwith\s+a\b)/i)[0];
  name = name.replace(/\s+/g, " ").trim().replace(/^["'`]|["'`]$/g, "").replace(/[,\s]+$/, "");

  if (!name || name.length < 2 || name.length > 120) return null;
  // A bare entity noun is not a name ("create an asset" alone).
  if (/^(asset|profile|vehicle|habit|task|event|tracker|goal|one|it|this|that)$/i.test(name)) return null;
  return name;
}

/** Attribute values stated in this message, keyed the way profile fields are. */
export function extractFields(message: string, entity: IntentEntity): Record<string, any> {
  const m = lc(message);
  const fields: Record<string, any> = {};

  const name = extractEntityName(message);
  if (name) fields.name = name;

  // WHOSE is it? "this is Bob's MacBook" → owner Bob, name MacBook. Ownership
  // decides which balance sheet the asset lands on, so it is a first-class
  // field, not a detail to be cleaned out of the name and forgotten.
  if (name) {
    const possessive = detectPossessiveOwner(name);
    if (possessive) {
      fields.owner = possessive.owner;
      fields.name = possessive.name;
    }
  }

  if (entity === "habit") {
    const target = parseDailyTarget(message);
    if (target != null) fields.dailyTarget = target;
  }

  if (entity === "asset" || entity === "profile" || entity === "unknown") {
    const color = m.match(COLORS);
    if (color) fields.color = color[1] === "grey" ? "gray" : color[1];
    for (const [re, value] of DRIVE_TYPES) {
      if (re.test(m)) { fields.driveType = value; break; }
    }
    const year = message.match(/\b(19\d{2}|20\d{2})\b/);
    if (year) fields.year = Number(year[1]);
  }

  return fields;
}

// ── The intent object ───────────────────────────────────────────────────────

/**
 * Build the pre-execution intent for a single user message.
 *
 * Confidence is the product of how sure we are about the entity and about the
 * operation. Both must be clear for the result to reach CONFIDENCE_FLOOR and
 * therefore be allowed to gate a tool call.
 */
export function parseTurnIntent(message: string): ParsedIntent {
  const source = String(message ?? "");
  const { entity, confidence: entityConfidence } = detectEntity(source);
  const operation = detectOperation(source);

  const operationConfidence =
    operation === "unknown" ? 0
      : operation === "read" ? 0.8
      : 0.95;

  const fields = extractFields(source, entity);

  // For update/delete the "target" is the record being pointed at; for a
  // create there is no target by definition — that distinction is the whole
  // point of the create-vs-update safety rule.
  const target =
    operation === "update" || operation === "delete" || operation === "complete"
      ? (fields.name ?? extractEntityName(source) ?? null)
      : null;

  return {
    entity,
    operation,
    target,
    fields,
    confidence: Number((entityConfidence * operationConfidence).toFixed(2)),
    sourceMessage: source.slice(0, 500),
  };
}

/**
 * Split a message into independently-actionable clauses.
 *
 * "Add a task to call the dentist and log $20 for lunch" is TWO requests, and
 * gating both against a single intent would block the second one. Splitting is
 * deliberately conservative — a connective only separates clauses when a write
 * verb follows it, so "mac and cheese" and "Dodge Ram and trailer" stay whole.
 */
export function splitIntentClauses(message: string): string[] {
  const raw = String(message ?? "").trim();
  if (!raw) return [];
  const WRITE_VERB = String.raw`create|add|make|new|register|set\s+up|schedule|update|change|edit|modify|rename|delete|remove|log|track|remind\s+me|check\s+(?:in|off)|mark`;
  const connective = new RegExp(
    String.raw`(?:[.;!?\n]+|,\s*(?:and\s+|then\s+|also\s+)?(?=(?:${WRITE_VERB})\b)|\s+(?:and|then|also|plus)\s+(?=(?:${WRITE_VERB})\b))`,
    "i",
  );
  return raw
    .split(connective)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Everything the router needs to know about one user message.
 *
 * `exhaustive` is the safety valve. It is true only when EVERY write-shaped
 * clause in the message produced a confident intent — i.e. we believe we
 * understand the whole request. When it is false the message contains a
 * request we could not classify, so a tool that matches none of the intents we
 * DID find might still be serving that unparsed clause, and blocking it would
 * be a false positive.
 */
export interface TurnIntentPlan {
  message: string;
  intents: ParsedIntent[];
  exhaustive: boolean;
}

/** Clause shapes that look like a request rather than commentary. */
const WRITE_SHAPED =
  /\b(create|creating|add|adding|make|making|new|register|set\s+up|schedule|update|change|edit|modify|rename|delete|remove|log|track|remind|check\s+(?:in|off)|mark)\b/i;

/**
 * One intent per actionable clause, message order preserved.
 *
 * Clauses that carry no entity of their own inherit the message-level read —
 * "It's white four-wheel-drive" belongs to the asset named in the sentence
 * before it, not to a second, entity-less request.
 */
export function parseTurnPlan(message: string): TurnIntentPlan {
  const raw = String(message ?? "");
  const whole = parseTurnIntent(raw);
  const clauses = splitIntentClauses(raw);

  if (clauses.length <= 1) {
    return { message: raw, intents: [whole], exhaustive: isActionable(whole) };
  }

  const writeClauses = clauses.filter((c) => WRITE_SHAPED.test(c));
  const perClause = writeClauses.map((c) => parseTurnIntent(c));
  const actionable = perClause.filter(isActionable);
  const exhaustive = writeClauses.length > 0 && actionable.length === writeClauses.length;

  if (actionable.length === 0) {
    return { message: raw, intents: [whole], exhaustive: isActionable(whole) && writeClauses.length <= 1 };
  }
  // Keep the whole-message read alongside the clause reads: it is the one that
  // sees attributes spread across sentences.
  const intents =
    isActionable(whole) && !actionable.some((i) => i.entity === whole.entity)
      ? [whole, ...actionable]
      : actionable;
  return { message: raw, intents, exhaustive };
}

/** Convenience wrapper for callers that only want the intent list. */
export function parseTurnIntents(message: string): ParsedIntent[] {
  return parseTurnPlan(message).intents;
}

/** True when this intent is trustworthy enough to gate tool selection. */
export function isActionable(intent: ParsedIntent): boolean {
  return (
    intent.confidence >= CONFIDENCE_FLOOR &&
    intent.entity !== "unknown" &&
    intent.operation !== "unknown" &&
    intent.operation !== "read"
  );
}

// ── Back-references ─────────────────────────────────────────────────────────

/**
 * "do it again", "change that", "delete the one I just made" — the message
 * legitimately depends on a previous turn, so turn-scope enforcement must not
 * treat a tool call about an older entity as replay.
 *
 * Deliberately NOT a bare-pronoun test. "Create an asset for my Dodge Ram
 * 2025, it's white four-wheel-drive" contains "it", but the "it" points at the
 * truck in the same sentence, not at an earlier turn — treating that as a
 * back-reference switched off replay detection on the exact message that
 * needed it most. A back-reference is a pronoun ATTACHED TO A VERB, or an
 * explicit pointer at previous work.
 */
const ANAPHORA: RegExp[] = [
  /\b(?:again|undo|redo|revert)\b/,
  // "do it", "make that", "add the same", "log those"
  /\b(?:do|make|create|add|log|run|repeat|try)\s+(?:it|that|those|them|the\s+same)\b/,
  // "delete that", "change it", "rename those"
  /\b(?:delete|remove|change|update|edit|rename|fix|move|cancel|finish|complete)\s+(?:it|that|those|them|the\s+(?:last|previous|first|one))\b/,
  /\b(?:that|the)\s+one\b/,
  /\b(?:i\s+)?just\s+(?:made|created|added|did|logged)\b/,
  /\b(?:previous|earlier|last\s+one|same\s+(?:one|thing|as))\b/,
  /\byou\s+(?:just\s+)?(?:made|created|added|logged|said)\b/,
];

export function hasBackReference(message: string): boolean {
  const m = lc(message);
  return ANAPHORA.some((re) => re.test(m));
}
