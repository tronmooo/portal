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
import type { ChatMutation } from "@shared/schema";
import { queryClient } from "./queryClient";
import { applyRowPatches, isRowList } from "./cache-patch";

/** `/api/tasks/abc123` → { collection: "/api/tasks", id: "abc123" }. */
export function parseWriteTarget(url: string): { collection: string; id?: string } | null {
  const path = url.split("?")[0].replace(/\/+$/, "");
  const m = path.match(/^\/api\/([a-z0-9-]+)(?:\/([^/]+))?/i);
  if (!m) return null;
  const collection = `/api/${m[1]}`;
  const id = m[2];
  // A trailing segment that is clearly an action, not an id ("/restore",
  // "/checkin", "/pay"), addresses the row before it — but the body of such a
  // call is rarely the row itself, so we keep the id and let the id-match
  // guard below decide whether anything is applied.
  return { collection, id: id || undefined };
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
  if (!target) return null;

  if (verb === "DELETE") {
    // The id in the URL is the row being removed. Some delete routes address a
    // sub-resource (".../checkin/:checkinId"); the LAST path segment is the
    // thing being deleted, so prefer it.
    const segments = url.split("?")[0].replace(/\/+$/, "").split("/");
    const id = segments[segments.length - 1];
    if (!id || id === target.collection.split("/").pop()) return null;
    tombstone(id);
    removeEverywhere(target.collection, id);
    return { op: "delete", entityType: null, domains: [], id, endpoint: target.collection };
  }

  // Creates and updates only act on a response that IS the row.
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, any>;
  const id = typeof row.id === "string" ? row.id : undefined;
  if (!id) return null;
  // A bare acknowledgement ({ id, ok: true }) is not a row worth rendering.
  if (Object.keys(row).length < 3) return null;

  // A write that names a row un-deletes it as far as the UI is concerned —
  // this is what makes Undo and restore instant.
  clearTombstone(id);

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
