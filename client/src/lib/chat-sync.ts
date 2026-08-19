// ─── AI write → UI synchronization ──────────────────────────────────────────
//
// The problem this solves: a chat turn wrote a row to the database, the AI
// confirmed it, and the page that lists that row still showed the old data
// until the user hit refresh.
//
// The old path (chat.tsx `invalidateAll`) did two things wrong. It never used
// the row the server had already returned, so the UI could only show the new
// item once a REFETCH came back — and it fired that refetch immediately, into a
// window where the server's version-stamped response cache could still serve
// pre-write data, which React Query then stored as fresh for a full staleTime.
// Hence "not there → refresh → there".
//
// The path here:
//   1. Record the server's post-write data version, so every request this
//      function triggers is a read-your-writes read (see queryClient.ts).
//   2. Patch the returned rows straight into every cached list that shows them,
//      synchronously. The UI is correct before any network call.
//   3. Invalidate the affected DOMAINS through the cache bus — which also
//      broadcasts to other tabs and covers nested keys — as the background
//      reconcile. The server stays the source of truth; it just no longer gates
//      what the user sees.
//
// Anything the server couldn't describe precisely arrives as the "everything"
// domain, which degrades to exactly the blanket invalidation this replaces.
import type { ChatMutation } from "@shared/schema";
import { passesProfileFilter } from "@shared/profile-filter";
import type { Domain } from "@shared/entity-domains";
import { queryClient, noteDataVersion } from "./queryClient";
import { invalidateDomains } from "./cache-bus";
import { perfMark, perfMeasure } from "./perf-marks";

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
  return passesProfileFilter(linked, { selectedIds, allProfiles });
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
 * Entry point: apply a chat turn's change manifest.
 *
 * `mutations` absent (an older server, or a turn we couldn't describe) falls
 * back to the blanket invalidation this replaced, so a write is never missed.
 */
export async function applyChatMutations(
  mutations: ChatMutation[] | undefined | null,
  dataVersion?: unknown,
): Promise<void> {
  noteDataVersion(dataVersion);
  perfMark("chat:mutations-start");

  if (!Array.isArray(mutations) || mutations.length === 0) {
    await invalidateDomains("everything");
    perfMeasure("chat:sync(fallback)", "chat:mutations-start");
    return;
  }

  // 1. Optimistic patch — synchronous, so the next render already has the row.
  applyRowPatches(mutations);
  perfMark("chat:cache-applied");
  perfMeasure("chat:cache-patch", "chat:mutations-start");

  // 2. Background reconcile over every affected domain (cross-tab included).
  //    "dashboard" is always included: every write moves a KPI tile, the
  //    activity feed, or the bootstrap payload that seeds the next launch, and
  //    those aggregates can't be patched from a single row.
  const domains = new Set<Domain>(["dashboard"]);
  for (const m of mutations) for (const d of toDomains(m.domains)) domains.add(d);
  await invalidateDomains(...domains);
  perfMeasure("chat:sync", "chat:mutations-start");
}

/**
 * Write a turn's changes into every cached list that shows them.
 *
 * Iterates matching queries directly (rather than setQueriesData) because each
 * query's own key decides whether an inserted row belongs in it — one pass hits
 * the unscoped ["/api/tasks"] list, every ["/api/tasks", mode, ...ids] variant,
 * and any sub-slice keyed off the same head. That breadth is the point: the row
 * has to be there whichever page the user navigates to.
 *
 * Exported for tests.
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
