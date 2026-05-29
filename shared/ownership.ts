/**
 * Ownership — the single writer for "who owns this entity?"
 *
 * One module, one function (`setOwners`), one truth. Every code path that
 * wants to set, change, or clear ownership for an entity goes through here.
 * No other code is allowed to write `linked_profiles` on an entity row, and
 * no other code is allowed to write to a `profile_*` junction table.
 *
 * This file is intentionally pure: it exports
 *   - `OWNERSHIP_TABLES`: the metadata table that maps entity type to its
 *     entity table, its junction table (if any), and the FK column name.
 *   - `normalizeOwners`: validation + default-to-self.
 * The runtime writer lives in `server/ownership-writer.ts` and uses these
 * primitives to do the atomic write.
 *
 * Stage 1 of the ownership consolidation plan
 * (docs/ownership_consolidation_plan.md).
 */

/**
 * Every entity type that has a `linked_profiles` JSONB column or any other
 * representation of ownership. Source: surveyed live on 2026-05-28.
 */
export type OwnedEntityType =
  | "expense"
  | "tracker"
  | "task"
  | "event"
  | "obligation"
  | "habit"
  | "goal"
  | "artifact"
  | "document"
  | "income"
  | "journal_entry";

export interface OwnershipTableSpec {
  /** Postgres table that holds the entity row. */
  entityTable: string;
  /** Junction table, or null if this entity type has none. */
  junctionTable: string | null;
  /** Name of the FK column on the junction table that points back to the entity. */
  junctionEntityColumn: string | null;
}

/**
 * Single source of truth for which tables back each entity type.
 * If a junction column is `null`, the JSONB is the only storage and there's
 * nothing to sync.
 */
export const OWNERSHIP_TABLES: Record<OwnedEntityType, OwnershipTableSpec> = {
  expense: { entityTable: "expenses", junctionTable: "profile_expenses", junctionEntityColumn: "expense_id" },
  tracker: { entityTable: "trackers", junctionTable: "profile_trackers", junctionEntityColumn: "tracker_id" },
  task: { entityTable: "tasks", junctionTable: "profile_tasks", junctionEntityColumn: "task_id" },
  event: { entityTable: "events", junctionTable: "profile_events", junctionEntityColumn: "event_id" },
  obligation: { entityTable: "obligations", junctionTable: "profile_obligations", junctionEntityColumn: "obligation_id" },
  habit: { entityTable: "habits", junctionTable: null, junctionEntityColumn: null },
  goal: { entityTable: "goals", junctionTable: null, junctionEntityColumn: null },
  artifact: { entityTable: "artifacts", junctionTable: "profile_artifacts", junctionEntityColumn: "artifact_id" },
  document: { entityTable: "documents", junctionTable: "profile_documents", junctionEntityColumn: "document_id" },
  income: { entityTable: "incomes", junctionTable: null, junctionEntityColumn: null },
  journal_entry: { entityTable: "journal_entries", junctionTable: null, junctionEntityColumn: null },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NormalizeOwnersResult {
  ownerIds: string[];
  /** True if the caller passed nothing usable and we filled in `selfId`. */
  defaultedToSelf: boolean;
}

/**
 * Normalize a candidate ownership array.
 *
 *   1. Drop null / undefined / non-string entries.
 *   2. Drop anything that isn't a UUID. Names and slugs are caller bugs —
 *      ownership is stored as IDs only ("Names are only labels", per the
 *      app's invariants).
 *   3. Dedupe while preserving order.
 *   4. If the result is empty, default to the caller's `selfId`.
 *
 * This is the only place default-to-self lives. Removing the duplicates
 * scattered across createX methods is a Stage 1 follow-up.
 */
export function normalizeOwners(
  candidate: readonly unknown[] | null | undefined,
  selfId: string,
): NormalizeOwnersResult {
  if (!selfId || typeof selfId !== "string" || !UUID_RE.test(selfId)) {
    throw new Error(`normalizeOwners: selfId must be a UUID, got ${JSON.stringify(selfId)}`);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  if (Array.isArray(candidate)) {
    for (const raw of candidate) {
      if (typeof raw !== "string") continue;
      const id = raw.trim();
      if (!id || !UUID_RE.test(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }

  if (out.length === 0) {
    return { ownerIds: [selfId], defaultedToSelf: true };
  }
  return { ownerIds: out, defaultedToSelf: false };
}

/**
 * Compute the junction row diff so the writer can issue exactly one insert
 * and one delete (no churn for unchanged rows).
 *
 * Exported because the writer keeps the SQL but pure tests own the math.
 */
export function diffOwners(
  before: readonly string[],
  after: readonly string[],
): { toInsert: string[]; toDelete: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const toInsert: string[] = [];
  const toDelete: string[] = [];
  for (const id of after) if (!beforeSet.has(id)) toInsert.push(id);
  for (const id of before) if (!afterSet.has(id)) toDelete.push(id);
  return { toInsert, toDelete };
}
