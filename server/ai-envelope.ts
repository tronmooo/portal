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
import type { ChatMutation } from "@shared/schema";
import { domainsForEntity, endpointForEntity } from "@shared/entity-domains";

export interface ToolVerification {
  /** Post-write read-back: the record is visible in the database (creates/
   *  updates) or gone (deletes). Omitted when no read-back mapping exists. */
  database_record_exists?: boolean;
  /** How many OTHER records of the same type share this record's normalized
   *  name/title. Reported, never enforced — duplicates are allowed. */
  duplicate_count?: number;
  /** Every profile id the record links to belongs to this user. */
  profile_isolation_valid?: boolean;
  /**
   * The record read back after the write carries the NAME the tool was asked
   * to write. False means the write landed on a different record than the
   * request named — the shape of the 2026-08-09 "Updated the Dodge Ram" bug,
   * where the operation succeeded against something the user hadn't asked
   * about. Reported, never enforced: names are legitimately normalized
   * (deduplication suffixes, canonical tracker names), so this is a signal for
   * the model and the failure log, not a hard failure.
   */
  requested_name_matches?: boolean;
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
  /**
   * Optional authoritative single-row read-back. When present, verification
   * uses this instead of scanning `list()` — one indexed lookup by primary key
   * rather than a full per-user list read. Required for entity types whose
   * list is expensive or truncated (tracker entries are capped at the 50
   * newest per tracker, so a list scan can MISS a row that really exists and
   * report a good write as failed).
   */
  byId?: (s: IStorage, id: string) => Promise<any | undefined>;
  /**
   * The storage method `byId` calls. Verification checks it exists before
   * trusting a by-id answer: an older backend or a test double that lacks the
   * method returns `undefined` through optional chaining, which is
   * indistinguishable from "no such row" — and reporting a good write as lost
   * is the exact failure this verification exists to prevent. Named here so
   * the check is a capability test rather than a guess about the result.
   */
  byIdMethod?: string;
};

const ENTITY_META: Record<string, EntityMeta> = {
  // Tasks verify by primary key when the storage offers it. `getTasks()` is a
  // scoped list — it drops done and soft-deleted rows — so a task the same turn
  // completes, or one written outside the active profile scope, can be missing
  // from it while sitting in the database. That mismatch is what reported
  // genuinely-saved writes as lost back when reminders carried the timed work;
  // tasks carry it now, so they get the authoritative read.
  task: { list: (s) => s.getTasks(), name: (r) => r.title, byId: (s, id) => (s as any).getTask(id), byIdMethod: "getTask" },
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
  // Notes are their own table since 20260820 — verified by id like tasks.
  note: { list: (s) => s.getNotes(), name: (r) => r.title, byId: (s, id) => (s as any).getNote(id), byIdMethod: "getNote" },
  document: { list: (s) => s.getDocuments(), name: (r) => r.name },
  paycheck: { list: (s) => s.getPaychecks(), name: (r) => r.source },
  // Tracker ENTRIES (the individual logged data points) verify by primary key.
  // They were previously absent from this map entirely, which is what let
  // "logged 24 oz" report success with no write verification at all
  // (production audit 2026-07-29, blocker #2). `list` is only a fallback for
  // storages without the by-id read; note it is truncated per tracker, which
  // is exactly why `byId` exists and takes precedence.
  trackerEntry: {
    list: async (s) => (await s.getTrackers()).flatMap((t: any) => t.entries || []),
    name: (r) => {
      const vals = r?.values && typeof r.values === "object" ? r.values : {};
      const first = Object.entries(vals).find(([k]) => !String(k).startsWith("_"));
      return first ? `${first[0]}: ${first[1]}` : "entry";
    },
    byId: (s, id) => (s as any).getTrackerEntry(id),
    byIdMethod: "getTrackerEntry",
  },
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
  log_tracker_entry: "trackerEntry", update_tracker_entry: "trackerEntry",
  delete_tracker_entry: "trackerEntry",
  create_goal: "goal", update_goal: "goal", delete_goal: "goal",
  create_profile: "profile", update_profile: "profile", delete_profile: "profile",
  create_liability: "profile", update_liability: "profile", revalue_asset: "profile",
  create_obligation: "obligation", update_obligation: "obligation", delete_obligation: "obligation",
  pay_obligation: "obligation", undo_last_payment: "obligation",
  add_liability_charge: "obligation", set_liability_amount: "obligation",
  create_account: "profile", update_account_balance: "profile",
  journal_entry: "journal", update_journal: "journal", delete_journal: "journal",
  save_memory: "memory", update_memory: "memory", delete_memory: "memory",
  create_artifact: "artifact", update_artifact: "artifact", delete_artifact: "artifact",
  create_note: "note", update_note: "note", delete_note: "note",
  duplicate_artifact: "artifact", toggle_artifact_item: "artifact",
  // create_reminder / update_reminder / delete_reminder are gone (reminders
  // were retired 2026-08-09). The executor translates those legacy names into
  // the task tools, and the envelope sees the task call, so they need no
  // mapping of their own.
  create_document: "document",
  log_expected_paycheck: "paycheck", confirm_paycheck_received: "paycheck", delete_paycheck: "paycheck",
};

/** Which entity a tool operates on — exported so the change manifest and its
 *  coverage test read the SAME map the verification does. */
export function entityTypeForTool(toolName: string): string | undefined {
  return TOOL_ENTITY[toolName];
}

/** Every tool name that has an entity mapping (coverage test reads this). */
export function mappedToolNames(): string[] {
  return Object.keys(TOOL_ENTITY);
}

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
    || result?.memory?.id || result?.payment?.id
    || result?.entity?.id;
}

/**
 * A tool whose top-level `id` is deliberately NOT the row it wrote can say so
 * with `_verify: { type?, id }`, and verification (plus the undo ledger) will
 * target the real row.
 *
 * The retired `create_reminder` was exactly this case: it returned the mirrored
 * CALENDAR EVENT's id as `id` so the chat card's Undo targeted the visible
 * calendar entry, while the row it actually wrote lived in another table.
 * Without the hint, verification looked that event id up in the wrong table,
 * never found it, and reported genuinely-saved writes as "could NOT be
 * confirmed … Nothing was saved". The hint is stripped before the envelope is
 * returned.
 */
function verifyTarget(toolName: string, result: any): { type?: string; id?: string } {
  const hint = result?._verify;
  return {
    type: (typeof hint?.type === "string" && hint.type) || TOOL_ENTITY[toolName],
    id: (typeof hint?.id === "string" && hint.id) || extractEntityId(result),
  };
}

/** Strip the internal hint so it never reaches the model or the chat client. */
function stripInternal(result: any): any {
  if (!result || typeof result !== "object" || !("_verify" in result)) return result;
  const { _verify, ...rest } = result;
  return rest;
}

const VERBS: Record<string, string> = { create: "Created", update: "Updated", delete: "Deleted" };

/** Entity types whose delete is a recoverable soft delete (deleted_at). */
export const SOFT_DELETE_TYPES = new Set([
  "task", "habit", "expense", "income", "event", "document", "profile", "obligation",
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
  document: (s, id) => s.deleteDocument(id),
  profile: (s, id) => s.deleteProfile(id),
  obligation: (s, id) => s.deleteObligation(id),
  memory: (s, id) => s.deleteMemory(id),
  artifact: (s, id) => s.deleteArtifact(id),
  note: (s, id) => s.deleteNote(id),
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
  note: (s, id, d) => s.updateNote(id, d),
  memory: (s, id, d) => s.updateMemory(id, d),
  journal: (s, id, d) => s.updateJournalEntry(id, d),
  tracker: (s, id, d) => s.updateTracker(id, d),
};

const RECREATE_FN: Record<string, (s: AnyStorage, snapshot: any) => Promise<any>> = {
  goal: (s, snap) => s.createGoal(snap),
  memory: (s, snap) => s.saveMemory(snap),
  artifact: (s, snap) => s.createArtifact(snap),
  note: (s, snap) => s.createNote(snap),
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
      // No companion-row cleanup here any more: a timed task IS its own
      // calendar entry, so deleting it removes the thing the user sees. The
      // retired reminder entity needed a mirrored event deleted alongside it,
      // which is how a deleted reminder used to reappear on the next fetch.
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
    const { type: entityType, id: entityId } = verifyTarget(toolName, result);
    const verification: ToolVerification = {};
    let entityName: string | undefined =
      result?.title || result?.name || result?.entity?.name
      || input?.title || input?.name || input?.description || input?.trackerName || input?.key;

    if (entityType && ENTITY_META[entityType] && entityId) {
      // ONE fresh list read, taken AFTER the write so it observes it. Do not
      // memoize the written type across a multi-write turn — the next write's
      // read-back must see this one too.
      const meta = ENTITY_META[entityType];
      // Prefer an authoritative primary-key read-back when the entity type
      // offers one: it is a single indexed lookup (cheaper than a per-user
      // list) and it cannot be fooled by a truncated list.
      // A storage that does not implement the by-id read (an older backend, a
      // test double) falls through to the list instead of being read as "row
      // not found".
      const canReadById = !!meta.byId
        && (!meta.byIdMethod || typeof (ctx.storage as any)[meta.byIdMethod] === "function");
      let byIdAnswered = false;
      if (canReadById) {
        let row: any | undefined;
        let readFailed = false;
        try { row = await meta.byId!(ctx.storage, entityId); } catch { readFailed = true; }
        if (!readFailed) {
          byIdAnswered = true;
          verification.database_record_exists = op === "delete" ? !!row && !row.deletedAt : !!row;
          if (row && op !== "delete") entityName = meta.name(row) || entityName;
        }
      }
      if (!byIdAnswered) {
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
    }

    // ── Failed verification is an ERROR, not a success ──────────────────────
    // (production audit 2026-07-29, blocker #2.)
    //
    // Previously this function hardcoded `success: true` for every write that
    // did not throw, and merely *reported* `database_record_exists` alongside
    // it, leaving it to the model to notice the discrepancy and describe it
    // honestly. It did not: the chat said "logged 24 oz" for a row that was
    // never written. A write we affirmatively read back as absent is a failed
    // write, and the envelope now says so in the machine-readable `success`
    // field that the rest of the pipeline and the UI key off.
    //
    // Strictly `=== false`: an omitted/undefined check means "not computed"
    // and must never be downgraded to a failure.
    const writeUnconfirmed = verification.database_record_exists === false && op !== "delete";
    const deleteUnconfirmed = verification.database_record_exists === true && op === "delete";
    if (writeUnconfirmed || deleteUnconfirmed) {
      const what = `${entityType || "record"}${entityName ? ` "${String(entityName).slice(0, 60)}"` : ""}`;
      const detail = writeUnconfirmed
        ? `The ${what} could NOT be confirmed in the database after ${op === "create" ? "creating" : "updating"} it — the record was not found on read-back. Nothing was saved. Tell the user the save failed and to try again; do NOT report success.`
        : `The ${what} still exists after the delete — the delete did NOT take effect. Tell the user the deletion failed; do NOT report success.`;
      try { console.error(`[ai-envelope] write verification FAILED for ${toolName} (${entityType}/${entityId})`); } catch { /* noop */ }
      return {
        ...stripInternal(result),
        success: false,
        action: toolName,
        action_type: actionType,
        error: detail,
        message: detail,
        verification,
        ...(entityType && entityId ? { entity: { type: entityType, id: entityId, ...(entityName ? { name: String(entityName).slice(0, 80) } : {}) } } : {}),
      };
    }

    // Did the write land on the record the request NAMED? A create/update
    // that succeeds against a different row is the failure mode behind
    // "Updated the Dodge Ram 2025" on a request to create one. Compared on
    // normalized names, and only when the input named something to begin with.
    if (op !== "delete" && verification.database_record_exists === true) {
      const requested = input?.title || input?.name || input?.description || input?.trackerName || input?.key;
      const requestedNorm = normalizeName(String(requested ?? ""));
      const writtenNorm = normalizeName(String(entityName ?? ""));
      if (requestedNorm && writtenNorm) {
        verification.requested_name_matches =
          writtenNorm === requestedNorm ||
          writtenNorm.startsWith(requestedNorm) ||
          requestedNorm.startsWith(writtenNorm);
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
      ...stripInternal(result),
    };
  } catch (e: any) {
    // The envelope must never break a tool.
    try { console.warn(`[ai-envelope] finalize failed for ${toolName}:`, e?.message || e); } catch { /* noop */ }
    return stripInternal(result);
  }
}


// ─── Change manifest ────────────────────────────────────────────────────────
// The envelope already knows exactly what a tool wrote — entity type, id, and
// the row itself. This turns that into the ChatMutation the client applies to
// its caches, so an AI-created row appears on its page instantly instead of
// after a refetch race (see shared/schema.ts ChatMutation).

// Envelope bookkeeping and tool-internal hints that must not be written into a
// cached list row. Everything else on the raw result IS the row.
const NON_ROW_KEYS = new Set([
  "success", "action", "action_type", "message", "entity", "verification",
  "error", "deduped", "_verify", "_displayData", "_validationWarnings",
  "_previousState", "trackerId",
]);

/**
 * A whole family of write tools — every liability tool, the paycheck tools, the
 * ownership-link tools — returns `{ result: <row>, actions: [...] }` rather than
 * the row itself. `extractEntityId` does not know that shape, so those writes
 * reached the client with no id and no row: the UI could only invalidate and
 * wait for a refetch, which is precisely the "created a liability, the list
 * still shows the old set" lag this whole change exists to remove.
 *
 * Unwrapped for the MANIFEST ONLY, deliberately not inside `extractEntityId`.
 * That function also drives post-write verification, and several tools in this
 * family return a LINK or a summary under `result` whose id belongs to a
 * different table than their TOOL_ENTITY mapping — teaching verification to
 * read those ids would fail the read-back and report successful writes as
 * failures. A wrong id here is harmless by construction: a row is only ever
 * inserted for a create, into the endpoint mapped for its entity type, and only
 * when the row's own id matches the manifest's.
 */
function manifestEntityId(rawResult: any): string | undefined {
  const direct = extractEntityId(rawResult);
  if (direct) return direct;
  const wrapped = rawResult?.result;
  return wrapped && typeof wrapped === "object" && typeof wrapped.id === "string" ? wrapped.id : undefined;
}

/** The DB row a tool wrote, or undefined when the result isn't row-shaped. */
function pickRow(rawResult: any, entityType: string | undefined, entityId: string | undefined): Record<string, any> | undefined {
  if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) return undefined;
  // Some tools return { task: {...} } / { expense: {...} } rather than the row,
  // and the liability/paycheck/ownership family returns { result: {...} }.
  const nested = entityType && rawResult[entityType];
  const wrapped = rawResult.result;
  const candidate = (typeof rawResult.id === "string" && rawResult.id)
    ? rawResult
    : (nested && typeof nested === "object" && typeof nested.id === "string" ? nested
      : (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped) && typeof wrapped.id === "string" ? wrapped
        : undefined));
  if (!candidate) return undefined;
  // Only hand back a row we can positively tie to the verified entity — a
  // mismatched id would insert the wrong record into a list.
  if (entityId && candidate.id !== entityId) return undefined;
  const row: Record<string, any> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (NON_ROW_KEYS.has(k)) continue;
    if (k.startsWith("_")) continue;
    if (typeof v === "function") continue;
    row[k] = v;
  }
  return typeof row.id === "string" ? row : undefined;
}

/**
 * Build the manifest entry for one executed tool.
 *
 * `envelopeResult` is what finalizeToolResult returned (or the raw result for
 * tools that skip the envelope). Returns null for reads, failures, and dedupes
 * — a dedupe wrote nothing, so claiming a create would put a phantom row in
 * the list.
 */
export function buildChatMutation(
  toolName: string,
  envelopeResult: any,
  rawResult: any,
): ChatMutation | null {
  try {
    if (!envelopeResult || envelopeResult.error) return null;
    if (envelopeResult.deduped === true) return null;
    const op = classifyOperation(toolName);
    const entityType = (typeof envelopeResult?.entity?.type === "string" && envelopeResult.entity.type)
      || entityTypeForTool(toolName)
      || null;
    const id = (typeof envelopeResult?.entity?.id === "string" && envelopeResult.entity.id)
      || manifestEntityId(rawResult);
    const domains = domainsForEntity(entityType);
    const endpoint = endpointForEntity(entityType);
    const row = op === "delete" ? undefined : pickRow(rawResult, entityType || undefined, id);
    return {
      op,
      entityType,
      domains,
      ...(id ? { id } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(row ? { row } : {}),
      tool: toolName,
    };
  } catch {
    // A manifest is an optimization. If we can't describe the write precisely,
    // say "something changed" rather than dropping it — the client's fallback
    // is the blanket invalidation it used to do unconditionally.
    return { op: "update", entityType: null, domains: ["everything"], tool: toolName };
  }
}
