// shared/conversation-context.ts — SHORT-TERM STRUCTURED CONVERSATIONAL STATE.
//
// Why this exists (QA report, reqs 4, 5, 14, 15):
//
//   "Sarah has a dentist appointment on September 8."
//   "Remind me two days before."        → "Two days before WHAT?"
//
//   "Sarah owns a MacBook Air worth $1,200."
//   "Actually it's probably worth $950." → offered unrelated vehicles
//
//   "Sarah takes a multivitamin every morning."
//   "She already took it today."        → nothing happened
//
// Every one of those is a reference the user expects to resolve against the
// message they sent ten seconds ago. The app had no conversational state at
// all: each turn re-read the raw history as prose, so "she", "it" and "the
// appointment" had nothing to bind to. The model was left to guess, and the
// system prompt — correctly worried about a DIFFERENT bug, where a profile
// leaked across unrelated turns — told it not to guess. So it asked.
//
// The fix is not "let the model use history". It is to keep the small set of
// facts a reference can legitimately bind to, with their CANONICAL IDS, and to
// resolve against that:
//
//   activeProfileId / lastSubjectProfileId  — who we are talking about
//   lastReferencedEntityId + Type           — what we last touched
//   lastCreatedEntityId / lastUpdatedEntityId
//   per-type slots (lastEventId, lastHabitId, lastAssetId, …)
//
// The distinction that makes this safe, and the one the old prompt rule was
// really reaching for:
//
//   A PRONOUN IS AN EXPLICIT REFERENCE IN THE CURRENT MESSAGE.
//
// "She already took it today" names its subject just as surely as "Sarah took
// her vitamin" does — anaphorically rather than lexically. What must never
// happen is a profile being adopted from history when the current message
// refers to NOBODY: that is the leak the old rule was written against, and it
// is still forbidden here (see `resolveSubjectProfile`, which returns null
// unless the message actually contains a referring expression).
//
// Pure, dependency-light, no I/O. Pinned by tests/conversation-context.test.ts.

import type { IntentEntity } from "./ai-intent";

// ─── The remembered shape ────────────────────────────────────────────────────

/** One entity this conversation has touched, with the id everything else uses. */
export interface ConversationEntity {
  /** Canonical database id. The whole point of this module. */
  id: string;
  /** Intent-level type ("event", "asset", "habit", …). */
  type: IntentEntity;
  /** Display name, for name-based reference matching ("the MacBook"). */
  name: string;
  /** Profile that owns it, when known. */
  profileId?: string | null;
  /** Was this created, updated, or merely read this turn? */
  operation?: "create" | "update" | "delete" | "complete" | "read";
  /** Monotonic turn number, newest highest. */
  turn: number;
}

/** A person (or pet) the conversation has been about. */
export interface ConversationProfile {
  id: string;
  name: string;
  turn: number;
}

export interface ConversationContext {
  /** The profile the conversation is currently about. */
  activeProfileId: string | null;
  activeProfileName: string | null;
  /** Most recent entity of any type. */
  lastReferencedEntityId: string | null;
  lastReferencedEntityType: IntentEntity | null;
  lastCreatedEntityId: string | null;
  lastUpdatedEntityId: string | null;
  /** Newest-first, capped. */
  entities: ConversationEntity[];
  /** Newest-first, capped. */
  profiles: ConversationProfile[];
  /** Turn counter. */
  turn: number;
}

export function emptyConversationContext(): ConversationContext {
  return {
    activeProfileId: null,
    activeProfileName: null,
    lastReferencedEntityId: null,
    lastReferencedEntityType: null,
    lastCreatedEntityId: null,
    lastUpdatedEntityId: null,
    entities: [],
    profiles: [],
    turn: 0,
  };
}

/** How many turns back a reference may reach. Beyond this the user is starting
 *  a new thought and a stale binding is worse than a clarifying question. */
export const CONTEXT_TURN_WINDOW = 6;
/** Hard cap on remembered entities, so a long conversation can't grow forever. */
const MAX_ENTITIES = 40;
const MAX_PROFILES = 12;

// ─── Recording a turn ────────────────────────────────────────────────────────

export interface TurnRecord {
  entities?: Array<Omit<ConversationEntity, "turn">>;
  /** Profiles named or resolved this turn, most relevant first. */
  profiles?: Array<Omit<ConversationProfile, "turn">>;
}

/**
 * Fold one turn's writes into the context. Pure: returns a new object.
 *
 * The LAST entity in `entities` wins the "last referenced" slots, because tool
 * calls arrive in execution order and the final one is what the reply is about.
 */
export function rememberTurn(
  prev: ConversationContext,
  record: TurnRecord,
): ConversationContext {
  const turn = prev.turn + 1;
  const incoming = (record.entities || [])
    .filter((e) => e && typeof e.id === "string" && e.id.trim() !== "")
    .map((e) => ({ ...e, name: String(e.name ?? ""), turn }));

  // Newest first; an id touched again moves to the front rather than doubling.
  const merged: ConversationEntity[] = [];
  const seen = new Set<string>();
  for (const e of [...incoming.slice().reverse(), ...prev.entities]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }

  const incomingProfiles = (record.profiles || [])
    .filter((p) => p && typeof p.id === "string" && p.id.trim() !== "")
    .map((p) => ({ ...p, name: String(p.name ?? ""), turn }));
  const mergedProfiles: ConversationProfile[] = [];
  const seenP = new Set<string>();
  for (const p of [...incomingProfiles, ...prev.profiles]) {
    if (seenP.has(p.id)) continue;
    seenP.add(p.id);
    mergedProfiles.push(p);
  }

  const newest = incoming.length > 0 ? incoming[incoming.length - 1] : null;
  const lastCreated = [...incoming].reverse().find((e) => e.operation === "create");
  const lastUpdated = [...incoming].reverse().find(
    (e) => e.operation === "update" || e.operation === "complete",
  );

  // The turn's own subject wins; otherwise the previous subject persists so a
  // follow-up ("she already took it") still has someone to bind to.
  const subject = incomingProfiles[0]
    || (newest?.profileId
      ? mergedProfiles.find((p) => p.id === newest.profileId)
      : undefined);

  return {
    activeProfileId: subject?.id ?? prev.activeProfileId,
    activeProfileName: subject?.name ?? prev.activeProfileName,
    lastReferencedEntityId: newest?.id ?? prev.lastReferencedEntityId,
    lastReferencedEntityType: newest?.type ?? prev.lastReferencedEntityType,
    lastCreatedEntityId: lastCreated?.id ?? prev.lastCreatedEntityId,
    lastUpdatedEntityId: lastUpdated?.id ?? prev.lastUpdatedEntityId,
    entities: merged.slice(0, MAX_ENTITIES),
    profiles: mergedProfiles.slice(0, MAX_PROFILES),
    turn,
  };
}

/** The per-type slots the QA report asks for, derived rather than stored so
 *  they can never drift from `entities`. */
export function lastEntityOfType(
  ctx: ConversationContext,
  type: IntentEntity,
): ConversationEntity | null {
  return ctx.entities.find((e) => e.type === type) ?? null;
}

// ─── Referring expressions ───────────────────────────────────────────────────

const lc = (s: unknown) => String(s ?? "").toLowerCase();

/** Third-person pronouns for a PERSON. "I/me/my" is the user, never a lookup. */
const PERSON_PRONOUN =
  /\b(she|her|hers|he|him|his|they|them|their|theirs)\b/i;

/**
 * Pronouns for a THING.
 *
 * "it", "them", "those" are unambiguous. "this" and "that" are only pronouns
 * when they stand alone — in "this morning" and "that vitamin" they are
 * DETERMINERS introducing a fresh noun phrase, and reading them as references
 * makes every message with a date in it point at the last record touched.
 */
const OBJECT_PRONOUN =
  /\b(?:it|its|it's|them|those|these)\b|\b(?:that|this)\b(?=\s*$|[.,!?;]|\s+(?:to|as|instead|too|again|now|one|and|or|please)\b)/i;

/**
 * A dependent-time reference: "two days before", "an hour before", "the night
 * after". These name no object at all — the object is whatever dated thing the
 * conversation just established, which is exactly why "Remind me two days
 * before" drew a "two days before WHAT?" instead of a reminder (QA req 4 + 5).
 */
const DEPENDENT_TIME_REF =
  /\b(?:\d+|a|an|one|two|three|four|five|six|seven|ten|fifteen|twenty|thirty)\s+(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s+(?:before|after|ahead|prior|early|earlier)\b|\b(?:the\s+)?(?:day|night|morning|evening|week|month)\s+(?:before|after|of)\b/i;

/** Entity types a dependent-time reference can attach to. */
const DATED_TYPES: IntentEntity[] = ["event", "task"];

/**
 * Nouns that name an entity TYPE when preceded by a definite article — "the
 * appointment", "the habit", "the car". These narrow a reference to one type
 * without the user having to repeat the name.
 */
const TYPE_NOUNS: Array<{ re: RegExp; type: IntentEntity }> = [
  { re: /\b(?:the|that|this)\s+(appointment|meeting|event|visit)\b/i, type: "event" },
  { re: /\b(?:the|that|this)\s+(habit|routine|streak)\b/i, type: "habit" },
  { re: /\b(?:the|that|this)\s+(task|todo|to-do|reminder)\b/i, type: "task" },
  { re: /\b(?:the|that|this)\s+(tracker|log)\b/i, type: "tracker" },
  { re: /\b(?:the|that|this)\s+(note)\b/i, type: "note" },
  { re: /\b(?:the|that|this)\s+(journal|entry)\b/i, type: "journal" },
  { re: /\b(?:the|that|this)\s+(expense|purchase|charge)\b/i, type: "expense" },
  { re: /\b(?:the|that|this)\s+(bill|subscription)\b/i, type: "obligation" },
  { re: /\b(?:the|that|this)\s+(loan|debt|mortgage)\b/i, type: "liability" },
  { re: /\b(?:the|that|this)\s+(goal)\b/i, type: "goal" },
  // Asset-shaped nouns. Deliberately generic: the NAME match below is what
  // usually resolves these ("the MacBook"), this is the fallback.
  { re: /\b(?:the|that|this)\s+(car|truck|vehicle|laptop|computer|phone|bike|house|asset)\b/i, type: "asset" },
];

/** Does this message contain any expression that points at earlier context? */
export function hasReferringExpression(message: string): boolean {
  const m = lc(message);
  if (!m) return false;
  return (
    PERSON_PRONOUN.test(m) ||
    OBJECT_PRONOUN.test(m) ||
    DEPENDENT_TIME_REF.test(m) ||
    TYPE_NOUNS.some((t) => t.re.test(m))
  );
}

/** Which entity type, if any, the message names via a definite noun. */
export function referencedType(message: string): IntentEntity | null {
  const m = lc(message);
  if (!m) return null;
  for (const t of TYPE_NOUNS) if (t.re.test(m)) return t.type;
  return null;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

const normalize = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const NAME_STOPWORDS = new Set([
  "the", "a", "an", "my", "our", "your", "his", "her", "their", "its",
  "of", "for", "and", "or", "to", "in", "on", "at", "is", "was", "it",
]);

function nameTokens(s: string): string[] {
  return normalize(s).split(" ").filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t));
}

/**
 * Resolve what the message is pointing at, or null when nothing plausibly is.
 *
 * Ladder, most specific first:
 *   1. a remembered entity whose NAME appears in the message ("the MacBook",
 *      "worth $950 now" after a MacBook turn — name match beats everything);
 *   2. a definite type noun ("the appointment") → newest entity of that type;
 *   3. a bare object pronoun ("it", "that") → the last referenced entity.
 *
 * Every rung is bounded by CONTEXT_TURN_WINDOW, and rung 3 additionally
 * requires that SOMETHING was touched recently — a pronoun in the first
 * message of a conversation resolves to nothing, as it should.
 */
export function resolveConversationReference(
  ctx: ConversationContext,
  message: string,
  opts: { type?: IntentEntity | null } = {},
): ConversationEntity | null {
  const m = String(message ?? "");
  if (!m.trim()) return null;
  const fresh = ctx.entities.filter((e) => ctx.turn - e.turn < CONTEXT_TURN_WINDOW);
  if (fresh.length === 0) return null;

  const wanted = opts.type ?? referencedType(m);

  // 1. Name match. "Actually it's probably worth $950" carries no name, but
  //    "the MacBook is worth $950" does — and when it does, it is decisive.
  const msgTokens = new Set(nameTokens(m));
  if (msgTokens.size > 0) {
    const byName = fresh
      .map((e) => {
        const toks = nameTokens(e.name);
        if (toks.length === 0) return { e, score: 0 };
        const hits = toks.filter((t) => msgTokens.has(t)).length;
        return { e, score: hits / toks.length };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || b.e.turn - a.e.turn);
    if (byName.length > 0 && byName[0].score >= 0.5) {
      const top = byName[0];
      // A type was explicitly asked for and the best name match disagrees —
      // trust the type rather than a partial name hit.
      if (!wanted || top.e.type === wanted) return top.e;
    }
  }

  // 2. Definite type noun.
  if (wanted) {
    const typed = fresh.find((e) => e.type === wanted);
    if (typed) return typed;
  }

  // 3. Bare object pronoun.
  if (OBJECT_PRONOUN.test(lc(m))) {
    return fresh[0] ?? null;
  }

  // 4. Dependent time reference with no object of its own: "two days before"
  //    attaches to the most recent DATED record, because that is the only kind
  //    of thing you can be two days before.
  if (DEPENDENT_TIME_REF.test(lc(m))) {
    return fresh.find((e) => DATED_TYPES.includes(e.type)) ?? null;
  }

  return null;
}

/**
 * Whose profile is this message about?
 *
 * Returns null unless the message ACTUALLY REFERS to someone — by a
 * third-person pronoun, or by pointing at an entity whose owner we know. A
 * message that mentions nobody keeps the caller's own default (the self
 * profile), which is what stops a profile leaking across unrelated turns.
 *
 * `explicitName` is the profile the CURRENT message named outright; when the
 * caller has one it always wins, and this function is not consulted.
 */
export function resolveSubjectProfile(
  ctx: ConversationContext,
  message: string,
): { id: string; name: string; via: "pronoun" | "entity" } | null {
  const m = String(message ?? "");
  if (!m.trim()) return null;

  // A referenced entity carries its own owner — the strongest signal, because
  // it came from the database rather than from grammar.
  const ref = resolveConversationReference(ctx, m);
  if (ref?.profileId) {
    const p = ctx.profiles.find((x) => x.id === ref.profileId);
    return { id: ref.profileId, name: p?.name ?? "", via: "entity" };
  }

  // A third-person pronoun points at whoever the conversation is about.
  if (PERSON_PRONOUN.test(lc(m)) && ctx.activeProfileId) {
    const recent = ctx.profiles.find((p) => p.id === ctx.activeProfileId);
    if (!recent || ctx.turn - recent.turn < CONTEXT_TURN_WINDOW) {
      return {
        id: ctx.activeProfileId,
        name: ctx.activeProfileName ?? recent?.name ?? "",
        via: "pronoun",
      };
    }
  }

  return null;
}

// ─── Rendering for the model ─────────────────────────────────────────────────

/**
 * A compact block for the system prompt. Ids are included deliberately: the
 * model is told to pass them straight through, so a reference resolves to the
 * SAME row the rest of the app would resolve it to, rather than to a name the
 * model re-derives and a lookup then re-guesses.
 */
export function renderConversationContext(ctx: ConversationContext): string {
  const fresh = ctx.entities.filter((e) => ctx.turn - e.turn < CONTEXT_TURN_WINDOW);
  if (fresh.length === 0 && !ctx.activeProfileId) return "";

  const lines: string[] = ["━━━ CONVERSATION CONTEXT (resolve references against THIS) ━━━"];
  if (ctx.activeProfileId) {
    lines.push(
      `Currently talking about: ${ctx.activeProfileName || "(unnamed)"} [profileId ${ctx.activeProfileId}]`,
    );
  }
  if (fresh.length > 0) {
    lines.push("Recently touched records (newest first):");
    for (const e of fresh.slice(0, 8)) {
      const op = e.operation ? ` ${e.operation}d` : "";
      lines.push(`  · ${e.type}${op}: "${e.name}" [id ${e.id}]`);
    }
  }
  lines.push(
    'A pronoun or a definite reference in the user\'s message ("she", "it", "the appointment", ' +
      '"the MacBook", "two days before") refers to something above. Resolve it and ACT — pass the ' +
      "id shown. Ask a clarifying question ONLY when two records above are genuinely equally " +
      "plausible. Never answer a reference you have already resolved with a question about what " +
      "the user meant.",
  );
  return lines.join("\n");
}
