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
 * Build the candidate owner-id set for an asset/liability profile from the
 * canonical ownership sources:
 *   - the profile's own `id` (a profile is its own owner),
 *   - its `parentProfileId` column (nesting parent),
 *   - co-owner `partyProfileId`s from the relational link tables
 *     (`asset_party_links` rows where `assetProfileId` matches, and
 *     `liability_profile_links` rows where `liabilityProfileId` matches).
 *
 * Pass the result to `isInScope(..., "out_of_scope")`. This replaces the
 * hand-rolled id/parent-only predicates that missed co-owners (P4.1).
 * Link arrays are small (user-scoped), so the per-call scan is cheap;
 * callers iterating many profiles inside a useMemo are fine.
 */
export function ownerCandidatesForProfile(
  profile: { id?: string | null; parentProfileId?: string | null } | null | undefined,
  assetLinks?: ReadonlyArray<{ assetProfileId?: string | null; partyProfileId?: string | null }> | null,
  liabilityLinks?: ReadonlyArray<{ liabilityProfileId?: string | null; partyProfileId?: string | null }> | null,
): string[] {
  const ids: string[] = [];
  if (!profile) return ids;
  const pid = profile.id;
  if (typeof pid === "string" && pid) ids.push(pid);
  const parentId = profile.parentProfileId;
  if (typeof parentId === "string" && parentId) ids.push(parentId);
  if (pid) {
    for (const l of assetLinks || []) {
      if (l?.assetProfileId === pid && typeof l.partyProfileId === "string" && l.partyProfileId) {
        ids.push(l.partyProfileId);
      }
    }
    for (const l of liabilityLinks || []) {
      if (l?.liabilityProfileId === pid && typeof l.partyProfileId === "string" && l.partyProfileId) {
        ids.push(l.partyProfileId);
      }
    }
  }
  return ids;
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

/**
 * Owner ids for a profile, walking the WHOLE nesting chain.
 *
 * `ownerCandidatesForProfile` above only looks at the direct
 * `parentProfileId`, so a grandchild (Bob → Home → MacBook) reads as
 * unowned. This walks every ancestor and unions in the co-owner party ids
 * from the link tables at each step.
 *
 * Unlike `ownerCandidatesForProfile`, the profile's OWN id is deliberately
 * excluded: the question here is "who does this belong to?", not "is this the
 * selected thing?". A profile with no parent and no link rows therefore
 * returns `[]` — an orphan — which `isInScope(..., "belongs_to_self")` maps
 * onto the Self profile, matching the app-wide rule that unattributed things
 * are mine.
 *
 * Pure and cycle-safe.
 */
export function ownerChainForProfile(
  profile: { id?: string | null; parentProfileId?: string | null } | null | undefined,
  allProfiles: ReadonlyArray<{ id: string; parentProfileId?: string | null }>,
  assetLinks?: ReadonlyArray<{ assetProfileId?: string | null; partyProfileId?: string | null }> | null,
  liabilityLinks?: ReadonlyArray<{ liabilityProfileId?: string | null; partyProfileId?: string | null }> | null,
): string[] {
  const out = new Set<string>();
  if (!profile || typeof profile.id !== "string" || !profile.id) return [];
  const byId = new Map((allProfiles || []).map((p) => [p.id, p] as const));
  const seen = new Set<string>();
  type Node = { id?: string | null; parentProfileId?: string | null };
  let cur: Node | undefined = profile;
  while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
    seen.add(cur.id);
    for (const id of ownerCandidatesForProfile(cur, assetLinks, liabilityLinks)) {
      if (id !== profile.id) out.add(id);
    }
    const nextId: string | null | undefined = cur.parentProfileId;
    cur = typeof nextId === "string" && nextId ? (byId.get(nextId) as Node | undefined) : undefined;
  }
  return [...out];
}
