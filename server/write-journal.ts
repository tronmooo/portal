// ─── Per-request write journal ──────────────────────────────────────────────
//
// What a request wrote is recorded as it writes, not declared up front. Every
// storage call in the app goes through the `storage` proxy in server/storage.ts
// (routes.ts, ai-engine.ts's 143 tool call sites, finance-routes.ts, the cron
// jobs), so hooking that proxy gives one journal that both the REST path and
// the AI chat path fill in without either of them knowing it exists.
//
// This is the point of the design: a write cannot fail to be reported because
// somebody forgot to add it to a list. The worst a new, unmapped write can do
// is report the "everything" domain — which is what every write did before.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Domain } from "@shared/entity-domains";
import { targetForStorageMethod, isJournaledStorageMethod } from "@shared/storage-domains";
import type { WriteChange, WriteManifest } from "@shared/write-manifest";

/**
 * A bulk import can touch hundreds of rows. Past this many we keep the domains
 * (which is what drives correctness) and drop the per-row detail (which is only
 * an optimization), rather than build a manifest no header could carry.
 */
const MAX_CHANGES = 50;

export interface WriteJournal {
  record(method: string, args: unknown[], result: unknown): void;
  /** The manifest for everything recorded so far. Safe to call more than once. */
  drain(): WriteManifest;
  /** Did this request write anything at all? */
  get dirty(): boolean;
}

export const writeJournalContext = new AsyncLocalStorage<WriteJournal>();

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The id a call addressed: the returned row's, else the first string argument. */
function resolveId(args: unknown[], result: unknown): string | undefined {
  if (isPlainObject(result) && typeof result.id === "string" && result.id) return result.id;
  // Deletes return a boolean, so the id can only come from the arguments.
  const first = args[0];
  if (typeof first === "string" && first) return first;
  return undefined;
}

export function createWriteJournal(): WriteJournal {
  const domains = new Set<Domain>();
  // Keyed by op:endpoint:id so a row written twice in one request (create then
  // update, the liability-payment shape) collapses to its final state.
  const changes = new Map<string, WriteChange>();
  let overflowed = false;
  let dirty = false;

  return {
    get dirty() { return dirty; },

    record(method, args, result) {
      const target = targetForStorageMethod(method);
      if (!target) return; // read or infrastructure
      dirty = true;
      for (const d of target.domains) domains.add(d);

      const id = resolveId(args, result);
      if (!id) return;

      const row = isPlainObject(result) && typeof result.id === "string" ? result : undefined;
      const endpoint = target.endpointFrom
        ? target.endpointFrom(row ?? (isPlainObject(args[0]) ? args[0] : undefined))
        : (target.endpoint ?? null);

      const key = `${target.op}:${endpoint ?? ""}:${id}`;
      if (!changes.has(key) && changes.size >= MAX_CHANGES) { overflowed = true; return; }
      changes.set(key, { op: target.op, endpoint, id, ...(row ? { row } : {}) });
    },

    drain() {
      const list = [...domains];
      return {
        domains: list.length > 0 ? list : (["everything"] as Domain[]),
        changes: overflowed ? [] : [...changes.values()],
        ...(overflowed ? { truncated: true } : {}),
      };
    },
  };
}

/**
 * Record one storage call against the active journal. A no-op outside a
 * request (cron jobs, startup, tests), which is what keeps the storage proxy
 * safe to wrap unconditionally.
 */
export function journalStorageCall(method: string, args: unknown[], result: unknown): void {
  const journal = writeJournalContext.getStore();
  if (!journal) return;
  try { journal.record(method, args, result); } catch { /* bookkeeping must never fail a write */ }
}

export { isJournaledStorageMethod };
