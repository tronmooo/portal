/**
 * Ownership writer — the runtime side of the single writer.
 *
 * Pairs with `shared/ownership.ts` (pure spec + normalization).
 * Every place in `server/` that wants to change "who owns this entity?" goes
 * through `setOwners` below. No other code is allowed to update
 * `linked_profiles` or write to `profile_*` junction tables — Stage 4 of the
 * ownership consolidation plan adds a build-time check that enforces this.
 *
 * Stage 1 of docs/ownership_consolidation_plan.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  OWNERSHIP_TABLES,
  normalizeOwners,
  diffOwners,
  type OwnedEntityType,
} from "../shared/ownership";

export interface SetOwnersOptions {
  /** When `true` (default), defaults to `[selfId]` if the input is empty. */
  defaultToSelf?: boolean;
  /** When `true`, writes an `audit_log` row recording before/after. Default `true`. */
  audit?: boolean;
}

export interface SetOwnersResult {
  ownerIds: string[];
  defaultedToSelf: boolean;
  changed: boolean;
}

/**
 * Set the owners of a single entity row atomically.
 *
 * - Reads the current `linked_profiles` so we can compute the junction diff
 *   (one insert, one delete — no churn on unchanged rows).
 * - Updates the entity row's JSONB column.
 * - Syncs the junction table if one exists for this entity type.
 * - Writes an `audit_log` row capturing the before/after.
 *
 * Throws on validation failures. Callers should not catch and proceed —
 * a failure here means the row would be in an inconsistent state.
 */
export async function setOwners(
  sb: SupabaseClient,
  userId: string,
  entityType: OwnedEntityType,
  entityId: string,
  candidate: readonly unknown[] | null | undefined,
  selfId: string,
  opts: SetOwnersOptions = {},
): Promise<SetOwnersResult> {
  const spec = OWNERSHIP_TABLES[entityType];
  if (!spec) throw new Error(`setOwners: unknown entityType ${entityType}`);
  if (!entityId || typeof entityId !== "string") {
    throw new Error(`setOwners: entityId must be a UUID string`);
  }

  // Normalize the desired owner set.
  const defaultToSelf = opts.defaultToSelf !== false;
  const { ownerIds: after, defaultedToSelf } = defaultToSelf
    ? normalizeOwners(candidate, selfId)
    : (() => {
        // Caller explicitly opted out of default-to-self (rare). We still
        // validate, dedupe, and drop non-UUIDs — empty is allowed in this mode.
        const seen = new Set<string>();
        const out: string[] = [];
        if (Array.isArray(candidate)) {
          for (const raw of candidate) {
            if (typeof raw !== "string") continue;
            const id = raw.trim();
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) continue;
            if (seen.has(id)) continue;
            seen.add(id);
            out.push(id);
          }
        }
        return { ownerIds: out, defaultedToSelf: false };
      })();

  // Read current state so we can compute the diff and audit accurately.
  const { data: row, error: readErr } = await sb
    .from(spec.entityTable)
    .select("linked_profiles")
    .eq("id", entityId)
    .eq("user_id", userId)
    .maybeSingle();
  if (readErr) throw new Error(`setOwners read failed: ${readErr.message}`);
  if (!row) throw new Error(`setOwners: ${spec.entityTable}/${entityId} not found for user ${userId}`);
  const before: string[] = Array.isArray(row.linked_profiles)
    ? row.linked_profiles.filter((x: unknown): x is string => typeof x === "string")
    : [];

  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const changed = before.length !== after.length || after.some(id => !beforeSet.has(id)) || before.some(id => !afterSet.has(id));

  if (!changed) {
    return { ownerIds: after, defaultedToSelf, changed: false };
  }

  // Write JSONB first.
  const { error: updErr } = await sb
    .from(spec.entityTable)
    .update({ linked_profiles: after })
    .eq("id", entityId)
    .eq("user_id", userId);
  if (updErr) throw new Error(`setOwners update ${spec.entityTable} failed: ${updErr.message}`);

  // Sync junction table if this entity type has one.
  if (spec.junctionTable && spec.junctionEntityColumn) {
    const { toInsert, toDelete } = diffOwners(before, after);
    if (toDelete.length > 0) {
      const { error: delErr } = await sb
        .from(spec.junctionTable)
        .delete()
        .eq(spec.junctionEntityColumn, entityId)
        .eq("user_id", userId)
        .in("profile_id", toDelete);
      if (delErr) throw new Error(`setOwners delete junction ${spec.junctionTable} failed: ${delErr.message}`);
    }
    if (toInsert.length > 0) {
      const rows = toInsert.map(pid => ({
        [spec.junctionEntityColumn as string]: entityId,
        profile_id: pid,
        user_id: userId,
      }));
      const { error: insErr } = await sb
        .from(spec.junctionTable)
        .upsert(rows, { onConflict: `${spec.junctionEntityColumn},profile_id` });
      if (insErr) throw new Error(`setOwners insert junction ${spec.junctionTable} failed: ${insErr.message}`);
    }
  }

  // Audit (fire-and-forget — failure here doesn't roll back the data write,
  // because the data write is already correct).
  if (opts.audit !== false) {
    Promise.resolve(sb.from("audit_log").insert({
      user_id: userId,
      action: "set_owners",
      entity_type: entityType,
      entity_id: entityId,
      description: `owners changed from ${JSON.stringify(before)} to ${JSON.stringify(after)}`,
      source: "ownership-writer",
    })).catch(() => { /* non-blocking */ });
  }

  return { ownerIds: after, defaultedToSelf, changed: true };
}
