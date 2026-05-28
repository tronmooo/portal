// shared/scope.ts — The ONE function that decides "is this thing in scope?".
//
// Stage 0 of the ownership-model consolidation. Before this file existed,
// `passesProfileFilter` (entities) and `isProfileInNetWorthScope` (asset/
// liability profiles) each implemented their own "any candidate id intersects
// the selection?" check. Two different functions, same question, drifted
// independently — the source of "two screens disagree about a number" bugs.
//
// This file introduces ONE primitive: `isInScope(candidateOwnerIds, ctx)`.
// Both existing functions delegate to it. The two callers extract different
// candidate-id sets (entity linkedProfiles vs. profile.id + parent + co-owners)
// but the final decision — "does this set intersect the selection, and how do
// orphans behave?" — happens in exactly ONE place from now on.
//
// Zero behavior change in Stage 0. The two existing functions keep their
// public signatures and their existing semantics; they just route through
// `isInScope` instead of inlining the comparison. This is what makes the
// stage reversible: revert this single file (and the two one-line edits in
// profile-filter.ts and net-worth.ts) and behavior is bit-identical to before.
//
// Future stages will move more callers (junction-table lookups, JSONB array
// reads, etc.) through this primitive so the THREE competing ownership
// systems collapse to one.

/**
 * Behavior knob for callers that need to distinguish between "this thing has
 * no owners listed" and "this thing has no owners listed AND we don't want it
 * to leak into a non-self filter". Two real-world semantics today:
 *
 *  - ENTITY scope (expenses/tasks/journal/etc.): legacy/orphan rows belong to
 *    "me" — show them when the active selection includes self, hide otherwise.
 *    This is the longstanding `passesProfileFilter` rule.
 *
 *  - PROFILE-NETWORTH scope (asset/liability profiles): a profile is its own
 *    owner. The "no candidate ids" case shouldn't really arise — every profile
 *    at minimum has its own id. We treat absent candidates as "out of scope"
 *    so a malformed profile never silently lands in someone else's net worth.
 *
 * Both behaviors share the inner intersect logic; only the orphan policy
 * differs. Encoding it as an enum keeps the contract explicit at every call
 * site instead of hidden in a boolean.
 */
export type OrphanPolicy = "belongs_to_self" | "out_of_scope";

export interface ScopeContext {
  /** IDs the user has explicitly selected. Empty array = no filter active. */
  selectedIds: string[];
  /**
   * Set of profile ids whose `type === "self"`. Used by the `belongs_to_self`
   * orphan policy to decide if a no-owner row falls through the filter.
   * Callers compute this once per render / per request.
   */
  selfIds: ReadonlySet<string>;
}

/**
 * The canonical scope decision. Pass every owner-id candidate that could
 * possibly tie this thing to a profile — entity `linkedProfiles`, profile
 * `id` + parent + co-owners, future junction-table membership, etc. — and
 * this function returns true iff the active selection covers it.
 *
 * Inactive selection (`selectedIds.length === 0`) is "everyone" — always true.
 */
export function isInScope(
  candidateOwnerIds: Iterable<string | null | undefined> | null | undefined,
  ctx: ScopeContext,
  orphanPolicy: OrphanPolicy = "belongs_to_self",
): boolean {
  // No active filter ⇒ everything passes. Mirrors the longstanding contract
  // of both `passesProfileFilter` and `isProfileInNetWorthScope` — keeping
  // this branch in the primitive (not the caller) makes the rule one-place.
  if (!ctx.selectedIds || ctx.selectedIds.length === 0) return true;

  const candidates: string[] = [];
  if (candidateOwnerIds) {
    for (const c of candidateOwnerIds) {
      if (typeof c === "string" && c.length > 0) candidates.push(c);
    }
  }

  if (candidates.length === 0) {
    if (orphanPolicy === "belongs_to_self") {
      return ctx.selectedIds.some((id) => ctx.selfIds.has(id));
    }
    return false;
  }

  // O(n*m) is fine here — selection is small (typically ≤ 8 ids) and
  // candidates are small (typically ≤ 5). Building a Set per call costs more.
  for (const c of candidates) {
    if (ctx.selectedIds.includes(c)) return true;
  }
  return false;
}

/**
 * Convenience helper: derive the selfIds set from a profile list. Callers
 * usually have one or both already; this exists so tests and incremental
 * adopters don't have to duplicate the snippet.
 */
export function selfIdsFrom(allProfiles: Array<{ id: string; type?: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const p of allProfiles) {
    if (p && p.type === "self") out.add(p.id);
  }
  return out;
}
