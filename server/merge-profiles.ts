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

/**
 * A co-ownership share the source holds (asset_party_links /
 * liability_profile_links). Merging used to leave these rows pointing at the
 * archived source: the target lost Linda's half of the car, the dead share
 * kept counting toward the asset's 100%, and the ownership editor showed an
 * owner that no longer existed.
 */
export interface MovedShare {
  table: "asset_party_links" | "liability_profile_links";
  /** The source's link row. */
  id: string;
  /** The asset or liability the share is on. */
  subjectId: string;
  pct: number;
  role?: string;
  /** The target's own link on the same subject, if any — shares are summed into it. */
  mergeIntoId?: string;
  mergeIntoPct?: number;
}

/** A budget month touched by the merge: entries re-pointed to the target and
 *  entries dropped because the target already budgets that category. */
export interface MovedBudgets {
  month: string;
  movedIds: string[];
  dropped: Array<{ id: string; category: string; amount: number; notes?: string; profileId?: string }>;
}

interface MergeSet {
  /** entityType → rows { id, links } whose linked_profiles include the source */
  affected: Record<string, Array<{ id: string; links: string[] }>>;
  childIds: string[];
  /** Co-ownership shares held by the source (see MovedShare). */
  shares: MovedShare[];
  /** entity_links rows naming the source on one side (relationship graph). */
  entityLinks: Array<{ id: string; side: "source" | "target" }>;
  /** tracker_entries logged FOR the source (profile_id). */
  trackerEntryIds: string[];
  /** Per-person budgets of the source, by month. */
  budgets: MovedBudgets[];
}

function hashMergeSet(set: MergeSet): string {
  const flat = [
    ...Object.entries(set.affected).flatMap(([t, rows]) => rows.map((r) => `${t}:${r.id}`)),
    ...set.childIds.map((id) => `child:${id}`),
    ...(set.shares || []).map((sh) => `share:${sh.table}:${sh.id}:${sh.pct}:${sh.mergeIntoId || ""}:${sh.mergeIntoPct ?? ""}`),
    ...(set.entityLinks || []).map((l) => `el:${l.id}:${l.side}`),
    ...(set.trackerEntryIds || []).map((id) => `te:${id}`),
    ...(set.budgets || []).flatMap((b) => [...b.movedIds.map((id) => `budget:${b.month}:${id}`), ...b.dropped.map((d) => `budget-drop:${b.month}:${d.id}`)]),
  ].sort().join("|");
  return createHash("sha256").update(flat).digest("hex").slice(0, 32);
}

async function deriveMergeSet(storage: IStorage, sourceId: string, targetId?: string): Promise<MergeSet> {
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
  const shares = await deriveShares(storage, sourceId, targetId);
  const { entityLinks, trackerEntryIds } = await deriveProfileRefs(storage, sourceId);
  const budgets = await deriveBudgets(storage, sourceId, targetId);
  return { affected, childIds, shares, entityLinks, trackerEntryIds, budgets };
}

const chunks = <T,>(arr: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/** Rows that name the source by id outside linked_profiles: the relationship
 *  graph (entity_links) and entries logged FOR the person (tracker_entries). */
async function deriveCaptureIds(storage: IStorage, sourceId: string): Promise<string[]> {
  const sb = (storage as any).supabase;
  if (!sb?.from) return [];
  try {
    const { data } = await sb.from("captures").select("id").eq("user_id", (storage as any).userId).eq("owner_profile_id", sourceId).limit(5000);
    return (data || []).map((r: any) => String(r.id));
  } catch { return []; }
}

async function deriveProfileRefs(storage: IStorage, sourceId: string): Promise<{ entityLinks: MergeSet["entityLinks"]; trackerEntryIds: string[] }> {
  const sb = (storage as any).supabase;
  const userId = (storage as any).userId as string;
  const entityLinks: MergeSet["entityLinks"] = [];
  let trackerEntryIds: string[] = [];
  if (!sb || !userId) return { entityLinks, trackerEntryIds };
  try {
    const { data } = await sb.from("entity_links").select("id, source_type, source_id, target_type, target_id").eq("user_id", userId)
      .or(`and(source_type.eq.profile,source_id.eq.${sourceId}),and(target_type.eq.profile,target_id.eq.${sourceId})`);
    for (const r of (data || []) as any[]) {
      if (r.source_type === "profile" && r.source_id === sourceId) entityLinks.push({ id: r.id, side: "source" });
      else if (r.target_type === "profile" && r.target_id === sourceId) entityLinks.push({ id: r.id, side: "target" });
    }
  } catch { /* best effort — the merge still moves everything else */ }
  try {
    const { data } = await sb.from("tracker_entries").select("id").eq("user_id", userId).eq("profile_id", sourceId).limit(5000);
    trackerEntryIds = ((data || []) as any[]).map((r) => r.id).filter((id) => typeof id === "string");
  } catch { /* best effort */ }
  return { entityLinks, trackerEntryIds };
}

/** The source's per-person budgets. A category the target already budgets
 *  that month keeps the target's cap (like fields); the source's is dropped. */
async function deriveBudgets(storage: IStorage, sourceId: string, targetId?: string): Promise<MovedBudgets[]> {
  const out: MovedBudgets[] = [];
  let all: Record<string, any[]> = {};
  try { all = (await (storage as any).getAllBudgets?.()) || {}; } catch { return out; }
  for (const [month, arr] of Object.entries(all)) {
    if (!Array.isArray(arr)) continue;
    const targetCats = new Set(arr.filter((b: any) => targetId && b?.profileId === targetId).map((b: any) => norm(b.category)));
    const mine = arr.filter((b: any) => b?.profileId === sourceId && typeof b.id === "string");
    if (mine.length === 0) continue;
    const movedIds = mine.filter((b: any) => !targetCats.has(norm(b.category))).map((b: any) => b.id);
    const dropped = mine.filter((b: any) => targetCats.has(norm(b.category)));
    out.push({ month, movedIds, dropped });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function deriveShares(storage: IStorage, sourceId: string, targetId?: string): Promise<MovedShare[]> {
  const s: any = storage;
  const [assetLinks, liabLinks] = await Promise.all([
    Promise.resolve(s.getAssetPartyLinks?.()).catch(() => []),
    Promise.resolve(s.getLiabilityProfileLinks?.()).catch(() => []),
  ]);
  const out: MovedShare[] = [];
  const collect = (rows: any[], table: MovedShare["table"], subjectKey: string) => {
    for (const l of Array.isArray(rows) ? rows : []) {
      if (!l || l.partyProfileId !== sourceId || typeof l.id !== "string") continue;
      const subjectId = String(l[subjectKey] || "");
      if (!subjectId) continue;
      const existing = targetId
        ? (rows as any[]).find((o) => o && o.id !== l.id && o.partyProfileId === targetId && String(o[subjectKey] || "") === subjectId)
        : undefined;
      out.push({
        table, id: l.id, subjectId, pct: Number(l.ownershipPercentage ?? 100) || 0, role: l.role || undefined,
        ...(existing ? { mergeIntoId: existing.id, mergeIntoPct: Number(existing.ownershipPercentage ?? 100) || 0 } : {}),
      });
    }
  };
  collect(assetLinks, "asset_party_links", "assetProfileId");
  collect(liabLinks, "liability_profile_links", "liabilityProfileId");
  return out;
}

function resolveProfile(profiles: any[], name: string): any | undefined {
  const needle = norm(name);
  return profiles.find((p: any) => norm(p.name) === needle)
    || profiles.find((p: any) => norm(p.name).includes(needle));
}

const refsCount = (set: MergeSet) => set.entityLinks.length + set.trackerEntryIds.length + set.budgets.reduce((n, b) => n + b.movedIds.length + b.dropped.length, 0);

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

  const set = await deriveMergeSet(storage, source.id, target.id);
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
    shares_moved: set.shares.length,
    references_moved: set.entityLinks.length + set.trackerEntryIds.length + set.budgets.reduce((n, b) => n + b.movedIds.length + b.dropped.length, 0),
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
    message: `Merge preview: "${source.name}" → "${target.name}" will re-point ${total} record${total === 1 ? "" : "s"}${set.childIds.length ? ` and move ${set.childIds.length} child profile${set.childIds.length === 1 ? "" : "s"}` : ""}${set.shares.length ? ` and move ${set.shares.length} ownership share${set.shares.length === 1 ? "" : "s"} (co-owned assets/loans)` : ""}${refsCount(set) ? ` and re-point ${refsCount(set)} linked record${refsCount(set) === 1 ? "" : "s"} (relationships, entries logged for them, budgets)` : ""}, then archive "${source.name}" (its empty fields fill from the target's are kept; conflicting fields keep the target's values). Nothing has been changed — confirm to proceed (15 min).`,
  };
}

/** Phase 2 (called from executeBulkPlan dispatch): re-derive, drift-check, merge. */
export async function executeMergeProfiles(storage: IStorage, plan: { id: string; criteria: MergeCriteria; planHash: string }): Promise<any> {
  const { source_id, target_id, source_name, target_name } = plan.criteria;
  const set = await deriveMergeSet(storage, source_id, target_id);
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

  // 2b. Move the source's co-ownership shares onto the target. A share the
  //     target already holds on the same asset/loan absorbs the source's
  //     (delete first so the per-subject 100% guard never sees both rows).
  let sharesMoved = 0;
  for (const sh of set.shares) {
    try {
      if (sh.mergeIntoId) {
        const { error: e1 } = await sb.from(sh.table).delete().eq("id", sh.id).eq("user_id", userId);
        if (e1) continue;
        const { error: e2 } = await sb.from(sh.table)
          .update({ ownership_percentage: Math.min(100, round2((sh.mergeIntoPct || 0) + sh.pct)) })
          .eq("id", sh.mergeIntoId).eq("user_id", userId);
        if (!e2) sharesMoved++;
      } else {
        const { error } = await sb.from(sh.table).update({ party_profile_id: target_id }).eq("id", sh.id).eq("user_id", userId);
        if (!error) sharesMoved++;
      }
    } catch { /* counted as not moved */ }
  }

  // 2c. Re-point the rows that name the source by id outside linked_profiles.
  let refsMoved = 0;
  for (const l of set.entityLinks) {
    try {
      const col = l.side === "source" ? "source_id" : "target_id";
      const { error } = await sb.from("entity_links").update({ [col]: target_id }).eq("id", l.id).eq("user_id", userId);
      if (!error) refsMoved++;
    } catch { /* counted as not moved */ }
  }
  for (const chunk of chunks(set.trackerEntryIds, 200)) {
    try {
      const { error } = await sb.from("tracker_entries").update({ profile_id: target_id }).in("id", chunk).eq("user_id", userId);
      if (!error) refsMoved += chunk.length;
    } catch { /* counted as not moved */ }
  }
  // Captures the source owned follow it to the target (and come back on
  // unmerge); they used to stay pointed at the archived source, out of every
  // scope.
  const captureIds = await deriveCaptureIds(storage, source_id);
  for (const chunk of chunks(captureIds, 200)) {
    try {
      const { error } = await sb.from("captures").update({ owner_profile_id: target_id }).in("id", chunk).eq("user_id", userId);
      if (!error) refsMoved += chunk.length;
    } catch { /* counted as not moved */ }
  }
  for (const b of set.budgets) {
    try {
      const arr: any[] = await (storage as any).getBudgets(b.month);
      const moved = new Set(b.movedIds);
      const dropped = new Set(b.dropped.map((d) => d.id));
      const next = arr.filter((x) => !dropped.has(x.id)).map((x) => (moved.has(x.id) ? { ...x, profileId: target_id } : x));
      await (storage as any).setBudgets(b.month, next);
      refsMoved += b.movedIds.length + b.dropped.length;
    } catch { /* counted as not moved */ }
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
    affected: { relinked, childrenMoved, filledFields, sharesMoved, refsMoved },
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
      before: { affected: set.affected, childIds: set.childIds, shares: set.shares, entityLinks: set.entityLinks, trackerEntryIds: set.trackerEntryIds, budgets: set.budgets } as any,
      reversible: !big,
      reversePlan: big
        ? { op: "none", reason: `merge touched ${totalRelinked} records — undo is best-effort only, ask to re-merge manually` }
        : { op: "unmerge", source_id, target_id, affected: set.affected, child_ids: set.childIds, shares: set.shares, entity_links: set.entityLinks, tracker_entry_ids: set.trackerEntryIds, capture_ids: captureIds, budgets: set.budgets },
      source: "bulk",
    });
  } catch { /* ledger is best-effort */ }

  // Ownership moved on every affected table — invalidate everything.
  await reportMergeWrite(storage, "mergeProfiles", [source_id, target_id], { id: target_id, relinked, childrenMoved });

  return {
    executed: true,
    merged: { relinked, children_moved: childrenMoved, fields_filled: filledFields, shares_moved: sharesMoved, references_moved: refsMoved },
    ...(totalFailed > 0 ? { failed } : {}),
    source_archived: !delErr,
    message: `Merged "${source_name}" into "${target_name}": ${totalRelinked} record${totalRelinked === 1 ? "" : "s"} re-pointed${childrenMoved ? `, ${childrenMoved} child profile${childrenMoved === 1 ? "" : "s"} moved` : ""}${sharesMoved ? `, ${sharesMoved} ownership share${sharesMoved === 1 ? "" : "s"} moved` : ""}${refsMoved ? `, ${refsMoved} linked record${refsMoved === 1 ? "" : "s"} re-pointed` : ""}${filledFields.length ? `, ${filledFields.length} empty field${filledFields.length === 1 ? "" : "s"} filled from "${source_name}"` : ""}. "${source_name}" was archived (soft-deleted)${big ? "" : " — this can be undone"}.${totalFailed ? ` ${totalFailed} record(s) failed to re-point.` : ""}`,
  };
}

/** Reverse a merge: restore the source profile, re-point links back, move children back. */
export async function reverseMerge(storage: IStorage, reversePlan: { source_id: string; target_id: string; affected: MergeSet["affected"]; child_ids: string[]; shares?: MovedShare[]; entity_links?: MergeSet["entityLinks"]; tracker_entry_ids?: string[]; capture_ids?: string[]; budgets?: MovedBudgets[] }): Promise<{ ok: boolean; description: string }> {
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

  // Give the source its co-ownership shares back (the mirror of step 2b).
  let sharesRestored = 0;
  for (const sh of reversePlan.shares || []) {
    try {
      if (sh.mergeIntoId) {
        const { error: e1 } = await sb.from(sh.table).update({ ownership_percentage: sh.mergeIntoPct ?? 0 })
          .eq("id", sh.mergeIntoId).eq("user_id", userId);
        if (e1) { failed++; continue; }
        const subjectCol = sh.table === "asset_party_links" ? "asset_profile_id" : "liability_profile_id";
        const row: Record<string, any> = { id: sh.id, user_id: userId, [subjectCol]: sh.subjectId, party_profile_id: reversePlan.source_id, ownership_percentage: sh.pct };
        if (sh.table === "asset_party_links") row.role = sh.role || "co_owner";
        const { error: e2 } = await sb.from(sh.table).insert(row);
        if (e2) failed++; else sharesRestored++;
      } else {
        const { error } = await sb.from(sh.table).update({ party_profile_id: reversePlan.source_id }).eq("id", sh.id).eq("user_id", userId);
        if (error) failed++; else sharesRestored++;
      }
    } catch { failed++; }
  }

  // Same fan-out as the merge itself: every owned table moved back.
  // And the rows that named the target only because of the merge.
  let refsRestored = 0;
  for (const l of reversePlan.entity_links || []) {
    try {
      const col = l.side === "source" ? "source_id" : "target_id";
      const { error } = await sb.from("entity_links").update({ [col]: reversePlan.source_id }).eq("id", l.id).eq("user_id", userId);
      if (error) failed++; else refsRestored++;
    } catch { failed++; }
  }
  for (const chunk of chunks(reversePlan.tracker_entry_ids || [], 200)) {
    try {
      const { error } = await sb.from("tracker_entries").update({ profile_id: reversePlan.source_id }).in("id", chunk).eq("user_id", userId);
      if (error) failed++; else refsRestored += chunk.length;
    } catch { failed++; }
  }
  for (const chunk of chunks(reversePlan.capture_ids || [], 200)) {
    try {
      const { error } = await sb.from("captures").update({ owner_profile_id: reversePlan.source_id }).in("id", chunk).eq("user_id", userId);
      if (error) failed++; else refsRestored += chunk.length;
    } catch { failed++; }
  }
  for (const b of reversePlan.budgets || []) {
    try {
      const arr: any[] = await (storage as any).getBudgets(b.month);
      const moved = new Set(b.movedIds);
      const present = new Set(arr.map((x) => x.id));
      const next = [
        ...arr.map((x) => (moved.has(x.id) ? { ...x, profileId: reversePlan.source_id } : x)),
        ...b.dropped.filter((d) => !present.has(d.id)).map((d) => ({ ...d, profileId: reversePlan.source_id })),
      ];
      await (storage as any).setBudgets(b.month, next);
      refsRestored += b.movedIds.length + b.dropped.length;
    } catch { failed++; }
  }

  await reportMergeWrite(storage, "unmergeProfiles", [reversePlan.source_id, reversePlan.target_id], { id: reversePlan.source_id, relinked });

  return {
    ok: failed === 0,
    description: `restored the source profile and re-pointed ${relinked} record(s) back${sharesRestored ? ` with ${sharesRestored} ownership share(s)` : ""}${refsRestored ? ` and ${refsRestored} linked record(s)` : ""}${failed ? ` (${failed} failed)` : ""}`,
  };
}
