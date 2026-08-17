// ── Entity resolution: the DATABASE decides existence, not the model ────────
//
// THE BUG THIS FIXES (user report 2026-08-17). The dashboard showed a habit
// called "Clean my room". In chat:
//
//   "Mark Clean my room done"        → ❌ Couldn't find a TASK called
//                                        "Clean my room". Create it instead?
//   "Mark habit clean my room done"  → ❌ No habit called "Clean my room".
//
// The record was healthy the whole time — id 3bf2af41…, deleted_at null, linked
// to the user's own self profile. What failed was the ROUTE: the model saw the
// word "done", chose complete_task, and complete_task reported "not found"
// without ever asking whether a HABIT of that name existed. The model then
// narrated that conclusion as if the database had spoken.
//
// The rule this module exists to enforce:
//
//   The model determines INTENT and PARAMETERS.
//   The database determines EXISTENCE.
//
// So every actionable "mark X done" handler resolves the name across the
// actionable entity types through one shared layer, and only offers to create
// something after the lookup has genuinely come back empty for every type.
//
// Normalization is deliberately shared with habit matching (habit-match.ts) so
// "Clean my room", "clean my room", "CLEAN MY ROOM" and "mark clean my room
// done" all reduce to the same key. Two normalizers would be two answers.

import { normalizeHabitText, habitTokens } from "./habit-match";

/** The entity types a "mark X done / complete X / finish X" command can hit. */
export type ActionableKind = "task" | "habit" | "goal" | "event";

export const ACTIONABLE_KINDS: ActionableKind[] = ["task", "habit", "goal", "event"];

/**
 * Which kind did the user EXPLICITLY name?
 *
 * "mark habit clean my room done" → "habit"  (search habits ONLY)
 * "mark task buy groceries done"  → "task"   (search tasks ONLY)
 * "mark clean my room done"       → null     (search every kind)
 *
 * An explicit word is a hard constraint in BOTH directions: it widens nothing
 * and it forbids the other types. Saying "habit" must never complete a task of
 * the same name, which is the failure mode that makes people stop trusting the
 * assistant with their data.
 */
export function explicitKind(message: unknown): ActionableKind | null {
  const m = normalizeHabitText(message);
  if (!m) return null;
  // Word-boundary tests on the normalized string (punctuation is already
  // collapsed to spaces, so \b is safe here).
  if (/\bhabits?\b/.test(m)) return "habit";
  if (/\btasks?\b/.test(m)) return "task";
  if (/\bgoals?\b/.test(m)) return "goal";
  if (/\b(events?|appointments?|meetings?)\b/.test(m)) return "event";
  return null;
}

/**
 * Rank the items whose name plausibly matches `query`, best first.
 *
 * Same ladder as matchHabitByName, generalised to any named record:
 *   1. exact normalized equality
 *   2. bidirectional substring (query ⊂ name, or name ⊂ query — the latter is
 *      what lets "I finished cleaning my room" find "Clean my room")
 *   3. stem-aware token overlap, scored by coverage
 *
 * Returns EVERY plausible match rather than one, because the caller has to be
 * able to say "exactly one habit and no task" — a single best guess cannot
 * answer that question.
 */
export function rankByName<T>(
  items: T[],
  query: string,
  getName: (item: T) => string,
): T[] {
  const q = normalizeHabitText(query);
  if (!q || items.length === 0) return [];

  const scored: Array<{ item: T; score: number; len: number }> = [];
  const qTokens = new Set(habitTokens(q));

  for (const item of items) {
    const n = normalizeHabitText(getName(item));
    if (!n) continue;
    let score = 0;
    if (n === q) {
      score = 1000;
    } else if (n.includes(q) || q.includes(n)) {
      // Longer overlaps are stronger: "clean my room" ⊂ "mark clean my room
      // done" beats a one-word incidental containment.
      score = 500 + Math.min(n.length, q.length);
    } else {
      const nTokens = habitTokens(n);
      if (nTokens.length === 0) continue;
      let overlap = 0;
      for (const t of nTokens) if (qTokens.has(t)) overlap++;
      if (overlap === 0) continue;
      const coverage = overlap / nTokens.length;
      // Require real overlap, not one incidental shared word: "buy a car"
      // shares "buy" with "Buy groceries" (coverage 0.5) and must NOT resolve
      // it — this is a MUTATION, and a wrong record completed is worse than a
      // question asked. One token is only enough when it IS the whole name
      // ("run" → "Run", "pooped" → "POOP").
      if (coverage < 0.6 && overlap < 2) continue;
      score = overlap * 10 + coverage * 6;
    }
    scored.push({ item, score, len: n.length });
  }

  // Best score first; on a tie the shorter (more specific) name wins.
  return scored
    .sort((a, b) => b.score - a.score || a.len - b.len)
    .map(s => s.item);
}

/** True when the two names refer to the same record by normalized identity. */
export function sameEntityName(a: unknown, b: unknown): boolean {
  const na = normalizeHabitText(a);
  return na.length > 0 && na === normalizeHabitText(b);
}

// ── What a resolution looks like ────────────────────────────────────────────

export interface ResolvedCandidate {
  kind: ActionableKind;
  id: string;
  name: string;
  /** The underlying record, for the caller to act on. */
  record: any;
}

export interface ResolutionResult {
  /** Every plausible match, across every kind that was searched. */
  candidates: ResolvedCandidate[];
  /** The kind the user explicitly named, if any — a hard constraint. */
  explicit: ActionableKind | null;
  /** Kinds actually searched (respects `explicit`). */
  searched: ActionableKind[];
  /** The normalized name that was searched for, so exactness can be tested. */
  queryName: string;
}

/**
 * Decide what a "mark X done" command should act on.
 *
 * The rules, in the order the user specified them:
 *   · an explicit kind restricts the search to that kind, full stop;
 *   · exactly one match overall → that is the answer;
 *   · several matches of the SAME kind → ambiguous, ask (never guess on a
 *     mutation);
 *   · several matches across kinds → prefer the kind whose top match is an
 *     exact name equality; if that is still tied, ambiguous.
 *
 * Returns `undefined` for `pick` when nothing matched — and only then may a
 * caller offer to create something.
 */
export function pickResolution(res: ResolutionResult): {
  pick?: ResolvedCandidate;
  ambiguous?: ResolvedCandidate[];
} {
  const { candidates } = res;
  if (candidates.length === 0) return {};
  if (candidates.length === 1) return { pick: candidates[0] };

  // Prefer exact-name matches when there are any: "Run" beats "Run 5k" for the
  // query "run", across kinds as well as within one.
  const exact = candidates.filter(c => sameEntityName(c.name, res.queryName));
  const pool = exact.length > 0 ? exact : candidates;
  if (pool.length === 1) return { pick: pool[0] };

  // Still more than one — two records genuinely share this name. A mutation
  // must not guess between them.
  return { ambiguous: pool.slice(0, 5) };
}
