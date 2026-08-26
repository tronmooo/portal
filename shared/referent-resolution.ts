// shared/referent-resolution.ts — who is "she", and what is "it"?
//
// User report 2026-08-22, three findings with one cause:
//
//   · "This Friday she's only getting $500."  → "Who is 'she'?"  (the turn
//     immediately before said "Sarah earns $750 every Friday")
//   · "It comes out on the 22nd."             → lost that "it" was Netflix
//   · "Change her email."                     → nothing was updated
//
// The conversation history was reaching the model the whole time. What was
// missing was permission to USE it: the profile rules say, in capitals, that
// picking a profile the user did not name is "a critical data-isolation
// failure" and that the assistant must ASK instead of guessing. With no rule
// distinguishing "guessing between two profiles" from "reading the pronoun in
// the sentence you just answered", the model asked — every time.
//
// This module resolves the referent DETERMINISTICALLY, before the model sees
// the turn, so the answer does not depend on the model noticing. It is handed
// to the model the same way the content router's directive is: as a line
// appended to the user turn.
//
// Deliberately conservative. It resolves only when:
//   · the message leans on a pronoun and names nobody itself, AND
//   · a recent turn names exactly one candidate of the right sort.
// Anything else returns null and the existing ask-instead-of-guessing rules
// stand — an ambiguous referent SHOULD be a question.
//
// Pure, no I/O. Pinned by tests/referent-resolution.test.ts.

/** Pronouns that stand in for a person. */
const PERSON_PRONOUNS = /\b(she|her|hers|he|him|his|they|them|their|theirs)\b/i;
/** Pronouns that stand in for a thing (a bill, a document, a subscription). */
const THING_PRONOUNS = /\b(it|its|it's|that|this|those|these)\b/i;

/**
 * Text that must not count as naming anyone.
 *
 * "her" in "her email" is possessive; in "tell her" it is not. Both resolve to
 * the same person, so we do not distinguish. What we DO ignore:
 *   · quoted strings — someone's words, not a referent;
 *   · email addresses and URLs — "Change her email to sarah@newmail.com" is
 *     the exact sentence this module exists for, and the "sarah" inside the
 *     new address must not be mistaken for the user naming Sarah (which would
 *     make the message look self-contained and leave "her" unresolved).
 */
function stripLiterals(message: string): string {
  return String(message || "")
    .replace(/"[^"]*"|'[^']*'/g, " ")
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ");
}

export type ReferentKind = "person" | "thing";

export interface ReferentCandidate {
  /** Display name as the tools expect it ("Sarah Miller"). */
  name: string;
  kind: ReferentKind;
  /** Extra spellings that should also match in history ("Sarah"). */
  aliases?: string[];
}

export interface ResolvedReferent {
  /** The pronoun as written ("she"). */
  pronoun: string;
  kind: ReferentKind;
  /** The candidate it points at. */
  name: string;
  /** How far back it was found: 1 = the previous turn. */
  turnsBack: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does this text name the candidate (whole word, case-insensitive)? */
function mentions(text: string, candidate: ReferentCandidate): boolean {
  const names = [candidate.name, ...(candidate.aliases || [])].filter(Boolean);
  return names.some((n) => n.length >= 2 && new RegExp(`\\b${escapeRe(n)}\\b`, "i").test(text));
}

/**
 * Resolve the pronoun in `message` against recent conversation turns.
 *
 * `turns` is oldest-first, as the client sends it. Only USER turns are
 * searched: the assistant's own wording ("I logged Sarah's income") is a
 * paraphrase, and a name it introduced on its own is not something the user
 * committed to.
 */
export function resolveReferent(
  message: string,
  turns: Array<{ role: string; content: string }>,
  candidates: ReferentCandidate[],
): ResolvedReferent | null {
  const text = stripLiterals(message);
  if (!text.trim() || candidates.length === 0) return null;

  const personMatch = text.match(PERSON_PRONOUNS);
  const thingMatch = text.match(THING_PRONOUNS);
  if (!personMatch && !thingMatch) return null;

  // If the message names someone itself, there is nothing to resolve — the
  // explicit name always wins.
  const namedHere = candidates.filter((c) => mentions(text, c));
  if (namedHere.length > 0) return null;

  // A person pronoun is the stronger signal; "it" is often filler ("it comes
  // out on the 22nd" vs "that works"), so persons are tried first.
  const wanted: Array<{ kind: ReferentKind; pronoun: string }> = [];
  if (personMatch) wanted.push({ kind: "person", pronoun: personMatch[0] });
  if (thingMatch) wanted.push({ kind: "thing", pronoun: thingMatch[0] });

  const userTurns = turns.filter((t) => t?.role === "user" && typeof t.content === "string");
  for (const { kind, pronoun } of wanted) {
    const pool = candidates.filter((c) => c.kind === kind);
    if (pool.length === 0) continue;
    // Newest turn first.
    for (let i = userTurns.length - 1; i >= 0; i--) {
      const hits = pool.filter((c) => mentions(stripLiterals(userTurns[i].content), c));
      // Exactly one candidate of this kind in that turn — otherwise the turn
      // itself is ambiguous and asking is right.
      if (hits.length === 1) {
        return { pronoun, kind, name: hits[0].name, turnsBack: userTurns.length - i };
      }
      if (hits.length > 1) return null;
    }
  }
  return null;
}

/**
 * The line appended to the user turn. Written as an instruction because the
 * profile rules elsewhere in the prompt are emphatic about never choosing a
 * profile the user did not name, and this is the exception that has to win:
 * the user DID name them, one message ago.
 */
export function buildReferentDirective(resolved: ResolvedReferent | null): string | null {
  if (!resolved) return null;
  const where = resolved.turnsBack === 1 ? "the message just before this one" : `${resolved.turnsBack} messages ago`;
  if (resolved.kind === "person") {
    return `[REFERENT] "${resolved.pronoun}" = ${resolved.name} — named in ${where}. `
      + `Use forProfile:"${resolved.name}" and act on this message now. `
      + `Do NOT ask who "${resolved.pronoun}" is: resolving a pronoun from the conversation is not guessing, and asking makes the user repeat themselves.`;
  }
  return `[REFERENT] "${resolved.pronoun}" = ${resolved.name} — named in ${where}. `
    + `Act on ${resolved.name} now; do NOT ask what "${resolved.pronoun}" refers to.`;
}
