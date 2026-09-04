// ── "Does this holding belong to the people in scope?" (pure, no React) ──────
//
// The Assets / Liabilities tabs answer this question for every asset and
// liability profile they render. It has TWO independent sources, and the bug
// this module exists to prevent is them disagreeing:
//
//   1. The relational link tables (`asset_party_links` /
//      `liability_profile_links`) fetched by the page, combined with the
//      profile's own id and its parent chain — `ownerCandidatesForProfile`.
//   2. The server's own share-aware breakdown for the SAME scope, which
//      /api/dashboard-enhanced already computed from those same link tables
//      (getDashboardEnhanced → assetBreakdown / liabilityBreakdown) and which
//      the Net Worth KPI and its popup render.
//
// Reported 2026-09-04: with one person selected, the Net Worth popup listed
// "Radio · $75 · 50% owned" while the Assets tab said "No assets or vehicles
// yet". Radio is parented to a DIFFERENT person and reaches the selected one
// only through a co-ownership row, so source (1) was the tab's entire answer —
// and while it is in flight (or if that one request fails) every co-owned
// holding disappears and the tab renders a confident, wrong empty state.
//
// So the rule is the UNION of the two: whatever the server already attributed
// to this scope is visible, plus whatever the link tables can prove locally.
// A union can only ever widen the list, never hide a row that used to show.

import { isInScope, ownerCandidatesForProfile } from "@shared/scope";

export interface HoldingVisibilityInput {
  /** The asset/liability profile id being tested. */
  id: string;
  /** Its `parentProfileId` column, if any. */
  parentId: string | null | undefined;
  /** The active selection. Empty = no filter = everything is visible. */
  selectedIds: string[];
  /** asset_party_links rows (assets) — pass null when testing a liability. */
  assetLinks?: ReadonlyArray<{ assetProfileId?: string | null; partyProfileId?: string | null }> | null;
  /** liability_profile_links rows (liabilities) — pass null when testing an asset. */
  liabilityLinks?: ReadonlyArray<{ liabilityProfileId?: string | null; partyProfileId?: string | null }> | null;
  /** All profiles, so the WHOLE parent chain counts, not just the direct parent. */
  allProfiles?: ReadonlyArray<{ id: string; parentProfileId?: string | null }> | null;
  /**
   * Ids the server already attributed to this scope (the breakdown rows from
   * /api/dashboard-enhanced). Optional: an empty set just means "no help from
   * the server yet", never "the server says no".
   */
  serverScopedIds?: ReadonlySet<string> | null;
}

export function isHoldingVisible(input: HoldingVisibilityInput): boolean {
  const { id, parentId, selectedIds } = input;
  if (!selectedIds || selectedIds.length === 0) return true;
  if (input.serverScopedIds?.has(id)) return true;
  return isInScope(
    ownerCandidatesForProfile(
      { id, parentProfileId: parentId ?? null },
      input.assetLinks ?? null,
      input.liabilityLinks ?? null,
      input.allProfiles ?? null,
    ),
    { selectedIds, selfIds: EMPTY_SELF_IDS },
    "out_of_scope",
  );
}

/**
 * Is the ownership answer known yet?
 *
 * Until the link tables have loaded (or the server breakdown has arrived) an
 * empty holdings list means "not known yet" — NOT "there is nothing here". The
 * tabs render a placeholder in that window instead of the "nothing yet" empty
 * state, which is what made the two surfaces contradict each other on screen.
 */
export function isOwnershipKnown(linksLoaded: boolean, serverScopedIds?: ReadonlySet<string> | null): boolean {
  return linksLoaded || (serverScopedIds?.size ?? 0) > 0;
}

// A holding is never an orphan (it always has at least its own id as a
// candidate), so the self-id set the "belongs_to_self" policy would consult is
// deliberately empty here — the policy in use is "out_of_scope".
const EMPTY_SELF_IDS: ReadonlySet<string> = new Set<string>();
