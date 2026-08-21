// shared/habit-completion-intent.ts — "did the user just tell me they did it?"
//
// User report 2026-08-20 (screenshot): with a "Walk the Dog" habit already on
// the dashboard, saying "I just walked the dog" logged a tracker entry and then
// REPLIED "say 'mark off my Walk the Dog habit' when you want to count it
// toward today's 2× daily goal", leaving the dashboard at 0 of 2. The user's
// point: the habit already exists, and the sentence already says they did it.
// Having to re-state it as a command is the bug.
//
// The rule this module encodes:
//
//   A past-tense report of doing something that IS an existing habit completes
//   today's occurrence. It does not ask permission.
//
// The old rule it replaces was absolute — habits moved ONLY on explicit command
// language (shared/habit-intent.ts) — and it existed for a real reason: "I went
// to the bathroom at 8:15 AM" once matched ANOTHER PROFILE's "Go to the
// bathroom 3x daily" habit and derailed the message (2026-07-15). So the
// relaxation here is deliberately narrow, and three separate things still have
// to hold before anything is completed:
//
//   1. The sentence is a COMPLETION REPORT — past tense, first person, not a
//      question, plan, reminder, negation, or someone else's action.
//   2. A habit MATCHES it strongly. "I walked the dog" covers every word of
//      "Walk the Dog"; "I walked for twenty minutes" covers only half, and is
//      left alone (the user's own example of a mapping that must NOT be made).
//   3. The CALLER scopes the candidate habits to the user's own profile (or the
//      one they named). This module never sees another profile's habits — see
//      server/ai-engine.ts checkin_habit.
//
// Pure, no I/O. Pinned by tests/habit-completion-intent.test.ts.

import { habitTokens, normalizeHabitText, type HabitLike } from "./habit-match";

/**
 * How strongly the message asserts a completion.
 *
 *  "explicit" — a completion word is present ("done", "finished", "checked
 *               off"). Strong enough to accept a partial-but-unique habit
 *               match: "Got his walk done" is about the walk habit.
 *  "reported" — a plain past-tense report ("I walked the dog"). Accepted only
 *               on a FULL habit-name match, because a partial one here is the
 *               "I walked for twenty minutes" false positive.
 *  "none"     — a question, a plan, a reminder, a negation, someone else's
 *               action, or nothing past-tense at all. Never completes.
 */
export type CompletionConfidence = "explicit" | "reported" | "none";

/** Irregular pasts the "-ed" test misses. */
const IRREGULAR_PAST = new Set([
  "took", "taken", "went", "gone", "ran", "run", "ate", "eaten", "drank", "drunk",
  "made", "had", "did", "done", "got", "gotten", "fed", "read", "wrote", "written",
  "swam", "slept", "woke", "sat", "spent", "kept", "held", "told", "gave", "given",
  "bought", "brought", "caught", "taught", "thought", "found", "won", "paid", "met",
  "sang", "rode", "drove", "flew", "built", "sent", "left", "felt", "put", "cut",
  "hit", "let", "beat", "lifted", "hung", "swung", "struck",
]);

/** Words that assert the thing is FINISHED, not merely described. */
const COMPLETION_MARKER =
  /\b(done|finished|complete|completed|completing|check(ed)?\s*(off|in)|mark(ed)?\s*off|knocked\s*out|wrapped\s*up|taken\s*care\s*of)\b/i;

/** Anything that makes the sentence NOT an assertion that it happened. */
const FUTURE_OR_HYPOTHETICAL =
  /\b(will|won't|gonna|going\s+to|about\s+to|plan(ning)?\s+to|need\s+to|have\s+to|has\s+to|should|shall|might|maybe|may\s+be|could|would|want\s+to|wanna|later|tonight\s+i|tomorrow|next\s+week|soon|intend)\b/i;

const NEGATION =
  /\b(didn'?t|did\s+not|don'?t|do\s+not|doesn'?t|haven'?t|have\s+not|hasn'?t|never|no\s+longer|not\s+yet|forgot\s+to|failed\s+to|skipped|missed|couldn'?t|could\s+not|won'?t)\b/i;

/** Asking about it, not reporting it. */
const INTERROGATIVE =
  /^\s*(did|do|does|have|has|had|am|is|are|was|were|will|would|should|could|can|what|when|where|why|how|who|which)\b/i;

/**
 * A polite imperative, not a question. "Can you mark off my run?" opens with
 * "can" and ends in "?", so the interrogative test alone would refuse the most
 * ordinary way people ask for something to be done.
 */
const POLITE_COMMAND = /^\s*(can|could|would|will)\s+(you|u)\b|\bplease\b/i;

const REQUEST_OR_REMINDER =
  /\b(remind\s+me|reminder|set\s+up|schedule|add\s+a|create\s+a|make\s+a|start\s+a|new\s+habit|track\s+my)\b/i;

/**
 * Words that can legitimately open a first-person sentence with the subject
 * dropped ("Just walked the dog", "Took the dog out"). A capitalized word
 * OUTSIDE this set followed by a past-tense verb is someone else's action:
 * "John walked the dog" must never move the user's streak.
 */
const SENTENCE_OPENERS = new Set([
  "i", "just", "already", "finally", "today", "yesterday", "this", "we",
  "took", "walked", "did", "done", "finished", "completed", "got", "had",
  "went", "ran", "fed", "made", "drank", "ate", "read", "cleaned", "brushed",
  "flossed", "stretched", "meditated", "worked", "played", "swam", "biked",
  "lifted", "washed", "vacuumed", "mowed", "practiced", "studied", "wrote",
  "and", "then", "also", "my", "the", "a", "an", "ok", "okay", "hey", "so",
]);

/** "He walked…", "John walked…" — a subject who is not the speaker. */
export function hasThirdPersonSubject(message: string): boolean {
  const m = String(message || "").trim();
  if (!m) return false;
  // Explicit third-person pronoun subject.
  if (/^\s*(he|she|they|him|her|them)\b/i.test(m)) return true;
  if (/\b(he|she|they)\s+(just\s+|already\s+)?\w+(ed|ked)\b/i.test(m)) return true;
  // A proper name in subject position: capitalized, not a normal opener, and
  // followed by a past-tense verb.
  const named = m.match(/^\s*([A-Z][a-zA-Z'-]{1,})\s+(?:just\s+|already\s+)?([a-z]+)\b/);
  if (named) {
    const subject = named[1].toLowerCase();
    const verb = named[2].toLowerCase();
    if (!SENTENCE_OPENERS.has(subject) && (verb.endsWith("ed") || IRREGULAR_PAST.has(verb))) {
      return true;
    }
  }
  return false;
}

/** Does the message contain a past-tense verb at all? */
function hasPastTenseVerb(message: string): boolean {
  const words = String(message || "").toLowerCase().match(/[a-z']+/g) || [];
  return words.some((w) => IRREGULAR_PAST.has(w) || (w.length > 3 && w.endsWith("ed")));
}

/**
 * Sentences that can NEVER be a completion, whatever else they contain.
 *
 * Separate from the rest because it has to override even explicit command
 * language: "Did I walk the dog?" opens with "did", which the older
 * command-word detector (shared/habit-intent.ts) reads as an imperative
 * "did…done" completion — so without this veto a QUESTION about a habit
 * checked it in.
 *
 * A question, a denial, and a request to be reminded are all about a
 * completion that has NOT happened. Third person and future tense are handled
 * separately (in classifyCompletionReport) because they are only wrong for
 * INFERENCE: "Joe completed his water habit" is a perfectly good explicit
 * command for Joe's habit.
 */
export function isHardCompletionVeto(message: string): boolean {
  const m = String(message || "").trim();
  if (!m) return false;
  if (NEGATION.test(m)) return true;
  if (REQUEST_OR_REMINDER.test(m)) return true;
  // "Can you mark it off?" is an instruction wearing a question mark. Only a
  // real question — one that isn't a polite request — vetoes.
  if (POLITE_COMMAND.test(m)) return false;
  if (INTERROGATIVE.test(m)) return true;
  // A trailing "?" on something that otherwise says "done" ("mark off my run?")
  // is hesitancy, not an enquiry.
  if (m.includes("?") && !COMPLETION_MARKER.test(m)) return true;
  return false;
}

/**
 * Classify the message as a completion report. This is about the SENTENCE only
 * — whether any habit matches is a separate question (see
 * matchHabitForCompletionReport).
 */
export function classifyCompletionReport(message: string): CompletionConfidence {
  const m = String(message || "").trim();
  if (!m) return "none";
  // Order matters: every one of these vetoes a completion outright.
  if (isHardCompletionVeto(m)) return "none";
  if (hasThirdPersonSubject(m)) return "none";
  // "I might walk the dog later" — a plan, not a report. A future marker only
  // vetoes when there is no completion word ("finished it, will do it again
  // tomorrow" is still a completion).
  const explicit = COMPLETION_MARKER.test(m);
  if (FUTURE_OR_HYPOTHETICAL.test(m) && !explicit) return "none";
  if (explicit) return "explicit";
  return hasPastTenseVerb(m) ? "reported" : "none";
}

export interface CompletionMatch<T extends HabitLike> {
  habit: T;
  confidence: Exclude<CompletionConfidence, "none">;
  /** "full" = every word of the habit name is in the message. */
  match: "full" | "unique-partial";
}

/**
 * Find the habit a completion report is about, or null.
 *
 * FULL coverage is the bar for a plain report: every meaningful word of the
 * habit's name has to appear in the message. "I walked the dog" covers both
 * words of "Walk the Dog". "I walked for twenty minutes" covers only "walk",
 * so it matches nothing — exactly the mapping the user said must not be made.
 *
 * A message with an explicit completion word may also match on a UNIQUE
 * partial ("Got his walk done" → the one habit whose name contains "walk"),
 * since the sentence itself already asserts that something was finished.
 * Ambiguity — two habits sharing the token — always declines.
 */
export function matchHabitForCompletionReport<T extends HabitLike>(
  habits: T[],
  message: string,
  confidenceOverride?: CompletionConfidence,
  opts?: {
    /** Tie-break among habits that share a NAME: prefer one this returns true
     *  for (the caller uses "today isn't finished yet"). */
    prefer?: (habit: T) => boolean;
  },
): CompletionMatch<T> | null {
  const confidence = confidenceOverride ?? classifyCompletionReport(message);
  if (confidence === "none" || !habits.length) return null;

  const msgTokens = new Set(habitTokens(message));
  if (msgTokens.size === 0) return null;

  const scored = habits
    .map((habit) => {
      const nameTokens = habitTokens(habit.name);
      if (nameTokens.length === 0) return null;
      const hits = nameTokens.filter((t) => msgTokens.has(t)).length;
      return hits > 0 ? { habit, nameTokens, hits, full: hits === nameTokens.length } : null;
    })
    .filter((s): s is { habit: T; nameTokens: string[]; hits: number; full: boolean } => s !== null);

  if (scored.length === 0) return null;

  // Full-name matches win outright, and the MORE SPECIFIC one wins among them:
  // "I walked the dog" names both a "Walk" habit and a "Walk the Dog" habit,
  // and the second is what the sentence is about.
  //
  // A tie between DIFFERENT habits declines. "Got my walk done" with both a
  // Morning Walk and an Evening Walk habit names neither in particular (their
  // distinguishing words are time-of-day filler, so both reduce to "walk"),
  // and picking one would record a completion the user never reported. This is
  // the "only ask when there is real ambiguity" case — and it is real.
  //
  // A tie between habits with the SAME NAME is not ambiguous to the user, only
  // to the database: duplicates accumulate (two rows both called "Walk the
  // Dog"), and declining there would refuse the completion for a distinction
  // nobody can see. Pick one, preferring an unfinished one so repeated reports
  // fill them in turn.
  const full = scored.filter((s) => s.full);
  if (full.length > 0) {
    const ranked = [...full].sort((a, b) => b.nameTokens.length - a.nameTokens.length);
    const topSize = ranked[0].nameTokens.length;
    const tied = ranked.filter((s) => s.nameTokens.length === topSize);
    if (tied.length > 1) {
      const names = new Set(tied.map((s) => normalizeHabitText(s.habit.name)));
      if (names.size > 1) return null;
      const preferred = opts?.prefer ? tied.find((s) => opts.prefer!(s.habit)) : undefined;
      return { habit: (preferred ?? tied[0]).habit, confidence, match: "full" };
    }
    return { habit: ranked[0].habit, confidence, match: "full" };
  }

  // Partial: only ever with an explicit completion word, and only when exactly
  // one habit is in the running.
  if (confidence === "explicit" && scored.length === 1) {
    return { habit: scored[0].habit, confidence, match: "unique-partial" };
  }
  return null;
}
