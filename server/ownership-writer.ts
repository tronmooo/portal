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
 * Add a single profile to an entity's owner set without touching the others.
 *
 * Thin wrapper over `setOwners` so additive call sites (the old
 * `linkProfileTo`) can route through the same chokepoint. Returns the
 * updated owner list. No-op if the profile is already an owner.
 */
export async function addOwner(
  sb: SupabaseClient,
  userId: string,
  entityType: OwnedEntityType,
  entityId: string,
  profileId: string,
  selfId: string,
): Promise<SetOwnersResult> {
  const spec = OWNERSHIP_TABLES[entityType];
  const { data: row, error } = await sb
    .from(spec.entityTable)
    .select("linked_profiles")
    .eq("id", entityId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`addOwner read failed: ${error.message}`);
  if (!row) throw new Error(`addOwner: ${spec.entityTable}/${entityId} not found`);
  const current: string[] = Array.isArray(row.linked_profiles)
    ? row.linked_profiles.filter((x: unknown): x is string => typeof x === "string")
    : [];
  // Always defer to setOwners (which reconciles the junction even when the
  //   JSONB is unchanged). The early `includes` short-circuit would skip
  //   the junction reconciliation when a prior writer set the JSONB inline
  //   but didn't touch the junction.
  const next = current.includes(profileId) ? current : [...current, profileId];
  return setOwners(sb, userId, entityType, entityId, next, selfId, { defaultToSelf: false });
}

/**
 * Remove a single profile from an entity's owner set. If removing the last
 * owner would leave the row orphaned, the row becomes owned by `selfId`
 * instead (matching the historic default-to-self behavior of every other
 * write path).
 */
export async function removeOwner(
  sb: SupabaseClient,
  userId: string,
  entityType: OwnedEntityType,
  entityId: string,
  profileId: string,
  selfId: string,
): Promise<SetOwnersResult> {
  const spec = OWNERSHIP_TABLES[entityType];
  const { data: row, error } = await sb
    .from(spec.entityTable)
    .select("linked_profiles")
    .eq("id", entityId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`removeOwner read failed: ${error.message}`);
  if (!row) throw new Error(`removeOwner: ${spec.entityTable}/${entityId} not found`);
  const current: string[] = Array.isArray(row.linked_profiles)
    ? row.linked_profiles.filter((x: unknown): x is string => typeof x === "string")
    : [];
  if (!current.includes(profileId)) {
    return { ownerIds: current, defaultedToSelf: false, changed: false };
  }
  const next = current.filter(id => id !== profileId);
  return setOwners(sb, userId, entityType, entityId, next, selfId);
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
  //   We retry the read once on a null result — Supabase has read replicas
  //   and a SELECT immediately after the INSERT of the same row can hit a
  //   replica that hasn't caught up yet. Without the retry, callers that
  //   create+setOwners back-to-back occasionally fail and leave the row
  //   with an empty owner set.
  let row: { linked_profiles: unknown } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error: readErr } = await sb
      .from(spec.entityTable)
      .select("linked_profiles")
      .eq("id", entityId)
      .eq("user_id", userId)
      .maybeSingle();
    if (readErr) throw new Error(`setOwners read failed: ${readErr.message}`);
    if (data) { row = data; break; }
    if (attempt < 2) await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
  }
  if (!row) throw new Error(`setOwners: ${spec.entityTable}/${entityId} not found for user ${userId}`);
  const before: string[] = Array.isArray(row.linked_profiles)
    ? row.linked_profiles.filter((x: unknown): x is string => typeof x === "string")
    : [];

  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const jsonbChanged = before.length !== after.length || after.some(id => !beforeSet.has(id)) || before.some(id => !afterSet.has(id));

  // Write JSONB if it changed. Skipping a no-op write saves a roundtrip on
  //   the hot path (most setOwners calls leave the JSONB column alone).
  if (jsonbChanged) {
    const { error: updErr } = await sb
      .from(spec.entityTable)
      .update({ linked_profiles: after })
      .eq("id", entityId)
      .eq("user_id", userId);
    if (updErr) {
      // The ownership guard (migration 20260729) refuses an owner id that
      // names no profile. That is the caller's bad input, not a server fault:
      // answer 404 like every other "no such profile", not a 500.
      const missing = /references profile ([0-9a-f-]+) which does not exist/i.exec(updErr.message || "");
      if (missing) throw Object.assign(new Error(`Profile ${missing[1]} not found`), { statusCode: 404 });
      throw new Error(`setOwners update ${spec.entityTable} failed: ${updErr.message}`);
    }
  }

  // Always reconcile the junction — even when JSONB was already correct, the
  //   junction may be stale (e.g. an upstream createX wrote linked_profiles
  //   inline before calling into this writer). We read the junction's
  //   current row set and diff against `after` so unrelated rows aren't
  //   touched.
  let junctionChanged = false;
  if (spec.junctionTable && spec.junctionEntityColumn) {
    const { data: jrows, error: readJErr } = await sb
      .from(spec.junctionTable)
      .select("profile_id")
      .eq(spec.junctionEntityColumn, entityId)
      .eq("user_id", userId);
    if (readJErr) throw new Error(`setOwners read junction ${spec.junctionTable} failed: ${readJErr.message}`);
    const currentJunction = (jrows || []).map((r: any) => r.profile_id as string);
    const { toInsert, toDelete } = diffOwners(currentJunction, after);
    if (toDelete.length > 0) {
      const { error: delErr } = await sb
        .from(spec.junctionTable)
        .delete()
        .eq(spec.junctionEntityColumn, entityId)
        .eq("user_id", userId)
        .in("profile_id", toDelete);
      if (delErr) throw new Error(`setOwners delete junction ${spec.junctionTable} failed: ${delErr.message}`);
      junctionChanged = true;
    }
    if (toInsert.length > 0) {
      const rows = toInsert.map(pid => ({
        [spec.junctionEntityColumn as string]: entityId,
        profile_id: pid,
        user_id: userId,
      }));
      const { error: insErr } = await sb
        .from(spec.junctionTable)
        .upsert(rows, { onConflict: `profile_id,${spec.junctionEntityColumn}` });
      if (insErr) throw new Error(`setOwners insert junction ${spec.junctionTable} failed: ${insErr.message}`);
      junctionChanged = true;
    }
  }

  const changed = jsonbChanged || junctionChanged;
  if (!changed) {
    return { ownerIds: after, defaultedToSelf, changed: false };
  }

  // Audit (fire-and-forget — failure here doesn't roll back the data write,
  // because the data write is already correct).
  if (opts.audit !== false) {
    Promise.resolve(sb.from("audit_log").insert({
      user_id: userId,
      action: "set_owners",
      entity_type: entityType,
      entity_id: entityId,
      details: { before, after },
      source: "ownership-writer",
    })).catch(() => { /* non-blocking */ });
  }

  return { ownerIds: after, defaultedToSelf, changed: true };
}
