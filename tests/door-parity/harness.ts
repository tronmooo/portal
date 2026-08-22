// ─── Door-parity harness ────────────────────────────────────────────────────
//
// The invariant the orchestration layer exists to guarantee: THE SAME SEMANTIC
// INPUT THROUGH ANY DOOR (chat tool, REST handler, extraction confirm, fast
// path, bulk) PRODUCES THE SAME DATABASE END STATE AND THE SAME CHANGE
// MANIFEST, and an ai_action_log row naming the door it came through.
//
// Each per-entity parity test (tests/door-parity-*.test.ts) drives every door
// against an identically-seeded MemStorage and asserts the outcomes match
// through these normalizers. Chat tools are driven via executeTool directly —
// no model call — inside requestStorageContext, the way the engine tests do.
import type { ChatMutation } from "@shared/schema";
import { MemStorage, requestStorageContext } from "../../server/storage";
import {
  beginMutationContext,
  runMutation,
  type MutationDoor,
  type MutationOutcome,
} from "../../server/mutation-outcome";

export { MemStorage };

/** Run `fn` with `storage` as the ambient request storage (chat tools need it). */
export const withStorage = <T>(storage: MemStorage, fn: () => Promise<T>): Promise<T> =>
  requestStorageContext.run(storage, fn);

/**
 * Drive one write through the door-agnostic contract, exactly as the door's
 * production code composes it: the REST handlers call runMutation around their
 * service call; the chat door's loop composes the same primitives with the
 * same semantics (see server/mutation-outcome.ts's header).
 */
export async function driveDoor(
  storage: MemStorage,
  door: MutationDoor,
  tool: string,
  input: Record<string, any>,
  execute: () => Promise<any>,
): Promise<MutationOutcome> {
  const ctx = beginMutationContext(storage, door);
  return withStorage(storage, () => runMutation(ctx, { tool, input, execute }));
}

/** Volatile per-row fields that legitimately differ between doors. */
const VOLATILE_KEYS = new Set(["id", "createdAt", "updatedAt", "deletedAt", "source", "sourceDoor"]);

/** A row with ids/timestamps/door-marks stripped, for cross-door comparison. */
export function normalizeRow(row: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!row || typeof row !== "object") return null;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (VOLATILE_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

/** Manifest projection that must be identical across doors (ids/rows differ). */
export function normalizeManifest(mutations: ChatMutation[]): Array<Record<string, any>> {
  return mutations.map((m) => ({
    op: m.op,
    entityType: m.entityType,
    endpoint: m.endpoint ?? null,
    domains: [...(m.domains || [])].sort(),
  }));
}

/** Ledger rows as the parity assertions read them. */
export async function ledgerRows(storage: MemStorage): Promise<Array<{ tool: string; source: string; entityType: string | null; reversible: boolean }>> {
  const rows = await storage.listAiActionLog({ limit: 50 });
  return rows.map((r) => ({
    tool: r.tool,
    source: r.source,
    entityType: r.entityType ?? null,
    reversible: r.reversible,
  }));
}
