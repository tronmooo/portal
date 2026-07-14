// ── Tool-result envelope + post-write verification ──────────────────────────
// Wraps successful WRITE-tool results from the AI chat's processMessage loop
// in a standard envelope:
//
//   { success, action, action_type, message,
//     entity?: { type, id, name },
//     verification?: { database_record_exists?, duplicate_count?, profile_isolation_valid? },
//     ...rawResult }                       // raw spread LAST-IN wins nothing:
//                                          // envelope keys are additive; raw
//                                          // keys (id, task, _previousState…)
//                                          // all survive for the chat UI/undo.
//
// Design rules (see docs/ai-crud-parity.md effort + plan):
// - Wrapped ONLY at the processMessage choke point — executeTool's raw return
//   shapes are a contract for internal tool-to-tool delegation and the
//   test_ai_e2e/test_ai_render scripts.
// - Verification is cheap by construction: at most ONE fresh entity-list read
//   per write (fetched AFTER the write so it observes it — lists are per-user
//   and small) plus a per-turn memoized profile-id set. Entity types without a
//   mapping simply omit verification fields — omission means "not computed",
//   never "failed".
// - The envelope must NEVER break a tool: any error here returns the raw
//   result unchanged.
import type { IStorage } from "./storage";

export interface ToolVerification {
  /** Post-write read-back: the record is visible in the database (creates/
   *  updates) or gone (deletes). Omitted when no read-back mapping exists. */
  database_record_exists?: boolean;
  /** How many OTHER records of the same type share this record's normalized
   *  name/title. Reported, never enforced — duplicates are allowed. */
  duplicate_count?: number;
  /** Every profile id the record links to belongs to this user. */
  profile_isolation_valid?: boolean;
}

export interface TurnVerifyContext {
  storage: IStorage;
  /** Lazily fetched, memoized for the turn; refreshed after profile writes. */
  _profileIds: Set<string> | null;
}

export function buildTurnVerifyContext(storage: IStorage): TurnVerifyContext {
  return { storage, _profileIds: null };
}

async function profileIdSet(ctx: TurnVerifyContext, refresh = false): Promise<Set<string>> {
  if (!ctx._profileIds || refresh) {
    const profiles = await ctx.storage.getProfiles();
    ctx._profileIds = new Set(profiles.map((p: any) => p.id));
  }
  return ctx._profileIds;
}

// ── Entity metadata ──────────────────────────────────────────────────────────
type EntityMeta = {
  list: (s: IStorage) => Promise<any[]>;
  name: (row: any) => string;
  /** Rows the list returns include soft-deleted? (false everywhere today —
   *  get* methods filter deleted_at, which is exactly what "exists" means.) */
};

const ENTITY_META: Record<string, EntityMeta> = {
  task: { list: (s) => s.getTasks(), name: (r) => r.title },
  expense: { list: (s) => s.getExpenses(), name: (r) => r.description },
  income: { list: (s) => s.getIncomes(), name: (r) => r.description },
  event: { list: (s) => s.getEvents(), name: (r) => r.title },
  habit: { list: (s) => s.getHabits(), name: (r) => r.name },
  tracker: { list: (s) => s.getTrackers(), name: (r) => r.name },
  goal: { list: (s) => s.getGoals(), name: (r) => r.title },
  profile: { list: (s) => s.getProfiles(), name: (r) => r.name },
  obligation: { list: (s) => s.getObligations(), name: (r) => r.name },
  journal: { list: (s) => s.getJournalEntries(), name: (r) => String(r.content || "").slice(0, 40) },
  memory: { list: (s) => s.getMemories(), name: (r) => r.key },
  artifact: { list: (s) => s.getArtifacts(), name: (r) => r.title },
  reminder: { list: (s) => s.listReminders(), name: (r) => r.title },
  document: { list: (s) => s.getDocuments(), name: (r) => r.name },
  paycheck: { list: (s) => s.getPaychecks(), name: (r) => r.source },
};

/** Which entity a tool operates on. Tools absent from this map still get the
 *  envelope (success/action/message) but no verification. */
const TOOL_ENTITY: Record<string, string> = {
  create_task: "task", update_task: "task", complete_task: "task", delete_task: "task",
  restore_task: "task", bulk_complete_tasks: "task",
  create_expense: "expense", update_expense: "expense", delete_expense: "expense", refund_expense: "expense",
  log_income: "income", update_income: "income", delete_income: "income",
  create_event: "event", update_event: "event", delete_event: "event", complete_event: "event",
  create_habit: "habit", update_habit: "habit", delete_habit: "habit", restore_habit: "habit",
  checkin_habit: "habit", uncomplete_habit: "habit",
  create_tracker: "tracker", update_tracker: "tracker", delete_tracker: "tracker",
  create_goal: "goal", update_goal: "goal", delete_goal: "goal",
  create_profile: "profile", update_profile: "profile", delete_profile: "profile",
  create_liability: "profile", update_liability: "profile", revalue_asset: "profile",
  create_obligation: "obligation", update_obligation: "obligation", delete_obligation: "obligation",
  pay_obligation: "obligation", undo_last_payment: "obligation",
  journal_entry: "journal", update_journal: "journal", delete_journal: "journal",
  save_memory: "memory", update_memory: "memory", delete_memory: "memory",
  create_artifact: "artifact", update_artifact: "artifact", delete_artifact: "artifact",
  duplicate_artifact: "artifact", toggle_artifact_item: "artifact",
  create_reminder: "reminder", update_reminder: "reminder", delete_reminder: "reminder",
  create_document: "document",
  log_expected_paycheck: "paycheck", confirm_paycheck_received: "paycheck", delete_paycheck: "paycheck",
};

/** Operation class drives which verification checks run. */
export function classifyOperation(toolName: string): "create" | "update" | "delete" {
  if (/^(delete_|remove_)/.test(toolName)) return "delete";
  if (/^(create_|log_|add_|duplicate_|journal_entry$|save_memory$|upload_)/.test(toolName)) return "create";
  return "update"; // complete/checkin/pay/restore/toggle/link/set/copy/etc.
}

const normalizeName = (s: string): string =>
  String(s || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

function extractEntityId(result: any): string | undefined {
  return result?.id || result?.task?.id || result?.expense?.id || result?.habit?.id
    || result?.obligation?.id || result?.income?.id || result?.artifact?.id
    || result?.reminder?.id || result?.memory?.id || result?.payment?.id
    || result?.entity?.id;
}

const VERBS: Record<string, string> = { create: "Created", update: "Updated", delete: "Deleted" };

/** Entity types whose delete is a recoverable soft delete (deleted_at). */
export const SOFT_DELETE_TYPES = new Set([
  "task", "habit", "expense", "income", "event", "document", "reminder", "profile", "obligation",
]);

/**
 * Pre-write snapshot for update/delete tools: one entity-list read BEFORE the
 * tool executes, so the ledger can store `before` (updates → reapply_before
 * undo; hard deletes → recreate-from-snapshot undo). Creates skip this.
 * Returns null when the tool's entity type has no mapping.
 */
export async function captureBeforeRows(toolName: string, ctx: TurnVerifyContext): Promise<any[] | null> {
  try {
    if (classifyOperation(toolName) === "create") return null;
    const entityType = TOOL_ENTITY[toolName];
    const meta = entityType ? ENTITY_META[entityType] : undefined;
    if (!meta) return null;
    return await meta.list(ctx.storage);
  } catch {
    return null;
  }
}

/** Compute reversibility + a machine-readable reverse plan for the ledger. */
export function planReverse(
  op: "create" | "update" | "delete",
  entityType: string | undefined,
  entityId: string | undefined,
  before: any | null,
): { reversible: boolean; reversePlan?: Record<string, any> } {
  if (!entityType || !entityId) return { reversible: false };
  if (op === "create") {
    return { reversible: true, reversePlan: { op: "delete", soft: SOFT_DELETE_TYPES.has(entityType) } };
  }
  if (op === "delete") {
    if (SOFT_DELETE_TYPES.has(entityType)) return { reversible: true, reversePlan: { op: "restore" } };
    if (before) return { reversible: true, reversePlan: { op: "recreate", snapshot: before } };
    return { reversible: false, reversePlan: { op: "none", reason: "hard delete with no pre-delete snapshot" } };
  }
  // update-class ops
  if (before) return { reversible: true, reversePlan: { op: "reapply_before", before } };
  return { reversible: false, reversePlan: { op: "none", reason: "no before snapshot for this update" } };
}

/**
 * Persist one ai_action_log row for a successful write. Awaited with a soft
 * timeout (unawaited promises are unreliable on serverless); a failed log
 * write never fails the tool.
 */
export async function recordActionLog(
  ctx: TurnVerifyContext,
  toolName: string,
  actionType: string,
  input: Record<string, any>,
  envelope: any,
  beforeRows: any[] | null,
  source = "chat",
): Promise<void> {
  try {
    const op = classifyOperation(toolName);
    const entityType = TOOL_ENTITY[toolName];
    const entityId = envelope?.entity?.id || extractEntityId(envelope);
    const before = beforeRows && entityId ? (beforeRows.find((r: any) => r.id === entityId) ?? null) : null;
    let { reversible, reversePlan } = planReverse(op, entityType, entityId, before);
    // Preference-backed tools (dashboard layout, notification prefs) undo by
    // restoring the previous preference value the handler stashed.
    if (toolName === "configure_dashboard_sections") {
      reversible = true;
      reversePlan = { op: "set_preference", key: "dashboard_layout", value: envelope?._previousState?.layout ?? null };
    }
    if (toolName === "set_notification_preferences") {
      reversible = true;
      reversePlan = { op: "set_preference", key: "notification_prefs", value: envelope?._previousState?.prefs ?? "{}" };
    }
    const { __userMessage, ...inputSansMsg } = input || {};
    const write = ctx.storage.createAiActionLog({
      tool: toolName,
      actionType,
      entityType,
      entityId: entityId ? String(entityId) : undefined,
      entityName: envelope?.entity?.name || undefined,
      input: inputSansMsg,
      before: before || undefined,
      after: envelope?.entity || undefined,
      reversible,
      reversePlan,
      source,
    });
    await Promise.race([write, new Promise((r) => setTimeout(r, 750))]);
  } catch (e: any) {
    try { console.warn(`[ai-envelope] action log failed for ${toolName}:`, e?.message || e); } catch { /* noop */ }
  }
}

// ── Document extracted-field trimming ────────────────────────────────────────
/**
 * Model-facing view of a document's extractedData: scalar fields only,
 * bounded key count and value length, so the model can ANSWER questions like
 * "what's my license plate?" from a registration document without the token
 * cost of nested blobs or base64 junk. Returns undefined when nothing usable.
 */
export function trimExtractedFields(extracted: any, maxKeys = 30, maxValueLen = 120): Record<string, string> | undefined {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(extracted)) {
    if (n >= maxKeys) break;
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t !== "string" && t !== "number" && t !== "boolean") continue;
    const s = String(v).trim();
    if (!s || s.length > 2000) continue; // skip empties and blob-like values
    out[k] = s.slice(0, maxValueLen);
    n++;
  }
  return n > 0 ? out : undefined;
}

/**
 * Content match for document search: does the query hit the document's
 * extracted field KEYS or VALUES (scalars only)? Lets "policy number",
 * "8YPJ480", or "licensePlate" find the right document even when the
 * document's NAME doesn't contain the term.
 */
export function docContentMatches(extracted: any, queryLower: string): boolean {
  if (!queryLower) return false;
  const fields = trimExtractedFields(extracted, 60, 300);
  if (!fields) return false;
  const terms = queryLower.split(/\s+/).filter((t) => t.length >= 3);
  if (terms.length === 0) return false;
  const haystack = Object.entries(fields)
    .map(([k, v]) => `${k} ${v}`).join(" ").toLowerCase();
  if (terms.some((t) => haystack.includes(t))) return true;
  // Bidirectional token match: the query "Honda" must find make:"HOND" —
  // abbreviations on documents are routinely shorter than the user's word.
  const tokens = haystack.split(/[^a-z0-9-]+/).filter((k) => k.length >= 4);
  return terms.some((t) => t.length >= 4 && tokens.some((k) => t.includes(k) || k.includes(t)));
}

// ── Undo execution ───────────────────────────────────────────────────────────
type AnyStorage = IStorage & Record<string, any>;

const DELETE_FN: Record<string, (s: AnyStorage, id: string) => Promise<any>> = {
  task: (s, id) => s.deleteTask(id),
  expense: (s, id) => s.deleteExpense(id),
  income: (s, id) => s.deleteIncome(id),
  event: (s, id) => s.deleteEvent(id),
  habit: (s, id) => s.deleteHabit(id),
  reminder: (s, id) => s.deleteReminder(id),
  document: (s, id) => s.deleteDocument(id),
  profile: (s, id) => s.deleteProfile(id),
  obligation: (s, id) => s.deleteObligation(id),
  memory: (s, id) => s.deleteMemory(id),
  artifact: (s, id) => s.deleteArtifact(id),
  goal: (s, id) => s.deleteGoal(id),
  tracker: (s, id) => s.deleteTracker(id),
  journal: (s, id) => s.deleteJournalEntry(id),
  paycheck: (s, id) => s.deletePaycheck(id),
};

const UPDATE_FN: Record<string, (s: AnyStorage, id: string, data: any) => Promise<any>> = {
  task: (s, id, d) => s.updateTask(id, d),
  expense: (s, id, d) => s.updateExpense(id, d),
  income: (s, id, d) => s.updateIncome(id, d),
  event: (s, id, d) => s.updateEvent(id, d),
  habit: (s, id, d) => s.updateHabit(id, d),
  obligation: (s, id, d) => s.updateObligation(id, d),
  profile: (s, id, d) => s.updateProfile(id, d),
  goal: (s, id, d) => s.updateGoal(id, d),
  artifact: (s, id, d) => s.updateArtifact(id, d),
  memory: (s, id, d) => s.updateMemory(id, d),
  journal: (s, id, d) => s.updateJournalEntry(id, d),
  tracker: (s, id, d) => s.updateTracker(id, d),
};

const RECREATE_FN: Record<string, (s: AnyStorage, snapshot: any) => Promise<any>> = {
  goal: (s, snap) => s.createGoal(snap),
  memory: (s, snap) => s.saveMemory(snap),
  artifact: (s, snap) => s.createArtifact(snap),
  journal: (s, snap) => s.createJournalEntry(snap),
  tracker: (s, snap) => s.createTracker(snap),
};

// Reusable entity helpers for the bulk-action machinery (server/bulk-actions).
export function getEntityList(storage: IStorage, entityType: string): Promise<any[]> | null {
  const meta = ENTITY_META[entityType];
  return meta ? meta.list(storage) : null;
}
export function getEntityName(entityType: string, row: any): string {
  const meta = ENTITY_META[entityType];
  return meta ? String(meta.name(row) ?? "") : "";
}
export async function deleteEntityById(storage: IStorage, entityType: string, id: string): Promise<boolean> {
  const fn = DELETE_FN[entityType];
  if (!fn) return false;
  await fn(storage as AnyStorage, id);
  return true;
}
export const BULK_ENTITY_TYPES = Object.keys(ENTITY_META);

/** Fields that must never be re-applied verbatim from a snapshot. */
const SNAPSHOT_STRIP = new Set(["id", "createdAt", "updatedAt", "userId", "deletedAt"]);
function cleanSnapshot(row: any): any {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row || {})) if (!SNAPSHOT_STRIP.has(k)) out[k] = v;
  return out;
}

/**
 * Execute a ledger row's reverse plan. Returns a human-honest outcome —
 * including refusals when a plan isn't safely executable.
 */
export async function executeReversePlan(
  storage: IStorage,
  log: { entityType?: string | null; entityId?: string | null; entityName?: string | null; reversePlan?: any; reversible: boolean },
): Promise<{ ok: boolean; description: string; newEntityId?: string }> {
  const s = storage as AnyStorage;
  const type = log.entityType || "";
  const id = log.entityId || "";
  const name = log.entityName ? `"${log.entityName}"` : `the ${type}`;
  const plan = log.reversePlan || {};
  if (!log.reversible || !plan.op || plan.op === "none") {
    return { ok: false, description: `That action can't be undone automatically${plan.reason ? ` (${plan.reason})` : ""}.` };
  }
  switch (plan.op) {
    case "delete": {
      const fn = DELETE_FN[type];
      if (!fn || !id) return { ok: false, description: `No delete path for ${type}.` };
      await fn(s, id);
      return { ok: true, description: `Removed ${name} (${plan.soft ? "recoverable" : "permanent"} delete).` };
    }
    case "restore": {
      const ok = await s.restoreEntity(type, id);
      return ok
        ? { ok: true, description: `Restored ${name}.` }
        : { ok: false, description: `Couldn't restore ${name} — it may have been permanently removed.` };
    }
    case "reapply_before": {
      const fn = UPDATE_FN[type];
      if (!fn || !id || !plan.before) return { ok: false, description: `No before-state to re-apply for ${name}.` };
      await fn(s, id, cleanSnapshot(plan.before));
      return { ok: true, description: `Reverted ${name} to its previous values.` };
    }
    case "recreate": {
      const fn = RECREATE_FN[type];
      if (!fn || !plan.snapshot) return { ok: false, description: `${name} was permanently deleted and no snapshot exists to recreate it.` };
      const created = await fn(s, cleanSnapshot(plan.snapshot));
      return { ok: true, description: `Recreated ${name} from its snapshot (it has a new id).`, newEntityId: created?.id };
    }
    case "restore_set": {
      // Bulk undo: restore every soft-deleted id per entity type.
      const sets: Record<string, string[]> = plan.ids || {};
      let restored = 0, failed = 0;
      for (const [t, ids] of Object.entries(sets)) {
        for (const rid of ids) {
          try { (await s.restoreEntity(t, rid)) ? restored++ : failed++; } catch { failed++; }
        }
      }
      return { ok: restored > 0, description: `Restored ${restored} record${restored === 1 ? "" : "s"}${failed ? ` (${failed} could not be restored)` : ""}.` };
    }
    case "unmerge": {
      const { reverseMerge } = await import("./merge-profiles");
      const res = await reverseMerge(storage, plan);
      return { ok: res.ok, description: res.ok ? `Unmerged: ${res.description}.` : res.description };
    }
    case "set_preference": {
      if (!plan.key) return { ok: false, description: "No preference key in the reverse plan." };
      if (plan.value === null || plan.value === undefined) {
        // No prior saved value — restore by writing the current defaults.
        if (plan.key === "dashboard_layout") {
          const { DEFAULT_SECTION_DEFS, serializeLayoutValue } = await import("../shared/dashboard-layout");
          await s.setPreference(plan.key, serializeLayoutValue(DEFAULT_SECTION_DEFS));
          return { ok: true, description: "Restored the default dashboard layout." };
        }
        return { ok: false, description: `No previous value recorded for ${plan.key}.` };
      }
      await s.setPreference(plan.key, String(plan.value));
      return { ok: true, description: `Restored the previous ${plan.key.replace(/_/g, " ")}.` };
    }
    default:
      return { ok: false, description: `Unknown reverse plan "${plan.op}".` };
  }
}

/**
 * Wrap a SUCCESSFUL write-tool result in the standard envelope. Never throws
 * usefully — callers get the raw result back if anything goes wrong here.
 */
export async function finalizeToolResult(
  toolName: string,
  actionType: string,
  input: Record<string, any>,
  result: any,
  ctx: TurnVerifyContext,
): Promise<any> {
  try {
    const op = classifyOperation(toolName);
    const entityType = TOOL_ENTITY[toolName];
    const entityId = extractEntityId(result);
    const verification: ToolVerification = {};
    let entityName: string | undefined =
      result?.title || result?.name || result?.entity?.name
      || input?.title || input?.name || input?.description || input?.trackerName || input?.key;

    if (entityType && ENTITY_META[entityType] && entityId) {
      // ONE fresh list read, taken AFTER the write so it observes it. Do not
      // memoize the written type across a multi-write turn — the next write's
      // read-back must see this one too.
      const meta = ENTITY_META[entityType];
      let rows: any[] | null = null;
      try { rows = await meta.list(ctx.storage); } catch { rows = null; }
      if (rows) {
        const row = rows.find((r: any) => r.id === entityId);
        if (op === "delete") {
          // "exists" refers to the LIVE record — false is the desired outcome
          // after a delete (get* lists already exclude soft-deleted rows).
          verification.database_record_exists = !!row && !row.deletedAt;
        } else {
          verification.database_record_exists = !!row;
          if (row) {
            entityName = meta.name(row) || entityName;
            if (op === "create") {
              const norm = normalizeName(meta.name(row));
              if (norm) {
                verification.duplicate_count = rows.filter(
                  (r: any) => r.id !== entityId && normalizeName(meta.name(r)) === norm
                ).length;
              }
            }
            const linked: string[] = Array.isArray(row.linkedProfiles) ? row.linkedProfiles : [];
            if (linked.length > 0) {
              const ids = await profileIdSet(ctx, entityType === "profile");
              verification.profile_isolation_valid = linked.every((id) => ids.has(id));
            } else {
              // Orphans belong to self by the app-wide scope rule — valid.
              verification.profile_isolation_valid = true;
            }
          }
        }
      }
    }

    const message = typeof result?.message === "string" && result.message
      ? result.message.slice(0, 200)
      : `${VERBS[op]} ${entityType || "record"}${entityName ? ` "${String(entityName).slice(0, 60)}"` : ""}.`;

    return {
      success: true,
      action: toolName,
      action_type: actionType,
      message,
      ...(entityType && entityId ? { entity: { type: entityType, id: entityId, ...(entityName ? { name: String(entityName).slice(0, 80) } : {}) } } : {}),
      ...(Object.keys(verification).length > 0 ? { verification } : {}),
      ...result,
    };
  } catch (e: any) {
    // The envelope must never break a tool.
    try { console.warn(`[ai-envelope] finalize failed for ${toolName}:`, e?.message || e); } catch { /* noop */ }
    return result;
  }
}
