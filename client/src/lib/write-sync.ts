// ─── REST write → UI synchronization ────────────────────────────────────────
//
// The AI chat path got a change manifest, an optimistic cache patch and a
// read-your-writes token. Ordinary writes made from the interface — every Add
// button, every checkbox, every delete, roughly 600 call sites — got none of
// it: they fired a mutation, invalidated some domains, and waited for the
// network. That is why adding, editing and deleting from the UI still felt
// slow, and why a deleted row could linger on other screens: nothing updated
// those screens until their own refetch came back.
//
// Rather than edit 600 call sites, this hooks the ONE place they all go
// through: apiRequest in queryClient.ts. Every successful write is applied to
// the cache by id, so the change is visible everywhere it appears before the
// refetch lands.
//
// Two rules keep it safe:
//   · it only ever acts on a response that is recognisably the written row
//     (an object carrying the same id the URL addressed);
//   · it stays out of the way of call sites that already do their own
//     optimistic work, so nothing is inserted twice.
//
// UPDATE (manifest era): the server now TELLS us what a write changed, in a
// response header built from the storage calls the request actually made (see
// shared/write-manifest.ts, server/write-journal.ts). `applyWriteManifest` is
// the path that uses it, and it is strictly better than the URL heuristic
// below in two ways that mattered:
//   · a write that touches two entities reports both — recording a payment
//     moves the payment list AND the liability's balance, and only the
//     manifest ever said so;
//   · the domains to invalidate come from the write instead of from whichever
//     screen happened to fire it, so a screen can no longer forget one.
// The heuristic path stays as the fallback for a response with no manifest
// (an older server mid-deploy), which is exactly the behavior we had before.
import type { ChatMutation } from "@shared/schema";
import type { WriteManifest } from "@shared/write-manifest";
import { queryClient } from "./queryClient";
import { invalidateDomains } from "./cache-bus";
import { applyRowPatches, isRowList } from "./cache-patch";

/**
 * `/api/tasks/abc123` → { collection: "/api/tasks", id: "abc123" }.
 *
 * A URL with a SUB-RESOURCE or an action after the id — `/api/liabilities/:id/payments`,
 * `/api/obligations/:id/pay` — does not address a row in `/api/liabilities` at
 * all, and the body it returns belongs to a different collection entirely.
 * Reporting `{collection:"/api/liabilities"}` for those made the heuristic
 * apply a payment row as an update to the liabilities list, where it matched
 * nothing and silently did nothing. Returning null is honest: the manifest
 * path handles these correctly, and where there is no manifest, invalidation
 * is the right answer rather than a wrong patch.
 */
export function parseWriteTarget(url: string): { collection: string; id?: string } | null {
  const path = url.split("?")[0].replace(/\/+$/, "");
  const m = path.match(/^\/api\/([a-z0-9-]+)(?:\/([^/]+))?(\/.*)?$/i);
  if (!m) return null;
  if (m[3]) return null; // sub-resource or action — not a row in this collection
  return { collection: `/api/${m[1]}`, id: m[2] || undefined };
}

/* ─── Tombstones ───────────────────────────────────────────────────────────
   A delete has to survive responses that are already in flight. Without this,
   a GET issued microseconds before the delete — or served from a server cache
   an instance has not busted yet — lands afterwards and puts the row back on
   screen, which is exactly "I deleted it and it showed up again somewhere
   else". Every list response is filtered through this set, so a deleted row
   cannot reappear no matter which response wins the race.

   A tombstone is released as soon as a fresh response for that collection
   agrees the row is gone, and in any case after TOMBSTONE_TTL_MS, so a failed
   delete can never hide a row permanently. */
const TOMBSTONE_TTL_MS = 30_000;
const tombstones = new Map<string, number>();

export function tombstone(id: string): void {
  if (!id) return;
  tombstones.set(id, Date.now() + TOMBSTONE_TTL_MS);
}

/** Undo/restore paths must be able to bring a row back immediately. */
export function clearTombstone(id: string): void {
  tombstones.delete(id);
}

export function isTombstoned(id: unknown): boolean {
  if (typeof id !== "string") return false;
  const until = tombstones.get(id);
  if (until === undefined) return false;
  if (Date.now() > until) { tombstones.delete(id); return false; }
  return true;
}

export function clearAllTombstones(): void {
  tombstones.clear();
}

/**
 * Drop tombstoned rows from a list the server just returned, and retire any
 * tombstone the server now agrees with.
 *
 * Called on every query response, so it must be cheap and must never alter a
 * payload it does not understand.
 */
export function filterTombstoned<T>(data: T): T {
  if (tombstones.size === 0 || !Array.isArray(data)) return data;
  let removed = false;
  const kept = (data as any[]).filter((row) => {
    if (!row || typeof row !== "object" || !isTombstoned((row as any).id)) return true;
    removed = true;
    return false;
  });
  // The server no longer lists these — the delete has propagated, so stop
  // filtering them and let the server be the source of truth again.
  if (!removed) {
    for (const [id] of tombstones) {
      if (!(data as any[]).some((row) => row && typeof row === "object" && (row as any).id === id)) {
        tombstones.delete(id);
      }
    }
    return data;
  }
  return kept as unknown as T;
}

/** Does this cached list already hold a call site's own optimistic row? */
function hasPendingOptimisticRow(collection: string): boolean {
  return queryClient.getQueryCache().getAll().some((q) => {
    if (!Array.isArray(q.queryKey) || q.queryKey[0] !== collection) return false;
    const data = q.state.data;
    return isRowList(data) && (data as any[]).some((r) => r && (r as any)._optimistic);
  });
}

/** Remove a row from every cached list for a collection. */
function removeEverywhere(collection: string, id: string): void {
  applyRowPatches([{ op: "delete", entityType: null, domains: [], id, endpoint: collection }]);
}

/**
 * Apply a successful REST write to the cache.
 *
 * `body` is the parsed response, when it was JSON. Returns the change it made,
 * for diagnostics.
 */
export function applyRestWrite(method: string, url: string, body: unknown): ChatMutation | null {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return null;
  const target = parseWriteTarget(url);

  if (verb === "DELETE") {
    // The id in the URL is the row being removed. Some delete routes address a
    // sub-resource (".../checkin/:checkinId"); the LAST path segment is the
    // thing being deleted, so prefer it.
    const segments = url.split("?")[0].replace(/\/+$/, "").split("/");
    const id = segments[segments.length - 1];
    if (!id || id.startsWith("api")) return null;
    // Tombstone regardless of shape: a response already in flight must not put
    // the row back on screen, and that is true whether or not we can name the
    // list it came from.
    tombstone(id);
    if (!target) return { op: "delete", entityType: null, domains: [], id, endpoint: null };
    if (id === target.collection.split("/").pop()) return null;
    removeEverywhere(target.collection, id);
    return { op: "delete", entityType: null, domains: [], id, endpoint: target.collection };
  }

  // Creates and updates only act on a response that IS the row.
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, any>;
  const id = typeof row.id === "string" ? row.id : undefined;
  if (!id) return null;

  // A write that names a row un-deletes it as far as the UI is concerned —
  // this is what makes Undo and restore instant. It happens before the shape
  // checks below because a restore route (`/api/tasks/:id/restore`) is exactly
  // the URL shape those checks decline to patch, and leaving the tombstone in
  // place would keep the restored row hidden.
  clearTombstone(id);

  // A bare acknowledgement ({ id, ok: true }) is not a row worth rendering.
  if (Object.keys(row).length < 3) return null;
  // Everything below patches a NAMED collection, so a sub-resource URL (which
  // parseWriteTarget declines to name) has nothing further to do here.
  if (!target) return null;

  const isUpdate = verb === "PATCH" || verb === "PUT" || (!!target.id && target.id !== id);
  if (!isUpdate && hasPendingOptimisticRow(target.collection)) {
    // This call site is already managing its own optimistic row; inserting a
    // second copy would show the item twice until its onSuccess reconciled.
    return null;
  }
  const op: ChatMutation["op"] = isUpdate ? "update" : "create";
  applyRowPatches([{ op, entityType: null, domains: [], id, endpoint: target.collection, row }]);
  return { op, entityType: null, domains: [], id, endpoint: target.collection, row };
}


/* ─── Manifest-driven sync (the canonical path) ────────────────────────────
   Ordering matters and is the whole point:
     1. patch the cache from the rows the server returned — synchronous, so the
        next render already shows the new balance/value/row;
     2. invalidate the domains the server named — the background reconcile.
   The user sees step 1. Step 2 only ever confirms it. */

/** The aggregate payloads no row can be patched into — they must refetch. */
const AGGREGATE_ENDPOINTS = new Set([
  "/api/stats",
  "/api/dashboard-enhanced",
  "/api/dashboard-bootstrap",
]);

/**
 * Apply a server-declared change manifest.
 *
 * Returns true when it handled the write, so the caller knows not to fall back
 * to the URL heuristic (and the global mutation default knows it does not need
 * its blanket mark-everything-stale).
 */
export async function applyWriteManifest(manifest: WriteManifest | null | undefined): Promise<boolean> {
  if (!manifest || !Array.isArray(manifest.domains) || manifest.domains.length === 0) return false;

  // 1. Optimistic patch from the authoritative rows.
  const patches: ChatMutation[] = [];
  for (const change of manifest.changes || []) {
    if (change.op === "delete") tombstone(change.id);
    else clearTombstone(change.id);
    if (!change.endpoint) continue; // no patchable list — invalidation covers it
    patches.push({
      op: change.op,
      entityType: null,
      domains: [],
      id: change.id,
      endpoint: change.endpoint,
      ...(change.row ? { row: change.row } : {}),
    } as ChatMutation);
  }
  if (patches.length > 0) applyRowPatches(patches);

  // 2. Background reconcile over exactly the domains this write touched.
  //    The aggregates are refetched rather than merely marked stale: they are
  //    what net worth, the KPI tiles and recent activity render, and leaving
  //    them stale-but-unfetched is what made the NEXT page show pre-write
  //    numbers while it quietly refetched behind them.
  await invalidateDomains(...manifest.domains);
  return true;
}

/** Is this query key one of the aggregate payloads that can never be patched? */
export function isAggregateKey(key: unknown): boolean {
  return Array.isArray(key) && typeof key[0] === "string" && AGGREGATE_ENDPOINTS.has(key[0]);
}
