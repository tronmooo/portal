// ── Bulk actions: preview → confirm → execute ────────────────────────────────
// Mirrors the finance-import discipline: planBulkAction is a pure dry-run
// (derives the affected set, NO writes except persisting the plan row);
// executeBulkPlan RE-DERIVES the set server-side and refuses on drift (hash
// mismatch ⇒ plan expires, fresh preview returned) so a stale confirmation
// can never delete rows the user didn't see. Every execution writes one
// ai_action_log row with a restore_set reverse plan (soft-deleted rows are
// undoable; hard-deleted types are reported honestly as unrecoverable).
import { createHash } from "crypto";
import type { IStorage } from "./storage";
import { getEntityList, getEntityName, deleteEntityById, SOFT_DELETE_TYPES, BULK_ENTITY_TYPES } from "./ai-envelope";
import { passesProfileFilter } from "../shared/profile-filter";

export interface BulkCriteria {
  operation: "delete";
  /** Entity types to scan. Omit ⇒ the common content types (not profiles). */
  entity_types?: string[];
  /** Scope to records owned by this profile (name, resolved server-side). */
  profile_name?: string;
  /** Case-insensitive substring the record's name/title must contain. */
  name_contains?: string;
  /** Only records dated before this date (YYYY-MM-DD, exclusive) — the
   *  record's OWN date (an expense's date, a task's due date, an event's
   *  date), falling back to when it was created. */
  before_date?: string;
  /** Only records dated on/after this date (YYYY-MM-DD, inclusive). */
  after_date?: string;
  /** Only records dated exactly this date (YYYY-MM-DD). "From today" is
   *  on_date=today — it used to have no expressible form, so the model fell
   *  back to a name filter and deleted yesterday's rows too. */
  on_date?: string;
  /** Also delete the profile itself (full cascade) after its records. */
  include_profile?: boolean;
}

export interface BulkPlanRow {
  id: string;
  operation: string;
  criteria: BulkCriteria;
  planHash: string;
  preview: { counts: Record<string, number>; samples: string[]; total: number };
  status: string;
  expiresAt: string;
}

const PLAN_TTL_MS = 15 * 60_000;
// Profiles are deliberately NOT in the default sweep — deleting profiles is
// only reachable via include_profile (single profile) to keep the blast
// radius understandable.
const DEFAULT_TYPES = BULK_ENTITY_TYPES.filter((t) => t !== "profile" && t !== "obligation");

function normalize(s: string): string {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hashIds(idsByType: Record<string, string[]>): string {
  const flat = Object.entries(idsByType)
    .flatMap(([t, ids]) => ids.map((id) => `${t}:${id}`))
    .sort()
    .join("|");
  return createHash("sha256").update(flat).digest("hex").slice(0, 32);
}

/**
 * The date a record is ABOUT, as YYYY-MM-DD: an expense's/income's/journal
 * entry's date, an event's date, a task's due date; else when it was created.
 * Date bounds in a bulk delete apply to this, not to the row's creation time —
 * "delete my expenses from before June" means June's expenses, whenever they
 * were typed in.
 */
export function entityDate(type: string, r: any): string {
  const t = normalize(type);
  const own =
    t === "task" ? (r.dueDate ?? null)
    : t === "event" ? (r.date ?? null)
    : (r.date ?? r.paymentDate ?? r.dueDate ?? null);
  const raw = own ?? r.createdAt ?? r.timestamp ?? "";
  const s = String(raw || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

/** The co-ownership tables, so "Linda's" reaches the car and loan she half-owns. */
async function ownershipLinks(storage: IStorage): Promise<{ assetPartyLinks: any[]; liabilityProfileLinks: any[] }> {
  const [assetPartyLinks, liabilityProfileLinks] = await Promise.all([
    Promise.resolve((storage as any).getAssetPartyLinks?.()).catch(() => []),
    Promise.resolve((storage as any).getLiabilityProfileLinks?.()).catch(() => []),
  ]);
  return { assetPartyLinks: Array.isArray(assetPartyLinks) ? assetPartyLinks : [], liabilityProfileLinks: Array.isArray(liabilityProfileLinks) ? liabilityProfileLinks : [] };
}

/** Derive the affected id set for the criteria. Pure read. */
export async function deriveBulkSet(
  storage: IStorage,
  criteria: BulkCriteria,
): Promise<{ idsByType: Record<string, string[]>; namesByType: Record<string, string[]>; profileId?: string; error?: string }> {
  const types = (criteria.entity_types?.length ? criteria.entity_types : DEFAULT_TYPES)
    .map(normalize).filter((t) => BULK_ENTITY_TYPES.includes(t));
  if (types.length === 0) return { idsByType: {}, namesByType: {}, error: "No valid entity types to scan." };

  let profileId: string | undefined;
  let profiles: any[] = [];
  if (criteria.profile_name) {
    profiles = await storage.getProfiles();
    const needle = normalize(criteria.profile_name);
    const match = profiles.find((p: any) => normalize(p.name) === needle)
      || profiles.find((p: any) => normalize(p.name).includes(needle));
    if (!match) return { idsByType: {}, namesByType: {}, error: `No profile found matching "${criteria.profile_name}".` };
    profileId = match.id;
  }

  const needle = criteria.name_contains ? normalize(criteria.name_contains) : "";
  const before = criteria.before_date ? String(criteria.before_date).slice(0, 10) : "";
  const after = criteria.after_date ? String(criteria.after_date).slice(0, 10) : "";
  const on = criteria.on_date ? String(criteria.on_date).slice(0, 10) : "";
  const idsByType: Record<string, string[]> = {};
  const namesByType: Record<string, string[]> = {};

  for (const type of types) {
    const listP = getEntityList(storage, type);
    if (!listP) continue;
    let rows: any[] = [];
    try { rows = await listP; } catch { continue; }
    const filterCtx = profileId && profiles.length
      ? { selectedIds: [profileId], allProfiles: profiles, ...(await ownershipLinks(storage)) }
      : null;
    const hits = rows.filter((r: any) => {
      if (needle && !normalize(getEntityName(type, r)).includes(needle)) return false;
      if (before || after || on) {
        const d = entityDate(type, r);
        if (!d) return false;
        if (before && d >= before) return false;
        if (after && d < after) return false;
        if (on && d !== on) return false;
      }
      if (filterCtx && !passesProfileFilter(r.linkedProfiles || [], filterCtx as any)) return false;
      return true;
    });
    if (hits.length > 0) {
      idsByType[type] = hits.map((r: any) => r.id);
      namesByType[type] = hits.slice(0, 5).map((r: any) => getEntityName(type, r)).filter(Boolean);
    }
  }
  return { idsByType, namesByType, profileId };
}

/** Phase 1: derive + persist the plan; returns the human preview. NO deletes. */
export async function planBulkAction(storage: IStorage, criteria: BulkCriteria): Promise<any> {
  if (criteria.operation !== "delete") return { error: `Unsupported bulk operation "${criteria.operation}".` };
  if (!criteria.name_contains && !criteria.profile_name && !criteria.before_date && !criteria.after_date && !criteria.on_date) {
    return { error: "Refusing an unbounded bulk delete — give me a name filter, a profile, or a date cutoff." };
  }
  const { idsByType, namesByType, profileId, error } = await deriveBulkSet(storage, criteria);
  if (error) return { error };
  const counts = Object.fromEntries(Object.entries(idsByType).map(([t, ids]) => [t, ids.length]));
  const total = Object.values(counts).reduce((s, n) => s + n, 0) + (criteria.include_profile && profileId ? 1 : 0);
  if (total === 0) return { error: "Nothing matches those criteria — there is nothing to delete." };

  const preview = {
    counts,
    samples: Object.values(namesByType).flat().slice(0, 10),
    total,
    ...(criteria.include_profile && profileId ? { profile_cascade: criteria.profile_name } : {}),
  };
  const row = await storage.createAiBulkPlan({
    operation: "delete",
    criteria,
    planHash: hashIds(idsByType),
    preview,
    expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
  });
  return {
    plan_id: row.id,
    preview,
    expires_at: row.expiresAt,
    message: `Bulk delete preview: ${total} record${total === 1 ? "" : "s"} (${Object.entries(counts).map(([t, n]) => `${n} ${t}${n === 1 ? "" : "s"}`).join(", ")}${preview.profile_cascade ? ` + the "${preview.profile_cascade}" profile itself` : ""}). Nothing has been deleted — confirm to proceed (plan expires in 15 minutes).`,
  };
}

/** Phase 2: re-derive, check drift, execute. planId omitted ⇒ the newest
 *  pending plan (chat history is text-only between turns, so the model may
 *  not have the id on the confirmation turn). */
export async function executeBulkPlan(storage: IStorage, planId?: string): Promise<any> {
  const plan = planId
    ? await storage.getAiBulkPlan(planId)
    : await storage.getLatestPendingAiBulkPlan();
  if (!plan) {
    return { error: planId
      ? "That bulk plan doesn't exist (or belongs to another account)."
      : "No pending bulk delete to confirm — run the preview first." };
  }
  if (plan.status !== "pending") return { error: `That plan was already ${plan.status}.` };
  if (new Date(plan.expiresAt).getTime() < Date.now()) {
    await storage.setAiBulkPlanStatus(plan.id, "expired");
    return { error: "That plan expired (15 min limit). Run the preview again." };
  }
  planId = plan.id;

  // Non-delete operations dispatch to their own executor (same plan table,
  // same drift discipline).
  if (plan.operation === "merge_profiles") {
    const { executeMergeProfiles } = await import("./merge-profiles");
    return executeMergeProfiles(storage, plan as any);
  }
  if (plan.operation !== "delete") {
    return { error: `Unknown bulk operation "${plan.operation}".` };
  }

  const criteria: BulkCriteria = plan.criteria;
  const { idsByType, profileId, error } = await deriveBulkSet(storage, criteria);
  if (error) return { error };
  const freshHash = hashIds(idsByType);
  if (freshHash !== plan.planHash) {
    await storage.setAiBulkPlanStatus(planId, "expired");
    const counts = Object.fromEntries(Object.entries(idsByType).map(([t, ids]) => [t, ids.length]));
    return {
      error: `The data changed since the preview — the plan was cancelled for safety. Fresh match: ${JSON.stringify(counts)}. Run the preview again to re-confirm.`,
    };
  }

  const deleted: Record<string, number> = {};
  const failed: Record<string, number> = {};
  const softDeletedIds: Record<string, string[]> = {};
  for (const [type, ids] of Object.entries(idsByType)) {
    for (const id of ids) {
      try {
        const ok = await deleteEntityById(storage, type, id);
        if (ok) {
          deleted[type] = (deleted[type] || 0) + 1;
          if (SOFT_DELETE_TYPES.has(type)) (softDeletedIds[type] ||= []).push(id);
        } else failed[type] = (failed[type] || 0) + 1;
      } catch { failed[type] = (failed[type] || 0) + 1; }
    }
  }
  let profileCascade = false;
  if (criteria.include_profile && profileId) {
    try { await storage.deleteProfile(profileId); profileCascade = true; }
    catch { failed.profile = (failed.profile || 0) + 1; }
  }

  await storage.setAiBulkPlanStatus(planId, "executed", { affected: idsByType, executedAt: new Date().toISOString() });

  // One ledger row for the whole bulk — soft-deleted rows are undoable.
  const totalDeleted = Object.values(deleted).reduce((s, n) => s + n, 0) + (profileCascade ? 1 : 0);
  const hardTypes = Object.keys(deleted).filter((t) => !SOFT_DELETE_TYPES.has(t));
  try {
    await storage.createAiActionLog({
      tool: "execute_bulk_action",
      actionType: "delete_entity",
      entityType: "bulk",
      entityId: planId,
      entityName: `bulk delete (${totalDeleted} records)`,
      input: criteria as any,
      reversible: Object.keys(softDeletedIds).length > 0,
      reversePlan: Object.keys(softDeletedIds).length > 0
        ? { op: "restore_set", ids: softDeletedIds, ...(hardTypes.length ? { note: `${hardTypes.join(", ")} deletes are permanent` } : {}) }
        : { op: "none", reason: "all affected types are hard-deleted" },
      source: "bulk",
    });
  } catch { /* ledger is best-effort */ }

  return {
    executed: true,
    deleted,
    ...(Object.keys(failed).length ? { failed } : {}),
    ...(profileCascade ? { profile_deleted: criteria.profile_name } : {}),
    total: totalDeleted,
    message: `Deleted ${totalDeleted} record${totalDeleted === 1 ? "" : "s"}${profileCascade ? ` including the "${criteria.profile_name}" profile` : ""}.${hardTypes.length ? ` Note: ${hardTypes.join(", ")} deletions are permanent.` : " This can be undone."}`,
  };
}
