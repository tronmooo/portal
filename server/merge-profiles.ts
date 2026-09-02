// ── merge_profiles: preview → confirm → execute ──────────────────────────────
// Highest data-loss-risk operation in the chat, so it ALWAYS rides the
// ai_bulk_plans machinery (operation 'merge_profiles'): planMergeProfiles is
// a pure dry-run that persists the plan; execute_bulk_action re-derives the
// affected set and refuses on drift. Execution:
//   1. re-point every record's linked_profiles source → target through
//      setOwners (the single ownership writer — junction + audit for free)
//   2. move child profiles (parent_profile_id) onto the target
//   3. fill-empty-only merge of the source profile's fields into the target
//   4. SOFT-delete the source (deleted_at directly — deleteProfile would
//      cascade onto records we just re-pointed)
// The ai_action_log row stores per-record prior links, so undo restores the
// source and re-points everything back.
import { createHash } from "crypto";
import type { IStorage } from "./storage";
import { setOwners } from "./ownership-writer";
import { OWNERSHIP_TABLES, type OwnedEntityType } from "../shared/ownership";
import { selfIdsFrom } from "../shared/scope";
import { journalStorageCall, writeJournalContext } from "./write-journal";

/**
 * Tell the caches what a merge did. The merge writes raw supabase rows
 * (setOwners, profiles.update) that the storage proxy's write journal never
 * sees, so before this only the ai_bulk_plans/ai_action_log bookkeeping was
 * recorded — the "dashboard" domain — and every shared response cache
 * (expenses:, tasks:, trackers:, caltimeline:, …) kept serving the pre-merge
 * ownership. A merge touches every owned table, so it is reported to the
 * request's journal as `mergeProfiles` (→ "everything", see
 * shared/storage-domains STORAGE_METHOD_TARGETS), which both bumps the
 * account-wide epoch and puts "everything" in the client manifest. Outside a
 * request (no journal — a script, a cron job) the epoch is bumped directly.
 */
async function reportMergeWrite(storage: IStorage, method: "mergeProfiles" | "unmergeProfiles", args: unknown[], result: unknown): Promise<void> {
  if (writeJournalContext.getStore()) {
    journalStorageCall(method, args, result);
    return;
  }
  try {
    const s = storage as any;
    // An empty domain list is the RPC's "move the epoch" (bumpDataVersionNow).
    if (typeof s.bumpDataVersions === "function") await s.bumpDataVersions([]);
    else if (typeof s.bumpDataVersion === "function") await s.bumpDataVersion();
  } catch { /* best effort — the next request resolves versions from the DB */ }
}

const norm =(s: any) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Entity lists that carry linkedProfiles, keyed by OWNERSHIP_TABLES type.
const LIST_BY_TYPE: Record<OwnedEntityType, (s: IStorage) => Promise<any[]>> = {
  expense: (s) => s.getExpenses(),
  tracker: (s) => s.getTrackers(),
  task: (s) => s.getTasks(),
  event: (s) => s.getEvents(),
  obligation: (s) => s.getObligations(),
  habit: (s) => s.getHabits(),
  goal: (s) => s.getGoals(),
  artifact: (s) => s.getArtifacts(),
  document: (s) => s.getDocuments(),
  income: (s) => s.getIncomes(),
  journal_entry: (s) => s.getJournalEntries(),
};

export interface MergeCriteria {
  operation: "merge_profiles";
  source_name: string;
  target_name: string;
  source_id: string;
  target_id: string;
}

interface MergeSet {
  /** entityType → rows { id, links } whose linked_profiles include the source */
  affected: Record<string, Array<{ id: string; links: string[] }>>;
  childIds: string[];
}

function hashMergeSet(set: MergeSet): string {
  const flat = [
    ...Object.entries(set.affected).flatMap(([t, rows]) => rows.map((r) => `${t}:${r.id}`)),
    ...set.childIds.map((id) => `child:${id}`),
  ].sort().join("|");
  return createHash("sha256").update(flat).digest("hex").slice(0, 32);
}

async function deriveMergeSet(storage: IStorage, sourceId: string): Promise<MergeSet> {
  const affected: MergeSet["affected"] = {};
  for (const [type, list] of Object.entries(LIST_BY_TYPE)) {
    let rows: any[] = [];
    try { rows = await list(storage); } catch { continue; }
    const hits = rows
      .filter((r: any) => Array.isArray(r.linkedProfiles) && r.linkedProfiles.includes(sourceId))
      .map((r: any) => ({ id: r.id, links: [...r.linkedProfiles] }));
    if (hits.length > 0) affected[type] = hits;
  }
  const profiles = await storage.getProfiles();
  const childIds = profiles.filter((p: any) => p.parentProfileId === sourceId).map((p: any) => p.id);
  return { affected, childIds };
}

function resolveProfile(profiles: any[], name: string): any | undefined {
  const needle = norm(name);
  return profiles.find((p: any) => norm(p.name) === needle)
    || profiles.find((p: any) => norm(p.name).includes(needle));
}

/** Phase 1: dry-run + persist the plan. NO writes to user data. */
export async function planMergeProfiles(storage: IStorage, sourceName: string, targetName: string): Promise<any> {
  if (!sourceName || !targetName) return { error: "I need both profiles: merge WHICH profile INTO which?" };
  const profiles = await storage.getProfiles();
  const source = resolveProfile(profiles, sourceName);
  const target = resolveProfile(profiles, targetName);
  if (!source) return { error: `No profile found matching "${sourceName}".` };
  if (!target) return { error: `No profile found matching "${targetName}".` };
  if (source.id === target.id) return { error: "Source and target resolve to the same profile — nothing to merge." };
  if (source.type === "self") return { error: "Refusing to merge your self profile into another profile. Merge the other profile INTO your self profile instead." };

  const set = await deriveMergeSet(storage, source.id);
  const counts = Object.fromEntries(Object.entries(set.affected).map(([t, rows]) => [t, rows.length]));
  const total = Object.values(counts).reduce((s, n) => s + n, 0);

  const criteria: MergeCriteria = {
    operation: "merge_profiles",
    source_name: source.name, target_name: target.name,
    source_id: source.id, target_id: target.id,
  };
  const preview = {
    counts, total,
    child_profiles_moved: set.childIds.length,
    samples: Object.entries(set.affected).slice(0, 3).map(([t, rows]) => `${rows.length} ${t}${rows.length === 1 ? "" : "s"}`),
  };
  const row = await storage.createAiBulkPlan({
    operation: "merge_profiles",
    criteria,
    planHash: hashMergeSet(set),
    preview,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  return {
    plan_id: row.id,
    preview,
    message: `Merge preview: "${source.name}" → "${target.name}" will re-point ${total} record${total === 1 ? "" : "s"}${set.childIds.length ? ` and move ${set.childIds.length} child profile${set.childIds.length === 1 ? "" : "s"}` : ""}, then archive "${source.name}" (its empty fields fill from the target's are kept; conflicting fields keep the target's values). Nothing has been changed — confirm to proceed (15 min).`,
  };
}

/** Phase 2 (called from executeBulkPlan dispatch): re-derive, drift-check, merge. */
export async function executeMergeProfiles(storage: IStorage, plan: { id: string; criteria: MergeCriteria; planHash: string }): Promise<any> {
  const { source_id, target_id, source_name, target_name } = plan.criteria;
  const set = await deriveMergeSet(storage, source_id);
  if (hashMergeSet(set) !== plan.planHash) {
    await storage.setAiBulkPlanStatus(plan.id, "expired");
    return { error: "The data changed since the merge preview — the plan was cancelled for safety. Run the merge again to get a fresh preview." };
  }

  const sb = (storage as any).supabase;
  const userId = (storage as any).userId as string;
  if (!sb || !userId) return { error: "Merge isn't available in this deployment." };
  const profiles = await storage.getProfiles();
  const selfId = [...selfIdsFrom(profiles)][0] || target_id;

  // 1. Re-point ownership source → target via the single ownership writer.
  const relinked: Record<string, number> = {};
  const failed: Record<string, number> = {};
  for (const [type, rows] of Object.entries(set.affected)) {
    for (const row of rows) {
      const next = Array.from(new Set(row.links.map((id) => (id === source_id ? target_id : id))));
      try {
        await setOwners(sb, userId, type as OwnedEntityType, row.id, next, selfId);
        relinked[type] = (relinked[type] || 0) + 1;
      } catch { failed[type] = (failed[type] || 0) + 1; }
    }
  }

  // 2. Move child profiles onto the target.
  let childrenMoved = 0;
  for (const childId of set.childIds) {
    const { error } = await sb.from("profiles")
      .update({ parent_profile_id: target_id })
      .eq("id", childId).eq("user_id", userId);
    if (!error) childrenMoved++;
  }

  // 3. Fill-empty-only field merge (target keeps its own values on conflict).
  const source = profiles.find((p: any) => p.id === source_id);
  const target = profiles.find((p: any) => p.id === target_id);
  const filledFields: string[] = [];
  if (source?.fields && typeof source.fields === "object") {
    const merged: Record<string, any> = { ...(target?.fields || {}) };
    for (const [k, v] of Object.entries(source.fields)) {
      const cur = merged[k];
      if ((cur === undefined || cur === null || cur === "") && v !== undefined && v !== null && v !== "") {
        merged[k] = v;
        filledFields.push(k);
      }
    }
    if (filledFields.length > 0) {
      await sb.from("profiles").update({ fields: merged }).eq("id", target_id).eq("user_id", userId);
    }
  }

  // 4. Soft-delete the source DIRECTLY — deleteProfile would cascade onto the
  //    records we just re-pointed to the target.
  const { error: delErr } = await sb.from("profiles")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", source_id).eq("user_id", userId);

  await storage.setAiBulkPlanStatus(plan.id, "executed", {
    affected: { relinked, childrenMoved, filledFields },
    executedAt: new Date().toISOString(),
  });

  const totalRelinked = Object.values(relinked).reduce((s, n) => s + n, 0);
  const totalFailed = Object.values(failed).reduce((s, n) => s + n, 0);
  const big = totalRelinked > 500;
  try {
    await storage.createAiActionLog({
      tool: "merge_profiles",
      actionType: "update_entity",
      entityType: "profile",
      entityId: target_id,
      entityName: `merge "${source_name}" → "${target_name}"`,
      input: plan.criteria as any,
      before: { affected: set.affected, childIds: set.childIds } as any,
      reversible: !big,
      reversePlan: big
        ? { op: "none", reason: `merge touched ${totalRelinked} records — undo is best-effort only, ask to re-merge manually` }
        : { op: "unmerge", source_id, target_id, affected: set.affected, child_ids: set.childIds },
      source: "bulk",
    });
  } catch { /* ledger is best-effort */ }

  // Ownership moved on every affected table — invalidate everything.
  await reportMergeWrite(storage, "mergeProfiles", [source_id, target_id], { id: target_id, relinked, childrenMoved });

  return {
    executed: true,
    merged: { relinked, children_moved: childrenMoved, fields_filled: filledFields },
    ...(totalFailed > 0 ? { failed } : {}),
    source_archived: !delErr,
    message: `Merged "${source_name}" into "${target_name}": ${totalRelinked} record${totalRelinked === 1 ? "" : "s"} re-pointed${childrenMoved ? `, ${childrenMoved} child profile${childrenMoved === 1 ? "" : "s"} moved` : ""}${filledFields.length ? `, ${filledFields.length} empty field${filledFields.length === 1 ? "" : "s"} filled from "${source_name}"` : ""}. "${source_name}" was archived (soft-deleted)${big ? "" : " — this can be undone"}.${totalFailed ? ` ${totalFailed} record(s) failed to re-point.` : ""}`,
  };
}

/** Reverse a merge: restore the source profile, re-point links back, move children back. */
export async function reverseMerge(storage: IStorage, reversePlan: { source_id: string; target_id: string; affected: MergeSet["affected"]; child_ids: string[] }): Promise<{ ok: boolean; description: string }> {
  const sb = (storage as any).supabase;
  const userId = (storage as any).userId as string;
  if (!sb || !userId) return { ok: false, description: "Unmerge isn't available in this deployment." };

  // 1. Restore the source profile first so re-pointed links are valid.
  const restored = await storage.restoreEntity("profile", reversePlan.source_id);
  if (!restored) return { ok: false, description: "Couldn't restore the archived source profile — it may have been permanently deleted." };

  const profiles = await storage.getProfiles();
  const selfId = [...selfIdsFrom(profiles)][0] || reversePlan.source_id;

  // 2. Re-apply each record's ORIGINAL owner list from the snapshot.
  let relinked = 0, failed = 0;
  for (const [type, rows] of Object.entries(reversePlan.affected || {})) {
    for (const row of rows) {
      try { await setOwners(sb, userId, type as OwnedEntityType, row.id, row.links, selfId); relinked++; }
      catch { failed++; }
    }
  }

  // 3. Move children back.
  for (const childId of reversePlan.child_ids || []) {
    await sb.from("profiles").update({ parent_profile_id: reversePlan.source_id })
      .eq("id", childId).eq("user_id", userId);
  }

  // Same fan-out as the merge itself: every owned table moved back.
  await reportMergeWrite(storage, "unmergeProfiles", [reversePlan.source_id, reversePlan.target_id], { id: reversePlan.source_id, relinked });

  return {
    ok: failed === 0,
    description: `restored the source profile and re-pointed ${relinked} record(s) back${failed ? ` (${failed} failed)` : ""}`,
  };
}
