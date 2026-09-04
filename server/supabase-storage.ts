import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID, createHash } from "crypto";

import { budgetMonthOrThrow, budgetCategoryKey, upsertBudget, applyBudgetUpdate, mergeBudgetsForCopy, spendByCategory, spendByCategory as spendByCategoryOf, type BudgetEntry } from "@shared/budget-ledger";
// One writer at a time per (user, month) within this process; see mutateBudgets.
const budgetWriteLocks = new Map<string, Promise<void>>();
import { assertEventSpan } from "@shared/event-span";
import { canonicalExpenseCategory, canonicalObligationCategory } from "@shared/category-canon";
// ---- Shared Supabase client (PERF) ----
// One client per (url, key) pair per warm container. The Supabase SDK keeps
// internal Fetch/Auth/Realtime state that's safe to share across requests
// because every storage call scopes by user_id. Avoiding per-request
// construction shaves real cold-start time off scoped storage routes.
let _sharedClient: SupabaseClient | null = null;
let _sharedKey: string | null = null;

// PERF Phase 0.3 (PERF_PLAN_LAUNCH_2026-07-16.md): per-table slow-query
// attribution. routes.ts logs [slow-request] per ENDPOINT (>1s); a slow
// endpoint fans out to 10-20 table fetches, so without this there's no way to
// tell WHICH table burned the time from production logs. Wrapping the client's
// fetch (Supabase REST path segment = table name) attributes it precisely.
const SLOW_QUERY_MS = 1_000;
function slowQueryLoggingFetch(input: any, init?: any): Promise<Response> {
  const started = Date.now();
  const done = (res: Response | null, err?: unknown) => {
    const ms = Date.now() - started;
    if (ms >= SLOW_QUERY_MS) {
      let table = "unknown";
      try {
        const raw = typeof input === "string" ? input : input?.url ?? String(input);
        const path = new URL(raw).pathname;              // /rest/v1/<table-or-rpc>
        table = path.split("/").filter(Boolean).pop() || "unknown";
      } catch { /* leave "unknown" */ }
      console.warn(`[slow-query] ${table} ${ms}ms${err ? " (failed)" : res && !res.ok ? ` (HTTP ${res.status})` : ""}`);
    }
  };
  return fetch(input, init).then(
    (res) => { done(res); return res; },
    (err) => { done(null, err); throw err; },
  );
}

export function getSharedSupabaseClient(url: string, serviceKey: string): SupabaseClient {
  const key = `${url}::${serviceKey.slice(0, 8)}`;
  if (_sharedClient && _sharedKey === key) return _sharedClient;
  _sharedClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-client-info": "portol-server" }, fetch: slowQueryLoggingFetch },
  });
  _sharedKey = key;
  return _sharedClient;
}
import { getUserToday, getUserCurrentMonth, parseLocalDate, toLocalDateStr, localDayOf, addDays as tzAddDays, DEFAULT_TIMEZONE } from "../shared/timezone";
import { prepareProfileFields } from "../shared/registry-fields";
import { nextRecurringTaskSpawn } from "../shared/recurrence";
import { addMonthsClamped, addYearsClamped, weekdaySetFor } from "../shared/date-math";
import { trackerIdentityKey } from "../shared/tracker-identity";
import { seriesFromEvents, seriesFromIncomes } from "../shared/calendar-adapters";
import { rulesFromAll, seriesFromDateRules, daysBetweenISO, normalizeEntityDateFields, EXPIRY_RULE_TYPES, isDocumentAttentionRule } from "../shared/date-rules";
import { deleteProfileFields, mergeFieldWrite } from "../shared/profile-field-identity";
import { generateSeriesOccurrences } from "../shared/calendar-occurrences";
import { passesProfileFilter, effectiveSelection, pushdownSelection } from "../shared/profile-filter";
import { buildRecallTerms, recallMatchScore } from "../shared/recall-match";
import { selfIdsFrom, isInScope, withAncestorOwnerIds } from "../shared/scope";
import { calculateStreak as sharedCalculateStreak } from "../shared/streak";
import { isHabitDueOn, type HabitScheduleShape } from "../shared/habit-schedule";
import {
  parseMoney as _sharedParseMoney,
  resolveAssetValue as _sharedResolveAssetValue,
  resolveLiabilityBalance as _sharedResolveLiabilityBalance,
  ASSET_PROFILE_TYPES,
  LIABILITY_PROFILE_TYPES,
  isAssetProfile,
  isLiabilityProfile,
  isNetWorthLiabilityProfile,
} from "../shared/asset-value";
import { isRecurringBill, isRecurringBillProfile } from "../shared/liability-types";
import {
  addCharge, removeCharge, setEstimate, setActual, normalizeBillingModel,
  resolveBillingModel, resolveOccurrenceAmount, billingModelMeta,
} from "../shared/liability-billing";
import {
  accountViews, accountKindMeta, applyBalanceAdjustment, balanceFieldsFor,
  isAccountProfile, isDebtAccount, normalizeAccountKind,
  reconcileAccountBalanceFields,
} from "../shared/finance-accounts";
import { collectOwnedAssetExpenses, ownedAssetIds } from "../shared/cost-of-ownership";
import { generateSchedule, nextDueOccurrence, liabilityAmount, liabilityFrequency, periodsPerYear, scheduleCounts, deriveScheduleFields, type ScheduleOccurrence } from "../shared/liability-schedule";
import { liabilityFamily } from "../shared/liability-types";
import { stripTrackerOwnerSuffix, stripOwnerPossessivePrefix } from "../shared/entity-naming";
import { advanceLiabilityDueDatePatch, advanceLiabilityDueDate, isSettledOccurrence, effectiveDueDate, resolveOccurrenceKey, isEndedBillFields } from "../shared/liability-recurrence";
import { parseRecurringMeta, eventOccursOn } from "../shared/recurring-dates";
import { taskOccurrenceDates, taskRepeats } from "../shared/task-occurrences";
import { habitDayProgress, habitsDayRollup } from "../shared/habit-progress";
import { autoCheckinLinkedHabits, mirrorHabitIds, HABIT_MIRROR_KEY, HABIT_MIRROR_IDS_KEY } from "./habit-completion";
import { normalizeTrackerEntry } from "./tracker-normalize";
import { sanitizeTrackerEntryValues } from "./tracker-entry-guard";
import { UPCOMING_BILL_WINDOW_DAYS, toMonthlyAmount, MS_PER_DAY, isUpcomingBill, isActiveObligation, canonicalIncomeFrequency } from "../shared/obligation-windows";

// PostgREST `.or()` filters are built by string concatenation, so a value
// containing `,` `(` `)` or `.` breaks out of its operand and appends
// caller-chosen conditions (or throws a 500). Every id interpolated into one
// MUST pass this. Ids are UUIDs; anything else cannot match a row anyway.
const POSTGREST_SAFE_VALUE = /^[A-Za-z0-9_-]{1,128}$/;
function isPostgrestSafe(v: unknown): v is string {
  return typeof v === "string" && POSTGREST_SAFE_VALUE.test(v);
}
import {
  type Profile, type InsertProfile,
  type Tracker, type InsertTracker, type TrackerEntry, type InsertTrackerEntry,
  type Task, type InsertTask,
  type Expense, type InsertExpense,
  type CalendarEvent, type InsertEvent, type CalendarTimelineItem,
  type EventCategory, EVENT_CATEGORY_COLORS,
  type Document, type DashboardStats,
  type ProfileDetail, type TimelineEntry, type Insight,
  type Habit, type InsertHabit, type HabitCheckin,
  type Obligation, type InsertObligation, type ObligationPayment,
  type Artifact, type InsertArtifact, type ChecklistItem,
  type JournalEntry, type InsertJournalEntry,
  type Income, type InsertIncome,
  type MemoryItem, type InsertMemory,
  type Domain, type InsertDomain, type DomainEntry,
  type MoodLevel,
  type Goal, type InsertGoal,
  type EntityLink, type InsertEntityLink,
  type LiabilityAssetLink, type InsertLiabilityAssetLink,
  type LiabilityProfileLink, type InsertLiabilityProfileLink,
  type LiabilityPayment, type InsertLiabilityPayment,
  type AssetPartyLink, type InsertAssetPartyLink,
  type OwnershipHistoryEntry,
  type AiActionLog, type InsertAiActionLog,
  MOOD_SCORES,
} from "@shared/schema";
import { type IStorage, computeSecondaryData } from "./storage";
import { encryptField, decryptField, shouldEncryptMemory, ENCRYPTED_PREFIX } from "./crypto-util";
import { setOwners } from "./ownership-writer";
import { ProfileLinkFailure } from "./profile-link-failure";
import { replaceOwnerSetWithRollback, type OwnerSetRecord } from "./owner-set-replacement";
import { OWNERSHIP_TABLES, type OwnedEntityType, resolveAutoOwner } from "../shared/ownership";
import { shareForParty, shareForParties, validateOwnership, roundPct, type OwnershipLink, scaleSharesTo100 } from "../shared/ownership-model";

const DOCUMENTS_BUCKET = "documents";

// ── Phone-sized image previews ───────────────────────────────────────────────
// Camera photos are stored at full resolution (3–6MB). The viewer shows them at
// ~700px, so every open shipped ~10x more bytes than the screen can use. A
// derived preview (max 1600px JPEG, ~200–400KB) is generated ON DEMAND the
// first time a document is opened with ?preview=1, stored next to the original
// (`<storage_path>.prev.jpg` — storage paths are `${userId}/${docId}.${ext}`
// and never change after creation, so a preview can't go stale), and served
// from the CDN on every open after that.
//
// sharp is a native module: it stays OUTSIDE the serverless bundle (see
// script/build-vercel.ts externals) and is loaded through this guarded dynamic
// import. If it is ever unavailable at runtime, generation quietly reports
// failure and the caller serves the original — previews are an optimization,
// never a dependency.
const PREVIEW_SUFFIX = ".prev.jpg";
const PREVIEW_MAX_DIM = 1600;
const PREVIEW_JPEG_QUALITY = 78;
const PREVIEW_SOURCE_LIMIT = 25_000_000; // don't decode >25MB sources in a 1GB function
const PREVIEWABLE_MIME = /^image\/(jpe?g|png|webp|heic|heif|tiff|bmp)$/i;

let _sharp: any | null | undefined; // undefined = not tried, null = unavailable
async function loadSharp(): Promise<any | null> {
  if (_sharp !== undefined) return _sharp;
  try {
    _sharp = (await import("sharp")).default;
  } catch (e: any) {
    console.warn("[doc-preview] sharp unavailable — serving originals:", e?.message || e);
    _sharp = null;
  }
  return _sharp;
}

// Explicit metadata-only projection for document LIST queries. Deliberately
// omits file_data — base64 blobs can be 10MB+ each and must never ship in a
// list. Binary is fetched on demand by getDocument(id)/:id/file only. Shared by
// getDocuments and getDocumentsPage so the two list paths stay in lockstep.
const DOCUMENT_LIST_COLUMNS =
  "id, user_id, name, type, mime_type, extracted_data, linked_profiles, tags, created_at, updated_at";

// Single-document metadata projection. Same as the list projection plus
// storage_path — deliberately WITHOUT file_data so opening a document never
// pulls its (multi-MB, base64) binary down just to render the details pane.
const DOCUMENT_META_COLUMNS = `${DOCUMENT_LIST_COLUMNS}, storage_path`;

/**
 * Merge an incoming JSONB-style patch into an existing object AND honor deletion
 * intents. Without explicit deletion support, shallow-merge (`{ ...existing,
 * ...incoming }`) can only OVERWRITE keys — it can never REMOVE them. That made
 * every JSONB-bearing column (`profiles.fields`, `tracker_entries.values`,
 * `artifacts.metadata`) append-only and produced the long-standing user
 * complaint: "I deleted birthday on Bob, came back after refresh, still there."
 *
 * Deletion intents come from three signals (all opt-in, all backward-compatible):
 *  - `keysToDelete: ["birthday"]`        — explicit allow-list of keys to drop.
 *  - `incoming[key] === null`            — sentinel: "clear this key."
 *  - `incoming[key] === undefined`       — same as null (defensive).
 *
 * The function returns a fresh object so callers don't mutate `existing`.
 */
/**
 * Keep only the columns the caller actually patched. Every updater builds
 * its UPDATE from `{ ...existing, ...data }` and used to write EVERY column,
 * so two edits to different columns of one row in flight together lost the
 * earlier one (the later writer re-wrote the earlier column with the stale
 * value it had read). Columns with no source key (timestamps) always stay.
 */
function onlyPatched<T extends Record<string, any>>(update: T, data: Record<string, any>, map: Record<string, string>): Partial<T> {
  const out: Record<string, any> = {};
  for (const [col, val] of Object.entries(update)) {
    const src = map[col];
    if (src === undefined || src in data) out[col] = val;
  }
  return out as Partial<T>;
}

export function mergeAndApplyDeletes<T extends Record<string, any>>(
  existing: T | null | undefined,
  incoming: Partial<T> | null | undefined,
  keysToDelete?: string[] | null
): T {
  const base: any = { ...(existing || {}) };
  if (incoming && typeof incoming === "object") {
    for (const [k, v] of Object.entries(incoming)) {
      if (v === null || v === undefined) {
        delete base[k];
      } else {
        base[k] = v;
      }
    }
  }
  if (Array.isArray(keysToDelete)) {
    for (const k of keysToDelete) {
      if (typeof k === "string") delete base[k];
    }
  }
  return base as T;
}

/**
 * Profile fields alias topology — MUST stay in lockstep with
 * `KEY_ALIASES` and `NESTED_GROUPS` in client/src/pages/profile-detail.tsx.
 *
 * The UI synthesizes a flat "display" view of `profile.fields` by:
 *   1. Promoting every key in a known nested group up to the top level
 *      (so `personal.dateOfBirth` is displayed as if it were `dateOfBirth`).
 *   2. Aliasing certain storage keys to a friendlier UI key
 *      (so `dateOfBirth` → `birthday` in the UI).
 *
 * The synthesis is one-way: the UI never sees that the storage key is
 * actually `dateOfBirth` nested under `personal`. So when a user clicks
 * the trash icon on a UI row labeled "Birthday" and the client sends
 * `{ fieldsToDelete: ["birthday"] }`, the storage layer that ONLY drops
 * the top-level `birthday` key leaves `dateOfBirth` and
 * `personal.dateOfBirth` in place — the value re-surfaces on the next
 * read because the flatten step puts it right back.
 *
 * That's the bug behind the long-standing complaint:
 *   "I deleted birthday on Bob, came back after refresh, still there."
 *
 * The shape below is the inverse of the client's KEY_ALIASES map:
 *   uiKey  →  every storage key that flattens INTO that uiKey.
 * `expandProfileFieldDeletions` uses this map to compute the FULL set of
 * storage keys that must be removed when a user asks to delete a UI key,
 * and `stripFromNestedGroups` removes every entry of that set from each
 * known nested group object.
 */
const PROFILE_KEY_ALIAS_REVERSE: Record<string, string[]> = {
  birthday: ["birthday", "dateOfBirth", "dob", "date_of_birth"],
  license: ["license", "licenseNumber"],
  licenseState: ["licenseState", "issuingAuthority"],
  licenseExpiration: ["licenseExpiration", "expirationDate"],
  name: ["name", "patientName"],
  phone: ["phone", "primaryPhone", "homePhone", "cellPhone"],
  address: ["address", "homeAddress", "serviceAddress"],
};

const PROFILE_NESTED_GROUPS = [
  // financial / asset groups
  "vehicles", "vehicle", "insurance", "housing", "other", "finance", "subscriptions", "utilities", "loan",
  // person / self groups
  "personal", "identity", "health", "contact", "contacts", "emergency",
  // pet groups
  "pets", "pet",
];

/**
 * Expand a list of UI-facing field keys into the full set of storage-side
 * keys that have to be removed to make the deletion actually stick across
 * a refresh. Returns a de-duplicated string[].
 *
 * Example: ["birthday"] → ["birthday", "dateOfBirth", "dob", "date_of_birth"]
 */
export function expandProfileFieldDeletions(uiKeys: string[] | undefined | null): string[] {
  if (!Array.isArray(uiKeys) || uiKeys.length === 0) return [];
  const out = new Set<string>();
  for (const k of uiKeys) {
    if (typeof k !== "string" || !k) continue;
    out.add(k);
    const aliases = PROFILE_KEY_ALIAS_REVERSE[k];
    if (aliases) for (const a of aliases) out.add(a);
  }
  return Array.from(out);
}

/**
 * Walk every known nested-group object on `fields` and remove `keys` from
 * each one. If a nested group ends up empty after stripping, drop the
 * group key itself so the UI doesn't show an empty "Personal Details"
 * section that re-promotes nothing.
 *
 * Operates in-place on `fields`. Safe to call when no nested groups exist.
 */
export function stripFromNestedGroups(fields: Record<string, any>, keys: string[]): void {
  if (!fields || typeof fields !== "object" || keys.length === 0) return;
  for (const group of PROFILE_NESTED_GROUPS) {
    const nested = fields[group];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    let touched = false;
    for (const k of keys) {
      if (k in nested) {
        delete nested[k];
        touched = true;
      }
    }
    if (touched && Object.keys(nested).length === 0) {
      delete fields[group];
    }
  }
}

// parseMoney / resolveAssetValue / resolveLiabilityValue moved to
// shared/asset-value.ts (BUG-20260528-asset-resolver-duplication).
// Re-exported here for backwards compatibility with existing imports.
const parseMoney = _sharedParseMoney;
export const resolveAssetValue = _sharedResolveAssetValue;
export const resolveLiabilityValue = _sharedResolveLiabilityBalance;

// Resolve the monthly payment $ for a liability/loan profile across all known
// nested storage paths. Used by server endpoints that enrich liability rows
// for the NetWorthStrip "Monthly debt" card and the Belongings debt service rollup.
export function resolveMonthlyPayment(fields: any): number {
  if (!fields || typeof fields !== "object") return 0;
  const finance = fields.finance || {};
  const loan = fields.loan || {};
  const other = fields.other || {};
  const candidates = [
    fields.monthlyPayment, fields.monthly_payment, fields.monthlyAmount, fields.monthly_amount,
    finance.monthlyPayment, finance.monthly_payment, finance.monthlyAmount, finance.monthly_amount,
    loan.monthlyPayment, loan.monthly_payment,
    other.monthlyPayment, other.monthly_payment,
    fields.minimumPayment, fields.minimum_payment,
    finance.minimumPayment, finance.minimum_payment,
  ];
  for (const c of candidates) {
    const n = parseMoney(c);
    if (n > 0) return n;
  }
  const loans = Array.isArray(finance.loans) ? finance.loans : Array.isArray(fields.loans) ? fields.loans : [];
  if (loans.length > 0) {
    const sum = loans.reduce((s: number, l: any) => s + parseMoney(l?.monthlyPayment || l?.monthly_payment || l?.monthlyAmount), 0);
    if (sum > 0) return sum;
  }
  return 0;
}

// (Removed with `autoGenerateProfileEvents`: `eventDrivingFieldKeys` and
// `profileEditTouchesEventKey`. They existed to decide whether a profile edit
// was worth generating calendar events for; nothing generates them any more,
// and a hardcoded per-type list of "date keys" is exactly the kind of second
// vocabulary this change removed everywhere else.)

// ---- MIME type → file extension helper ----
function getExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf',
    'text/plain': 'txt', 'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  };
  return map[mimeType] || 'bin';
}

// ---- Streak calculator (timezone-aware) ----
function calculateStreak(
  checkins: { date: string }[],
  targetPerDay: number = 1,
  timezone: string = 'America/Los_Angeles',
  schedule?: HabitScheduleShape | null,
): { current: number; longest: number } {
  // One streak rule for every reader (shared/streak.ts). With the habit's
  // schedule, a Mon/Wed/Fri habit's off-days neither count nor break the run.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  return sharedCalculateStreak(checkins.map((c) => String(c.date || "").slice(0, 10)).filter(Boolean), {
    today,
    targetPerDay,
    ...(schedule ? { isScheduled: (d: string) => isHabitDueOn(schedule, d) } : {}),
  });
}

// ---- Insight generation ----
function generateInsights(
  profiles: Profile[], trackers: Tracker[], tasks: Task[], expenses: Expense[],
  habits: Habit[], obligations: Obligation[], journal: JournalEntry[],
): Insight[] {
  const insights: Insight[] = [];
  const now = new Date();
  // generateInsights() has no request context, so it cannot read the user's
  // timezone; every date bucket below uses the app-wide default.
  const insightTz = DEFAULT_TIMEZONE;
  const todayLocal = getUserToday(insightTz);

  const weightTracker = trackers.find(t => t.name.toLowerCase().includes("weight") && t.category === "health");
  if (weightTracker && weightTracker.entries.length >= 3) {
    const recent = weightTracker.entries.slice(-5);
    const firstVal = parseFloat(recent[0].values.weight || recent[0].values.value || "0");
    const lastVal = parseFloat(recent[recent.length - 1].values.weight || recent[recent.length - 1].values.value || "0");
    const diff = lastVal - firstVal;
    if (Math.abs(diff) > 0.5) {
      insights.push({ id: randomUUID(), type: "health_correlation", title: diff < 0 ? "Weight trending down" : "Weight trending up", description: `Your weight has ${diff < 0 ? "decreased" : "increased"} by ${Math.abs(diff).toFixed(1)} lbs over the last ${recent.length} entries. ${diff < 0 ? "Great progress — keep it up." : "Consider reviewing your nutrition and activity levels."}`, severity: diff < 0 ? "positive" : "info", relatedEntityType: "tracker", relatedEntityId: weightTracker.id, data: { change: diff, entries: recent.length }, createdAt: now.toISOString() });
    }
  }

  const fitnessTrackers = trackers.filter(t => t.category === "fitness");
  if (fitnessTrackers.length > 0) {
    const allFE = fitnessTrackers.flatMap(t => t.entries);
    // Bug #23: bucket entries into local YYYY-MM-DD and walk backwards with
    // addDays() (noon UTC anchor) so day arithmetic never drifts on DST days.
    // generateInsights() doesn't have access to the user's timezone, so we
    // fall back to America/Los_Angeles — same default the rest of the app uses.
    const fitTz = insightTz;
    const fitDays = new Set<string>();
    for (const e of allFE) {
      try { fitDays.add(toLocalDateStr(new Date(e.timestamp), fitTz)); }
      catch { fitDays.add(e.timestamp.slice(0, 10)); }
    }
    let streak = 0;
    let fitCursor = getUserToday(fitTz);
    for (let i = 0; i < 30; i++) {
      if (fitDays.has(fitCursor)) streak++; else if (i > 0) break;
      fitCursor = tzAddDays(fitCursor, -1);
    }
    if (streak >= 2) {
      insights.push({ id: randomUUID(), type: "streak", title: `${streak}-day fitness streak`, description: `You've worked out ${streak} days in a row. ${streak >= 7 ? "Incredible consistency!" : streak >= 3 ? "Building great momentum." : "Keep it going!"}`, severity: "positive", data: { streak }, createdAt: now.toISOString() });
    }
  }

  const bpTracker = trackers.find(t => t.name.toLowerCase().includes("blood pressure") || t.name.toLowerCase().includes("bp"));
  if (bpTracker && bpTracker.entries.length > 0) {
    const latest = bpTracker.entries[bpTracker.entries.length - 1];
    const sys = parseFloat(latest.values.systolic); const dia = parseFloat(latest.values.diastolic);
    // Both readings must be real numbers — a systolic-only entry used to
    // render "Your latest reading (150/NaN)".
    if (Number.isFinite(sys) && Number.isFinite(dia) && (sys >= 140 || dia >= 90)) {
      insights.push({ id: randomUUID(), type: "anomaly", title: "Elevated blood pressure detected", description: `Your latest reading (${sys}/${dia}) is above the recommended range.`, severity: "warning", relatedEntityType: "tracker", relatedEntityId: bpTracker.id, data: { systolic: sys, diastolic: dia }, createdAt: now.toISOString() });
    }
  }

  // Expense dates are YYYY-MM-DD: compare the month prefix rather than parsing
  // (new Date("YYYY-MM-DD") is UTC midnight, so the 1st landed in the prior month).
  const thisMonthKey = getUserCurrentMonth(insightTz);
  const monthlyExpenses = expenses.filter(e => String(e.date || "").slice(0, 7) === thisMonthKey);
  const monthTotal = monthlyExpenses.reduce((s, e) => s + e.amount, 0);
  if (monthTotal > 0) {
    const topCat = Object.entries(spendByCategory(monthlyExpenses)).sort((a, b) => b[1] - a[1])[0];
    if (topCat) {
      insights.push({ id: randomUUID(), type: "spending_trend", title: `$${monthTotal.toFixed(0)} spent this month`, description: `Top category: ${topCat[0]} ($${topCat[1].toFixed(0)}).`, severity: monthTotal > 1000 ? "warning" : "info", data: { total: monthTotal, topCategory: topCat[0] }, createdAt: now.toISOString() });
    }
  }

  const overdueTasks = tasks.filter(t => { if (t.status === "done" || !t.dueDate) return false; const dueDay = localDayOf(t.dueDate, insightTz); return !!dueDay && dueDay < todayLocal; });
  if (overdueTasks.length > 0) {
    insights.push({ id: randomUUID(), type: "reminder", title: `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`, description: overdueTasks.map(t => t.title).join(", "), severity: "negative", data: { taskIds: overdueTasks.map(t => t.id) }, createdAt: now.toISOString() });
  }

  for (const habit of habits) {
    if (habit.currentStreak >= 3) {
      insights.push({ id: randomUUID(), type: "habit_streak", title: `${habit.currentStreak}-day ${habit.name} streak`, description: `${habit.currentStreak >= 7 ? "Amazing consistency!" : "Keep building the habit!"}${habit.longestStreak > habit.currentStreak ? ` Your record is ${habit.longestStreak} days.` : " This is your personal best!"}`, severity: "positive", relatedEntityType: "habit", relatedEntityId: habit.id, data: { current: habit.currentStreak, longest: habit.longestStreak }, createdAt: now.toISOString() });
    }
  }

  const weekOutLocal = tzAddDays(todayLocal, 7);
  const upcomingObs = obligations.filter(o => { const dueDay = localDayOf(o.nextDueDate, insightTz); return !!dueDay && dueDay >= todayLocal && dueDay <= weekOutLocal; });
  if (upcomingObs.length > 0) {
    const totalDue = upcomingObs.reduce((s, o) => s + o.amount, 0);
    insights.push({ id: randomUUID(), type: "obligation_due", title: `$${totalDue.toFixed(0)} due this week`, description: upcomingObs.map(o => `${o.name}: $${o.amount}`).join(", "), severity: "warning", data: { obligations: upcomingObs.map(o => o.id), total: totalDue }, createdAt: now.toISOString() });
  }

  const recentJournal = journal.filter(j => { const d = new Date(j.createdAt); return (now.getTime() - d.getTime()) < 7 * 86400000; });
  if (recentJournal.length >= 3) {
    const avg = recentJournal.reduce((s, j) => s + (MOOD_SCORES[j.mood] || 4), 0) / recentJournal.length;
    if (avg <= 3.0) { insights.push({ id: randomUUID(), type: "mood_trend", title: "Mood has been low this week", description: "Your journal entries suggest a tough stretch. Consider reaching out to someone or doing something you enjoy.", severity: "warning", data: { avgMood: avg }, createdAt: now.toISOString() }); }
    else if (avg >= 6) { insights.push({ id: randomUUID(), type: "mood_trend", title: "Great mood this week", description: "You've been feeling positive. Keep doing what's working!", severity: "positive", data: { avgMood: avg }, createdAt: now.toISOString() }); }
  }

  let totalCalsBurned = 0;
  for (const t of trackers) { for (const e of t.entries) { if (localDayOf(e.timestamp, insightTz) === todayLocal && e.computed?.caloriesBurned) totalCalsBurned += e.computed.caloriesBurned; } }
  if (totalCalsBurned > 0) { insights.push({ id: randomUUID(), type: "health_correlation", title: `${totalCalsBurned} calories burned today`, description: `Based on your logged activities. ${totalCalsBurned > 500 ? "Great active day!" : "Every bit counts."}`, severity: "positive", data: { caloriesBurned: totalCalsBurned }, createdAt: now.toISOString() }); }

  if (trackers.length > 0) {
    const noRecentEntries = trackers.filter(t => { if (t.entries.length === 0) return true; const last = new Date(t.entries[t.entries.length - 1].timestamp); return (now.getTime() - last.getTime()) > 3 * 86400000; });
    if (noRecentEntries.length > 0) { insights.push({ id: randomUUID(), type: "suggestion", title: "Trackers need attention", description: `${noRecentEntries.map(t => t.name).join(", ")} haven't been updated in 3+ days.`, severity: "info", data: { trackerIds: noRecentEntries.map(t => t.id) }, createdAt: now.toISOString() }); }
  }

  return insights;
}

// ---- [P0] Per-user insights cache ----
// generateInsights() walks every tracker × every entry (O(N×M)) plus six more
// table scans each time getInsights() runs. Recomputing that on every fetch is
// pure waste — the inputs change at human speed. Cache the computed result per
// (user, profile-filter) for 60s in a module-level Map so it survives across
// the per-request SupabaseStorage instances created on a warm container.
//
// NOTE: per-instance caching is BEST-EFFORT under serverless — every warm
// Vercel instance has its own Map, so a request landing on a cold/other
// instance recomputes once. That's acceptable: warm instances serve most
// traffic, and the recompute is merely the status quo ante.
//
// Invalidation: tracker/entry mutations through this storage layer bust the
// user's entries eagerly (see bustInsightsCacheFor call sites); every other
// mutation is covered by the 60s TTL, which the QA spec accepts.
const INSIGHTS_CACHE_TTL_MS = 60_000;
const insightsCache = new Map<string, { at: number; insights: Insight[] }>();
function bustInsightsCacheFor(userId: string): void {
  for (const key of insightsCache.keys()) {
    if (key.startsWith(`${userId}:`)) insightsCache.delete(key);
  }
}


// ============================================================
// PROFILE DETAIL LIST CAPS (shared by SupabaseStorage + MemStorage)
// ============================================================
// PERF 2026-07-21 (large-profile first paint): a profile with years of data
// (1000s of tracker entries / expenses / events) shipped a multi-MB detail
// payload on every open — the JSON dominated open time, not the queries.
// First paint only needs the recent slice of each section, so we cap each
// embedded list to the newest N and expose TRUE totals/sums as ADDITIVE
// sibling fields (nothing renamed or removed). Full lists stay reachable via
// the existing per-section endpoints (/api/expenses?profileId=,
// /api/events?profileIds=, /api/journal?profileIds=, /api/documents?profileId=,
// /api/trackers/:id) which the client calls lazily on "Show all".
export const PROFILE_DETAIL_CAPS = {
  trackerEntriesPerTracker: 50, // newest entries embedded per tracker
  expenses: 100,                // newest expenses embedded
  pastEvents: 100,              // newest PAST events (all upcoming always kept)
  journal: 50,                  // newest journal entries embedded
  documents: 200,               // newest document METADATA rows (never file blobs)
  timeline: 200,                // newest timeline entries
} as const;

export function capProfileDetailLists(input: {
  relatedTrackers: Tracker[];
  relatedExpenses: Expense[];
  relatedEvents: CalendarEvent[];
  relatedDocuments: Document[];
  relatedJournal: JournalEntry[];
  timeline: TimelineEntry[];
  profileId: string;
  /** Exact DB-side entry count when known (head-only count query); falls back to embedded count. */
  trackerEntriesExactTotal?: number;
}) {
  const { relatedTrackers, relatedExpenses, relatedEvents, relatedDocuments, relatedJournal, timeline, profileId } = input;
  const C = PROFILE_DETAIL_CAPS;
  const ts = (d: any) => { const t = new Date(d || 0).getTime(); return Number.isFinite(t) ? t : 0; };

  // Trackers: newest N entries per tracker, ALWAYS emitted oldest → newest —
  // the order every other tracker read uses and the order the profile page
  // reads (`entries[length - 1]` is "latest"). The detail's entry query is
  // newest-first (it keeps the newest 1000 across the profile's trackers), so
  // a tracker under the cap used to pass through newest-first while one over
  // it was re-sorted — and the page showed a small tracker's OLDEST value as
  // its latest (D236). Sorting is defensive either way: MemStorage keeps
  // insertion order.
  let embeddedEntryTotal = 0;
  const cappedTrackers = relatedTrackers.map(t => {
    const all = t.entries || [];
    embeddedEntryTotal += all.length;
    const newestFirst = [...all].sort((a, b) => ts(b.timestamp) - ts(a.timestamp));
    const kept = all.length <= C.trackerEntriesPerTracker ? newestFirst : newestFirst.slice(0, C.trackerEntriesPerTracker);
    return { ...t, entries: kept.reverse(), entriesTotal: all.length };
  });

  // Expenses: newest N by date. Sums/counts computed over the FULL set so
  // headline stats stay exact. The "owned" pair mirrors the Finance tab's
  // strict-ownership rule (linkedProfiles[0] === profileId).
  const relatedExpensesTotal = relatedExpenses.length;
  const relatedExpensesSum = relatedExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const ownedRows = relatedExpenses.filter(e => Array.isArray(e.linkedProfiles) && e.linkedProfiles[0] === profileId);
  const relatedExpensesOwnedSum = ownedRows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const relatedExpensesOwnedCount = ownedRows.length;
  const cappedExpenses = relatedExpensesTotal <= C.expenses
    ? relatedExpenses
    : [...relatedExpenses].sort((a, b) => ts(b.date) - ts(a.date)).slice(0, C.expenses);

  // Events: keep EVERY upcoming event (reminders/renewals must never drop)
  // plus the newest N past events.
  const relatedEventsTotal = relatedEvents.length;
  let cappedEvents = relatedEvents;
  if (relatedEventsTotal > C.pastEvents) {
    const dayStart = Date.now() - 86400000; // 1-day grace so "today" never drops
    const upcoming = relatedEvents.filter(e => ts(e.date) >= dayStart);
    const past = relatedEvents
      .filter(e => ts(e.date) < dayStart)
      .sort((a, b) => ts(b.date) - ts(a.date))
      .slice(0, C.pastEvents);
    cappedEvents = [...upcoming, ...past];
  }

  // Journal: newest N by date (created_at fallback).
  const relatedJournalTotal = relatedJournal.length;
  const cappedJournal = relatedJournalTotal <= C.journal
    ? relatedJournal
    : [...relatedJournal].sort((a, b) => ts((b as any).date || b.createdAt) - ts((a as any).date || a.createdAt)).slice(0, C.journal);

  // Documents: metadata-only rows (file blobs are never embedded), newest N.
  const relatedDocumentsTotal = relatedDocuments.length;
  const cappedDocuments = relatedDocumentsTotal <= C.documents
    ? relatedDocuments
    : [...relatedDocuments].sort((a, b) => ts(b.createdAt) - ts(a.createdAt)).slice(0, C.documents);

  // Timeline: callers sort newest-first before calling — plain cap.
  const timelineTotal = timeline.length;
  const cappedTimeline = timeline.length <= C.timeline ? timeline : timeline.slice(0, C.timeline);

  return {
    relatedTrackers: cappedTrackers,
    relatedExpenses: cappedExpenses,
    relatedEvents: cappedEvents,
    relatedDocuments: cappedDocuments,
    relatedJournal: cappedJournal,
    timeline: cappedTimeline,
    relatedExpensesTotal, relatedExpensesSum, relatedExpensesOwnedSum, relatedExpensesOwnedCount,
    relatedEventsTotal, relatedJournalTotal, relatedDocumentsTotal, timelineTotal,
    trackerEntriesTotal: Math.max(Number(input.trackerEntriesExactTotal) || 0, embeddedEntryTotal),
  };
}

// ============================================================
// SUPABASE STORAGE IMPLEMENTATION
// ============================================================

/** Postgres 23505 through supabase-js (a PK/unique clash on insert). */
function isUniqueViolationError(e: any): boolean {
  const code = String(e?.code || e?.details?.code || "");
  return code === "23505" || /duplicate key value/i.test(String(e?.message || ""));
}

/** Fold any liability lifecycle word into the obligation status enum. */
export function canonicalObligationStatus(raw: unknown): "active" | "paused" | "cancelled" | "ended" {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "paused") return "paused";
  if (v === "cancelled" || v === "canceled") return "cancelled";
  if (v === "ended") return "ended";
  return "active";
}

/** entity_links endpoint type → table carrying its deleted_at flag. */
const LINK_ENDPOINT_TABLES: Record<string, string> = {
  task: "tasks", expense: "expenses", income: "incomes", event: "events", document: "documents",
  goal: "goals", habit: "habits", journal: "journal_entries", tracker: "trackers",
  profile: "profiles", obligation: "profiles", memory: "memories", artifact: "artifacts",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** writeProfilePatch's answer when the row moved between the read and the guarded write. */
const PROFILE_WRITE_COLLIDED: unique symbol = Symbol("profile-write-collided");

export class SupabaseStorage implements IStorage {
  private supabase: SupabaseClient;
  private userId: string;
  _timezone: string = 'America/Los_Angeles'; // user's timezone for date calculations

  // PERF (2026-05-29): per-instance in-flight Promise cache for heavy list
  // methods. The bootstrap handler (and other multi-aggregate endpoints)
  // calls getProfiles/getExpenses/getEvents etc. several times across
  // getStats() and getDashboardEnhanced() — each call paid a full Supabase
  // round-trip. Caching the in-flight Promise on this per-request instance
  // collapses duplicate fetches to a single network call without changing
  // any call sites. enableMemo() turns it on; methods check the cache.
  // Default OFF so cross-request reuse never happens (instance is also
  // per-request, but defensive).
  private memoEnabled = false;
  private memoCache: Map<string, Promise<any>> = new Map();
  enableRequestMemo(): void { this.memoEnabled = true; this.memoCache.clear(); }
  disableRequestMemo(): void { this.memoEnabled = false; this.memoCache.clear(); }
  /** Drop memoized reads without disabling the memo — called after every AI
   * tool write (ai-engine invalidateContextCache) so read-after-write
   * verification observes the write while pre-write reads stay deduplicated. */
  clearRequestMemo(): void { this.memoCache.clear(); }
  private memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.memoEnabled) return fn();
    const hit = this.memoCache.get(key);
    if (hit) return hit as Promise<T>;
    const p = fn().catch(err => { this.memoCache.delete(key); throw err; });
    this.memoCache.set(key, p);
    return p;
  }

  /**
   * PERF (profile-switch, 2026-08-05): export this request's resolved memo so a
   * LATER request for the same user can start with the same tables already in
   * hand (see primeRequestMemo).
   *
   * Why this is safe to reuse across requests: the caller keys the snapshot by
   * the user's data VERSION (cacheUserKey → `<uid>@v<n>`), so any write makes
   * the old snapshot unaddressable — exactly the scheme the response cache
   * already relies on — and it is stored under a short TTL on top of that.
   *
   * Rejected reads are dropped rather than cached: a failed fetch must not be
   * replayed into the next request as if it had succeeded.
   */
  async snapshotRequestMemo(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    await Promise.all(
      Array.from(this.memoCache.entries()).map(async ([key, promise]) => {
        try {
          const value = await promise;
          if (value !== undefined) out[key] = value;
        } catch { /* failed read — leave the slot empty so the next request retries */ }
      }),
    );
    return out;
  }

  /**
   * Seed the request memo with reads captured by an earlier request
   * (snapshotRequestMemo). Every subsequent getTasks()/getExpenses()/… that
   * would have hit Supabase resolves from memory instead.
   *
   * This is what makes the SECOND profile scope cheap: /api/dashboard-bootstrap
   * fetches every table UNFILTERED (see the `sharedFetches` path in getStats /
   * getDashboardEnhanced) and filters in JS, so switching people changes only
   * the JS filtering — the ~18 Supabase round trips behind it are identical
   * work the server used to redo from scratch for every person.
   *
   * No-op unless the memo is enabled (never leaks into a plain request), and it
   * never overwrites a live entry, so an in-flight read always wins.
   */
  primeRequestMemo(entries: Record<string, unknown> | null | undefined): void {
    if (!this.memoEnabled || !entries) return;
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined || this.memoCache.has(key)) continue;
      this.memoCache.set(key, Promise.resolve(value));
    }
  }

  /**
   * PERF (durable-fix-phase1, 2026-05-30): build a memo-key suffix for the
   * optional profileIds filter on every list method. Deterministic (sorted)
   * so that two equivalent filters hit the same memo entry.
   */
  private _fk(profileIds?: string[]): string {
    return profileIds && profileIds.length > 0 ? `:${[...profileIds].sort().join(",")}` : "";
  }

  /**
   * PERF (durable-fix-phase1): apply the linked_profiles filter as a chain of
   * `cs` (@>) checks OR'd together. Each `@>` lookup hits the GIN index
   * (idx_<table>_linked_profiles_gin); the planner unions the bitmap scans.
   *
   * IMPORTANT: linked_profiles is JSONB on most tables but PG ARRAY on
   * `incomes` and `journal_entries`. The `cs.` operator works for both, but
   * the literal syntax differs:
   *   JSONB:  cs.["id"]    → jsonb @> '["id"]'
   *   ARRAY:  cs.{id}      → array @> '{id}'
   * Passing JSONB syntax to an ARRAY column returns SQL error
   *   "malformed array literal" (regression caught in production after the
   *   first deploy of Phase 1).
   */
  /**
   * The ids a containment pushdown must match. `passesProfileFilter` (the
   * correctness authority every list is re-filtered with) reaches a row
   * through its linked profiles' OWNER CHAIN (D88: the car's bill is Self's)
   * and through CO-OWNERSHIP (D120: Linda's share of the car), but
   * `linked_profiles @> [id]` only sees the raw id — so a person-scoped
   * fetch silently dropped the car's tasks, documents, bills and events
   * before the JS filter ever saw them. shared/profile-filter.pushdownSelection
   * is the same rule written from the selection's side (descendants +
   * co-owned assets); with it the pushdown and the JS pass agree on every
   * row except the orphan rule, which callers keep on the fetch-all path.
   * Empty/undefined (no filter) is passed through untouched.
   */
  private async pushdownIds(profileIds?: string[]): Promise<string[] | undefined> {
    if (!profileIds || profileIds.length === 0) return profileIds;
    const [allProfiles, assetPartyLinks, liabilityProfileLinks] = await Promise.all([
      this.memo("getProfilesLite", () => this.getProfilesLite()).catch(() => [] as Profile[]),
      this.getAssetPartyLinks().catch(() => [] as any[]),
      this.getLiabilityProfileLinks().catch(() => [] as any[]),
    ]);
    return pushdownSelection({ selectedIds: profileIds, allProfiles: allProfiles as any, assetPartyLinks: assetPartyLinks as any, liabilityProfileLinks: liabilityProfileLinks as any });
  }

  private _applyProfileFilter<Q extends { or: (clause: string) => Q }>(
    q: Q,
    profileIds?: string[],
    columnKind: "jsonb" | "array" = "jsonb",
  ): Q {
    if (!profileIds || profileIds.length === 0) return q;
    const orClause = profileIds
      .map(id => {
        if (columnKind === "array") {
          // PG array literal: {uuid}. UUIDs are quote-safe (hex + dashes).
          return `linked_profiles.cs.{${id}}`;
        }
        return `linked_profiles.cs.${JSON.stringify([id])}`;
      })
      .join(",");
    return q.or(orClause);
  }

  constructor(supabaseUrl: string, supabaseServiceKey: string, userId: string) {
    // PERF (2026-05-28): reuse a single Supabase client across warm container
    // requests instead of constructing a new one per scoped storage instance.
    // The createClient() call sets up Fetch/Realtime/Auth internals — when we
    // were doing it per request, every cold-ish request paid the cost. The
    // client itself is stateless w.r.t. userId (we always filter by user_id in
    // queries), so it's safe to share.
    this.supabase = getSharedSupabaseClient(supabaseUrl, supabaseServiceKey);
    this.userId = userId;
  }

  setUserId(userId: string) { this.userId = userId; }

  private logActivity(entityType: string, description: string, action: string = "create", entityId?: string, source: string = "manual") {
    // Write to audit_log table (fire-and-forget, non-blocking)
    Promise.resolve(this.supabase.from("audit_log").insert({
      user_id: this.userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      entity_name: description,
      source,
    })).catch(() => {}); // non-critical, never block
  }

  // ============================================================
  // AI ACTION LEDGER (undo + audit for chat mutations)
  // ============================================================
  private rowToAiActionLog(r: any): AiActionLog {
    return {
      id: r.id, tool: r.tool, actionType: r.action_type,
      entityType: r.entity_type, entityId: r.entity_id, entityName: r.entity_name,
      input: r.input, before: r.before, after: r.after,
      reversible: !!r.reversible, reversePlan: r.reverse_plan,
      source: r.source, createdAt: r.created_at,
      undoneAt: r.undone_at, undoneByLogId: r.undone_by_log_id,
    };
  }

  async createAiActionLog(entry: InsertAiActionLog): Promise<AiActionLog | undefined> {
    const { data, error } = await this.supabase.from("ai_action_log").insert({
      user_id: this.userId,
      tool: entry.tool,
      action_type: entry.actionType,
      entity_type: entry.entityType ?? null,
      entity_id: entry.entityId ?? null,
      entity_name: entry.entityName ?? null,
      input: entry.input ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reversible: entry.reversible ?? false,
      reverse_plan: entry.reversePlan ?? null,
      source: entry.source || "chat",
    }).select().single();
    if (error) throw error;
    return data ? this.rowToAiActionLog(data) : undefined;
  }

  async listAiActionLog(opts: { limit?: number; entityType?: string; entityId?: string; includeUndone?: boolean } = {}): Promise<AiActionLog[]> {
    let q = this.supabase.from("ai_action_log").select("*")
      .eq("user_id", this.userId);
    if (opts.entityType) q = q.eq("entity_type", opts.entityType);
    if (opts.entityId) q = q.eq("entity_id", opts.entityId);
    if (!opts.includeUndone) q = q.is("undone_at", null);
    const { data, error } = await q.order("created_at", { ascending: false })
      .limit(Math.min(Math.max(opts.limit || 20, 1), 100));
    if (error) throw error;
    return (data || []).map(r => this.rowToAiActionLog(r));
  }

  async markActionUndone(id: string, undoneByLogId?: string): Promise<void> {
    const { error } = await this.supabase.from("ai_action_log")
      .update({ undone_at: new Date().toISOString(), undone_by_log_id: undoneByLogId ?? null })
      .eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
  }

  /**
   * ONE owner check for every restore path. The profile-delete cascade
   * (migrations/009_delete_profile_cascade.sql) only touches LIVE rows
   * (`deleted_at IS NULL`), so a row that was already in the bin when its
   * only owner was deleted keeps that owner's id. Restoring it later revived a
   * row whose linked_profiles pointed at nothing — visible in no scope, not
   * even "Everyone" (the orphan rule needs an EMPTY owner list for that).
   *
   * Called with the row the restore just un-deleted: drops owner ids that no
   * longer resolve to a live profile; if none survive, the row falls back to
   * the self profile (or to unowned when there is none). Ownership writes go
   * through the single writer (setOwners) like every other owner change.
   * Returns the owner list the row ends up with. Never throws — restoring the
   * row is the essential step; re-owning it is best-effort and logged.
   */
  private async _reownRestoredRow(entityType: OwnedEntityType | null, id: string, row: any): Promise<string[]> {
    const owners: string[] = Array.isArray(row?.linked_profiles)
      ? row.linked_profiles.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if (!entityType || owners.length === 0) return owners;
    try {
      // Live profiles only (the lite read filters deleted_at), straight from
      // the DB rather than the request memo, so a profile deleted earlier in
      // this same request is already gone here.
      const live = new Set((await this.getProfilesLite()).map(p => p.id));
      const kept = owners.filter(pid => live.has(pid));
      if (kept.length === owners.length) return owners;
      let next = kept;
      if (next.length === 0) {
        const self = await this.getSelfProfile();
        next = self ? [self.id] : [];
      }
      await this.applyOwnershipPatch(entityType, id, next);
      return next;
    } catch (e: any) {
      console.warn(`[restore] could not re-own ${entityType} ${id}: ${e?.message || e}`);
      return owners;
    }
  }

  /** Generic soft-delete restore (deleted_at = null) for entities without a
   *  dedicated restore method. Only tables that soft-delete are mapped. */
  async restoreEntity(entityType: string, id: string): Promise<boolean> {
    // Documents also need their owners' documents[] arrays re-linked.
    if (entityType === "document") return this.restoreDocument(id);
    // NOTE: obligation is not listed: deleteProfile is a hard cascade (the
    // RPC) and deleteObligation delegates to it — there is no row to
    // un-delete, so promising restore for it was a lie that surfaced as
    // "restore succeeded" toasts over permanently gone data. `profile` IS
    // listed for the one path that soft-deletes a profile row — a merge
    // archives its source with `deleted_at` — so "this can be undone" on a
    // merge holds; a hard-deleted profile matches no row and still answers
    // false (the row-count check below), never a false success.
    const TABLES: Record<string, string> = {
      task: "tasks", habit: "habits", expense: "expenses", income: "incomes",
      event: "events", reminder: "reminders", goal: "goals", profile: "profiles",
    };
    const table = TABLES[entityType];
    if (!table) return false;
    // `select("*")` rather than naming linked_profiles: reminders carry no
    // owner column, and the restore must not fail on the column list.
    const { data, error } = await this.supabase.from(table)
      .update({ deleted_at: null })
      .eq("id", id).eq("user_id", this.userId)
      .select("*");
    if (error) throw error;
    const ok = Array.isArray(data) && data.length > 0;
    if (ok) {
      const owned = (entityType in OWNERSHIP_TABLES) ? (entityType as OwnedEntityType) : null;
      await this._reownRestoredRow(owned, id, data[0]);
    }
    return ok;
  }

  // ============================================================
  // AI BULK PLANS (preview → confirm → execute)
  // ============================================================
  private rowToAiBulkPlan(r: any) {
    return {
      id: r.id, operation: r.operation, criteria: r.criteria,
      planHash: r.plan_hash, preview: r.preview, status: r.status,
      affected: r.affected, createdAt: r.created_at,
      expiresAt: r.expires_at, executedAt: r.executed_at,
    };
  }

  async createAiBulkPlan(plan: { operation: string; criteria: any; planHash: string; preview: any; expiresAt: string }) {
    const { data, error } = await this.supabase.from("ai_bulk_plans").insert({
      user_id: this.userId,
      operation: plan.operation,
      criteria: plan.criteria,
      plan_hash: plan.planHash,
      preview: plan.preview,
      expires_at: plan.expiresAt,
    }).select().single();
    if (error) throw error;
    return this.rowToAiBulkPlan(data);
  }

  async getAiBulkPlan(planId: string) {
    const { data, error } = await this.supabase.from("ai_bulk_plans")
      .select("*").eq("id", planId).eq("user_id", this.userId).maybeSingle();
    if (error) throw error;
    return data ? this.rowToAiBulkPlan(data) : undefined;
  }

  async getLatestPendingAiBulkPlan() {
    const { data, error } = await this.supabase.from("ai_bulk_plans")
      .select("*").eq("user_id", this.userId).eq("status", "pending")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    return data ? this.rowToAiBulkPlan(data) : undefined;
  }

  // ============================================================
  // USER NOTIFICATIONS (persisted custom rows; computed ones live
  // in server/notification-service.ts)
  // ============================================================
  private rowToUserNotification(r: any) {
    return {
      id: r.id, title: r.title, message: r.message, severity: r.severity,
      entityType: r.entity_type, entityId: r.entity_id,
      createdAt: r.created_at, readAt: r.read_at, dismissedAt: r.dismissed_at,
    };
  }

  async createUserNotification(n: { title: string; message?: string; severity?: string; entityType?: string; entityId?: string }) {
    const { data, error } = await this.supabase.from("user_notifications").insert({
      user_id: this.userId,
      title: n.title,
      message: n.message || "",
      severity: ["critical", "warning", "info"].includes(String(n.severity)) ? n.severity : "info",
      entity_type: n.entityType ?? null,
      entity_id: n.entityId ?? null,
    }).select().single();
    if (error) throw error;
    return this.rowToUserNotification(data);
  }

  async listUserNotifications(opts: { includeDismissed?: boolean; limit?: number } = {}) {
    let q = this.supabase.from("user_notifications").select("*").eq("user_id", this.userId);
    if (!opts.includeDismissed) q = q.is("dismissed_at", null);
    const { data, error } = await q.order("created_at", { ascending: false })
      .limit(Math.min(Math.max(opts.limit || 50, 1), 200));
    if (error) throw error;
    return (data || []).map(r => this.rowToUserNotification(r));
  }

  /** Stamp read_at / dismissed_at on custom notification rows. ids are the
   *  raw uuids (without the 'custom:' namespace prefix); empty = all unread/
   *  un-dismissed rows. Returns how many rows were stamped. */
  async markUserNotifications(field: "read" | "dismissed", ids?: string[]): Promise<number> {
    const col = field === "read" ? "read_at" : "dismissed_at";
    let q = this.supabase.from("user_notifications")
      .update({ [col]: new Date().toISOString() })
      .eq("user_id", this.userId).is(col, null);
    if (ids && ids.length > 0) q = q.in("id", ids);
    const { data, error } = await q.select("id");
    if (error) throw error;
    return Array.isArray(data) ? data.length : 0;
  }

  async setAiBulkPlanStatus(planId: string, status: string, patch?: { affected?: any; executedAt?: string }): Promise<void> {
    const { error } = await this.supabase.from("ai_bulk_plans")
      .update({
        status,
        ...(patch?.affected !== undefined ? { affected: patch.affected } : {}),
        ...(patch?.executedAt ? { executed_at: patch.executedAt } : {}),
      })
      .eq("id", planId).eq("user_id", this.userId);
    if (error) throw error;
  }

  /**
   * [P0.2] Optimistic concurrency for the updateX methods.
   *
   * Callers may include `expectedUpdatedAt` (the `updatedAt` they last read)
   * in a PATCH body. It is ALWAYS stripped from the patch here so it can
   * never be persisted. When the caller supplied a value and the row's
   * current updated_at no longer matches, another request modified the row
   * after the caller read it — throw a 409 ConflictError (routes'
   * asyncHandler forwards 4xx statusCode values as-is).
   *
   * Tables without an updated_at column pass `undefined` for
   * `currentUpdatedAt` and skip the comparison — there is nothing to compare
   * against (the strip still happens so the field never leaks into a write).
   */
  private assertNoWriteConflict(patch: Record<string, any>, currentUpdatedAt: string | null | undefined): void {
    if (!patch || typeof patch !== "object" || !("expectedUpdatedAt" in patch)) return;
    const expected = patch.expectedUpdatedAt;
    delete patch.expectedUpdatedAt;
    if (typeof expected !== "string" || !currentUpdatedAt) return;
    // String equality first (clients echo back exactly what the API returned);
    // fall back to millisecond comparison to tolerate timezone/precision
    // formatting differences between Postgres and the client.
    const expectedMs = Date.parse(expected);
    const currentMs = Date.parse(currentUpdatedAt);
    const matches = expected === currentUpdatedAt
      || (Number.isFinite(expectedMs) && Number.isFinite(currentMs) && expectedMs === currentMs);
    if (!matches) throw this.writeConflictError();
  }

  /**
   * [P0.2] Table-targeted variant: fetches the row's current updated_at only
   * when the caller actually sent expectedUpdatedAt (zero cost otherwise).
   * Every entity table carries updated_at maintained by a BEFORE UPDATE
   * trigger (verified live 2026-06-10), so the comparison is authoritative
   * even though some row mappers don't surface the column.
   */
  private async assertNoWriteConflictFor(table: string, id: string, patch: Record<string, any>): Promise<string | undefined> {
    if (!patch || typeof patch !== "object" || (patch as any).expectedUpdatedAt === undefined) return undefined;
    const { data: curRow } = await this.supabase.from(table)
      .select("updated_at").eq("id", id).eq("user_id", this.userId).maybeSingle();
    this.assertNoWriteConflict(patch, curRow?.updated_at);
    // The version the caller was checked against, in the column's own
    // spelling, so the write itself can be made conditional on it.
    return typeof curRow?.updated_at === "string" ? curRow.updated_at : undefined;
  }

  private writeConflictError(): Error {
    return Object.assign(
      new Error("Conflict: record was modified by another request"),
      { name: "ConflictError", statusCode: 409 },
    );
  }

  /**
   * Runs an UPDATE builder. With a `version` (the updated_at the caller was
   * checked against) the write only lands if the row still carries it —
   * the check above and the write are two round trips, and two same-version
   * edits arriving together both passed the check and both wrote, the
   * second silently over the first. Zero rows touched under a version is
   * the same 409 the pre-check raises.
   */
  private async guardedWrite(query: any, version: string | undefined): Promise<{ error: any }> {
    if (!version) return await query;
    const { data, error } = await query.eq("updated_at", version).select("id");
    if (error) return { error };
    if (!Array.isArray(data) || data.length === 0) throw this.writeConflictError();
    return { error: null };
  }

  // ---- ROW → OBJECT helpers ----
  // PostgreSQL uses snake_case; TypeScript uses camelCase.
  // JSONB columns are already parsed objects from Supabase.

  private rowToProfile(r: any): Profile {
    const fields = r.fields || {};
    return {
      id: r.id, type: r.type, name: r.name, avatar: r.avatar || undefined,
      type_key: r.type_key || undefined,
      fields, tags: r.tags || [], notes: r.notes || "",
      documents: r.documents || [], linkedTrackers: r.linked_trackers || [],
      linkedExpenses: r.linked_expenses || [], linkedTasks: r.linked_tasks || [],
      linkedEvents: r.linked_events || [],
      // FIX 2: read ONLY from the `parent_profile_id` column. The legacy JSON
      //   fallback is gone — it allowed a silently divergent shadow.
      parentProfileId: r.parent_profile_id || undefined,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  /** `trackerId` rides along (the column is always selected) so a by-id read
   *  says which tracker owns the entry — the by-id entry routes no longer have
   *  to scan a wide entry window to find the parent. */
  private rowToTrackerEntry(r: any): TrackerEntry & { trackerId: string } {
    return {
      id: r.id, trackerId: r.tracker_id, values: r.entry_values || {}, computed: r.computed || {},
      notes: r.notes || undefined, mood: r.mood || undefined,
      tags: r.tags || undefined, forProfile: r.for_profile || undefined,
      profileId: r.profile_id || undefined,
      timestamp: r.timestamp,
    };
  }

  private rowToTracker(r: any, entries: TrackerEntry[]): Tracker {
    return {
      id: r.id, name: r.name, category: r.category, unit: r.unit || undefined,
      icon: r.icon || undefined, fields: r.fields || [], entries,
      linkedProfiles: r.linked_profiles || [], createdAt: r.created_at,
      // PR H: surface canonical metric metadata. Older rows return null and
      // the client falls back to category defaults at render time.
      metricDefinition: r.metric_definition || undefined,
    };
  }

  private rowToTask(r: any): Task {
    return {
      id: r.id, title: r.title, description: r.description || undefined,
      status: r.status, priority: r.priority, dueDate: r.due_date || undefined,
      dueTime: r.due_time || undefined,
      linkedProfiles: r.linked_profiles || [], tags: r.tags || [], createdAt: r.created_at,
      updatedAt: r.updated_at || r.created_at,
    };
  }

  private rowToExpense(r: any): Expense {
    return {
      id: r.id, amount: Number(r.amount) || 0, category: r.category, description: r.description,
      vendor: r.vendor || undefined, isRecurring: r.is_recurring || undefined,
      linkedProfiles: r.linked_profiles || [], tags: r.tags || [],
      date: r.date, createdAt: r.created_at, updatedAt: r.updated_at || undefined,
    };
  }

  private rowToEvent(r: any): CalendarEvent {
    return {
      id: r.id, title: r.title, date: r.date, time: r.time || undefined,
      endTime: r.end_time || undefined, endDate: r.end_date || undefined,
      allDay: r.all_day || false, description: r.description || undefined,
      location: r.location || undefined, category: r.category as EventCategory,
      color: r.color || undefined, recurrence: r.recurrence as any,
      recurrenceEnd: r.recurrence_end || undefined,
      linkedProfiles: r.linked_profiles || [], linkedDocuments: r.linked_documents || [],
      tags: r.tags || [], source: r.source as any, createdAt: r.created_at,
      updatedAt: r.updated_at || undefined,
    };
  }

  private rowToDocument(r: any): Document {
    return {
      id: r.id, name: r.name, type: r.type, mimeType: r.mime_type,
      fileData: r.file_data || "", storagePath: r.storage_path || undefined,
      extractedData: r.extracted_data || {},
      linkedProfiles: r.linked_profiles || [], tags: r.tags || [],
      createdAt: r.created_at, updatedAt: r.updated_at || r.created_at,
    };
  }

  private rowToHabitCheckin(r: any): HabitCheckin {
    return {
      id: r.id, date: r.date, value: r.value ?? undefined,
      notes: r.notes || undefined, timestamp: r.timestamp,
    };
  }

  private rowToHabit(r: any, checkins: HabitCheckin[]): Habit {
    // Live streaks: the stored current_streak column is a snapshot from the
    // last check-in WRITE, so it silently goes stale as days pass without one
    // — a habit last checked Monday still showed "1🔥" on Thursday while its
    // never-checked neighbors showed 0. Recompute from the loaded check-ins on
    // every read; callers that don't load check-ins (deleted-habit listings)
    // keep the stored snapshot.
    const live = checkins.length > 0
      ? calculateStreak(checkins, r.target_per_day || 1, this._timezone, { frequency: r.frequency, targetDays: r.target_days || null, startDate: r.start_date || null, endDate: r.end_date || null } as HabitScheduleShape)
      : { current: r.current_streak || 0, longest: r.longest_streak || 0 };
    return {
      id: r.id, name: r.name, icon: r.icon || undefined, color: r.color || undefined,
      frequency: r.frequency, targetDays: r.target_days || undefined,
      targetPerDay: r.target_per_day || 1,
      startDate: r.start_date || undefined, endDate: r.end_date || undefined,
      timeOfDay: r.time_of_day || undefined,
      scheduledTime: r.scheduled_time || undefined,
      currentStreak: live.current, longestStreak: Math.max(live.longest, r.longest_streak || 0),
      linkedProfiles: r.linked_profiles || [],
      linkedTrackerId: r.linked_tracker_id || undefined,
      checkins, createdAt: r.created_at, updatedAt: r.updated_at || undefined,
    };
  }

  private rowToPayment(r: any): ObligationPayment {
    return {
      id: r.id, amount: Number(r.amount) || 0, date: r.date,
      method: r.method || undefined, confirmationNumber: r.confirmation_number || undefined,
    };
  }

  private rowToObligation(r: any, payments: ObligationPayment[]): Obligation {
    return {
      id: r.id, name: r.name, amount: Number(r.amount) || 0, frequency: r.frequency,
      category: r.category, nextDueDate: r.next_due_date, autopay: r.autopay || false,
      status: r.status || "active",
      // Wave 16 — new fields. Default sensibly so legacy rows still hydrate.
      kind: (r.kind as any) || "bill",
      leadTimeDays: typeof r.lead_time_days === "number" ? r.lead_time_days : 3,
      autoLogExpense: r.auto_log_expense === true,
      linkedAssetId: r.linked_asset_id || undefined,
      linkedLiabilityId: r.linked_liability_id || undefined,
      linkedDocumentId: r.linked_document_id || undefined,
      recurrenceEnd: r.recurrence_end || undefined,
      currency: r.currency || "USD",
      icon: r.icon || undefined,
      linkedProfiles: r.linked_profiles || [], payments,
      notes: r.notes || undefined, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private rowToArtifact(r: any): Artifact {
    const metadata = r.metadata || {};
    return {
      id: r.id, type: r.type, title: r.title, content: r.content || "",
      items: r.items || [], tags: r.tags || [], linkedProfiles: r.linked_profiles || [],
      pinned: r.pinned || false,
      language: metadata.language,
      dataBindings: metadata.dataBindings,
      chartData: metadata.chartData,
      chartType: metadata.chartType,
      // Doc/Sheet additions stored inside metadata JSON — no SQL migration needed.
      sheetData: metadata.sheetData,
      source: metadata.source,
      shareToken: metadata.shareToken,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private rowToJournalEntry(r: any): JournalEntry {
    return {
      id: r.id, date: r.date, mood: r.mood as MoodLevel, content: r.content || "",
      tags: r.tags || [], energy: r.energy ?? undefined,
      gratitude: r.gratitude || undefined, highlights: r.highlights || undefined,
      linkedProfiles: r.linked_profiles || [],
      createdAt: r.created_at,
    } as JournalEntry & { linkedProfiles: string[] };
  }

  private rowToMemory(r: any): MemoryItem {
    let value = r.value;
    if (typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX)) {
      try {
        value = decryptField(value);
      } catch (err) {
        // Tampered ciphertext, missing key, or AES-GCM auth failure — return
        // a marker so callers don't render raw enc:v1: blobs to users.
        value = "[decryption failed]";
      }
    }
    return {
      id: r.id, key: r.key, value, category: r.category,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private rowToDomain(r: any): Domain {
    return {
      id: r.id, name: r.name, slug: r.slug, icon: r.icon || undefined,
      color: r.color || undefined, description: r.description || undefined,
      fields: r.fields || [], createdAt: r.created_at,
    };
  }

  private rowToDomainEntry(r: any): DomainEntry {
    return {
      id: r.id, domainId: r.domain_id, values: r.entry_values || {},
      tags: r.tags || [], notes: r.notes || undefined, createdAt: r.created_at,
    };
  }

  private rowToGoal(r: any): Goal {
    return {
      id: r.id, title: r.title, type: r.type, target: r.target, current: r.current,
      unit: r.unit, startValue: r.start_value ?? undefined, deadline: r.deadline || undefined,
      trackerId: r.tracker_id || undefined, habitId: r.habit_id || undefined,
      category: r.category || undefined, status: r.status,
      milestones: r.milestones || [], linkedProfiles: r.linked_profiles || [],
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private rowToEntityLink(r: any): EntityLink {
    return {
      id: r.id, sourceType: r.source_type, sourceId: r.source_id,
      targetType: r.target_type, targetId: r.target_id,
      relationship: r.relationship, confidence: r.confidence,
      createdAt: r.created_at,
    };
  }

  // ============================================================
  // PROFILES
  // ============================================================
  async getProfiles(): Promise<Profile[]> {
    return this.memo("getProfiles", async () => {
      const { data, error } = await this.supabase.from("profiles").select("*").eq("user_id", this.userId).is("deleted_at", null);
      if (error) throw error;
      return this.healOwnerPrefixedProfileNames((data || []).map(r => this.rowToProfile(r)));
    });
  }

  // Self-heal legacy asset/vehicle names that carried a possessive owner prefix
  // ("Craig's Ford F250 2025" → "Ford F250 2025"). Only child/asset types are
  // touched, and only when the possessive owner matches the parent profile or a
  // known person/self name — people & pets keep their names verbatim, and brand
  // names ("Levi's") survive. Persists the rename once so the DB heals too.
  private CHILD_PROFILE_TYPES = new Set(["vehicle", "asset", "subscription", "loan", "investment", "account", "property"]);
  private async healOwnerPrefixedProfileNames(profiles: Profile[]): Promise<Profile[]> {
    if (!profiles.length) return profiles;
    const nameById = new Map(profiles.map(p => [p.id, p.name]));
    const personNames = profiles.filter(p => p.type === "person" || p.type === "self").map(p => p.name);
    const renames: Array<Promise<any>> = [];
    const healed = profiles.map(p => {
      if (!this.CHILD_PROFILE_TYPES.has(p.type as string)) return p;
      const parentName = p.parentProfileId ? nameById.get(p.parentProfileId) : undefined;
      const cleaned = stripOwnerPossessivePrefix(p.name, [parentName, ...personNames]);
      if (cleaned === p.name) return p;
      renames.push(
        (async () => { await this.supabase.from("profiles").update({ name: cleaned }).eq("id", p.id).eq("user_id", this.userId); })(),
      );
      return { ...p, name: cleaned };
    });
    if (renames.length) {
      try { await Promise.all(renames); } catch { /* display already clean; retry next read */ }
    }
    return healed;
  }

  /**
   * PERF: slim variant used by the MultiProfileFilter chip and any nav UI
   * that only needs id/type/name/avatar/parent. Skips heavy jsonb columns
   * (fields, documents, linked_*, tags, notes). Returned shape is a strict
   * subset of Profile so callers can treat it as Profile-compatible — extra
   * fields default to empty arrays/strings to keep the Profile contract.
   */
  async getProfilesLite(): Promise<Profile[]> {
    const { data, error } = await this.supabase
      .from("profiles")
      .select("id, type, type_key, name, avatar, parent_profile_id, created_at, updated_at")
      .eq("user_id", this.userId)
      .is("deleted_at", null);
    if (error) throw error;
    return (data || []).map((r: any): Profile => ({
      id: r.id,
      type: r.type,
      type_key: r.type_key || undefined,
      name: r.name,
      avatar: r.avatar || undefined,
      fields: {},
      tags: [],
      notes: "",
      documents: [],
      linkedTrackers: [],
      linkedExpenses: [],
      linkedTasks: [],
      linkedEvents: [],
      parentProfileId: r.parent_profile_id || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async getProfile(id: string): Promise<Profile | undefined> {
    const { data, error } = await this.supabase.from("profiles").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error || !data) return undefined;
    return this.rowToProfile(data);
  }

  async getProfileDetail(id: string): Promise<ProfileDetail | undefined> {
    const profile = await this.getProfile(id);
    if (!profile) return undefined;

    // FIX 4 Phase 2: query entity rows directly by JSONB containment — the
    // profile_<type> junction tables were dropped. `linked_profiles @> [id]`
    // (via PostgREST `.contains`) returns rows that link to this profile.
    // Trackers/entries/payments are pulled in the same parallel batch.
    //
    // CRITICAL — JSONB vs ARRAY literal syntax (see _applyProfileFilter):
    // linked_profiles is JSONB on trackers/expenses/tasks/events/documents/
    // obligations, so the containment value MUST be JSON: `JSON.stringify([id])`
    // → cs.["id"] → @> '["id"]'::jsonb. Passing a bare JS array `[id]` makes
    // supabase-js emit a PG array literal `cs.{id}` which casts to invalid JSON
    // and SILENTLY returns zero rows — that was the bug where a profile's own
    // documents/trackers/tasks never appeared in its tabs. journal_entries is a
    // text[] column, so it (and only it) keeps the bare `[id]` array form.
    const [
      allProfiles,
      trackersRes, expensesRes, tasksRes, eventsRes, documentsRes, obligationsRes,
      journalRows, habitsRes,
    ] = await Promise.all([
      this.getProfiles(),
      // FIX: linked_profiles is jsonb on these 6 tables. supabase-js .contains()
      // serializes the JS array as PostgREST `cs.{uuid}` array syntax, which is
      // invalid for jsonb columns (returns 22P02 "invalid input syntax for type
      // json"). The error was swallowed by `.then(r => r.data || [])`, so every
      // profile detail page showed 0 linked items. Use raw `.filter('cs', '[uuid]')`
      // with explicit JSON array syntax instead.
      this.supabase.from("trackers").select("*")
        .eq("user_id", this.userId).is("deleted_at", null).contains("linked_profiles", JSON.stringify([id]))
        .then(r => r.data || []),
      this.supabase.from("expenses").select("*")
        .eq("user_id", this.userId).is("deleted_at", null).contains("linked_profiles", JSON.stringify([id]))
        .then(r => r.data || []),
      this.supabase.from("tasks").select("*")
        .eq("user_id", this.userId).is("deleted_at", null).contains("linked_profiles", JSON.stringify([id]))
        .then(r => r.data || []),
      this.supabase.from("events").select("*")
        .eq("user_id", this.userId).is("deleted_at", null).contains("linked_profiles", JSON.stringify([id]))
        .then(r => r.data || []),
      this.supabase.from("documents")
        .select("id, user_id, name, type, mime_type, extracted_data, linked_profiles, tags, created_at, updated_at")
        .eq("user_id", this.userId).is("deleted_at", null).contains("linked_profiles", JSON.stringify([id]))
        .then(r => r.data || []),
      // Obligations retired — recurring bills are liability child profiles now,
      // so the profile timeline no longer needs a separate obligation feed.
      Promise.resolve([] as any[]),
      // journal_entries.linked_profiles is text[] (ARRAY) — .contains() works fine here.
      this.supabase.from("journal_entries")
        .select("*")
        .eq("user_id", this.userId)
        .is("deleted_at", null)
        .contains("linked_profiles", [id])
        .order("created_at", { ascending: false })
        .then(r => r.data || []),
      // habits.linked_profiles is JSONB → JSON containment form.
      this.supabase.from("habits").select("*")
        .eq("user_id", this.userId).is("deleted_at", null).contains("linked_profiles", JSON.stringify([id]))
        .then(r => r.data || []),
    ]);

    const trackerIds = (trackersRes as any[]).map((r: any) => r.id);
    const obligationIds = (obligationsRes as any[]).map((r: any) => r.id);
    const habitIds = (habitsRes as any[]).map((r: any) => r.id);
    const [trackerEntryRows, obligationPaymentRows, habitCheckinRows, trackerEntriesExactTotal] = await Promise.all([
      // PERF 2026-07-08: cap at the 1000 most recent entries. This fetch was
      // unbounded — a profile with a dense tracker (e.g. daily weight for
      // years) shipped every row on every profile open, dominating both the
      // query time and the JSON payload. Newest-first ordering means the cap
      // drops only the oldest history; the profile page's charts/timeline
      // show recent activity, and full history stays available through the
      // trackers page's own paginated fetches.
      trackerIds.length > 0
        ? this.supabase.from("tracker_entries").select("*").eq("user_id", this.userId).in("tracker_id", trackerIds).is("deleted_at", null).order("timestamp", { ascending: false }).limit(1000).then(r => r.data || [])
        : Promise.resolve([] as any[]),
      // Obligations retired — no separate obligation payment feed on the timeline.
      Promise.resolve([] as any[]),
      habitIds.length > 0
        ? this.supabase.from("habit_checkins").select("*").eq("user_id", this.userId).in("habit_id", habitIds).order("date", { ascending: true }).then(r => r.data || [])
        : Promise.resolve([] as any[]),
      // PERF 2026-07-21: exact entry count (head-only — no rows shipped) so the
      // client can show "Show all N" even when the 1000-row fetch above and the
      // per-tracker cap below trimmed the embedded history.
      trackerIds.length > 0
        ? this.supabase.from("tracker_entries").select("id", { count: "exact", head: true }).eq("user_id", this.userId).in("tracker_id", trackerIds).is("deleted_at", null).then(r => r.count ?? 0)
        : Promise.resolve(0),
    ]);

    // Build lookup maps for entries/payments
    const entriesByTracker = new Map<string, any[]>();
    for (const e of trackerEntryRows) {
      if (!entriesByTracker.has(e.tracker_id)) entriesByTracker.set(e.tracker_id, []);
      entriesByTracker.get(e.tracker_id)!.push(e);
    }
    const paymentsByObligation = new Map<string, any[]>();
    for (const p of obligationPaymentRows) {
      if (!paymentsByObligation.has(p.obligation_id)) paymentsByObligation.set(p.obligation_id, []);
      paymentsByObligation.get(p.obligation_id)!.push(p);
    }
    const checkinsByHabit = new Map<string, any[]>();
    for (const c of habitCheckinRows) {
      if (!checkinsByHabit.has(c.habit_id)) checkinsByHabit.set(c.habit_id, []);
      checkinsByHabit.get(c.habit_id)!.push(c);
    }

    // Map DB rows to domain objects
    const relatedTrackers = (trackersRes as any[]).map((r: any) => this.rowToTracker(r, (entriesByTracker.get(r.id) || []).map((e: any) => this.rowToTrackerEntry(e))));
    const relatedExpenses = (expensesRes as any[]).map((r: any) => this.rowToExpense(r));
    const relatedTasks = (tasksRes as any[]).map((r: any) => this.rowToTask(r));
    const relatedEvents = (eventsRes as any[]).map((r: any) => this.rowToEvent(r));
    const relatedDocuments = (documentsRes as any[]).map((r: any) => this.rowToDocument({ ...r, file_data: "" }));
    const relatedObligations = (obligationsRes as any[]).map((r: any) => this.rowToObligation(r, (paymentsByObligation.get(r.id) || []).map((p: any) => this.rowToPayment(p))));
    const relatedJournal = (journalRows as any[]).map((r: any) => this.rowToJournalEntry(r));
    const relatedHabits = (habitsRes as any[]).map((r: any) => this.rowToHabit(r, (checkinsByHabit.get(r.id) || []).map((c: any) => this.rowToHabitCheckin(c))));

    // Child profiles: profiles whose parentProfileId points to this profile.
    // PLUS: assets/liabilities where this profile is a CO-OWNER via the link
    // tables. Rule: co-ownership only applies to asset & liability profiles,
    // and a co-owned item must surface on each owner's individual profile
    // page — e.g. Home (parented to Test) appears on Jane's page because Jane
    // owns 50% via asset_party_links. We tag the synthetic adds with a
    // `_coOwner: true` marker so the UI can show them with the right framing.
    const directChildren = allProfiles.filter(p => p.parentProfileId === id);
    const childProfiles: any[] = [...directChildren];
    const isPersonLike = profile.type === "self" || profile.type === "person" || profile.type === "pet";
    // PERF 2026-07-08: fetch each ownership link table ONCE and reuse it for
    // both the co-owner child derivation here and the ownership-share
    // annotation below. Previously this method queried asset_party_links and
    // liability_profile_links twice each (a ForParty query + an unfiltered
    // one). The full-table variants are also request-memoized, so the
    // profile-bootstrap route's own link fetch shares the same round-trip.
    let allAssetLinks: any[] = [];
    let allLiabLinks: any[] = [];
    if (isPersonLike) {
      [allAssetLinks, allLiabLinks] = await Promise.all([
        this.getAssetPartyLinks().catch(() => [] as any[]),
        this.getLiabilityProfileLinks().catch(() => [] as any[]),
      ]);
      try {
        const assetLinks = allAssetLinks.filter((l: any) => l?.partyProfileId === id);
        const liabLinks = allLiabLinks.filter((l: any) => l?.partyProfileId === id);
        const seen = new Set(directChildren.map(p => p.id));
        for (const l of assetLinks || []) {
          const aid = (l as any).assetProfileId;
          if (!aid || seen.has(aid)) continue;
          const a = allProfiles.find(p => p.id === aid);
          if (!a) continue;
          // Only assets surface as co-owned children, per the rule. Use the
          // canonical ASSET_PROFILE_TYPES set so co-owned accounts/loans/etc.
          // surface too (the old hardcoded list dropped `account` and `loan`).
          if (!isAssetProfile(a)) continue;
          seen.add(aid);
          childProfiles.push({ ...a, _coOwner: true, _ownershipPercentage: (l as any).ownershipPercentage });
        }
        for (const l of liabLinks || []) {
          const lid = (l as any).liabilityProfileId;
          if (!lid || seen.has(lid)) continue;
          const x = allProfiles.find(p => p.id === lid);
          if (!x) continue;
          if (!isLiabilityProfile(x) && x.type !== "subscription") continue;
          seen.add(lid);
          childProfiles.push({ ...x, _coOwner: true, _ownershipPercentage: (l as any).ownershipPercentage });
        }
      } catch (e) {
        // Non-fatal — fall back to the parent-only child list.
        console.warn("getProfile: co-owner link lookup failed:", (e as any)?.message || e);
      }
    }

    // Build timeline from all related entities
    const timeline: TimelineEntry[] = [];
    for (const t of relatedTrackers) {
      for (const e of t.entries) {
        timeline.push({ id: e.id, type: "tracker", title: `${t.name} logged`, description: Object.entries(e.values).map(([k, v]) => `${k}: ${v}`).join(", "), data: { ...e.values, computed: e.computed, trackerId: t.id }, timestamp: e.timestamp });
      }
    }
    for (const e of relatedExpenses) timeline.push({ id: e.id, type: "expense", title: e.description, description: `$${e.amount} - ${e.category}`, timestamp: e.date });
    for (const t of relatedTasks) timeline.push({ id: t.id, type: "task", title: t.title, description: `${t.status} - ${t.priority}`, timestamp: t.createdAt });
    for (const e of relatedEvents) timeline.push({ id: e.id, type: "event", title: e.title, description: e.description, timestamp: e.date });
    for (const d of relatedDocuments) timeline.push({ id: d.id, type: "document", title: d.name, description: d.type, timestamp: d.createdAt });
    for (const o of relatedObligations) timeline.push({ id: o.id, type: "obligation", title: o.name, description: `$${o.amount}/${o.frequency}`, timestamp: o.createdAt });
    for (const j of relatedJournal) timeline.push({ id: j.id, type: "journal", title: j.content?.slice(0, 80) || "Journal entry", description: j.mood ? `Mood: ${j.mood}` : undefined, timestamp: j.date || (j as any).createdAt });
    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Annotate each asset/liability child with THIS profile's ownership share
    // (single source of truth = shared/ownership-model). Co-ownership drives
    // both visibility and the per-row financial figure: e.g. a car Bob owns 50%
    // of shows `_ownershipPercentage: 50` so the UI can badge "owns 50%" and
    // render half the value. Items with no explicit owners are left unannotated
    // (treated as wholly the viewer's / contained), so plain nested children
    // don't sprout a confusing "0%". Only meaningful for person-like profiles.
    if (isPersonLike && childProfiles.length > 0) {
      try {
        // Reuses the link tables fetched once above — no extra round-trips.
        const selfId2 = allProfiles.find(p => p.type === "self")?.id || null;
        const assetLinksByItem = new Map<string, OwnershipLink[]>();
        for (const l of (allAssetLinks as any[]) || []) {
          if (!l?.assetProfileId || !l?.partyProfileId) continue;
          if (!assetLinksByItem.has(l.assetProfileId)) assetLinksByItem.set(l.assetProfileId, []);
          assetLinksByItem.get(l.assetProfileId)!.push({ partyProfileId: l.partyProfileId, ownershipPercentage: Number(l.ownershipPercentage ?? 100), role: l.role });
        }
        const liabLinksByItem = new Map<string, OwnershipLink[]>();
        for (const l of (allLiabLinks as any[]) || []) {
          if (!l?.liabilityProfileId || !l?.partyProfileId) continue;
          if (!liabLinksByItem.has(l.liabilityProfileId)) liabLinksByItem.set(l.liabilityProfileId, []);
          liabLinksByItem.get(l.liabilityProfileId)!.push({ partyProfileId: l.partyProfileId, ownershipPercentage: Number(l.ownershipPercentage ?? 100), role: l.role });
        }
        for (const child of childProfiles) {
          const links = assetLinksByItem.get(child.id) || liabLinksByItem.get(child.id);
          if (!links || links.length === 0) continue; // no explicit owners → leave unannotated
          const share = shareForParty(id, links, selfId2);
          if (share <= 0) continue; // contained but not owned by this person → show gross, no "0%"
          child._ownershipPercentage = share;
          child._coOwner = true;
        }
      } catch (e) {
        console.warn("getProfileDetail: ownership-share annotation failed:", (e as any)?.message || e);
      }
    }

    // COST OF OWNERSHIP — surface the expenses of the assets this person owns,
    // WITHOUT duplicating any record. Each asset's costs are linked to the ASSET
    // (single row/link); we derive them here for the owner's view so they can
    // see the full cost of ownership. Nothing is written; aggregates that sum
    // the distinct expense set still count each expense exactly once.
    let ownedAssetExpenses: any[] = [];
    if (isPersonLike && childProfiles.length > 0) {
      try {
        const ownedAssets = childProfiles.filter((c: any) => isAssetProfile(c));
        if (ownedAssets.length > 0) {
          const allExpenses = await this.getExpenses();
          const directIds = new Set(relatedExpenses.map((e: any) => e.id));
          ownedAssetExpenses = collectOwnedAssetExpenses(
            ownedAssets.map((a: any) => ({ id: a.id, name: a.name, type: a.type, _ownershipPercentage: a._ownershipPercentage })),
            allExpenses as any[],
            directIds,
          ).map((r) => ({ ...r.expense, _viaAsset: r.viaAsset, _ownershipPercentage: r.ownershipPercentage }));
        }
      } catch (e) {
        console.warn("getProfileDetail: cost-of-ownership derivation failed:", (e as any)?.message || e);
      }
    }

    // `relatedJournal` is added to the returned shape so the profile detail
    // page can render a journal section. Existing keys are unchanged.
    //
    // PERF 2026-07-21 (large-profile first paint): cap each embedded list to
    // the most recent N before serialization — a data-heavy profile (1000s of
    // entries/expenses) was shipping multi-MB JSON on every open. ALL caps are
    // additive: field names/shapes are unchanged and sibling *Total/*Sum
    // fields carry the true figures so the client can show exact headline
    // stats and "Show all N" (full lists load lazily via the existing
    // /api/expenses?profileId=, /api/events?profileIds=, /api/journal?profileIds=,
    // /api/documents?profileId= and /api/trackers/:id endpoints).
    const capped = capProfileDetailLists({
      relatedTrackers, relatedExpenses, relatedEvents, relatedDocuments, relatedJournal, timeline,
      profileId: id,
      trackerEntriesExactTotal: trackerEntriesExactTotal as number,
    });
    return { ...profile, ...capped, relatedTasks, relatedObligations, relatedHabits, childProfiles, ownedAssetExpenses } as any;
  }

  async createProfile(data: InsertProfile): Promise<Profile> {
    // ── The last write path ────────────────────────────────────────────────
    //
    // Normalizing dates in the routes and the AI tools covers every caller
    // that exists TODAY. Doing it here as well covers every caller, full stop
    // — a script, a migration, a tool added next month. A date is stored in
    // one form because the storage layer will not accept another, so the
    // question "can an actionable date be saved without its rule following?"
    // has a structural answer rather than an inventory of call sites.
    // See shared/date-rules.
    if (data.fields && typeof data.fields === "object") {
      data = { ...data, fields: prepareProfileFields(normalizeEntityDateFields(data.fields as Record<string, any>, { contextKey: String(data.type ?? "") }).fields, { typeKey: (data as any).type_key ?? (data as any).typeKey, todayISO: getUserToday(this._timezone) }) };
    }
    const validProfileTypes = new Set(["self", "person", "pet", "vehicle", "asset", "subscription", "loan", "liability", "investment", "property", "account", "insurance", "medical"]);
    if (data.type && !validProfileTypes.has(data.type)) data.type = "person";
    // NAME NORMALIZATION (BUG-20260709-double-profile): strip a leading
    // "a/an/the/my [new] <type> named/called " descriptor that the model
    // sometimes passes as the literal name ("a person named Mike" → "Mike").
    // Done HERE — the single chokepoint every create path funnels through — so
    // the AI tool executor, the REST route, and the dedup below all see the
    // clean name. Without this the junk-named twin dodged the same-name dedup.
    if (typeof data.name === "string" && data.name.trim()) {
      data.name = data.name
        .replace(/^\s*(?:a|an|the|my)\s+(?:new\s+)?(?:person|people|pet|dog|cat|animal|profile|vehicle|car|truck|asset|property|house|home|account|subscription|loan|liability)?\s*(?:named|called)\s+/i, "")
        .replace(/^\s*(?:named|called)\s+/i, "")
        .trim();
    }
    // DEDUP people/pets (BUG-20260709-double-profile): the AI chat path calls
    // this directly (bypassing the REST route's findBlockingDuplicateProfile),
    // and the model sometimes emits TWO create_profile calls for one request —
    // e.g. "create a profile for a person named Mike" produced BOTH "Mike" and a
    // junk "a person named Mike". People and pets must not duplicate on an exact
    // (case-insensitive, trimmed) name for the same user. Assets/vehicles/etc CAN
    // legitimately repeat (two "Samsung TV"s), so this only guards person/pet.
    if ((data.type === "person" || data.type === "pet") && typeof data.name === "string" && data.name.trim()) {
      // Query the DB DIRECTLY (not the request-memoized getProfiles) so that a
      // second create_profile in the SAME chat turn sees the row the first one
      // just inserted — otherwise a stale memo lets the twin slip through.
      const { data: rows } = await this.supabase
        .from("profiles")
        .select("id")
        .eq("user_id", this.userId)
        .eq("type", data.type)
        .ilike("name", data.name.trim())
        .limit(1);
      if (rows && rows.length > 0) {
        const existing = await this.getProfile(rows[0].id);
        if (existing) return existing;
      }
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    // Auto-assign parent to self profile if not specified for child types
    const childTypes = new Set(["vehicle", "asset", "subscription", "loan", "liability", "investment", "account", "property"]);
    let parentProfileId = data.parentProfileId;
    if (!parentProfileId && childTypes.has(data.type)) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) parentProfileId = selfProfile.id;
    }
    // Parent is stored ONLY in the `parent_profile_id` column. The legacy
    //   `fields._parentProfileId` JSON shadow is no longer written — it caused
    //   silent disagreement when the column and JSON drifted (3 such rows
    //   existed in production before the FIX 2 backfill).
    const fields = { ...(data.fields || {}) };
    if ("_parentProfileId" in fields) delete fields._parentProfileId;
    const insertData: any = {
      id, user_id: this.userId, type: data.type, name: data.name,
      fields, tags: data.tags || [], notes: data.notes || "",
      documents: [], linked_trackers: [], linked_expenses: [],
      linked_tasks: [], linked_events: [], created_at: now, updated_at: now,
    };
    // Persist type_key (registry key) so liability subtype, asset registry,
    // etc. survive a round-trip through the DB. Without this, the client
    // sends type_key but it's silently dropped — making the subtype badge
    // and registry lookups fall back to generic labels.
    if ((data as any).type_key) {
      insertData.type_key = (data as any).type_key;
    }
    // Write to the real column if it exists (Phase 1 migration adds it)
    if (parentProfileId) {
      insertData.parent_profile_id = parentProfileId;
    }
    const { error } = await this.supabase.from("profiles").insert(insertData);
    if (error) throw error;
    this.logActivity("profile", `Created profile: ${data.name}`);

    // Auto-generate calendar events from profile date fields

    // ---- Default-ownership hook ----
    // For new asset/liability profiles with no explicit ownership, auto-link the
    // OWNING party at 100%. See ensureAutoOwnerLink for the resolution rules.
    // Best-effort — must not break the create response if it fails.
    await this.ensureAutoOwnerLink(id, data.type, parentProfileId ?? null);

    return (await this.getProfile(id))!;
  }

  /**
   * Ensure an asset/liability profile carries an OWNER party link at 100% when
   * it has no explicit ownership yet. The owner is resolved from the parent
   * chain (resolveAutoOwner): a non-Self person parent means that person owns
   * it; a Self parent (or no parent) means Self owns it. Linking Self
   * unconditionally was the Jane Doe bug — it claimed every person's asset for
   * Self (net worth $0) and, once a competing person link was added, the
   * SUM>100 DB trigger split both to 50/50.
   *
   * Idempotent + best-effort: safe to call on create, on the createObligation
   * upsert path, and as a lazy self-heal when a profile's parties are read
   * (older bills that resolved to an existing shell never got a link). Returns
   * the party id that was linked (or already present), or null.
   */
  private async ensureAutoOwnerLink(
    id: string,
    type: string,
    parentProfileId: string | null,
  ): Promise<string | null> {
    try {
      const assetTypes = new Set(["asset", "vehicle", "property"]);
      const liabilityTypes = new Set(["liability", "loan"]);
      const isAsset = assetTypes.has(type);
      const isLiability = liabilityTypes.has(type);
      if (!isAsset && !isLiability) return null;
      // If a parent wasn't supplied (upsert/heal path), read it off the row.
      let parent = parentProfileId;
      if (parent == null) {
        const self = await this.getProfile(id).catch(() => null as any);
        parent = (self as any)?.parentProfileId ?? null;
      }
      const selfProfile = await this.getSelfProfile();
      const allProfiles = await this.getProfiles().catch(() => [] as any[]);
      const ownerProfileId = resolveAutoOwner(parent, allProfiles as any, selfProfile?.id ?? null);
      if (!ownerProfileId || ownerProfileId === id) return null;
      if (isAsset) {
        const existing = await this.getAssetPartyLinks(id).catch(() => [] as any[]);
        if ((existing || []).length > 0) return (existing[0] as any)?.partyProfileId ?? null;
        await this.createAssetPartyLink({
          assetProfileId: id, partyProfileId: ownerProfileId, ownershipPercentage: 100, role: "owner",
        } as any).catch((e: any) => console.warn("[auto-ownership] asset link failed:", e?.message || e));
      } else {
        const existing = await this.getLiabilityProfileLinks(id).catch(() => [] as any[]);
        if ((existing || []).length > 0) return (existing[0] as any)?.partyProfileId ?? null;
        await this.createLiabilityProfileLink({
          liabilityProfileId: id, partyProfileId: ownerProfileId, ownershipPercentage: 100, role: "owner",
        } as any).catch((e: any) => console.warn("[auto-ownership] liability link failed:", e?.message || e));
      }
      return ownerProfileId;
    } catch (autoOwnErr: any) {
      console.warn("[auto-ownership] hook failed:", autoOwnErr?.message || autoOwnErr);
      return null;
    }
  }

  /** Public self-heal used by the parties route to backfill legacy rows. */
  async ensureLiabilityOwnerLink(id: string): Promise<void> {
    await this.ensureAutoOwnerLink(id, "liability", null);
  }

  /** Auto-create calendar events for profile date fields */
  // (Removed 2026-08-20: `autoGenerateProfileEvents`.
  //
  // Its stated rule was "generate an event ONLY for a date the occurrence
  // engine cannot derive from the profile itself" — and every field it had left
  // (leaseEnd, insuranceExpiry, nextService, warrantyExpiry, maturityDate,
  // expirationDate, nextVisit, nextVetVisit, startDate) is derived now, by the
  // Date Rule engine. So it had no remaining job, and kept doing it: each of
  // those dates rendered twice, once as the derived rule and once as the event
  // row this wrote. The shadow pass could not save it either — that only covers
  // birthdays, anniversaries and document-linked extraction events.
  //
  // This was the last WRITE-side date duplicator. Nothing generates a calendar
  // row for a date a record already owns.)

  async updateProfile(
    id: string,
    data: Partial<Profile> & { fieldsToDelete?: string[] }
  ): Promise<Profile | undefined> {
    let existing = await this.getProfile(id);
    if (!existing) return undefined;
    // [P0.2] optimistic concurrency — 409 if the row moved since the caller read it.
    this.assertNoWriteConflict(data as Record<string, any>, existing.updatedAt);
    for (let attempt = 0; ; attempt++) {
      const out = await this.writeProfilePatch(id, data, existing);
      if (out !== PROFILE_WRITE_COLLIDED) return out;
      if (attempt >= 6) throw Object.assign(new Error("Profile edit kept colliding with another writer; try again"), { statusCode: 409 });
      this.clearRequestMemo();
      existing = await this.getProfile(id);
      if (!existing) return undefined;
    }
  }

  /**
   * Read-modify-write on a profile with the patch RECOMPUTED from the fresh
   * row on every retry. updateProfile retries a fixed patch, which keeps two
   * edits to different fields from losing one; it cannot help a caller whose
   * patch is derived from what it read (a balance delta, a payment's split):
   * that retry wrote the stale figure over the other writer's, so two
   * adjustments in flight together moved the balance once. `fn` returns the
   * patch for the row it is handed, or null to write nothing.
   */
  async mutateProfileFields(
    id: string,
    fn: (fresh: Profile) => (Partial<Profile> & { fieldsToDelete?: string[] }) | null,
  ): Promise<Profile | undefined> {
    for (let attempt = 0; ; attempt++) {
      this.clearRequestMemo();
      const fresh = await this.getProfile(id);
      if (!fresh) return undefined;
      const patch = fn(fresh);
      if (!patch) return fresh;
      const out = await this.writeProfilePatch(id, patch, fresh);
      if (out !== PROFILE_WRITE_COLLIDED) return out;
      if (attempt >= 6) throw Object.assign(new Error("Profile edit kept colliding with another writer; try again"), { statusCode: 409 });
      await new Promise((r) => setTimeout(r, 10 + attempt * 20));
    }
  }

  /** One attempt at writing `data` over `existing`; PROFILE_WRITE_COLLIDED when the row moved since `existing` was read. */
  private async writeProfilePatch(
    id: string,
    data: Partial<Profile> & { fieldsToDelete?: string[] },
    existing: Profile,
  ): Promise<Profile | undefined | typeof PROFILE_WRITE_COLLIDED> {
    // Universal-delete: expand UI keys into the full storage-side alias set,
    // then ALSO strip those keys from every nested group. Without this step,
    // deleting "birthday" on a person profile only removes the top-level
    // `birthday` key while `dateOfBirth` (top-level) and `personal.dateOfBirth`
    // (nested) survive — and flatten promotes them right back on the next read.
    // See PROFILE_KEY_ALIAS_REVERSE + PROFILE_NESTED_GROUPS at the top of this
    // file for the topology this depends on (kept in lockstep with the client).
    // UNIVERSAL DELETE (2026-07-25). Deletion now matches on field IDENTITY
    // (shared/profile-field-identity), not on exact key strings.
    //
    // The old path expanded a UI key through a hand-maintained alias table and
    // then did `delete base[k]` / `k in nested`. Any spelling missing from that
    // table — `license_number`, `LICENSE NUMBER`, `licenseNo` — survived, and
    // the flattener promoted it straight back on the next read, so the field
    // looked undeletable. `deleteProfileFields` sweeps the top level AND every
    // nested group, comparing normalized identities, so one spelling cannot
    // hide behind another.
    // UNIVERSAL WRITE (2026-08-20). A write says what the field IS now, so it
    // SUPERSEDES every other spelling of that field — matched on identity, at
    // the top level and inside every nested group.
    //
    // The exact-key merge this replaced is why editing "Address" on a profile
    // whose value lives in `personal.address` (or under `streetAddress`) added
    // a second row instead of changing the one on screen, and why an AI
    // update_profile writing a different spelling piled up a twin. Only the
    // confirm-extraction route did the supersede, inline — every other door
    // into a profile skipped it. It lives here now so all of them get it.
    //
    // …and the same argument applies to DATES. Normalizing them in the routes
    // and the AI tools covers every caller that exists today; doing it here
    // covers every caller full stop — a script, a migration, a tool added next
    // month. A date is stored in one form because the storage layer will not
    // take another, so "can an actionable date be saved without its rule
    // following?" has a structural answer rather than an inventory of call
    // sites. See shared/date-rules.
    //
    // Deletion intents (null / undefined values) are pulled out FIRST: those
    // keys are being removed, not written, and must not sweep their own twins.
    const normalizedIncoming = data.fields && typeof data.fields === "object"
      ? prepareProfileFields(normalizeEntityDateFields(data.fields as Record<string, any>, { contextKey: String(data.type ?? existing.type ?? "") }).fields, { typeKey: (data as any).type_key ?? (existing as any).type_key ?? (existing as any).typeKey, todayISO: getUserToday(this._timezone) })
      : data.fields;
    const incomingFields: Record<string, any> = {};
    const deletionIntents: string[] = [];
    for (const [k, v] of Object.entries(normalizedIncoming || {})) {
      if (v === null || v === undefined) deletionIntents.push(k);
      else incomingFields[k] = v;
    }
    const write = mergeFieldWrite(existing.fields || {}, incomingFields);
    // Superseded twins come back as null markers — drop exactly those, so a
    // null a caller legitimately stored on some other field survives untouched.
    const supersededOut: Record<string, any> = { ...write.fields };
    for (const k of write.superseded) delete supersededOut[k];
    const mergedFields = mergeAndApplyDeletes(
      supersededOut,
      Object.fromEntries(deletionIntents.map((k) => [k, null])) as any,
      null,
    );
    const deletion = deleteProfileFields(
      mergedFields as Record<string, any>,
      data.fieldsToDelete,
      (data as any).fieldPathsToDelete,
    );
    const finalFields = deletion.fields;
    if (deletion.removed.length > 0) {
      console.log(`[profile-delete] ${id} removed ${deletion.removed.length} key(s): ${deletion.removed.join(", ")}`);
    }
    const merged = { ...existing, ...data, fields: finalFields };
    const now = new Date().toISOString();
    // Only the columns this patch names: two edits to different columns of
    // one profile in flight together used to lose the earlier one.
    const updateData: any = onlyPatched({
      type: merged.type, name: merged.name, avatar: merged.avatar || null,
      fields: merged.fields, tags: merged.tags, notes: merged.notes,
      documents: merged.documents, updated_at: now,
      // JSONB linked_trackers/expenses/tasks/events are deprecated — junction tables are source of truth
    }, data as Record<string, any>, { type: "type", name: "name", avatar: "avatar", fields: "fields", tags: "tags", notes: "notes", documents: "documents" });
    if ((data as any).fieldsToDelete?.length || (data as any).fieldPathsToDelete?.length) updateData.fields = merged.fields;
    // Optional FK fields (linked_obligation_id column dropped — obligations retired)
    if (data.parentProfileId !== undefined) updateData.parent_profile_id = data.parentProfileId || null;
    if ((data as any).type_key !== undefined) updateData.type_key = (data as any).type_key || null;
    if (updateData.fields !== undefined) {
      // `fields` is one JSON map merged from what was read: write it only if
      // nobody else wrote the row since that read, else re-read and re-merge.
      // (The pay claim and the occurrence writer use the same guard.)
      let guarded = this.supabase.from("profiles").update(updateData).eq("id", id).eq("user_id", this.userId);
      guarded = existing.updatedAt ? guarded.eq("updated_at", existing.updatedAt as any) : guarded.is("updated_at", null);
      const { data: written, error } = await guarded.select("id");
      if (error) throw error;
      if (!Array.isArray(written) || written.length === 0) return PROFILE_WRITE_COLLIDED;
    } else {
      const { error } = await this.supabase.from("profiles").update(updateData).eq("id", id).eq("user_id", this.userId);
      if (error) throw error;
    }

    // (No auto-generated events here any more. Editing a profile date changes
    // the date; the calendar is a view of it, so there is nothing to write.)

    return this.getProfile(id);
  }

  /**
   * Per-person budgets live as JSON under `budget:<month>` in preferences,
   * which the SQL cascade never touches: a deleted person's caps stayed in
   * every month and kept counting in the everyone-mode total (D127). Drop
   * the person's entries from each month that has them. Best effort — the
   * profile is already gone; a failed prune is logged, not surfaced.
   */
  private async pruneBudgetsForProfile(profileId: string): Promise<void> {
    try {
      const all = await this.getAllBudgets();
      for (const [month, arr] of Object.entries(all)) {
        if (!Array.isArray(arr) || !arr.some((b: any) => b?.profileId === profileId)) continue;
        await this.mutateBudgets(month, (list) => { const kept = list.filter((b: any) => b?.profileId !== profileId); list.splice(0, list.length, ...kept); });
      }
    } catch (e: any) {
      console.warn(`[deleteProfile] budget prune for ${profileId} failed: ${e?.message || e}`);
    }
  }

  /**
   * The shares a profile holds on other people's assets and loans, keyed by
   * subject, captured BEFORE the delete cascade drops the link rows.
   */
  private async capturePartyShares(partyId: string): Promise<Array<{ kind: "asset" | "liability"; subjectId: string; others: Array<{ partyProfileId: string; ownershipPercentage: number }> }>> {
    const out: Array<{ kind: "asset" | "liability"; subjectId: string; others: Array<{ partyProfileId: string; ownershipPercentage: number }> }> = [];
    try {
      const [assetLinks, liabLinks] = await Promise.all([
        this.getAssetPartyLinks().catch(() => [] as any[]),
        this.getLiabilityProfileLinks().catch(() => [] as any[]),
      ]);
      const collect = (rows: any[], kind: "asset" | "liability", subjectKey: string) => {
        const mine = new Set((rows || []).filter((l) => l?.partyProfileId === partyId).map((l) => String(l[subjectKey])));
        for (const subjectId of mine) {
          const others = (rows || [])
            .filter((l) => String(l[subjectKey]) === subjectId && l.partyProfileId !== partyId && l.partyProfileId)
            .map((l) => ({ partyProfileId: l.partyProfileId, ownershipPercentage: Number(l.ownershipPercentage ?? 0) }));
          out.push({ kind, subjectId, others });
        }
      };
      collect(assetLinks as any[], "asset", "assetProfileId");
      collect(liabLinks as any[], "liability", "liabilityProfileId");
    } catch { /* best effort — the delete itself is the priority */ }
    return out;
  }

  /**
   * A deleted co-owner's share goes back to the remaining owners pro rata
   * (one remaining owner → 100%). The cascade only dropped the link row, so
   * the car sat at "Self 50%" with the other half held by nobody and Self's
   * net worth undercounted an asset that was now wholly theirs (D139).
   * No remaining owner ⇒ no link rows ⇒ the asset is Self's by convention.
   */
  private async redistributePartyShares(shares: Array<{ kind: "asset" | "liability"; subjectId: string; others: Array<{ partyProfileId: string; ownershipPercentage: number }> }>): Promise<void> {
    for (const sh of shares) {
      try {
        const scaled = scaleSharesTo100(sh.others.filter((o) => o.partyProfileId));
        if (!scaled) continue;
        if (sh.kind === "asset") await this.setAssetOwners(sh.subjectId, scaled);
        else await this.setLiabilityOwners(sh.subjectId, scaled);
      } catch (e: any) {
        console.warn(`[ownership] could not redistribute shares on ${sh.kind} ${sh.subjectId}: ${e?.message || e}`);
      }
    }
  }

  /**
   * After one owner's link is removed, hand their share back to the owners
   * that remain — the same rule as deleting the person (D139). Without it the
   * "Remove" button on the owners panel left the asset partly owned by nobody
   * (D224): Self kept 40% of a boat that was now entirely theirs.
   */
  private async redistributeAfterLinkRemoval(kind: "asset" | "liability", subjectId: string): Promise<void> {
    const rows = kind === "asset"
      ? await this.getAssetPartyLinks(subjectId).catch(() => [] as any[])
      : await this.getLiabilityProfileLinks(subjectId).catch(() => [] as any[]);
    const others = (rows || []).filter((l: any) => l?.partyProfileId)
      .map((l: any) => ({ partyProfileId: String(l.partyProfileId), ownershipPercentage: Number(l.ownershipPercentage ?? 0) }));
    await this.redistributePartyShares([{ kind, subjectId, others }]);
  }

  async deleteProfile(id: string): Promise<boolean> {
    const profile = await this.getProfile(id);
    if (!profile) return false;
    const heldShares = await this.capturePartyShares(id);

    // ── RECURSIVE: Delete all child profiles first (vehicles, assets, subscriptions, etc.) ──
    // Each child profile deletion triggers its own cascade, so their data goes away too.
    // [P2] Lite projection: this scan only reads parentProfileId (+ name/type
    // for the log line), so skip the heavy jsonb columns of the full select.
    const allProfiles = await this.getProfilesLite();
    const childProfiles = allProfiles.filter(p =>
      p.parentProfileId === id
    );
    for (const child of childProfiles) {
      console.log(`[deleteProfile] Cascade-deleting child profile: ${child.name} (${child.type}, id:${child.id})`);
      await this.deleteProfile(child.id);
    }

    // ── [P0.1] Preferred path: atomic cascade in ONE Postgres transaction. ──
    // The legacy loop below is a non-transactional read-then-write cascade: a
    // concurrent write between its read and its per-row update is lost, and a
    // crash mid-loop leaves half-cascaded orphans. delete_profile_cascade()
    // (migrations/009_delete_profile_cascade.sql) mirrors the loop's exact
    // semantics inside a single transaction. Fall back to the legacy loop only
    // when the function hasn't been deployed yet (Postgres 42883 /
    // PostgREST PGRST202 = function not found).
    // Captures this profile owned go to the Self first: the table's foreign
    // key would otherwise set their owner to NULL when the row goes, leaving
    // the user's own notes ownerless (visible under nobody's scope). The
    // capture route defaults an owner to the Self; a deleted owner does too.
    await this.rehomeCapturesToSelf(id);
    const { data: rpcCounts, error: rpcError } = await this.supabase.rpc("delete_profile_cascade", {
      p_user_id: this.userId,
      p_profile_id: id,
    });
    if (!rpcError) {
      console.log(`[deleteProfile] atomic cascade RPC path for ${id}: ${JSON.stringify(rpcCounts)}`);
      await this.pruneBudgetsForProfile(id);
      await this.redistributePartyShares(heldShares);
      return true;
    }
    const fnMissing = rpcError.code === "42883" || rpcError.code === "PGRST202"
      || /could not find the function/i.test(rpcError.message || "");
    if (!fnMissing) {
      // The function exists but the transaction failed and rolled back —
      // nothing was deleted. Don't run the legacy loop on top of an unknown
      // failure; report the deletion as failed instead.
      console.error(`[deleteProfile] cascade RPC failed for ${id} (rolled back): ${rpcError.message}`);
      return false;
    }
    console.warn(`[deleteProfile] delete_profile_cascade not deployed — legacy non-transactional cascade path for ${id}`);

    // ── Cascade delete: remove ALL linked entities — no exceptions ──
    // [P0] BATCHED fallback. The previous implementation looped over every
    // linked row with one awaited round trip per row — a profile with 300
    // items paid ~300 sequential Supabase calls and risked the serverless
    // function timeout. Semantics are UNCHANGED from that loop (Bug #7 rules):
    //   • trackers linked to the profile are deleted ENTIRELY (entries first);
    //   • multi-owner tables (expenses/tasks/habits/events/documents/
    //     artifacts/goals/incomes/journal) delete a row only when this profile
    //     is the SOLE owner; co-owned rows just get this id stripped from
    //     linked_profiles;
    //   • incomes soft-delete (deleted_at) instead of hard delete (Bug #8).
    // Sole-owner rows collapse into chunked bulk .in() deletes; co-owned rows
    // still need one update each (each row keeps a DIFFERENT linked_profiles
    // value) but run concurrently. Independent tables run under Promise.all;
    // FK ordering is respected WITHIN each group (tracker_entries before
    // trackers, habit_checkins before habits) and the profile row itself is
    // deleted only after every child group settles.
    const errors: string[] = [];
    const nowIso = new Date().toISOString();
    // Chunk id lists so a bulk .in() filter never builds an over-long URL
    // (PostgREST encodes filters in the query string; ~100 UUIDs ≈ 4KB).
    const chunk = <T>(arr: T[], size = 100): T[][] => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };
    const bulkDeleteByIds = async (table: string, ids: string[]): Promise<void> => {
      for (const c of chunk(ids)) {
        const { error } = await this.supabase.from(table).delete().in("id", c).eq("user_id", this.userId);
        if (error) throw error;
      }
    };
    // Multi-owner cascade for one table: bulk-delete (or soft-delete) the
    // sole-owner rows, strip this profile id from co-owned rows.
    const cascadeSharedTable = async (
      table: string,
      tag: string,
      rows: Array<{ id: string; linkedProfiles?: string[] | null }> | null,
      opts: { softDelete?: boolean; beforeDelete?: (soleIds: string[]) => Promise<void> } = {},
    ): Promise<void> => {
      if (!rows) return; // list fetch already failed and tagged the error
      try {
        const soleIds: string[] = [];
        const coOwned: Array<{ rowId: string; remaining: string[] }> = [];
        for (const r of rows) {
          const lp = (r.linkedProfiles || []) as string[];
          if (!lp.includes(id)) continue;
          if (lp.length <= 1) soleIds.push(r.id);
          else coOwned.push({ rowId: r.id, remaining: lp.filter(pid => pid !== id) });
        }
        if (soleIds.length > 0) {
          if (opts.beforeDelete) await opts.beforeDelete(soleIds);
          if (opts.softDelete) {
            for (const c of chunk(soleIds)) {
              const { error } = await this.supabase.from(table).update({ deleted_at: nowIso }).in("id", c).eq("user_id", this.userId);
              if (error) throw error;
            }
          } else {
            await bulkDeleteByIds(table, soleIds);
          }
        }
        // Each co-owned row gets a different linked_profiles value, so these
        // can't collapse into one statement — but they CAN run concurrently.
        // (Works for both JSONB and text[] linked_profiles columns: the value
        // travels in the JSON request body, not as a PostgREST filter literal.)
        await Promise.all(coOwned.map(async ({ rowId, remaining }) => {
          const { error } = await this.supabase.from(table).update({ linked_profiles: remaining }).eq("id", rowId).eq("user_id", this.userId);
          if (error) throw error;
        }));
      } catch (e) { errors.push(tag); }
    };

    // Fetch every candidate list in ONE parallel batch (was ~10 sequential
    // list fetches interleaved with the per-row writes).
    const safeList = async <T>(tag: string, fn: () => Promise<T[]>): Promise<T[] | null> => {
      try { return await fn(); } catch { errors.push(tag); return null; }
    };
    const [allTrackers, allExpenses, allTasks, allHabits, allEvents, allDocuments, allArtifacts, allGoals, allIncomes, journalRows] = await Promise.all([
      safeList("trackers", () => this.getTrackers()),
      safeList("expenses", () => this.getExpenses()),
      safeList("tasks", () => this.getTasks()),
      safeList("habits", () => this.getHabits()),
      safeList("events", () => this.getEvents()),
      safeList("documents", () => this.getDocuments()),
      safeList("artifacts", () => this.getArtifacts()),
      safeList("goals", () => this.getGoals()),
      safeList("incomes", () => this.getIncomes()),
      safeList("journal", async () => {
        const { data, error } = await this.supabase.from("journal_entries").select("id, linked_profiles").eq("user_id", this.userId);
        if (error) throw error;
        return data || [];
      }),
    ]);

    // 1. Trackers — deleted ENTIRELY when linked to this profile. No "shared"
    // concept: if you delete Jane Doe, her Hemoglobin tracker goes away.
    const cascadeTrackers = async (): Promise<void> => {
      if (!allTrackers) return;
      try {
        // The same rule as every other multi-owner table (D250): a tracker
        // this profile owns ALONE goes entirely; one it SHARES keeps the other
        // owners' data and only loses this profile (and the entries logged
        // for it). Mirrors migrations/20260903_shared_tracker_cascade.sql.
        const linked = allTrackers.filter(t => (t.linkedProfiles || []).includes(id));
        const soleIds = linked.filter(t => (t.linkedProfiles || []).length <= 1).map(t => t.id);
        const shared = linked.filter(t => (t.linkedProfiles || []).length > 1);
        // FK ordering: entries (children) before trackers (parents).
        for (const c of chunk(soleIds)) {
          const { error } = await this.supabase.from("tracker_entries").delete().in("tracker_id", c).eq("user_id", this.userId);
          if (error) throw error;
        }
        // Entries logged for this profile on any tracker, shared ones included.
        const { error: orphanErr } = await this.supabase.from("tracker_entries").delete().eq("profile_id", id).eq("user_id", this.userId);
        if (orphanErr) throw orphanErr;
        await bulkDeleteByIds("trackers", soleIds);
        await Promise.all(shared.map(async (t) => {
          const remaining = (t.linkedProfiles || []).filter(pid => pid !== id);
          const { error } = await this.supabase.from("trackers").update({ linked_profiles: remaining }).eq("id", t.id).eq("user_id", this.userId);
          if (error) throw error;
        }));
      } catch (e) { errors.push("trackers"); }
    };

    // 11. Entity_links junction rows referencing this profile.
    const cascadeEntityLinks = async (): Promise<void> => {
      try {
        const { error } = await this.supabase.from("entity_links").delete()
          .or(`and(source_type.eq.profile,source_id.eq.${id}),and(target_type.eq.profile,target_id.eq.${id})`)
          .eq("user_id", this.userId);
        if (error) throw error;
      } catch (e) { errors.push("entity_links"); }
    };

    // 12. Asset/Liability ownership + collateral link rows.
    // Belt-and-suspenders: clean up explicitly so the profile-row DELETE
    // doesn't have to rely on FK CASCADE firing through the owner-
    // enforcement triggers (which are patched to no-op when the profile
    // is gone, but cleaning up directly here is safer and avoids any
    // trigger churn in the same transaction).
    const cascadeOwnershipLinks = async (): Promise<void> => {
      try {
        const [a, b, c] = await Promise.all([
          this.supabase.from("asset_party_links").delete()
            .or(`asset_profile_id.eq.${id},party_profile_id.eq.${id}`)
            .eq("user_id", this.userId),
          this.supabase.from("liability_profile_links").delete()
            .or(`liability_profile_id.eq.${id},party_profile_id.eq.${id}`)
            .eq("user_id", this.userId),
          this.supabase.from("liability_asset_links").delete()
            .or(`liability_profile_id.eq.${id},asset_profile_id.eq.${id}`)
            .eq("user_id", this.userId),
        ]);
        const firstErr = a.error || b.error || c.error;
        if (firstErr) throw firstErr;
      } catch (e) { errors.push("ownership_links"); }
    };

    // Run every independent table cascade concurrently. (Obligations retired —
    // recurring bills are liability child profiles deleted via the recursive
    // child-profile pass above, so there's no obligations table step here.)
    await Promise.all([
      cascadeTrackers(),
      cascadeSharedTable("expenses", "expenses", allExpenses),
      cascadeSharedTable("tasks", "tasks", allTasks),
      cascadeSharedTable("habits", "habits", allHabits as any, {
        // FK ordering: check-ins (children) before habits (parents).
        beforeDelete: async (soleIds) => {
          for (const c of chunk(soleIds)) {
            const { error } = await this.supabase.from("habit_checkins").delete().in("habit_id", c).eq("user_id", this.userId);
            if (error) throw error;
          }
        },
      }),
      cascadeSharedTable("events", "events", allEvents),
      cascadeSharedTable("documents", "documents", allDocuments as any),
      cascadeSharedTable("artifacts", "artifacts", allArtifacts as any),
      cascadeSharedTable("goals", "goals", allGoals as any),
      // Bug #8: incomes were once missing from the cascade entirely. Soft-
      // delete sole-owner incomes (deleted_at), strip co-owners.
      cascadeSharedTable("incomes", "incomes", allIncomes as any, { softDelete: true }),
      cascadeSharedTable("journal_entries", "journal",
        journalRows ? (journalRows as any[]).map(r => ({ id: r.id, linkedProfiles: r.linked_profiles || [] })) : null),
      cascadeEntityLinks(),
      cascadeOwnershipLinks(),
    ]);

    if (errors.length > 0) {
      console.warn(`[deleteProfile] Cascade delete partial failures for profile ${id}: ${errors.join(", ")}`);
    }

    // Finally, delete the profile itself
    const { error } = await this.supabase.from("profiles").delete().eq("id", id).eq("user_id", this.userId);
    if (error) {
      console.warn(`[deleteProfile] Failed to delete profile ${id}:`, error.message);
    }
    // The profile row is gone: its per-person budgets go with it (D127) and
    // its co-ownership shares return to the remaining owners (D139).
    if (!error) { await this.pruneBudgetsForProfile(id); await this.redistributePartyShares(heldShares); }
    // Return false if EITHER the final profile-row delete failed OR any cascade
    // step failed. Previously we returned `!error` even when child cascade
    // operations failed, so the route reported success while orphan rows
    // (expenses, obligations, etc.) remained linked to the deleted profile.
    return !error && errors.length === 0;
  }

  // FIX 4 Phase 2: junction-table map removed — every profile_<type> table was
  //   dropped after the JSONB-vs-junction audit showed 0/17,299 disagreements.
  //   The `linked_profiles` JSONB column on each entity row is now the sole
  //   source of truth for non-fractional ownership.


  // Profile-exclusive entity types: ONE owner only. Adding a second profile is BLOCKED.
  private static readonly PROFILE_EXCLUSIVE: Set<string> = new Set(["tracker", "habit", "goal", "journal"]);

  /**
   * [P2.2] Single-writer chokepoint for updateX ownership patches.
   *
   * When a PATCH carries `linkedProfiles`, the ownership part of the patch
   * is applied via setOwners() — which owns the JSONB write, the junction
   * reconcile, and the audit_log entry — instead of writing linked_profiles
   * raw alongside the rest of the patch. `defaultToSelf: false` preserves
   * the historic update semantics: an explicit `[]` clears ownership.
   *
   * Throws on failure (ownership-writer contract: "callers should not catch
   * and proceed") — silently keeping the old owners after a 200 would be a
   * lost update.
   */
  private async applyOwnershipPatch(
    entityType: OwnedEntityType,
    entityId: string,
    linkedProfiles: readonly unknown[],
  ): Promise<void> {
    const self = await this.getSelfProfile();
    // selfId is only consulted in default-to-self mode, which we opt out of.
    await setOwners(this.supabase, this.userId, entityType, entityId, linkedProfiles, self?.id || this.userId, { defaultToSelf: false });
  }

  /**
   * Ownership invariant — FIX 4 Phase 2 (post-junction-drop).
   *
   * The original invariant (JSONB vs. profile_<type> junction) is gone because
   * the junctions were dropped. The new invariant is: every id in any entity
   * row's `linked_profiles` array must resolve to an existing profile owned
   * by the same user. A dangling id means a profile was deleted out from
   * under an entity, or a write inserted a bogus id.
   *
   * Response shape is preserved for backward compat with the existing
   * contract test and dashboards — `disagreementCount` now counts dangling
   * references, `jsonbOnlyCount` stays at 0 (legacy slot).
   */
  async getOwnershipConsistency(): Promise<{
    disagreementCount: number;
    jsonbOnlyCount: number;
    financeDisagreementCount: number;
    perType: Record<string, { disagree: number; jsonbOnly: number; agree: number; total: number }>;
  }> {
    const entityTables: { et: string; table: string; softDelete: boolean }[] = [
      { et: "expense", table: "expenses", softDelete: true },
      { et: "tracker", table: "trackers", softDelete: false },
      { et: "task", table: "tasks", softDelete: true },
      { et: "event", table: "events", softDelete: false },
      { et: "obligation", table: "obligations", softDelete: false },
      { et: "document", table: "documents", softDelete: true },
      { et: "artifact", table: "artifacts", softDelete: false },
    ];

    // Build the set of valid profile ids once.
    const { data: profileRows } = await this.supabase
      .from("profiles").select("id").eq("user_id", this.userId).is("deleted_at", null);
    const validIds = new Set<string>((profileRows || []).map((r: any) => r.id));

    let totalDisagree = 0;
    const perType: Record<string, { disagree: number; jsonbOnly: number; agree: number; total: number }> = {};

    for (const t of entityTables) {
      let q = this.supabase.from(t.table).select("id, linked_profiles").eq("user_id", this.userId);
      if (t.softDelete) q = q.is("deleted_at", null);
      const { data } = await q;
      let disagree = 0, agree = 0;
      const total = (data || []).length;
      for (const e of (data || []) as any[]) {
        const lp: string[] = Array.isArray(e.linked_profiles)
          ? e.linked_profiles.filter((x: any) => typeof x === "string")
          : [];
        if (lp.length === 0) continue; // empty arrays don't count toward agree/disagree.
        const allResolve = lp.every(pid => validIds.has(pid));
        if (allResolve) agree += 1; else disagree += 1;
      }
      perType[t.et] = { disagree, jsonbOnly: 0, agree, total };
      totalDisagree += disagree;
    }

    // Stage 5 invariant: for asset/liability profiles, the relational link
    //   table is the source of truth. Any legacy `fields.ownerProfileId` value
    //   that disagrees with the link table is a drift.
    let financeDisagreement = 0;
    const { data: financeProfiles } = await this.supabase
      .from("profiles")
      .select("id, type, type_key, fields")
      .eq("user_id", this.userId)
      .is("deleted_at", null);
    const assetIds: string[] = [];
    const liaIds: string[] = [];
    const isAsset = (p: any) => ["asset", "vehicle", "property", "investment"].includes(p.type)
      || ["asset", "vehicle", "property", "electronics", "jewelry", "collectible", "art", "high_value_item"].includes(p.type_key);
    const isLia = (p: any) => ["liability", "loan"].includes(p.type);
    for (const p of (financeProfiles || []) as any[]) {
      if (isAsset(p)) assetIds.push(p.id);
      else if (isLia(p)) liaIds.push(p.id);
    }
    const [assetLinks, liaLinks] = await Promise.all([
      assetIds.length > 0
        ? this.supabase.from("asset_party_links").select("asset_profile_id, party_profile_id").in("asset_profile_id", assetIds)
        : Promise.resolve({ data: [] as any[] }),
      liaIds.length > 0
        ? this.supabase.from("liability_profile_links").select("liability_profile_id, party_profile_id").in("liability_profile_id", liaIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const assetLinkMap = new Map<string, Set<string>>();
    for (const l of (assetLinks.data || []) as any[]) {
      const s = assetLinkMap.get(l.asset_profile_id) || new Set<string>();
      s.add(l.party_profile_id);
      assetLinkMap.set(l.asset_profile_id, s);
    }
    const liaLinkMap = new Map<string, Set<string>>();
    for (const l of (liaLinks.data || []) as any[]) {
      const s = liaLinkMap.get(l.liability_profile_id) || new Set<string>();
      s.add(l.party_profile_id);
      liaLinkMap.set(l.liability_profile_id, s);
    }
    for (const p of (financeProfiles || []) as any[]) {
      const fieldOwner: string | undefined = p?.fields?.ownerProfileId;
      if (!fieldOwner || typeof fieldOwner !== "string") continue;
      const linkSet = isAsset(p) ? assetLinkMap.get(p.id) : isLia(p) ? liaLinkMap.get(p.id) : undefined;
      if (!linkSet || !linkSet.has(fieldOwner)) {
        financeDisagreement += 1;
      }
    }

    return { disagreementCount: totalDisagree, jsonbOnlyCount: 0, financeDisagreementCount: financeDisagreement, perType };
  }

  /**
   * [P0.5] Repair counterpart to getOwnershipConsistency.
   *
   * Scans the same entity tables for `linked_profiles` entries pointing at
   * profiles that no longer exist (the "dangling reference" invariant breach)
   * and strips them. Every repair routes through setOwners() so the JSONB
   * write and the audit trail stay consistent — no raw linked_profiles
   * writes. `defaultToSelf: false` means a row whose only owner was the
   * dangling profile ends up un-owned rather than silently re-owned by Self.
   */
  // ── Per-user data version (cross-instance cache coherence) ────────────
  // See migrations/010_user_data_versions.sql. Reads resolve the current
  // version (memoized in routes.ts); writes bump it so cached API responses
  // on every serverless instance go stale within ~2s of any mutation.
  async getDataVersion(): Promise<number> {
    const { data, error } = await this.supabase
      .from("user_data_versions").select("version")
      .eq("user_id", this.userId).maybeSingle();
    if (error) throw error;
    return Number(data?.version || 0);
  }

  async bumpDataVersion(): Promise<number> {
    const { data, error } = await this.supabase
      .rpc("bump_user_data_version", { p_user_id: this.userId });
    if (error) throw error;
    return Number(data || 0);
  }

  /**
   * The per-domain version map (migration 20260825).
   *
   * `{ epoch, <domain>: <n>, ... }`. The epoch is in every cache key, so a
   * write that names no domain — or that an older instance made through the
   * one-argument RPC — still invalidates everything, which is the pre-migration
   * behavior and the correct direction to fail in.
   */
  async getDataVersions(): Promise<Record<string, number>> {
    const { data, error } = await this.supabase
      .from("user_data_versions").select("version,domains")
      .eq("user_id", this.userId).maybeSingle();
    if (error) throw error;
    const domains = (data?.domains && typeof data.domains === "object") ? data.domains as Record<string, unknown> : {};
    const out: Record<string, number> = { epoch: Number(data?.version || 0) };
    for (const [k, v] of Object.entries(domains)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  }

  async bumpDataVersions(domains: string[] = []): Promise<Record<string, number>> {
    const { data, error } = await this.supabase
      .rpc("bump_user_domain_versions", { p_user_id: this.userId, p_domains: domains });
    if (error) throw error;
    const map = (data && typeof data === "object") ? data as Record<string, unknown> : {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(map)) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  }

  // ── Shared response cache (migration 20260731_response_cache) ─────────────
  // Cross-INSTANCE warm cache for the handful of expensive aggregations
  // (bootstrap/stats/enhanced/calendar-timeline). The in-memory response cache
  // in routes.ts is per serverless instance, so under Vercel's instance
  // fan-out a user "warmed" on instance A still paid the full ~15-query
  // recompute the moment a request landed on instance B — a large share of
  // the residual cold-open slowness. Correctness rides on the existing
  // version-stamped keys (`<uid>@v<N>`): any write bumps the version, making
  // every stale row unaddressable — no cross-instance bust protocol needed.
  async getResponseCache(key: string): Promise<any | null> {
    const { data, error } = await this.supabase
      .from("response_cache").select("payload,expires_at")
      .eq("key", key).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (new Date(data.expires_at).getTime() <= Date.now()) return null;
    return data.payload;
  }

  async setResponseCache(key: string, payload: any, ttlMs: number): Promise<void> {
    const { error } = await this.supabase.from("response_cache").upsert({
      key,
      user_id: this.userId,
      payload,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    });
    if (error) throw error;
  }

  /** Delete this user's expired rows (piggybacked on write busts). */
  async cleanupResponseCache(): Promise<void> {
    await this.supabase.from("response_cache").delete()
      .eq("user_id", this.userId)
      .lt("expires_at", new Date().toISOString());
  }

  /** Delete ALL expired rows (any user) — called from the daily cron. */
  async sweepResponseCache(): Promise<void> {
    await this.supabase.from("response_cache").delete()
      .lt("expires_at", new Date().toISOString());
  }

  async repairOwnershipConsistency(): Promise<{ scanned: number; repaired: number; details: string[] }> {
    // Same table list + soft-delete visibility as getOwnershipConsistency.
    const entityTables: { et: OwnedEntityType; table: string; softDelete: boolean }[] = [
      { et: "expense", table: "expenses", softDelete: true },
      { et: "tracker", table: "trackers", softDelete: false },
      { et: "task", table: "tasks", softDelete: true },
      { et: "event", table: "events", softDelete: false },
      { et: "obligation", table: "obligations", softDelete: false },
      { et: "document", table: "documents", softDelete: true },
      { et: "artifact", table: "artifacts", softDelete: false },
    ];

    const { data: profileRows } = await this.supabase
      .from("profiles").select("id").eq("user_id", this.userId).is("deleted_at", null);
    const validIds = new Set<string>((profileRows || []).map((r: any) => r.id));
    const self = await this.getSelfProfile();
    const selfId = self?.id || this.userId; // unused by setOwners in defaultToSelf:false mode

    const MAX_DETAILS = 50;
    let scanned = 0;
    let repaired = 0;
    const details: string[] = [];

    for (const t of entityTables) {
      let q = this.supabase.from(t.table).select("id, linked_profiles").eq("user_id", this.userId);
      if (t.softDelete) q = q.is("deleted_at", null);
      const { data } = await q;
      for (const e of (data || []) as any[]) {
        scanned += 1;
        const lp: string[] = Array.isArray(e.linked_profiles)
          ? e.linked_profiles.filter((x: any) => typeof x === "string")
          : [];
        if (lp.length === 0) continue;
        const dangling = lp.filter(pid => !validIds.has(pid));
        if (dangling.length === 0) continue;
        const next = lp.filter(pid => validIds.has(pid));
        try {
          await setOwners(this.supabase, this.userId, t.et, e.id, next, selfId, { defaultToSelf: false });
          repaired += 1;
          if (details.length < MAX_DETAILS) {
            details.push(`${t.et} ${e.id}: removed dangling owner(s) ${dangling.join(", ")}`);
          }
        } catch (err: any) {
          if (details.length < MAX_DETAILS) {
            details.push(`${t.et} ${e.id}: repair failed — ${err?.message || err}`);
          }
        }
      }
    }
    return { scanned, repaired, details };
  }

  async linkProfileTo(profileId: string, entityType: string, entityId: string): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) return;

    // ════════════════════════════════════════════════════════════════
    // ENFORCEMENT GUARD: Profile-exclusive entities can have ONE owner.
    // If the entity already belongs to a DIFFERENT profile, REJECT.
    // This is the single architectural boundary that prevents all
    // cross-profile data leakage. No code path can bypass this.
    // ════════════════════════════════════════════════════════════════
    const spec = (OWNERSHIP_TABLES as any)[entityType] as { entityTable: string } | undefined;
    const entityTable = spec?.entityTable;

    if (SupabaseStorage.PROFILE_EXCLUSIVE.has(entityType) && entityTable) {
      const { data: entityRow } = await this.supabase
        .from(entityTable).select("linked_profiles").eq("id", entityId).eq("user_id", this.userId).single();
      if (entityRow) {
        const current: string[] = entityRow.linked_profiles || [];
        if (current.length > 0 && !current.includes(profileId)) {
          // BLOCKED: entity already belongs to a different profile
          console.warn(`[ISOLATION] BLOCKED: ${entityType} ${entityId.slice(0,8)} already belongs to ${current[0].slice(0,8)}, rejecting link to ${profileId.slice(0,8)}`);
          throw new ProfileLinkFailure(
            "PROFILE_EXCLUSIVE_CONFLICT",
            `${entityType} already belongs to another profile`,
            409,
          );
        }
      }
    }

    // Stage 1b: route the ownership write through the single writer. setOwners
    //   atomically updates the JSONB column and syncs the junction table.
    //   We deliberately call setOwners even when the profile is already in
    //   the JSONB list — setOwners reconciles the junction too, so this is
    //   what catches createX paths that wrote linked_profiles inline before
    //   calling here. If everything is already in sync, setOwners no-ops.
    if (entityTable && (OWNERSHIP_TABLES as any)[entityType]) {
      const { data: entityRow } = await this.supabase
        .from(entityTable).select("linked_profiles").eq("id", entityId).eq("user_id", this.userId).maybeSingle();
      if (entityRow) {
        const current: string[] = Array.isArray(entityRow.linked_profiles)
          ? entityRow.linked_profiles.filter((x: any) => typeof x === "string")
          : [];
        const next = current.includes(profileId) ? current : [...current, profileId];
        const self = await this.getSelfProfile();
        const selfId = self?.id || profileId; // Worst case, default to the new owner.
        try {
          await setOwners(
            this.supabase,
            this.userId,
            entityType as OwnedEntityType,
            entityId,
            next,
            selfId,
            { defaultToSelf: false },
          );
        } catch (e: any) {
          console.error(`[linkProfileTo] setOwners failed for ${entityType}/${entityId.slice(0,8)}: ${e?.message || e}`);
          throw new ProfileLinkFailure(
            "OWNER_WRITE_FAILED",
            `Failed to link ${entityType}`,
            500,
          );
        }
      }
    }

    // Documents still use profile JSONB `documents` array — side effect outside
    //   the ownership-writer's responsibility, so we keep it here.
    if (entityType === "document") {
      if (!profile.documents.includes(entityId)) {
        profile.documents.push(entityId);
        await this.supabase.from("profiles").update({ documents: profile.documents }).eq("id", profileId).eq("user_id", this.userId);
      }
    }
  }

  async unlinkProfileFrom(profileId: string, entityType: string, entityId: string): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) return;

    // Stage 1b: route the ownership write through the single writer. We pass
    //   `defaultToSelf: false` so removing the last owner leaves the row
    //   un-owned (matches historic unlinkProfileFrom behavior).
    const spec = (OWNERSHIP_TABLES as any)[entityType] as { entityTable: string } | undefined;
    if (spec) {
      const { data: entityRow } = await this.supabase
        .from(spec.entityTable).select("linked_profiles").eq("id", entityId).eq("user_id", this.userId).maybeSingle();
      if (entityRow) {
        const current: string[] = Array.isArray(entityRow.linked_profiles)
          ? entityRow.linked_profiles.filter((x: any) => typeof x === "string")
          : [];
        if (current.includes(profileId)) {
          const next = current.filter(id => id !== profileId);
          const self = await this.getSelfProfile();
          const selfId = self?.id || profileId; // Only used if next is empty in default-to-self mode; we opt out.
          try {
            await setOwners(
              this.supabase,
              this.userId,
              entityType as OwnedEntityType,
              entityId,
              next,
              selfId,
              { defaultToSelf: false },
            );
          } catch (e: any) {
            console.error(`[unlinkProfileFrom] setOwners failed for ${entityType}/${entityId.slice(0,8)}: ${e?.message || e}`);
            throw new ProfileLinkFailure(
              "OWNER_WRITE_FAILED",
              `Failed to unlink ${entityType}`,
              500,
            );
          }
        }
      }
    }

    // Documents still use the profile JSONB `documents` array (no junction table yet)
    if (entityType === "document") {
      profile.documents = profile.documents.filter(id => id !== entityId);
      await this.supabase.from("profiles").update({ documents: profile.documents }).eq("id", profileId).eq("user_id", this.userId);
    }
    // Also remove from entity_links table — generic graph cleanup, outside
    //   the ownership-writer's responsibility.
    await this.supabase.from("entity_links").delete()
      .eq("user_id", this.userId)
      .eq("source_type", "profile")
      .eq("source_id", profileId)
      .eq("target_type", entityType)
      .eq("target_id", entityId);
  }

  /**
   * Auto-propagate a document link up the profile chain.
   * When a document is linked to a child profile (e.g., Tesla Model S),
   * also link it to the parent profile (e.g., Me/self) so documents
   * appear in all relevant places without duplication.
   * Also adds the document's linkedProfiles array to include parent IDs.
   */
  async propagateDocumentToAncestors(documentId: string, profileId: string): Promise<string[]> {
    const propagated: string[] = [];
    const visited = new Set<string>([profileId]);
    let currentId: string | undefined = profileId;

    while (currentId) {
      const profile = await this.getProfile(currentId);
      if (!profile) break;

      const parentId = profile.parentProfileId;
      if (!parentId || visited.has(parentId)) break;
      visited.add(parentId);

      // FIX 4 Phase 2: junction dropped; use profile.documents JSONB only.
      const parent = await this.getProfile(parentId);
      if (parent) {
        if (!parent.documents.includes(documentId)) {
          parent.documents.push(documentId);
          await this.supabase.from("profiles").update({ documents: parent.documents }).eq("id", parentId).eq("user_id", this.userId);
        }
        propagated.push(parent.name);
      }

      // Also add parent to document's linkedProfiles — [P2.2] routed through
      // the single writer (setOwners) instead of a raw linked_profiles write.
      // PERF: only linkedProfiles is needed — metadata read, never the binary.
      const doc = await this.getDocumentMeta(documentId);
      if (doc && !doc.linkedProfiles.includes(parentId)) {
        try {
          await this.applyOwnershipPatch("document", documentId, [...doc.linkedProfiles, parentId]);
        } catch (e: any) {
          console.error(`[propagateDocumentToAncestors] setOwners failed for ${documentId.slice(0,8)}: ${e?.message || e}`);
        }
      }

      currentId = parentId;
    }
    return propagated;
  }

  /**
   * Propagate any entity link up to parent profiles.
   * Generic version — works for trackers, expenses, tasks, etc.
   */
  async propagateEntityToAncestors(entityType: string, entityId: string, profileId: string): Promise<string[]> {
    const propagated: string[] = [];
    const visited = new Set<string>([profileId]);
    let currentId: string | undefined = profileId;

    while (currentId) {
      const profile = await this.getProfile(currentId);
      if (!profile) break;

      const parentId = profile.parentProfileId;
      if (!parentId || visited.has(parentId)) break;
      visited.add(parentId);

      await this.linkProfileTo(parentId, entityType, entityId);
      const parent = await this.getProfile(parentId);
      if (parent) propagated.push(parent.name);

      currentId = parentId;
    }
    return propagated;
  }

  // Get the "self" profile (type="self") for this user — used for auto-linking
  async getSelfProfile(): Promise<Profile | undefined> {
    // PERF: request-memoized — a chat turn used to hit this twice (classifier
    // context + capture owner), two identical Supabase queries per message.
    // memo() is cleared on every write (invalidateContextCache), so
    // read-after-write correctness matches getProfiles.
    return this.memo("getSelfProfile", async () => {
      const { data, error } = await this.supabase.from("profiles").select("*").eq("user_id", this.userId).eq("type", "self").is("deleted_at", null).limit(1).single();
      if (error || !data) return undefined;
      return this.rowToProfile(data);
    });
  }

  /**
   * Returns true if setting profileId.parentProfileId = newParentId would create a cycle.
   * A cycle exists when newParentId is profileId itself, or when walking up the ancestor chain
   * from newParentId we encounter profileId.
   */
  async wouldCreateCycle(_userId: string, profileId: string, newParentId: string | null): Promise<boolean> {
    if (!newParentId) return false;
    if (newParentId === profileId) return true;
    // Walk up the ancestor chain from newParentId using getProfile (user-scoped).
    // If we ever encounter profileId, it's a cycle.
    let currentId: string | null = newParentId;
    const visited = new Set<string>();
    while (currentId) {
      if (visited.has(currentId)) break; // guard against pre-existing cycles in data
      visited.add(currentId);
      const current = await this.getProfile(currentId);
      if (!current) break;
      const parentId: string | null = current.parentProfileId || null;
      if (!parentId) break;
      if (parentId === profileId) return true;
      currentId = parentId;
    }
    return false;
  }

  // Migrate all unlinked trackers to the "self" profile (bidirectional)
  async migrateUnlinkedTrackersToSelf(): Promise<number> {
    const selfProfile = await this.getSelfProfile();
    if (!selfProfile) return 0;
    const trackers = await this.getTrackers();
    let count = 0;
    for (const t of trackers) {
      if (!t.linkedProfiles || t.linkedProfiles.length === 0) {
        // [P2.2] Route the ownership write through the single writer instead
        // of a raw linked_profiles update. setOwners covers everything the
        // old update + linkProfileTo pair did for trackers (JSONB write +
        // audit_log) in one chokepoint.
        try {
          await setOwners(this.supabase, this.userId, "tracker", t.id, [selfProfile.id], selfProfile.id, { defaultToSelf: false });
        } catch (e: any) {
          console.error(`[migrateUnlinkedTrackersToSelf] setOwners failed for ${t.id.slice(0,8)}: ${e?.message || e}`);
          continue;
        }
        count++;
      }
    }
    return count;
  }

  // ============================================================
  // TRACKERS
  // ============================================================
  async getTrackers(daysBack = 120, profileIds?: string[]): Promise<Tracker[]> {
    return this.memo(`getTrackers:${daysBack}${this._fk(profileIds)}`, () => this._getTrackersImpl(daysBack, profileIds));
  }
  private async _getTrackersImpl(daysBack = 120, profileIds?: string[]): Promise<Tracker[]> {
    // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth.
    // Limit entries to recent data (default 120 days) to avoid slow full-history scans
    const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
    // PERF (durable-fix-phase1): push profileIds filter into Postgres using the
    // existing idx_trackers_linked_profiles_gin index.
    // ORDER BY is not optional here. Postgres makes no ordering guarantee for an
    // unordered select, so two calls could hand back the same rows in different
    // order — and anything that slices the result (the ?limit= pager, the
    // persisted-bootstrap shell projection) then kept a DIFFERENT subset each
    // time, which is how the same scope produced two different wellness scores
    // (QA report 2026-08-05). Newest first, matching the other list reads.
    let trackersQuery = this.supabase.from("trackers").select("*").eq("user_id", this.userId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    trackersQuery = this._applyProfileFilter(trackersQuery, await this.pushdownIds(profileIds));
    const trackersResult = await trackersQuery;
    if (trackersResult.error) throw trackersResult.error;
    const trackerRows = trackersResult.data || [];
    if (trackerRows.length === 0) return [];

    // Fetch child history only for the parents in this scope. The old parallel
    // query loaded every tracker entry for the user and discarded unrelated
    // rows in memory, making a one-profile filter almost as expensive as
    // Everyone for accounts with long histories.
    const trackerIds = trackerRows.map((row: any) => row.id);
    const entriesResult = await this.supabase
      .from("tracker_entries")
      .select("*")
      .eq("user_id", this.userId)
      .in("tracker_id", trackerIds)
      .gte("timestamp", cutoff)
      .is("deleted_at", null)
      .order("timestamp", { ascending: true });
    if (entriesResult.error) throw entriesResult.error;
    // Group entries by tracker_id
    const entriesByTracker = new Map<string, any[]>();
    for (const e of entriesResult.data || []) {
      const arr = entriesByTracker.get(e.tracker_id) || [];
      arr.push(e);
      entriesByTracker.set(e.tracker_id, arr);
    }
    const trackers = trackerRows.map(r =>
      this.rowToTracker(r, (entriesByTracker.get(r.id) || []).map(e => this.rowToTrackerEntry(e))),
    );
    return this.healOwnerSuffixedTrackerNames(trackers);
  }

  // Strip a legacy "<Name> - <Owner>" tracker-name suffix (created before the
  // owner suffix was removed — see server/ai-engine.ts) using the tracker's OWN
  // linked profiles' names. DISPLAY-ONLY: returns clean names but NEVER writes.
  //
  // This used to PATCH the name column on every read to "heal the DB too". That
  // was a read-path write storm: when two trackers strip to the same canonical
  // name (e.g. "Weight - Craig" and an existing "Weight"), the rename collides
  // with the partial unique index idx_trackers_name_user (user_id, name) WHERE
  // deleted_at IS NULL → 409 duplicate key. The failed write never healed the
  // suffix, so every dashboard/getTrackers load re-fired the same rejected
  // PATCH, and awaiting them stalled the response (skeleton hang). Canonicalizing
  // in memory alone gives clean display without ever mutating on the read path;
  // matches MemStorage.healTrackerName parity. Never touches a suffix that isn't
  // an owner name.
  private async healOwnerSuffixedTrackerNames(trackers: Tracker[]): Promise<Tracker[]> {
    if (!trackers.length) return trackers;
    let profileNameById: Map<string, string>;
    try {
      const profiles = await this.getProfiles();
      profileNameById = new Map(profiles.map(p => [p.id, p.name]));
    } catch {
      return trackers; // never let a heal failure break tracker reads
    }
    return trackers.map(t => {
      const ownerNames = (t.linkedProfiles || []).map(id => profileNameById.get(id)).filter(Boolean) as string[];
      if (!ownerNames.length) return t;
      const cleaned = stripTrackerOwnerSuffix(t.name, ownerNames);
      if (cleaned === t.name) return t;
      return { ...t, name: cleaned };
    });
  }

  async getTracker(id: string): Promise<Tracker | undefined> {
    const [{ data, error }, entriesResult] = await Promise.all([
      this.supabase.from("trackers").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single(),
      this.supabase.from("tracker_entries").select("*").eq("tracker_id", id).eq("user_id", this.userId).is("deleted_at", null).order("timestamp", { ascending: true }),
    ]);
    if (error || !data) return undefined;
    const tracker = this.rowToTracker(
      data,
      (entriesResult.data || []).map(e => this.rowToTrackerEntry(e)),
    );
    return (await this.healOwnerSuffixedTrackerNames([tracker]))[0];
  }

  async createTracker(data: InsertTracker): Promise<Tracker> {
    // Dedup: check for an existing tracker with the same IDENTITY and the same
    // profile. Different profiles CAN have same-named trackers (e.g. "Calories"
    // for Me and "Calories - Rex" for Rex).
    //
    // Identity, not raw text (QA report 2026-07-25: '"Chess (2)" indicates
    // duplicate tracker creation instead of matching the existing canonical
    // tracker'). `trackerIdentityKey` strips a trailing "(2)", punctuation and
    // noise words, so "Chess (2)", "Chess" and "Chess Tracker" collapse to one
    // key. Deliberate equality — not the looser containment matching in
    // `trackerNamesMatch` — so a user who really does want "Trail Running"
    // alongside "Running" still gets two trackers.
    const existing = await this.getTrackers();
    const requestedProfiles = (data as any).linkedProfiles || [];
    const wantedKey = trackerIdentityKey(data.name);
    // Resolve the owner FIRST: an unspecified owner means the self profile, not
    // "any owner". Matching any owner is what let one person's log land on
    // another person's tracker.
    const selfForDedup = requestedProfiles.length === 0 ? await this.getSelfProfile() : null;
    const ownerForDedup: string[] = requestedProfiles.length > 0
      ? requestedProfiles
      : (selfForDedup ? [selfForDedup.id] : []);
    // Owner names, for recognising a LEGACY "<Name> - <Owner>" row as the same
    // tracker. New rows are never named that way, but rows created before
    // migrations/20260824_tracker_owner_scoped_names.sql are — and a deployment
    // whose database predates that migration still makes them. Without this,
    // asking for "Calories" for Bob when "Calories - Bob" already exists would
    // hand Bob a second tracker.
    const ownerNamesForDedup = (await Promise.all(
      ownerForDedup.map(async (pid) => {
        try { return (await this.getProfile(pid))?.name; } catch { return undefined; }
      }),
    )).filter(Boolean) as string[];
    const dup = existing.find(t => {
      const bare = ownerNamesForDedup.length
        ? stripTrackerOwnerSuffix(t.name, ownerNamesForDedup)
        : t.name;
      if (!wantedKey || trackerIdentityKey(bare) !== wantedKey) return false;
      const existingLp = t.linkedProfiles || [];
      // An unowned (orphan) tracker is adoptable by whoever logs to it next.
      if (existingLp.length === 0) return true;
      if (ownerForDedup.length === 0) return false;
      return ownerForDedup.some((pid: string) => existingLp.includes(pid));
    });
    if (dup) return dup;

    const id = randomUUID();
    const now = new Date().toISOString();
    // Auto-link to self profile if no profiles specified
    let linkedProfiles = (data as any).linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }

    // NAME: the tracker keeps the name it was asked for. Trackers are unique on
    // (user_id, owner_profile_id, lower(name)) — migrations/20260824_tracker_
    // owner_scoped_names.sql — so identity is OWNER + NAME, not account + name.
    // Bob's Running and Sarah's Running are two rows both honestly called
    // "Running", and the dedup above already reused this owner's own tracker if
    // they had one.
    //
    // This is where the old "Calories - Bob" suffix came from: under the former
    // UNIQUE (user_id, name) index a second profile's tracker was literally
    // un-insertable, so the name was mangled to make room and the read path
    // stripped the mangling back off for display. With the index cut at the
    // right grain, there is nothing to work around.
    const finalName = data.name;
    // UNIVERSAL ENGINE: never reject a tracker over field shape. Coerce every
    // field to the canonical {name, type} so an AI-supplied field with an odd
    // type ("time", "string", missing) can't fail the insert. Unknown types
    // fall back to text; empties are dropped.
    const VALID_TYPES = new Set(["number", "text", "boolean", "select", "duration"]);
    const safeFields = (Array.isArray(data.fields) ? data.fields : [])
      .filter((f: any) => f && typeof f.name === "string" && f.name.trim())
      .map((f: any) => {
        const t = String(f.type || "").toLowerCase();
        const field: any = { name: String(f.name).trim(), type: VALID_TYPES.has(t) ? t : "text" };
        if (Array.isArray(f.options)) field.options = f.options.map((o: any) => String(o));
        if (f.unit != null) field.unit = String(f.unit);
        if (typeof f.isPrimary === "boolean") field.isPrimary = f.isPrimary;
        return field;
      });

    // Core columns guaranteed by the base migration. Optional columns
    // (metric_definition) are added only when actually supplied, so a
    // deployment that hasn't run that migration never sees a "column does not
    // exist" schema error on a brand-new tracker.
    // Insert helper — builds the row for a given name and retries WITHOUT the
    // optional metric_definition column if a deployment hasn't migrated it.
    const insertWithName = async (nm: string): Promise<{ error: any }> => {
      const base: any = {
        id, user_id: this.userId, name: nm, category: data.category || "custom",
        unit: data.unit || null, icon: data.icon || null, fields: safeFields,
        linked_profiles: linkedProfiles, created_at: now,
      };
      const full = (data as any).metricDefinition
        ? { ...base, metric_definition: (data as any).metricDefinition }
        : base;
      let err = (await this.supabase.from("trackers").insert(full)).error;
      if (err && full !== base &&
          /metric_definition|column .* does not exist|schema cache|could not find/i.test(err.message || "")) {
        console.warn(`[createTracker] optional column rejected (${err.message}); retrying with base columns`);
        err = (await this.supabase.from("trackers").insert(base)).error;
      }
      return { error: err };
    };

    let insertErr = (await insertWithName(finalName)).error;
    // BACKSTOP for the UNIQUE (user_id, name) constraint. A 23505 here means the
    // pre-check missed a colliding row — almost always a CONCURRENT createTracker
    // for the same name that committed between our getTrackers() read and our
    // insert (the AI tool path can fire the same "log X" twice; the client can
    // retry a timed-out request whose write actually landed).
    //
    // The old backstop blindly suffixed and re-inserted, so every such race
    // spawned a brand-new "Running abcd" tracker — the duplicate-insert storm on
    // idx_trackers_name_user. Instead, make creation IDEMPOTENT: re-read and
    // REUSE the tracker that won the race whenever it's a legitimate match for
    // what we were asked to create. Only suffix when the surviving row genuinely
    // belongs to a DIFFERENT profile (the real "Calories for Me vs Bob" case),
    // never weakening the uniqueness constraint.
    if (insertErr && /duplicate key|23505|idx_trackers_name_user|already exists/i.test(insertErr.message || insertErr.code || "")) {
      const fresh = await this.getTrackers();
      const wanted = new Set<string>(requestedProfiles.length ? requestedProfiles : linkedProfiles);
      const reusable = fresh.find(t => {
        if (!wantedKey || trackerIdentityKey(t.name) !== wantedKey) return false;
        if (wanted.size === 0) return true; // no profile constraint → any same-name row
        const lp = t.linkedProfiles || [];
        return lp.some((pid: string) => wanted.has(pid));
      });
      if (reusable) return reusable; // race winner already created it → idempotent no-op
      // Not a race we can reuse: under the owner-scoped index a 23505 means THIS
      // owner already holds this name, and the only rows that fit are ones the
      // pre-check couldn't see (a soft-deleted row, a replica lag read). Suffix
      // ONCE with a short id — never the owner's name, which is what produced
      // "Calories - Bob" — so the write makes progress instead of raising a raw
      // duplicate-key error at the user.
      insertErr = (await insertWithName(`${finalName} ${id.slice(0, 4)}`)).error;
    }
    if (insertErr) throw insertErr;
    bustInsightsCacheFor(this.userId); // [P0] tracker set changed → recompute insights
    // Link to profiles via junction table
    for (const pId of linkedProfiles) {
      await this.linkProfileTo(pId, "tracker", id);
    }
    this.logActivity("tracker", `Created tracker: ${finalName}`);
    return (await this.getTracker(id))!;
  }

  async updateTracker(id: string, data: Partial<Tracker>): Promise<Tracker | undefined> {
    const existing = await this.getTracker(id);
    if (!existing) return undefined;
    // [P0.2] Optimistic concurrency: compare against the trigger-maintained
    // updated_at column (fetched only when the caller sent expectedUpdatedAt).
    const trackerVersion = await this.assertNoWriteConflictFor("trackers", id, data as Record<string, any>);
    const merged = { ...existing, ...data };
    const baseUpdate: any = {
      name: merged.name, category: merged.category, unit: merged.unit || null,
      icon: merged.icon || null, fields: merged.fields,
    };
    // Only the columns this patch names (see onlyPatched).
    const baseUpdatePatched: any = onlyPatched(baseUpdate, data as Record<string, any>, { name: "name", category: "category", unit: "unit", icon: "icon", fields: "fields" });
    // Only round-trip metric_definition when it's actually present, and retry
    // without it if a deployment hasn't migrated that optional column — same
    // resilience as createTracker, so an auto-extend / edit never fails with a
    // "column does not exist" schema error.
    const fullUpdate = (data as any).metricDefinition !== undefined
      ? { ...baseUpdatePatched, metric_definition: (merged as any).metricDefinition }
      : baseUpdatePatched;
    let updErr = (await this.guardedWrite(this.supabase.from("trackers").update(fullUpdate).eq("id", id).eq("user_id", this.userId), trackerVersion)).error;
    if (updErr && fullUpdate !== baseUpdatePatched &&
        /metric_definition|column .* does not exist|schema cache|could not find/i.test(updErr.message || "")) {
      console.warn(`[updateTracker] optional column rejected (${updErr.message}); retrying with base columns`);
      updErr = (await this.supabase.from("trackers").update(baseUpdatePatched).eq("id", id).eq("user_id", this.userId)).error;
    }
    if (updErr) throw updErr;
    bustInsightsCacheFor(this.userId); // [P0] tracker changed → recompute insights
    // [P2.2] Ownership patches go through the single writer (setOwners), not a
    // raw linked_profiles write alongside the rest of the patch.
    if (data.linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("tracker", id, data.linkedProfiles);
    }
    return this.getTracker(id);
  }

  /**
   * An entry dated after today in the user's zone is a slip (a weight "for
   * Friday" typed on Tuesday, or a wrong year): it sat at the top of every
   * list as the latest value, drove goal progress and the wellness score,
   * and could not be told apart from a real reading. Refused with a 400 on
   * the API and the chat path alike (both create through logEntry, edits
   * through updateTrackerEntry). Same-day entries at any clock time stay
   * allowed.
   */
  private assertEntryNotInFuture(ts: string | Date): void {
    const day = localDayOf(ts, this._timezone);
    if (day && day > getUserToday(this._timezone)) {
      const e: any = new Error("Entries can't be logged for a future date");
      e.statusCode = 400;
      throw e;
    }
  }

  async logEntry(data: InsertTrackerEntry): Promise<TrackerEntry | undefined> {
    const tracker = await this.getTracker(data.trackerId);
    if (!tracker) return undefined;

    // Provenance metadata (per-value source/confidence/assumptions from the
    // estimation engine) rides in on values._enrichment but belongs on the
    // entry's `computed` column — an object left inside values renders as
    // "_enrichment: [object Object]" in every values-chip UI and pollutes the
    // duplicate-detection key below.
    const { _enrichment: enrichmentMeta, ...rawClean } = { ...data.values } as Record<string, any>;
    // ONE unit gate: convert to the tracker's unit here, at the write, so a
    // value that arrives with a unit ("80 kg", or { value: 80, unit: "kg" })
    // lands in the tracker's own unit from EVERY entry point — the POST route
    // and the habit mirror never ran the normalizer the AI lanes run, so the
    // form stored kilograms in a pounds tracker. Idempotent for already-
    // normalized input.
    const cleanValues = normalizeTrackerEntry(tracker as any, rawClean).values;

    // Validate and normalize entry values against tracker field definitions
    let values = cleanValues;
    let validated = true;
    const fieldNames = new Set(tracker.fields.map(f => f.name.toLowerCase()));
    const COMMON_ALIASES: Record<string, string[]> = {
      value: ["steps", "count", "amount", "total", "score", "reading", "number"],
      duration: ["time", "minutes", "hours", "length"],
      distance: ["miles", "km", "meters"],
      weight: ["lbs", "kg", "mass"],
    };

    if (fieldNames.size > 0) {
      const normalizedValues: Record<string, any> = {};
      for (const [key, val] of Object.entries(values)) {
        if (fieldNames.has(key.toLowerCase())) {
          normalizedValues[key] = val;
        } else {
          // Try to map common aliases
          let mapped = false;
          for (const [canonical, aliases] of Object.entries(COMMON_ALIASES)) {
            if (aliases.includes(key.toLowerCase()) && fieldNames.has(canonical)) {
              normalizedValues[canonical] = val;
              mapped = true;
              console.warn(`logEntry: mapped alias "${key}" → "${canonical}" for tracker "${tracker.name}"`);
              break;
            }
          }
          if (!mapped) {
            // Accept the value but flag as not validated
            normalizedValues[key] = val;
            validated = false;
            console.warn(`logEntry: unknown field "${key}" for tracker "${tracker.name}" (expected: ${[...fieldNames].join(", ")})`);
          }
        }
      }
      values = normalizedValues;
    }

    // ONE value gate for every write path (route, smart-entry, AI quick-log
    // lanes, extraction, habit mirror). The POST route used to be the only
    // path with bounds, so "log 8000 hours of sleep" stored happily from chat.
    {
      const guard = sanitizeTrackerEntryValues(tracker.fields, values);
      if (guard.error) throw new Error(guard.error);
      values = guard.values;
    }

    // W4-4: honor an explicit entry timestamp when the caller supplies one
    // (already parsed to ISO upstream); otherwise stamp NOW().
    const ts = data.timestamp || new Date().toISOString();
    this.assertEntryNotInFuture(ts);

    // Dedup check: reject entries with same values logged within 5 minutes.
    // Use a key-sorted canonical form so {a:1,b:2} and {b:2,a:1} dedup the same way.
    // Only deduplicates accidental double-fires (e.g. retried HTTP request) —
    // intentional re-logs of the same value within 5 min are the trade-off.
    //
    // The window is centred on the ENTRY's own timestamp, not the wall clock:
    // "also 180 for yesterday" is a backdated entry whose only near neighbour
    // is yesterday's, and it must not be swallowed by today's identical row.
    // The lower bound is applied by the query; the upper bound is checked on
    // the rows (PostgREST filters compose, but keeping one filter here keeps
    // the query shape every storage double already scripts).
    //
    // `__skipDedupe` is the internal marker the habit mirror sets (alongside
    // `__skipHabitSync`): the 2nd and 3rd mirror of a "twice daily" habit are
    // identical rows moments apart BY DESIGN, and swallowing them handed back
    // the first row's id — so the un-check later deleted the only mirror.
    const DEDUP_WINDOW_MS = 5 * 60 * 1000;
    const tsMs = Date.parse(ts);
    if (!(data as any).__skipDedupe && Number.isFinite(tsMs)) {
      const canonicalize = (obj: any): string => {
        if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return JSON.stringify(obj);
        const sortedKeys = Object.keys(obj).sort();
        const out: Record<string, any> = {};
        for (const k of sortedKeys) out[k] = obj[k];
        return JSON.stringify(out);
      };
      const newCanonical = canonicalize(values);
      // A backdated entry's neighbours sit just AFTER the window's start, so
      // walk forward from it; a live entry's neighbours are the newest rows.
      const backdated = tsMs < Date.now() - DEDUP_WINDOW_MS;
      const recentEntries = await this.supabase
        .from("tracker_entries")
        .select("id, entry_values, timestamp")
        .eq("tracker_id", data.trackerId)
        .eq("user_id", this.userId)
        .is("deleted_at", null)
        .gte("timestamp", new Date(tsMs - DEDUP_WINDOW_MS).toISOString())
        .order("timestamp", { ascending: backdated })
        .limit(5);
      if (recentEntries.data) {
        const existing = recentEntries.data.find(e =>
          Date.parse(e.timestamp) <= tsMs + DEDUP_WINDOW_MS
          && canonicalize(e.entry_values) === newCanonical);
        if (existing) {
          return this.rowToTrackerEntry(existing);
        }
      }
    }

    const computed = {
      ...computeSecondaryData(tracker.name, tracker.category, values),
      validated,
      ...(enrichmentMeta ? { enrichment: enrichmentMeta } : {}),
    };
    const id = randomUUID();
    // AUTHORITATIVE WRITE + READ-BACK (production audit 2026-07-29, blocker #2).
    //
    // This method used to `.insert()` and then return an entry object built
    // from LOCAL variables — it never asked the database what it actually
    // stored. Any write that did not persist (RLS silently filtering the row,
    // a rolled-back statement, a tracker deleted underneath us) still produced
    // a fully-formed "success" return value, which the chat layer reported as
    // a completed log. That is the "AI reports writes that never occurred"
    // defect: the UI showed 24 oz, the database had nothing, and a refresh
    // made it vanish.
    //
    // `.select().maybeSingle()` makes the INSERT return the row as the
    // database committed it, so the value we hand back is read from storage
    // rather than reconstructed from intent. A missing row is now a thrown
    // error instead of a phantom success.
    const { data: inserted, error } = await this.supabase.from("tracker_entries").insert({
      id, user_id: this.userId, tracker_id: data.trackerId,
      entry_values: values, computed, notes: data.notes || null,
      mood: data.mood || null, tags: data.tags || null,
      for_profile: data.forProfile || null,
      profile_id: data.profileId || null,
      timestamp: ts,
    }).select().maybeSingle();
    if (error) throw error;
    if (!inserted) {
      throw new Error(
        `Tracker entry write could not be confirmed: no row returned after inserting entry ${id} ` +
        `into tracker "${tracker.name}" (${data.trackerId}).`
      );
    }
    // Validate the persisted row is the one we meant to write, and that it is
    // owned by and scoped to this user — never report someone else's row (or a
    // row on a different tracker) as a successful log.
    if (inserted.id !== id
        || inserted.tracker_id !== data.trackerId
        || inserted.user_id !== this.userId) {
      throw new Error(
        `Tracker entry write verification failed: expected entry ${id} on tracker ${data.trackerId} ` +
        `for user ${this.userId}, but the database returned entry ${inserted.id} on tracker ` +
        `${inserted.tracker_id} for user ${inserted.user_id}.`
      );
    }
    bustInsightsCacheFor(this.userId); // [P0] new entry → recompute insights
    this.logActivity("tracker", `Logged ${tracker.name}`);
    // Habit ↔ tracker link: one activity record updates both. Advances any
    // habit linked to this tracker by one completion for the entry's day
    // (best-effort — see server/habit-completion.ts). Skipped on the dedup
    // early-return above (a retried HTTP request must not double-advance) and
    // when this write IS the mirror of a habit check-in, which would loop.
    if (!(data as any).__skipHabitSync) {
      // NOTE: `this` (the raw instance) rather than the storage proxy, so the
      // nested checkinHabit/updateHabit writes are NOT individually journaled.
      // Covered because logEntry's own noun (Entry) maps to the habits domain;
      // passing the proxy here would resolve through AsyncLocalStorage and
      // could bind a different instance for direct-instance callers.
      await autoCheckinLinkedHabits(this, data.trackerId, { timestamp: ts, values, timezone: this._timezone, entryId: inserted?.id });
    }
    // Return the DATABASE's version of the row, not our intended one.
    return this.rowToTrackerEntry(inserted);
  }

  /**
   * Read a single tracker entry back by id, scoped to this user. This is the
   * authoritative existence check the chat envelope uses to confirm a logged
   * entry really landed before any success is reported to the user
   * (production audit 2026-07-29, blocker #2). Returns undefined when the row
   * does not exist, belongs to someone else, or has been soft-deleted.
   */
  async getTrackerEntry(entryId: string): Promise<(TrackerEntry & { trackerId: string }) | undefined> {
    const { data, error } = await this.supabase
      .from("tracker_entries")
      .select()
      .eq("id", entryId)
      .eq("user_id", this.userId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error || !data) return undefined;
    return this.rowToTrackerEntry(data);
  }

  async updateTrackerEntry(
    trackerId: string,
    entryId: string,
    patch: {
      values?: Record<string, any>;
      valuesToDelete?: string[];
      notes?: string;
      mood?: any;
      tags?: string[];
      timestamp?: string;
    }
  ): Promise<any> {
    // Fetch existing row so we can merge values + recompute computed fields.
    const { data: existing, error: fetchErr } = await this.supabase.from("tracker_entries")
      .select("*").eq("id", entryId).eq("tracker_id", trackerId).eq("user_id", this.userId).maybeSingle();
    if (fetchErr || !existing) return undefined;
    let tracker: Tracker | undefined;
    try { tracker = await this.getTracker(trackerId); } catch { tracker = undefined; }
    // The SAME unit gate and value gate logEntry runs, on the patched values.
    // An edit used to skip both, so the entry form stored "80 kg" as a bare 80
    // in a pounds tracker and "8000 hours" of sleep from a PATCH that the POST
    // path would have refused. Gate the patch (not the whole merged row) so a
    // legacy row with an out-of-range value elsewhere can still be corrected
    // one field at a time. Throws the same error shape logEntry throws, so the
    // route maps it to a 400.
    let patchValues = patch.values;
    if (patchValues && typeof patchValues === "object" && tracker) {
      const normalized = normalizeTrackerEntry(tracker as any, patchValues).values;
      const guard = sanitizeTrackerEntryValues(tracker.fields, normalized);
      if (guard.error) throw new Error(guard.error);
      patchValues = guard.values;
    }
    // Merge values JSONB AND honor deletion intents — same reason as updateProfile.
    // Without this, secondary metrics logged in error could never be cleared from
    // a tracker entry (e.g. accidentally logged `diastolic` on a single-value
    // weight tracker).
    // NB: the live column is `entry_values` (the original `values` name is a SQL
    // reserved word and was renamed). logEntry + rowToTrackerEntry already use
    // `entry_values`; this method used to read/write `values`, so EVERY edit
    // failed with a column error → the route returned "404 Entry not found".
    if (patch.timestamp) this.assertEntryNotInFuture(patch.timestamp);
    const buildUpdate = (row: any) => {
    const mergedValues = mergeAndApplyDeletes(
      row.entry_values || {},
      patchValues,
      patch.valuesToDelete
    );
    const update: any = { entry_values: mergedValues };
    if (patch.notes !== undefined) update.notes = patch.notes;
    if (patch.mood !== undefined) update.mood = patch.mood;
    if (patch.tags !== undefined) update.tags = patch.tags;
    if (patch.timestamp) update.timestamp = patch.timestamp;
    // Recompute derived/computed data from the new values so badges (BP
    // category, sleep quality, pace, calories, etc.) stay correct after an edit.
    try {
      if (tracker) {
        update.computed = {
          ...computeSecondaryData(tracker.name, tracker.category, mergedValues),
          validated: (row.computed && row.computed.validated) ?? true,
        };
      }
    } catch { /* leave computed untouched if recompute fails */ }
    return update;
    };
    // Written only if nobody wrote the row since it was read (compare-and-swap
    // on updated_at, retried from the fresh row): two field edits in flight
    // together used to merge against the same stale values, and the later
    // write put the earlier field back.
    let fresh: any = existing;
    for (let attempt = 0; ; attempt++) {
      const update = buildUpdate(fresh);
      let q = this.supabase.from("tracker_entries").update({ ...update, updated_at: new Date().toISOString() })
        .eq("id", entryId).eq("tracker_id", trackerId).eq("user_id", this.userId);
      q = fresh.updated_at == null ? q.is("updated_at", null) : q.eq("updated_at", fresh.updated_at);
      const { data, error } = await q.select().maybeSingle();
      if (error) return undefined;
      if (data) {
        bustInsightsCacheFor(this.userId); // [P0] entry changed → recompute insights
        return this.rowToTrackerEntry(data);
      }
      if (attempt >= 7) throw new Error("Entry edit kept colliding with another writer; try again");
      const { data: again, error: reread } = await this.supabase.from("tracker_entries")
        .select("*").eq("id", entryId).eq("tracker_id", trackerId).eq("user_id", this.userId).maybeSingle();
      if (reread || !again) return undefined;
      fresh = again;
      await new Promise((r) => setTimeout(r, 10 + attempt * 20));
    }
  }

  async deleteTrackerEntry(trackerId: string, entryId: string): Promise<boolean> {
    // `.select` so a delete that matched no row (another user's entry, a
    // missing id) reports false instead of "no error, so success".
    const { data, error } = await this.supabase.from("tracker_entries").delete()
      .eq("id", entryId).eq("tracker_id", trackerId).eq("user_id", this.userId).select("id");
    if (!error) bustInsightsCacheFor(this.userId); // [P0] entry removed → recompute insights
    return !error && Array.isArray(data) && data.length > 0;
  }

  /**
   * A goal that reads its progress from a tracker or a habit keeps the last
   * figure when that source goes away. Progress is computed on read and never
   * stored, so deleting the tracker (a hard delete; the FK nulls the goal's
   * tracker_id) or the habit used to drop the goal back to the 0 its row
   * carried: "100 pushups — 0 / 100" the moment the tracker was gone.
   */
  private async freezeGoalProgress(column: "tracker_id" | "habit_id", sourceId: string): Promise<void> {
    const { data, error } = await this.supabase.from("goals").select("*")
      .eq("user_id", this.userId).eq(column, sourceId).eq("status", "active").is("deleted_at", null);
    if (error || !data || data.length === 0) return;
    for (const row of data) {
      const goal = this.rowToGoal(row);
      let current: number;
      try { current = await this.computeGoalProgress(goal); } catch { continue; }
      if (typeof current !== "number" || !Number.isFinite(current) || current === row.current) continue;
      const { error: writeErr } = await this.supabase.from("goals").update({ current }).eq("id", goal.id).eq("user_id", this.userId);
      if (writeErr) console.warn(`[freezeGoalProgress] could not keep goal ${goal.id} at ${current}: ${writeErr.message}`);
    }
  }

  async deleteTracker(id: string): Promise<boolean> {
    await this.freezeGoalProgress("tracker_id", id);
    // Delete entries first, then the tracker
    await this.supabase.from("tracker_entries").delete().eq("tracker_id", id).eq("user_id", this.userId);
    /* D1: clean up entity_links rows that reference this tracker */
    await this.cleanupEntityLinks("tracker", id);
    // `.select` so a tracker that was not there (or not this user's) reports
    // false instead of success (D280).
    const { data, error } = await this.supabase.from("trackers").delete().eq("id", id).eq("user_id", this.userId).select("id");
    const removed = !error && Array.isArray(data) && data.length > 0;
    if (removed) {
      bustInsightsCacheFor(this.userId); // [P0] tracker removed → recompute insights
      // A habit that mirrored into this tracker must not keep pointing at it:
      // completeHabitOccurrence read the dangling id, found no tracker, wrote
      // no mirror and — because the link was "set" — never resolved a new one.
      const { error: unlinkErr } = await this.supabase.from("habits")
        .update({ linked_tracker_id: null })
        .eq("linked_tracker_id", id).eq("user_id", this.userId);
      if (unlinkErr) console.warn(`[deleteTracker] could not clear habits.linked_tracker_id for ${id}: ${unlinkErr.message}`);
    }
    return removed;
  }

  // ============================================================
  // TASKS
  // ============================================================
  async getTasks(profileIds?: string[]): Promise<Task[]> {
    return this.memo(`getTasks${this._fk(profileIds)}`, async () => {
      // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth.
      // PERF (durable-fix-phase1): DB pushdown via idx_tasks_linked_profiles_gin.
      let q = this.supabase
        .from("tasks").select("*").eq("user_id", this.userId).is("deleted_at", null);
      q = this._applyProfileFilter(q, await this.pushdownIds(profileIds));
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map(r => this.rowToTask(r));
    });
  }

  async getTask(id: string): Promise<Task | undefined> {
    const { data, error } = await this.supabase
      .from("tasks").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error || !data) return undefined;
    return this.rowToTask(data);
  }

  async createTask(data: InsertTask): Promise<Task> {
    // A caller may supply the row id (the recurring-task spawn derives one
    // from the series, so two concurrent completions collide on the primary
    // key instead of inserting two clones).
    const suppliedId = (data as any).id;
    const id = typeof suppliedId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedId) ? suppliedId : randomUUID();
    const now = new Date().toISOString();
    // Auto-link to self profile if no profiles specified
    let linkedProfiles = data.linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    // Insert empty; setOwners handles both JSONB and junction. See createExpense.
    const { error } = await this.supabase.from("tasks").insert({
      id, user_id: this.userId, title: data.title, description: data.description || null,
      status: (data as any).status || "todo", priority: data.priority || "medium", due_date: data.dueDate || null,
      due_time: data.dueTime || null,
      linked_profiles: [], tags: data.tags || [],
      source: (data as any).source || "manual", created_at: now,
    });
    if (error) throw error;
    if (linkedProfiles.length > 0) {
      const self = await this.getSelfProfile();
      const selfId = self?.id || linkedProfiles[0];
      try {
        await setOwners(this.supabase, this.userId, "task", id, linkedProfiles, selfId, { defaultToSelf: false });
      } catch (e: any) {
        console.error(`[createTask] setOwners failed for ${id.slice(0,8)}: ${e?.message || e}`);
      }
    }
    this.logActivity("task", `Created task: ${data.title}`);
    return (await this.getTask(id))!;
  }

  async updateTask(id: string, data: Partial<Task>): Promise<Task | undefined> {
    const existing = await this.getTask(id);
    if (!existing) return undefined;
    // [P0.2] Optimistic concurrency: compare against the trigger-maintained
    // updated_at column (fetched only when the caller sent expectedUpdatedAt).
    const taskVersion = await this.assertNoWriteConflictFor("tasks", id, data as Record<string, any>);
    const merged = { ...existing, ...data };
    const { error } = await this.guardedWrite(this.supabase.from("tasks").update(onlyPatched({
      title: merged.title, description: merged.description || null, status: merged.status,
      priority: merged.priority, due_date: merged.dueDate || null,
      due_time: merged.dueTime || null,
      tags: merged.tags,
    }, data as Record<string, any>, { title: "title", description: "description", status: "status", priority: "priority", due_date: "dueDate", due_time: "dueTime", tags: "tags" })).eq("id", id).eq("user_id", this.userId), taskVersion);
    if (error) throw error;
    // [P2.2] Ownership patches go through the single writer (setOwners), not a
    // raw linked_profiles write alongside the rest of the patch.
    if (data.linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("task", id, data.linkedProfiles);
    }

    // BUG-B: recurring tasks. When a task carrying a `recur:<freq>` tag flips to
    // done, spawn the next dated instance so the chore reappears. Cadence lives
    // in the tag (no schema change). Guard against double-spawn: only fire on the
    // todo/pending -> done transition.
    if (data.status === "done" && existing.status !== "done") {
      const recurTag = (existing.tags || []).find((t: string) => String(t).startsWith("recur:"));
      if (recurTag) {
        try {
          await this.spawnNextRecurringTask(existing, String(recurTag).slice("recur:".length));
        } catch (e: any) {
          console.error(`[updateTask] recurring spawn failed for ${id.slice(0,8)}: ${e?.message || e}`);
        }
      }
    } else if (data.status !== undefined && data.status !== "done" && existing.status === "done") {
      // Un-completing takes back the occurrence that the completion spawned;
      // otherwise today's chore and tomorrow's both stay open and the series
      // forks at the next completion.
      const recurTag = (existing.tags || []).find((t: string) => String(t).startsWith("recur:"));
      if (recurTag) {
        try {
          await this.retractSpawnedRecurringTask(existing);
        } catch (e: any) {
          console.error(`[updateTask] recurring retract failed for ${id.slice(0,8)}: ${e?.message || e}`);
        }
      }
    }
    return this.getTask(id);
  }

  /**
   * Create the next instance of a recurring task with its due date advanced.
   *
   * The cadence step is shared/recurrence's — ONE rule for the task's tags.
   * The hand-rolled step this replaces knew daily/weekly/biweekly/monthly/
   * every-N-days only, so `every-N-weeks`, `weekdays`, `yearly` spawned
   * nothing (the chore vanished after its first completion), `runtil:` /
   * `rcount:` were ignored (the chore outlived its end), the monthly step
   * drifted off the 31st, and an undated task stepped from the HOST's clock.
   * `_freq` is kept for the caller's signature; the rule is read from the tags.
   */
  private async spawnNextRecurringTask(prev: Task, _freq: string): Promise<void> {
    const next = nextRecurringTaskSpawn(
      { dueDate: prev.dueDate, tags: prev.tags },
      getUserToday(this._timezone),
    );
    if (!next) return; // not recurring, or the series has reached its end
    // IDEMPOTENT. The spawn fires on every todo → done transition, so
    // un-checking and re-checking the same chore produced a SECOND clone for
    // the same next date (live repro 2026-09-02). If the next occurrence —
    // same title, same owners, same due date — already exists as a live task,
    // it IS the series' next row; don't create another. Read the DB directly
    // rather than the request-memoized getTasks(), which can predate the first
    // spawn inside the same AI turn.
    const sameTitle = (t: unknown) => String(t || "").trim().toLowerCase() === String(prev.title || "").trim().toLowerCase();
    const ownersKey = (ids: unknown) => (Array.isArray(ids) ? ids.map(String) : []).sort().join(",");
    const { data: siblings, error: sibErr } = await this.supabase.from("tasks")
      .select("id, title, linked_profiles")
      .eq("user_id", this.userId).is("deleted_at", null)
      .eq("due_date", next.dueDate);
    if (sibErr) throw sibErr;
    const alreadySpawned = (siblings || []).some((r: any) =>
      r.id !== prev.id && sameTitle(r.title) && ownersKey(r.linked_profiles) === ownersKey(prev.linkedProfiles));
    if (alreadySpawned) return;
    // Two completions racing past the read above (a double tap, two tabs)
    // both saw no sibling. The clone's id is derived from the series row and
    // the next date, so the second insert hits the primary key and is dropped
    // instead of becoming a duplicate.
    const seriesCloneId = this.recurringCloneId(prev.id, next.dueDate);
    try {
      await this.createTask({
        id: seriesCloneId,
        title: prev.title,
      description: prev.description || undefined,
      priority: prev.priority,
      dueDate: next.dueDate,
      // The next instance keeps the same hour — a 9 AM chore is 9 AM every week.
      dueTime: prev.dueTime || undefined,
        // Carries the series forward: rdone incremented, anchor pinned.
        tags: next.tags,
        linkedProfiles: prev.linkedProfiles || [],
      } as any);
    } catch (e: any) {
      if (isUniqueViolationError(e)) return; // the other completion won
      throw e;
    }
  }

  /** The deterministic id of the occurrence spawned from `prevId` for `dueDate` (a v5-shaped uuid). */
  private recurringCloneId(prevId: string, dueDate: string): string {
    const h = createHash("sha1").update(`recurring-clone:${prevId}:${dueDate}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${h.slice(18, 20)}-${h.slice(20, 32)}`;
  }

  /**
   * Remove the occurrence a completion spawned, when the completion is undone.
   * Only the untouched spawn goes: it must still be open, on the date the
   * series step predicts and with the same title — an occurrence the user
   * has since edited or completed is theirs to keep.
   */
  private async retractSpawnedRecurringTask(prev: Task): Promise<boolean> {
    const next = nextRecurringTaskSpawn({ dueDate: prev.dueDate, tags: prev.tags }, getUserToday(this._timezone));
    if (!next) return false;
    const clone = await this.getTask(this.recurringCloneId(prev.id, next.dueDate));
    if (!clone || clone.status === "done") return false;
    if (String(clone.dueDate || "").slice(0, 10) !== next.dueDate) return false;
    if (String(clone.title || "").trim().toLowerCase() !== String(prev.title || "").trim().toLowerCase()) return false;
    // Only a clone that is still exactly what the spawn made goes: once the
    // user has touched next week's occurrence (a note, a priority, a tag, a
    // time), it is their task, and un-completing this week's must not take
    // it away. (It used to be purged regardless, edit and all.)
    if (!this.isPristineRecurringClone(clone, prev, next.tags)) return false;
    // A hard delete, not the soft one: the clone's id is deterministic, so a
    // soft-deleted row would make the next re-completion's spawn collide on
    // it and spawn nothing. The row was machine-made moments ago — there is
    // nothing for the trash to restore.
    return this.purgeTask(clone.id);
  }

  /** Does the spawned occurrence still carry exactly what the spawn copied from its source? */
  private isPristineRecurringClone(clone: Task, prev: Task, spawnTags: string[] | undefined): boolean {
    const text = (v: unknown) => String(v ?? "").trim();
    const sorted = (t: unknown) => (Array.isArray(t) ? [...t].map(String).sort() : []);
    if (text(clone.description) !== text(prev.description)) return false;
    if (text(clone.priority || "medium") !== text(prev.priority || "medium")) return false;
    if (text(clone.dueTime) !== text(prev.dueTime)) return false;
    // A stored row always carries tags and owners; only compare what the row
    // has (a stub without them is not an edit).
    if (clone.tags !== undefined && JSON.stringify(sorted(clone.tags)) !== JSON.stringify(sorted(spawnTags ?? prev.tags))) return false;
    if (clone.linkedProfiles !== undefined && JSON.stringify(sorted(clone.linkedProfiles)) !== JSON.stringify(sorted(prev.linkedProfiles))) return false;
    return true;
  }

  /** Move the captures a profile owns onto the Self (a deleted owner must not leave them ownerless). */
  private async rehomeCapturesToSelf(profileId: string): Promise<number> {
    try {
      const self = await this.getSelfProfile();
      if (!self || self.id === profileId) return 0;
      const { data, error } = await this.supabase.from("captures")
        .update({ owner_profile_id: self.id })
        .eq("user_id", this.userId).eq("owner_profile_id", profileId).select("id");
      if (error) { console.warn(`[deleteProfile] could not re-home captures of ${profileId}: ${error.message}`); return 0; }
      return Array.isArray(data) ? data.length : 0;
    } catch (e: any) {
      console.warn(`[deleteProfile] capture re-home failed for ${profileId}: ${e?.message || e}`);
      return 0;
    }
  }

  /** Permanently remove a task row (its entity links first). */
  async purgeTask(id: string): Promise<boolean> {
    await this.cleanupEntityLinks("task", id);
    const { data, error } = await this.supabase.from("tasks")
      .delete().eq("id", id).eq("user_id", this.userId).select("id");
    return !error && Array.isArray(data) && data.length > 0;
  }

  async deleteTask(id: string): Promise<boolean> {
    // A soft delete keeps this task's entity_links: restore brings the links
    // back with the row, and link readers hide endpoints that sit in the trash
    // (pruneLinksToTrashed). Only the hard deletes wipe them.
    // Soft delete KEEPS linked_profiles: every task reader filters deleted_at,
    // so ownership leaks nowhere — and it is what makes restore actually
    // restore. Clearing owners here (the old behavior) left 1,700+ restored
    // tasks visible only under "Everyone", invisible in every per-profile
    // scope, permanently. `.select` so 0 rows matched reports false.
    const { data, error } = await this.supabase.from("tasks")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).select("id");
    return !error && Array.isArray(data) && data.length > 0;
  }

  async restoreTask(id: string): Promise<boolean> {
    const { data, error } = await this.supabase.from("tasks").update({ deleted_at: null })
      .eq("id", id).eq("user_id", this.userId).select("id, linked_profiles");
    const ok = !error && Array.isArray(data) && data.length > 0;
    if (ok) await this._reownRestoredRow("task", id, data![0]);
    return ok;
  }

  /** Recently soft-deleted tasks (newest deletion first) — for restore-by-name. */
  async getDeletedTasks(limit = 25): Promise<Task[]> {
    const { data, error } = await this.supabase
      .from("tasks").select("*").eq("user_id", this.userId)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data || []).map(r => this.rowToTask(r));
  }

  // ============================================================
  // EXPENSES
  // ============================================================
  async getExpenses(profileIds?: string[]): Promise<Expense[]> {
    return this.memo(`getExpenses${this._fk(profileIds)}`, async () => {
      // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth.
      // PERF (durable-fix-phase1): DB pushdown via idx_expenses_linked_profiles_gin.
      let q = this.supabase
        .from("expenses").select("*").eq("user_id", this.userId).is("deleted_at", null);
      q = this._applyProfileFilter(q, await this.pushdownIds(profileIds));
      const { data, error } = await q.order("date", { ascending: false });
      if (error) throw error;
      return (data || []).map(r => this.rowToExpense(r));
    });
  }

  async getExpense(id: string): Promise<Expense | undefined> {
    const { data, error } = await this.supabase
      .from("expenses").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error || !data) return undefined;
    return this.rowToExpense(data);
  }

  async createExpense(data: InsertExpense): Promise<Expense> {
    if (typeof data.amount !== 'number' || data.amount <= 0) throw new Error("Expense amount must be a positive number");
    const id = randomUUID();
    const now = new Date().toISOString();
    // Auto-link to self profile if no profiles specified
    let linkedProfiles = (data as any).linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    // Insert with EMPTY linked_profiles — setOwners writes both the JSONB and
    //   the junction in one place. Inserting with the populated array and then
    //   relying on linkProfileTo to fix the junction is racy under replication
    //   lag: linkProfileTo's read-back can come from a stale replica and skip
    //   the junction write entirely. Going through setOwners avoids that.
    const { error } = await this.supabase.from("expenses").insert({
      id, user_id: this.userId, amount: data.amount, category: canonicalExpenseCategory(data.category),
      description: data.description, vendor: data.vendor || null,
      is_recurring: data.isRecurring || false, linked_profiles: [],
      // A missing date is TODAY in the user's zone. `now` is a UTC instant,
      // whose calendar date is tomorrow for every US user from late afternoon
      // and yesterday for every user east of Greenwich in the morning.
      tags: data.tags || [], date: data.date || getUserToday(this._timezone),
      source: (data as any).source || "manual", created_at: now,
    });
    if (error) throw error;
    if (linkedProfiles.length > 0) {
      const self = await this.getSelfProfile();
      const selfId = self?.id || linkedProfiles[0];
      try {
        await setOwners(this.supabase, this.userId, "expense", id, linkedProfiles, selfId, { defaultToSelf: false });
      } catch (e: any) {
        console.error(`[createExpense] setOwners failed for ${id.slice(0,8)}: ${e?.message || e}`);
      }
    }
    this.logActivity("expense", `${data.description} - $${data.amount}`, "create", id);
    return (await this.getExpense(id))!;
  }

  async updateExpense(id: string, data: Partial<Expense>): Promise<Expense | undefined> {
    const existing = await this.getExpense(id);
    if (!existing) return undefined;
    // [P0.2] Optimistic concurrency: compare against the trigger-maintained
    // updated_at column (fetched only when the caller sent expectedUpdatedAt).
    const expenseVersion = await this.assertNoWriteConflictFor("expenses", id, data as Record<string, any>);
    const merged = { ...existing, ...data };
    const { error } = await this.guardedWrite(this.supabase.from("expenses").update(onlyPatched({
      amount: merged.amount, category: canonicalExpenseCategory(merged.category), description: merged.description,
      vendor: merged.vendor || null, is_recurring: merged.isRecurring || false,
      tags: merged.tags, date: merged.date,
    }, data as Record<string, any>, { amount: "amount", description: "description", vendor: "vendor", is_recurring: "isRecurring", tags: "tags", date: "date" })).eq("id", id).eq("user_id", this.userId), expenseVersion);
    if (error) throw error;
    // [P2.2] Ownership patches go through the single writer (setOwners), not a
    // raw linked_profiles write alongside the rest of the patch.
    if (data.linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("expense", id, data.linkedProfiles);
    }
    return this.getExpense(id);
  }

  async deleteExpense(id: string): Promise<boolean> {
    // A soft delete keeps this expense's entity_links: restore brings the links
    // back with the row, and link readers hide endpoints that sit in the trash
    // (pruneLinksToTrashed). Only the hard deletes wipe them.
    // Keeps linked_profiles (readers filter deleted_at) so restore returns the
    // expense to its owner's scope; `.select` so 0 rows reports false.
    const { data, error } = await this.supabase.from("expenses")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).select("id");
    return !error && Array.isArray(data) && data.length > 0;
  }

  // ============================================================
  // INCOME
  // ============================================================
  async getIncomes(profileIds?: string[]): Promise<Income[]> {
    return this.memo(`getIncomes${this._fk(profileIds)}`, async () => {
      // PERF (durable-fix-phase1): DB pushdown via idx_incomes_linked_profiles_gin.
      // incomes.linked_profiles is a PG ARRAY (text[]), not jsonb — see
      // _applyProfileFilter doc for the syntax difference.
      let q = this.supabase.from("incomes").select("*").eq("user_id", this.userId).is("deleted_at", null);
      q = this._applyProfileFilter(q, await this.pushdownIds(profileIds), "array");
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map(r => this.rowToIncome(r));
    });
  }

  private rowToIncome(r: any): Income {
    return {
      id: r.id, description: r.description, amount: Number(r.amount),
      category: r.category || "salary",
      // Rows stored before the cadence was folded ("bi-weekly") read as the
      // canonical word every projection switches on.
      frequency: canonicalIncomeFrequency(r.frequency) ?? (r.frequency || "monthly"),
      date: r.date || undefined, linkedProfiles: r.linked_profiles || [],
      tags: r.tags || [], deletedAt: r.deleted_at, createdAt: r.created_at,
      updatedAt: r.updated_at || undefined,
    } as Income;
  }

  async createIncome(data: InsertIncome): Promise<Income> {
    const id = randomUUID();
    const now = new Date().toISOString();
    let linkedProfiles = data.linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    const { error } = await this.supabase.from("incomes").insert({
      id, user_id: this.userId, description: data.description,
      amount: data.amount, category: data.category || "salary",
      frequency: canonicalIncomeFrequency(data.frequency) ?? (data.frequency || "monthly"), date: data.date || null,
      linked_profiles: linkedProfiles, tags: data.tags || [],
      source: "manual", created_at: now,
    });
    if (error) throw error;
    this.logActivity("income", `Created income: ${data.description} $${data.amount}`, "create", id);
    return { id, ...data, amount: data.amount, category: data.category || "salary",
      frequency: data.frequency || "monthly", linkedProfiles,
      tags: data.tags || [], createdAt: now };
  }

  async updateIncome(id: string, data: Partial<Income>): Promise<Income | undefined> {
    const updates: any = {};
    if (data.description !== undefined) updates.description = data.description;
    if (data.amount !== undefined) updates.amount = data.amount;
    if (data.category !== undefined) updates.category = data.category;
    if (data.frequency !== undefined) updates.frequency = canonicalIncomeFrequency(data.frequency) ?? data.frequency;
    if (data.date !== undefined) updates.date = data.date;
    // Bug #4: linkedProfiles and tags were silently dropped on update, so any
    // edit (manual or via AI updateEntityLinkedProfiles → updateIncome path,
    // bug #12) would wipe the income's profile attribution. The PATCH route
    // accepts these fields and returns 200 — but they never reached the DB.
    if (data.tags !== undefined) updates.tags = data.tags;
    const { error } = await this.supabase.from("incomes").update(updates).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // [P2.2] Ownership patches go through the single writer (setOwners).
    if (data.linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("income", id, data.linkedProfiles);
    }
    // Read the row back BY ID (the updateTask / updateExpense pattern), never
    // out of getIncomes(): that list is request-memoized, so inside an AI turn
    // it still held the PRE-update rows and the client patched its list with
    // the stale values the tool had just replaced.
    const { data: row, error: readErr } = await this.supabase.from("incomes").select("*")
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).maybeSingle();
    if (readErr || !row) return undefined;
    return this.rowToIncome(row);
  }

  async deleteIncome(id: string): Promise<boolean> {
    // `.select` so a row that was not there (or not this user's) reports
    // false: the route's 404 was defeated by a "success" for zero rows (D280).
    const { data, error } = await this.supabase.from("incomes").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("user_id", this.userId).is("deleted_at", null).select("id");
    return !error && Array.isArray(data) && data.length > 0;
  }

  // ============================================================
  // EVENTS
  // ============================================================
  async getEvents(profileIds?: string[]): Promise<CalendarEvent[]> {
    return this.memo(`getEvents${this._fk(profileIds)}`, async () => {
      // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth.
      // PERF (durable-fix-phase1): DB pushdown via idx_events_linked_profiles_gin.
      let q = this.supabase
        .from("events").select("*").eq("user_id", this.userId).is("deleted_at", null);
      q = this._applyProfileFilter(q, await this.pushdownIds(profileIds));
      const { data, error } = await q.order("date", { ascending: false });
      if (error) throw error;
      return (data || []).map(r => this.rowToEvent(r));
    });
  }

  async getEvent(id: string): Promise<CalendarEvent | undefined> {
    const { data, error } = await this.supabase
      .from("events").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error || !data) return undefined;
    return this.rowToEvent(data);
  }

  async createEvent(data: InsertEvent): Promise<CalendarEvent> {
    assertEventSpan(data as any); // ends before it starts → 400 (shared/event-span)
    const id = randomUUID();
    const now = new Date().toISOString();
    // Auto-link to self profile if no profiles specified
    let linkedProfiles = data.linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    const { error } = await this.supabase.from("events").insert({
      id, user_id: this.userId, title: data.title, date: data.date,
      time: data.time || null, end_time: data.endTime || null, end_date: data.endDate || null,
      all_day: data.allDay || false, description: data.description || null,
      location: data.location || null, category: data.category || "personal",
      color: data.color || null, recurrence: data.recurrence || "none",
      recurrence_end: data.recurrenceEnd || null,
      linked_profiles: linkedProfiles, linked_documents: data.linkedDocuments || [],
      tags: data.tags || [], source: data.source || "manual", created_at: now,
    });
    if (error) throw error;
    for (const pId of linkedProfiles) {
      await this.linkProfileTo(pId, "event", id);
    }
    this.logActivity("event", `Created event: ${data.title}`);
    return (await this.getEvent(id))!;
  }

  async updateEvent(id: string, data: Partial<CalendarEvent>): Promise<CalendarEvent | undefined> {
    const existing = await this.getEvent(id);
    if (!existing) return undefined;
    // [P0.2] Optimistic concurrency: compare against the trigger-maintained
    // updated_at column (fetched only when the caller sent expectedUpdatedAt).
    const eventVersion = await this.assertNoWriteConflictFor("events", id, data as Record<string, any>);
    const merged = { ...existing, ...data };
    assertEventSpan(merged as any); // the edited record as a whole must still run forwards
    const { error } = await this.guardedWrite(this.supabase.from("events").update(onlyPatched({
      title: merged.title, date: merged.date, time: merged.time || null,
      end_time: merged.endTime || null, end_date: merged.endDate || null,
      all_day: merged.allDay, description: merged.description || null,
      location: merged.location || null, category: merged.category,
      color: merged.color || null, recurrence: merged.recurrence,
      recurrence_end: merged.recurrenceEnd || null,
      linked_documents: merged.linkedDocuments,
      tags: merged.tags, source: merged.source,
    }, data as Record<string, any>, { title: "title", date: "date", time: "time", end_time: "endTime", end_date: "endDate", all_day: "allDay", description: "description", location: "location", category: "category", color: "color", recurrence: "recurrence", recurrence_end: "recurrenceEnd", linked_documents: "linkedDocuments", tags: "tags", source: "source" })).eq("id", id).eq("user_id", this.userId), eventVersion);
    if (error) throw error;
    // [P2.2] Ownership patches go through the single writer (setOwners), not a
    // raw linked_profiles write alongside the rest of the patch.
    if (data.linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("event", id, data.linkedProfiles);
    }
    return this.getEvent(id);
  }

  async deleteEvent(id: string): Promise<boolean> {
    // A soft delete keeps this event's entity_links: restore brings the links
    // back with the row, and link readers hide endpoints that sit in the trash
    // (pruneLinksToTrashed). Only the hard deletes wipe them.
    // [P6.3] Soft delete — parity with every other entity (the live events
    // table has had a deleted_at column all along; the old "no such column"
    // comment was wrong). Profile-cascade deletion still hard-deletes.
    const { data, error } = await this.supabase.from("events").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("user_id", this.userId).is("deleted_at", null).select("id");
    return !error && Array.isArray(data) && data.length > 0;
  }

  // ============================================================
  // CALENDAR TIMELINE
  // ============================================================
  async getCalendarTimeline(startDate: string, endDate: string, profileIds?: string[]): Promise<CalendarTimelineItem[]> {
    const items: CalendarTimelineItem[] = [];
    // Fetch all data in parallel for speed
    // (Habits are intentionally excluded — they don't belong on the calendar.)
    const [allEvents, allTasks, allObligations, profiles, allIncomes, allDocsForDates] = await Promise.all([
      this.getEvents(), this.getTasks(), this.getObligations(), this.getProfiles(),
      // Recurring income. Without this a paycheck showed on the Recurring &
      // Important screen (which builds its own series client-side) and never on
      // the Calendar tab, which reads this method.
      this.getIncomes().catch(() => [] as any[]),
      // Documents, in the same fan-out rather than a serial round-trip after it.
      this.getDocuments(),
    ]);
    // Profile filtering (calendar isolation):
    // When a profile filter is active, an item shows if it is linked to one of
    // the selected profiles. Orphan items (linkedProfiles = []) fall through to
    // the SELF (default) profile — per the user rule "unassigned stuff should
    // always go to the primary person's profile by default." So an unassigned
    // event/task/obligation appears on the primary person's calendar, never on
    // a different person/pet/asset calendar. This is the same soft-orphan rule
    // (`belongs_to_self`) that finance, the dashboard, and every list endpoint
    // apply, so the whole app now scopes unassigned data one consistent way.
    // (This intentionally supersedes the earlier stricter calendar rule that
    // hid orphans from every individual calendar.)
    const filterActive = !!(profileIds && profileIds.length > 0);
    const _selfIds = selfIdsFrom(profiles);
    // A person's selection also covers the assets they own or co-own
    // (shared/profile-filter.effectiveSelection), like every other list.
    const [timelineLinks, timelineLiabLinks] = filterActive
      ? await Promise.all([this.getAssetPartyLinks().catch(() => [] as any[]), this.getLiabilityProfileLinks().catch(() => [] as any[])])
      : [[], []];
    const timelineSelection = filterActive ? effectiveSelection({ selectedIds: profileIds!, allProfiles: profiles as any, assetPartyLinks: timelineLinks as any[], liabilityProfileLinks: timelineLiabLinks as any[] }) : [];
    const matchesProfile = (linked: string[] | null | undefined) => {
      if (!filterActive) return true;
      // Owner chain, same as passesProfileFilter: the car's insurance bill and
      // the "Bill due" task linked to a bill (parent: Self) are Self's.
      return isInScope(
        withAncestorOwnerIds(Array.isArray(linked) ? linked.filter((x): x is string => typeof x === "string" && !!x) : [], profiles as any),
        { selectedIds: timelineSelection, selfIds: _selfIds },
        "belongs_to_self",
      );
    };
    // PR AC: reminders do NOT belong on the calendar. They have their own
    // surface (the reminders table + the productivity hub). Strip events whose
    // title indicates they are a reminder so the calendar shows only real
    // events. Match "Daily Reminder", "Rent Payment Reminder", "🔔 Reminder:
    // ...", etc. without nuking legitimate event titles that merely contain
    // the substring (we anchor on a word boundary).
    const rdTodayISO0 = getUserToday(this._timezone);
    const REMINDER_TITLE_RE = /\breminder\b/i;
    const isReminderEvent = (e: { title?: string | null }) =>
      typeof e.title === "string" && REMINDER_TITLE_RE.test(e.title);

    // ── Birthdays & anniversaries come from the PROFILE, once ──────────────
    // The grid and the recurring stream must agree, so both run the same
    // shared logic (shared/calendar-adapters + calendar-occurrences):
    //
    //   • a profile's date-of-birth field is the authoritative birthday, and
    //     the grid renders it directly — previously the grid showed birthdays
    //     only if someone had also typed in a calendar event, so a profile
    //     birthday appeared nowhere on the grid at all;
    //   • a typed-in birthday event for a profile that already carries the
    //     date is a SHADOW of it and is suppressed here, so the same birthday
    //     can never render twice.
    // Scope on the profile AND ITS PARENT, exactly as the virtual-event ladder
    // this replaced did. A subscription, vehicle or asset nested under a person
    // belongs to that person, so filtering by them must keep its renewal,
    // service and warranty dates — matching on the child id alone dropped them.
    const scopedProfiles = profiles.filter(p =>
      !filterActive || matchesProfile([p.id, ...(p.parentProfileId ? [p.parentProfileId] : [])]));
    // Every profile- and document-carried date, from the ONE Date Rule engine
    // (shared/date-rules) the Recurring & Important Dates screen and the
    // Upcoming feed also read. This block used to cover birthdays and
    // anniversaries only, and a separate block further down tried to add
    // document expirations from `doc.expirationDate` — a property
    // `rowToDocument` never sets, so it was dead code and a driver's licence
    // expiration never reached this grid at all. One engine, no dead branch.
    const scopedDocs = (allDocsForDates as any[]).filter(d => matchesProfile(d.linkedProfiles));
    const profileDateSeries = seriesFromDateRules(
      rulesFromAll({ profiles: scopedProfiles as any[], documents: scopedDocs }),
    );
    const knownBirthdayProfiles = new Set(
      profileDateSeries.filter(x => x.kind === "birthday").map(x => x.source.profileId!).filter(Boolean),
    );
    const knownAnniversaryProfiles = new Set(
      profileDateSeries.filter(x => x.kind === "anniversary").map(x => x.source.profileId!).filter(Boolean),
    );
    // Legacy extraction-written events for a document whose dates are now
    // derived are shadows of it, matched by link rather than by title.
    const ruledDocumentDates = new Set(
      profileDateSeries.filter(x => x.source.system === "document")
        .map(x => `${x.source.id}@${x.baseDate}`),
    );
    const ruledProfileDates = new Set(
      profileDateSeries.filter(x => x.source.system === "profile")
        .map(x => `${x.source.id}@${x.baseDate}`),
    );
    const shadowEventIds = new Set(
      seriesFromEvents(allEvents as any[], { knownBirthdayProfiles, knownAnniversaryProfiles, ruledDocumentDates, ruledProfileDates })
        .filter(x => x.shadow)
        .map(x => x.source.id),
    );
    for (const ser of seriesFromIncomes(
      (allIncomes as any[]).filter(i => matchesProfile(i?.linkedProfiles)),
    )) {
      for (const occ of generateSeriesOccurrences(ser, {
        todayISO: rdTodayISO0,
        horizonDays: Math.max(366, daysBetweenISO(rdTodayISO0, endDate) + 1),
        lookbackDays: Math.max(0, daysBetweenISO(startDate, rdTodayISO0) + 1),
        cap: 400,
      })) {
        if (occ.date < startDate || occ.date > endDate) continue;
        items.push({
          id: `${ser.id}-${occ.date}`, type: "event", title: ser.title, date: occ.date,
          allDay: true, color: "#4FA37A", category: "finance",
          linkedProfiles: ser.source.ownerIds || [], sourceId: ser.source.id,
          meta: { kind: "income", amount: occ.amount, recurrence: ser.recurrence, href: ser.source.href },
        } as any);
      }
    }

    const RULE_KIND_COLOR: Record<string, string> = {
      birthday: "#A78BFA", anniversary: "#F472B6", expiration: "#E0803C",
      renewal: "#E0A63C", appointment: "#5FB98A", maintenance: "#4F98A3",
    };
    for (const ser of profileDateSeries) {
      for (const occ of generateSeriesOccurrences(ser, {
        // A one-time expiration can be years out (a 2034 licence), so the
        // horizon has to reach it. The window filter below still bounds what
        // the response carries to the month the caller asked for.
          // The window the CALLER asked for, not "from today forward".
          // Generating from `todayISO` with no lookback meant any date before
          // today produced nothing: a lease that ended in January, a licence
          // that expired last year, and every birthday earlier in the current
          // year simply left the grid, where the per-type pass this replaced
          // rendered anything inside the requested range.
        todayISO: rdTodayISO0,
        horizonDays: Math.max(366 * 12, daysBetweenISO(rdTodayISO0, endDate) + 1),
        lookbackDays: Math.max(0, daysBetweenISO(startDate, rdTodayISO0) + 1),
        cap: 400,
      })) {
        if (occ.date < startDate || occ.date > endDate) continue;
        items.push({
          // The series id already encodes entity + field + semantic type, so a
          // calendar item can be traced all the way back to the field it came
          // from: occurrence → rule → source entity.
          id: `${ser.id}-${occ.date}`,
          type: "event",
          title: ser.title,
          date: occ.date,
          allDay: true,
          color: RULE_KIND_COLOR[ser.kind] || "#4F98A3",
          category: ser.kind === "birthday" || ser.kind === "anniversary" ? "family" : "other",
          linkedProfiles: ser.source.ownerIds && ser.source.ownerIds.length
            ? ser.source.ownerIds
            : (ser.source.profileId ? [ser.source.profileId] : []),
          sourceId: ser.source.id,
          meta: {
            recurrence: ser.recurrence, source: ser.source.system,
            kind: ser.kind, href: ser.source.href, ruleId: ser.id.replace(/^rule:/, ""),
          },
        } as any);
      }
    }

    const events = allEvents
      .filter(e => !isReminderEvent(e))
      .filter(e => !shadowEventIds.has(e.id))
      .filter(e => matchesProfile(e.linkedProfiles));
    const tasks = allTasks.filter(t => matchesProfile(t.linkedProfiles));
    const obligations = allObligations.filter(o => matchesProfile(o.linkedProfiles));
    // Recurring Dates (shared/recurring-dates): per-occurrence state rides in
    // the event's tags — a checked-off or skipped occurrence affects ONLY that
    // date, never the series. Archived series leave the calendar entirely;
    // paused series keep their history but stop emitting future occurrences.
    const rdTodayISO = getUserToday(this._timezone);
    for (const ev of events) {
      const color = ev.color || EVENT_CATEGORY_COLORS[ev.category] || "#4F98A3";
      const rdMeta = parseRecurringMeta(ev.tags);
      if (rdMeta.archived) continue;
      const rdShow = (dateISO: string) =>
        !rdMeta.skippedDates.includes(dateISO) && !(rdMeta.paused && dateISO >= rdTodayISO && !rdMeta.completedDates.includes(dateISO));
      const baseDate = ev.date.slice(0, 10);
      if (baseDate >= startDate && baseDate <= endDate && rdShow(baseDate)) {
        items.push({ id: `event-${ev.id}-${baseDate}`, type: "event", title: ev.title, date: baseDate, time: ev.time, endTime: ev.endTime, allDay: ev.allDay, color, category: ev.category, description: ev.description, location: ev.location, linkedProfiles: ev.linkedProfiles, sourceId: ev.id, completed: rdMeta.completedDates.includes(baseDate), meta: { recurrence: ev.recurrence, tags: ev.tags, source: ev.source } });
      }
      if (ev.recurrence !== "none") {
        // [P4.3] Expand occurrences all the way to the requested window's end
        // date instead of a hardcoded 45 iterations. The `nextStr > endDate`
        // break bounds the loop by the request window; the 500-occurrence cap
        // mirrors the obligation-engine safety cap.
        //
        // [PERF 2026-07-31 window clamp] The walk used to start at i=1 (the
        // series base). For an old series that meant (a) hundreds of wasted
        // iterations before the window — the weekdays variant re-walked from
        // base for EVERY i, up to ~125k date mutations per event — and (b) a
        // daily series older than 500 days exhausted the cap before reaching
        // the window and silently vanished from the calendar. Fast-forward
        // arithmetically to just before the window (one stride early to
        // absorb rounding), so both the work and the cap now apply to the
        // window, not to the series' age.
        const MAX_EVENT_OCCURRENCES = 500;
        const base = parseLocalDate(ev.date.slice(0, 10));
        const gapDays = Math.floor((parseLocalDate(startDate).getTime() - base.getTime()) / 86400000);
        const pushOccurrence = (nextStr: string) => {
          if (nextStr >= startDate && rdShow(nextStr)) {
            items.push({ id: `event-${ev.id}-${nextStr}`, type: "event", title: ev.title, date: nextStr, time: ev.time, endTime: ev.endTime, allDay: ev.allDay, color, category: ev.category, description: ev.description, location: ev.location, linkedProfiles: ev.linkedProfiles, sourceId: ev.id, completed: rdMeta.completedDates.includes(nextStr), meta: { recurrence: ev.recurrence, tags: ev.tags, source: ev.source } });
          }
        };
        const evDaySet = weekdaySetFor(ev.recurrence);
        if (evDaySet) {
          // weekdays / weekends / weekly:<days> — one INCREMENTAL walk (the old
          // code restarted from base for every occurrence index — O(n²)). Skip
          // whole weeks up to ~a week before the window; every 7-day hop
          // preserves the day-of-week pattern for ANY day set.
          const cur = new Date(base);
          if (gapDays > 14) cur.setDate(cur.getDate() + Math.floor((gapDays - 7) / 7) * 7);
          for (let emitted = 0; emitted < MAX_EVENT_OCCURRENCES; ) {
            cur.setDate(cur.getDate() + 1);
            if (!evDaySet.has(cur.getDay())) continue;
            emitted++;
            const nextStr = cur.toLocaleDateString('en-CA');
            if (nextStr > endDate) break;
            if (ev.recurrenceEnd && nextStr > ev.recurrenceEnd) break;
            pushOccurrence(nextStr);
          }
        } else {
          // Stride-based recurrences: first index at-or-before the window
          // start (floor − 1, clamped to 1) so no pre-window date is skipped.
          let i0 = 1;
          if (gapDays > 2) {
            switch (ev.recurrence) {
              case "daily": i0 = gapDays - 1; break;
              case "weekly": i0 = Math.floor(gapDays / 7) - 1; break;
              case "biweekly": i0 = Math.floor(gapDays / 14) - 1; break;
              case "monthly": i0 = Math.floor(gapDays / 31) - 1; break;
              case "yearly": i0 = Math.floor(gapDays / 366) - 1; break;
            }
            i0 = Math.max(1, i0);
          }
          for (let i = i0; i < i0 + MAX_EVENT_OCCURRENCES; i++) {
            const next = new Date(base);
            switch (ev.recurrence) {
              case "daily": next.setDate(next.getDate() + i); break;
              case "weekly": next.setDate(next.getDate() + i * 7); break;
              case "biweekly": next.setDate(next.getDate() + i * 14); break;
              // Clamped + base-anchored (shared/date-math): setMonth overflows a
              // short month ("June 31" → July 1) and permanently drags the series
              // off its day-of-month.
              case "monthly": next.setTime(addMonthsClamped(base, i).getTime()); break;
              case "yearly": next.setTime(addYearsClamped(base, i).getTime()); break;
            }
            const nextStr = next.toLocaleDateString('en-CA');
            if (nextStr > endDate) break;
            if (ev.recurrenceEnd && nextStr > ev.recurrenceEnd) break;
            pushOccurrence(nextStr);
          }
        }
      }
    }

    for (const task of tasks) {
      // Use dueDate if available, otherwise fall back to createdAt so every task appears on the calendar
      const rawDate = task.dueDate || task.createdAt;
      if (!rawDate) continue;
      const taskColor = task.priority === "high" ? "#A13544" : task.priority === "medium" ? "#BB653B" : "#797876";
      // A task carries its own clock time now (Portol has two entities, events
      // and tasks — see shared/schema.ts Task), and a repeating task is
      // projected across the window instead of appearing once on its stored due
      // date. Without the projection "every Tuesday at 9 AM" occupied one
      // Tuesday and the rest of the year was blank.
      // An undated task sits on the day it was CREATED — in the user's zone.
      // createdAt is a UTC instant, so `slice(0, 10)` put an evening task on
      // tomorrow for every negative-offset user.
      const createdDay = task.dueDate ? null : localDayOf(rawDate, this._timezone);
      const taskDates = task.dueDate
        ? taskOccurrenceDates({ dueDate: task.dueDate, tags: task.tags, status: task.status }, startDate, endDate, { todayISO: rdTodayISO })
        : (createdDay && createdDay >= startDate && createdDay <= endDate ? [createdDay] : []);
      const isSeries = taskRepeats(task as any);
      for (const d of taskDates) {
        items.push({
          // A projected occurrence is not the stored row, so its id carries the
          // date — two occurrences of one task must not collide as one item.
          id: isSeries ? `task-${task.id}-${d}` : `task-${task.id}`,
          type: "task", title: task.title, date: d,
          time: task.dueTime || undefined,
          allDay: !task.dueTime,
          color: taskColor, category: "task", description: task.description,
          // Only the stored occurrence can be complete; projected future ones
          // are always still to do.
          completed: task.status === "done" && d === String(task.dueDate || "").slice(0, 10),
          linkedProfiles: task.linkedProfiles, sourceId: task.id,
          meta: { priority: task.priority, status: task.status, tags: task.tags, recurring: isSeries },
        });
      }
    }

    // Recurring bills as first-class calendar objects (2026-07). Each recurring
    // liability generates its payment occurrences on the fly (no occurrence
    // table) and every occurrence in the window lands on the calendar as a
    // distinct "bill" item, linked back to its liability profile. Per-occurrence
    // state (paid / skipped / rescheduled) comes from fields.occurrences and the
    // liability_payments history — see shared/liability-schedule.ts.
    // EVERY liability — recurring bills AND loans / credit cards / one-time
    // debts — puts its payment due dates on the calendar (user: "all the
    // liabilities should look similar; do it for all, not just subscriptions").
    // Non-recurring families derive a monthly payment series from their terms.
    {
      // A liability's owner chain is its parent PLUS every party on it (a
      // co-signer): the bill Linda co-signs is on Linda's calendar, as it is
      // on her bills list. With the parent alone her scoped calendar dropped it.
      const partiesByLiab = new Map<string, string[]>();
      for (const l of (timelineLiabLinks || []) as any[]) {
        if (!l?.liabilityProfileId || !l?.partyProfileId) continue;
        partiesByLiab.set(l.liabilityProfileId, [...(partiesByLiab.get(l.liabilityProfileId) || []), l.partyProfileId]);
      }
      const liabOwners = (p: any): string[] => Array.from(new Set([...(p.parentProfileId ? [p.parentProfileId] : []), ...(partiesByLiab.get(p.id) || [])]));
      const liabProfiles = profiles.filter((p: any) =>
        (p.type === "liability" || p.type === "loan") &&
        matchesProfile(liabOwners(p)));
      // One query for all liability payments, grouped, so paid status is exact.
      const payByLiab = new Map<string, Array<{ paymentDate?: string; id?: string }>>();
      const liabIds = liabProfiles.map((p: any) => p.id);
      if (liabIds.length > 0) {
        const { data: payRows } = await this.supabase
          .from("liability_payments").select("id,payment_date,liability_profile_id")
          .eq("user_id", this.userId).in("liability_profile_id", liabIds);
        for (const r of payRows || []) {
          const arr = payByLiab.get(r.liability_profile_id) || [];
          arr.push({ paymentDate: r.payment_date, id: r.id });
          payByLiab.set(r.liability_profile_id, arr);
        }
      }
      const todayISO = getUserToday(this._timezone);
      const toUiStatus = (s: ScheduleOccurrence["status"]) =>
        s === "paid" ? "done" : s === "overdue" ? "late" : s === "skipped" ? "skipped" : "pending";
      for (const p of liabProfiles as any[]) {
        const typeKey = p.type_key ?? p.typeKey;
        const sf = deriveScheduleFields(p.fields || {}, typeKey, todayISO);
        const occ = generateSchedule({ id: p.id, fields: sf }, payByLiab.get(p.id) || [], { todayISO, windowStart: startDate, windowEnd: endDate });
        const owner = liabOwners(p);
        const fam = liabilityFamily(typeKey);
        const freq = liabilityFrequency({ id: p.id, fields: sf });
        for (const o of occ) {
          // The generator admits an occurrence when EITHER its anchor day or
          // its moved day is inside the window; the timeline answers for the
          // day the occurrence actually falls on, so a bill moved from the
          // 5th to the 12th must not come back for a 5th-only query.
          if (o.effectiveDate < startDate || o.effectiveDate > endDate) continue;
          items.push({
            id: `bill-${p.id}-${o.date}`,
            type: "obligation",
            title: p.name,
            date: o.effectiveDate,
            allDay: true,
            color: "#C75B5B",
            category: "bill",
            linkedProfiles: owner,
            sourceId: p.id,
            completed: o.status === "paid",
            meta: {
              kind: fam === "recurring" ? "bill" : "payment",
              status: toUiStatus(o.status),
              amount: o.amount,
              recurrence: freq,
              occurrenceId: o.occurrenceId,
              liabilityId: p.id,
              notes: o.notes,
            },
          } as any);
        }
      }
    }

    // Habits intentionally NOT emitted as calendar items — they live on their
    // own page and clutter the calendar with repeating noise. Re-enable here
    // if a future view wants them, but the calendar tab does not.

    // ── Dedup: remove events that duplicate an obligation on the same date ──
    // Whole-name matches only, and same-date obligations keyed by their source
    // row — see dedupCalendarTimelineItems for what the old substring match did.
    const finalItems = dedupCalendarTimelineItems(items);
    items.length = 0;
    items.push(...finalItems);

    // (Removed: a document-expiration pass that read `doc.expirationDate ||
    // doc.fields?.expirationDate`. `rowToDocument` populates NEITHER — a
    // document's extracted dates live in `extractedData` — so the branch never
    // fired and document expirations were absent from this grid entirely,
    // while the Recurring screen showed them. Documents are now adapted by the
    // Date Rule engine in the block at the top of this method, alongside
    // profile-carried dates, so both surfaces read the same set.)

    // (Removed: a second pass that iterated habit.checkins and pushed an
    // additional habit item per checkin. The earlier loop above already
    // projects habits onto each applicable day and merges the checkin
    // count into the title. The second pass duplicated those days AND
    // emitted them with `linkedProfiles: []`, which leaked the habit into
    // every filtered view regardless of who the habit belongs to.)

    // ── Loan amortization payments ───────────────────────────────
    // The user has scheduled loan payments in `loan_amortization` (one row
    // per payment). Previously these were only readable via the dedicated
    // schedule view; the unified calendar didn't surface them, so a user
    // looking at their month had no idea their car payment was hitting on
    // the 17th. Pull unpaid rows in range and add them as obligation-style
    // items so they participate in the same dedup pass below.
    try {
      const { data: loanRows } = await this.supabase
        .from('loan_amortization')
        .select('*')
        .eq('user_id', this.userId)
        // Only unpaid rows are ever rendered (the JS `row.paid` check below
        // stays as the authority); paid rows accumulate forever, so push the
        // filter down. `.or` keeps rows where paid is false OR null — `.eq`
        // would silently drop the null-paid legacy rows.
        .or('paid.is.null,paid.eq.false');
      if (Array.isArray(loanRows)) {
        // Map loan_id → profile linked profiles (so per-profile filtering works).
        const loanProfileMap = new Map<string, string[]>();
        for (const p of profiles) {
          if (p.type === 'loan' || p.type === 'liability') loanProfileMap.set(p.id, [p.id]);
        }
        for (const row of loanRows) {
          if (row.paid) continue;
          const dueRaw = row.due_date || row.payment_date || row.date;
          if (!dueRaw) continue;
          const d = String(dueRaw).slice(0, 10);
          if (d < startDate || d > endDate) continue;
          const linked = (row.loan_id && loanProfileMap.get(row.loan_id)) || [];
          if (!matchesProfile(linked)) continue;
          const amt = Number(row.payment || row.amount || row.payment_amount || 0);
          const name = row.loan_name || 'Loan payment';
          items.push({
            id: `loan-${row.id || row.loan_id}-${d}`,
            type: 'obligation',
            title: `${name} — $${amt.toFixed(2)}`,
            date: d,
            allDay: true,
            color: '#A13544',
            category: 'loan',
            description: `Scheduled loan payment ($${amt.toFixed(2)})`,
            linkedProfiles: linked,
            sourceId: row.loan_id || row.id,
            meta: { amount: amt, paymentNumber: row.payment_number, source: 'loan_amortization' },
          });
        }
      }
    } catch (e: any) {
      console.warn('[calendar] loan amortization read failed:', e?.message);
    }

    // (Removed 2026-08-20: two more date vocabularies lived here.
    //
    //  1. "Profile-derived virtual events" — a hard-coded ladder of
    //     (profile.type, exact field key) pairs: person→birthday,
    //     vehicle→nextService, property→leaseEnd, account→expirationDate…
    //     It matched one spelling per type and only ISO values, so an
    //     `expiration_date` or a "07/18/2034" was invisible, and a licence
    //     expiration typed onto a PERSON matched no branch at all.
    //  2. "Document-extracted dates" — a second regex over extractedData that
    //     emitted the SAME dates again under different titles
    //     ("⚠️ … — Expiration" vs "📄 … expires"), which is what made
    //     `stripGeneratedSuffix` in shared/calendar-occurrences necessary.
    //
    // Both are superseded by the Date Rule pass at the top of this method: it
    // reads every profile type and every document, understands every key
    // spelling, and normalizes non-ISO values — so it is a strict superset of
    // what these two produced, emitted once each.)

    items.sort((a, b) => {
      const cmp = a.date.localeCompare(b.date);
      if (cmp !== 0) return cmp;
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return (a.time || "").localeCompare(b.time || "");
    });
    return items;
  }

  // ============================================================
  // DOCUMENTS
  // ============================================================
  async getDocuments(profileIds?: string[]): Promise<Document[]> {
    return this.memo(`getDocuments${this._fk(profileIds)}`, async () => {
      if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
      // PERF: metadata-only projection (see DOCUMENT_LIST_COLUMNS) excludes
      // file_data. DB pushdown of profile scope via idx_documents_linked_profiles_gin.
      let q = this.supabase.from("documents")
        .select(DOCUMENT_LIST_COLUMNS)
        .eq("user_id", this.userId)
        .is("deleted_at", null);
      q = this._applyProfileFilter(q, await this.pushdownIds(profileIds));
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map(r => this.rowToDocument({ ...r, file_data: "" }));
    });
  }

  // [PERF Phase 4] Server-side paginated documents. Pushes projection, profile
  // scope, ordering, range (limit/offset) AND an exact total count into
  // Supabase in ONE round-trip, so a list request fetches only the page it
  // renders instead of the whole documents table (all rows + extracted_data).
  //
  // Ordering matches getDocuments (created_at desc) so the page is byte-identical
  // to what the old fetch-all-then-slice returned for the same offset/limit.
  // `total` is the exact count of ALL matching rows (independent of the range),
  // so the route can set X-Total-Count without a second query.
  //
  // profileIds pushdown reproduces the NON-orphan half of passesProfileFilter
  // (linked_profiles contains any selected id). Callers must only pass
  // profileIds when the selection contains NO self-type profile — the orphan
  // inclusion rule (empty linked_profiles pass when a self profile is selected)
  // is NOT expressed here and stays on the fetch-all path. everyone-mode
  // (no profileIds) has no orphan concept and is always safe to push down.
  async getDocumentsPage(opts?: {
    profileIds?: string[];
    limit?: number;
    offset?: number;
  }): Promise<{ rows: Document[]; total: number }> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    let q = this.supabase.from("documents")
      .select(DOCUMENT_LIST_COLUMNS, { count: "exact" })
      .eq("user_id", this.userId)
      .is("deleted_at", null);
    q = this._applyProfileFilter(q, await this.pushdownIds(opts?.profileIds));
    let ranged: any = q.order("created_at", { ascending: false });
    const offset = Math.max(opts?.offset ?? 0, 0);
    if (opts?.limit != null) {
      const limit = Math.max(opts.limit, 1);
      ranged = ranged.range(offset, offset + limit - 1);
    } else if (offset > 0) {
      // Offset with no explicit limit: skip the first `offset` rows, keep the rest.
      ranged = ranged.range(offset, Number.MAX_SAFE_INTEGER);
    }
    const { data, count, error } = await ranged;
    if (error) throw error;
    const rows = (data || []).map((r: any) => this.rowToDocument({ ...r, file_data: "" }));
    return { rows, total: count ?? rows.length };
  }

  async getDocument(id: string): Promise<Document | undefined> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    const { data, error } = await this.supabase.from("documents").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error || !data) return undefined;
    const doc = this.rowToDocument(data);

    // If file is in Supabase Storage (not base64 in DB), download it on demand
    if (doc.storagePath && !doc.fileData) {
      try {
        const { data: blob, error: dlErr } = await this.supabase.storage
          .from(DOCUMENTS_BUCKET)
          .download(doc.storagePath);
        if (dlErr) {
          console.error(`[getDocument] Storage download failed for ${doc.storagePath}:`, dlErr.message);
        }
        if (!dlErr && blob) {
          const buffer = Buffer.from(await blob.arrayBuffer());
          doc.fileData = buffer.toString('base64');
        }
      } catch (e: any) {
        console.error(`[getDocument] Storage download error for ${doc.storagePath}:`, e.message);
      }
    }
    // If still no fileData and file_data column has data, use that
    if (!doc.fileData && data.file_data && data.file_data.length > 10) {
      doc.fileData = data.file_data;
    }
    return doc;
  }

  /**
   * PERF: metadata-only single-document read.
   *
   * `getDocument()` selects `*` (pulling the whole base64 `file_data` column for
   * legacy rows) AND downloads the object from Supabase Storage — even though
   * every JSON consumer strips the binary right back out. Opening a document
   * therefore paid for a full file transfer before the preview could start, and
   * the client then fetched the same bytes AGAIN via /file.
   *
   * This reads the metadata projection only. `hasFile` is resolved without
   * moving any bytes: a storage_path is proof on its own, and for legacy
   * base64-in-DB rows we run a filtered existence probe that selects just `id`.
   */
  async getDocumentMeta(id: string): Promise<(Omit<Document, "fileData"> & { hasFile: boolean }) | undefined> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    const { data, error } = await this.supabase.from("documents")
      .select(DOCUMENT_META_COLUMNS)
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .maybeSingle();
    if (error || !data) return undefined;
    const { fileData, ...meta } = this.rowToDocument({ ...(data as any), file_data: "" });

    let hasFile = !!(data as any).storage_path;
    if (!hasFile) {
      // Existence probe for pre-Storage rows: the filter runs in Postgres and
      // the projection is a single uuid, so no file bytes cross the wire.
      const { data: probe } = await this.supabase.from("documents")
        .select("id")
        .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
        .not("file_data", "is", null).neq("file_data", "")
        .maybeSingle();
      hasFile = !!probe;
    }
    return { ...meta, hasFile };
  }

  /**
   * PERF: delivery decision for the /file route. Storage-backed documents get
   * a short-lived signed URL so the device downloads straight from Supabase's
   * edge — piping every byte through the API function (Storage → serverless
   * Buffer → device) doubled the transfer and held the first pixel until the
   * LAST byte had crossed both hops, which read as a long spinner on every
   * photo/PDF open. Legacy base64-in-DB rows fall back to the buffer path.
   *
   * Kill switch: DOC_FILE_PROXY=1 forces the old proxied buffer path.
   * `opts.preview` asks for the phone-sized image preview variant — generated
   * on first use, served from the CDN afterwards; non-image documents and any
   * generation failure transparently serve the original instead.
   */
  async getDocumentDelivery(id: string, opts?: { preview?: boolean }): Promise<
    | { mode: "redirect"; url: string; mimeType: string; name: string; version: string; userId?: string }
    | { mode: "buffer"; buffer: Buffer; mimeType: string; name: string; version: string; userId?: string }
    | undefined
  > {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    if (process.env.DOC_FILE_PROXY !== "1") {
      const { data, error } = await this.supabase.from("documents")
        .select("id, user_id, name, mime_type, storage_path, updated_at, created_at")
        .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
        .maybeSingle();
      if (error || !data) return undefined;
      const row = data as any;
      if (row.storage_path) {
        const baseVersion = `${row.updated_at || row.created_at || ""}`;
        const wantsPreview = !!opts?.preview
          && PREVIEWABLE_MIME.test(row.mime_type || "")
          && process.env.DOC_PREVIEW !== "0";
        if (wantsPreview) {
          const previewPath = `${row.storage_path}${PREVIEW_SUFFIX}`;
          // Already generated on a previous open? Straight to the CDN.
          let url = await this.signStorageUrl(previewPath, /* quietMiss */ true);
          if (!url) {
            // First open: derive it now, then serve it. Even this open is
            // faster than shipping the original — the server-side download
            // rides the datacenter link, and the phone receives ~10x less.
            if (await this.generateDocumentPreview(row.storage_path, previewPath)) {
              url = await this.signStorageUrl(previewPath, true);
            }
          }
          if (url) {
            return {
              mode: "redirect", url,
              mimeType: "image/jpeg",
              name: row.name || "document",
              version: `${baseVersion}-p`,
              userId: row.user_id,
            };
          }
          // Generation unavailable — fall through to the original.
        }
        const url = await this.signStorageUrl(row.storage_path, false);
        if (url) {
          return {
            mode: "redirect", url,
            mimeType: row.mime_type || "application/octet-stream",
            name: row.name || "document",
            version: `${baseVersion}-r`,
            userId: row.user_id,
          };
        }
      }
    }
    // Legacy base64-in-DB row, signing failure, or forced proxy mode.
    const file = await this.getDocumentFile(id);
    return file ? { mode: "buffer" as const, ...file } : undefined;
  }

  /** Signed CDN URL for a storage object, or null. A missing preview object is
   *  an EXPECTED miss (quietMiss) — only real failures are logged. */
  private async signStorageUrl(path: string, quietMiss: boolean): Promise<string | null> {
    try {
      const { data: signed, error } = await this.supabase.storage
        .from(DOCUMENTS_BUCKET)
        .createSignedUrl(path, 300);
      if (error) {
        if (!quietMiss) console.error(`[getDocumentDelivery] sign failed for ${path}:`, error.message);
        return null;
      }
      const url = signed?.signedUrl;
      return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
    } catch (e: any) {
      if (!quietMiss) console.error(`[getDocumentDelivery] sign error for ${path}:`, e?.message || e);
      return null;
    }
  }

  /** Downscale the original into `<path>.prev.jpg` (max 1600px, JPEG). Returns
   *  false on ANY problem — the caller then serves the original, so preview
   *  generation can never break document viewing. */
  private async generateDocumentPreview(srcPath: string, previewPath: string): Promise<boolean> {
    try {
      const sharp = await loadSharp();
      if (!sharp) return false;
      const { data: blob, error } = await this.supabase.storage
        .from(DOCUMENTS_BUCKET)
        .download(srcPath);
      if (error || !blob) return false;
      const buf = Buffer.from(await blob.arrayBuffer());
      if (buf.length === 0 || buf.length > PREVIEW_SOURCE_LIMIT) return false;
      const out: Buffer = await sharp(buf)
        .rotate() // honor EXIF orientation — phone photos are usually rotated
        .resize({ width: PREVIEW_MAX_DIM, height: PREVIEW_MAX_DIM, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: PREVIEW_JPEG_QUALITY, mozjpeg: true })
        .toBuffer();
      // Upsert even when the source was already small: the stored preview is
      // what makes every subsequent open skip this generation step entirely.
      const { error: upErr } = await this.supabase.storage
        .from(DOCUMENTS_BUCKET)
        .upload(previewPath, out, { contentType: "image/jpeg", upsert: true });
      if (upErr) {
        console.error(`[doc-preview] upload failed for ${previewPath}:`, upErr.message);
        return false;
      }
      console.log(`[doc-preview] generated ${previewPath}: ${buf.length} → ${out.length} bytes`);
      return true;
    } catch (e: any) {
      console.warn(`[doc-preview] generation failed for ${srcPath}:`, e?.message || e);
      return false;
    }
  }

  /**
   * PERF: raw bytes for the /file route. Downloads straight into a Buffer
   * instead of the Storage-blob → base64 → Buffer round-trip `getDocument()`
   * forces (which doubles peak memory and burns CPU on every view).
   *
   * `version` is a cheap content identity used to build the route's ETag.
   */
  async getDocumentFile(id: string): Promise<{ buffer: Buffer; mimeType: string; name: string; version: string; userId?: string } | undefined> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    const { data, error } = await this.supabase.from("documents")
      .select("id, user_id, name, mime_type, storage_path, file_data, updated_at, created_at")
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null)
      .maybeSingle();
    if (error || !data) return undefined;
    const row = data as any;
    const mimeType = row.mime_type || "application/octet-stream";
    const name = row.name || "document";

    let buffer: Buffer | undefined;
    if (row.storage_path) {
      try {
        const { data: blob, error: dlErr } = await this.supabase.storage
          .from(DOCUMENTS_BUCKET)
          .download(row.storage_path);
        if (dlErr) console.error(`[getDocumentFile] Storage download failed for ${row.storage_path}:`, dlErr.message);
        else if (blob) buffer = Buffer.from(await blob.arrayBuffer());
      } catch (e: any) {
        console.error(`[getDocumentFile] Storage download error for ${row.storage_path}:`, e.message);
      }
    }
    if (!buffer && row.file_data && String(row.file_data).length > 10) {
      buffer = Buffer.from(String(row.file_data), "base64");
    }
    if (!buffer || buffer.length === 0) return undefined;
    return {
      buffer, mimeType, name,
      version: `${row.updated_at || row.created_at || ""}-${buffer.length}`,
      userId: row.user_id,
    };
  }

  async createDocument(data: any): Promise<Document> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    // ── The last write path ────────────────────────────────────────────────
    //
    // Normalizing dates in the routes and the AI tools covers every caller
    // that exists TODAY. Doing it here as well covers every caller, full stop
    // — a script, a migration, a tool added next month. A date is stored in
    // one form because the storage layer will not accept another, so the
    // question "can an actionable date be saved without its rule following?"
    // has a structural answer rather than an inventory of call sites.
    // See shared/date-rules.
    if (data.extractedData && typeof data.extractedData === "object") {
      data = { ...data, extractedData: normalizeEntityDateFields(data.extractedData as Record<string, any>, { contextKey: `${data.type ?? ""} ${data.name ?? ""}` }).fields };
    }
    if (data.fileData && typeof data.fileData === 'string' && data.fileData.length > 12_000_000) {
      throw new Error('File too large (max ~9MB decoded)');
    }
    // Supabase Storage migration: uploads target the private 'documents' bucket.
    // The bucket must exist in the Supabase dashboard (Storage > New bucket >
    // "documents", private). If absent, uploads fail and the code falls back
    // to base64 in the file_data column. After creating the bucket, new
    // documents use storage_path; existing base64 records can be migrated via
    // POST /api/cleanup/migrate-documents-to-storage.
    const id = randomUUID();
    const now = new Date().toISOString();
    let storagePath: string | null = null;
    let fileDataForDB: string = data.fileData || "";

    // Upload to Supabase Storage if we have base64 file data
    if (data.fileData && data.fileData.length > 0) {
      try {
        const storagePath2 = `${this.userId}/${id}.${getExtension(data.mimeType)}`;
        const buffer = Buffer.from(data.fileData, 'base64');
        const { error: uploadError } = await this.supabase.storage
          .from(DOCUMENTS_BUCKET)
          .upload(storagePath2, buffer, {
            contentType: data.mimeType,
            upsert: true,
          });
        if (!uploadError) {
          storagePath = storagePath2;
          fileDataForDB = ""; // Don't store base64 when we have storage
        } else {
          console.error('Storage upload failed, falling back to base64:', uploadError.message);
          // Keep file_data as-is (base64 fallback)
        }
      } catch (err: any) {
        console.error(`[Storage] Upload exception for ${id}:`, err.message);
        // Fall back to storing base64 in DB
      }
    }

    let linkedProfiles = data.linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    const { error } = await this.supabase.from("documents").insert({
      id, user_id: this.userId, name: data.name, type: data.type || "other",
      mime_type: data.mimeType || "image/jpeg", file_data: fileDataForDB,
      storage_path: storagePath,
      extracted_data: data.extractedData || {}, linked_profiles: linkedProfiles,
      tags: data.tags || [], created_at: now,
    });
    if (error) throw error;
    // PERF FIX: was sequential linkProfileTo per profile — N round trips for
    // a multi-profile upload. Parallelize so a 5-profile link is one burst.
    await Promise.all(
      linkedProfiles.map((pid: string) =>
        this.linkProfileTo(pid, "document", id).catch((e: any) => {
          console.warn(`[createDocument] linkProfileTo failed for ${pid}:`, e?.message);
        })
      )
    );
    this.logActivity("document", `Stored document: ${data.name}`);
    return (await this.getDocument(id))!;
  }

  async updateDocument(id: string, data: Partial<Document>): Promise<Document | undefined> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    const existing = await this.getDocument(id);
    if (!existing) return undefined;
    // ── The last write path ────────────────────────────────────────────────
    //
    // Normalizing dates in the routes and the AI tools covers every caller
    // that exists TODAY. Doing it here as well covers every caller, full stop
    // — a script, a migration, a tool added next month. A date is stored in
    // one form because the storage layer will not accept another, so the
    // question "can an actionable date be saved without its rule following?"
    // has a structural answer rather than an inventory of call sites.
    // See shared/date-rules.
    if (data.extractedData && typeof data.extractedData === "object") {
      data = { ...data, extractedData: normalizeEntityDateFields(data.extractedData as Record<string, any>, { contextKey: `${data.type ?? existing.type ?? ""} ${data.name ?? existing.name ?? ""}` }).fields };
    }
    // [P0.2] documents has updated_at, but rowToDocument doesn't surface it —
    // read it directly (only when the caller actually sent expectedUpdatedAt).
    if ((data as any).expectedUpdatedAt !== undefined) {
      const { data: curRow } = await this.supabase.from("documents")
        .select("updated_at").eq("id", id).eq("user_id", this.userId).maybeSingle();
      this.assertNoWriteConflict(data as Record<string, any>, curRow?.updated_at);
    }
    if (data.linkedProfiles) {
      // PERF FIX: was sequential getProfile + update per removed profile, then
      // sequential linkProfileTo per added profile — up to 2N round trips.
      const removedPids = existing.linkedProfiles.filter(pid => !data.linkedProfiles!.includes(pid));
      const addedPids = data.linkedProfiles.filter(pid => !existing.linkedProfiles.includes(pid));
      // Unlink removed profiles in parallel
      await Promise.all(removedPids.map(async pid => {
        try {
          const profile = await this.getProfile(pid);
          if (profile) {
            const newDocs = profile.documents.filter(did => did !== id);
            await this.supabase.from("profiles").update({ documents: newDocs }).eq("id", pid).eq("user_id", this.userId);
          }
        } catch (e: any) {
          console.warn(`[updateDocument] unlink failed for ${pid}:`, e?.message);
        }
      }));
      // Link added profiles in parallel
      await Promise.all(addedPids.map(pid =>
        this.linkProfileTo(pid, "document", id).catch((e: any) => {
          console.warn(`[updateDocument] linkProfileTo failed for ${pid}:`, e?.message);
        })
      ));
    }
    const merged = { ...existing, ...data };
    const { error } = await this.supabase.from("documents").update(onlyPatched({
      name: merged.name, type: merged.type, mime_type: merged.mimeType,
      file_data: merged.fileData, extracted_data: merged.extractedData,
      tags: merged.tags,
      updated_at: new Date().toISOString(),
    }, data as Record<string, any>, { name: "name", type: "type", mime_type: "mimeType", file_data: "fileData", extracted_data: "extractedData", tags: "tags" })).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // [P2.2] Ownership patches go through the single writer (setOwners), not a
    // raw linked_profiles write. This also reconciles the removals that the
    // linkProfileTo calls above (additive, per added pid) don't cover.
    if (data.linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("document", id, data.linkedProfiles);
    }
    return this.getDocument(id);
  }

  async deleteDocument(id: string): Promise<boolean> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    // A soft delete keeps this document's entity_links: restore brings the links
    // back with the row, and link readers hide endpoints that sit in the trash
    // (pruneLinksToTrashed). Only the hard deletes wipe them.
    // A SOFT delete that is actually soft. The old version soft-deleted the
    // row while destroying the bytes (file_data cleared, Storage blob and
    // preview removed, owners wiped) — so "restore" produced a zombie: a row
    // with no file, no owners, and a viewer that couldn't open it, while the
    // UI called the delete recoverable. Bytes and owners now survive until an
    // explicit purgeDocument.
    try {
      const doc = await this.getDocumentMeta(id);
      if (doc) {
        // Take the doc out of each owner's documents[] array; restoreDocument
        // puts it back (linked_profiles on the row is the canonical side and
        // is kept).
        await Promise.all(doc.linkedProfiles.map(async pid => {
          try {
            const profile = await this.getProfile(pid);
            if (profile) {
              const newDocs = profile.documents.filter(did => did !== id);
              await this.supabase.from("profiles").update({ documents: newDocs }).eq("id", pid).eq("user_id", this.userId);
            }
          } catch (innerErr: any) {
            console.warn(`[deleteDocument] cleanup failed for profile ${pid}:`, innerErr?.message);
          }
        }));
      }
    } catch (e: any) {
      console.error(`[deleteDocument] Profile cleanup error for ${id}:`, e.message);
    }
    const { data, error } = await this.supabase.from("documents")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).select("id");
    if (error) {
      console.error(`[deleteDocument] Supabase error for ${id}:`, error.message);
      return false;
    }
    // Honest: 0 rows matched ⇒ false (the old version returned true no matter what).
    return Array.isArray(data) && data.length > 0;
  }

  /**
   * Destroy a document's bytes and row, permanently. The ONLY place allowed
   * to remove the Storage blob — a soft delete never does. Works on a live or
   * an already-soft-deleted document.
   */
  async purgeDocument(id: string): Promise<boolean> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    let storagePathToRemove: string | undefined;
    try {
      // Direct read, deliberately NOT getDocumentMeta: that filters deleted_at,
      // and purge's main job is destroying a soft-deleted document's bytes.
      const { data: row } = await this.supabase.from("documents")
        .select("storage_path").eq("id", id).eq("user_id", this.userId).maybeSingle();
      storagePathToRemove = (row as any)?.storage_path || undefined;
    } catch { /* row lookup below still decides success */ }
    // Bytes first, then the row: a purge interrupted between the two leaves a
    // recoverable-looking row with no bytes — exactly the zombie — so remove
    // the row last only after the blob removal has been attempted.
    if (storagePathToRemove) {
      try {
        const { error: rmErr } = await this.supabase.storage.from(DOCUMENTS_BUCKET)
          .remove([storagePathToRemove, `${storagePathToRemove}${PREVIEW_SUFFIX}`]);
        if (rmErr) console.error(`[purgeDocument] Storage remove failed for ${storagePathToRemove}:`, rmErr.message);
      } catch (e: any) {
        console.error(`[purgeDocument] Storage remove exception:`, e.message);
      }
    }
    const { data, error } = await this.supabase.from("documents")
      .delete().eq("id", id).eq("user_id", this.userId).select("id");
    if (error) {
      console.error(`[purgeDocument] Supabase error for ${id}:`, error.message);
      return false;
    }
    return Array.isArray(data) && data.length > 0;
  }

  /** Un-delete a document and put it back in its owners' documents[] arrays. */
  async restoreDocument(id: string): Promise<boolean> {
    const { data, error } = await this.supabase.from("documents")
      .update({ deleted_at: null })
      .eq("id", id).eq("user_id", this.userId).select("id, linked_profiles");
    if (error || !Array.isArray(data) || data.length === 0) return false;
    // Owners that no longer exist are dropped BEFORE re-linking, so the doc
    // lands in a live profile's documents[] rather than in nobody's.
    const owners = await this._reownRestoredRow("document", id, data[0]);
    await Promise.all(owners.map(async pid => {
      try {
        const profile = await this.getProfile(pid);
        if (profile && !profile.documents.includes(id)) {
          await this.supabase.from("profiles")
            .update({ documents: [...profile.documents, id] })
            .eq("id", pid).eq("user_id", this.userId);
        }
      } catch (e: any) {
        console.warn(`[restoreDocument] re-link failed for profile ${pid}:`, e?.message);
      }
    }));
    return true;
  }

  async getDocumentsForProfile(profileId: string): Promise<Document[]> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    const allDocs = await this.getDocuments();
    return allDocs.filter(d => d.linkedProfiles.includes(profileId));
  }

  /**
   * Backfill: migrate existing base64 file_data from DB rows to Supabase Storage.
   * Sets storage_path and clears file_data for each migrated document.
   * Returns count of documents migrated.
   */
  async migrateDocumentsToStorage(): Promise<{ migrated: number; errors: string[] }> {
    const { data: docs, error } = await this.supabase.from("documents")
      .select("id, name, mime_type, file_data, storage_path")
      .eq("user_id", this.userId)
      .is("storage_path", null)
      .not("file_data", "eq", "")
      .not("file_data", "is", null);
    if (error || !docs) return { migrated: 0, errors: [error?.message || "No docs"] };
    let migrated = 0;
    const errors: string[] = [];
    for (const doc of docs) {
      if (!doc.file_data || doc.file_data.length < 10) continue; // skip empty/tiny
      try {
        const safeName = (doc.name || 'document').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
        const path = `${this.userId}/${doc.id}/${safeName}`;
        const buffer = Buffer.from(doc.file_data, 'base64');
        const { error: uploadErr } = await this.supabase.storage
          .from(DOCUMENTS_BUCKET)
          .upload(path, buffer, { contentType: doc.mime_type || 'application/octet-stream', upsert: true });
        if (uploadErr) {
          errors.push(`${doc.id}: ${uploadErr.message}`);
          continue;
        }
        // Update DB: set storage_path, clear file_data
        await this.supabase.from("documents").update({ storage_path: path, file_data: "" }).eq("id", doc.id).eq("user_id", this.userId);
        migrated++;
      } catch (e: any) {
        errors.push(`${doc.id}: ${e.message}`);
      }
    }
    return { migrated, errors };
  }

  // ============================================================
  // HABITS
  // ============================================================
  async getHabits(profileIds?: string[]): Promise<Habit[]> {
    return this.memo(`getHabits${this._fk(profileIds)}`, async () => {
      // PERF (durable-fix-phase1): DB pushdown via idx_habits_linked_profiles.
      let habitsQuery = this.supabase.from("habits").select("*").eq("user_id", this.userId).is("deleted_at", null);
      habitsQuery = this._applyProfileFilter(habitsQuery, await this.pushdownIds(profileIds));
      // Fetch habits first, then constrain child rows to those parents. This
      // remains two total queries (not N+1) while avoiding a transfer of every
      // check-in owned by unrelated profiles.
      // [PERF 2026-07-31] Checkins are windowed to the last 400 days — the
      // table grows forever and was fetched IN FULL on every dashboard
      // bootstrap. 400 days comfortably covers every consumer: streak math
      // walks back ≤30 days (rowToHabit / getStats), completion rates use
      // today/this week, and the habit heatmaps show ≤ a year.
      const checkinCutoff = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
      const habitsResult = await habitsQuery;
      if (habitsResult.error) throw habitsResult.error;
      const habitRows = habitsResult.data || [];
      if (habitRows.length === 0) return [];
      const habitIds = habitRows.map((row: any) => row.id);
      const checkinsResult = await this.supabase
        .from("habit_checkins")
        .select("*")
        .eq("user_id", this.userId)
        .in("habit_id", habitIds)
        .gte("date", checkinCutoff)
        .order("date", { ascending: true });
      if (checkinsResult.error) throw checkinsResult.error;
      const checkinsByHabit = new Map<string, any[]>();
      for (const c of checkinsResult.data || []) {
        const arr = checkinsByHabit.get(c.habit_id) || [];
        arr.push(c);
        checkinsByHabit.set(c.habit_id, arr);
      }
      return habitRows.map(r =>
        this.rowToHabit(r, (checkinsByHabit.get(r.id) || []).map(c => this.rowToHabitCheckin(c)))
      );
    });
  }

  async getHabit(id: string): Promise<Habit | undefined> {
    const { data, error } = await this.supabase.from("habits").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error || !data) return undefined;
    const { data: checkins } = await this.supabase.from("habit_checkins").select("*").eq("habit_id", id).eq("user_id", this.userId).order("date", { ascending: true });
    return this.rowToHabit(data, (checkins || []).map(c => this.rowToHabitCheckin(c)));
  }

  async createHabit(data: InsertHabit): Promise<Habit> {
    const id = randomUUID();
    const now = new Date().toISOString();
    // Auto-link to self profile if no profiles specified
    let linkedProfiles = (data as any).linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    const { error } = await this.supabase.from("habits").insert({
      id, user_id: this.userId, name: data.name, icon: data.icon || null,
      color: data.color || null, frequency: data.frequency || "daily",
      target_days: data.targetDays || null, target_per_day: data.targetPerDay || 1,
      start_date: (data as any).startDate || null, end_date: (data as any).endDate || null,
      time_of_day: (data as any).timeOfDay || null,
      scheduled_time: (data as any).scheduledTime || null,
      current_streak: 0, longest_streak: 0,
      linked_profiles: linkedProfiles,
      linked_tracker_id: (data as any).linkedTrackerId || null,
      created_at: now,
    });
    if (error) throw error;
    for (const pId of linkedProfiles) {
      try { await this.linkProfileTo(pId, "habit", id); } catch {}
    }
    this.logActivity("habit", `Created habit: ${data.name}`);
    return (await this.getHabit(id))!;
  }

  async checkinHabit(habitId: string, date?: string, value?: number, notes?: string): Promise<HabitCheckin | undefined> {
    const habit = await this.getHabit(habitId);
    if (!habit) return undefined;
    const checkinDate = date || getUserToday(this._timezone);
    // Allow multiple check-ins per day up to targetPerDay
    const todayCheckins = habit.checkins.filter(c => c.date === checkinDate);
    const maxPerDay = habit.targetPerDay || 1;
    if (todayCheckins.length >= maxPerDay) {
      // Already at max for today
      return todayCheckins[todayCheckins.length - 1];
    }
    const id = randomUUID();
    const ts = new Date().toISOString();
    const { error } = await this.supabase.from("habit_checkins").insert({
      id, user_id: this.userId, habit_id: habitId, date: checkinDate,
      value: value ?? null, notes: notes || null, timestamp: ts,
    });
    if (error) throw error;
    // Reconcile the day AFTER the insert: the read-then-insert above cannot see
    // a concurrent check-in (two taps, two tabs, two lambdas), so a daily
    // habit ended up with two rows for one day. Whoever runs this deletes the
    // surplus beyond targetPerDay, oldest rows win, and a caller whose row
    // lost gets the surviving row back — one day, one truth, from any path.
    let returned: HabitCheckin = { id, date: checkinDate, value, notes, timestamp: ts };
    const { data: dayRows } = await this.supabase.from("habit_checkins").select("id, date, value, notes, timestamp")
      .eq("habit_id", habitId).eq("user_id", this.userId).eq("date", checkinDate)
      .order("timestamp", { ascending: true }).order("id", { ascending: true });
    if (Array.isArray(dayRows) && dayRows.length > maxPerDay) {
      const surplus = dayRows.slice(maxPerDay).map((r: any) => r.id);
      await this.supabase.from("habit_checkins").delete().in("id", surplus).eq("user_id", this.userId);
      if (surplus.includes(id)) returned = this.rowToHabitCheckin(dayRows[maxPerDay - 1]);
    }
    // Recalculate streaks (with targetPerDay support)
    const { data: allCheckins } = await this.supabase.from("habit_checkins").select("date").eq("habit_id", habitId).eq("user_id", this.userId);
    const { current, longest } = calculateStreak(allCheckins || [], habit.targetPerDay || 1, this._timezone, habit as any);
    await this.supabase.from("habits").update({
      current_streak: current, longest_streak: Math.max(longest, habit.longestStreak),
    }).eq("id", habitId).eq("user_id", this.userId);
    this.logActivity("habit", `Checked in: ${habit.name}`);
    return returned;
  }

  async deleteHabitCheckin(habitId: string, checkinId: string): Promise<boolean> {
    const habit = await this.getHabit(habitId);
    if (!habit) return false;
    const { error } = await this.supabase.from("habit_checkins").delete().eq("id", checkinId).eq("habit_id", habitId).eq("user_id", this.userId);
    if (error) return false;
    // Recalculate streaks after deletion. `longest_streak` is an all-time
    // record: un-checking today must never lower it (checkinHabit and
    // MemStorage both guard with Math.max — this path used to be the one
    // backend that didn't, so an undo could destroy a year-old record).
    const { data: allCheckins } = await this.supabase.from("habit_checkins").select("date").eq("habit_id", habitId).eq("user_id", this.userId);
    const { current, longest } = calculateStreak(allCheckins || [], habit.targetPerDay || 1, this._timezone, habit as any);
    await this.supabase.from("habits").update({
      current_streak: current, longest_streak: Math.max(longest, habit.longestStreak || 0),
    }).eq("id", habitId).eq("user_id", this.userId);
    return true;
  }

  async updateHabit(id: string, data: Partial<Habit>): Promise<Habit | undefined> {
    const existing = await this.getHabit(id);
    if (!existing) return undefined;
    // [P0.2] Optimistic concurrency: compare against the trigger-maintained
    // updated_at column (fetched only when the caller sent expectedUpdatedAt).
    const habitVersion = await this.assertNoWriteConflictFor("habits", id, data as Record<string, any>);
    const merged = { ...existing, ...data };
    const { error } = await this.guardedWrite(this.supabase.from("habits").update(onlyPatched({
      name: merged.name, icon: merged.icon || null, color: merged.color || null,
      frequency: merged.frequency, target_days: merged.targetDays || null,
      target_per_day: merged.targetPerDay || existing.targetPerDay || 1,
      start_date: merged.startDate || null, end_date: merged.endDate || null,
      time_of_day: merged.timeOfDay || null,
      scheduled_time: merged.scheduledTime || null,
      linked_tracker_id: merged.linkedTrackerId || null,
    }, data as Record<string, any>, { name: "name", icon: "icon", color: "color", frequency: "frequency", target_days: "targetDays", target_per_day: "targetPerDay", start_date: "startDate", end_date: "endDate", time_of_day: "timeOfDay", scheduled_time: "scheduledTime", linked_tracker_id: "linkedTrackerId" })).eq("id", id).eq("user_id", this.userId), habitVersion);
    if (error) throw error;
    // [P2.2] Ownership patches go through the single writer (setOwners), not a
    // raw linked_profiles write alongside the rest of the patch.
    if (data.linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("habit", id, data.linkedProfiles);
    }
    return this.getHabit(id);
  }

  /**
   * The tracker a habit mirrors its check-ins into, when that tracker holds
   * NOTHING but this habit's mirror entries (an auto-created one). A tracker
   * the user logs to directly is theirs and must survive the habit.
   */
  private async habitMirrorTrackerId(habitId: string, habitName: string | null | undefined, linkedTrackerId: string | null | undefined): Promise<string | null> {
    if (!linkedTrackerId) return null;
    // Fail CLOSED: any doubt means the tracker stays. (A lookup error once
    // made the `every` below vacuously true and retired a user's own tracker.)
    const [{ data: tracker, error: tErr }, { data: entries, error: eErr }] = await Promise.all([
      this.supabase.from("trackers").select("name").eq("id", linkedTrackerId).eq("user_id", this.userId).maybeSingle(),
      this.supabase.from("tracker_entries").select("entry_values").eq("tracker_id", linkedTrackerId).eq("user_id", this.userId).is("deleted_at", null).limit(500),
    ]);
    if (tErr || eErr || !tracker) return null;
    const rows = entries || [];
    const allMirrors = rows.every((e: any) => (e?.entry_values as any)?.["_habitId"] === habitId);
    if (!allMirrors) return null;
    // An EMPTY tracker is only a mirror if it is the one auto-created for this
    // habit (habit-completion names it after the habit); a tracker the user
    // made and linked, with nothing logged yet, is theirs.
    if (rows.length === 0 && String(tracker.name || "").trim() !== String(habitName || "").trim()) return null;
    return linkedTrackerId;
  }

  async deleteHabit(id: string): Promise<boolean> {
    // A soft delete keeps this habit's entity_links: restore brings the links
    // back with the row, and link readers hide endpoints that sit in the trash
    // (pruneLinksToTrashed). Only the hard deletes wipe them.
    // Read the link before the row is hidden: the habit's mirror tracker (if
    // it is purely a mirror) is retired with it. Otherwise a deleted habit
    // kept showing up on the Trackers page under its own name, with its
    // check-ins, as if it still existed.
    const { data: habitRow } = await this.supabase.from("habits").select("linked_tracker_id, name")
      .eq("id", id).eq("user_id", this.userId).maybeSingle();
    const mirrorId = await this.habitMirrorTrackerId(id, habitRow?.name, habitRow?.linked_tracker_id);
    // Goals reading this habit's streak (or the mirror tracker retired with
    // it) keep their last figure.
    await this.freezeGoalProgress("habit_id", id);
    if (mirrorId) await this.freezeGoalProgress("tracker_id", mirrorId);
    // Soft delete the habit and KEEP its check-ins. The old hard-delete of
    // habit_checkins made "recoverable" a lie: restore returned an empty habit
    // with a phantom stored streak and no history. Check-in readers join
    // through the habits list (which filters deleted_at), so the retained rows
    // leak nowhere while the habit is deleted — and come back with it.
    // `.select` so 0 rows matched reports false.
    const deletedAt = new Date().toISOString();
    const { data, error } = await this.supabase.from("habits")
      .update({ deleted_at: deletedAt })
      .eq("id", id).eq("user_id", this.userId).select("id");
    const ok = !error && Array.isArray(data) && data.length > 0;
    if (ok && mirrorId) {
      // Same timestamp on the tracker and its entries, so restore can revive
      // exactly this retirement and nothing deleted separately before it.
      await this.supabase.from("trackers").update({ deleted_at: deletedAt }).eq("id", mirrorId).eq("user_id", this.userId);
      await this.supabase.from("tracker_entries").update({ deleted_at: deletedAt }).eq("tracker_id", mirrorId).eq("user_id", this.userId).is("deleted_at", null);
      bustInsightsCacheFor(this.userId);
    } else if (ok && habitRow?.linked_tracker_id) {
      // The habit was linked to the user's OWN tracker: it survives, but the
      // habit's mirror entries on it ("Completed run", no measurement) used to
      // stay behind as phantom rows pointing at a deleted habit (D228). They
      // go to the trash with the habit (same stamp, so a restore brings them
      // back); an entry another habit also owns is only unpaired.
      await this.retireHabitMirrorEntries(id, String(habitRow.linked_tracker_id), deletedAt);
    }
    return ok;
  }

  /** Trash this habit's own mirror entries on `trackerId` and unpair shared ones (D228). */
  private async retireHabitMirrorEntries(habitId: string, trackerId: string, deletedAt: string): Promise<void> {
    try {
      const { data: rows } = await this.supabase.from("tracker_entries").select("id, entry_values")
        .eq("tracker_id", trackerId).eq("user_id", this.userId).is("deleted_at", null);
      for (const r of (rows || []) as any[]) {
        const ids = mirrorHabitIds(r.entry_values);
        if (!ids.includes(habitId)) continue;
        const others = ids.filter((x) => x !== habitId);
        if (others.length === 0) {
          await this.supabase.from("tracker_entries").update({ deleted_at: deletedAt }).eq("id", r.id).eq("user_id", this.userId);
        } else {
          const values: Record<string, any> = { ...(r.entry_values || {}) };
          delete values[HABIT_MIRROR_IDS_KEY];
          values[HABIT_MIRROR_KEY] = others[0];
          if (others.length > 1) values[HABIT_MIRROR_IDS_KEY] = others;
          await this.supabase.from("tracker_entries").update({ entry_values: values }).eq("id", r.id).eq("user_id", this.userId);
        }
      }
      bustInsightsCacheFor(this.userId);
    } catch (e: any) {
      console.warn(`[deleteHabit] could not retire mirror entries for ${habitId}: ${e?.message || e}`);
    }
  }

  async restoreHabit(id: string): Promise<boolean> {
    const { data: before } = await this.supabase.from("habits").select("deleted_at, linked_tracker_id")
      .eq("id", id).eq("user_id", this.userId).maybeSingle();
    const { data, error } = await this.supabase.from("habits").update({ deleted_at: null })
      .eq("id", id).eq("user_id", this.userId).select("id, linked_tracker_id, linked_profiles");
    const ok = !error && Array.isArray(data) && data.length > 0;
    if (ok) await this._reownRestoredRow("habit", id, data![0]);
    const trackerId = ok ? (data![0] as any)?.linked_tracker_id : null;
    if (trackerId) {
      // Revive the mirror tracker retired WITH this habit (matching stamp).
      const { data: tr } = await this.supabase.from("trackers").select("deleted_at").eq("id", trackerId).eq("user_id", this.userId).maybeSingle();
      if (tr?.deleted_at) {
        await this.supabase.from("trackers").update({ deleted_at: null }).eq("id", trackerId).eq("user_id", this.userId);
        await this.supabase.from("tracker_entries").update({ deleted_at: null }).eq("tracker_id", trackerId).eq("user_id", this.userId).eq("deleted_at", tr.deleted_at);
        bustInsightsCacheFor(this.userId);
      } else if (before?.deleted_at) {
        // The tracker survived the habit's deletion (the user's own): bring
        // back the mirror entries trashed with the habit — same stamp (D228).
        await this.supabase.from("tracker_entries").update({ deleted_at: null }).eq("tracker_id", trackerId).eq("user_id", this.userId).eq("deleted_at", before.deleted_at);
        bustInsightsCacheFor(this.userId);
      }
    }
    return ok;
  }

  /** Recently soft-deleted habits (newest deletion first) — for restore-by-name. */
  async getDeletedHabits(limit = 25): Promise<Habit[]> {
    const { data, error } = await this.supabase
      .from("habits").select("*").eq("user_id", this.userId)
      .not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data || []).map(r => this.rowToHabit(r, []));
  }

  // ============================================================
  // OBLIGATIONS — compat projection over recurring-bill liabilities
  // ============================================================
  // The dedicated `obligations` tables were retired (2026-07). Every recurring
  // bill now lives as a recurring-family LIABILITY profile (type_key utility /
  // subscription / bill …) with its recurrence in `fields`. These methods
  // project those liabilities into the legacy Obligation shape so existing
  // readers (dashboard upcoming bills, monthly total, insights, finance import)
  // keep working against the single liability source of truth. No obligation
  // table is ever queried.

  private billTypeKey(kind?: string | null, category?: string | null, name?: string | null): string {
    const k = String(kind || "").toLowerCase();
    const c = String(category || "").toLowerCase();
    const n = String(name || "").toLowerCase();
    // Name-based inference gives the detail page the right fields/layout for
    // common bills instead of a generic "bill". All of these stay in the
    // recurring family (excluded from net worth).
    if (/\b(phone|mobile|cell|wireless|cellular)\b/.test(n)) return "phone_plan";
    if (/\b(internet|broadband|wifi|fiber)\b/.test(n)) return "internet";
    if (/\b(electric|electricity|water|gas|sewer|utility|utilities|power)\b/.test(n)) return "utility";
    if (/\b(netflix|hulu|spotify|disney|hbo|streaming|apple tv|prime video)\b/.test(n)) return "streaming";
    if (/\b(gym|fitness|membership)\b/.test(n)) return "gym_membership";
    if (k === "subscription" || c === "subscription") return "subscription";
    if (c === "utilities" || c === "utility") return "utility";
    return "bill";
  }

  private liabilityToObligation(p: Profile, payments: ObligationPayment[] = [], partyIds: string[] = []): Obligation {
    const f: any = p.fields || {};
    const baseAmount = Number(f.monthlyAmount ?? f.monthly_amount ?? f.amount ?? f.cost ?? f.balance ?? 0) || 0;
    const frequency = String(f.frequency ?? f.billingFrequency ?? "monthly");
    let nextDueDate = String(
      f.dueDate ?? f.due_date ?? f.nextDueDate ?? f.next_due_date ?? f.renewalDate ?? "",
    ).slice(0, 10);
    // A one-time bill has no next occurrence once its only one is paid or
    // skipped; the pay path advances a recurring bill's due date but a
    // "once" bill kept its date and stayed in "upcoming" after being paid.
    if (/^(once|one[-_ ]?time|single)$/i.test(frequency) && nextDueDate && isSettledOccurrence(f, nextDueDate)) {
      nextDueDate = "";
    } else if (nextDueDate && isSettledOccurrence(f, nextDueDate)) {
      // A recurring bill whose stored date sits on a paid or skipped
      // occurrence (a manual date edit back onto a settled day) is next due
      // at the following unsettled occurrence — the same step the pay path
      // takes — so the bills list, the attention row and the cron agree
      // instead of offering to pay a day that is already paid.
      nextDueDate = advanceLiabilityDueDate(f, nextDueDate);
    }
    // A rescheduled occurrence is due on the day it was moved to (D221).
    if (nextDueDate) nextDueDate = effectiveDueDate(f, nextDueDate);
    // A finite series with no occurrence left is ended: no next due date, and
    // a status the bills list, the totals and the due-scan all recognise
    // (D252). The calendar already drew nothing for it.
    const seriesEnded = !!nextDueDate && isEndedBillFields(f, nextDueDate);
    if (seriesEnded) nextDueDate = "";
    // `amount` is what the NEXT BILLING PERIOD actually costs, not the
    // definition's figure. For a fixed bill those are identical; for a
    // usage-based one the definition says $20 while August says $62, and every
    // downstream consumer (upcoming bills, cash flow, the dashboard total)
    // reads this single field. Resolving it here is what keeps them all in
    // agreement instead of each surface picking a different number.
    const billingModel = resolveBillingModel(p as any);
    const money = resolveOccurrenceAmount(
      baseAmount,
      (f.occurrences && typeof f.occurrences === "object") ? f.occurrences[nextDueDate] : null,
      billingModel,
    );
    const amount = money.current;
    const tk = String((p as any).type_key ?? (p as any).typeKey ?? "").toLowerCase();
    const kind = tk === "subscription" ? "subscription" : "bill";
    const parent = (p as any).parentProfileId;
    return {
      id: p.id, name: p.name, amount, frequency,
      billingModel, baseAmount, amountIsEstimate: money.isEstimate,
      category: String(f.category ?? "general"),
      nextDueDate: nextDueDate || "",
      autopay: f.autopay === true || f.autoPay === true,
      // The obligation surface speaks active | paused | cancelled; the
      // liability fields also carry lifecycle words ("upcoming", "overdue",
      // written by the pay path). Echoing those back made an edit form that
      // round-trips the record fail validation with a 400.
      status: seriesEnded ? "ended" : canonicalObligationStatus(f.status),
      recurrenceEnd: typeof f.recurrenceEnd === "string" && f.recurrenceEnd ? String(f.recurrenceEnd).slice(0, 10) : undefined,
      kind: kind as any,
      leadTimeDays: 3,
      autoLogExpense: false,
      linkedLiabilityId: p.id,
      // The bill's owner chain is its parent PLUS every party on it (a
      // co-signer, a responsible party): a bill Linda co-signs is Linda's on
      // her bills list, snapshot, timeline and bell, the way her co-owned
      // car's is. With the parent alone, every scoped read dropped it.
      linkedProfiles: Array.from(new Set([...(parent ? [parent] : []), ...partyIds.filter((id) => typeof id === "string" && id && id !== p.id)])),
      payments,
      notes: f.notes || undefined,
      createdAt: (p as any).createdAt,
      updatedAt: (p as any).updatedAt,
    } as Obligation;
  }

  private paymentRowToObligationPayment(r: any): ObligationPayment {
    return {
      id: r.id, amount: Number(r.amount) || 0, date: r.payment_date,
      method: r.source_account || undefined,
    };
  }

  async getObligations(profileIds?: string[]): Promise<Obligation[]> {
    return this.memo(`getObligations${this._fk(profileIds)}`, async () => {
      const profiles = await this.getProfiles();
      let bills = profiles.filter((p: any) => isRecurringBillProfile(p));
      if (profileIds && profileIds.length > 0) {
        // The raw selection only matched a bill or its immediate parent, so a
        // co-owned car's insurance (D120) or a bill two levels down (bill →
        // car → Mike) vanished from the scoped dashboard snapshot and stats
        // while /api/obligations (which filters after mapping) listed it.
        // pushdownIds is the same widening every other scoped read uses.
        const set = new Set((await this.pushdownIds(profileIds)) || profileIds);
        bills = bills.filter((p: any) => set.has(p.id) || (p.parentProfileId && set.has(p.parentProfileId)));
      }
      if (bills.length === 0) return [];
      const ids = bills.map(p => p.id);
      const { data: payRows } = await this.supabase
        .from("liability_payments").select("*")
        .eq("user_id", this.userId).in("liability_profile_id", ids)
        .order("payment_date", { ascending: true });
      const byLiab = new Map<string, ObligationPayment[]>();
      for (const r of payRows || []) {
        const arr = byLiab.get(r.liability_profile_id) || [];
        arr.push(this.paymentRowToObligationPayment(r));
        byLiab.set(r.liability_profile_id, arr);
      }
      const partiesByLiab = new Map<string, string[]>();
      for (const l of await this.getLiabilityProfileLinks().catch(() => [] as LiabilityProfileLink[])) {
        if (!l?.liabilityProfileId || !l?.partyProfileId) continue;
        partiesByLiab.set(l.liabilityProfileId, [...(partiesByLiab.get(l.liabilityProfileId) || []), l.partyProfileId]);
      }
      return bills.map(p => this.liabilityToObligation(p, byLiab.get(p.id) || [], partiesByLiab.get(p.id) || []));
    });
  }

  async getObligation(id: string): Promise<Obligation | undefined> {
    const p = await this.getProfile(id);
    if (!p || !isRecurringBillProfile(p)) return undefined;
    const { data: payRows } = await this.supabase
      .from("liability_payments").select("*")
      .eq("user_id", this.userId).eq("liability_profile_id", id)
      .order("payment_date", { ascending: true });
    const parties = (await this.getLiabilityProfileLinks(id).catch(() => [] as LiabilityProfileLink[])).map((l) => l.partyProfileId).filter(Boolean) as string[];
    return this.liabilityToObligation(p, (payRows || []).map(r => this.paymentRowToObligationPayment(r)), parties);
  }

  /** Normalize a liability/bill name for identity: drop a trailing "payment"
   *  suffix, collapse whitespace, lowercase. "Water Bill payment" ≡ "Water Bill". */
  private normLiabilityName(n: string): string {
    return String(n || "").toLowerCase().replace(/\s+(bill\s+)?payments?$/i, "").replace(/\s+/g, " ").trim();
  }

  /** Find an existing liability profile that IS this one (same normalized name,
   *  same owner) so create becomes an idempotent upsert — one liability = one
   *  profile, no matter how many times / ways it's created. */
  private async resolveExistingLiability(
    name: string,
    ownerId: string | undefined,
    all?: Profile[],
    opts: { billShellsOnly?: boolean } = {},
  ): Promise<Profile | undefined> {
    const target = this.normLiabilityName(name);
    if (!target) return undefined;
    const profiles = all || await this.getProfiles();
    const isLiab = (p: any) => (p.type === "liability" || p.type === "loan")
      && (!opts.billShellsOnly || isRecurringBillShell(p));
    // Same owner first; then a self/orphan-owned shell of the same name.
    const selfId = profiles.find(p => p.type === "self")?.id;
    return profiles.find((p: any) => isLiab(p) && this.normLiabilityName(p.name) === target && p.parentProfileId === ownerId)
      || profiles.find((p: any) => isLiab(p) && this.normLiabilityName(p.name) === target && (p.parentProfileId == null || p.parentProfileId === selfId));
  }

  async createObligation(data: InsertObligation): Promise<Obligation> {
    const kind = (data as any).kind || "bill";
    // Folded here so every door (import, chat, API) stores the canon's spelling.
    const category = canonicalObligationCategory((data as any).category);
    // A cadence typed as an alias ("fortnightly", "annual") folds to the
    // obligation vocabulary when it names one of its six cadences; the route
    // enum refuses it for the form, but chat and imports write here directly.
    const foldedFrequency = (() => { const f = canonicalIncomeFrequency((data as any).frequency); return f && (["weekly", "biweekly", "monthly", "quarterly", "yearly", "once"] as string[]).includes(f) ? f : (data as any).frequency; })();
    const rawName = String(data.name || "").trim();
    const typeKey = this.billTypeKey(kind, category, rawName);
    let parent: string | undefined = ((data as any).linkedProfiles || [])[0];
    if (!parent) {
      const self = await this.getSelfProfile();
      parent = self?.id;
    }
    const amount = Number(data.amount) || 0;
    const freq = foldedFrequency || "monthly";
    const nextDue = String((data as any).nextDueDate || getUserToday(this._timezone)).slice(0, 10);
    const billFields: Record<string, any> = {
      monthlyAmount: amount, amount,
      frequency: freq, billingFrequency: freq,
      // Fixed series origin so the generated schedule stays anchored even as
      // dueDate advances with each payment (see shared/liability-schedule.ts).
      firstPaymentDate: nextDue,
      dueDate: nextDue, nextDueDate: nextDue,
      autopay: (data as any).autopay || false,
      category,
      status: "upcoming",
      source: "obligation",
      // The billing model decides whether `amount` is THE amount or merely a
      // starting point. A usage-based bill's $20 is a base price; each month's
      // real total is assembled from that month's charges. Stored on the
      // definition, read per-occurrence (shared/liability-billing.ts).
      ...(normalizeBillingModel((data as any).billingModel)
        ? { billingModel: normalizeBillingModel((data as any).billingModel) }
        : {}),
      // Finite terms — only when explicitly provided (never invented).
      ...((data as any).count != null ? { count: Math.max(1, parseInt(String((data as any).count), 10) || 0) } : {}),
      ...((data as any).reminderLeadDays != null ? { reminderLeadDays: Math.max(0, parseInt(String((data as any).reminderLeadDays), 10) || 0) } : {}),
      ...((data as any).recurrenceEnd ? { recurrenceEnd: String((data as any).recurrenceEnd).slice(0, 10) } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
    };

    // IDEMPOTENT UPSERT — one liability = one profile. If a RECURRING BILL (or
    // a bare liability shell with no type_key yet — a create_liability shell,
    // a prior create, a re-run) with this normalized name already exists for
    // the owner, UPDATE it into this recurring bill and return it instead of
    // inserting a duplicate.
    //
    // Only bill shells qualify. The match used to accept ANY liability of the
    // same name, so "Car Loan payment" (normalized: "car loan") UPDATED the
    // amortizing "Car Loan" into a recurring bill — type_key overwritten, the
    // loan dropped out of net worth, its amortization replaced by a monthly
    // shell. A loan, credit card or one-time debt of the same name is a
    // different thing: it keeps its identity, and the bill is created as a
    // separate profile that records which liability it pays
    // (fields.linkedLiabilityId), so the two stay related without merging.
    const profiles = await this.getProfiles();
    const existing = await this.resolveExistingLiability(rawName, parent, profiles, { billShellsOnly: true });
    const paysFor = existing ? undefined : await this.resolveExistingLiability(rawName, parent, profiles);
    if (paysFor) billFields.linkedLiabilityId = paysFor.id;
    if (existing) {
      await this.updateProfile(existing.id, {
        name: rawName,
        type: "liability",
        type_key: typeKey,
        fields: { ...(existing.fields || {}), ...billFields },
      } as any);
      // The upsert path skips createProfile, so ensure the owner link exists
      // (an existing shell may never have gotten one).
      await this.ensureAutoOwnerLink(existing.id, "liability", (existing as any).parentProfileId ?? parent ?? null);
      this.logActivity("obligation", `Updated bill: ${rawName}`);
      return (await this.getObligation(existing.id))!;
    }

    const created = await this.createProfile({
      name: rawName,
      type: "liability",
      type_key: typeKey,
      ...(parent ? { parentProfileId: parent } : {}),
      fields: billFields,
      tags: [],
    } as any);
    this.logActivity("obligation", `Created bill: ${rawName}`);
    return (await this.getObligation(created.id))!;
  }

  async updateObligation(id: string, data: Partial<Obligation>): Promise<Obligation | undefined> {
    const existing = await this.getProfile(id);
    if (!existing || !isRecurringBillProfile(existing)) return undefined;
    // The version the caller read rides through to the profile write, which
    // is where the conflict check lives; it used to be dropped here, so a bill
    // edit from a stale tab never got its 409.
    const expectedUpdatedAt = (data as any).expectedUpdatedAt;
    const fieldsPatch: any = {};
    if (data.amount !== undefined) { fieldsPatch.monthlyAmount = data.amount; fieldsPatch.amount = data.amount; }
    if (data.frequency !== undefined) { const f0 = canonicalIncomeFrequency(data.frequency); const f = f0 && (["weekly", "biweekly", "monthly", "quarterly", "yearly", "once"] as string[]).includes(f0) ? f0 : data.frequency; fieldsPatch.frequency = f; fieldsPatch.billingFrequency = f; }
    if (data.nextDueDate !== undefined) {
      fieldsPatch.dueDate = data.nextDueDate; fieldsPatch.nextDueDate = data.nextDueDate;
      // An explicit due-date edit re-anchors the series. The schedule anchors on
      // firstPaymentDate (so the day-of-month survives each payment's advance),
      // and leaving it untouched kept the calendar on the OLD dates while the
      // bill, the popup and the date rules all showed the new one.
      fieldsPatch.firstPaymentDate = data.nextDueDate;
    }
    if (data.autopay !== undefined) fieldsPatch.autopay = data.autopay;
    if ((data as any).category !== undefined) fieldsPatch.category = canonicalObligationCategory((data as any).category);
    if (data.status !== undefined) fieldsPatch.status = data.status;
    if (data.notes !== undefined) fieldsPatch.notes = data.notes;
    // Ownership reassignment: an obligation is a liability profile whose
    // canonical owner is both its parentProfileId and its OWNER-role junction
    // row. Keep those representations synchronized. Moving only the parent left
    // the auto-created Self owner row in liability_profile_links, and
    // liabilityToObligation unioned that stale row back into linkedProfiles.
    // setLiabilityOwners deliberately preserves non-owner relationships such as
    // co_signer and guarantor.
    const linked = (data as any).linkedProfiles;
    const hasLinked = Array.isArray(linked);
    const ownerId = hasLinked && linked[0] ? String(linked[0]) : null;
    const previousParentProfileId = (existing as any).parentProfileId ?? null;
    let previousOwners: Array<{ partyProfileId: string; ownershipPercentage: number }> = [];
    if (hasLinked) {
      this.clearRequestMemo();
      previousOwners = (await this.getLiabilityProfileLinks(id))
        .filter((row) => {
          const role = (row.role || "owner").toLowerCase();
          return role === "owner" || role === "co_owner" || role === "co-owner";
        })
        .map((row) => ({
          partyProfileId: row.partyProfileId,
          ownershipPercentage: Number(row.ownershipPercentage),
        }));
    }
    await this.updateProfile(id, {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(Object.keys(fieldsPatch).length > 0 ? { fields: fieldsPatch } : {}),
      ...(hasLinked ? { parentProfileId: ownerId } : {}),
      ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}),
    } as any);
    if (hasLinked) {
      // updateProfile/getProfile and the ownership helpers can participate in a
      // request memo during AI and bootstrap work. Never reconcile against, or
      // return, the pre-write owner list.
      this.clearRequestMemo();
      try {
        await this.setLiabilityOwners(
          id,
          ownerId ? [{ partyProfileId: ownerId, ownershipPercentage: 100 }] : [],
        );
      } catch (ownerWriteError) {
        // The profile parent was already changed. Reconcile BOTH canonical
        // representations back to their pre-request snapshots before exposing
        // the owner-write failure to the route.
        let ownerRollbackError: unknown;
        let parentRollbackError: unknown;
        try {
          await this.setLiabilityOwners(id, previousOwners);
        } catch (error) {
          ownerRollbackError = error;
        }
        try {
          await this.updateProfile(id, { parentProfileId: previousParentProfileId } as any);
        } catch (error) {
          parentRollbackError = error;
        }
        this.clearRequestMemo();
        if (ownerRollbackError || parentRollbackError) {
          const compensationError = new Error(
            `Obligation owner update failed and compensation was incomplete` +
            `${ownerRollbackError ? `; owner rollback: ${ownerRollbackError instanceof Error ? ownerRollbackError.message : String(ownerRollbackError)}` : ""}` +
            `${parentRollbackError ? `; parent rollback: ${parentRollbackError instanceof Error ? parentRollbackError.message : String(parentRollbackError)}` : ""}`,
          );
          (compensationError as any).cause = ownerWriteError;
          (compensationError as any).ownerRollbackError = ownerRollbackError;
          (compensationError as any).parentRollbackError = parentRollbackError;
          throw compensationError;
        }
        throw ownerWriteError;
      }
      this.clearRequestMemo();
    }
    return this.getObligation(id);
  }

  // NOTE: payObligation lived here until the pay paths were unified. It dated
  // every payment "today", advanced the due date unconditionally anchored on
  // today, and never stamped the occurrence — one of six divergent
  // implementations of "this bill got paid". All entry points now call
  // payBillOccurrence (server/liability-payments.ts).

  async deleteObligation(id: string): Promise<boolean> {
    const p = await this.getProfile(id);
    if (!p) return false;
    return this.deleteProfile(id);
  }

  // ============================================================
  // RECURRING LIABILITY SCHEDULE — per-occurrence + series operations.
  // Occurrences are generated on the fly (shared/liability-schedule.ts); the
  // only stored state is the fields.occurrences override map + pause flags +
  // the liability_payments history. No occurrence table, no migration.
  // ============================================================

  private async _liabilityPayments(id: string): Promise<Array<{ id?: string; paymentDate?: string }>> {
    const { data } = await this.supabase
      .from("liability_payments").select("id,payment_date")
      .eq("user_id", this.userId).eq("liability_profile_id", id)
      .order("payment_date", { ascending: true });
    return (data || []).map((r: any) => ({ id: r.id, paymentDate: r.payment_date }));
  }

  /** Rich payment schedule for ANY liability (recurring bill, loan, credit card,
   *  one-time debt): occurrences window + history + settings. Non-recurring
   *  families derive a monthly payment series from their terms. */
  async getLiabilitySchedule(id: string, months = 12): Promise<any | null> {
    const p = await this.getProfile(id);
    const typeKey = (p as any)?.type_key ?? (p as any)?.typeKey ?? null;
    if (!p || (p.type !== "liability" && p.type !== "loan")) return null;
    const todayISO = getUserToday(this._timezone);
    // Normalize every family into schedule-ready fields (bills pass through).
    const f: any = deriveScheduleFields(p.fields || {}, typeKey, todayISO);
    const isBill = isRecurringBillProfile(p);
    const payments = await this._liabilityPayments(id);
    const fromISO = new Date(new Date(todayISO + "T00:00:00").setMonth(new Date(todayISO + "T00:00:00").getMonth() - 2)).toLocaleDateString("en-CA");
    const toISO = new Date(new Date(todayISO + "T00:00:00").setMonth(new Date(todayISO + "T00:00:00").getMonth() + months)).toLocaleDateString("en-CA");
    // The billing model is read from the ORIGINAL profile: deriveScheduleFields
    // drops `type_key`, so resolving it off the normalized fields would fall
    // back to the wrong family for loans and cards.
    const billingModel = resolveBillingModel(p as any);
    const occurrences = generateSchedule({ id: p.id, fields: f }, payments, { todayISO, windowStart: fromISO, windowEnd: toISO, billingModel });
    const next = nextDueOccurrence({ id: p.id, fields: f }, payments, todayISO, billingModel);
    const paidPayRows = await this.supabase
      .from("liability_payments").select("*")
      .eq("user_id", this.userId).eq("liability_profile_id", id)
      .order("payment_date", { ascending: false });
    const history = (paidPayRows.data || []).map((r: any) => this.paymentRowToObligationPayment(r));
    const amount = liabilityAmount({ id: p.id, fields: f });
    const counts = scheduleCounts({ id: p.id, fields: f }, payments, todayISO);
    return {
      id: p.id,
      name: p.name,
      typeKey,
      family: liabilityFamily(typeKey),
      billingModel,
      billingModelMeta: billingModelMeta(billingModel),
      isRecurring: isBill,
      amount,
      frequency: liabilityFrequency({ id: p.id, fields: f }),
      firstPayment: String(f.firstPaymentDate ?? f.dueDate ?? f.nextDueDate ?? "").slice(0, 10) || null,
      nextDue: next ? {
        date: next.date, effectiveDate: next.effectiveDate, amount: next.amount,
        estimatedAmount: next.estimatedAmount, actualAmount: next.actualAmount,
        isEstimate: next.isEstimate, amountLabel: next.amountLabel,
        chargeTotal: next.chargeTotal, charges: next.charges,
      } : null,
      lastPaid: history[0]?.date ?? f.lastPaidDate ?? null,
      autopay: f.autopay === true || f.autoPay === true,
      paused: f.paused === true,
      pausedUntil: f.pausedUntil ?? null,
      gracePeriodDays: f.gracePeriodDays ?? null,
      lateFee: f.lateFee ?? null,
      reminderLeadDays: f.reminderLeadDays ?? null,
      // Finite term (null when open-ended): total, paid so far, and remaining.
      totalPayments: counts.totalPayments,
      paidCount: counts.paidCount,
      remainingPayments: counts.remainingPayments,
      recurrenceEnd: f.recurrenceEnd ?? null,
      annualTotal: Math.round(amount * periodsPerYear({ id: p.id, fields: f }) * 100) / 100,
      calendarSynced: true,
      occurrences,
      payments: history,
    };
  }

  /** Merge a per-occurrence override into fields.occurrences (shallow-replaced).
   *  A key set to null in `patch` is REMOVED — this is how unpayBillOccurrence
   *  clears a paid stamp without touching the rest of the period's history. */
  /**
   * Change ONE billing period's override. `patch` is merged over the stored
   * override, or — as a function — computed from the FRESH override, so a
   * charge appended by two requests at once keeps both charges.
   *
   * Written with the same optimistic-concurrency loop the pay claim uses
   * (read `fields, updated_at`, write only if nobody else wrote the row since,
   * retry): two skips on different occurrences used to race through a plain
   * read-merge-write of the whole `fields` map and one skip was lost.
   */
  async updateOccurrenceOverride(
    id: string,
    date: string,
    patch: Record<string, any> | ((current: Record<string, any>) => Record<string, any>),
  ): Promise<any> {
    const p = await this.getProfile(id);
    if (!p || (p.type !== "liability" && p.type !== "loan")) return null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const { data: fresh, error: readErr } = await this.supabase.from("profiles").select("fields, updated_at")
        .eq("id", id).eq("user_id", this.userId).maybeSingle();
      if (readErr) throw readErr;
      if (!fresh) return null;
      const f: any = (fresh.fields && typeof fresh.fields === "object") ? fresh.fields : {};
      const occ: Record<string, any> = (f.occurrences && typeof f.occurrences === "object") ? { ...f.occurrences } : {};
      const existing = occ[date] || {};
      const delta = typeof patch === "function" ? patch(existing) : patch;
      const merged: Record<string, any> = { ...existing, ...delta };
      // Drop keys explicitly nulled so an override can be cleared.
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      occ[date] = merged;
      const nextFields = mergeFieldWrite(f, { occurrences: occ }).fields;
      const now = new Date().toISOString();
      let q = this.supabase.from("profiles").update({ fields: nextFields, updated_at: now }).eq("id", id).eq("user_id", this.userId);
      q = fresh.updated_at == null ? q.is("updated_at", null) : q.eq("updated_at", fresh.updated_at);
      const { data, error } = await q.select("id");
      if (error) throw error;
      if (Array.isArray(data) && data.length > 0) {
        this.clearRequestMemo();
        bustInsightsCacheFor(this.userId);
        return this.getLiabilitySchedule(id);
      }
      await new Promise((r) => setTimeout(r, 10 + attempt * 20));
    }
    throw new Error(`Occurrence write for ${id} on ${date} kept colliding with another writer; try again`);
  }

  /** The stored override for ONE billing period, or null. */
  private _occurrenceOverride(p: any, date: string): any {
    const occ = p?.fields?.occurrences;
    return (occ && typeof occ === "object" ? occ[String(date).slice(0, 10)] : null) || null;
  }

  /**
   * File a usage / credits / fee charge against ONE billing period.
   *
   * This is the operation that makes a usage-based liability work: the charge
   * lands on that period's occurrence and nowhere else, so August's total moves
   * and July's and September's do not.
   */
  async addOccurrenceCharge(
    id: string,
    date: string,
    charge: { amount: number; kind?: string; label?: string; date?: string; notes?: string; source?: any },
  ): Promise<any> {
    const p = await this.getProfile(id);
    if (!p || (p.type !== "liability" && p.type !== "loan")) return null;
    const occDate = String(date).slice(0, 10);
    const result = await this.updateOccurrenceOverride(id, occDate, (current) => ({ charges: addCharge(current, charge as any).charges }));
    this.logActivity("obligation", `Added ${charge.kind || "charge"} of $${charge.amount} to ${p.name} ${occDate}`);
    return result;
  }

  async removeOccurrenceCharge(id: string, date: string, chargeId: string): Promise<any> {
    const p = await this.getProfile(id);
    if (!p || (p.type !== "liability" && p.type !== "loan")) return null;
    const occDate = String(date).slice(0, 10);
    return this.updateOccurrenceOverride(id, occDate, (current) => ({ charges: removeCharge(current, chargeId).charges }));
  }

  /** What we EXPECT this period to cost. Never touches other periods. */
  async setOccurrenceEstimate(id: string, date: string, amount: number | null): Promise<any> {
    const p = await this.getProfile(id);
    if (!p || (p.type !== "liability" && p.type !== "loan")) return null;
    const occDate = String(date).slice(0, 10);
    const next = setEstimate(this._occurrenceOverride(p, occDate), amount);
    return this.updateOccurrenceOverride(id, occDate, {
      estimatedAmount: next.estimatedAmount ?? null,
    });
  }

  /**
   * What ACTUALLY posted. Freezes the period as history — later definition
   * edits and stray charges can no longer move it.
   */
  async setOccurrenceActual(id: string, date: string, amount: number | null): Promise<any> {
    const p = await this.getProfile(id);
    if (!p || (p.type !== "liability" && p.type !== "loan")) return null;
    const occDate = String(date).slice(0, 10);
    const next = setActual(this._occurrenceOverride(p, occDate), amount);
    const result = await this.updateOccurrenceOverride(id, occDate, {
      actualAmount: next.actualAmount ?? null,
      postedAt: next.postedAt ?? null,
    });
    if (amount != null) this.logActivity("obligation", `${p.name} ${occDate} posted at $${amount}`);
    return result;
  }

  // NOTE: payOccurrence lived here until the pay paths were unified. Its
  // side-effect set (occurrence stamp + conditional advance + account debit,
  // but no debt-balance move and no expense) now lives in payBillOccurrence
  // (server/liability-payments.ts), which every entry point calls.

  async skipOccurrence(id: string, date: string): Promise<any> {
    // The caller may address the MOVED day (what the calendar shows); the
    // occurrence lives under its anchor key (D221).
    const target = await this.getProfile(id);
    const occDate = resolveOccurrenceKey(target?.fields, String(date).slice(0, 10));
    const result = await this.updateOccurrenceOverride(id, occDate, { status: "skipped", paymentId: null });
    // If skipping the current due date, advance so the next occurrence becomes due.
    const p = await this.getProfile(id);
    const f: any = p?.fields || {};
    if (String(f.dueDate ?? f.nextDueDate ?? "").slice(0, 10) === occDate) {
      await this.updateProfile(id, { fields: advanceLiabilityDueDatePatch(f, occDate) } as any);
      return this.getLiabilitySchedule(id);
    }
    return result;
  }

  async rescheduleOccurrence(id: string, date: string, newDate: string): Promise<any> {
    return this.updateOccurrenceOverride(id, String(date).slice(0, 10), { movedTo: String(newDate).slice(0, 10) });
  }

  async setOccurrenceFields(id: string, date: string, patch: { amount?: number; notes?: string }): Promise<any> {
    const clean: Record<string, any> = {};
    if (patch.amount != null) clean.amount = Number(patch.amount);
    if (patch.notes !== undefined) clean.notes = patch.notes || null;
    return this.updateOccurrenceOverride(id, String(date).slice(0, 10), clean);
  }

  async pauseLiability(id: string, until?: string): Promise<any> {
    const p = await this.getProfile(id);
    if (!p || !isRecurringBillProfile(p)) return null;
    await this.updateProfile(id, { fields: { paused: true, pausedUntil: until ? String(until).slice(0, 10) : null, status: "paused" } } as any);
    this.logActivity("obligation", `Paused ${p.name}${until ? ` until ${until}` : ""}`);
    return this.getLiabilitySchedule(id);
  }

  async resumeLiability(id: string): Promise<any> {
    const p = await this.getProfile(id);
    if (!p || !isRecurringBillProfile(p)) return null;
    await this.updateProfile(id, { fields: { paused: false, pausedUntil: null, status: "upcoming" } } as any);
    this.logActivity("obligation", `Resumed ${p.name}`);
    return this.getLiabilitySchedule(id);
  }

  // ============================================================
  // FINANCIAL ACCOUNTS — manually-tracked checking / savings / cash /
  // credit / investment / loan accounts.
  //
  // An account is a `type: "account"` PROFILE, so it inherits net worth,
  // profile filtering, ownership links, nesting, linked expenses/incomes and
  // document attachment from machinery that already exists. These methods add
  // only what is account-specific: the canonical field layout and the balance
  // adjustment ledger. Everything else goes through createProfile /
  // updateProfile / deleteProfile like any other profile.
  // ============================================================

  /** Every account profile, as the display-ready view shape. */
  async getAccounts(): Promise<any[]> {
    let profiles = await this.getProfiles();
    // Self-heal rows written before balanceFieldsFor existed: a fresh
    // `balance` beside a stale `currentValue` renders as two different numbers
    // for one account (Finance says $53,000, Assets says $50,000). The repair
    // only copies the authoritative balance into the keys the resolvers read,
    // and only for rows that actually disagree — a no-op on healthy data.
    const repairs: Array<{ id: string; patch: Record<string, any> }> = [];
    for (const p of profiles) {
      const patch = reconcileAccountBalanceFields(p);
      if (patch) repairs.push({ id: p.id, patch });
    }
    if (repairs.length > 0) {
      for (const r of repairs) {
        await this.updateProfile(r.id, { fields: r.patch } as any).catch(() => null);
      }
      profiles = await this.getProfiles();
    }
    return accountViews(profiles);
  }

  /**
   * Create a manual account. `balance` is written to BOTH `balance` and
   * `currentBalance` because an account can sit on either side of the balance
   * sheet and the two resolvers read different keys.
   */
  async createAccount(input: {
    name: string;
    accountKind?: string;
    institution?: string;
    balance?: number;
    availableBalance?: number;
    creditLimit?: number;
    accountNumberLast4?: string;
    balanceAsOf?: string;
    currency?: string;
    notes?: string;
    ownerProfileId?: string;
  }): Promise<any> {
    const kind = normalizeAccountKind(input.accountKind);
    const meta = accountKindMeta(kind);
    const today = getUserToday(this._timezone);
    const balance = Math.abs(Number(input.balance ?? 0)) || 0;
    const fields: Record<string, any> = {
      accountKind: kind,
      // Every key the canonical resolvers read, not just `balance` — otherwise
      // a new account lists its balance in Finance while the Assets card and
      // Net Worth read a different (or absent) number. See balanceFieldsFor.
      ...balanceFieldsFor({ type: "account", fields: { accountKind: kind } }, balance),
      balanceAsOf: /^\d{4}-\d{2}-\d{2}$/.test(String(input.balanceAsOf ?? "")) ? String(input.balanceAsOf).slice(0, 10) : today,
      currency: (input.currency || "usd").toLowerCase(),
      balanceHistory: [],
    };
    if (input.institution) fields.institution = String(input.institution);
    if (input.accountNumberLast4) fields.accountNumberLast4 = String(input.accountNumberLast4).slice(-4);
    // Only store the fields the kind actually supports, so a checking account
    // never renders an empty "credit limit" row.
    if (meta.supportsAvailable && input.availableBalance != null) {
      fields.availableBalance = Math.abs(Number(input.availableBalance)) || 0;
    }
    if (meta.supportsCreditLimit && input.creditLimit != null) {
      fields.creditLimit = Math.abs(Number(input.creditLimit)) || 0;
    }

    const created = await this.createProfile({
      type: "account" as any,
      type_key: kind,
      name: String(input.name || "Account").trim(),
      fields,
      notes: input.notes || "",
      ...(input.ownerProfileId ? { parentProfileId: input.ownerProfileId } : {}),
    } as any);
    this.logActivity("profile", `Added ${meta.label.toLowerCase()} account ${created.name}`);
    return created;
  }

  async updateAccount(id: string, changes: Record<string, any>): Promise<any | undefined> {
    const p = await this.getProfile(id);
    if (!p || !isAccountProfile(p)) return undefined;
    const patch: any = { fields: {} };
    if (changes.name) patch.name = String(changes.name);
    if (changes.notes !== undefined) patch.notes = String(changes.notes ?? "");
    if (changes.ownerProfileId !== undefined) patch.parentProfileId = changes.ownerProfileId || null;
    const f = patch.fields;
    if (changes.accountKind !== undefined) {
      const kind = normalizeAccountKind(changes.accountKind);
      f.accountKind = kind;
      patch.type_key = kind;
    }
    for (const key of ["institution", "accountNumberLast4", "currency", "status"]) {
      if (changes[key] !== undefined) f[key] = changes[key] == null ? null : String(changes[key]);
    }
    for (const key of ["availableBalance", "creditLimit"]) {
      if (changes[key] !== undefined) f[key] = changes[key] == null ? null : Math.abs(Number(changes[key])) || 0;
    }
    if (changes.includeInNetWorth !== undefined) f.includeInNetWorth = changes.includeInNetWorth !== false;
    // A balance change is an ADJUSTMENT, never a silent overwrite — it goes
    // through the ledger so the history survives.
    if (changes.balance !== undefined && changes.balance !== null) {
      await this.adjustAccountBalance(id, {
        newBalance: Number(changes.balance),
        date: changes.balanceAsOf,
        reason: changes.reason || "Manual update",
        source: "user",
      });
    } else if (changes.balanceAsOf) {
      f.balanceAsOf = String(changes.balanceAsOf).slice(0, 10);
    }
    if (Object.keys(f).length === 0) delete patch.fields;
    if (Object.keys(patch).length === 0) return this.getProfile(id);
    return this.updateProfile(id, patch as any);
  }

  /**
   * Move an account's balance and record why.
   *
   * `newBalance` sets it outright ("my checking is $2,410 now"); `delta` moves
   * it ("I spent $40"). Either way the before/after pair is appended to
   * `fields.balanceHistory`, so a balance that changed can always be explained.
   */
  async adjustAccountBalance(id: string, input: {
    newBalance?: number | null;
    delta?: number | null;
    date?: string | null;
    reason?: string | null;
    source?: any;
    linkedRecordId?: string | null;
  }): Promise<any | undefined> {
    const p = await this.getProfile(id);
    if (!p || !isAccountProfile(p)) return undefined;
    const today = getUserToday(this._timezone);
    // The delta is applied to the balance as it is when the write lands, not
    // as it was when this call read it: two adjustments in flight together
    // (a bill paid from the account beside a manual correction) used to move
    // the balance once and keep one history entry.
    let adjustment: ReturnType<typeof applyBalanceAdjustment>["adjustment"] | null = null;
    const updated = await this.mutateProfileFields(id, (fresh) => {
      const out = applyBalanceAdjustment(fresh, input, today);
      adjustment = out.adjustment;
      return { fields: out.fields } as any;
    });
    if (!updated) return undefined;
    // A move of nothing is a successful no-op: the account as it is, no
    // history row, no activity line (D283).
    if (!adjustment) return updated;
    const adj = adjustment as NonNullable<ReturnType<typeof applyBalanceAdjustment>["adjustment"]>;
    this.logActivity(
      "profile",
      `${p.name} balance ${adj.delta >= 0 ? "+" : "-"}$${Math.abs(adj.delta)} → $${adj.newBalance}`,
    );
    return updated;
  }

  // ============================================================
  // ARTIFACTS
  // ============================================================
  async getArtifacts(profileIds?: string[]): Promise<Artifact[]> {
    return this.memo(`getArtifacts${this._fk(profileIds)}`, async () => {
      // PERF (durable-fix-phase1): DB pushdown via idx_artifacts_linked_profiles_gin.
      let q = this.supabase.from("artifacts").select("*").eq("user_id", this.userId).is("deleted_at", null);
      q = this._applyProfileFilter(q, await this.pushdownIds(profileIds));
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map(r => this.rowToArtifact(r));
    });
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    const { data, error } = await this.supabase.from("artifacts").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error || !data) return undefined;
    return this.rowToArtifact(data);
  }

  // Public share lookup — does NOT filter by user_id. Used by /api/public-artifacts/:slug.
  // Service-role key bypasses RLS so we can find any user's artifact by its share token.
  // Caller must treat the result as PUBLIC and strip private fields before serving.
  async getArtifactByShareToken(token: string): Promise<Artifact | undefined> {
    if (!token) return undefined;
    const { data, error } = await this.supabase
      .from("artifacts")
      .select("*")
      .filter("metadata->>shareToken", "eq", token)
      .limit(1);
    if (error || !data || data.length === 0) return undefined;
    return this.rowToArtifact(data[0]);
  }

  async createArtifact(data: InsertArtifact): Promise<Artifact> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const items: ChecklistItem[] = (data.items || []).map((item, i) => ({ id: randomUUID(), text: item.text, checked: item.checked ?? false, order: i }));
    // Auto-link to self profile if no profiles specified
    let linkedProfiles = (data as any).linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    // Build metadata for non-column artifact fields (language, dataBindings,
    // chartData, sheetData, source). All live inside the metadata JSONB column
    // so adding new fields stays migration-free.
    const metadata: Record<string, any> = {};
    if ((data as any).language) metadata.language = (data as any).language;
    if ((data as any).dataBindings) metadata.dataBindings = (data as any).dataBindings;
    if ((data as any).chartData) metadata.chartData = (data as any).chartData;
    if ((data as any).chartType) metadata.chartType = (data as any).chartType;
    if ((data as any).sheetData) metadata.sheetData = (data as any).sheetData;
    if ((data as any).source) metadata.source = (data as any).source;
    if ((data as any).shareToken) metadata.shareToken = (data as any).shareToken;
    const { error } = await this.supabase.from("artifacts").insert({
      id, user_id: this.userId, type: data.type, title: data.title,
      content: data.content || "", items, tags: data.tags || [],
      linked_profiles: linkedProfiles, pinned: data.pinned || false,
      metadata: Object.keys(metadata).length > 0 ? metadata : {},
      created_at: now, updated_at: now,
    });
    if (error) throw error;
    this.logActivity("artifact", `Created ${data.type}: ${data.title}`);
    return (await this.getArtifact(id))!;
  }

  // Generate or revoke a public share token for an artifact.
  // Pass null to revoke. Returns updated artifact (with new shareToken) or undefined if not found.
  async setArtifactShareToken(id: string, token: string | null): Promise<Artifact | undefined> {
    const existing = await this.getArtifact(id);
    if (!existing) return undefined;
    // Read current metadata blob directly to preserve any unknown keys.
    const { data: row } = await this.supabase
      .from("artifacts")
      .select("metadata")
      .eq("id", id)
      .eq("user_id", this.userId)
      .single();
    const currentMeta: Record<string, any> = (row?.metadata as any) || {};
    if (token) currentMeta.shareToken = token;
    else delete currentMeta.shareToken;
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from("artifacts")
      .update({ metadata: currentMeta, updated_at: now })
      .eq("id", id)
      .eq("user_id", this.userId);
    if (error) throw error;
    return this.getArtifact(id);
  }

  async updateArtifact(
    id: string,
    data: Partial<Artifact> & { metadataToDelete?: string[] }
  ): Promise<Artifact | undefined> {
    const existing = await this.getArtifact(id);
    if (!existing) return undefined;
    // [P0.2] optimistic concurrency — 409 if the row moved since the caller
    // read it (the other updaters already honour expectedUpdatedAt; a stale
    // tab's checklist rename used to land silently).
    this.assertNoWriteConflict(data as Record<string, any>, (existing as any).updatedAt);
    const merged = { ...existing, ...data };
    const now = new Date().toISOString();

    // Read the RAW metadata blob from the DB so unknown / future keys survive.
    // The previous implementation rebuilt metadata from scratch using truthiness
    // guards, which (a) made it impossible to clear a key by setting it to ""
    // or null, and (b) permanently lost any metadata key not in its hard-coded
    // whitelist on the first PATCH.
    const { data: rawRow } = await this.supabase.from("artifacts")
      .select("metadata").eq("id", id).eq("user_id", this.userId).maybeSingle();
    const existingMeta: Record<string, any> = (rawRow?.metadata && typeof rawRow.metadata === "object") ? rawRow.metadata : {};

    // Build the incoming metadata delta from the fields that are explicitly
    // present on `data`. "present" means the caller passed the key — use `in`
    // semantics, NOT truthiness, so callers can pass `language: ""` to clear.
    const incomingMeta: Record<string, any> = {};
    const metaKeys = ["language", "dataBindings", "chartData", "chartType", "sheetData", "source", "shareToken"] as const;
    for (const k of metaKeys) {
      if (k in (data as any)) {
        const v = (data as any)[k];
        // "" / null → deletion intent (handled by mergeAndApplyDeletes).
        incomingMeta[k] = v === "" ? null : v;
      }
    }

    const metadata = mergeAndApplyDeletes(existingMeta, incomingMeta, data.metadataToDelete);

    // Only the columns this patch names: a rename in flight with an item
    // toggle used to write the stale items back over the toggle.
    const metaPatched = metaKeys.some((k) => (data as any)[k] !== undefined) || !!data.metadataToDelete?.length;
    const artifactUpdate: Record<string, any> = onlyPatched({
      type: merged.type, title: merged.title, content: merged.content,
      items: merged.items, tags: merged.tags,
      pinned: merged.pinned,
      updated_at: now,
    }, data as Record<string, any>, { type: "type", title: "title", content: "content", items: "items", tags: "tags", pinned: "pinned" });
    if (metaPatched) artifactUpdate.metadata = metadata;
    const { error } = await this.supabase.from("artifacts").update(artifactUpdate).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // [P2.2] Ownership patches go through the single writer (setOwners), not a
    // raw linked_profiles write merged from a possibly-stale read.
    if (data.linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("artifact", id, data.linkedProfiles);
    }
    return this.getArtifact(id);
  }

  async toggleChecklistItem(artifactId: string, itemId: string): Promise<Artifact | undefined> {
    // Flip ONE item against the fresh list, written only if nobody wrote the
    // row since the read (compare-and-swap on updated_at, retried): two
    // toggles in flight together used to read the same list and the later
    // write put the earlier item back.
    for (let attempt = 0; attempt < 6; attempt++) {
      const { data: fresh, error: readErr } = await this.supabase.from("artifacts").select("items, updated_at")
        .eq("id", artifactId).eq("user_id", this.userId).maybeSingle();
      if (readErr) throw readErr;
      if (!fresh) return undefined;
      const items: any[] = Array.isArray(fresh.items) ? fresh.items.map((i: any) => ({ ...i })) : [];
      const item = items.find((i) => i.id === itemId);
      if (!item) return this.getArtifact(artifactId);
      item.checked = !item.checked;
      const now = new Date().toISOString();
      let q = this.supabase.from("artifacts").update({ items, updated_at: now }).eq("id", artifactId).eq("user_id", this.userId);
      q = fresh.updated_at == null ? q.is("updated_at", null) : q.eq("updated_at", fresh.updated_at);
      const { data, error } = await q.select("id");
      if (error) throw error;
      if (Array.isArray(data) && data.length > 0) { this.clearRequestMemo(); return this.getArtifact(artifactId); }
      await new Promise((r) => setTimeout(r, 10 + attempt * 20));
    }
    throw new Error("Checklist toggle kept colliding with another writer; try again");
  }

  async deleteArtifact(id: string): Promise<boolean> {
    const { data, error } = await this.supabase.from("artifacts").delete().eq("id", id).eq("user_id", this.userId).select("id");
    return !error && Array.isArray(data) && data.length > 0;
  }

  // ============================================================
  // JOURNAL
  // ============================================================
  async getJournalEntries(profileIds?: string[]): Promise<JournalEntry[]> {
    return this.memo(`getJournalEntries${this._fk(profileIds)}`, async () => {
      // PERF (durable-fix-phase1): DB pushdown via idx_journal_entries_linked_profiles_gin.
      // journal_entries.linked_profiles is a PG ARRAY (text[]), not jsonb —
      // see _applyProfileFilter doc for syntax.
      let q = this.supabase.from("journal_entries").select("*").eq("user_id", this.userId).is("deleted_at", null);
      q = this._applyProfileFilter(q, await this.pushdownIds(profileIds), "array");
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map(r => this.rowToJournalEntry(r));
    });
  }

  private async getJournalEntry(id: string): Promise<JournalEntry | undefined> {
    const { data, error } = await this.supabase.from("journal_entries").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error || !data) return undefined;
    return this.rowToJournalEntry(data);
  }

  async createJournalEntry(data: InsertJournalEntry): Promise<JournalEntry> {
    const id = randomUUID();
    const now = new Date().toISOString();
    let linkedProfiles = (data as any).linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    const { error } = await this.supabase.from("journal_entries").insert({
      id, user_id: this.userId, date: data.date || getUserToday(this._timezone), mood: data.mood,
      content: data.content || "", tags: data.tags || [], energy: data.energy ?? null,
      gratitude: data.gratitude || null, highlights: data.highlights || null,
      linked_profiles: linkedProfiles,
      created_at: now,
    });
    if (error) throw error;
    this.logActivity("journal", `Journal entry — mood: ${data.mood}`);
    return (await this.getJournalEntry(id))!;
  }

  async updateJournalEntry(id: string, data: Partial<JournalEntry>): Promise<JournalEntry | undefined> {
    const existing = await this.getJournalEntry(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    const { error } = await this.supabase.from("journal_entries").update(onlyPatched({
      date: merged.date, mood: merged.mood, content: merged.content,
      tags: merged.tags, energy: merged.energy ?? null,
      gratitude: merged.gratitude || null, highlights: merged.highlights || null,
    }, data as Record<string, any>, { date: "date", mood: "mood", content: "content", tags: "tags", energy: "energy", gratitude: "gratitude", highlights: "highlights" })).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // [P2.2] Ownership patches go through the single writer (setOwners).
    if ((data as any).linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("journal_entry", id, (data as any).linkedProfiles);
    }
    return this.getJournalEntry(id);
  }

  async deleteJournalEntry(id: string): Promise<boolean> {
    /* D1: clean up entity_links rows that reference this journal */
    await this.cleanupEntityLinks("journal", id);
    // Use .select() so we can tell apart "row deleted" from "row did not exist".
    // Without this, Supabase returns no error in both cases and the caller
    // can't return a correct 404 vs 200.
    const { data, error } = await this.supabase
      .from("journal_entries").delete().eq("id", id).eq("user_id", this.userId)
      .select("id");
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }

  // ============================================================
  // MEMORY
  // ============================================================
  async getMemories(): Promise<MemoryItem[]> {
    return this.memo("getMemories", async () => {
      const { data, error } = await this.supabase.from("memories").select("*").eq("user_id", this.userId).is("deleted_at", null);
      if (error) throw error;
      return (data || []).map(r => this.rowToMemory(r));
    });
  }

  async saveMemory(data: InsertMemory): Promise<MemoryItem> {
    const now = new Date().toISOString();
    // Check if key exists — update
    const { data: existing } = await this.supabase.from("memories").select("*").eq("user_id", this.userId).eq("key", data.key).single();
    const finalCategory = data.category || existing?.category || "general";
    // Encrypt sensitive values at rest. Plaintext value is returned to the
    // caller via rowToMemory's pass-through path (non-prefixed plaintext).
    let storedValue = data.value;
    if (shouldEncryptMemory(finalCategory) && typeof data.value === "string" && data.value) {
      try { storedValue = encryptField(data.value); }
      catch (e: any) { console.error('[saveMemory] encryption failed, storing plaintext:', e?.message || e); }
    }
    if (existing) {
      await this.supabase.from("memories").update({
        value: storedValue, category: finalCategory, updated_at: now,
      }).eq("id", existing.id).eq("user_id", this.userId);
      return this.rowToMemory({ ...existing, value: storedValue, category: finalCategory, updated_at: now });
    }
    const id = randomUUID();
    const { error } = await this.supabase.from("memories").insert({
      id, user_id: this.userId, key: data.key, value: storedValue,
      category: finalCategory, created_at: now, updated_at: now,
    });
    if (error) throw error;
    return this.rowToMemory({ id, key: data.key, value: storedValue, category: finalCategory, created_at: now, updated_at: now });
  }

  async recallMemory(query: string): Promise<MemoryItem[]> {
    // Unified recall: the AI's only "what do you know about me" tool. It must
    // search EVERY store of structured user knowledge, not just the dedicated
    // `memories` table — and it must bridge the user's vocabulary to whatever
    // label the data actually carries.
    //
    // THE BUG THIS FIXES: matching used to require the *entire* query string to
    // be a literal substring of a field key or value. So "What is the VIN of my
    // Honda CRV?" — and even the focused query "vin" — came up empty against a
    // registration document whose extracted field is labeled "Vehicle ID
    // Number". The VIN was sitting right there; the matcher just couldn't
    // connect "vin" to "Vehicle ID Number".
    //
    // Now we tokenize the query, drop stopwords, expand each token through
    // bidirectional alias groups (vin ⇄ "vehicle id number", plate ⇄ "license
    // number", dob ⇄ "date of birth", …), and SCORE every candidate field so
    // the best matches rise to the top. Sources scanned: memories + profiles
    // (name, notes, tags, fields) + documents (name, tags, extracted_data) +
    // captures (payload). See shared/recall-match.ts.
    const terms = buildRecallTerms(query);
    if (terms.isEmpty) return [];

    const now = new Date().toISOString();
    type Scored = { item: MemoryItem; score: number };
    const scored: Scored[] = [];

    // Score one candidate (key path + value); keep it only if something matched.
    const consider = (id: string, key: string, value: any, category: string) => {
      if (value === null || value === undefined) return;
      const score = recallMatchScore(terms, key, value);
      if (score <= 0) return;
      const strVal = typeof value === "object" ? JSON.stringify(value) : String(value);
      scored.push({ item: { id, key, value: strVal, category, createdAt: now, updatedAt: now }, score });
    };

    // Deep field walker shared by profiles + documents + captures. Emits one
    // candidate per leaf, keyed by its full dotted path (so the source label —
    // e.g. the document name "Honda Registration" — also contributes to the
    // key-path match and surfaces every field of the matching document).
    const walk = (sourceLabel: string, sourceId: string, category: string, obj: any, pathParts: string[] = []) => {
      if (obj === null || obj === undefined) return;
      if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") {
        const path = pathParts.join(".");
        consider(`${sourceId}:${path || "value"}`, `${sourceLabel}.${path || "value"}`, obj, category);
        return;
      }
      if (Array.isArray(obj)) {
        obj.forEach((item, i) => walk(sourceLabel, sourceId, category, item, [...pathParts, String(i)]));
        return;
      }
      if (typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          walk(sourceLabel, sourceId, category, v, [...pathParts, k]);
        }
      }
    };

    // 1) memories table (key/value/category all searchable)
    try {
      const memories = await this.getMemories();
      for (const m of memories) {
        consider(m.id, `${m.category || ""} ${m.key || ""}`.trim() || m.key || "memory",
          m.value, m.category || "general");
      }
    } catch (e: any) {
      console.error("[recallMemory] memories scan failed:", e?.message || e);
    }

    // 2) profiles: name, type, notes, tags, fields (deep)
    try {
      const profiles = await this.getProfiles();
      for (const p of profiles) {
        const label = p.name || "profile";
        const idStr = String((p as any).id || label);
        const type = String((p as any).type || "profile");
        // The profile itself: name + type + notes + tags all feed the key/value
        // so a query for the entity ("honda crv") returns it even with no field.
        const tagsArr: string[] = Array.isArray((p as any).tags) ? (p as any).tags : [];
        consider(`profile:${idStr}`,
          `${label} ${type} ${tagsArr.join(" ")}`.trim(),
          (p as any).notes || `${type} — ${label}`, "profile");
        if ((p as any).fields && typeof (p as any).fields === "object") {
          walk(`${label} ${type}`, `profile:${idStr}`, "profile_field", (p as any).fields);
        }
      }
    } catch (e: any) {
      console.error("[recallMemory] profiles scan failed:", e?.message || e);
    }

    // 3) documents: name, type, tags, extractedData (deep). We don't read raw
    // file text -- the OCR/extracted_data already holds the structured fields.
    try {
      const docs = await this.getDocuments();
      for (const d of docs) {
        const label = (d as any).name || "document";
        const idStr = String((d as any).id || label);
        const type = String((d as any).type || "document");
        const tagsArr: string[] = Array.isArray((d as any).tags) ? (d as any).tags : [];
        consider(`doc:${idStr}`,
          `${label} ${type} ${tagsArr.join(" ")}`.trim(),
          (d as any).name || "document", "document");
        if ((d as any).extractedData && typeof (d as any).extractedData === "object") {
          walk(`${label} ${type}`, `doc:${idStr}`, "document_extracted", (d as any).extractedData);
        }
      }
    } catch (e: any) {
      console.error("[recallMemory] documents scan failed:", e?.message || e);
    }

    // 4) captures (universal capture layer -- the chat firehose).
    try {
      const { data: captures } = await this.supabase
        .from("captures")
        .select("id, kind, payload, created_at")
        .eq("user_id", this.userId)
        .order("created_at", { ascending: false })
        .limit(500);
      for (const c of (captures || [])) {
        const idStr = String(c.id);
        const label = `capture/${c.kind || "item"}`;
        if (c.payload && typeof c.payload === "object") {
          walk(label, `capture:${idStr}`, "capture", c.payload);
        }
      }
    } catch (e: any) {
      // captures table may not be present in older deployments -- fail open.
      console.error("[recallMemory] captures scan failed:", e?.message || e);
    }

    // Best matches first, then de-duplicate by (key, value) so we don't return
    // the same VIN three times when it lives in memories + profile + document.
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const deduped: MemoryItem[] = [];
    for (const { item } of scored) {
      const k = `${(item.key || "").toLowerCase()}|${String(item.value || "").toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(item);
    }
    // Cap to keep the prompt manageable when a query is too broad.
    return deduped.slice(0, 50);
  }

  async deleteMemory(id: string): Promise<boolean> {
    // .select() returns the deleted rows so we can distinguish 404 from 200.
    const { data, error } = await this.supabase
      .from("memories").delete().eq("id", id).eq("user_id", this.userId)
      .select("id");
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }

  async updateMemory(id: string, data: Partial<any>): Promise<any | undefined> {
    const updates: Record<string, any> = {};
    // Determine the effective category for the encryption decision: use the
    // incoming update if present, otherwise read the row to learn its current
    // category. Prevents leaking a sensitive value when only `value` is sent
    // and the existing row's category is sensitive.
    let effectiveCategory: string | undefined = data.category;
    if (data.value !== undefined && effectiveCategory === undefined) {
      const { data: existing } = await this.supabase.from("memories")
        .select("category").eq("id", id).eq("user_id", this.userId).single();
      effectiveCategory = existing?.category;
    }
    if (data.value !== undefined) {
      let storedVal = data.value;
      if (shouldEncryptMemory(effectiveCategory) && typeof data.value === "string" && data.value) {
        try { storedVal = encryptField(data.value); }
        catch (e: any) { console.error('[updateMemory] encryption failed, storing plaintext:', e?.message || e); }
      }
      updates.value = storedVal;
    }
    if (data.category !== undefined) updates.category = data.category;
    const { data: result, error } = await this.supabase
      .from("memories")
      .update(updates)
      .eq("id", id)
      .eq("user_id", this.userId)
      .select()
      .single();
    if (error || !result) return undefined;
    return this.rowToMemory(result);
  }

  // ============================================================
  // GOALS
  // ============================================================
  async getGoals(profileIds?: string[]): Promise<Goal[]> {
    // Memoized like the other list reads: the dashboard bootstrap and any
    // sibling reads in the same request share one fetch + progress pass.
    return this.memo(`getGoals${this._fk(profileIds)}`, () => this._getGoalsImpl(profileIds));
  }
  private async _getGoalsImpl(profileIds?: string[]): Promise<Goal[]> {
    // PERF (durable-fix-phase1): DB pushdown via idx_goals_linked_profiles.
    let q = this.supabase.from("goals").select("*").eq("user_id", this.userId).is("deleted_at", null);
    q = this._applyProfileFilter(q, await this.pushdownIds(profileIds));
    const { data, error } = await q.order("created_at", { ascending: false });
    if (error) throw error;
    const goals = (data || []).map(r => this.rowToGoal(r));
    // [PERF 2026-07-31, N+1 fix] Progress used to be computed with a SERIAL
    // await per active goal, each doing its own getTracker/getHabit (2 queries
    // apiece) — 5 goals ≈ 10 sequential round trips inside every dashboard
    // bootstrap. Resolve trackers/habits ONCE via the request-memoized list
    // reads (free when the same request already fetched them, which the
    // bootstrap always does) and compute all goals in parallel.
    const active = goals.filter(g => g.status === "active");
    if (active.length > 0) {
      const [trackerList, habitList] = await Promise.all([
        active.some(g => g.trackerId) ? this.getTrackers() : Promise.resolve([] as Tracker[]),
        active.some(g => g.habitId) ? this.getHabits() : Promise.resolve([] as Habit[]),
      ]);
      const lookup = {
        trackerById: new Map(trackerList.map(t => [t.id, t])),
        habitById: new Map(habitList.map(h => [h.id, h])),
      };
      await Promise.all(active.map(async goal => {
        goal.current = await this.computeGoalProgress(goal, lookup);
      }));
    }
    return goals;
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    const { data, error } = await this.supabase.from("goals").select("*").eq("id", id).eq("user_id", this.userId).is("deleted_at", null).single();
    if (error || !data) return undefined;
    const goal = this.rowToGoal(data);
    if (goal.status === "active") {
      goal.current = await this.computeGoalProgress(goal);
    }
    return goal;
  }

  async createGoal(data: InsertGoal): Promise<Goal> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const milestones = (data.milestones || []).map(m => ({ ...m, reached: false }));
    // Auto-link to self profile if no profiles specified
    let linkedProfiles = (data as any).linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    const { error } = await this.supabase.from("goals").insert({
      // Bug fix (AI e2e): `type` column is NOT NULL but the AI's
      // create_goal often omits it (the LLM treats it as optional). Fall
      // back to "custom" so the insert succeeds and the goal is still
      // visible on the goals page — "custom" is a valid enum value.
      // Bug fix (AI e2e): `target` and `unit` are NOT NULL in the DB but
      // the AI's create_goal often omits one or both (it phrases a goal
      // like "read more this year" without a numeric target). Default
      // sensible values so the row inserts and the goal is at least
      // visible — the user can edit specifics inline afterwards.
      id, user_id: this.userId, title: data.title, type: data.type || "custom", target: data.target ?? 0,
      current: data.startValue || 0, unit: data.unit || "", start_value: data.startValue ?? null,
      deadline: data.deadline || null, tracker_id: data.trackerId || null,
      habit_id: data.habitId || null, category: data.category || null,
      linked_profiles: linkedProfiles,
      status: "active", milestones, created_at: now, updated_at: now,
    });
    if (error) throw error;
    this.logActivity("goal", `Created goal: ${data.title}`);
    return (await this.getGoal(id))!;
  }

  async updateGoal(id: string, data: Partial<Goal>): Promise<Goal | undefined> {
    const existing = await this.getGoal(id);
    if (!existing) return undefined;
    // [P0.2] optimistic concurrency — 409 if the row moved since the caller read it.
    this.assertNoWriteConflict(data as Record<string, any>, existing.updatedAt);
    const now = new Date().toISOString();
    const updates: Record<string, any> = { updated_at: now };
    if (data.title !== undefined) updates.title = data.title;
    if (data.type !== undefined) updates.type = data.type;
    if (data.target !== undefined) updates.target = data.target;
    if (data.current !== undefined) updates.current = data.current;
    if (data.unit !== undefined) updates.unit = data.unit;
    if (data.startValue !== undefined) updates.start_value = data.startValue;
    if (data.deadline !== undefined) updates.deadline = data.deadline;
    if (data.trackerId !== undefined) updates.tracker_id = data.trackerId;
    if (data.habitId !== undefined) updates.habit_id = data.habitId;
    if (data.category !== undefined) updates.category = data.category;
    if (data.status !== undefined) updates.status = data.status;
    if (data.milestones !== undefined) updates.milestones = data.milestones;

    // Auto-complete: if the new (or existing) `current` is >= target and the
    // caller did not explicitly set status, mark the goal completed. Without
    // this, goals that hit 100% via UI edits (or any non-AI path) stayed
    // "active" forever and never showed up in completed lists.
    const effectiveCurrent = data.current !== undefined ? data.current : existing.current;
    const effectiveTarget = data.target !== undefined ? data.target : existing.target;
    if (
      data.status === undefined &&
      existing.status === "active" &&
      typeof effectiveCurrent === "number" &&
      typeof effectiveTarget === "number" &&
      effectiveTarget > 0 &&
      effectiveCurrent >= effectiveTarget
    ) {
      updates.status = "completed";
    }
    // Leaving "active" freezes the figure: progress is computed live only for
    // active goals, so a goal completed by lowering its target (or paused /
    // abandoned) used to fall back to the 0 its row stored and show "0 / 50".
    if (updates.status !== undefined && updates.status !== "active" && existing.status === "active"
      && data.current === undefined && typeof effectiveCurrent === "number" && Number.isFinite(effectiveCurrent)) {
      updates.current = effectiveCurrent;
    }

    const { error } = await this.supabase.from("goals").update(updates).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // [P2.2] Ownership patches go through the single writer (setOwners), not a
    // raw linked_profiles write alongside the rest of the patch.
    if ((data as any).linkedProfiles !== undefined) {
      await this.applyOwnershipPatch("goal", id, (data as any).linkedProfiles);
    }
    return this.getGoal(id);
  }

  async deleteGoal(id: string): Promise<boolean> {
    // Soft delete — the column always existed; the delete just never used it,
    // making goals the one entity that was unrecoverable by accident.
    const { data, error } = await this.supabase.from("goals")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId).is("deleted_at", null).select("id");
    return !error && Array.isArray(data) && data.length > 0;
  }

  async restoreGoal(id: string): Promise<boolean> {
    const { data, error } = await this.supabase.from("goals").update({ deleted_at: null })
      .eq("id", id).eq("user_id", this.userId).select("id, linked_profiles");
    const ok = !error && Array.isArray(data) && data.length > 0;
    if (ok) await this._reownRestoredRow("goal", id, data![0]);
    return ok;
  }

  /**
   * `lookup` (optional, N+1 fix): pre-resolved tracker/habit maps from the
   * request-memoized list reads. A tracker found there with entries is used
   * directly; a tracker that is MISSING or has an empty 120-day entry window
   * falls back to the direct getTracker(id) fetch, because the list read
   * windows entries to 120 days while goal progress ("latest weight") must
   * see the full history of a stale tracker. Without `lookup` behavior is
   * exactly the pre-fix per-goal fetch.
   */
  private async computeGoalProgress(
    goal: Goal,
    lookup?: { trackerById: Map<string, Tracker>; habitById: Map<string, Habit> },
  ): Promise<number> {
    // "This month" is the USER's month (getStats does the same). The server
    // runs in UTC, so getMonth() on the host rolled to next month at 5 pm
    // Pacific on the last day, and `new Date("YYYY-MM-DD")` on a date-only
    // expense read as UTC midnight — the 1st landed in the previous month for
    // every negative-offset user.
    const thisMonthKey = getUserCurrentMonth(this._timezone);
    const inThisMonth = (v: string | Date | null | undefined) =>
      (localDayOf(v, this._timezone) || "").slice(0, 7) === thisMonthKey;
    const resolveTracker = async (id: string): Promise<Tracker | undefined> => {
      const fromList = lookup?.trackerById.get(id);
      if (fromList && fromList.entries.length > 0) return fromList;
      return this.getTracker(id);
    };
    const resolveHabit = async (id: string): Promise<Habit | undefined> => {
      return lookup?.habitById.get(id) ?? this.getHabit(id);
    };

    switch (goal.type) {
      case "weight_loss":
      case "weight_gain": {
        if (!goal.trackerId) return goal.current;
        const tracker = await resolveTracker(goal.trackerId);
        if (!tracker || tracker.entries.length === 0) return goal.current;
        const latest = tracker.entries[tracker.entries.length - 1];
        return parseFloat(latest.values.weight || latest.values.value || "0") || goal.current;
      }
      case "habit_streak": {
        if (!goal.habitId) return goal.current;
        const habit = await resolveHabit(goal.habitId);
        if (!habit) return goal.current;
        return habit.currentStreak;
      }
      case "fitness_distance": {
        if (!goal.trackerId) return goal.current;
        const tracker = await resolveTracker(goal.trackerId);
        if (!tracker) return goal.current;
        const entries = tracker.entries.filter(e => inThisMonth(e.timestamp));
        return entries.reduce((sum, e) => sum + (parseFloat(e.values.distance || e.computed?.distanceMiles || "0")), 0);
      }
      case "fitness_frequency": {
        if (!goal.trackerId) return goal.current;
        const tracker = await resolveTracker(goal.trackerId);
        if (!tracker) return goal.current;
        return tracker.entries.filter(e => inThisMonth(e.timestamp)).length;
      }
      case "spending_limit": {
        if (!goal.category) return goal.current;
        const expenses = await this.getExpenses();
        // Expenses carry canonical categories; the goal's category is folded
        // the same way so "Groceries" meets the "food" spend (the goal stayed
        // at $0 forever when the spellings differed).
        const goalBucket = budgetCategoryKey(goal.category);
        return expenses.filter(e =>
          inThisMonth(e.date) &&
          budgetCategoryKey(e.category) === goalBucket,
        ).reduce((sum, e) => sum + e.amount, 0);
      }
      case "tracker_target": {
        if (!goal.trackerId) return goal.current;
        const tracker = await resolveTracker(goal.trackerId);
        if (!tracker || tracker.entries.length === 0) return goal.current;
        const latest = tracker.entries[tracker.entries.length - 1];
        // A tracker without field definitions (API/import-created: just a
        // name and a unit) logs `{ value }` entries; the goal used to stay at
        // its stored figure forever because the no-fields case bailed out
        // before the first-value fallback below.
        const fields: any[] = Array.isArray(tracker.fields) ? tracker.fields : [];
        const primary = fields.find((f: any) => f.isPrimary) || fields.find((f: any) => f.type === "number");
        if (primary) return parseFloat(latest.values[primary.name] || "0") || goal.current;
        const firstNumeric = Object.values(latest.values || {}).map((v) => parseFloat(String(v))).find((n) => Number.isFinite(n));
        return firstNumeric ?? goal.current;
      }
      case "savings":
      case "custom":
      default:
        return goal.current;
    }
  }

  // ============================================================
  // DOMAINS
  // ============================================================
  async getDomains(): Promise<Domain[]> {
    const { data, error } = await this.supabase.from("domains").select("*").eq("user_id", this.userId);
    if (error) throw error;
    return (data || []).map(r => this.rowToDomain(r));
  }

  private async getDomain(id: string): Promise<Domain | undefined> {
    const { data, error } = await this.supabase.from("domains").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    return this.rowToDomain(data);
  }

  async createDomain(data: InsertDomain): Promise<Domain> {
    const id = randomUUID();
    const slug = data.name.toLowerCase().replace(/\s+/g, "-");
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("domains").insert({
      id, user_id: this.userId, name: data.name, slug, icon: data.icon || null,
      color: data.color || null, description: data.description || null,
      fields: data.fields || [], created_at: now,
    });
    if (error) throw error;
    this.logActivity("domain", `Created domain: ${data.name}`);
    return (await this.getDomain(id))!;
  }

  async updateDomain(id: string, data: Partial<any>): Promise<any | undefined> {
    const updates: Record<string, any> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.icon !== undefined) updates.icon = data.icon;
    if (data.color !== undefined) updates.color = data.color;
    if (data.fields !== undefined) updates.fields = data.fields;
    const { error } = await this.supabase
      .from("domains")
      .update(updates)
      .eq("id", id)
      .eq("user_id", this.userId);
    if (error) return undefined;
    return await this.getDomain(id);
  }

  async deleteDomain(id: string): Promise<boolean> {
    await this.supabase.from("domain_entries").delete().eq("domain_id", id).eq("user_id", this.userId);
    const { data, error } = await this.supabase.from("domains").delete().eq("id", id).eq("user_id", this.userId).select("id");
    return !error && Array.isArray(data) && data.length > 0;
  }

  async getDomainEntries(domainId: string): Promise<DomainEntry[]> {
    const { data, error } = await this.supabase.from("domain_entries").select("*").eq("domain_id", domainId).eq("user_id", this.userId);
    if (error) throw error;
    return (data || []).map(r => this.rowToDomainEntry(r));
  }

  async addDomainEntry(domainId: string, values: Record<string, any>, tags?: string[], notes?: string): Promise<DomainEntry | undefined> {
    const domain = await this.getDomain(domainId);
    if (!domain) return undefined;
    const id = randomUUID();
    const now = new Date().toISOString();
    const { data, error } = await this.supabase.from("domain_entries").insert({
      id, user_id: this.userId, domain_id: domainId, entry_values: values,
      tags: tags || [], notes: notes || null, created_at: now,
    }).select().single();
    if (error) throw error;
    this.logActivity("domain", `Added entry to ${domain.name}`);
    return data ? this.rowToDomainEntry(data) : undefined;
  }

  // ============================================================
  // ENTITY LINKS
  // ============================================================
  async getEntityLinks(entityType: string, entityId: string): Promise<EntityLink[]> {
    // Both values are interpolated into the .or() filter below — see isPostgrestSafe.
    if (!isPostgrestSafe(entityType) || !isPostgrestSafe(entityId)) return [];
    const { data, error } = await this.supabase.from("entity_links").select("*").eq("user_id", this.userId)
      .or(`and(source_type.eq.${entityType},source_id.eq.${entityId}),and(target_type.eq.${entityType},target_id.eq.${entityId})`)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return this.pruneLinksToTrashed((data || []).map(r => this.rowToEntityLink(r)));
  }

  /**
   * Hide links whose endpoint sits in the trash (or is gone). Soft deletes keep
   * their entity_links so a restore brings the relationships back; until then
   * the link must not surface on the other end, and a link to a hard-deleted
   * row (an interrupted purge, an old cascade) heals itself on read. A lookup
   * that fails keeps that type's links: a degraded list beats an empty one.
   */
  private async pruneLinksToTrashed(links: EntityLink[]): Promise<EntityLink[]> {
    if (links.length === 0) return links;
    const wanted = new Map<string, Set<string>>();
    for (const l of links) {
      for (const [t, id] of [[l.sourceType, l.sourceId], [l.targetType, l.targetId]] as const) {
        if (!LINK_ENDPOINT_TABLES[t] || !UUID_RE.test(String(id))) continue;
        if (!wanted.has(t)) wanted.set(t, new Set());
        wanted.get(t)!.add(String(id));
      }
    }
    const live = new Map<string, Set<string>>();
    await Promise.all([...wanted].map(async ([t, ids]) => {
      const { data, error } = await this.supabase.from(LINK_ENDPOINT_TABLES[t]).select("id")
        .eq("user_id", this.userId).in("id", [...ids]).is("deleted_at", null);
      if (error) { console.warn(`[entity-links] liveness lookup failed for ${t}: ${error.message}`); return; }
      live.set(t, new Set((data || []).map((r: any) => String(r.id))));
    }));
    const alive = (t: string, id: string) => !live.has(t) || live.get(t)!.has(String(id));
    return links.filter(l => alive(l.sourceType, l.sourceId) && alive(l.targetType, l.targetId));
  }

  async createEntityLink(data: InsertEntityLink): Promise<EntityLink> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const confidence = data.confidence ?? 1;
    // Try insert — ignore unique constraint violations
    const { data: inserted, error } = await this.supabase.from("entity_links").insert({
      id, user_id: this.userId, source_type: data.sourceType, source_id: data.sourceId,
      target_type: data.targetType, target_id: data.targetId,
      relationship: data.relationship, confidence, created_at: now,
    }).select().single();
    if (!error && inserted) return this.rowToEntityLink(inserted);
    // Duplicate — find existing
    const { data: existing } = await this.supabase.from("entity_links").select("*").eq("user_id", this.userId)
      .eq("source_type", data.sourceType).eq("source_id", data.sourceId)
      .eq("target_type", data.targetType).eq("target_id", data.targetId).single();
    if (existing) return this.rowToEntityLink(existing);
    throw error || new Error("Failed to create entity link");
  }

  async deleteEntityLink(id: string): Promise<boolean> {
    const { data, error } = await this.supabase.from("entity_links").delete().eq("id", id).eq("user_id", this.userId).select("id");
    return !error && Array.isArray(data) && data.length > 0;
  }

  /**
   * D1: entity_links is polymorphic (source/target are TEXT pairs) so we
   * can't declare typed FKs with ON DELETE CASCADE in the DB. Instead,
   * every entity-delete path calls this helper to wipe links pointing at
   * the deleted row from either side. Failures are logged but don't fail
   * the parent delete — the parent row already has its own soft-delete
   * flag, so a residual orphan link is a degraded-but-not-broken state.
   */
  private async cleanupEntityLinks(entityType: string, entityId: string): Promise<void> {
    try {
      await this.supabase.from("entity_links").delete()
        .or(`and(source_type.eq.${entityType},source_id.eq.${entityId}),and(target_type.eq.${entityType},target_id.eq.${entityId})`)
        .eq("user_id", this.userId);
    } catch (e: any) {
      console.warn(`[cleanupEntityLinks] ${entityType}/${entityId}: ${e?.message || e}`);
    }
  }

  async getRelatedEntities(entityType: string, entityId: string): Promise<any[]> {
    const links = await this.getEntityLinks(entityType, entityId);
    const related: any[] = [];
    for (const link of links) {
      const otherType = (link.sourceType === entityType && link.sourceId === entityId) ? link.targetType : link.sourceType;
      const otherId = (link.sourceType === entityType && link.sourceId === entityId) ? link.targetId : link.sourceId;
      let entity: any = null;
      switch (otherType) {
        case "profile": entity = await this.getProfile(otherId); break;
        case "tracker": entity = await this.getTracker(otherId); break;
        case "task": entity = await this.getTask(otherId); break;
        case "expense": {
          const expenses = await this.getExpenses();
          entity = expenses.find(e => e.id === otherId) || null;
          break;
        }
        case "event": entity = await this.getEvent(otherId); break;
        case "habit": entity = await this.getHabit(otherId); break;
        case "obligation": entity = await this.getObligation(otherId); break;
        // PERF: metadata-only read — the binary was stripped below anyway.
        case "document": entity = await this.getDocumentMeta(otherId); break;
      }
      if (entity) {
        if (otherType === "document" && entity.fileData) {
          const { fileData, ...rest } = entity;
          entity = rest;
        }
        related.push({ ...entity, _type: otherType, _linkId: link.id, _relationship: link.relationship, _confidence: link.confidence });
      }
    }
    return related;
  }

  // ============================================================
  // DASHBOARD
  // ============================================================
  async getStats(filterProfileId?: string, filterProfileIds?: string[], opts?: { sharedFetches?: boolean }): Promise<DashboardStats> {
    // PERF (2026-05-28): single Promise.all wave — was two serial waves
    // (one before computing streaks/habits, then another for
    // profiles/events/artifacts/memories). The streak/habit math is pure JS
    // and doesn't need to block fetching; collapsing to one parallel batch
    // cut cold /api/stats from ~4s → ~1.5s.
    // PERF (2026-05-30 Phase 1b): push the profile filter into the DB
    // queries (linked_profiles GIN index) rather than fetching all rows and
    // filtering in JS. CORRECTNESS: pushdown only matches
    // linked_profiles ∩ selection — it would drop orphan items
    // (linkedProfiles = []), which the unified passesProfileFilter rule
    // includes whenever a self profile is selected. So we pre-fetch
    // profiles, then push the filter down ONLY when no self profile is
    // in the selection. The post-fetch matchesProfile() still runs to
    // enforce the unified rule.
    const fpIds = filterProfileIds || (filterProfileId ? [filterProfileId] : undefined);
    // Start getProfiles() in parallel with the rest. We need it to decide
    // whether DB pushdown is safe (see _dbFilterIds), but we don't want to
    // serialize the wave. await it as the very first thing after Promise.all.
    const profilesPromise = this.getProfiles();
    // Recent Activity has to be able to show a payment. Started here so the one
    // bounded, indexed read overlaps the rest of the wave instead of adding to
    // the critical path.
    const recentPaymentsPromise = Promise.resolve(
      (this as any).getRecentLiabilityPayments?.(10),
    ).catch(() => [] as any[]);
    // Best-effort pushdown: if the caller passed a filter that contains NO
    // self profile, the unified rule reduces to "linked_profiles ∩
    // selection ≠ ∅" — which the GIN-indexed cs.[id] check enforces. When
    // self IS in the selection, orphans (linkedProfiles = []) must also pass,
    // so we conservatively skip DB pushdown and let the JS filter do its job.
    const allProfiles = await profilesPromise;
    const _selfIds = selfIdsFrom(allProfiles);
    const _selfInFilter = !!fpIds && fpIds.some(id => _selfIds.has(id));
    // [PERF 2026-07-31 sharedFetches] Inside the dashboard bootstrap, the same
    // request ALSO reads every one of these tables unfiltered (seed payloads +
    // buildNotifications). Pushing the filter down there means each table is
    // fetched twice under two different memo keys ("getTasks" and
    // "getTasks:<ids>") — ~2× the Supabase round trips per bootstrap. With
    // sharedFetches the wave fetches unfiltered and memo-collapses with the
    // sibling reads; the matchesProfile() JS pass below (always the
    // correctness authority) produces identical results either way.
    const _pushdownIds = fpIds && !_selfInFilter ? fpIds : undefined;
    const _dbFilterIds = opts?.sharedFetches ? undefined : _pushdownIds;
    const [
      allTasks, allExpenses, allTrackers, allHabits, allObligations,
      journalEntries, allEvents, artifacts, memories,
    ] = await Promise.all([
      this.getTasks(_dbFilterIds), this.getExpenses(_dbFilterIds), this.getTrackers(undefined, _dbFilterIds),
      this.getHabits(_dbFilterIds), this.getObligations(_dbFilterIds), this.getJournalEntries(_dbFilterIds),
      // Artifacts keep the per-scope pushdown even under sharedFetches:
      // totalArtifacts is NOT re-filtered in JS below (it counts what the
      // fetch returned), and no sibling read in the bootstrap fetches
      // artifacts — so scoping it costs nothing and changing it would
      // change the number.
      this.getEvents(_dbFilterIds), this.getArtifacts(_pushdownIds), this.getMemories(),
    ]);

    // Use the unified rule (shared/profile-filter.ts) so server stats agree
    // with the client's Finance/Calendar views — see getDashboardEnhanced for
    // the full rationale.
    const [statsAssetLinks, statsLiabLinks] = await Promise.all([
      this.getAssetPartyLinks().catch(() => [] as any[]),
      this.getLiabilityProfileLinks().catch(() => [] as any[]),
    ]);
    const filterCtxStats = { selectedIds: fpIds || [], allProfiles, assetPartyLinks: statsAssetLinks as any[], liabilityProfileLinks: statsLiabLinks as any[] };
    const matchesProfile = (linkedProfiles: string[]) =>
      passesProfileFilter(linkedProfiles, filterCtxStats);
    const tasks = allTasks.filter(t => matchesProfile(t.linkedProfiles));
    // COST OF OWNERSHIP in the person-scoped dashboard: an expense linked to an
    // asset ("$50 gas for my truck") must count in the OWNER's monthly spend /
    // cash flow, not just under the asset. Widen the expense scope to include
    // assets the selected person owns/contains. Each expense is still a single
    // row counted once. Only widens when a person filter is active.
    const ownedAssetSet = (fpIds && fpIds.length)
      ? ownedAssetIds(fpIds, allProfiles as any, statsAssetLinks as any[])
      : new Set<string>();
    const expenseScopeIds = (fpIds && ownedAssetSet.size > 0)
      ? Array.from(new Set([...fpIds, ...ownedAssetSet]))
      : fpIds;
    const filterCtxExpense = { selectedIds: expenseScopeIds || [], allProfiles };
    // When the scope widened (person filter + owned assets), the person-only
    // pushdown (allExpenses) excluded asset-linked rows. PERF (2026-07): fetch
    // the WIDENED set via the same GIN pushdown + request-memo instead of the
    // whole expense table — bounded to the relevant rows, and shared with the
    // getDashboardEnhanced call in the same request.
    // Under sharedFetches, allExpenses is already the FULL table — a superset
    // of any widened scope — so the extra widened fetch would be a wasted
    // round trip; the JS filter below applies the widened ctx either way.
    const expenseSource = (fpIds && ownedAssetSet.size > 0 && !opts?.sharedFetches)
      ? await this.getExpenses(expenseScopeIds) : allExpenses;
    const expenses = expenseSource.filter(e => passesProfileFilter(e.linkedProfiles, filterCtxExpense));
    const trackers = allTrackers.filter(t => matchesProfile(t.linkedProfiles));
    const habits = allHabits.filter(h => matchesProfile(h.linkedProfiles || []));
    const obligations = allObligations.filter(o => matchesProfile(o.linkedProfiles));
    // Phase-fix: journal entries were the one entity not run through the
    // unified filter, so brand-new profiles (e.g. EMPTYPROBE_QA) saw the
    // global journalStreak/currentMood and a phantom "1 entry" badge on
    // the journal page. Apply the same passesProfileFilter rule so journal
    // stats are scoped to the active profile selection.
    const filteredJournal = journalEntries.filter((j: any) => matchesProfile(j.linkedProfiles || []));
    const now = new Date();
    // CRITICAL: month boundaries must be evaluated in the user's timezone, not
    // server UTC. The server runs in UTC on Vercel, so a user adding an expense
    // at 6pm PDT on April 30 would have it filed under April locally but the
    // server would compute thisMonth=May (UTC = May 1 already) and the
    // expense would silently disappear from "this month" totals.
    // We compare YYYY-MM strings (which are timezone-stable for the stored
    // date strings, since expenses store local YYYY-MM-DD).
    const userYM = new Date().toLocaleDateString('en-CA', { timeZone: this._timezone }).slice(0, 7);
    const monthlyExpenses = expenses.filter(e => (e.date || '').slice(0, 7) === userYM);
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    let weeklyEntries = 0;
    for (const t of trackers) weeklyEntries += t.entries.filter(e => new Date(e.timestamp) > weekAgo).length;

    const streaks: { name: string; days: number }[] = [];
    // Tracker streaks: walk back from "today in user's timezone".
    //
    // Bug #23 (DST/timezone): the previous walk did
    //   parseLocalDate(today) → setDate(-i) → toISOString().slice(0,10)
    // which always returns the UTC date. Tracker entries store ISO timestamps
    // (UTC), so a 11pm-Pacific entry on Apr 30 lands on May 1 UTC — the streak
    // walk would compare local dates to UTC slices and miss days. We now
    // bucket BOTH sides into the user's local calendar date.
    const trackerTz = this._timezone || 'America/Los_Angeles';
    const trackerTodayStr = getUserToday(trackerTz);
    for (const t of trackers) {
      if (t.entries.length < 2) continue;
      // Pre-bucket entries into local YYYY-MM-DD once — avoids O(N·30) work and
      // makes DST-day arithmetic trivial.
      const localDays = new Set<string>();
      for (const e of t.entries) {
        try { localDays.add(toLocalDateStr(new Date(e.timestamp), trackerTz)); }
        catch { localDays.add(e.timestamp.slice(0, 10)); }
      }
      let streak = 0;
      // Use addDays() (timezone-safe — noon UTC anchor) to step backward through
      // the calendar without DST drift.
      let cursor = trackerTodayStr;
      for (let i = 0; i < 30; i++) {
        if (localDays.has(cursor)) streak++; else if (i > 0) break;
        cursor = tzAddDays(cursor, -1);
      }
      if (streak >= 2) streaks.push({ name: t.name, days: streak });
    }
    // Habit streaks belong in this list too: the header STREAK chip takes
    // max(streaks, journalStreak) and OPENS the Habits popup, so leaving
    // habits out made the chip say "0D" while the popup said "1 Day Streak".
    // currentStreak is recomputed live in rowToHabit, so this stays in step
    // with what the popup derives from the same check-ins.
    for (const h of habits) {
      if ((h.currentStreak || 0) >= 1) streaks.push({ name: h.name, days: h.currentStreak });
    }

    const todayStr2 = getUserToday(this._timezone);
    const allActiveHabits = habits.filter(h => h.frequency === "daily" || h.frequency === "weekly");
    // For daily habits, check if completed today. For weekly habits, check if completed this week.
    // Week starts on Monday — ISO 8601 / international convention. Using
    // Sunday-start (getDay()===0) caused weekly-habit completion to flip on
    // Sunday morning, before users typically think "new week". We also use
    // a parsed local-date so the week boundary aligns with the user's
    // timezone, not server UTC.
    const todayLocal = parseLocalDate(todayStr2);
    const dow = todayLocal.getDay(); // 0=Sun..6=Sat
    const daysSinceMonday = (dow + 6) % 7; // Mon=0, Tue=1, ... Sun=6
    const weekStart = new Date(todayLocal);
    weekStart.setDate(weekStart.getDate() - daysSinceMonday);
    const weekStartStr = weekStart.toLocaleDateString('en-CA');
    const todayCompleted = allActiveHabits.filter(h => {
      if (h.frequency === "daily") return habitDayProgress(h as any, todayStr2).isComplete;
      // weekly: completed if any checkin exists this week
      return h.checkins.some(c => c.date >= weekStartStr && c.date <= todayStr2);
    }).length;
    // The rate is over OCCURRENCES so a 3× daily habit at 1 of 3 reads as a
    // third done rather than as zero. Habits not scheduled today are excluded
    // from both sides — they were previously counted as incomplete all week.
    const occurrenceRollup = habitsDayRollup(allActiveHabits as any[], todayStr2);
    const habitCompletionRate = occurrenceRollup.required > 0
      ? occurrenceRollup.percent
      : (allActiveHabits.length > 0 ? Math.round((todayCompleted / allActiveHabits.length) * 100) : 0);

    // BUG-20260528-upcoming-window: getStats() used a 7-day window while
    // getDashboardEnhanced() used 30 days. Tile count permanently differed
    // from popup count. Unified to 30 days via UPCOMING_BILL_WINDOW_DAYS.
    // One predicate (shared/obligation-windows.ts) for this tile AND the
    // popup rows in getDashboardEnhanced — same window, same status rule —
    // so the KPI count always equals the list length (ARCHITECTURE §10.1).
    const upcomingObs = obligations.filter(o => isUpcomingBill(o, now));
    // BUG-20260528-monthly-multipliers: previously used truncated 4.33/2.17.
    // Now uses exact fractions via shared toMonthlyAmount so this total
    // matches the Finance page and dashboard-enhanced.
    // Same status rule as getDashboardEnhanced (a paused bill costs nothing
    // this month) — the tile and the popup used to disagree by the paused amount.
    const monthlyObTotal = obligations.reduce(
      (s, o) => isActiveObligation(o) ? s + toMonthlyAmount(o.amount, o.frequency) : s,
      0,
    );

    // Journal streak: walk backwards from today in the user's timezone.
    // Bug #23: even with parseLocalDate(today), the inner setDate/-i +
    // toISOString().slice(0,10) shortcut still emits UTC dates, breaking the
    // walk on DST days and for users east of UTC. Use addDays() which is
    // anchored at T12:00:00 UTC so day arithmetic never drifts.
    let journalStreak = 0;
    const todayUserStr = getUserToday(this._timezone);
    const journalDays = new Set(filteredJournal.map(j => j.date));
    let jCursor = todayUserStr;
    for (let i = 0; i < 30; i++) {
      if (journalDays.has(jCursor)) journalStreak++; else if (i > 0) break;
      jCursor = tzAddDays(jCursor, -1);
    }

    // Payments on liabilities the current filter can see. `linkedProfiles` does
    // not exist on a payment row — a payment belongs to its liability — so the
    // scope check follows the liability, exactly like the balance does.
    const liabilityInScope = (p: Profile) =>
      !fpIds || fpIds.length === 0 ||
      fpIds.includes(p.id) ||
      (!!p.parentProfileId && fpIds.includes(p.parentProfileId));
    const visibleLiabilityIds = new Set(allProfiles.filter(liabilityInScope).map((p) => p.id));
    const recentLiabilityPayments = ((await recentPaymentsPromise) || [])
      .filter((p: any) => p && visibleLiabilityIds.has(p.liabilityProfileId));

    const recentJournal = [...filteredJournal].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const currentMood = recentJournal.length > 0 ? recentJournal[0].mood as MoodLevel : undefined;

    // All Supabase data already loaded in the single Promise.all above.
    const profiles = allProfiles;
    const events = allEvents.filter(e => matchesProfile(e.linkedProfiles));

    return {
      totalProfiles: profiles.length,
      totalTrackers: trackers.length,
      totalTasks: tasks.length,
      // Audit fix: case/whitespace-normalize so the KPI tile and the popup
      // (which uses normalizeFilter) agree on what counts as 'done'.
      activeTasks: tasks.filter(t => (t.status || "").trim().toLowerCase() !== "done").length,
      totalExpenses: expenses.reduce((sum, e) => sum + e.amount, 0),
      totalEvents: events.length,
      monthlySpend: monthlyExpenses.reduce((sum, e) => sum + e.amount, 0),
      weeklyEntries,
      streaks,
      recentActivity: [
        ...recentLiabilityPayments.map((p: any) => {
          const liability = allProfiles.find((x) => x.id === p.liabilityProfileId);
          return {
            type: 'liability_payment',
            description: `Paid $${p.amount} — ${liability?.name || 'liability'}`,
            timestamp: p.createdAt || p.paymentDate,
          };
        }),
        ...trackers.flatMap(t => t.entries.slice(-2).map(e => ({
          type: 'tracker_entry',
          description: (() => {
            const nums = Object.entries(e.values).filter(([,v]) => typeof v === 'number') as [string, number][];
            const strs = Object.entries(e.values).filter(([,v]) => typeof v === 'string' && v) as [string, string][];
            if (nums.length === 0 && strs.length === 0) return `Logged ${t.name}`;
            // For nutrition-like trackers with labeled fields
            if (nums.length >= 3 && ['calories','protein','carbs','fat','fiber'].some(f => t.name.toLowerCase().includes(f) || nums.some(([k]) => k.toLowerCase().includes(f)))) {
              const cal = nums.find(([k]) => k.toLowerCase().includes('cal'))?.[1] || nums[nums.length-1]?.[1];
              const protein = nums.find(([k]) => k.toLowerCase().includes('pro'))?.[1];
              const carbs = nums.find(([k]) => k.toLowerCase().includes('carb'))?.[1];
              const fat = nums.find(([k]) => k.toLowerCase().includes('fat'))?.[1];
              const parts = [cal != null ? `${cal} cal` : null, protein != null ? `${protein}g protein` : null, carbs != null ? `${carbs}g carbs` : null, fat != null ? `${fat}g fat` : null].filter(Boolean);
              return `${t.name}: ${parts.join(', ')}`;
            }
            if (nums.length === 1) return `${t.name}: ${nums[0][1]} ${nums[0][0]}`;
            const summary = nums.slice(0, 2).map(([k, v]) => `${v} ${k}`).join(', ');
            return `${t.name}: ${summary}${nums.length > 2 ? ` (+${nums.length - 2} more)` : ''}`;
          })(),
          timestamp: e.timestamp,
        }))),
        // Newest completions first, stamped with COMPLETION time (updatedAt).
        // getTasks() returns created_at DESC, so slice(-3) grabbed the three
        // OLDEST done tasks timestamped at creation — a task completed just now
        // never surfaced in Recent Activity.
        ...tasks.filter(t => t.status === 'done')
          .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
          .slice(0, 3).map(t => ({
            type: 'task_completed',
            description: `Completed: ${t.title}`,
            timestamp: t.updatedAt || t.createdAt,
          })),
        // Expenses are ordered date DESC — take the head, not the tail.
        ...expenses.slice(0, 3).map(e => ({
          type: 'expense',
          description: `$${e.amount} — ${e.description}`,
          timestamp: e.date || e.createdAt,
        })),
      ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 10),
      totalHabits: habits.length,
      habitCompletionRate,
      totalObligations: obligations.length,
      upcomingObligations: upcomingObs.length,
      monthlyObligationTotal: monthlyObTotal,
      journalStreak,
      currentMood,
      totalArtifacts: artifacts.length,
      totalMemories: memories.length,
    };
  }

  // ============================================================
  // ENHANCED DASHBOARD
  // ============================================================
  async getDashboardEnhanced(filterProfileId?: string, filterProfileIds?: string[], opts?: { sharedFetches?: boolean }): Promise<any> {
    const now = new Date();
    // Use user's timezone for 'today' — toISOString() is UTC and causes
    // events to disappear after ~5pm PST when UTC rolls to the next day
    const today = getUserToday(this._timezone);
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    // Multi-select filter support
    const fpIds = filterProfileIds || (filterProfileId ? [filterProfileId] : undefined);
    // Same timezone fix as getStats — "this month" is the user's local month,
    // not server-UTC month. Without this, all April expenses disappear after
    // 5pm PDT on April 30 (UTC has already rolled to May).
    const userYearMonth = new Date().toLocaleDateString('en-CA', { timeZone: this._timezone }).slice(0, 7);

    // PERF (2026-05-30 Phase 1b): push the profile filter into the DB
    // queries when the selection contains no self profile. Same correctness
    // rule as getStats — see the comment block above passesProfileFilter.
    // NW-15 (cold-load): the asset/liability link queries don't depend on the
    // profile filter, so kick them off concurrently with getProfiles() instead
    // of waiting for profiles first and only then starting them. On a cold
    // Supabase connection getProfiles() was the long pole (~3-4s) and nothing
    // else ran during it; overlapping the two link fetches removes that serial
    // gap. The filter-dependent fetches still wait on profiles (they need the
    // self-id resolution) but now start as soon as profiles resolve.
    const assetLinksPromise = this.getAssetPartyLinks().catch(() => [] as any[]);
    const liabLinksPromise = this.getLiabilityProfileLinks().catch(() => [] as any[]);
    const allProfiles = await this.getProfiles();
    const _selfIdsEnh = selfIdsFrom(allProfiles);
    const _selfInFilterEnh = !!fpIds && fpIds.some(id => _selfIdsEnh.has(id));
    // sharedFetches: fetch unfiltered so the request memo collapses these with
    // the bootstrap's sibling unfiltered reads — see getStats for rationale.
    // The passesProfileFilter pass below stays the correctness authority.
    const _dbFilterIdsEnh = (fpIds && !_selfInFilterEnh && !opts?.sharedFetches) ? fpIds : undefined;
    const [documents, rawTrackers, rawExpenses, rawObligations, rawTasks, rawEvents, allAssetLinks, allLiabLinks] = await Promise.all([
      this.getDocuments(_dbFilterIdsEnh), this.getTrackers(undefined, _dbFilterIdsEnh),
      this.getExpenses(_dbFilterIdsEnh), this.getObligations(_dbFilterIdsEnh),
      this.getTasks(_dbFilterIdsEnh), this.getEvents(_dbFilterIdsEnh),
      assetLinksPromise,
      liabLinksPromise,
    ]);
    // Per-asset / per-liability explicit ownership links, in the shape the
    // shared ownership-model consumes. The model is the SINGLE SOURCE OF TRUTH:
    // explicit owners win; with no explicit owners the Self profile owns 100%
    // (NOT the nesting parent). See shared/ownership-model.ts.
    const assetLinksByAsset = new Map<string, OwnershipLink[]>();
    for (const l of (allAssetLinks as any[]) || []) {
      const aid = (l as any).assetProfileId; const pid = (l as any).partyProfileId;
      if (!aid || !pid) continue;
      if (!assetLinksByAsset.has(aid)) assetLinksByAsset.set(aid, []);
      assetLinksByAsset.get(aid)!.push({ partyProfileId: pid, ownershipPercentage: Number((l as any).ownershipPercentage ?? 100), role: (l as any).role });
    }
    const liabLinksByLiability = new Map<string, OwnershipLink[]>();
    for (const l of (allLiabLinks as any[]) || []) {
      const lid = (l as any).liabilityProfileId; const pid = (l as any).partyProfileId;
      if (!lid || !pid) continue;
      if (!liabLinksByLiability.has(lid)) liabLinksByLiability.set(lid, []);
      liabLinksByLiability.get(lid)!.push({ partyProfileId: pid, ownershipPercentage: Number((l as any).ownershipPercentage ?? 100), role: (l as any).role });
    }
    // Use the SAME unified rule the client uses (shared/profile-filter.ts).
    // The previous strict-only rule diverged from the Finance / Calendar /
    // dashboard popup logic, which is why the user saw "Monthly Spend $0"
    // on the dashboard but "Total Spent $375" on the Finance page when
    // selecting the same Me filter — the client was including orphan
    // expenses (no linkedProfiles) under the self profile while the server
    // silently dropped them.
    const filterCtx = { selectedIds: fpIds || [], allProfiles, assetPartyLinks: allAssetLinks as any[], liabilityProfileLinks: allLiabLinks as any[] };
    const matchesProfileEnhanced = (linkedProfiles: string[]) =>
      passesProfileFilter(linkedProfiles, filterCtx);
    const allTrackers = rawTrackers.filter(t => matchesProfileEnhanced(t.linkedProfiles));
    // COST OF OWNERSHIP: include expenses from assets the selected person owns
    // (e.g. "$50 gas for my truck") in their monthly spend + cash flow. Reuses
    // allAssetLinks (already fetched) so no extra query. Single row per expense
    // → counted once. Only widens when a person filter is active.
    const ownedAssetSetEnh = (fpIds && fpIds.length)
      ? ownedAssetIds(fpIds, allProfiles as any, allAssetLinks as any[])
      : new Set<string>();
    const expenseScopeIdsEnh = (fpIds && ownedAssetSetEnh.size > 0)
      ? Array.from(new Set([...fpIds, ...ownedAssetSetEnh]))
      : fpIds;
    const filterCtxExpenseEnh = { selectedIds: expenseScopeIdsEnh || [], allProfiles };
    // PERF (2026-07): fetch the WIDENED scope via GIN pushdown + memo, not the
    // full expense table (see the matching comment in getStats).
    // Same as getStats: under sharedFetches rawExpenses is already the full
    // table (superset of the widened scope) — skip the extra fetch.
    const expenseSourceEnh = (fpIds && ownedAssetSetEnh.size > 0 && !opts?.sharedFetches)
      ? await this.getExpenses(expenseScopeIdsEnh) : rawExpenses;
    const allExpenses = expenseSourceEnh.filter(e => passesProfileFilter(e.linkedProfiles, filterCtxExpenseEnh));
    const allObligations = rawObligations.filter(o => matchesProfileEnhanced(o.linkedProfiles));
    const allTasks = rawTasks.filter(t => matchesProfileEnhanced(t.linkedProfiles));
    const allEvents = rawEvents.filter(e => matchesProfileEnhanced(e.linkedProfiles));
    // Filter documents by profile
    const filteredDocs = documents.filter(d => matchesProfileEnhanced(d.linkedProfiles));
    // Expirations, from the ONE Date Rule engine (shared/date-rules).
    //
    // This block used to carry its own list of twelve expiry key spellings and
    // `new Date(val)` parsing — a sixth vocabulary, and one that read DOCUMENTS
    // only. A passport expiration typed onto a person was therefore absent from
    // the Executive tab while showing up in Upcoming. The rule engine reads both
    // sources, every spelling, and non-ISO values, so this section now sees
    // exactly what the calendar and the Important Dates screen see.
    const expiringDocs: any[] = [];
    {
      // Scope on the profile AND ITS PARENT, exactly as the calendar block does.
      // Matching the child id alone dropped a nested vehicle's or property's
      // expiration from this tile while the calendar still showed it.
      const scopedProfilesForExp = allProfiles.filter(p =>
        matchesProfileEnhanced([p.id, ...((p as any).parentProfileId ? [(p as any).parentProfileId] : [])]));
      for (const rule of rulesFromAll({ profiles: scopedProfilesForExp, documents: filteredDocs })) {
        // Things that EXPIRE anywhere, plus what a DOCUMENT says is DUE.
        //
        // Expiry alone was too narrow (user report 2026-08-25): a parking
        // citation due in 31 days is exactly the "act before this date" record
        // this tile exists for, and it does not "expire". The source test is
        // what keeps the old bug fixed — a `premiumDueDate` typed onto an
        // insurance PROFILE is a bill and still belongs on the bills surface,
        // so only document-carried due dates join the expiries here.
        if (!isDocumentAttentionRule(rule)) continue;
        const daysUntil = daysBetweenISO(today, rule.date);
        expiringDocs.push({
          documentId: rule.sourceEntityId,
          documentName: rule.label,
          documentType: rule.ruleSubtype || rule.sourceEntityType,
          fieldName: rule.sourceField,
          // The PATH, because the date may live in a nested group. "Renewed — set
          // new date" writes this key back: given only the leaf it added a new
          // top-level one and left the stale nested date in place, so the record
          // then carried two expirations.
          fieldPath: rule.sourcePath,
          expirationDate: rule.date,
          daysUntil,
          ruleId: rule.id,
          // What KIND of date this is, so every surface can say "Due in 31
          // days" where it means due and "Expires" where it means expires,
          // instead of labelling everything an expiration.
          ruleType: rule.ruleType,
          ruleSubtype: rule.ruleSubtype,
          // A rule can come from a PROFILE (a passport expiration typed onto a
          // person), and `/documents/<profileId>` is not a page. The rule
          // already knows where its record lives.
          sourceEntityType: rule.sourceEntityType,
          href: rule.href,
          relatedProfileId: rule.profileId,
          status: daysUntil < 0 ? 'expired' : daysUntil <= 30 ? 'expiring_soon' : daysUntil <= 90 ? 'upcoming' : 'ok',
        });
      }
    }
    expiringDocs.sort((a, b) => a.daysUntil - b.daysUntil);

    const selfProfile = allProfiles.find(p => p.type === 'self');
    const selfId = selfProfile?.id;
    const targetProfileId = (fpIds && fpIds.length > 0) ? fpIds[0] : selfId;
    const healthCategories = ['health', 'fitness', 'weight', 'sleep', 'blood_pressure', 'running', 'exercise', 'nutrition', 'wellness'];
    // Health trackers: already filtered by profile above — just filter by health category.
    const healthTrackers = allTrackers.filter(t => {
      const isHealthCategory = healthCategories.some(c => t.category.toLowerCase().includes(c) || t.name.toLowerCase().includes(c));
      if (!isHealthCategory) return false;
      // When profile filter active, allTrackers is already scoped. When no filter, show self's.
      if (fpIds && fpIds.length > 0) return true;
      if (targetProfileId && t.linkedProfiles.includes(targetProfileId)) return true;
      return false;
    });
    const healthSnapshot: any[] = [];
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const t of healthTrackers) {
      const primaryField = t.fields.find((f: any) => f.isPrimary) || t.fields[0];
      if (!primaryField) continue;
      // BUG (user report: "Bob has weight data but Health says no data"): only
      // the last 7 days were considered, so a tracker whose entries are older
      // was silently dropped and the section claimed "No health data yet".
      // Fall back to the most recent entries so the latest known value always
      // shows (with its real lastEntry date); the 7-day window still drives
      // the trend when fresh data exists.
      const last7 = t.entries.filter(e => new Date(e.timestamp).getTime() >= sevenDaysAgoMs);
      const recent = last7.length > 0 ? last7 : t.entries.slice(-5);
      if (recent.length === 0) continue;
      const values = recent.map(e => Number(e.values[primaryField.name])).filter(v => !isNaN(v));
      if (values.length === 0) continue;
      const latest = values[values.length - 1];
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const trend = values.length >= 2 ? (values[values.length - 1] - values[0]) : 0;
      // For hydration trackers, calculate today's total
      const isHydration = t.name.toLowerCase().includes('hydration') || t.name.toLowerCase().includes('water');
      const todayStr = getUserToday(this._timezone); // the user's zone, not a hardcoded one
      let dailyTotal: number | undefined;
      if (isHydration) {
        // The entry timestamp is a UTC instant; compare its calendar day in
        // the user's zone, not its ISO prefix (which is the UTC day — every
        // glass logged after 5 pm Pacific counted toward TOMORROW).
        dailyTotal = hydrationDailyTotal(t.entries, primaryField.name, todayStr, this._timezone);
      }
      healthSnapshot.push({ trackerId: t.id, name: t.name, category: t.category, unit: primaryField.unit || t.unit || '', latestValue: latest, average: Math.round(avg * 10) / 10, trend: trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat', trendValue: Math.round(Math.abs(trend) * 10) / 10, entryCount: recent.length, lastEntry: recent[recent.length - 1]?.timestamp, dailyTotal });
    }

    const monthlyExpenses = allExpenses.filter(e => (e.date || '').slice(0, 7) === userYearMonth);
    // Keyed like the budget caps (budgetCategoryKey): the finance page reads a
    // cap's spending straight out of this map by the cap's category.
    const spendByCategory = spendByCategoryOf(monthlyExpenses);
    const totalMonthlySpend = monthlyExpenses.reduce((s, e) => s + e.amount, 0);

    // Previous month YYYY-MM, computed in the user's timezone
    const [yStr, mStr] = userYearMonth.split('-');
    const prevMonthIndex = parseInt(mStr, 10) - 2; // 0-indexed previous month
    const prevYear = prevMonthIndex < 0 ? parseInt(yStr, 10) - 1 : parseInt(yStr, 10);
    const prevMonth = ((prevMonthIndex % 12) + 12) % 12;
    const lastMonthYM = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}`;
    const lastMonthExpenses = allExpenses.filter(e => (e.date || '').slice(0, 7) === lastMonthYM);
    const lastMonthTotal = lastMonthExpenses.reduce((s, e) => s + e.amount, 0);

    const upcomingBills = allObligations.filter(o => isUpcomingBill(o, now)).sort((a, b) => new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime()).map(o => {
      // Whole calendar days between the user's today and the due DATE — no
      // instants. `new Date("YYYY-MM-DD")` is UTC midnight, so a bill due
      // today read as "overdue" from 5 pm Pacific onward.
      const daysUntil = calendarDaysUntil(o.nextDueDate, today, this._timezone);
      return {
        id: o.id, name: o.name, amount: o.amount, dueDate: o.nextDueDate, daysUntil,
        autopay: o.autopay, category: o.category,
        // Bills-as-liabilities: each bill is backed by a liability record; the
        // Bills popup deep-links to it and shows the lifecycle status.
        linkedLiabilityId: (o as any).linkedLiabilityId || null,
        status: daysUntil < 0 ? "overdue" : daysUntil === 0 ? "due_today" : "upcoming",
      };
    });

    // BUG-20260528-monthly-multipliers: unify to exact 52/12, 26/12 via shared toMonthlyAmount.
    // Skip paused/cancelled so this matches the Cash Flow popup's recurring-out
    // (the hero tile now renders Out from this same number — user report: tile
    // said "Out $0" while the popup said "Out $1,020").
    const monthlyObligationTotal = allObligations.reduce(
      (s, o) => isActiveObligation(o) ? s + toMonthlyAmount(o.amount, o.frequency) : s,
      0,
    );

    // Calendar days in the user's zone: `new Date("YYYY-MM-DD") < now` listed a
    // task due TODAY as overdue on the dashboard widget for the whole day.
    const overdueTasks = allTasks.filter(t => { if (t.status === 'done' || !t.dueDate) return false; const dueDay = localDayOf(t.dueDate, this._timezone); return !!dueDay && dueDay < today; }).map(t => ({ id: t.id, title: t.title, dueDate: t.dueDate!, priority: t.priority }));

    // BUG-NW-2/3 fix (2026-06-03): build asset / liability breakdown arrays here
    // so the Net Worth popup never recomputes its own per-row math. The popup
    // renders these arrays directly and the rows always sum to the total.
    // `subscription` is intentionally excluded from assetBreakdown.
    // Source of truth: shared/asset-value.ts. Do NOT inline a local copy of
    // these type sets — drift here silently desyncs dashboard net worth.
    const noFilterBreak = !fpIds || fpIds.length === 0;
    // Ownership share for the selected filter, via the shared model. An item
    // with explicit owner links is attributed to those owners; an item with NO
    // explicit owners is implicitly the main user's (Self owns 100%) — so
    // filtering to the primary user shows everything that isn't explicitly
    // someone else's, which is the intended behavior. To attribute an item to
    // another person, give it an explicit owner. Selecting the asset/liability
    // profile itself = full value.
    const shareForAsset = (p: any): number => {
      if (noFilterBreak) return 100;
      if (fpIds!.includes(p.id)) return 100;
      return shareForParties(fpIds!, assetLinksByAsset.get(p.id), selfId);
    };
    const shareForLiability = (p: any): number => {
      if (noFilterBreak) return 100;
      if (fpIds!.includes(p.id)) return 100;
      return shareForParties(fpIds!, liabLinksByLiability.get(p.id), selfId);
    };
    const assetBreakdown: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }> = [];
    for (const p of allProfiles) {
      if (!isAssetProfile(p)) continue;
      const gross = resolveAssetValue(p.fields);
      if (gross <= 0) continue;
      const share = shareForAsset(p);
      if (share <= 0) continue;
      assetBreakdown.push({ id: p.id, name: p.name, type: p.type, grossValue: gross, share, value: gross * share / 100 });
    }
    assetBreakdown.sort((a, b) => b.value - a.value);
    const liabilityBreakdown: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }> = [];
    for (const p of allProfiles) {
      // Only real balance-sheet debt. Recurring service bills (utility/streaming/
      // phone) are tracked as liabilities for Bills/Cash Flow but excluded from the
      // Net Worth debt total (user decision: "only real debt counts").
      if (!isNetWorthLiabilityProfile(p)) continue;
      const gross = resolveLiabilityValue(p.fields);
      if (gross <= 0) continue;
      const share = shareForLiability(p);
      if (share <= 0) continue;
      liabilityBreakdown.push({ id: p.id, name: p.name, type: p.type, grossValue: gross, share, value: gross * share / 100 });
    }
    liabilityBreakdown.sort((a, b) => b.value - a.value);

    // A recurring event happens today when today is one of its occurrences,
    // not only on the day it was created (a daily standup never appeared).
    const todaysEvents = allEvents.filter(e => eventOccursOn(e as any, today)).map(e => ({ id: e.id, title: e.title, time: e.time, endTime: e.endTime, category: e.category, location: e.location }));

    return {
      expiringDocuments: expiringDocs.filter(d => d.status !== 'ok'),
      healthSnapshot,
      financeSnapshot: {
        totalMonthlySpend, lastMonthTotal,
        spendTrend: lastMonthTotal > 0 ? Math.round(((totalMonthlySpend - lastMonthTotal) / lastMonthTotal) * 100) : (totalMonthlySpend > 0 ? 100 : 0),
        spendByCategory, upcomingBills,
        monthlyObligationTotal,
        totalAssetValue: (() => {
          // Asset profiles: vehicles, real estate, investments, accounts, generic assets, even loans
          // (a loan profile may carry the asset's market value separately from its remaining balance).
          // BUG-NW-1 fix (2026-06-03): `subscription` removed — subscriptions are recurring expenses,
          // never balance-sheet items. They were leaking $cost into Net Worth via resolveAssetValue's
          // fields.cost candidate path.
          // Same ownership-share rule as assetBreakdown (shared model) — keep
          // the total and the per-row breakdown in lockstep.
          return allProfiles.reduce((s, p) => {
            if (!isAssetProfile(p)) return s;
            const share = shareForAsset(p);
            if (share <= 0) return s;
            return s + (resolveAssetValue(p.fields) * share / 100);
          }, 0);
        })(),
        // Liabilities: profiles carrying a loan/remaining balance (financed cars, mortgages,
        // explicit loans). Obligations (recurring bills) are intentionally excluded — they are
        // monthly cash-flow items, not balance-sheet liabilities.
        //
        // Scope tightening: only iterate profile types that can actually
        // carry a balance (loan / vehicle / property / asset / account).
        // The previous version walked EVERY profile (including persons and
        // pets) and ran the liability resolver on whatever fields they had,
        // which could double-count fields named things like `balance` or
        // `amount` that aren't really debts.
        totalLiabilities: (() => {
          // 'liability' is the new canonical type (Phase 1+); 'loan' is the legacy
          // alias kept around for any rows that haven't been migrated yet.
          // Recurring service bills are excluded here (isNetWorthLiabilityProfile)
          // — they are monthly cash-flow items, not balance-sheet debt.
          // Same ownership-share rule as liabilityBreakdown (shared model).
          return allProfiles.reduce((s, p) => {
            if (!isNetWorthLiabilityProfile(p)) return s;
            const share = shareForLiability(p);
            if (share <= 0) return s;
            return s + (resolveLiabilityValue(p.fields) * share / 100);
          }, 0);
        })(),
        assetBreakdown,
        liabilityBreakdown,
        recentExpenses: allExpenses.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 5).map(e => ({ id: e.id, description: e.description, amount: e.amount, date: e.date, category: e.category })),
        monthlyExpenseRecords: monthlyExpenses.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).map(e => ({ id: e.id, description: e.description, amount: e.amount, date: e.date, category: e.category, vendor: e.vendor })),
      },
      overdueTasks,
      todaysEvents,
      totalDocuments: filteredDocs.length,
    };
  }

  // ============================================================
  // NET-WORTH SNAPSHOTS (W4-5)
  // ============================================================
  // Compute and persist today's net worth. One row per profile passed in plus
  // one aggregate row (profile_id NULL = "everyone"). Reuses the share-aware,
  // subscription-excluding math in getDashboardEnhanced — no re-implementation.
  // Upsert semantics: one row per (user, profile-or-aggregate, day); a second
  // call the same day overwrites rather than duplicating.
  async takeNetWorthSnapshot(profileIds?: string[]): Promise<Array<{ profileId: string | null; assetsTotal: number; liabilitiesTotal: number; netWorth: number; snapshotDate: string }>> {
    const snapshotDate = getUserToday(this._timezone);
    const targets: Array<string | null> = [null, ...((profileIds || []).filter(Boolean))];
    const rows: Array<{ profileId: string | null; assetsTotal: number; liabilitiesTotal: number; netWorth: number; snapshotDate: string }> = [];
    for (const pid of targets) {
      const enhanced = await this.getDashboardEnhanced(undefined, pid ? [pid] : undefined);
      const fin = (enhanced && (enhanced as any).financeSnapshot) || {};
      const assetsTotal = Number(fin.totalAssetValue || 0);
      const liabilitiesTotal = Number(fin.totalLiabilities || 0);
      const netWorth = assetsTotal - liabilitiesTotal;
      // Expression unique index (COALESCE(profile_id, sentinel)) can't be named
      // in onConflict, so resolve the existing row by hand then update/insert.
      let q = this.supabase.from("net_worth_snapshots")
        .select("id").eq("user_id", this.userId).eq("snapshot_date", snapshotDate);
      q = pid ? q.eq("profile_id", pid) : q.is("profile_id", null);
      const { data: existing } = await q.maybeSingle();
      if (existing?.id) {
        await this.supabase.from("net_worth_snapshots")
          .update({ assets_total: assetsTotal, liabilities_total: liabilitiesTotal, net_worth: netWorth })
          .eq("id", existing.id);
      } else {
        await this.supabase.from("net_worth_snapshots").insert({
          user_id: this.userId, profile_id: pid, snapshot_date: snapshotDate,
          assets_total: assetsTotal, liabilities_total: liabilitiesTotal, net_worth: netWorth,
        });
      }
      rows.push({ profileId: pid, assetsTotal, liabilitiesTotal, netWorth, snapshotDate });
    }
    return rows;
  }

  // Read snapshot history for a profile (or the aggregate when profileId is
  // omitted) within the lookback window, newest first.
  // `profileIds`: none → the aggregate rows (profile_id NULL); one → that
  // profile's own rows; several → the per-profile rows summed by day. A
  // multi-profile selection used to fall back to the aggregate, so "Self +
  // Linda" drew the whole account's trend (a third person's holdings
  // included) under a header that showed only the two of them. Per-profile
  // rows carry each owner's share (takeNetWorthSnapshot reuses the share-aware
  // dashboard math), so their sum is the selection's total.
  async getNetWorthHistory(profileIds?: string | string[], lookbackDays: number = 1): Promise<Array<{ snapshotDate: string; assetsTotal: number; liabilitiesTotal: number; netWorth: number }>> {
    const ids = (Array.isArray(profileIds) ? profileIds : profileIds ? [profileIds] : []).filter(Boolean);
    const today = getUserToday(this._timezone);
    const since = tzAddDays(today, -Math.max(1, lookbackDays));
    let q = this.supabase.from("net_worth_snapshots")
      .select("snapshot_date, profile_id, assets_total, liabilities_total, net_worth")
      .eq("user_id", this.userId)
      .gte("snapshot_date", since);
    q = ids.length === 0 ? q.is("profile_id", null) : ids.length === 1 ? q.eq("profile_id", ids[0]) : q.in("profile_id", ids);
    const { data, error } = await q.order("snapshot_date", { ascending: false });
    if (error) throw error;
    const byDay = new Map<string, { snapshotDate: string; assetsTotal: number; liabilitiesTotal: number; netWorth: number }>();
    for (const r of data || []) {
      const day = String(r.snapshot_date);
      const row = byDay.get(day) || { snapshotDate: day, assetsTotal: 0, liabilitiesTotal: 0, netWorth: 0 };
      row.assetsTotal += Number(r.assets_total || 0);
      row.liabilitiesTotal += Number(r.liabilities_total || 0);
      row.netWorth += Number(r.net_worth || 0);
      byDay.set(day, row);
    }
    return Array.from(byDay.values()).sort((a, b) => (a.snapshotDate < b.snapshotDate ? 1 : a.snapshotDate > b.snapshotDate ? -1 : 0));
  }

  // ============================================================
  // INSIGHTS
  // ============================================================
  async getInsights(filterProfileId?: string): Promise<Insight[]> {
    // [P0] Serve from the module-level per-user cache (60s TTL) — see the
    // comment block above insightsCache. Keyed per profile-filter so a scoped
    // request can never leak another scope's cached result.
    const cacheKey = `${this.userId}:${filterProfileId || "all"}`;
    const hit = insightsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < INSIGHTS_CACHE_TTL_MS) return hit.insights;

    // PERF: fetch all seven inputs in parallel — this was 7 sequential
    // round trips before. getProfilesLite() is safe here because
    // generateInsights() never reads any per-profile field (verified: the
    // profiles argument is unused inside the function).
    const [profiles, allTrackers, allTasks, allExpenses, allHabits, allObligations, journal] = await Promise.all([
      this.getProfilesLite(),
      this.getTrackers(),
      this.getTasks(),
      this.getExpenses(),
      this.getHabits(),
      this.getObligations(),
      this.getJournalEntries(),
    ]);
    // Strict profile filter — no orphan fallback
    const fp = filterProfileId;
    const matchFp = (lp: string[]) => {
      if (!fp) return true;
      return lp.includes(fp);
    };
    const trackers = allTrackers.filter(t => matchFp(t.linkedProfiles));
    const tasks = allTasks.filter(t => matchFp(t.linkedProfiles));
    const expenses = allExpenses.filter(e => matchFp(e.linkedProfiles));
    const habits = allHabits.filter(h => matchFp(h.linkedProfiles || []));
    const obligations = allObligations.filter(o => matchFp(o.linkedProfiles));
    const insights = generateInsights(profiles, trackers, tasks, expenses, habits, obligations, journal);
    // Bound the map so a many-user warm instance can't grow it unboundedly.
    if (insightsCache.size > 1000) insightsCache.clear();
    insightsCache.set(cacheKey, { at: Date.now(), insights });
    return insights;
  }

  // ============================================================
  // SEARCH
  // ============================================================
  async search(query: string): Promise<any[]> {
    const q = query.toLowerCase();
    const results: any[] = [];
    // Helper: safe lowercase includes check (handles null/undefined fields)
    const has = (val: any) => val && typeof val === 'string' && val.toLowerCase().includes(q);
    const tagsMatch = (tags: any) => Array.isArray(tags) && tags.some(t => has(t));

    // PERF: Fetch all top-level tables in parallel instead of 9 sequential awaits.
    // Previously this was ~9 round trips taking ~90–300ms each before any
    // filtering even started.
    const [profiles, trackers, tasks, expenses, habits, obligations, artifacts, journal, memories, events, documents] = await Promise.all([
      this.getProfiles(),
      this.getTrackers(),
      this.getTasks(),
      this.getExpenses(),
      this.getHabits(),
      this.getObligations(),
      this.getArtifacts(),
      this.getJournalEntries(),
      this.getMemories(),
      // Events and documents were never searched at all: the command palette
      // has had "Events" and "Documents" groups all along, and the API simply
      // never produced a row for them. A user searching "dentist" found the
      // task and not the appointment.
      this.getEvents().catch(() => [] as any[]),
      this.getDocuments().catch(() => [] as any[]),
    ]);

    for (const p of profiles) {
      if (has(p.name) || has(p.type) || tagsMatch(p.tags)) results.push({ ...p, _type: "profile" });
    }
    for (const t of trackers) {
      if (has(t.name) || has(t.category)) results.push({ ...t, _type: "tracker" });
    }
    for (const t of tasks) {
      if (has(t.title) || tagsMatch(t.tags)) results.push({ ...t, _type: "task" });
    }
    for (const e of expenses) {
      if (has(e.description) || has(e.category) || has(e.vendor)) results.push({ ...e, _type: "expense" });
    }
    for (const h of habits) {
      if (has(h.name)) results.push({ ...h, _type: "habit" });
    }
    for (const o of obligations) {
      if (has(o.name) || has(o.category)) results.push({ ...o, _type: "obligation" });
    }
    for (const a of artifacts) {
      if (has(a.title) || has(a.content) || tagsMatch(a.tags)) results.push({ ...a, _type: "artifact" });
    }
    for (const j of journal) {
      if (has(j.content) || tagsMatch(j.tags)) results.push({ ...j, _type: "journal" });
    }
    for (const m of memories) {
      if (has(m.key) || has(m.value)) results.push({ ...m, _type: "memory" });
    }
    for (const ev of events as any[]) {
      if (has(ev.title) || has(ev.description) || has(ev.location) || has(ev.category)) results.push({ ...ev, _type: "event" });
    }
    for (const d of documents as any[]) {
      // Never match on file contents/base64 — name, category, type and tags only.
      if (has(d.name) || has(d.title) || has(d.category) || has(d.type) || tagsMatch(d.tags)) {
        const { content, fileData, data, ...rest } = d;
        results.push({ ...rest, _type: "document" });
      }
    }

    // Enhance with entity links — limit to first 10 results to avoid N+1 explosion.
    // Pre-build lookup maps from the already-fetched tables so we don't
    // re-query them for every linked entity (the previous version called
    // getExpenses() inside the inner loop, plus a fresh round trip per link).
    const profileById = new Map(profiles.map(p => [p.id, p]));
    const trackerById = new Map(trackers.map(t => [t.id, t]));
    const taskById = new Map(tasks.map(t => [t.id, t]));
    const habitById = new Map(habits.map(h => [h.id, h]));
    const obligationById = new Map(obligations.map(o => [o.id, o]));
    const expenseById = new Map(expenses.map(e => [e.id, e]));

    const enrichSlice = results.slice(0, 10);
    const existingIds = new Set(results.map((r: any) => r.id));

    // Fetch all entity-link rows for the enrich slice in parallel.
    const linkBatches = await Promise.all(
      enrichSlice.map(r => (r._type && r.id) ? this.getEntityLinks(r._type, r.id).catch(() => []) : Promise.resolve([])),
    );

    // Collect IDs we still need to fetch (events/documents aren't bulk-fetched
    // above), grouped by type, then fetch each type's batch concurrently.
    const needed = { event: new Set<string>(), document: new Set<string>() };
    const linkRefs: { result: any; otherType: string; otherId: string; link: any }[] = [];
    enrichSlice.forEach((result, i) => {
      const links = linkBatches[i] || [];
      for (const link of links) {
        const otherType = (link.sourceType === result._type && link.sourceId === result.id) ? link.targetType : link.sourceType;
        const otherId = (link.sourceType === result._type && link.sourceId === result.id) ? link.targetId : link.sourceId;
        if (!otherId || existingIds.has(otherId)) continue;
        existingIds.add(otherId);
        linkRefs.push({ result, otherType, otherId, link });
        if (otherType === "event") needed.event.add(otherId);
        else if (otherType === "document") needed.document.add(otherId);
      }
    });

    const [eventEntities, documentEntities] = await Promise.all([
      needed.event.size > 0
        ? Promise.all([...needed.event].map(id => this.getEvent(id).catch(() => null)))
        : Promise.resolve([] as any[]),
      needed.document.size > 0
        // PERF: metadata-only reads — the old getDocument() here downloaded and
        // base64-encoded every linked file just to strip it out on the next line.
        ? Promise.all([...needed.document].map(id => this.getDocumentMeta(id).catch(() => null).then(d => d ?? null)))
        : Promise.resolve([] as any[]),
    ]);
    const eventById = new Map<string, any>();
    for (const e of eventEntities) if (e && e.id) eventById.set(e.id, e);
    const documentById = new Map<string, any>();
    for (const d of documentEntities) if (d && d.id) documentById.set(d.id, d);

    for (const ref of linkRefs) {
      let entity: any = null;
      switch (ref.otherType) {
        case "profile": entity = profileById.get(ref.otherId) || null; break;
        case "task": entity = taskById.get(ref.otherId) || null; break;
        case "event": entity = eventById.get(ref.otherId) || null; break;
        case "habit": entity = habitById.get(ref.otherId) || null; break;
        case "obligation": entity = obligationById.get(ref.otherId) || null; break;
        case "tracker": entity = trackerById.get(ref.otherId) || null; break;
        case "expense": entity = expenseById.get(ref.otherId) || null; break;
        case "document": {
          const d = documentById.get(ref.otherId);
          if (d) { const { fileData, ...rest } = d; entity = rest; }
          break;
        }
      }
      if (entity) {
        results.push({ ...entity, _type: ref.otherType, _related: true, _relationship: ref.link.relationship, _confidence: ref.link.confidence });
      }
    }

    return results;
  }

  // ============================================================
  // PREFERENCES
  // ============================================================
  async getPreference(key: string): Promise<string | null> {
    // maybeSingle (not single): an absent preference row is the NORMAL case
    // (e.g. a key the user has never set). single() emits PostgREST 406 on zero
    // rows — the harmless-but-noisy error the production log sample flagged.
    const { data } = await this.supabase.from("preferences").select("value").eq("user_id", this.userId).eq("key", key).maybeSingle();
    return data ? data.value : null;
  }

  /**
   * The lock is a preferences row `lock:<name>` whose value is the claim time.
   * (user_id, key) is unique, so of two concurrent claims exactly one insert
   * lands; the loser may still take over a claim older than `ttlMs` (a holder
   * that died) through a conditional update, which is atomic per row.
   */
  async acquireUserLock(name: string, ttlMs: number): Promise<boolean> {
    const key = `lock:${name}`;
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("preferences").insert({ user_id: this.userId, key, value: now });
    if (!error) return true;
    if (!isUniqueViolationError(error)) throw error;
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const { data, error: takeErr } = await this.supabase.from("preferences").update({ value: now })
      .eq("user_id", this.userId).eq("key", key).lt("value", cutoff).select("key");
    if (takeErr) throw takeErr;
    return Array.isArray(data) && data.length > 0;
  }
  async releaseUserLock(name: string): Promise<void> {
    await this.supabase.from("preferences").delete().eq("user_id", this.userId).eq("key", `lock:${name}`);
  }

  async setPreference(key: string, value: string): Promise<void> {
    // Upsert: try update, then insert. maybeSingle — a missing row is the
    // expected insert path, not an error (avoids the 406 that single() raises).
    const { data: existing } = await this.supabase.from("preferences").select("key").eq("user_id", this.userId).eq("key", key).maybeSingle();
    if (existing) {
      await this.supabase.from("preferences").update({ value }).eq("user_id", this.userId).eq("key", key);
    } else {
      await this.supabase.from("preferences").insert({ user_id: this.userId, key, value });
    }
  }

  // ============================================================
  // BUDGETS (stored in preferences table as JSON)
  // ============================================================

  /**
   * The month's raw budget row(s). One row per (user, month) is the rule, but
   * the table has no unique key, so two first writes racing across instances
   * can leave two rows; the extras are merged into the oldest and removed so
   * readers see one list.
   */
  private async readBudgetRow(month: string): Promise<{ id: string | null; value: string | null; list: BudgetEntry[] }> {
    const key = `budget:${budgetMonthOrThrow(month)}`;
    const { data, error } = await this.supabase.from("preferences")
      .select("id, value")
      .eq("user_id", this.userId)
      .eq("key", key)
      .order("id", { ascending: true });
    if (error) throw error;
    const rows: Array<{ id: string; value: string | null }> = data || [];
    const parse = (v: string | null): BudgetEntry[] => { try { const p = JSON.parse(v || "[]"); return Array.isArray(p) ? p : []; } catch { return []; } };
    if (rows.length === 0) return { id: null, value: null, list: [] };
    if (rows.length === 1) return { id: rows[0].id, value: rows[0].value, list: parse(rows[0].value) };
    const merged: BudgetEntry[] = [];
    for (const r of rows) for (const b of parse(r.value)) {
      if (!merged.some((m) => budgetCategoryKey(m.category) === budgetCategoryKey(b.category) && (m.profileId || null) === (b.profileId || null))) merged.push(b);
    }
    const keep = rows[0];
    const value = JSON.stringify(merged);
    await this.supabase.from("preferences").update({ value }).eq("id", keep.id).eq("user_id", this.userId);
    await this.supabase.from("preferences").delete().in("id", rows.slice(1).map((r) => r.id)).eq("user_id", this.userId);
    return { id: keep.id, value, list: merged };
  }

  /**
   * Apply `fn` to the month's list atomically: the write is a compare-and-swap
   * on the row's previous value (the table carries no version column), retried
   * when another writer got in first, behind a per-process lock on the same
   * month. Six caps added at once used to leave one: every request read the
   * empty list and wrote back only its own cap.
   */
  private async mutateBudgets<T>(month: string, fn: (list: BudgetEntry[]) => T | Promise<T>): Promise<T> {
    const lockKey = `${this.userId}:${budgetMonthOrThrow(month)}`;
    const prev = budgetWriteLocks.get(lockKey) || Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    budgetWriteLocks.set(lockKey, prev.then(() => mine));
    await prev;
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        const row = await this.readBudgetRow(month);
        const list = row.list.map((b) => ({ ...b }));
        const out = await fn(list);
        const next = JSON.stringify(list);
        if (next === (row.value ?? "[]") && row.id) return out; // nothing changed
        const key = `budget:${budgetMonthOrThrow(month)}`;
        if (row.id) {
          let q = this.supabase.from("preferences").update({ value: next }).eq("id", row.id).eq("user_id", this.userId);
          q = row.value === null ? q.is("value", null) : q.eq("value", row.value);
          const { data, error } = await q.select("id");
          if (error) throw error;
          if (Array.isArray(data) && data.length > 0) return out;
        } else {
          const { error } = await this.supabase.from("preferences").insert({ user_id: this.userId, key, value: next });
          if (!error) return out;
          if (!/duplicate|unique|23505/i.test(`${(error as any).code} ${(error as any).message}`)) throw error;
        }
        await new Promise((r) => setTimeout(r, 10 + attempt * 25));
      }
      throw new Error(`Budget write for ${month} kept colliding with another writer; try again`);
    } finally {
      release();
      if (budgetWriteLocks.get(lockKey) === prev.then(() => mine)) budgetWriteLocks.delete(lockKey);
    }
  }

  async getBudgets(month: string, profileIds?: string[]): Promise<Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>> {
    // Every budget reader and writer goes through the same month key: "2026-9"
    // used to be stored under its own `budget:2026-9` bucket that no reader
    // (all of which ask for "2026-09") ever showed again.
    let parsed = (await this.readBudgetRow(month)).list;
    // Caps stored before categories were folded ("Groceries") read as their
    // bucket ("food") so every consumer meets the spend the same way.
    parsed = parsed.map(b => ({ ...b, category: budgetCategoryKey(b.category) || String(b.category || "") }));
    if (!profileIds) return parsed;
    // Entries with no profileId are shared/all and always returned; otherwise
    // only entries whose profileId is in the requested set.
    const wanted = new Set(profileIds);
    return parsed.filter(b => !b.profileId || wanted.has(b.profileId));
  }

  async getAllBudgets(): Promise<Record<string, Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>>> {
    const { data, error } = await this.supabase.from("preferences")
      .select("key, value")
      .eq("user_id", this.userId)
      .like("key", "budget:%");
    if (error) throw error;
    const out: Record<string, any[]> = {};
    for (const row of data || []) {
      const month = String(row.key || "").slice("budget:".length);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      try { const parsed = JSON.parse(row.value); if (Array.isArray(parsed)) out[month] = parsed; } catch { /* skip a corrupt month */ }
    }
    return out;
  }

  async setBudgets(month: string, budgets: Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>): Promise<void> {
    // Every Supabase error is thrown. The three budget writers (this, addBudget,
    // updateBudget — which both funnel here) used to discard `error`, so a
    // failed write answered success and the UI showed a cap the DB never got.
    // The routes map a thrown error to a 500 like every other storage write.
    const key = `budget:${budgetMonthOrThrow(month)}`;
    const { data: existing, error: readErr } = await this.supabase.from("preferences")
      .select("id")
      .eq("user_id", this.userId)
      .eq("key", key)
      .maybeSingle();
    if (readErr) throw readErr;
    if (existing) {
      const { error } = await this.supabase.from("preferences")
        .update({ value: JSON.stringify(budgets) })
        .eq("id", existing.id)
        .eq("user_id", this.userId);
      if (error) throw error;
    } else {
      const { error } = await this.supabase.from("preferences").insert({
        user_id: this.userId,
        key,
        value: JSON.stringify(budgets),
      });
      if (error) throw error;
    }
  }

  async addBudget(month: string, category: string, amount: number, notes?: string, profileId?: string): Promise<{id: string; category: string; amount: number; notes?: string; profileId?: string}> {
    // One cap per (category, owner) bucket, with the category folded to the
    // expense canon so the cap meets the spend (shared/budget-ledger.ts).
    return this.mutateBudgets(month, (list) => ({ ...upsertBudget(list, { category, amount, notes, profileId }, () => crypto.randomUUID()) }));
  }

  async updateBudget(month: string, budgetId: string, updates: {amount?: number; category?: string; notes?: string | null; profileId?: string}): Promise<boolean> {
    // Throws a 409 when the edit would leave two caps for one bucket.
    return this.mutateBudgets(month, (list) => !!applyBudgetUpdate(list, budgetId, updates));
  }

  async deleteBudget(month: string, budgetId: string): Promise<boolean> {
    return this.mutateBudgets(month, (list) => {
      const idx = list.findIndex(b => b.id === budgetId);
      if (idx === -1) return false;
      list.splice(idx, 1);
      return true;
    });
  }

  async copyBudgetsToMonth(fromMonth: string, toMonth: string): Promise<number> {
    // "Copy last month" adds what the destination lacks and keeps what it
    // already has; it used to replace the destination list, so caps set for
    // next month before the copy were lost. Returns the number added.
    const source = await this.getBudgets(fromMonth);
    if (source.length === 0) return 0;
    return this.mutateBudgets(toMonth, (list) => {
      const { list: merged, added } = mergeBudgetsForCopy(list, source, () => crypto.randomUUID());
      list.splice(0, list.length, ...merged);
      return added;
    });
  }

  // ============================================================
  // PAYCHECKS
  // ============================================================
  // ⚠️  CRITICAL: every query in this section MUST filter by user_id.
  // The server uses the Supabase SERVICE_ROLE_KEY which BYPASSES Row
  // Level Security — so the database will happily return / mutate other
  // users' rows if we don't constrain by user_id ourselves.
  async getPaychecks(): Promise<any[]> {
    const { data } = await this.supabase.from('paychecks').select('*')
      .eq('user_id', this.userId)
      .order('expected_date', { ascending: false });
    return data || [];
  }

  async createPaycheck(paycheck: { source: string; amount: number; expected_date: string; notes?: string }): Promise<any> {
    const { data, error } = await this.supabase.from('paychecks').insert({ ...paycheck, user_id: this.userId }).select().single();
    if (error) throw error;
    return data;
  }

  async confirmPaycheck(id: string, actual_amount?: number): Promise<any> {
    const update: any = { confirmed: true, received_date: getUserToday(this._timezone) };
    if (actual_amount != null) update.actual_amount = actual_amount;
    const { data, error } = await this.supabase.from('paychecks').update(update)
      .eq('id', id).eq('user_id', this.userId).select().single();
    if (error) throw error;
    return data;
  }

  async deletePaycheck(id: string): Promise<boolean> {
    // `.select` so a delete that matched no row (another user's paycheck, a
    // missing id) reports false and the route answers 404 instead of success.
    const { data, error } = await this.supabase.from('paychecks').delete()
      .eq('id', id).eq('user_id', this.userId).select('id');
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }

  // ============================================================
  // LOAN AMORTIZATION
  // ============================================================
  // ⚠️  Same RLS-bypass concern as PAYCHECKS — always filter by user_id.
  async getLoanSchedule(loanId: string): Promise<any[]> {
    const { data } = await this.supabase.from('loan_amortization').select('*')
      .eq('loan_id', loanId).eq('user_id', this.userId).order('payment_number');
    return data || [];
  }

  async getAllLoanSchedules(): Promise<any[]> {
    const { data } = await this.supabase.from('loan_amortization').select('*')
      .eq('user_id', this.userId).order('loan_name').order('payment_number');
    return data || [];
  }

  async createLoanSchedule(entries: Array<{ loan_id: string; loan_name: string; payment_number: number; payment_date: string; principal_amount: number; interest_amount: number; total_payment: number; remaining_balance: number }>): Promise<any[]> {
    const withUser = entries.map(e => ({ ...e, user_id: this.userId }));
    const { data, error } = await this.supabase.from('loan_amortization').insert(withUser).select();
    if (error) throw error;
    return data || [];
  }

  async markLoanPayment(id: string): Promise<any> {
    const { data, error } = await this.supabase.from('loan_amortization').update({ paid: true })
      .eq('id', id).eq('user_id', this.userId).select().single();
    if (error) throw error;
    return data;
  }
  async unmarkLoanPayment(loanId: string, match: { paymentNumber?: number | null; paymentDate?: string | null }): Promise<number> {
    // The inverse of markLoanPayment: a retracted ledger payment leaves its
    // amortization row open again, so the row can be marked once more and the
    // cashflow projection counts it as still due. Matched by the payment
    // number the mark stamped into the payment's note, else by the date.
    let q = this.supabase.from('loan_amortization').update({ paid: false })
      .eq('loan_id', loanId).eq('user_id', this.userId).eq('paid', true);
    if (typeof match.paymentNumber === 'number' && Number.isFinite(match.paymentNumber)) q = q.eq('payment_number', match.paymentNumber);
    else if (match.paymentDate) q = q.eq('payment_date', String(match.paymentDate).slice(0, 10));
    else return 0;
    const { data, error } = await q.select('id');
    if (error) throw error;
    return Array.isArray(data) ? data.length : 0;
  }


  // ============================================================
  // CASHFLOW PROJECTIONS
  // ============================================================
  // ⚠️  Same RLS-bypass concern — always filter by user_id.
  async getCashflow(month?: string): Promise<any[]> {
    // The user's month, not the host's UTC month (which is next month for an
    // evening caller west of Greenwich on the last day). The route defaults
    // the same way; the chat tool relies on this default.
    const m = month || getUserCurrentMonth(this._timezone);
    const { data } = await this.supabase.from('cashflow_projections').select('*')
      .eq('month', m).eq('user_id', this.userId).order('week');
    const projections = (data as any[]) || [];

    // Layer in unpaid loan amortization payments scheduled for this month.
    // Previously the cashflow view only read `cashflow_projections`, so the
    // calendar showed loan payments coming due but the cashflow numbers
    // didn't reflect them — making the projection silently wrong by
    // hundreds of dollars/month for any user with a loan.
    try {
      const { data: schedule } = await this.supabase
        .from('loan_amortization')
        .select('*')
        .eq('user_id', this.userId);
      if (Array.isArray(schedule) && schedule.length > 0) {
        // Bucket payments into ISO weeks of `m` (1–5) and sum.
        const monthStart = parseLocalDate(`${m}-01`);
        const nextMonth = new Date(monthStart);
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        const weekTotals = new Map<number, number>();
        for (const row of schedule) {
          if (row.paid) continue;
          const dueRaw = row.due_date || row.payment_date || row.date;
          if (!dueRaw) continue;
          const due = parseLocalDate(String(dueRaw).slice(0, 10));
          if (due < monthStart || due >= nextMonth) continue;
          // Week of month: 1-indexed, capped at 5
          const week = Math.min(5, Math.floor((due.getDate() - 1) / 7) + 1);
          const amt = Number(row.payment || row.amount || row.payment_amount || 0);
          if (!isFinite(amt) || amt === 0) continue;
          weekTotals.set(week, (weekTotals.get(week) || 0) + amt);
        }
        // Merge into existing projection rows (or insert virtual rows).
        for (const [week, total] of weekTotals.entries()) {
          const existing = projections.find(p => p.week === week);
          if (existing) {
            existing.projected_expenses = (Number(existing.projected_expenses) || 0) + total;
            existing.includes_loan_payments = true;
          } else {
            projections.push({
              month: m,
              week,
              projected_income: 0,
              projected_expenses: total,
              actual_income: 0,
              actual_expenses: 0,
              includes_loan_payments: true,
              source: 'loan_amortization',
            });
          }
        }
        projections.sort((a: any, b: any) => (a.week || 0) - (b.week || 0));
      }
    } catch (e: any) {
      console.warn('[cashflow] loan amortization merge failed:', e?.message);
    }

    return projections;
  }

  async upsertCashflow(entry: { month: string; week: number; projected_income?: number; projected_expenses?: number; actual_income?: number; actual_expenses?: number }): Promise<any> {
    const { data, error } = await this.supabase.from('cashflow_projections').upsert({ ...entry, user_id: this.userId }, { onConflict: 'user_id,month,week' }).select().single();
    if (error) throw error;
    return data;
  }

  // ============================================================
  // DELETE ALL USER DATA
  // ============================================================
  /** Every user-scoped table, children before parents, PROFILES LAST.
   *  Exported so tests can diff it against the live schema instead of trusting
   *  a hand-maintained list nobody re-checks. */
  static readonly ALL_USER_TABLES: readonly string[] = [
    // captures — the universal capture layer (added 2026-06); missed by the
    // wipe until 2026-09-03, so "delete all data" left a user's captures behind.
    "captures",
    // Child / link / bookkeeping tables first
    "tracker_entries", "habit_checkins", "domain_entries", "entity_links",
    "event_documents", "extraction_corrections", "liability_payments",
    "liability_asset_links", "liability_profile_links", "asset_party_links",
    "ownership_history", "net_worth_snapshots", "loan_amortization",
    "cashflow_projections", "audit_log", "ai_action_log", "ai_bulk_plans",
    "undo_log", "user_notifications", "chat_artifacts", "chat_idempotency",
    "finance_imports", "finance_sync_runs", "financial_transaction_overrides",
    "financial_transfer_links", "financial_transactions", "financial_accounts",
    "financial_connections", "stripe_account_holders",
    // Standalone data tables
    "expenses", "tasks", "events", "documents", "trackers", "habits",
    "artifacts", "journal_entries", "memories", "goals", "domains",
    "incomes", "paychecks",
    // Settings + caches
    "preferences", "response_cache", "user_data_versions",
    // The profile graph LAST — everything above references it. The old list
    // omitted profiles (and a dozen other tables) entirely, so "delete all my
    // data" left the user's entire profile graph, payment history and
    // ownership records behind.
    "profiles",
  ];

  async deleteAllUserData(): Promise<{ deleted: Record<string, number>; errors: Record<string, string> }> {
    const deleted: Record<string, number> = {};
    const errors: Record<string, string> = {};
    const uid = this.userId;

    // The bytes first: uploaded documents live in the storage bucket under
    // `${userId}/…` and are not rows, so the table sweep below never touched
    // them — "delete all data" left every uploaded file (and its preview)
    // behind. Sweep the user's folder, reporting the count like a table.
    try {
      const bucket = this.supabase.storage.from(DOCUMENTS_BUCKET);
      let removed = 0;
      for (let offset = 0; ; offset += 1000) {
        const { data: files, error: listErr } = await bucket.list(uid, { limit: 1000, offset });
        if (listErr) throw listErr;
        const names = (files || []).map((f: any) => f?.name).filter((n: any) => typeof n === "string" && n.length > 0);
        if (names.length === 0) break;
        const { error: rmErr } = await bucket.remove(names.map((n: string) => `${uid}/${n}`));
        if (rmErr) throw rmErr;
        removed += names.length;
        if (names.length < 1000) break;
      }
      deleted.storage_files = removed;
    } catch (e: any) {
      errors.storage_files = e?.message || String(e);
    }

    for (const table of SupabaseStorage.ALL_USER_TABLES) {
      try {
        const { count, error } = await this.supabase
          .from(table)
          .delete({ count: "exact" })
          .eq("user_id", uid);
        if (error) {
          // LOUD, per table. The old version silently produced no key at all,
          // so the response could not distinguish "0 rows" from "table failed"
          // — for an operation whose whole point is complete erasure.
          errors[table] = error.message;
        } else {
          deleted[table] = count || 0;
        }
      } catch (e: any) {
        errors[table] = e?.message || String(e);
      }
    }

    return { deleted, errors };
  }

  // ============================================================
  // LIABILITIES — links + payments (Phase 1)
  // ============================================================

  private rowToLiabilityAssetLink(r: any): LiabilityAssetLink {
    return {
      id: r.id,
      liabilityProfileId: r.liability_profile_id,
      assetProfileId: r.asset_profile_id,
      ownershipPercentage: Number(r.ownership_percentage ?? 100),
      allocationAmount: r.allocation_amount != null ? Number(r.allocation_amount) : null,
      role: r.role || "collateral",
      notes: r.notes ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private rowToLiabilityProfileLink(r: any): LiabilityProfileLink {
    return {
      id: r.id,
      liabilityProfileId: r.liability_profile_id,
      partyProfileId: r.party_profile_id,
      ownershipPercentage: Number(r.ownership_percentage ?? 100),
      role: r.role,
      notes: r.notes ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private rowToLiabilityPayment(r: any): LiabilityPayment {
    return {
      id: r.id,
      liabilityProfileId: r.liability_profile_id,
      paymentDate: r.payment_date,
      amount: Number(r.amount || 0),
      principalPortion: Number(r.principal_portion || 0),
      interestPortion: Number(r.interest_portion || 0),
      fees: Number(r.fees || 0),
      remainingBalanceAfter: r.remaining_balance_after != null ? Number(r.remaining_balance_after) : null,
      paymentType: r.payment_type || "standard",
      sourceAccount: r.source_account ?? null,
      documentId: r.document_id ?? null,
      notes: r.notes ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async getLiabilityAssetLinks(liabilityProfileId?: string): Promise<LiabilityAssetLink[]> {
    let q = this.supabase.from("liability_asset_links").select("*").eq("user_id", this.userId);
    if (liabilityProfileId) q = q.eq("liability_profile_id", liabilityProfileId);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(r => this.rowToLiabilityAssetLink(r));
  }

  async getLiabilityAssetLinksForAsset(assetProfileId: string): Promise<LiabilityAssetLink[]> {
    const { data, error } = await this.supabase.from("liability_asset_links")
      .select("*").eq("user_id", this.userId).eq("asset_profile_id", assetProfileId);
    if (error) throw error;
    return (data || []).map(r => this.rowToLiabilityAssetLink(r));
  }

  async createLiabilityAssetLink(data: InsertLiabilityAssetLink): Promise<LiabilityAssetLink> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const row = {
      id, user_id: this.userId,
      liability_profile_id: data.liabilityProfileId,
      asset_profile_id: data.assetProfileId,
      ownership_percentage: data.ownershipPercentage ?? 100,
      allocation_amount: data.allocationAmount ?? null,
      role: data.role || "collateral",
      notes: data.notes ?? null,
      created_at: now, updated_at: now,
    };
    const { error } = await this.supabase.from("liability_asset_links").insert(row);
    if (error) throw error;
    try {
      await this.recordOwnershipHistory({
        linkKind: "liability_asset", linkId: id,
        subjectId: data.liabilityProfileId, counterpartyId: data.assetProfileId,
        action: "create", fieldChanged: null, oldValue: null,
        newValue: JSON.stringify({ pct: row.ownership_percentage, role: row.role }),
        changedBy: "user", note: null,
      });
    } catch (e) { /* history is best-effort */ }
    return this.rowToLiabilityAssetLink(row);
  }

  async updateLiabilityAssetLink(id: string, patch: Partial<InsertLiabilityAssetLink>): Promise<LiabilityAssetLink | undefined> {
    const { data: existing } = await this.supabase.from("liability_asset_links")
      .select("*").eq("id", id).eq("user_id", this.userId).single();
    const update: any = { updated_at: new Date().toISOString() };
    if (patch.ownershipPercentage !== undefined) update.ownership_percentage = patch.ownershipPercentage;
    if (patch.allocationAmount !== undefined) update.allocation_amount = patch.allocationAmount;
    if (patch.role !== undefined) update.role = patch.role;
    if (patch.notes !== undefined) update.notes = patch.notes;
    if (patch.assetProfileId !== undefined) update.asset_profile_id = patch.assetProfileId;
    const { data, error } = await this.supabase.from("liability_asset_links")
      .update(update).eq("id", id).eq("user_id", this.userId).select().single();
    if (error) throw error;
    if (existing) {
      try {
        if (patch.ownershipPercentage !== undefined && Number(existing.ownership_percentage) !== Number(patch.ownershipPercentage)) {
          await this.recordOwnershipHistory({
            linkKind: "liability_asset", linkId: id,
            subjectId: existing.liability_profile_id, counterpartyId: existing.asset_profile_id,
            action: "update", fieldChanged: "ownership_percentage",
            oldValue: String(existing.ownership_percentage), newValue: String(patch.ownershipPercentage),
            changedBy: "user", note: null,
          });
        }
        if (patch.role !== undefined && existing.role !== patch.role) {
          await this.recordOwnershipHistory({
            linkKind: "liability_asset", linkId: id,
            subjectId: existing.liability_profile_id, counterpartyId: existing.asset_profile_id,
            action: "update", fieldChanged: "role",
            oldValue: existing.role, newValue: String(patch.role),
            changedBy: "user", note: null,
          });
        }
        if (patch.assetProfileId !== undefined && existing.asset_profile_id !== patch.assetProfileId) {
          await this.recordOwnershipHistory({
            linkKind: "liability_asset", linkId: id,
            subjectId: existing.liability_profile_id, counterpartyId: patch.assetProfileId,
            action: "move", fieldChanged: "asset_profile_id",
            oldValue: existing.asset_profile_id, newValue: String(patch.assetProfileId),
            changedBy: "user", note: null,
          });
        }
      } catch (e) { /* best-effort */ }
    }
    return data ? this.rowToLiabilityAssetLink(data) : undefined;
  }

  async deleteLiabilityAssetLink(id: string): Promise<boolean> {
    const { data: existing } = await this.supabase.from("liability_asset_links")
      .select("*").eq("id", id).eq("user_id", this.userId).single();
    if (!existing) return false;
    const { error } = await this.supabase.from("liability_asset_links")
      .delete().eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    if (existing) {
      try {
        await this.recordOwnershipHistory({
          linkKind: "liability_asset", linkId: id,
          subjectId: existing.liability_profile_id, counterpartyId: existing.asset_profile_id,
          action: "delete", fieldChanged: null,
          oldValue: JSON.stringify({ pct: existing.ownership_percentage, role: existing.role }),
          newValue: null, changedBy: "user", note: null,
        });
      } catch (e) { /* best-effort */ }
    }
    return true;
  }

  async getLiabilityProfileLinks(liabilityProfileId?: string): Promise<LiabilityProfileLink[]> {
    return this.memo(`getLiabilityProfileLinks:${liabilityProfileId || ""}`, async () => {
      let q = this.supabase.from("liability_profile_links").select("*").eq("user_id", this.userId);
      if (liabilityProfileId) q = q.eq("liability_profile_id", liabilityProfileId);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map(r => this.rowToLiabilityProfileLink(r));
    });
  }

  async getLiabilityProfileLinksForParty(partyProfileId: string): Promise<LiabilityProfileLink[]> {
    const { data, error } = await this.supabase.from("liability_profile_links")
      .select("*").eq("user_id", this.userId).eq("party_profile_id", partyProfileId);
    if (error) throw error;
    return (data || []).map(r => this.rowToLiabilityProfileLink(r));
  }

  async createLiabilityProfileLink(data: InsertLiabilityProfileLink): Promise<LiabilityProfileLink> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const row = {
      id, user_id: this.userId,
      liability_profile_id: data.liabilityProfileId,
      party_profile_id: data.partyProfileId,
      ownership_percentage: data.ownershipPercentage ?? 100,
      role: data.role || "owner",
      notes: data.notes ?? null,
      created_at: now, updated_at: now,
    };
    const { error } = await this.supabase.from("liability_profile_links").insert(row);
    if (error) throw error;
    try {
      await this.recordOwnershipHistory({
        linkKind: "liability_party", linkId: id,
        subjectId: data.liabilityProfileId, counterpartyId: data.partyProfileId,
        action: "create", fieldChanged: null, oldValue: null,
        newValue: JSON.stringify({ pct: row.ownership_percentage, role: row.role }),
        changedBy: "user", note: null,
      });
    } catch (e) { /* best-effort */ }
    return this.rowToLiabilityProfileLink(row);
  }

  async updateLiabilityProfileLink(id: string, patch: Partial<InsertLiabilityProfileLink>): Promise<LiabilityProfileLink | undefined> {
    const { data: existing } = await this.supabase.from("liability_profile_links")
      .select("*").eq("id", id).eq("user_id", this.userId).single();
    const update: any = { updated_at: new Date().toISOString() };
    if (patch.ownershipPercentage !== undefined) update.ownership_percentage = patch.ownershipPercentage;
    if (patch.role !== undefined) update.role = patch.role;
    if (patch.notes !== undefined) update.notes = patch.notes;
    const { data, error } = await this.supabase.from("liability_profile_links")
      .update(update).eq("id", id).eq("user_id", this.userId).select().single();
    if (error) throw error;
    if (existing) {
      try {
        if (patch.ownershipPercentage !== undefined && Number(existing.ownership_percentage) !== Number(patch.ownershipPercentage)) {
          await this.recordOwnershipHistory({
            linkKind: "liability_party", linkId: id,
            subjectId: existing.liability_profile_id, counterpartyId: existing.party_profile_id,
            action: "update", fieldChanged: "ownership_percentage",
            oldValue: String(existing.ownership_percentage), newValue: String(patch.ownershipPercentage),
            changedBy: "user", note: null,
          });
        }
        if (patch.role !== undefined && existing.role !== patch.role) {
          await this.recordOwnershipHistory({
            linkKind: "liability_party", linkId: id,
            subjectId: existing.liability_profile_id, counterpartyId: existing.party_profile_id,
            action: "update", fieldChanged: "role",
            oldValue: existing.role, newValue: String(patch.role),
            changedBy: "user", note: null,
          });
        }
      } catch (e) { /* best-effort */ }
    }
    return data ? this.rowToLiabilityProfileLink(data) : undefined;
  }

  async deleteLiabilityProfileLink(id: string): Promise<boolean> {
    const { data: existing } = await this.supabase.from("liability_profile_links")
      .select("*").eq("id", id).eq("user_id", this.userId).single();
    if (!existing) return false;
    const { error } = await this.supabase.from("liability_profile_links")
      .delete().eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    try {
      await this.recordOwnershipHistory({
        linkKind: "liability_party", linkId: id,
        subjectId: existing.liability_profile_id, counterpartyId: existing.party_profile_id,
        action: "delete", fieldChanged: null,
        oldValue: JSON.stringify({ pct: existing.ownership_percentage, role: existing.role }),
        newValue: null, changedBy: "user", note: null,
      });
    } catch (e) { /* best-effort */ }
    await this.redistributeAfterLinkRemoval("liability", String(existing.liability_profile_id));
    return true;
  }

  /**
   * The most recent payments across ALL liabilities.
   *
   * Recent Activity is built from tracker entries, completed tasks and
   * expenses — so recording a payment, one of the most consequential things a
   * person does in this app, never appeared in it at any latency. That is not a
   * caching problem and no invalidation would have fixed it: the feed simply
   * did not read this table. One indexed, bounded query.
   */
  async getRecentLiabilityPayments(limit: number = 10): Promise<LiabilityPayment[]> {
    const { data, error } = await this.supabase.from("liability_payments")
      .select("*").eq("user_id", this.userId)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(50, limit)));
    if (error) throw error;
    return (data || []).map(r => this.rowToLiabilityPayment(r));
  }

  /**
   * Compare-and-set claim of one bill occurrence: stamps `occurrences[date]`
   * (merged over the FRESH row) plus `extraFields`, but only while that
   * occurrence is not already paid. A concurrent second payer gets
   * "already-paid" and the occurrence map as it stands, including the
   * winner's paymentId. Returns the pre-claim occurrences on success so a
   * failed ledger write can release the claim.
   */
  async claimBillOccurrence(
    liabilityId: string,
    occurrenceDate: string,
    stamp: Record<string, any>,
    extraFields: Record<string, any>,
  ): Promise<{ status: "claimed" | "already-paid"; occurrences: Record<string, any> }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate)) throw new Error("occurrenceDate must be YYYY-MM-DD");
    // Optimistic concurrency on the row's updated_at: read the row, write the
    // merged fields only if nobody else has written the row since. A JSON-path
    // condition on the occurrence status was tried first and did not hold
    // under concurrent updates in production; a scalar version token does.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data: fresh, error: readErr } = await this.supabase.from("profiles").select("fields, updated_at")
        .eq("id", liabilityId).eq("user_id", this.userId).maybeSingle();
      if (readErr) throw readErr;
      if (!fresh) throw new Error("Liability not found");
      const f = (fresh.fields && typeof fresh.fields === "object") ? fresh.fields as Record<string, any> : {};
      const prior: Record<string, any> = (f.occurrences && typeof f.occurrences === "object") ? f.occurrences : {};
      if (prior[occurrenceDate]?.status === "paid") return { status: "already-paid", occurrences: prior };
      const occurrences = { ...prior, [occurrenceDate]: { ...(prior[occurrenceDate] || {}), ...stamp } };
      // Same field-merge rule updateProfile applies, so identity/supersession
      // bookkeeping stays consistent with every other write to this row.
      const merged = mergeFieldWrite(f, { ...extraFields, occurrences }).fields;
      const now = new Date().toISOString();
      let q = this.supabase.from("profiles")
        .update({ fields: merged, updated_at: now })
        .eq("id", liabilityId).eq("user_id", this.userId);
      q = fresh.updated_at == null ? q.is("updated_at", null) : q.eq("updated_at", fresh.updated_at);
      const { data, error } = await q.select("id");
      if (error) throw error;
      if (Array.isArray(data) && data.length > 0) {
        bustInsightsCacheFor(this.userId);
        return { status: "claimed", occurrences: prior };
      }
      // Someone wrote the row between our read and our write — re-read: if
      // that write paid this occurrence we lost; otherwise retry the claim.
    }
    const { data: again } = await this.supabase.from("profiles").select("fields").eq("id", liabilityId).eq("user_id", this.userId).maybeSingle();
    const occ = (again?.fields as any)?.occurrences;
    return { status: "already-paid", occurrences: (occ && typeof occ === "object") ? occ : {} };
  }

  async getLiabilityPayments(liabilityProfileId: string): Promise<LiabilityPayment[]> {
    const { data, error } = await this.supabase.from("liability_payments")
      .select("*").eq("user_id", this.userId).eq("liability_profile_id", liabilityProfileId)
      .order("payment_date", { ascending: false });
    if (error) throw error;
    return (data || []).map(r => this.rowToLiabilityPayment(r));
  }

  async getLiabilityPayment(id: string): Promise<LiabilityPayment | undefined> {
    const { data, error } = await this.supabase.from("liability_payments")
      .select("*").eq("id", id).eq("user_id", this.userId).maybeSingle();
    if (error || !data) return undefined;
    return this.rowToLiabilityPayment(data);
  }

  async createLiabilityPayment(data: InsertLiabilityPayment): Promise<LiabilityPayment> {
    const now = new Date().toISOString();
    // A caller may preset the id (payBillOccurrence stamps the occurrence with
    // it BEFORE inserting the row, so a concurrent duplicate can be detected).
    const presetId = (data as any).id;
    const id = typeof presetId === "string" && /^[0-9a-f-]{36}$/i.test(presetId) ? presetId : randomUUID();
    const row = {
      id, user_id: this.userId,
      liability_profile_id: data.liabilityProfileId,
      payment_date: data.paymentDate,
      amount: data.amount,
      principal_portion: data.principalPortion ?? 0,
      interest_portion: data.interestPortion ?? 0,
      fees: data.fees ?? 0,
      remaining_balance_after: data.remainingBalanceAfter ?? null,
      payment_type: data.paymentType || "standard",
      source_account: data.sourceAccount ?? null,
      document_id: data.documentId ?? null,
      notes: data.notes ?? null,
      created_at: now, updated_at: now,
    };
    const { error } = await this.supabase.from("liability_payments").insert(row);
    if (error) throw error;
    return this.rowToLiabilityPayment(row);
  }

  async updateLiabilityPayment(id: string, data: Partial<InsertLiabilityPayment>): Promise<LiabilityPayment | undefined> {
    const patch: any = { updated_at: new Date().toISOString() };
    if (data.paymentDate !== undefined) patch.payment_date = data.paymentDate;
    if (data.amount !== undefined) patch.amount = data.amount;
    if (data.principalPortion !== undefined) patch.principal_portion = data.principalPortion;
    if (data.interestPortion !== undefined) patch.interest_portion = data.interestPortion;
    if (data.fees !== undefined) patch.fees = data.fees;
    if (data.remainingBalanceAfter !== undefined) patch.remaining_balance_after = data.remainingBalanceAfter;
    if (data.paymentType !== undefined) patch.payment_type = data.paymentType;
    if (data.sourceAccount !== undefined) patch.source_account = data.sourceAccount;
    if (data.documentId !== undefined) patch.document_id = data.documentId;
    if (data.notes !== undefined) patch.notes = data.notes;
    const { error } = await this.supabase.from("liability_payments")
      .update(patch).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    const { data: row } = await this.supabase.from("liability_payments")
      .select("*").eq("id", id).eq("user_id", this.userId).single();
    return row ? this.rowToLiabilityPayment(row) : undefined;
  }

  async deleteLiabilityPayment(id: string): Promise<boolean> {
    // Returns true iff a row was actually deleted. Without `.select()` the
    // Supabase client returns no rows and the route was reporting success even
    // when the id didn't exist (RLS denial looks the same to callers).
    const { data, error } = await this.supabase.from("liability_payments")
      .delete().eq("id", id).eq("user_id", this.userId).select();
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }

  // ============================================================
  // ASSET ↔ PARTY LINKS + OWNERSHIP HISTORY (Relationships module)
  // ============================================================

  private rowToAssetPartyLink(r: any): AssetPartyLink {
    return {
      id: r.id,
      assetProfileId: r.asset_profile_id,
      partyProfileId: r.party_profile_id,
      ownershipPercentage: Number(r.ownership_percentage ?? 100),
      role: r.role || "owner",
      effectiveFrom: r.effective_from ?? null,
      effectiveTo: r.effective_to ?? null,
      notes: r.notes ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private rowToOwnershipHistory(r: any): OwnershipHistoryEntry {
    return {
      id: r.id,
      linkKind: r.link_kind,
      linkId: r.link_id ?? null,
      subjectId: r.subject_id ?? null,
      counterpartyId: r.counterparty_id ?? null,
      action: r.action,
      fieldChanged: r.field_changed ?? null,
      oldValue: r.old_value ?? null,
      newValue: r.new_value ?? null,
      changedBy: r.changed_by || "user",
      note: r.note ?? null,
      changedAt: r.changed_at,
    };
  }

  async getAssetPartyLinks(assetProfileId?: string): Promise<AssetPartyLink[]> {
    return this.memo(`getAssetPartyLinks:${assetProfileId || ""}`, async () => {
      let q = this.supabase.from("asset_party_links").select("*").eq("user_id", this.userId);
      if (assetProfileId) q = q.eq("asset_profile_id", assetProfileId);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map((r: any) => this.rowToAssetPartyLink(r));
    });
  }

  async getAssetPartyLinksForParty(partyProfileId: string): Promise<AssetPartyLink[]> {
    const { data, error } = await this.supabase.from("asset_party_links")
      .select("*").eq("user_id", this.userId).eq("party_profile_id", partyProfileId);
    if (error) throw error;
    return (data || []).map((r: any) => this.rowToAssetPartyLink(r));
  }

  // NW-7: ownership-share-aware asset/liability value for a single profile,
  // mirroring the assetBreakdown / shareForAsset math in getDashboardEnhanced.
  // Chat read tools must report a profile's RESIDUAL share of co-owned items
  // (e.g. Bob's 50% of a $350k Home = $175k), not the gross value in fields.
  async getProfileAssetValue(profileId: string): Promise<{
    assetValue: number; liabilityValue: number; netValue: number;
    assets: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }>;
    liabilities: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }>;
  }> {
    const [allProfiles, allAssetLinks, allLiabLinks] = await Promise.all([
      this.getProfiles(),
      this.getAssetPartyLinks().catch(() => [] as any[]),
      this.getLiabilityProfileLinks().catch(() => [] as any[]),
    ]);
    // Explicit ownership links keyed by the item (asset/liability) id, in the
    // shape the shared ownership-model consumes. Single source of truth:
    // explicit owners win; with none, Self owns 100% (nesting is NOT ownership).
    const selfId = allProfiles.find(p => p.type === 'self')?.id || null;
    const assetLinksByAsset = new Map<string, OwnershipLink[]>();
    for (const l of (allAssetLinks as any[]) || []) {
      const aid = (l as any).assetProfileId; const pid = (l as any).partyProfileId;
      if (!aid || !pid) continue;
      if (!assetLinksByAsset.has(aid)) assetLinksByAsset.set(aid, []);
      assetLinksByAsset.get(aid)!.push({ partyProfileId: pid, ownershipPercentage: Number((l as any).ownershipPercentage ?? 100), role: (l as any).role });
    }
    const liabLinksByLiability = new Map<string, OwnershipLink[]>();
    for (const l of (allLiabLinks as any[]) || []) {
      const lid = (l as any).liabilityProfileId; const pid = (l as any).partyProfileId;
      if (!lid || !pid) continue;
      if (!liabLinksByLiability.has(lid)) liabLinksByLiability.set(lid, []);
      liabLinksByLiability.get(lid)!.push({ partyProfileId: pid, ownershipPercentage: Number((l as any).ownershipPercentage ?? 100), role: (l as any).role });
    }
    // Source of truth: shared/asset-value.ts. Do NOT inline a local copy of
    // these type sets — drift here silently desyncs dashboard net worth.
    // This profile's ownership share of an item: the item itself = 100%; else
    // the profile's explicit ownership %, or 100% if it's Self and the item has
    // no explicit owners.
    const shareForItem = (p: any, links: Map<string, OwnershipLink[]>): number => {
      if (p.id === profileId) return 100;
      return shareForParties([profileId], links.get(p.id), selfId);
    };
    const assets: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }> = [];
    for (const p of allProfiles) {
      if (!isAssetProfile(p)) continue;
      const gross = resolveAssetValue(p.fields);
      if (gross <= 0) continue;
      const share = shareForItem(p, assetLinksByAsset);
      if (share <= 0) continue;
      assets.push({ id: p.id, name: p.name, type: p.type, grossValue: gross, share, value: Math.round(gross * share) / 100 });
    }
    const liabilities: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }> = [];
    for (const p of allProfiles) {
      // Recurring service bills are not balance-sheet debt — exclude from net worth.
      if (!isNetWorthLiabilityProfile(p)) continue;
      const gross = resolveLiabilityValue(p.fields);
      if (gross <= 0) continue;
      const share = shareForItem(p, liabLinksByLiability);
      if (share <= 0) continue;
      liabilities.push({ id: p.id, name: p.name, type: p.type, grossValue: gross, share, value: Math.round(gross * share) / 100 });
    }
    const assetValue = Math.round(assets.reduce((s, a) => s + a.value, 0) * 100) / 100;
    const liabilityValue = Math.round(liabilities.reduce((s, l) => s + l.value, 0) * 100) / 100;
    return { assetValue, liabilityValue, netValue: Math.round((assetValue - liabilityValue) * 100) / 100, assets, liabilities };
  }

  async createAssetPartyLink(data: InsertAssetPartyLink): Promise<AssetPartyLink> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const row = {
      id, user_id: this.userId,
      asset_profile_id: data.assetProfileId,
      party_profile_id: data.partyProfileId,
      ownership_percentage: data.ownershipPercentage ?? 100,
      role: data.role || "owner",
      effective_from: data.effectiveFrom ?? null,
      effective_to: data.effectiveTo ?? null,
      notes: data.notes ?? null,
      created_at: now, updated_at: now,
    };
    const { error } = await this.supabase.from("asset_party_links").insert(row);
    if (error) throw error;
    // [P2.3] history is fire-and-forget — a history failure must never block
    // (or retroactively fail) the ownership write that already succeeded.
    this.recordOwnershipHistory({
      linkKind: "asset_party", linkId: id,
      subjectId: data.assetProfileId, counterpartyId: data.partyProfileId,
      action: "create",
      fieldChanged: null, oldValue: null,
      newValue: JSON.stringify({ pct: row.ownership_percentage, role: row.role }),
      changedBy: "user", note: null,
    }).catch(() => { /* history is best-effort */ });
    return this.rowToAssetPartyLink(row);
  }

  async updateAssetPartyLink(id: string, patch: Partial<InsertAssetPartyLink>): Promise<AssetPartyLink | undefined> {
    // fetch existing for history
    const { data: existing } = await this.supabase.from("asset_party_links")
      .select("*").eq("id", id).eq("user_id", this.userId).single();
    if (!existing) return undefined;
    const update: any = { updated_at: new Date().toISOString() };
    if (patch.ownershipPercentage !== undefined) update.ownership_percentage = patch.ownershipPercentage;
    if (patch.role !== undefined) update.role = patch.role;
    if (patch.notes !== undefined) update.notes = patch.notes;
    if (patch.effectiveFrom !== undefined) update.effective_from = patch.effectiveFrom;
    if (patch.effectiveTo !== undefined) update.effective_to = patch.effectiveTo;
    const { data, error } = await this.supabase.from("asset_party_links")
      .update(update).eq("id", id).eq("user_id", this.userId).select().single();
    if (error) throw error;
    // record history per changed field — [P2.3] fire-and-forget so history
    // failures never block the write that already succeeded.
    if (patch.ownershipPercentage !== undefined && Number(existing.ownership_percentage) !== Number(patch.ownershipPercentage)) {
      this.recordOwnershipHistory({
        linkKind: "asset_party", linkId: id,
        subjectId: existing.asset_profile_id, counterpartyId: existing.party_profile_id,
        action: "update", fieldChanged: "ownership_percentage",
        oldValue: String(existing.ownership_percentage), newValue: String(patch.ownershipPercentage),
        changedBy: "user", note: null,
      }).catch(() => { /* history is best-effort */ });
    }
    if (patch.role !== undefined && existing.role !== patch.role) {
      this.recordOwnershipHistory({
        linkKind: "asset_party", linkId: id,
        subjectId: existing.asset_profile_id, counterpartyId: existing.party_profile_id,
        action: "update", fieldChanged: "role",
        oldValue: existing.role, newValue: String(patch.role),
        changedBy: "user", note: null,
      }).catch(() => { /* history is best-effort */ });
    }
    return data ? this.rowToAssetPartyLink(data) : undefined;
  }

  async deleteAssetPartyLink(id: string): Promise<boolean> {
    const { data: existing } = await this.supabase.from("asset_party_links")
      .select("*").eq("id", id).eq("user_id", this.userId).single();
    if (!existing) return false;
    const { error } = await this.supabase.from("asset_party_links")
      .delete().eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // [P2.3] fire-and-forget — history failures never block the delete.
    this.recordOwnershipHistory({
      linkKind: "asset_party", linkId: id,
      subjectId: existing.asset_profile_id, counterpartyId: existing.party_profile_id,
      action: "delete", fieldChanged: null,
      oldValue: JSON.stringify({ pct: existing.ownership_percentage, role: existing.role }),
      newValue: null, changedBy: "user", note: null,
    }).catch(() => { /* history is best-effort */ });
    await this.redistributeAfterLinkRemoval("asset", String(existing.asset_profile_id));
    return true;
  }

  /**
   * Replace the OWNER set of an asset — the single source-of-truth
   * write for ownership. Validates the full set (each 0–100, no dupes, totals
   * exactly 100% unless empty), then applies the minimal diff in a SAFE ORDER
   * so the per-asset sum never transiently exceeds 100 (which the DB guardrail
   * rejects): removals + decreases first, then increases + additions. Since
   * these are multiple database writes, a failure triggers reconciliation back
   * to a snapshot of the complete previous owner set.
   * Passing [] clears ownership → the asset reverts to the Self-100% default.
   */
  async setAssetOwners(
    assetProfileId: string,
    owners: Array<{ partyProfileId: string; ownershipPercentage: number }>,
  ): Promise<AssetPartyLink[]> {
    // Normalize + validate the desired set against the shared model.
    const desired = (owners || [])
      .filter((o) => o && o.partyProfileId)
      .map((o) => ({ partyProfileId: o.partyProfileId, ownershipPercentage: roundPct(Number(o.ownershipPercentage)), role: "owner" }));
    const v = validateOwnership(desired);
    if (!v.valid) {
      throw new Error(v.errors[0] || "Invalid ownership configuration");
    }

    const targets: OwnerSetRecord[] = desired.map((owner) => ({
      id: `desired:${owner.partyProfileId}`,
      ...owner,
    }));
    await replaceOwnerSetWithRollback(targets, {
      load: async () => {
        this.clearRequestMemo();
        return this.getAssetPartyLinks(assetProfileId);
      },
      remove: (row) => this.deleteAssetPartyLink(row.id),
      updatePercentage: (row, ownershipPercentage) =>
        this.updateAssetPartyLink(row.id, { ownershipPercentage }),
      create: (target) => this.createAssetPartyLink({
        assetProfileId,
        partyProfileId: target.partyProfileId,
        ownershipPercentage: target.ownershipPercentage,
        role: (target.role || "owner") as any,
        // A deleted snapshot row is recreated with all representable metadata.
        effectiveFrom: (target as AssetPartyLink).effectiveFrom ?? null,
        effectiveTo: (target as AssetPartyLink).effectiveTo ?? null,
        notes: (target as AssetPartyLink).notes ?? null,
      } as InsertAssetPartyLink),
    });
    this.clearRequestMemo();
    return this.getAssetPartyLinks(assetProfileId);
  }

  /**
   * Validated, compensating owner-set replacement for a LIABILITY — the liability
   * analogue of `setAssetOwners`. Same semantics: the application writes the
   * full desired owner set, this method validates the total via
   * `validateOwnership`, then reconciles existing OWNER-role links by deleting
   * removed parties first, lowering shrinking shares, then raising/inserting
   * new shares. That two-phase write keeps the running sum monotonic so the
   * DB-side >100 guard trigger (20260605_ownership_no_autoequalize.sql) never
   * trips during the transition. Non-owner roles (co_signer, guarantor,
   * responsible_party, authorized_user) are left untouched — this method
   * manages the OWNERSHIP set only.
   */
  async setLiabilityOwners(
    liabilityProfileId: string,
    owners: Array<{ partyProfileId: string; ownershipPercentage: number }>,
  ): Promise<LiabilityProfileLink[]> {
    const desired = (owners || [])
      .filter((o) => o && o.partyProfileId)
      .map((o) => ({ partyProfileId: o.partyProfileId, ownershipPercentage: roundPct(Number(o.ownershipPercentage)), role: "owner" }));
    const v = validateOwnership(desired);
    if (!v.valid) {
      throw new Error(v.errors[0] || "Invalid ownership configuration");
    }

    const targets: OwnerSetRecord[] = desired.map((owner) => ({
      id: `desired:${owner.partyProfileId}`,
      ...owner,
    }));
    await replaceOwnerSetWithRollback(targets, {
      load: async () => {
        this.clearRequestMemo();
        return this.getLiabilityProfileLinks(liabilityProfileId);
      },
      remove: (row) => this.deleteLiabilityProfileLink(row.id),
      updatePercentage: (row, ownershipPercentage) =>
        this.updateLiabilityProfileLink(row.id, { ownershipPercentage }),
      create: (target) => this.createLiabilityProfileLink({
        liabilityProfileId,
        partyProfileId: target.partyProfileId,
        ownershipPercentage: target.ownershipPercentage,
        role: (target.role || "owner") as any,
        notes: (target as LiabilityProfileLink).notes ?? null,
      } as InsertLiabilityProfileLink),
    });
    this.clearRequestMemo();
    return this.getLiabilityProfileLinks(liabilityProfileId);
  }

  async getOwnershipHistory(opts?: { subjectId?: string; counterpartyId?: string; limit?: number }): Promise<OwnershipHistoryEntry[]> {
    // Both ids are interpolated into .or() filters below — see isPostgrestSafe.
    // A malformed id can match nothing, so answer that rather than widening.
    if ((opts?.subjectId && !isPostgrestSafe(opts.subjectId)) ||
        (opts?.counterpartyId && !isPostgrestSafe(opts.counterpartyId))) return [];
    let q = this.supabase.from("ownership_history").select("*").eq("user_id", this.userId)
      .order("changed_at", { ascending: false });
    if (opts?.subjectId && opts?.counterpartyId) {
      q = q.or(`subject_id.eq.${opts.subjectId},counterparty_id.eq.${opts.subjectId},subject_id.eq.${opts.counterpartyId},counterparty_id.eq.${opts.counterpartyId}`);
    } else if (opts?.subjectId) {
      q = q.or(`subject_id.eq.${opts.subjectId},counterparty_id.eq.${opts.subjectId}`);
    } else if (opts?.counterpartyId) {
      q = q.or(`subject_id.eq.${opts.counterpartyId},counterparty_id.eq.${opts.counterpartyId}`);
    }
    if (opts?.limit) q = q.limit(opts.limit);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map((r: any) => this.rowToOwnershipHistory(r));
  }

  async recordOwnershipHistory(entry: Omit<OwnershipHistoryEntry, "id" | "changedAt">): Promise<OwnershipHistoryEntry> {
    const id = randomUUID();
    const row = {
      id, user_id: this.userId,
      link_kind: entry.linkKind,
      link_id: entry.linkId ?? null,
      subject_id: entry.subjectId ?? null,
      counterparty_id: entry.counterpartyId ?? null,
      action: entry.action,
      field_changed: entry.fieldChanged ?? null,
      old_value: entry.oldValue ?? null,
      new_value: entry.newValue ?? null,
      changed_by: entry.changedBy || "user",
      note: entry.note ?? null,
      changed_at: new Date().toISOString(),
    };
    const { error } = await this.supabase.from("ownership_history").insert(row);
    if (error) throw error;
    return this.rowToOwnershipHistory(row);
  }

  async deleteOwnershipHistoryEntry(id: string): Promise<boolean> {
    const { data, error } = await this.supabase.from("ownership_history")
      .delete().eq("id", id).eq("user_id", this.userId).select();
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }

  // ============================================================
  // SEED DATA
  // ============================================================
  async seedIfEmpty(): Promise<void> {
    // No seed data in production
    return;
  }

  private async seedData(): Promise<void> {
    // Removed — no demo data in production
  }

  // ============================================================
  // Universal Captures (PR Y/Z)
  // ============================================================
  // Primary backend is the `captures` table (migration 20260615).
  // If the table doesn't exist yet (e.g. migration not run on this
  // instance) we transparently fall back to an in-memory Map so the
  // API still works — capture data is the safety net for the user,
  // so we never want to refuse a write because the table is missing.
  private _captures: Map<string, import("@shared/schema").Capture> = new Map();
  private _capturesTableMissing = false;

  private _rowToCapture(row: any): import("@shared/schema").Capture {
    return {
      id: row.id,
      type: row.type || "unknown",
      ownerProfileId: row.owner_profile_id ?? null,
      title: row.title || "",
      rawInput: row.raw_input || "",
      structuredData: row.structured_data || {},
      metadata: row.metadata || {},
      relationships: row.relationships || [],
      source: row.source || "chat",
      confidence: typeof row.confidence === "number" ? row.confidence : Number(row.confidence ?? 0.5),
      status: row.status || "pending",
      projections: row.projections || [],
      clarifyingQuestion: row.clarifying_question ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private _isMissingTable(err: any): boolean {
    const code = err?.code || err?.error?.code || "";
    const msg = String(err?.message || err?.error?.message || "").toLowerCase();
    return code === "42P01" || code === "PGRST205" || msg.includes("could not find the table") || msg.includes("does not exist");
  }

  async getCaptures(opts?: { status?: string; ownerProfileId?: string; limit?: number }) {
    if (!this._capturesTableMissing) {
      let q = this.supabase.from("captures").select("*").eq("user_id", this.userId).order("created_at", { ascending: false });
      if (opts?.status) q = q.eq("status", opts.status);
      if (opts?.ownerProfileId) q = q.eq("owner_profile_id", opts.ownerProfileId);
      if (opts?.limit) q = q.limit(opts.limit);
      const { data, error } = await q;
      if (error) {
        if (this._isMissingTable(error)) {
          this._capturesTableMissing = true;
        } else {
          throw error;
        }
      } else {
        return (data || []).map((r: any) => this._rowToCapture(r));
      }
    }
    let list = Array.from(this._captures.values());
    if (opts?.status) list = list.filter(c => c.status === opts.status);
    if (opts?.ownerProfileId) list = list.filter(c => c.ownerProfileId === opts.ownerProfileId);
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (opts?.limit) list = list.slice(0, opts.limit);
    return list;
  }

  async getCapture(id: string) {
    if (!this._capturesTableMissing) {
      const { data, error } = await this.supabase.from("captures").select("*").eq("id", id).eq("user_id", this.userId).maybeSingle();
      if (error) {
        if (this._isMissingTable(error)) { this._capturesTableMissing = true; }
        else { throw error; }
      } else {
        return data ? this._rowToCapture(data) : undefined;
      }
    }
    return this._captures.get(id);
  }

  async createCapture(data: import("@shared/schema").InsertCapture): Promise<import("@shared/schema").Capture> {
    const { randomUUID } = await import("crypto");
    const id = randomUUID();
    const now = new Date().toISOString();
    const row = {
      id,
      user_id: this.userId,
      owner_profile_id: data.ownerProfileId ?? null,
      type: data.type || "unknown",
      title: data.title || "",
      raw_input: data.rawInput,
      structured_data: data.structuredData || {},
      metadata: data.metadata || {},
      relationships: data.relationships || [],
      source: data.source || "chat",
      confidence: data.confidence ?? 0.5,
      status: data.status || "pending",
      projections: data.projections || [],
      clarifying_question: data.clarifyingQuestion ?? null,
      created_at: now,
      updated_at: now,
    };
    if (!this._capturesTableMissing) {
      const { data: inserted, error } = await this.supabase.from("captures").insert(row).select().single();
      if (error) {
        if (this._isMissingTable(error)) { this._capturesTableMissing = true; }
        else { throw error; }
      } else {
        return this._rowToCapture(inserted);
      }
    }
    // No `captures` table on this deployment (the 20260615 migration has not
    // run): the row lives only in this process's memory. The chat pipeline
    // treats a capture as best-effort and carries on; the public route reads
    // this marker and refuses instead of answering 200 for a record that is
    // gone on the next request.
    const capture = { ...this._rowToCapture(row), ephemeral: true as const };
    this._captures.set(capture.id, capture);
    return capture;
  }

  async updateCapture(id: string, patch: Partial<import("@shared/schema").Capture>) {
    if (!this._capturesTableMissing) {
      const update: any = { updated_at: new Date().toISOString() };
      if (patch.type !== undefined) update.type = patch.type;
      if (patch.ownerProfileId !== undefined) update.owner_profile_id = patch.ownerProfileId;
      if (patch.title !== undefined) update.title = patch.title;
      if (patch.structuredData !== undefined) update.structured_data = patch.structuredData;
      if (patch.metadata !== undefined) update.metadata = patch.metadata;
      if (patch.relationships !== undefined) update.relationships = patch.relationships;
      if (patch.source !== undefined) update.source = patch.source;
      if (patch.confidence !== undefined) update.confidence = patch.confidence;
      if (patch.status !== undefined) update.status = patch.status;
      if (patch.projections !== undefined) update.projections = patch.projections;
      if (patch.clarifyingQuestion !== undefined) update.clarifying_question = patch.clarifyingQuestion;
      const { data, error } = await this.supabase.from("captures").update(update).eq("id", id).eq("user_id", this.userId).select().maybeSingle();
      if (error) {
        if (this._isMissingTable(error)) { this._capturesTableMissing = true; }
        else { throw error; }
      } else {
        return data ? this._rowToCapture(data) : undefined;
      }
    }
    const existing = this._captures.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    this._captures.set(id, updated);
    return updated;
  }

  async deleteCapture(id: string) {
    if (!this._capturesTableMissing) {
      // `.select` so a delete that matched no row (another user's id, a
      // missing id) reports false and the route answers 404 — it used to
      // answer success for a row that was never this user's to delete.
      const { data, error } = await this.supabase.from("captures").delete().eq("id", id).eq("user_id", this.userId).select("id");
      if (error) {
        if (this._isMissingTable(error)) { this._capturesTableMissing = true; }
        else { throw error; }
      } else {
        return Array.isArray(data) && data.length > 0;
      }
    }
    return this._captures.delete(id);
  }

  // ── Finance imports ("Import from ChatGPT") — batch history + undo ──────────
  private _rowToFinanceImport(r: any): any {
    return {
      id: r.id,
      profileId: r.profile_id ?? null,
      status: r.status,
      summary: r.summary ?? {},
      recordCount: r.record_count ?? 0,
      createdRecords: r.created_records ?? { expenses: [], obligations: [], incomes: [], profiles: [], budgets: [] },
      createdAt: r.created_at,
      undoneAt: r.undone_at ?? null,
    };
  }
  async createFinanceImport(rec: any): Promise<any> {
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("finance_imports").insert({
      id: rec.id, user_id: this.userId, profile_id: rec.profileId || null,
      status: rec.status, summary: rec.summary || {}, record_count: rec.recordCount || 0,
      created_records: rec.createdRecords || {}, created_at: now,
    });
    if (error) throw error;
    return (await this.getFinanceImport(rec.id))!;
  }
  async listFinanceImports(limit = 50): Promise<any[]> {
    const { data, error } = await this.supabase
      .from("finance_imports").select("*").eq("user_id", this.userId)
      .order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    return (data || []).map((r) => this._rowToFinanceImport(r));
  }
  async getFinanceImport(id: string): Promise<any | null> {
    const { data, error } = await this.supabase
      .from("finance_imports").select("*").eq("id", id).eq("user_id", this.userId).maybeSingle();
    if (error) throw error;
    return data ? this._rowToFinanceImport(data) : null;
  }
  async setFinanceImportStatus(id: string, status: "committed" | "undone"): Promise<void> {
    const patch: any = { status };
    if (status === "undone") patch.undone_at = new Date().toISOString();
    const { error } = await this.supabase.from("finance_imports").update(patch).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
  }
}

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/**
 * A liability row createObligation may turn INTO a recurring bill: one that
 * already is a recurring bill, or a bare shell with no type_key yet. A loan,
 * credit card or one-time debt is a different thing and must never be
 * converted by a same-named bill.
 */
export function isRecurringBillShell(p: { type_key?: string | null; typeKey?: string | null } | null | undefined): boolean {
  const tk = (p as any)?.type_key ?? (p as any)?.typeKey;
  return !tk || isRecurringBill(tk);
}

/**
 * The identity a calendar title is compared by: emoji, a trailing "— $amount"
 * and a trailing bill/payment/due word stripped, whitespace collapsed, lower
 * case. "💧 Water Bill — $42" and "Water" are the same bill; "Water polo" is not.
 */
export function calendarTitleKey(title: string | null | undefined): string {
  return String(title || "")
    .replace(/[\uD83C-\uDBFF][\uDC00-\uDFFF]|[☀-➿]/g, "")
    .replace(/\s*[—-]\s*\$[\d.,]+/, "")
    .replace(/\s+/g, " ").trim().toLowerCase()
    .replace(/^pay\s+/, "")
    .replace(/\s+(bill|payment|due)$/, "");
}

/**
 * Calendar dedup: an event that duplicates a bill on the bill's due date is
 * dropped, and one bill row yields one item per date.
 *
 * Matching is by WHOLE normalized title. The substring test it replaces
 * (`eventTitle.includes(billName)`) removed "Parent-teacher conference" on
 * Rent's due date and "Water polo" on the Water bill's, and the obligation
 * pass keyed on title+date so two different bills that share a name ("Phone"
 * for two people) collapsed into one. Obligations key on sourceId (the
 * liability row) instead.
 */
export function dedupCalendarTimelineItems<T extends { type: string; title: string; date: string; sourceId?: string | null }>(items: T[]): T[] {
  const obligationKeys = new Set<string>();
  for (const item of items) {
    if (item.type === "obligation") obligationKeys.add(`${calendarTitleKey(item.title)}::${item.date}`);
  }
  const seenObligations = new Set<string>();
  return items.filter(item => {
    if (item.type === "event") {
      return !obligationKeys.has(`${calendarTitleKey(item.title)}::${item.date}`);
    }
    if (item.type === "obligation") {
      const key = `${item.sourceId || calendarTitleKey(item.title)}::${item.date}`;
      if (seenObligations.has(key)) return false;
      seenObligations.add(key);
    }
    return true;
  });
}

/**
 * Whole calendar days from `todayISO` (the user's today) to a due date —
 * negative when past, 0 when due today. Computed on the two date strings, so
 * no instant (and no UTC-midnight reading of a date-only string) is involved.
 * NaN when the due date is unparseable.
 */
export function calendarDaysUntil(dueDate: string | Date | null | undefined, todayISO: string, timezone: string = DEFAULT_TIMEZONE): number {
  const due = localDayOf(dueDate, timezone);
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(todayISO)) return Number.NaN;
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${todayISO}T00:00:00Z`)) / 86400000);
}

/** Sum of a field over the entries whose calendar day IN `timezone` is `todayISO`. */
export function hydrationDailyTotal(
  entries: ReadonlyArray<{ timestamp: string; values: Record<string, any> }>,
  fieldName: string,
  todayISO: string,
  timezone: string = DEFAULT_TIMEZONE,
): number {
  return entries
    .filter(e => localDayOf(e.timestamp, timezone) === todayISO)
    .reduce((s, e) => s + (Number(e.values?.[fieldName]) || 0), 0);
}
