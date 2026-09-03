// ─── Cache patching primitives ──────────────────────────────────────────────
//
// Shared by BOTH write paths — the AI chat manifest (chat-sync.ts) and ordinary
// REST writes made from the interface (write-sync.ts). The rule they enforce is
// the same in both cases: when a write succeeds, every cached list that shows
// that row is updated in place, so the change is on screen everywhere before
// any refetch returns.
//
// Keeping this in one module is deliberate. The reason the interface felt
// slower than chat was that only chat had this logic; anything split between
// the two paths drifts and one of them regresses.
import type { ChatMutation } from "@shared/schema";
import { passesProfileFilter } from "@shared/profile-filter";
import type { Domain } from "@shared/entity-domains";
import { queryClient } from "./queryClient";

/** Domains the bus knows how to expand. Anything else falls back to "everything". */
function toDomains(raw: unknown): Domain[] {
  if (!Array.isArray(raw) || raw.length === 0) return ["everything"];
  return raw.filter((d): d is Domain => typeof d === "string" && d.length > 0) as Domain[];
}

/**
 * Is this cached value a list of rows we can patch?
 *
 * Deliberately strict: aggregate payloads (/api/stats, /api/dashboard-enhanced)
 * and paginated envelopes are left alone for invalidation to refresh. Writing a
 * row into a shape we don't understand would put wrong numbers on screen, which
 * is worse than waiting one round trip.
 */
function isRowList(value: unknown): value is Array<Record<string, any>> {
  return Array.isArray(value) && value.every((r) => r && typeof r === "object" && !Array.isArray(r));
}

/** Profile ids known to this client, from the cached profiles list. */
function knownProfileIds(): Set<string> | null {
  const all = queryClient.getQueryData<Array<{ id: string }>>(["/api/profiles"]);
  if (!Array.isArray(all) || all.length === 0) return null;
  return new Set(all.map((p) => p?.id).filter((id): id is string => typeof id === "string"));
}

/**
 * The profile ids a scope-keyed query is filtered to.
 *
 * Key convention (shared/query-keys.ts): [endpoint, mode, ...selectedIds, ...extra].
 * The trailing `extra` is a free-form sub-slice discriminator ("hero", "trends",
 * "detail"), so ids are identified by membership in the known profile list
 * rather than by guessing at their shape — ids are opaque strings and a regex
 * would misclassify whichever convention the backend uses next.
 *
 * Returns null when the answer can't be established (an unrecognized key shape,
 * or no cached profile list to resolve against). Callers treat null as "don't
 * insert" and let the refetch handle it — a wrong guess here would put one
 * person's data in another person's filtered view.
 */
export function scopeIdsFromKey(
  key: readonly unknown[],
  known: Set<string> | null = knownProfileIds(),
): string[] | null {
  if (!Array.isArray(key) || key.length < 2) return []; // bare [endpoint] — unscoped
  const mode = key[1];
  if (mode === "everyone") return [];
  if (mode !== "selected") return null; // some other key shape (dates, ids, slices)
  if (!known) return null;
  const ids: string[] = [];
  for (let i = 2; i < key.length; i++) {
    const seg = key[i];
    if (typeof seg !== "string" || !known.has(seg)) break;
    ids.push(seg);
  }
  return ids;
}

/**
 * Would this row show up in a list filtered to `selectedIds`?
 *
 * Guards the optimistic insert only. Getting this wrong in the permissive
 * direction would flash one person's data into another's filtered view — the
 * exact bug class the profile-filter rules exist to prevent — so an
 * indeterminate answer (no cached profile list to resolve `self` against) is
 * treated as "don't insert" and left to the refetch.
 */
function rowBelongsInScope(row: Record<string, any>, selectedIds: string[]): boolean {
  if (selectedIds.length === 0) return true; // unfiltered list
  const allProfiles = queryClient.getQueryData<Array<{ id: string; type?: string }>>(["/api/profiles"]);
  if (!Array.isArray(allProfiles) || allProfiles.length === 0) return false;
  const linked = Array.isArray(row.linkedProfiles) ? row.linkedProfiles : undefined;
  // A profile row is in scope when it IS one of the selected profiles.
  if (!linked && typeof row.id === "string" && selectedIds.includes(row.id)) return true;
  // Co-ownership widens the selection (a co-owner's car): read the cached
  // links so a new car task lands in Linda's list the same way a refetch would.
  const cachedLinks = queryClient.getQueryData<any[]>(["/api/asset-party-links"]);
  const cachedLiabLinks = queryClient.getQueryData<any[]>(["/api/liability-profile-links"]);
  return passesProfileFilter(linked, {
    selectedIds, allProfiles,
    assetPartyLinks: Array.isArray(cachedLinks) ? cachedLinks : [],
    liabilityProfileLinks: Array.isArray(cachedLiabLinks) ? cachedLiabLinks : [],
  });
}

/** Apply one mutation to one cached list. Returns the new list, or the old one. */
function patchList(
  list: Array<Record<string, any>>,
  mutation: ChatMutation,
  selectedIds: string[] | null,
): Array<Record<string, any>> {
  const id = mutation.id;
  if (!id) return list;
  if (mutation.op === "delete") {
    const next = list.filter((r) => r?.id !== id);
    return next.length === list.length ? list : next;
  }
  const row = mutation.row;
  if (!row) return list;
  const existing = list.findIndex((r) => r?.id === id);
  if (existing >= 0) {
    // Update (or a create whose refetch already landed): merge over the cached
    // row so fields the tool didn't return survive.
    const next = list.slice();
    next[existing] = { ...next[existing], ...row };
    return next;
  }
  if (mutation.op !== "create") return list; // updating a row this list doesn't have
  if (selectedIds === null) return list;     // unreadable key shape — let the refetch do it
  if (!rowBelongsInScope(row, selectedIds)) return list;
  return [row, ...list];
}


/**
 * Write a set of changes into every cached list that shows them.
 *
 * Iterates matching queries directly (rather than setQueriesData) because each
 * query's own key decides whether an inserted row belongs in it — one pass hits
 * the unscoped ["/api/tasks"] list, every ["/api/tasks", mode, ...ids] variant,
 * and any sub-slice keyed off the same head. That breadth is the point: the row
 * has to be right whichever page the user opens next.
 */
export function applyRowPatches(mutations: ChatMutation[]): void {
  for (const mutation of mutations) {
    const endpoint = mutation.endpoint;
    if (!endpoint || !mutation.id) continue;
    const matches = queryClient.getQueryCache().findAll({
      predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === endpoint,
    });
    for (const query of matches) {
      const current = query.state.data;
      if (!isRowList(current)) continue;
      const next = patchList(current, mutation, scopeIdsFromKey(query.queryKey));
      if (next !== current) queryClient.setQueryData(query.queryKey, next);
    }
  }
}

export { isRowList, toDomains };
