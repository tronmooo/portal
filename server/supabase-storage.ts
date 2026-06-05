import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

// ---- Shared Supabase client (PERF) ----
// One client per (url, key) pair per warm container. The Supabase SDK keeps
// internal Fetch/Auth/Realtime state that's safe to share across requests
// because every storage call scopes by user_id. Avoiding per-request
// construction shaves real cold-start time off scoped storage routes.
let _sharedClient: SupabaseClient | null = null;
let _sharedKey: string | null = null;
export function getSharedSupabaseClient(url: string, serviceKey: string): SupabaseClient {
  const key = `${url}::${serviceKey.slice(0, 8)}`;
  if (_sharedClient && _sharedKey === key) return _sharedClient;
  _sharedClient = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-client-info": "portol-server" } },
  });
  _sharedKey = key;
  return _sharedClient;
}
import { getUserToday, parseLocalDate, toLocalDateStr, addDays as tzAddDays } from "../shared/timezone";
import { passesProfileFilter } from "../shared/profile-filter";
import { selfIdsFrom } from "../shared/scope";
import {
  parseMoney as _sharedParseMoney,
  resolveAssetValue as _sharedResolveAssetValue,
  resolveLiabilityBalance as _sharedResolveLiabilityBalance,
  ASSET_PROFILE_TYPES,
  LIABILITY_PROFILE_TYPES,
} from "../shared/asset-value";
import { UPCOMING_BILL_WINDOW_DAYS, toMonthlyAmount, MS_PER_DAY } from "../shared/obligation-windows";
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
  MOOD_SCORES,
} from "@shared/schema";
import { type IStorage, type Reminder, computeSecondaryData } from "./storage";
import { encryptField, decryptField, shouldEncryptMemory, ENCRYPTED_PREFIX } from "./crypto-util";
import { setOwners } from "./ownership-writer";
import { OWNERSHIP_TABLES, type OwnedEntityType, resolveAutoOwner } from "../shared/ownership";
import { shareForParties, validateOwnership, roundPct, type OwnershipLink } from "../shared/ownership-model";

const DOCUMENTS_BUCKET = "documents";

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
function calculateStreak(checkins: { date: string }[], targetPerDay: number = 1): { current: number; longest: number } {
  if (checkins.length === 0) return { current: 0, longest: 0 };
  // Count check-ins per date
  const countByDate = new Map<string, number>();
  for (const c of checkins) {
    countByDate.set(c.date, (countByDate.get(c.date) || 0) + 1);
  }
  // A day is "complete" if check-in count >= targetPerDay
  const completeDates = [...countByDate.entries()]
    .filter(([, count]) => count >= targetPerDay)
    .map(([date]) => date)
    .sort()
    .reverse();
  if (completeDates.length === 0) return { current: 0, longest: 0 };
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  function addDays(dateStr: string, days: number): string {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }
  const yesterdayStr = addDays(todayStr, -1);
  let current = 0;
  if (completeDates[0] === todayStr || completeDates[0] === yesterdayStr) {
    let expectedDate = completeDates[0];
    for (let i = 0; i < completeDates.length; i++) {
      if (completeDates[i] === expectedDate) { current++; expectedDate = addDays(expectedDate, -1); }
      else if (completeDates[i] < expectedDate) { break; }
    }
  }
  const allDates = [...completeDates].sort();
  let tempStreak = 1;
  let longest = 1;
  for (let i = 1; i < allDates.length; i++) {
    if (allDates[i] === addDays(allDates[i - 1], 1)) { tempStreak++; longest = Math.max(longest, tempStreak); } else { tempStreak = 1; }
  }
  return { current: Math.max(current, 0), longest: Math.max(longest, current) };
}

// ---- Insight generation ----
function generateInsights(
  profiles: Profile[], trackers: Tracker[], tasks: Task[], expenses: Expense[],
  habits: Habit[], obligations: Obligation[], journal: JournalEntry[],
): Insight[] {
  const insights: Insight[] = [];
  const now = new Date();

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
    const fitTz = 'America/Los_Angeles';
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
    if (sys >= 140 || dia >= 90) {
      insights.push({ id: randomUUID(), type: "anomaly", title: "Elevated blood pressure detected", description: `Your latest reading (${sys}/${dia}) is above the recommended range.`, severity: "warning", relatedEntityType: "tracker", relatedEntityId: bpTracker.id, data: { systolic: sys, diastolic: dia }, createdAt: now.toISOString() });
    }
  }

  const thisMonth = now.getMonth(); const thisYear = now.getFullYear();
  const monthlyExpenses = expenses.filter(e => { const d = new Date(e.date); return d.getMonth() === thisMonth && d.getFullYear() === thisYear; });
  const monthTotal = monthlyExpenses.reduce((s, e) => s + e.amount, 0);
  if (monthTotal > 0) {
    const topCat = Object.entries(monthlyExpenses.reduce((acc: Record<string, number>, e) => { acc[e.category] = (acc[e.category] || 0) + e.amount; return acc; }, {})).sort((a, b) => b[1] - a[1])[0];
    if (topCat) {
      insights.push({ id: randomUUID(), type: "spending_trend", title: `$${monthTotal.toFixed(0)} spent this month`, description: `Top category: ${topCat[0]} ($${topCat[1].toFixed(0)}).`, severity: monthTotal > 1000 ? "warning" : "info", data: { total: monthTotal, topCategory: topCat[0] }, createdAt: now.toISOString() });
    }
  }

  const overdueTasks = tasks.filter(t => { if (t.status === "done" || !t.dueDate) return false; return new Date(t.dueDate) < now; });
  if (overdueTasks.length > 0) {
    insights.push({ id: randomUUID(), type: "reminder", title: `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`, description: overdueTasks.map(t => t.title).join(", "), severity: "negative", data: { taskIds: overdueTasks.map(t => t.id) }, createdAt: now.toISOString() });
  }

  for (const habit of habits) {
    if (habit.currentStreak >= 3) {
      insights.push({ id: randomUUID(), type: "habit_streak", title: `${habit.currentStreak}-day ${habit.name} streak`, description: `${habit.currentStreak >= 7 ? "Amazing consistency!" : "Keep building the habit!"}${habit.longestStreak > habit.currentStreak ? ` Your record is ${habit.longestStreak} days.` : " This is your personal best!"}`, severity: "positive", relatedEntityType: "habit", relatedEntityId: habit.id, data: { current: habit.currentStreak, longest: habit.longestStreak }, createdAt: now.toISOString() });
    }
  }

  const sevenDaysOut = new Date(now.getTime() + 7 * 86400000);
  const upcomingObs = obligations.filter(o => { const due = new Date(o.nextDueDate); return due >= now && due <= sevenDaysOut; });
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

  const todayStr = now.toISOString().slice(0, 10);
  let totalCalsBurned = 0;
  for (const t of trackers) { for (const e of t.entries) { if (e.timestamp.slice(0, 10) === todayStr && e.computed?.caloriesBurned) totalCalsBurned += e.computed.caloriesBurned; } }
  if (totalCalsBurned > 0) { insights.push({ id: randomUUID(), type: "health_correlation", title: `${totalCalsBurned} calories burned today`, description: `Based on your logged activities. ${totalCalsBurned > 500 ? "Great active day!" : "Every bit counts."}`, severity: "positive", data: { caloriesBurned: totalCalsBurned }, createdAt: now.toISOString() }); }

  if (trackers.length > 0) {
    const noRecentEntries = trackers.filter(t => { if (t.entries.length === 0) return true; const last = new Date(t.entries[t.entries.length - 1].timestamp); return (now.getTime() - last.getTime()) > 3 * 86400000; });
    if (noRecentEntries.length > 0) { insights.push({ id: randomUUID(), type: "suggestion", title: "Trackers need attention", description: `${noRecentEntries.map(t => t.name).join(", ")} haven't been updated in 3+ days.`, severity: "info", data: { trackerIds: noRecentEntries.map(t => t.id) }, createdAt: now.toISOString() }); }
  }

  return insights;
}


// ============================================================
// SUPABASE STORAGE IMPLEMENTATION
// ============================================================

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
  private memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.memoEnabled) return fn();
    const hit = this.memoCache.get(key);
    if (hit) return hit as Promise<T>;
    const p = fn().catch(err => { this.memoCache.delete(key); throw err; });
    this.memoCache.set(key, p);
    return p;
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
      linkedObligationId: r.linked_obligation_id || undefined,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private rowToTrackerEntry(r: any): TrackerEntry {
    return {
      id: r.id, values: r.entry_values || {}, computed: r.computed || {},
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
    };
  }

  private rowToTask(r: any): Task {
    return {
      id: r.id, title: r.title, description: r.description || undefined,
      status: r.status, priority: r.priority, dueDate: r.due_date || undefined,
      linkedProfiles: r.linked_profiles || [], tags: r.tags || [], createdAt: r.created_at,
    };
  }

  private rowToExpense(r: any): Expense {
    return {
      id: r.id, amount: Number(r.amount) || 0, category: r.category, description: r.description,
      vendor: r.vendor || undefined, isRecurring: r.is_recurring || undefined,
      linkedProfiles: r.linked_profiles || [], tags: r.tags || [],
      date: r.date, createdAt: r.created_at,
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
    };
  }

  private rowToDocument(r: any): Document {
    return {
      id: r.id, name: r.name, type: r.type, mimeType: r.mime_type,
      fileData: r.file_data || "", storagePath: r.storage_path || undefined,
      extractedData: r.extracted_data || {},
      linkedProfiles: r.linked_profiles || [], tags: r.tags || [],
      createdAt: r.created_at,
    };
  }

  private rowToHabitCheckin(r: any): HabitCheckin {
    return {
      id: r.id, date: r.date, value: r.value ?? undefined,
      notes: r.notes || undefined, timestamp: r.timestamp,
    };
  }

  private rowToHabit(r: any, checkins: HabitCheckin[]): Habit {
    return {
      id: r.id, name: r.name, icon: r.icon || undefined, color: r.color || undefined,
      frequency: r.frequency, targetDays: r.target_days || undefined,
      targetPerDay: r.target_per_day || 1,
      currentStreak: r.current_streak || 0, longestStreak: r.longest_streak || 0,
      linkedProfiles: r.linked_profiles || [],
      checkins, createdAt: r.created_at,
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
      return (data || []).map(r => this.rowToProfile(r));
    });
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
      .select("id, type, type_key, name, avatar, parent_profile_id, linked_obligation_id, created_at, updated_at")
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
      linkedObligationId: r.linked_obligation_id || undefined,
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
    const [
      allProfiles,
      trackersRes, expensesRes, tasksRes, eventsRes, documentsRes, obligationsRes,
      journalRows,
    ] = await Promise.all([
      this.getProfiles(),
      this.supabase.from("trackers").select("*")
        .eq("user_id", this.userId).contains("linked_profiles", [id])
        .then(r => r.data || []),
      this.supabase.from("expenses").select("*")
        .eq("user_id", this.userId).is("deleted_at", null).contains("linked_profiles", [id])
        .then(r => r.data || []),
      this.supabase.from("tasks").select("*")
        .eq("user_id", this.userId).is("deleted_at", null).contains("linked_profiles", [id])
        .then(r => r.data || []),
      this.supabase.from("events").select("*")
        .eq("user_id", this.userId).contains("linked_profiles", [id])
        .then(r => r.data || []),
      this.supabase.from("documents")
        .select("id, user_id, name, type, mime_type, extracted_data, linked_profiles, tags, created_at, updated_at")
        .eq("user_id", this.userId).is("deleted_at", null).contains("linked_profiles", [id])
        .then(r => r.data || []),
      this.supabase.from("obligations").select("*")
        .eq("user_id", this.userId).contains("linked_profiles", [id])
        .then(r => r.data || []),
      this.supabase.from("journal_entries")
        .select("*")
        .eq("user_id", this.userId)
        .contains("linked_profiles", [id])
        .order("created_at", { ascending: false })
        .then(r => r.data || []),
    ]);

    const trackerIds = (trackersRes as any[]).map((r: any) => r.id);
    const obligationIds = (obligationsRes as any[]).map((r: any) => r.id);
    const [trackerEntryRows, obligationPaymentRows] = await Promise.all([
      trackerIds.length > 0
        ? this.supabase.from("tracker_entries").select("*").eq("user_id", this.userId).in("tracker_id", trackerIds).is("deleted_at", null).order("timestamp", { ascending: false }).then(r => r.data || [])
        : Promise.resolve([] as any[]),
      obligationIds.length > 0
        ? this.supabase.from("obligation_payments").select("*").eq("user_id", this.userId).in("obligation_id", obligationIds).order("date", { ascending: false }).then(r => r.data || [])
        : Promise.resolve([] as any[]),
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

    // Map DB rows to domain objects
    const relatedTrackers = (trackersRes as any[]).map((r: any) => this.rowToTracker(r, (entriesByTracker.get(r.id) || []).map((e: any) => this.rowToTrackerEntry(e))));
    const relatedExpenses = (expensesRes as any[]).map((r: any) => this.rowToExpense(r));
    const relatedTasks = (tasksRes as any[]).map((r: any) => this.rowToTask(r));
    const relatedEvents = (eventsRes as any[]).map((r: any) => this.rowToEvent(r));
    const relatedDocuments = (documentsRes as any[]).map((r: any) => this.rowToDocument({ ...r, file_data: "" }));
    const relatedObligations = (obligationsRes as any[]).map((r: any) => this.rowToObligation(r, (paymentsByObligation.get(r.id) || []).map((p: any) => this.rowToPayment(p))));
    const relatedJournal = (journalRows as any[]).map((r: any) => this.rowToJournalEntry(r));

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
    if (isPersonLike) {
      try {
        const [assetLinks, liabLinks] = await Promise.all([
          this.getAssetPartyLinksForParty(id).catch(() => [] as any[]),
          this.getLiabilityProfileLinksForParty(id).catch(() => [] as any[]),
        ]);
        const seen = new Set(directChildren.map(p => p.id));
        for (const l of assetLinks || []) {
          const aid = (l as any).assetProfileId;
          if (!aid || seen.has(aid)) continue;
          const a = allProfiles.find(p => p.id === aid);
          if (!a) continue;
          // Only assets surface as co-owned children, per the rule.
          if (!["vehicle", "asset", "investment", "property"].includes(a.type)) continue;
          seen.add(aid);
          childProfiles.push({ ...a, _coOwner: true, _ownershipPercentage: (l as any).ownershipPercentage });
        }
        for (const l of liabLinks || []) {
          const lid = (l as any).liabilityProfileId;
          if (!lid || seen.has(lid)) continue;
          const x = allProfiles.find(p => p.id === lid);
          if (!x) continue;
          if (!["liability", "loan", "subscription"].includes(x.type)) continue;
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
        timeline.push({ id: e.id, type: "tracker", title: `${t.name} logged`, description: Object.entries(e.values).map(([k, v]) => `${k}: ${v}`).join(", "), data: { ...e.values, computed: e.computed }, timestamp: e.timestamp });
      }
    }
    for (const e of relatedExpenses) timeline.push({ id: e.id, type: "expense", title: e.description, description: `$${e.amount} - ${e.category}`, timestamp: e.date });
    for (const t of relatedTasks) timeline.push({ id: t.id, type: "task", title: t.title, description: `${t.status} - ${t.priority}`, timestamp: t.createdAt });
    for (const e of relatedEvents) timeline.push({ id: e.id, type: "event", title: e.title, description: e.description, timestamp: e.date });
    for (const d of relatedDocuments) timeline.push({ id: d.id, type: "document", title: d.name, description: d.type, timestamp: d.createdAt });
    for (const o of relatedObligations) timeline.push({ id: o.id, type: "obligation", title: o.name, description: `$${o.amount}/${o.frequency}`, timestamp: o.createdAt });
    for (const j of relatedJournal) timeline.push({ id: j.id, type: "journal", title: j.content?.slice(0, 80) || "Journal entry", description: j.mood ? `Mood: ${j.mood}` : undefined, timestamp: j.date || (j as any).createdAt });
    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // `relatedJournal` is added to the returned shape so the profile detail
    // page can render a journal section. Existing keys are unchanged.
    return { ...profile, relatedTrackers, relatedExpenses, relatedTasks, relatedEvents, relatedDocuments, relatedObligations, relatedJournal, childProfiles, timeline } as any;
  }

  async createProfile(data: InsertProfile): Promise<Profile> {
    const validProfileTypes = new Set(["self", "person", "pet", "vehicle", "asset", "subscription", "loan", "liability", "investment", "property", "account", "insurance", "medical"]);
    if (data.type && !validProfileTypes.has(data.type)) data.type = "person";
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
    await this.autoGenerateProfileEvents(id, data.type, data.name, data.fields || {});

    // ---- Default-ownership hook ----
    // For new asset/liability profiles with no explicit ownership, auto-link the
    // OWNING party at 100%. The owner is resolved from the parent chain
    // (resolveAutoOwner): a non-Self person parent means that person owns it; a
    // Self parent (or no parent) means Self owns it. Linking Self unconditionally
    // was the Jane Doe bug — it claimed every person's asset for Self (net worth
    // $0) and, once a competing person link was added, the SUM>100 DB trigger
    // (migrations/20260511_ownership_invariant.sql) split both to 50/50.
    // Best-effort — must not break the create response if it fails.
    try {
      const assetTypes = new Set(["asset", "vehicle", "property"]);
      const liabilityTypes = new Set(["liability", "loan"]);
      const isAsset = assetTypes.has(data.type);
      const isLiability = liabilityTypes.has(data.type);
      if (isAsset || isLiability) {
        const selfProfile = await this.getSelfProfile();
        const allProfiles = await this.getProfiles().catch(() => [] as any[]);
        const ownerProfileId = resolveAutoOwner(parentProfileId, allProfiles as any, selfProfile?.id ?? null);
        if (ownerProfileId && ownerProfileId !== id) {
          if (isAsset) {
            const existing = await this.getAssetPartyLinks(id).catch(() => [] as any[]);
            const already = (existing || []).some((l: any) => l.partyProfileId === ownerProfileId);
            if (!already) {
              await this.createAssetPartyLink({
                assetProfileId: id,
                partyProfileId: ownerProfileId,
                ownershipPercentage: 100,
                role: "owner",
              } as any).catch((e: any) => {
                console.warn("[auto-ownership/storage] asset link failed:", e?.message || e);
              });
            }
          } else if (isLiability) {
            const existing = await this.getLiabilityProfileLinks(id).catch(() => [] as any[]);
            const already = (existing || []).some((l: any) => l.partyProfileId === ownerProfileId);
            if (!already) {
              await this.createLiabilityProfileLink({
                liabilityProfileId: id,
                partyProfileId: ownerProfileId,
                ownershipPercentage: 100,
                role: "owner",
              } as any).catch((e: any) => {
                console.warn("[auto-ownership/storage] liability link failed:", e?.message || e);
              });
            }
          }
        }
      }
    } catch (autoOwnErr: any) {
      console.warn("[auto-ownership/storage] hook failed:", autoOwnErr?.message || autoOwnErr);
    }

    return (await this.getProfile(id))!;
  }

  /** Auto-create calendar events for profile date fields */
  private async autoGenerateProfileEvents(profileId: string, type: string, name: string, fields: Record<string, any>): Promise<void> {
    // ── Phase 4: synthesize nextPayment from dueDay for liability/loan profiles ──
    // If the profile has a `dueDay` (1-31) but no explicit nextPayment date, compute
    // the next occurrence so the auto-event generator below picks it up.
    if ((type === "liability" || type === "loan") && !fields.nextPayment) {
      const dueDayRaw = fields.dueDay ?? fields.due_day ?? fields?.finance?.dueDay;
      const dd = Number(dueDayRaw);
      if (Number.isFinite(dd) && dd >= 1 && dd <= 31) {
        const today = new Date();
        const y = today.getFullYear();
        const m = today.getMonth();
        const d = today.getDate();
        // If due day already passed this month, schedule for next month
        const targetMonth = d <= dd ? m : m + 1;
        const candidate = new Date(y, targetMonth, dd);
        // Clamp to last day of month if needed (e.g. Feb 31 → Feb 28/29)
        if (candidate.getMonth() !== ((targetMonth) % 12 + 12) % 12) {
          candidate.setDate(0);
        }
        const iso = candidate.toISOString().slice(0, 10);
        // Mutate the fields snapshot we'll feed into the event generator below
        fields = { ...fields, nextPayment: iso };
      }
    }

    const eventDefs: { fieldKey: string; titleFn: (n: string) => string; category: string; recurrence: string; color: string }[] = [];

    switch (type) {
      case "person":
      case "self":
        eventDefs.push({ fieldKey: "birthday", titleFn: (n) => `\u{1F382} ${n}'s Birthday`, category: "family", recurrence: "yearly", color: "#A86FDF" });
        break;
      case "medical":
        eventDefs.push({ fieldKey: "nextVisit", titleFn: (n) => `\u{1F3E5} ${n} — Visit`, category: "health", recurrence: "none", color: "#6DAA45" });
        break;
      case "vehicle":
        eventDefs.push({ fieldKey: "nextService", titleFn: (n) => `\u{1F697} ${n} — Service`, category: "other", recurrence: "none", color: "#BB653B" });
        break;
      case "subscription":
        eventDefs.push({ fieldKey: "renewalDate", titleFn: (n) => `\u{1F504} ${n} — Renewal`, category: "finance", recurrence: "monthly", color: "#D19900" });
        eventDefs.push({ fieldKey: "nextPayment", titleFn: (n) => `\u{1F4B0} ${n} — Payment Due`, category: "finance", recurrence: "monthly", color: "#BB653B" });
        eventDefs.push({ fieldKey: "startDate", titleFn: (n) => `\u{1F504} ${n} — Start Date`, category: "finance", recurrence: "none", color: "#D19900" });
        break;
      case "loan":
      case "liability":
        // Calendar events on loan/liability profiles. Phase 4 also derives a synthetic
        // 'nextPayment' from `dueDay` (1-31) when explicit nextPayment isn't set —
        // see synthesizeNextPaymentFromDueDay below.
        eventDefs.push({ fieldKey: "nextPayment", titleFn: (n) => `\u{1F4B0} ${n} — Payment Due`, category: "finance", recurrence: "monthly", color: "#BB653B" });
        eventDefs.push({ fieldKey: "startDate", titleFn: (n) => `\u{1F4B0} ${n} — Start Date`, category: "finance", recurrence: "none", color: "#BB653B" });
        break;
      case "pet":
        eventDefs.push({ fieldKey: "nextVetVisit", titleFn: (n) => `\u{1F43E} ${n} — Vet Visit`, category: "health", recurrence: "none", color: "#6DAA45" });
        break;
      case "property":
        eventDefs.push({ fieldKey: "insuranceExpiry", titleFn: (n) => `\u{1F3E0} ${n} — Insurance Expiry`, category: "finance", recurrence: "none", color: "#BB653B" });
        eventDefs.push({ fieldKey: "leaseEnd", titleFn: (n) => `\u{1F3E0} ${n} — Lease End`, category: "finance", recurrence: "none", color: "#A13544" });
        break;
      case "investment":
        eventDefs.push({ fieldKey: "maturityDate", titleFn: (n) => `\u{1F4C8} ${n} — Maturity`, category: "finance", recurrence: "none", color: "#D19900" });
        break;
      case "account":
        eventDefs.push({ fieldKey: "expirationDate", titleFn: (n) => `\u26A0\uFE0F ${n} — Expires`, category: "other", recurrence: "none", color: "#A13544" });
        break;
      case "asset":
        eventDefs.push({ fieldKey: "warrantyExpiry", titleFn: (n) => `\u{1F6E1}\uFE0F ${n} — Warranty Expiry`, category: "other", recurrence: "none", color: "#BB653B" });
        break;
    }

    // Fetch existing events to dedup — don't create if a matching event already exists
    const existingEvents = await this.getEvents();
    for (const def of eventDefs) {
      const dateVal = fields[def.fieldKey];
      if (dateVal && typeof dateVal === "string" && dateVal.length >= 10) {
        const title = def.titleFn(name);
        const date = dateVal.slice(0, 10);
        // Dedup: skip if an event with the same title already exists for this profile
        const alreadyExists = existingEvents.some(e => 
          e.title === title && e.linkedProfiles.includes(profileId)
        );
        if (alreadyExists) continue;
        try {
          await this.createEvent({
            title,
            date,
            allDay: true,
            category: def.category as any,
            color: def.color,
            recurrence: def.recurrence as any,
            linkedProfiles: [profileId],
            linkedDocuments: [],
            tags: ["auto-generated"],
            source: "ai",
          });
        } catch (e) {
          console.error(`Auto-event generation failed for ${name} / ${def.fieldKey}:`, e);
        }
      }
    }
  }

  async updateProfile(
    id: string,
    data: Partial<Profile> & { fieldsToDelete?: string[] }
  ): Promise<Profile | undefined> {
    const existing = await this.getProfile(id);
    if (!existing) return undefined;
    // Universal-delete: expand UI keys into the full storage-side alias set,
    // then ALSO strip those keys from every nested group. Without this step,
    // deleting "birthday" on a person profile only removes the top-level
    // `birthday` key while `dateOfBirth` (top-level) and `personal.dateOfBirth`
    // (nested) survive — and flatten promotes them right back on the next read.
    // See PROFILE_KEY_ALIAS_REVERSE + PROFILE_NESTED_GROUPS at the top of this
    // file for the topology this depends on (kept in lockstep with the client).
    const expandedDeletes = expandProfileFieldDeletions(data.fieldsToDelete);
    const mergedFields = mergeAndApplyDeletes(
      existing.fields || {},
      data.fields,
      expandedDeletes
    );
    if (expandedDeletes.length > 0) {
      stripFromNestedGroups(mergedFields as Record<string, any>, expandedDeletes);
    }
    const merged = { ...existing, ...data, fields: mergedFields };
    const now = new Date().toISOString();
    const updateData: any = {
      type: merged.type, name: merged.name, avatar: merged.avatar || null,
      fields: merged.fields, tags: merged.tags, notes: merged.notes,
      documents: merged.documents, updated_at: now,
      // JSONB linked_trackers/expenses/tasks/events are deprecated — junction tables are source of truth
    };
    // Optional FK fields
    if (data.linkedObligationId !== undefined) updateData.linked_obligation_id = data.linkedObligationId || null;
    if (data.parentProfileId !== undefined) updateData.parent_profile_id = data.parentProfileId || null;
    if ((data as any).type_key !== undefined) updateData.type_key = (data as any).type_key || null;
    const { error } = await this.supabase.from("profiles").update(updateData).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;

    // Auto-generate calendar events from updated profile date fields (dedup logic prevents duplicates)
    await this.autoGenerateProfileEvents(id, merged.type, merged.name, merged.fields || {});

    return this.getProfile(id);
  }

  async deleteProfile(id: string): Promise<boolean> {
    const profile = await this.getProfile(id);
    if (!profile) return false;

    // ── RECURSIVE: Delete all child profiles first (vehicles, assets, subscriptions, etc.) ──
    // Each child profile deletion triggers its own cascade, so their data goes away too.
    const allProfiles = await this.getProfiles();
    const childProfiles = allProfiles.filter(p => 
      p.parentProfileId === id
    );
    for (const child of childProfiles) {
      console.log(`[deleteProfile] Cascade-deleting child profile: ${child.name} (${child.type}, id:${child.id})`);
      await this.deleteProfile(child.id);
    }

    // ── Cascade delete: remove ALL linked entities — no exceptions ──
    const errors: string[] = [];

    try { // 1. Delete ALL trackers linked to this profile — completely
      // When a profile is deleted, ALL its trackers are deleted entirely.
      // No "shared" concept — if you delete Jane Doe, her Hemoglobin tracker goes away.
      // Delete entries by profile_id (new entries) AND by tracker_id (catches old entries without profile_id)
      const allTrackers = await this.getTrackers();
      for (const tracker of allTrackers) {
        if (!tracker.linkedProfiles.includes(id)) continue;
        // Delete ALL entries for this tracker (not just ones with profile_id)
        await this.supabase.from("tracker_entries").delete().eq("tracker_id", tracker.id).eq("user_id", this.userId);
        await this.supabase.from("trackers").delete().eq("id", tracker.id).eq("user_id", this.userId);
      }
      // Also catch any orphaned entries with this profile_id on trackers not directly linked
      await this.supabase.from("tracker_entries").delete().eq("profile_id", id).eq("user_id", this.userId);
    } catch (e) { errors.push("trackers"); }

    // Bug #7: previously this block deleted entire rows whenever a row was
    // linked to the deleted profile — even if other profiles co-owned it. So
    // deleting Bob would also delete every expense, task, habit, event,
    // document, obligation, artifact, or goal that Alice and Bob co-owned,
    // wiping data Alice still needed. Now we follow the journal pattern at
    // step 10: if the deleted profile is the SOLE owner (linkedProfiles
    // length <= 1) delete the row; if it's a co-owner, strip just that id
    // from linkedProfiles and update. PROFILE_EXCLUSIVE entities (habit, goal
    // — see PROFILE_EXCLUSIVE set above) always have <= 1 owner so the
    // "strip" branch is a no-op for them in practice.

    try { // 2. Expenses (multi-owner: preserve shared rows)
      const allExpenses = await this.getExpenses();
      for (const exp of allExpenses) {
        const lp = exp.linkedProfiles || [];
        if (!lp.includes(id)) continue;
        if (lp.length <= 1) {
          await this.supabase.from("expenses").delete().eq("id", exp.id).eq("user_id", this.userId);
        } else {
          await this.supabase.from("expenses").update({ linked_profiles: lp.filter(pid => pid !== id) }).eq("id", exp.id).eq("user_id", this.userId);
        }
      }
    } catch (e) { errors.push("expenses"); }

    try { // 3. Tasks (multi-owner: preserve shared rows)
      const allTasks = await this.getTasks();
      for (const task of allTasks) {
        const lp = task.linkedProfiles || [];
        if (!lp.includes(id)) continue;
        if (lp.length <= 1) {
          await this.supabase.from("tasks").delete().eq("id", task.id).eq("user_id", this.userId);
        } else {
          await this.supabase.from("tasks").update({ linked_profiles: lp.filter(pid => pid !== id) }).eq("id", task.id).eq("user_id", this.userId);
        }
      }
    } catch (e) { errors.push("tasks"); }

    try { // 4. Habits + check-ins (PROFILE_EXCLUSIVE, but use same shape for safety)
      const allHabits = await this.getHabits();
      for (const habit of allHabits) {
        const lp = (habit.linkedProfiles || []) as string[];
        if (!lp.includes(id)) continue;
        if (lp.length <= 1) {
          await this.supabase.from("habit_checkins").delete().eq("habit_id", habit.id).eq("user_id", this.userId);
          await this.supabase.from("habits").delete().eq("id", habit.id).eq("user_id", this.userId);
        } else {
          await this.supabase.from("habits").update({ linked_profiles: lp.filter(pid => pid !== id) }).eq("id", habit.id).eq("user_id", this.userId);
        }
      }
    } catch (e) { errors.push("habits"); }

    try { // 5. Obligations (multi-owner: preserve shared rows)
      const allObligations = await this.getObligations();
      for (const ob of allObligations) {
        const lp = ob.linkedProfiles || [];
        if (!lp.includes(id)) continue;
        if (lp.length <= 1) {
          await this.supabase.from("obligations").delete().eq("id", ob.id).eq("user_id", this.userId);
        } else {
          await this.supabase.from("obligations").update({ linked_profiles: lp.filter(pid => pid !== id) }).eq("id", ob.id).eq("user_id", this.userId);
        }
      }
    } catch (e) { errors.push("obligations"); }

    try { // 6. Events (multi-owner: preserve shared rows)
      const allEvents = await this.getEvents();
      for (const ev of allEvents) {
        const lp = ev.linkedProfiles || [];
        if (!lp.includes(id)) continue;
        if (lp.length <= 1) {
          await this.supabase.from("events").delete().eq("id", ev.id).eq("user_id", this.userId);
        } else {
          await this.supabase.from("events").update({ linked_profiles: lp.filter(pid => pid !== id) }).eq("id", ev.id).eq("user_id", this.userId);
        }
      }
    } catch (e) { errors.push("events"); }

    try { // 7. Documents (multi-owner: preserve shared rows)
      const allDocuments = await this.getDocuments();
      for (const doc of allDocuments) {
        const lp = (doc.linkedProfiles || []) as string[];
        if (!lp.includes(id)) continue;
        if (lp.length <= 1) {
          await this.supabase.from("documents").delete().eq("id", doc.id).eq("user_id", this.userId);
        } else {
          await this.supabase.from("documents").update({ linked_profiles: lp.filter(pid => pid !== id) }).eq("id", doc.id).eq("user_id", this.userId);
        }
      }
    } catch (e) { errors.push("documents"); }

    try { // 8. Artifacts (multi-owner: preserve shared rows)
      const allArtifacts = await this.getArtifacts();
      for (const art of allArtifacts) {
        const lp = (art.linkedProfiles || []) as string[];
        if (!lp.includes(id)) continue;
        if (lp.length <= 1) {
          await this.supabase.from("artifacts").delete().eq("id", art.id).eq("user_id", this.userId);
        } else {
          await this.supabase.from("artifacts").update({ linked_profiles: lp.filter(pid => pid !== id) }).eq("id", art.id).eq("user_id", this.userId);
        }
      }
    } catch (e) { errors.push("artifacts"); }

    try { // 9. Goals (PROFILE_EXCLUSIVE; use same shape for safety)
      const allGoals = await this.getGoals();
      for (const goal of allGoals) {
        const lp = ((goal as any).linkedProfiles || []) as string[];
        if (!lp.includes(id)) continue;
        if (lp.length <= 1) {
          await this.supabase.from("goals").delete().eq("id", goal.id).eq("user_id", this.userId);
        } else {
          await this.supabase.from("goals").update({ linked_profiles: lp.filter(pid => pid !== id) }).eq("id", goal.id).eq("user_id", this.userId);
        }
      }
    } catch (e) { errors.push("goals"); }

    try { // 9b. Incomes (multi-owner: preserve shared rows) — Bug #8: incomes
      // were never part of the cascade at all, so deleted profiles left orphan
      // income rows still pointing at them in linked_profiles.
      const allIncomes = await this.getIncomes();
      for (const inc of allIncomes) {
        const lp = (inc.linkedProfiles || []) as string[];
        if (!lp.includes(id)) continue;
        if (lp.length <= 1) {
          await this.supabase.from("incomes").update({ deleted_at: new Date().toISOString() }).eq("id", inc.id).eq("user_id", this.userId);
        } else {
          await this.supabase.from("incomes").update({ linked_profiles: lp.filter(pid => pid !== id) }).eq("id", inc.id).eq("user_id", this.userId);
        }
      }
    } catch (e) { errors.push("incomes"); }

    try { // 10. Delete/unlink journal entries
      const { data: journalRows } = await this.supabase.from("journal_entries").select("id, linked_profiles").eq("user_id", this.userId);
      for (const row of journalRows || []) {
        const lp: string[] = row.linked_profiles || [];
        if (lp.includes(id)) {
          if (lp.length <= 1) {
            await this.supabase.from("journal_entries").delete().eq("id", row.id).eq("user_id", this.userId);
          } else {
            await this.supabase.from("journal_entries").update({ linked_profiles: lp.filter((pid: string) => pid !== id) }).eq("id", row.id).eq("user_id", this.userId);
          }
        }
      }
    } catch (e) { errors.push("journal"); }

    try { // 11. Delete entity_links junction table rows referencing this profile
      await this.supabase.from("entity_links").delete()
        .or(`and(source_type.eq.profile,source_id.eq.${id}),and(target_type.eq.profile,target_id.eq.${id})`)
        .eq("user_id", this.userId);
    } catch (e) { errors.push("entity_links"); }

    try { // 12. Asset/Liability ownership + collateral link rows.
      // Belt-and-suspenders: clean up explicitly so the profile-row DELETE
      // doesn't have to rely on FK CASCADE firing through the owner-
      // enforcement triggers (which are patched to no-op when the profile
      // is gone, but cleaning up directly here is safer and avoids any
      // trigger churn in the same transaction).
      await this.supabase.from("asset_party_links").delete()
        .or(`asset_profile_id.eq.${id},party_profile_id.eq.${id}`)
        .eq("user_id", this.userId);
      await this.supabase.from("liability_profile_links").delete()
        .or(`liability_profile_id.eq.${id},party_profile_id.eq.${id}`)
        .eq("user_id", this.userId);
      await this.supabase.from("liability_asset_links").delete()
        .or(`liability_profile_id.eq.${id},asset_profile_id.eq.${id}`)
        .eq("user_id", this.userId);
    } catch (e) { errors.push("ownership_links"); }

    if (errors.length > 0) {
      console.warn(`[deleteProfile] Cascade delete partial failures for profile ${id}: ${errors.join(", ")}`);
    }

    // Finally, delete the profile itself
    const { error } = await this.supabase.from("profiles").delete().eq("id", id).eq("user_id", this.userId);
    if (error) {
      console.warn(`[deleteProfile] Failed to delete profile ${id}:`, error.message);
    }
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
          return; // Hard reject — do not write anything
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

      // Also add parent to document's linkedProfiles JSONB
      const doc = await this.getDocument(documentId);
      if (doc && !doc.linkedProfiles.includes(parentId)) {
        const updatedLinked = [...doc.linkedProfiles, parentId];
        await this.supabase.from("documents").update({ linked_profiles: updatedLinked }).eq("id", documentId).eq("user_id", this.userId);
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
    const { data, error } = await this.supabase.from("profiles").select("*").eq("user_id", this.userId).eq("type", "self").is("deleted_at", null).limit(1).single();
    if (error || !data) return undefined;
    return this.rowToProfile(data);
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
        // Update tracker's linkedProfiles
        await this.supabase.from("trackers").update({ linked_profiles: [selfProfile.id] }).eq("id", t.id).eq("user_id", this.userId);
        // Update profile's linkedTrackers
        await this.linkProfileTo(selfProfile.id, "tracker", t.id);
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
    let trackersQuery = this.supabase.from("trackers").select("*").eq("user_id", this.userId);
    trackersQuery = this._applyProfileFilter(trackersQuery, profileIds);
    const [trackersResult, entriesResult] = await Promise.all([
      trackersQuery,
      this.supabase.from("tracker_entries").select("*").eq("user_id", this.userId).gte("timestamp", cutoff).is("deleted_at", null).order("timestamp", { ascending: true }),
    ]);
    if (trackersResult.error) throw trackersResult.error;
    // Group entries by tracker_id
    const entriesByTracker = new Map<string, any[]>();
    for (const e of entriesResult.data || []) {
      const arr = entriesByTracker.get(e.tracker_id) || [];
      arr.push(e);
      entriesByTracker.set(e.tracker_id, arr);
    }
    return (trackersResult.data || []).map(r =>
      this.rowToTracker(r, (entriesByTracker.get(r.id) || []).map(e => this.rowToTrackerEntry(e))),
    );
  }

  async getTracker(id: string): Promise<Tracker | undefined> {
    const [{ data, error }, entriesResult] = await Promise.all([
      this.supabase.from("trackers").select("*").eq("id", id).eq("user_id", this.userId).single(),
      this.supabase.from("tracker_entries").select("*").eq("tracker_id", id).eq("user_id", this.userId).is("deleted_at", null).order("timestamp", { ascending: true }),
    ]);
    if (error || !data) return undefined;
    return this.rowToTracker(
      data,
      (entriesResult.data || []).map(e => this.rowToTrackerEntry(e)),
    );
  }

  async createTracker(data: InsertTracker): Promise<Tracker> {
    // Dedup: check for existing tracker with same name AND same profile (case-insensitive)
    // Different profiles CAN have same-named trackers (e.g., "Calories" for Me and "Calories - Rex" for Rex)
    const existing = await this.getTrackers();
    const requestedProfiles = (data as any).linkedProfiles || [];
    const dup = existing.find(t => {
      if (t.name.toLowerCase() !== data.name.toLowerCase()) return false;
      // If no profile specified, any match is a dup
      if (requestedProfiles.length === 0) return true;
      // If profile specified, only match if the existing tracker has the same profile
      const existingLp = t.linkedProfiles || [];
      return requestedProfiles.some((pid: string) => existingLp.includes(pid));
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
    const { error } = await this.supabase.from("trackers").insert({
      id, user_id: this.userId, name: data.name, category: data.category || "custom",
      unit: data.unit || null, icon: data.icon || null, fields: data.fields || [],
      linked_profiles: linkedProfiles, created_at: now,
    });
    if (error) throw error;
    // Link to profiles via junction table
    for (const pId of linkedProfiles) {
      await this.linkProfileTo(pId, "tracker", id);
    }
    this.logActivity("tracker", `Created tracker: ${data.name}`);
    return (await this.getTracker(id))!;
  }

  async updateTracker(id: string, data: Partial<Tracker>): Promise<Tracker | undefined> {
    const existing = await this.getTracker(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    const { error } = await this.supabase.from("trackers").update({
      name: merged.name, category: merged.category, unit: merged.unit || null,
      icon: merged.icon || null, fields: merged.fields, linked_profiles: merged.linkedProfiles,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth; no junction sync.
    return this.getTracker(id);
  }

  async logEntry(data: InsertTrackerEntry): Promise<TrackerEntry | undefined> {
    const tracker = await this.getTracker(data.trackerId);
    if (!tracker) return undefined;

    // Validate and normalize entry values against tracker field definitions
    let values = { ...data.values };
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

    // Dedup check: reject entries with same values logged within 5 minutes.
    // Use a key-sorted canonical form so {a:1,b:2} and {b:2,a:1} dedup the same way.
    // Only deduplicates accidental double-fires (e.g. retried HTTP request) —
    // intentional re-logs of the same value within 5 min are the trade-off.
    const canonicalize = (obj: any): string => {
      if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return JSON.stringify(obj);
      const sortedKeys = Object.keys(obj).sort();
      const out: Record<string, any> = {};
      for (const k of sortedKeys) out[k] = obj[k];
      return JSON.stringify(out);
    };
    const newCanonical = canonicalize(values);
    const recentEntries = await this.supabase
      .from("tracker_entries")
      .select("id, entry_values, timestamp")
      .eq("tracker_id", data.trackerId)
      .eq("user_id", this.userId)
      .is("deleted_at", null)
      .gte("timestamp", new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .order("timestamp", { ascending: false })
      .limit(5);
    if (recentEntries.data) {
      const existing = recentEntries.data.find(e => canonicalize(e.entry_values) === newCanonical);
      if (existing) {
        return this.rowToTrackerEntry(existing);
      }
    }

    const computed = { ...computeSecondaryData(tracker.name, tracker.category, values), validated };
    const id = randomUUID();
    // W4-4: honor an explicit entry timestamp when the caller supplies one
    // (already parsed to ISO upstream); otherwise stamp NOW().
    const ts = data.timestamp || new Date().toISOString();
    const { error } = await this.supabase.from("tracker_entries").insert({
      id, user_id: this.userId, tracker_id: data.trackerId,
      entry_values: values, computed, notes: data.notes || null,
      mood: data.mood || null, tags: data.tags || null,
      for_profile: data.forProfile || null,
      profile_id: data.profileId || null,
      timestamp: ts,
    });
    if (error) throw error;
    this.logActivity("tracker", `Logged ${tracker.name}`);
    return {
      id,
      values,
      computed,
      notes: data.notes,
      mood: data.mood as any,
      tags: data.tags,
      forProfile: data.forProfile || undefined,
      profileId: data.profileId || undefined,
      timestamp: ts,
    };
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
    // Merge values JSONB AND honor deletion intents — same reason as updateProfile.
    // Without this, secondary metrics logged in error could never be cleared from
    // a tracker entry (e.g. accidentally logged `diastolic` on a single-value
    // weight tracker).
    const mergedValues = mergeAndApplyDeletes(
      existing.values || {},
      patch.values,
      patch.valuesToDelete
    );
    const update: any = { values: mergedValues };
    if (patch.notes !== undefined) update.notes = patch.notes;
    if (patch.mood !== undefined) update.mood = patch.mood;
    if (patch.tags !== undefined) update.tags = patch.tags;
    if (patch.timestamp) update.timestamp = patch.timestamp;
    const { data, error } = await this.supabase.from("tracker_entries").update(update)
      .eq("id", entryId).eq("tracker_id", trackerId).eq("user_id", this.userId)
      .select().maybeSingle();
    if (error || !data) return undefined;
    return {
      id: data.id,
      values: data.values,
      computed: data.computed,
      notes: data.notes,
      mood: data.mood,
      tags: data.tags,
      timestamp: data.timestamp,
    };
  }

  async deleteTrackerEntry(trackerId: string, entryId: string): Promise<boolean> {
    const { error } = await this.supabase.from("tracker_entries").delete()
      .eq("id", entryId).eq("tracker_id", trackerId).eq("user_id", this.userId);
    return !error;
  }

  async deleteTracker(id: string): Promise<boolean> {
    // Delete entries first, then the tracker
    await this.supabase.from("tracker_entries").delete().eq("tracker_id", id).eq("user_id", this.userId);
    /* D1: clean up entity_links rows that reference this tracker */
    await this.cleanupEntityLinks("tracker", id);
    const { error } = await this.supabase.from("trackers").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
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
      q = this._applyProfileFilter(q, profileIds);
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
    const id = randomUUID();
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
    const merged = { ...existing, ...data };
    const { error } = await this.supabase.from("tasks").update({
      title: merged.title, description: merged.description || null, status: merged.status,
      priority: merged.priority, due_date: merged.dueDate || null,
      linked_profiles: merged.linkedProfiles, tags: merged.tags,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth; no junction sync.

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
    }
    return this.getTask(id);
  }

  /** Create the next instance of a recurring task with its due date advanced. */
  private async spawnNextRecurringTask(prev: Task, freq: string): Promise<void> {
    const base = prev.dueDate ? new Date(prev.dueDate.slice(0, 10) + "T00:00:00") : new Date();
    const next = new Date(base);
    const everyMatch = freq.match(/^every-(\d+)-days$/);
    if (everyMatch) next.setDate(next.getDate() + parseInt(everyMatch[1], 10));
    else if (freq === "daily") next.setDate(next.getDate() + 1);
    else if (freq === "weekly") next.setDate(next.getDate() + 7);
    else if (freq === "biweekly") next.setDate(next.getDate() + 14);
    else if (freq === "monthly") {
      const day = next.getDate();
      const last = new Date(next.getFullYear(), next.getMonth() + 2, 0).getDate();
      next.setMonth(next.getMonth() + 1, Math.min(day, last));
    } else return; // unknown cadence — do nothing
    const nextDue = next.toLocaleDateString("en-CA");
    await this.createTask({
      title: prev.title,
      description: prev.description || undefined,
      priority: prev.priority,
      dueDate: nextDue,
      tags: prev.tags || [],
      linkedProfiles: prev.linkedProfiles || [],
    } as any);
  }

  async deleteTask(id: string): Promise<boolean> {
    /* D1: clean up entity_links rows that reference this task */
    await this.cleanupEntityLinks("task", id);
    const { error } = await this.supabase.from("tasks")
      .update({ deleted_at: new Date().toISOString(), linked_profiles: [] })
      .eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  async restoreTask(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("tasks").update({ deleted_at: null }).eq("id", id).eq("user_id", this.userId);
    return !error;
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
      q = this._applyProfileFilter(q, profileIds);
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
      id, user_id: this.userId, amount: data.amount, category: data.category || "general",
      description: data.description, vendor: data.vendor || null,
      is_recurring: data.isRecurring || false, linked_profiles: [],
      tags: data.tags || [], date: data.date || now,
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
    const merged = { ...existing, ...data };
    const { error } = await this.supabase.from("expenses").update({
      amount: merged.amount, category: merged.category, description: merged.description,
      vendor: merged.vendor || null, is_recurring: merged.isRecurring || false,
      linked_profiles: merged.linkedProfiles, tags: merged.tags, date: merged.date,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth; no junction sync.
    return this.getExpense(id);
  }

  async deleteExpense(id: string): Promise<boolean> {
    /* D1: clean up entity_links rows that reference this expense */
    await this.cleanupEntityLinks("expense", id);
    const { error } = await this.supabase.from("expenses")
      .update({ deleted_at: new Date().toISOString(), linked_profiles: [] })
      .eq("id", id).eq("user_id", this.userId);
    return !error;
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
      q = this._applyProfileFilter(q, profileIds, "array");
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map(r => ({
        id: r.id, description: r.description, amount: Number(r.amount),
        category: r.category || "salary", frequency: r.frequency || "monthly",
        date: r.date || undefined, linkedProfiles: r.linked_profiles || [],
        tags: r.tags || [], deletedAt: r.deleted_at, createdAt: r.created_at,
      }));
    });
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
      frequency: data.frequency || "monthly", date: data.date || null,
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
    if (data.frequency !== undefined) updates.frequency = data.frequency;
    if (data.date !== undefined) updates.date = data.date;
    // Bug #4: linkedProfiles and tags were silently dropped on update, so any
    // edit (manual or via AI updateEntityLinkedProfiles → updateIncome path,
    // bug #12) would wipe the income's profile attribution. The PATCH route
    // accepts these fields and returns 200 — but they never reached the DB.
    if (data.linkedProfiles !== undefined) updates.linked_profiles = data.linkedProfiles;
    if (data.tags !== undefined) updates.tags = data.tags;
    const { error } = await this.supabase.from("incomes").update(updates).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    const all = await this.getIncomes();
    return all.find(i => i.id === id);
  }

  async deleteIncome(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("incomes").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // EVENTS
  // ============================================================
  async getEvents(profileIds?: string[]): Promise<CalendarEvent[]> {
    return this.memo(`getEvents${this._fk(profileIds)}`, async () => {
      // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth.
      // PERF (durable-fix-phase1): DB pushdown via idx_events_linked_profiles_gin.
      let q = this.supabase
        .from("events").select("*").eq("user_id", this.userId);
      q = this._applyProfileFilter(q, profileIds);
      const { data, error } = await q.order("date", { ascending: false });
      if (error) throw error;
      return (data || []).map(r => this.rowToEvent(r));
    });
  }

  async getEvent(id: string): Promise<CalendarEvent | undefined> {
    const { data, error } = await this.supabase
      .from("events").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    return this.rowToEvent(data);
  }

  async createEvent(data: InsertEvent): Promise<CalendarEvent> {
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
    const merged = { ...existing, ...data };
    const { error } = await this.supabase.from("events").update({
      title: merged.title, date: merged.date, time: merged.time || null,
      end_time: merged.endTime || null, end_date: merged.endDate || null,
      all_day: merged.allDay, description: merged.description || null,
      location: merged.location || null, category: merged.category,
      color: merged.color || null, recurrence: merged.recurrence,
      recurrence_end: merged.recurrenceEnd || null,
      linked_profiles: merged.linkedProfiles, linked_documents: merged.linkedDocuments,
      tags: merged.tags, source: merged.source,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth; no junction sync.
    return this.getEvent(id);
  }

  async deleteEvent(id: string): Promise<boolean> {
    /* D1: clean up entity_links rows that reference this event */
    await this.cleanupEntityLinks("event", id);
    // Hard delete — events table doesn't have deleted_at column
    const { error } = await this.supabase.from("events").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // CALENDAR TIMELINE
  // ============================================================
  async getCalendarTimeline(startDate: string, endDate: string, profileIds?: string[]): Promise<CalendarTimelineItem[]> {
    const items: CalendarTimelineItem[] = [];
    // Fetch all data in parallel for speed
    // (Habits are intentionally excluded — they don't belong on the calendar.)
    const [allEvents, allTasks, allObligations, profiles] = await Promise.all([
      this.getEvents(), this.getTasks(), this.getObligations(), this.getProfiles(),
    ]);
    // Profile filtering: use the same rule the client uses so the calendar
    // doesn't silently drop legacy/orphan items when the user filters to
    // only their own self-profile. Without this, a brand-new user who
    // hasn't tagged anything yet sees an empty calendar the moment they
    // touch the filter.
    const filterActive = !!(profileIds && profileIds.length > 0);
    const selfMatch = filterActive && profileIds!.some(id =>
      profiles.find(p => p.id === id)?.type === "self",
    );
    const matchesProfile = (linked: string[]) => {
      if (!filterActive) return true;
      const arr = Array.isArray(linked) ? linked : [];
      if (arr.length === 0) return selfMatch;
      return arr.some(id => profileIds!.includes(id));
    };
    const events = allEvents.filter(e => matchesProfile(e.linkedProfiles));
    const tasks = allTasks.filter(t => matchesProfile(t.linkedProfiles));
    const obligations = allObligations.filter(o => matchesProfile(o.linkedProfiles));
    for (const ev of events) {
      const color = ev.color || EVENT_CATEGORY_COLORS[ev.category] || "#4F98A3";
      const baseDate = ev.date.slice(0, 10);
      if (baseDate >= startDate && baseDate <= endDate) {
        items.push({ id: `event-${ev.id}-${baseDate}`, type: "event", title: ev.title, date: baseDate, time: ev.time, endTime: ev.endTime, allDay: ev.allDay, color, category: ev.category, description: ev.description, location: ev.location, linkedProfiles: ev.linkedProfiles, sourceId: ev.id, meta: { recurrence: ev.recurrence, tags: ev.tags, source: ev.source } });
      }
      if (ev.recurrence !== "none") {
        const base = parseLocalDate(ev.date.slice(0, 10));
        for (let i = 1; i <= 45; i++) {
          const next = new Date(base);
          switch (ev.recurrence) {
            case "daily": next.setDate(next.getDate() + i); break;
            case "weekly": next.setDate(next.getDate() + i * 7); break;
            case "biweekly": next.setDate(next.getDate() + i * 14); break;
            case "monthly": next.setMonth(next.getMonth() + i); break;
            case "yearly": next.setFullYear(next.getFullYear() + i); break;
          }
          const nextStr = next.toLocaleDateString('en-CA');
          if (nextStr > endDate) break;
          if (ev.recurrenceEnd && nextStr > ev.recurrenceEnd) break;
          if (nextStr >= startDate) {
            items.push({ id: `event-${ev.id}-${nextStr}`, type: "event", title: ev.title, date: nextStr, time: ev.time, endTime: ev.endTime, allDay: ev.allDay, color, category: ev.category, description: ev.description, location: ev.location, linkedProfiles: ev.linkedProfiles, sourceId: ev.id, meta: { recurrence: ev.recurrence, tags: ev.tags, source: ev.source } });
          }
        }
      }
    }

    for (const task of tasks) {
      // Use dueDate if available, otherwise fall back to createdAt so every task appears on the calendar
      const rawDate = task.dueDate || task.createdAt;
      if (rawDate) {
        const d = rawDate.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({ id: `task-${task.id}`, type: "task", title: task.title, date: d, allDay: true, color: task.priority === "high" ? "#A13544" : task.priority === "medium" ? "#BB653B" : "#797876", category: "task", description: task.description, completed: task.status === "done", linkedProfiles: task.linkedProfiles, sourceId: task.id, meta: { priority: task.priority, status: task.status } });
        }
      }
    }

    // Wave 16 — prefer persisted obligation_occurrences when they exist.
    // Falls back to virtual generation only for obligations that haven't been
    // materialized yet (legacy data). Occurrences carry per-instance status
    // so the calendar can visually distinguish done / skipped / late.
    const { data: occRows } = await this.supabase
      .from("obligation_occurrences")
      .select("id,obligation_id,due_at,original_due_at,status,actual_amount")
      .eq("user_id", this.userId)
      .gte("due_at", startDate)
      .lte("due_at", endDate);
    const occByOb = new Map<string, any[]>();
    for (const r of (occRows || [])) {
      const arr = occByOb.get(r.obligation_id) || [];
      arr.push(r);
      occByOb.set(r.obligation_id, arr);
    }
    const KIND_COLORS: Record<string, string> = {
      bill: "#BB653B", subscription: "#5591C7", loan_payment: "#A13544",
      medication: "#6DAA45", maintenance: "#797876", appointment: "#A86FDF",
      habit: "#20808D", doc_expiration: "#D19900", task: "#4F98A3",
    };
    const STATUS_TINT: Record<string, string> = {
      done: "#6DAA45", skipped: "#797876", late: "#A13544", pending: "", rescheduled: "#A86FDF",
    };

    for (const ob of obligations) {
      const kind = (ob as any).kind || "bill";
      const baseColor = KIND_COLORS[kind] || "#BB653B";
      const occs = occByOb.get(ob.id) || [];
      const matchedDates = new Set<string>();

      // Emit a calendar item for every persisted occurrence.
      for (const occ of occs) {
        matchedDates.add(occ.original_due_at);
        const color = STATUS_TINT[occ.status] || baseColor;
        items.push({
          id: `obligation-${ob.id}-${occ.due_at}`,
          type: "obligation", title: `${ob.name} — $${ob.amount}`,
          date: occ.due_at, allDay: true, color, category: ob.category,
          description: occ.status === "done" ? "Paid"
            : occ.status === "skipped" ? "Skipped"
            : occ.status === "rescheduled" ? "Rescheduled"
            : occ.status === "late" ? `OVERDUE — $${ob.amount}`
            : ob.autopay ? "Autopay enabled" : `$${ob.amount} due`,
          completed: occ.status === "done",
          linkedProfiles: ob.linkedProfiles, sourceId: ob.id,
          meta: { amount: ob.amount, frequency: ob.frequency, autopay: ob.autopay, kind, occurrenceId: occ.id, status: occ.status }
        });
      }

      // Fallback virtual generation for obligations without materialized rows.
      // Keeps the calendar populated for legacy data until the next mutation
      // triggers materialization.
      if (occs.length === 0) {
        const baseDate = ob.nextDueDate.slice(0, 10);
        if (baseDate >= startDate && baseDate <= endDate) {
          items.push({ id: `obligation-${ob.id}-${baseDate}`, type: "obligation", title: `${ob.name} — $${ob.amount}`, date: baseDate, allDay: true, color: baseColor, category: ob.category, description: ob.autopay ? "Autopay enabled" : `$${ob.amount} due`, linkedProfiles: ob.linkedProfiles, sourceId: ob.id, meta: { amount: ob.amount, frequency: ob.frequency, autopay: ob.autopay, kind } });
        }
        if (ob.frequency !== "once") {
          const base = parseLocalDate(ob.nextDueDate.slice(0, 10));
          for (let i = 1; i <= 24; i++) {
            const next = new Date(base);
            switch (ob.frequency) {
              case "weekly": next.setDate(next.getDate() + i * 7); break;
              case "biweekly": next.setDate(next.getDate() + i * 14); break;
              case "monthly": next.setMonth(next.getMonth() + i); break;
              case "quarterly": next.setMonth(next.getMonth() + i * 3); break;
              case "yearly": next.setFullYear(next.getFullYear() + i); break;
            }
            const nextStr = next.toLocaleDateString('en-CA');
            if (nextStr > endDate) break;
            if (nextStr >= startDate) {
              items.push({ id: `obligation-${ob.id}-${nextStr}`, type: "obligation", title: `${ob.name} — $${ob.amount}`, date: nextStr, allDay: true, color: baseColor, category: ob.category, description: ob.autopay ? "Autopay enabled" : `$${ob.amount} due`, linkedProfiles: ob.linkedProfiles, sourceId: ob.id, meta: { amount: ob.amount, frequency: ob.frequency, autopay: ob.autopay, kind } });
            }
          }
        }
      }
    }

    // Habits intentionally NOT emitted as calendar items — they live on their
    // own page and clutter the calendar with repeating noise. Re-enable here
    // if a future view wants them, but the calendar tab does not.

    // ── Dedup: remove events that duplicate an obligation on the same date ──
    // Build a set of obligation fingerprints (normalized title + date)
    const obligationFingerprints = new Set<string>();
    for (const item of items) {
      if (item.type === "obligation") {
        // Normalize: strip emoji, $amounts, and extra whitespace for matching
        const normTitle = item.title.replace(/[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]/g, "").replace(/\s*[\u2014-]\s*\$[\d.]+/, "").replace(/\s+/g, " ").trim().toLowerCase();
        obligationFingerprints.add(`${normTitle}::${item.date}`);
      }
    }
    // Filter out events that match an obligation's fingerprint
    const dedupedItems = items.filter(item => {
      if (item.type !== "event") return true; // Keep non-events
      const normTitle = item.title.replace(/[\uD83C-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]/g, "").replace(/\s*[\u2014-]\s*\$[\d.]+/, "").replace(/\s+/g, " ").trim().toLowerCase();
      const fp = `${normTitle}::${item.date}`;
      // Also check if event title contains any obligation name
      for (const ofp of obligationFingerprints) {
        const [oName] = ofp.split("::");
        if (normTitle.includes(oName) && item.date === ofp.split("::")[1]) return false;
      }
      return !obligationFingerprints.has(fp);
    });
    // Also dedup obligations with same name+date (keep only first)
    const seenObligations = new Set<string>();
    const finalItems = dedupedItems.filter(item => {
      if (item.type === "obligation") {
        const key = `${item.title}::${item.date}`;
        if (seenObligations.has(key)) return false;
        seenObligations.add(key);
      }
      return true;
    });
    items.length = 0;
    items.push(...finalItems);

    // ── Document expiration dates ──
    const documents = await this.getDocuments();
    for (const doc of documents) {
      const expField = doc.expirationDate || doc.fields?.expirationDate;
      if (expField) {
        // Parse date (could be MM/DD/YYYY or YYYY-MM-DD)
        let expDate: string;
        if (expField.includes('/')) {
          const [m, d, y] = expField.split('/');
          expDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        } else {
          expDate = expField.slice(0, 10);
        }
        if (expDate >= startDate && expDate <= endDate) {
          items.push({
            id: `doc-expiry-${doc.id}`, type: "event", title: `📄 ${doc.title || doc.name} expires`,
            date: expDate, allDay: true, color: "#A13544", category: "document",
            description: `Document expiration`, linkedProfiles: doc.linkedProfiles || [],
            sourceId: doc.id, meta: { docType: doc.type }
          });
        }
      }
    }

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
        .eq('user_id', this.userId);
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

    // ── Profile-derived virtual events ──────────────────────────
    // Build fingerprint set from existing stored events to prevent duplicates
    const storedEventFPs = new Set<string>();
    for (const item of items) {
      if (item.type === "event") storedEventFPs.add(`${item.title.toLowerCase().trim()}::${item.date}`);
    }
    const addVirtualEvent = (item: CalendarTimelineItem) => {
      const fp = `${item.title.toLowerCase().trim()}::${item.date}`;
      if (!storedEventFPs.has(fp)) items.push(item);
    };
    for (const profile of profiles) {
      const f = profile.fields || {};

      // Person / Self → birthday (yearly)
      if ((profile.type === "person" || profile.type === "self") && f.birthday) {
        const bday = f.birthday.slice(0, 10); // YYYY-MM-DD
        // Generate for current year of the view range
        const startY = parseInt(startDate.slice(0, 4), 10);
        const endY = parseInt(endDate.slice(0, 4), 10);
        for (let y = startY; y <= endY; y++) {
          const d = `${y}-${bday.slice(5, 10)}`;
          if (d >= startDate && d <= endDate) {
            addVirtualEvent({ id: `profile-birthday-${profile.id}-${d}`, type: "event", title: `🎂 ${profile.name}'s Birthday`, date: d, allDay: true, color: "#A86FDF", category: "family", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: profile.type } });
          }
        }
      }

      // Medical → nextVisit
      if (profile.type === "medical" && f.nextVisit) {
        const d = f.nextVisit.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          addVirtualEvent({ id: `profile-medical-${profile.id}-${d}`, type: "event", title: `🏥 ${profile.name} — Visit`, date: d, allDay: true, color: "#6DAA45", category: "health", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "medical" } });
        }
      }

      // Vehicle → nextService
      if (profile.type === "vehicle" && f.nextService) {
        const d = f.nextService.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          addVirtualEvent({ id: `profile-vehicle-${profile.id}-${d}`, type: "event", title: `🚗 ${profile.name} — Service`, date: d, allDay: true, color: "#BB653B", category: "other", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "vehicle" } });
        }
      }

      // Subscription → renewalDate
      if (profile.type === "subscription" && f.renewalDate) {
        const d = f.renewalDate.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          addVirtualEvent({ id: `profile-subscription-${profile.id}-${d}`, type: "event", title: `🔄 ${profile.name} — Renewal`, date: d, allDay: true, color: "#D19900", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "subscription" } });
        }
      }

      // Loan → startDate or nextPayment
      if ((profile.type === "loan" || profile.type === "liability") && (f.nextPayment || f.startDate)) {
        const d = (f.nextPayment || f.startDate).slice(0, 10);
        if (d >= startDate && d <= endDate) {
          const label = f.nextPayment ? "Payment Due" : "Start Date";
          addVirtualEvent({ id: `profile-loan-${profile.id}-${d}`, type: "event", title: `💰 ${profile.name} — ${label}`, date: d, allDay: true, color: "#BB653B", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "loan" } });
        }
      }

      // Pet → nextVetVisit
      if (profile.type === "pet" && f.nextVetVisit) {
        const d = f.nextVetVisit.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          addVirtualEvent({ id: `profile-pet-${profile.id}-${d}`, type: "event", title: `🐾 ${profile.name} — Vet Visit`, date: d, allDay: true, color: "#6DAA45", category: "health", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "pet" } });
        }
      }

      // Property → insurance expiry, lease end, etc.
      if (profile.type === "property") {
        if (f.insuranceExpiry) {
          const d = f.insuranceExpiry.slice(0, 10);
          if (d >= startDate && d <= endDate) {
            addVirtualEvent({ id: `profile-property-ins-${profile.id}-${d}`, type: "event", title: `🏠 ${profile.name} — Insurance Expiry`, date: d, allDay: true, color: "#BB653B", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "property" } });
          }
        }
        if (f.leaseEnd) {
          const d = f.leaseEnd.slice(0, 10);
          if (d >= startDate && d <= endDate) {
            addVirtualEvent({ id: `profile-property-lease-${profile.id}-${d}`, type: "event", title: `🏠 ${profile.name} — Lease End`, date: d, allDay: true, color: "#A13544", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "property" } });
          }
        }
      }

      // Investment → maturityDate
      if (profile.type === "investment" && f.maturityDate) {
        const d = f.maturityDate.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          addVirtualEvent({ id: `profile-investment-${profile.id}-${d}`, type: "event", title: `📈 ${profile.name} — Maturity`, date: d, allDay: true, color: "#D19900", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "investment" } });
        }
      }

      // Account → expirationDate
      if (profile.type === "account" && f.expirationDate) {
        const d = f.expirationDate.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          addVirtualEvent({ id: `profile-account-${profile.id}-${d}`, type: "event", title: `⚠️ ${profile.name} — Expires`, date: d, allDay: true, color: "#A13544", category: "other", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "account" } });
        }
      }

      // Asset → warrantyExpiry
      if (profile.type === "asset" && f.warrantyExpiry) {
        const d = f.warrantyExpiry.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          addVirtualEvent({ id: `profile-asset-${profile.id}-${d}`, type: "event", title: `🛡️ ${profile.name} — Warranty Expiry`, date: d, allDay: true, color: "#BB653B", category: "other", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "asset" } });
        }
      }
    }

    // ── Document-extracted dates (expiry, renewal, due, appointment) ──────
    // documents already fetched above for expiration dates
    const DATE_KEY_RE = /expir|renew|due|valid.until|appoint|next.visit|warranty/i;
    const DATE_VAL_RE = /^\d{4}[-/]\d{2}[-/]\d{2}/;
    for (const doc of documents) {
      const ed = doc.extractedData as Record<string, any> | null;
      if (!ed) continue;
      for (const [key, val] of Object.entries(ed)) {
        if (!DATE_KEY_RE.test(key)) continue;
        const strVal = String(val || "");
        const dateMatch = strVal.match(/(\d{4})[-/](\d{2})[-/](\d{2})/);
        if (!dateMatch) continue;
        const d = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
        if (d < startDate || d > endDate) continue;
        const label = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
        const emoji = /expir/i.test(key) ? "⚠️" : /renew/i.test(key) ? "🔄" : /due/i.test(key) ? "📅" : "📄";
        items.push({
          id: `doc-date-${doc.id}-${key}`,
          type: "event",
          title: `${emoji} ${doc.name} — ${label}`,
          date: d,
          allDay: true,
          color: /expir/i.test(key) ? "#A13544" : "#BB653B",
          category: "other" as any,
          linkedProfiles: doc.linkedProfiles || [],
          sourceId: doc.id,
          meta: { source: "document", documentType: doc.type, field: key },
        });
      }
    }

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
      // PERF: Exclude file_data from list queries — base64 blobs can be 10MB+ each.
      // Only getDocument(id) returns file_data when specifically needed.
      // PERF (durable-fix-phase1): DB pushdown via idx_documents_linked_profiles_gin.
      let q = this.supabase.from("documents")
        .select("id, user_id, name, type, mime_type, extracted_data, linked_profiles, tags, created_at, updated_at")
        .eq("user_id", this.userId)
        .is("deleted_at", null);
      q = this._applyProfileFilter(q, profileIds);
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map(r => this.rowToDocument({ ...r, file_data: "" }));
    });
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

  async createDocument(data: any): Promise<Document> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
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
    const { error } = await this.supabase.from("documents").update({
      name: merged.name, type: merged.type, mime_type: merged.mimeType,
      file_data: merged.fileData, extracted_data: merged.extractedData,
      linked_profiles: merged.linkedProfiles, tags: merged.tags,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    return this.getDocument(id);
  }

  async deleteDocument(id: string): Promise<boolean> {
    if (!this.userId) throw new Error('Unauthorized: storage context missing userId');
    /* D1: clean up entity_links rows that reference this document */
    await this.cleanupEntityLinks("document", id);
    // Capture storage_path BEFORE we mutate the row — we need it to remove the
    // underlying file from the Supabase Storage bucket. Without this, deleted
    // documents leave their files behind in the bucket forever, silently
    // accumulating storage cost and potential PII leakage if a stale signed
    // URL is ever resurfaced.
    let storagePathToRemove: string | undefined;
    try {
      const doc = await this.getDocument(id);
      if (doc) {
        storagePathToRemove = doc.storagePath;
        // PERF FIX: was sequential getProfile + update per linked profile.
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
    // FIX 4 Phase 2: profile_documents junction dropped.
    // Soft delete the document. Clear file_data to remove residual base64 PII
    // from the row (the underlying Storage blob is removed below). Also clear
    // linked_profiles so the soft-deleted row's two ownership representations
    // stay in lockstep with the wiped junction — same pattern as deleteExpense.
    const { error } = await this.supabase.from("documents").update({ deleted_at: new Date().toISOString(), file_data: '', linked_profiles: [] }).eq("id", id).eq("user_id", this.userId);
    if (error) {
      console.error(`[deleteDocument] Supabase error for ${id}:`, error.message);
      return false;
    }
    // Best-effort: remove the underlying file from Storage. We do this AFTER
    // the soft-delete succeeds so a transient Storage error never blocks the
    // user-visible delete. We log but don't fail — the row is already gone.
    if (storagePathToRemove) {
      try {
        const { error: rmErr } = await this.supabase.storage.from(DOCUMENTS_BUCKET).remove([storagePathToRemove]);
        if (rmErr) console.error(`[deleteDocument] Storage remove failed for ${storagePathToRemove}:`, rmErr.message);
      } catch (e: any) {
        console.error(`[deleteDocument] Storage remove exception for ${storagePathToRemove}:`, e.message);
      }
    }
    return true; // Supabase delete succeeds even if 0 rows matched — that's fine, doc is gone
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
      habitsQuery = this._applyProfileFilter(habitsQuery, profileIds);
      // Fetch habits and ALL checkins in 2 parallel queries (not N+1)
      const [habitsResult, checkinsResult] = await Promise.all([
        habitsQuery,
        this.supabase.from("habit_checkins").select("*").eq("user_id", this.userId).order("date", { ascending: true }),
      ]);
      if (habitsResult.error) throw habitsResult.error;
      const checkinsByHabit = new Map<string, any[]>();
      for (const c of checkinsResult.data || []) {
        const arr = checkinsByHabit.get(c.habit_id) || [];
        arr.push(c);
        checkinsByHabit.set(c.habit_id, arr);
      }
      return (habitsResult.data || []).map(r =>
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
      current_streak: 0, longest_streak: 0,
      linked_profiles: linkedProfiles,
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
    // Recalculate streaks (with targetPerDay support)
    const { data: allCheckins } = await this.supabase.from("habit_checkins").select("date").eq("habit_id", habitId).eq("user_id", this.userId);
    const { current, longest } = calculateStreak(allCheckins || [], habit.targetPerDay || 1);
    await this.supabase.from("habits").update({
      current_streak: current, longest_streak: Math.max(longest, habit.longestStreak),
    }).eq("id", habitId).eq("user_id", this.userId);
    this.logActivity("habit", `Checked in: ${habit.name}`);
    return { id, date: checkinDate, value, notes, timestamp: ts };
  }

  async deleteHabitCheckin(habitId: string, checkinId: string): Promise<boolean> {
    const habit = await this.getHabit(habitId);
    if (!habit) return false;
    const { error } = await this.supabase.from("habit_checkins").delete().eq("id", checkinId).eq("habit_id", habitId).eq("user_id", this.userId);
    if (error) return false;
    // Recalculate streaks after deletion
    const { data: allCheckins } = await this.supabase.from("habit_checkins").select("date").eq("habit_id", habitId).eq("user_id", this.userId);
    const { current, longest } = calculateStreak(allCheckins || [], habit.targetPerDay || 1);
    await this.supabase.from("habits").update({
      current_streak: current, longest_streak: longest,
    }).eq("id", habitId).eq("user_id", this.userId);
    return true;
  }

  async updateHabit(id: string, data: Partial<Habit>): Promise<Habit | undefined> {
    const existing = await this.getHabit(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    const { error } = await this.supabase.from("habits").update({
      name: merged.name, icon: merged.icon || null, color: merged.color || null,
      frequency: merged.frequency, target_days: merged.targetDays || null,
      target_per_day: merged.targetPerDay || existing.targetPerDay || 1,
      linked_profiles: merged.linkedProfiles || existing.linkedProfiles || [],
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    return this.getHabit(id);
  }

  async deleteHabit(id: string): Promise<boolean> {
    /* D1: clean up entity_links rows that reference this habit */
    await this.cleanupEntityLinks("habit", id);
    // Cascade delete habit_checkins — they are per-habit metadata with no value once
    // the habit is gone. Leaving them would orphan rows that show up in analytics /
    // AI summaries / calendar timeline queries that hit habit_checkins directly.
    await this.supabase.from("habit_checkins").delete().eq("habit_id", id).eq("user_id", this.userId);
    // Soft delete the habit row itself — set deleted_at instead of removing it so
    // restoreHabit still works (the row is recoverable; the checkins are not).
    const { error } = await this.supabase.from("habits").update({ deleted_at: new Date().toISOString() }).eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  async restoreHabit(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("habits").update({ deleted_at: null }).eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // OBLIGATIONS
  // ============================================================
  async getObligations(profileIds?: string[]): Promise<Obligation[]> {
    return this.memo(`getObligations${this._fk(profileIds)}`, async () => {
      // PERF (durable-fix-phase1): DB pushdown via idx_obligations_linked_profiles_gin.
      let obligationsQuery = this.supabase.from("obligations").select("*").eq("user_id", this.userId);
      obligationsQuery = this._applyProfileFilter(obligationsQuery, profileIds);
      // Fetch obligations and ALL payments in 2 parallel queries (not N+1)
      const [obligationsResult, paymentsResult] = await Promise.all([
        obligationsQuery,
        this.supabase.from("obligation_payments").select("*").eq("user_id", this.userId).order("date", { ascending: true }),
      ]);
      if (obligationsResult.error) throw obligationsResult.error;
      const paymentsByObligation = new Map<string, any[]>();
      for (const p of paymentsResult.data || []) {
        const arr = paymentsByObligation.get(p.obligation_id) || [];
        arr.push(p);
        paymentsByObligation.set(p.obligation_id, arr);
      }
      return (obligationsResult.data || []).map(r =>
        this.rowToObligation(r, (paymentsByObligation.get(r.id) || []).map(p => this.rowToPayment(p)))
      );
    });
  }

  async getObligation(id: string): Promise<Obligation | undefined> {
    const { data, error } = await this.supabase.from("obligations").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    const { data: payments } = await this.supabase.from("obligation_payments").select("*").eq("obligation_id", id).eq("user_id", this.userId).order("date", { ascending: true });
    return this.rowToObligation(data, (payments || []).map(p => this.rowToPayment(p)));
  }

  async createObligation(data: InsertObligation): Promise<Obligation> {
    const id = randomUUID();
    const now = new Date().toISOString();
    // Auto-link to self profile if no profiles specified
    let linkedProfiles = (data as any).linkedProfiles || [];
    if (linkedProfiles.length === 0) {
      const selfProfile = await this.getSelfProfile();
      if (selfProfile) linkedProfiles = [selfProfile.id];
    }
    const kind = (data as any).kind || "bill";
    const { error } = await this.supabase.from("obligations").insert({
      id, user_id: this.userId, name: data.name, amount: data.amount,
      frequency: data.frequency || "monthly", category: data.category || "general",
      kind,
      next_due_date: data.nextDueDate, autopay: data.autopay || false,
      // Bug fix (AI e2e): the DB column is NOT NULL, but the AI path
      // calls createObligation without supplying leadTimeDays and the
      // insert blew up with "null value in column lead_time_days". The
      // read path already defaults to 3 when missing (see getObligations),
      // so write the same default here.
      lead_time_days: (data as any).leadTimeDays ?? 3,
      auto_log_expense: (data as any).autoLogExpense ?? false,
      linked_asset_id: (data as any).linkedAssetId || null,
      linked_liability_id: (data as any).linkedLiabilityId || null,
      linked_document_id: (data as any).linkedDocumentId || null,
      recurrence_end: (data as any).recurrenceEnd || null,
      currency: (data as any).currency || "USD",
      icon: (data as any).icon || null,
      linked_profiles: linkedProfiles, notes: data.notes || null, created_at: now,
    });
    if (error) throw error;
    for (const pId of linkedProfiles) {
      await this.linkProfileTo(pId, "obligation", id);
    }
    this.logActivity("obligation", `Created obligation: ${data.name}`);

    // Wave 17 — materialize the FULL series. With recurrence_end set, the
    // engine expands every occurrence (e.g. 12 monthly for a 1-year housing
    // bill). Without it, the engine uses its 2-year default horizon. Single
    // source of truth for calendar / dashboard / reminder feeds.
    try {
      const { materializeOccurrences } = await import("./obligation-engine");
      await materializeOccurrences(this.supabase, this.userId, id);
    } catch (e: any) {
      console.error("[obligations] materialize failed (non-fatal):", e?.message || e);
    }

    // NOTE: Calendar events for obligations are generated dynamically by
    // getCalendarTimeline() — no need to create a stored event here.
    // This avoids duplicate entries on the calendar view.

    return (await this.getObligation(id))!;
  }

  async updateObligation(id: string, data: Partial<Obligation>): Promise<Obligation | undefined> {
    const existing = await this.getObligation(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    const { error } = await this.supabase.from("obligations").update({
      name: merged.name, amount: merged.amount, frequency: merged.frequency,
      category: merged.category,
      kind: merged.kind,
      next_due_date: merged.nextDueDate,
      autopay: merged.autopay, linked_profiles: merged.linkedProfiles,
      lead_time_days: merged.leadTimeDays,
      auto_log_expense: merged.autoLogExpense,
      linked_asset_id: merged.linkedAssetId || null,
      linked_liability_id: merged.linkedLiabilityId || null,
      linked_document_id: merged.linkedDocumentId || null,
      recurrence_end: merged.recurrenceEnd || null,
      currency: merged.currency || "USD",
      icon: merged.icon || null,
      notes: merged.notes || null,
      // Bug fix: status (active|paused|...) was previously dropped on update,
      // making the pause/resume button a no-op. Forward the merged value so
      // PATCH /api/obligations/:id { status } actually persists.
      status: merged.status || "active",
      updated_at: new Date().toISOString(),
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth; no junction sync.
    // Re-materialize when cadence or due date changes — keeps calendar correct.
    if (data.frequency !== undefined || data.nextDueDate !== undefined || data.recurrenceEnd !== undefined) {
      try {
        const { materializeOccurrences } = await import("./obligation-engine");
        await materializeOccurrences(this.supabase, this.userId, id);
      } catch (e: any) {
        console.error("[obligations] re-materialize failed (non-fatal):", e?.message || e);
      }
    }
    return this.getObligation(id);
  }

  async payObligation(obligationId: string, amount: number, method?: string, confirmationNumber?: string, date?: string): Promise<ObligationPayment | undefined> {
    const ob = await this.getObligation(obligationId);
    if (!ob) return undefined;
    const id = randomUUID();
    const today = date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const { error } = await this.supabase.from("obligation_payments").insert({
      id, user_id: this.userId, obligation_id: obligationId, amount, date: today,
      method: method || null, confirmation_number: confirmationNumber || null,
    });
    if (error) throw error;

    // Wave 17 — ALSO mark the earliest pending/late occurrence as done so the
    // user actually sees the late item disappear from their list. Previously
    // we only advanced next_due_date which didn't touch obligation_occurrences,
    // so the user saw "nothing happened" after marking paid. Find the earliest
    // un-done occurrence (preferring late > pending, oldest first) and link the
    // new payment to it.
    try {
      const { data: targetOcc } = await this.supabase
        .from("obligation_occurrences")
        .select("id")
        .eq("user_id", this.userId)
        .eq("obligation_id", obligationId)
        .in("status", ["pending", "late"])
        .order("due_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (targetOcc?.id) {
        await this.supabase.from("obligation_occurrences").update({
          status: "done",
          completed_at: new Date().toISOString(),
          actual_amount: amount,
          payment_id: id,
          updated_at: new Date().toISOString(),
        }).eq("id", targetOcc.id).eq("user_id", this.userId);
      }
    } catch (e: any) {
      console.error("[payObligation] occurrence mark failed (non-fatal):", e?.message || e);
    }
    // Advance next due date. "once" obligations don't recur — leave them.
    // For everything else, advance from the LATER of (current next_due_date,
    // today). This keeps a stuck overdue bill from staying overdue forever
    // when the user marks it paid: we jump to the next future cycle.
    if (ob.frequency && ob.frequency !== "once") {
      const todayLocal = new Date();
      todayLocal.setHours(0, 0, 0, 0);
      // parseLocalDate-style: avoid UTC drift by constructing in local TZ.
      const [y, mo, d] = String(ob.nextDueDate).slice(0, 10).split("-").map(Number);
      let nextDue = new Date(y || 1970, (mo || 1) - 1, d || 1, 0, 0, 0, 0);
      // Advance the cycle at least once; keep advancing until strictly after today.
      for (let i = 0; i < 600; i++) {
        switch (ob.frequency) {
          case "weekly": nextDue.setDate(nextDue.getDate() + 7); break;
          case "biweekly": nextDue.setDate(nextDue.getDate() + 14); break;
          case "monthly": nextDue.setMonth(nextDue.getMonth() + 1); break;
          case "quarterly": nextDue.setMonth(nextDue.getMonth() + 3); break;
          case "yearly": nextDue.setFullYear(nextDue.getFullYear() + 1); break;
          default: nextDue.setMonth(nextDue.getMonth() + 1); break;
        }
        if (nextDue > todayLocal) break;
      }
      // Format as YYYY-MM-DD in local time — not UTC — so a date computed
      // in PT doesn't get pushed back a day when toISOString() converts to UTC.
      const yy = nextDue.getFullYear();
      const mm = String(nextDue.getMonth() + 1).padStart(2, "0");
      const dd = String(nextDue.getDate()).padStart(2, "0");
      const newDateStr = `${yy}-${mm}-${dd}`;
      // Use .select() so we can VERIFY the update actually ran. The previous
      // version silently ignored update errors — the user paid 3 times in a
      // row because next_due_date never advanced and the bill kept showing as
      // overdue. Log loudly if the update failed.
      const { data: updated, error: upErr } = await this.supabase
        .from("obligations")
        .update({ next_due_date: newDateStr, updated_at: new Date().toISOString() })
        .eq("id", obligationId)
        .eq("user_id", this.userId)
        .select("id, next_due_date")
        .single();
      if (upErr) {
        console.error("[payObligation] failed to advance next_due_date:", { obligationId, newDateStr, error: upErr.message });
      } else if (!updated || updated.next_due_date !== newDateStr) {
        console.error("[payObligation] next_due_date update returned unexpected result:", { obligationId, newDateStr, updated });
      }
    }
    this.logActivity("obligation", `Paid ${ob.name}: $${amount}`);
    return { id, amount, date: today, method, confirmationNumber };
  }

  async deleteObligation(id: string): Promise<boolean> {
    /* D1: clean up entity_links rows that reference this obligation */
    await this.cleanupEntityLinks("obligation", id);
    await this.supabase.from("obligation_payments").delete().eq("obligation_id", id).eq("user_id", this.userId);
    const { error } = await this.supabase.from("obligations").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // ARTIFACTS
  // ============================================================
  async getArtifacts(profileIds?: string[]): Promise<Artifact[]> {
    return this.memo(`getArtifacts${this._fk(profileIds)}`, async () => {
      // PERF (durable-fix-phase1): DB pushdown via idx_artifacts_linked_profiles_gin.
      let q = this.supabase.from("artifacts").select("*").eq("user_id", this.userId);
      q = this._applyProfileFilter(q, profileIds);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []).map(r => this.rowToArtifact(r));
    });
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    const { data, error } = await this.supabase.from("artifacts").select("*").eq("id", id).eq("user_id", this.userId).single();
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

    const { error } = await this.supabase.from("artifacts").update({
      type: merged.type, title: merged.title, content: merged.content,
      items: merged.items, tags: merged.tags, linked_profiles: merged.linkedProfiles,
      pinned: merged.pinned,
      metadata,
      updated_at: now,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    // FIX 4 Phase 2: linked_profiles JSONB is the sole source of truth; no junction sync.
    return this.getArtifact(id);
  }

  async toggleChecklistItem(artifactId: string, itemId: string): Promise<Artifact | undefined> {
    const a = await this.getArtifact(artifactId);
    if (!a) return undefined;
    const item = a.items.find(i => i.id === itemId);
    if (item) item.checked = !item.checked;
    const now = new Date().toISOString();
    await this.supabase.from("artifacts").update({ items: a.items, updated_at: now }).eq("id", artifactId).eq("user_id", this.userId);
    return this.getArtifact(artifactId);
  }

  async deleteArtifact(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("artifacts").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // JOURNAL
  // ============================================================
  async getJournalEntries(profileIds?: string[]): Promise<JournalEntry[]> {
    return this.memo(`getJournalEntries${this._fk(profileIds)}`, async () => {
      // PERF (durable-fix-phase1): DB pushdown via idx_journal_entries_linked_profiles_gin.
      // journal_entries.linked_profiles is a PG ARRAY (text[]), not jsonb —
      // see _applyProfileFilter doc for syntax.
      let q = this.supabase.from("journal_entries").select("*").eq("user_id", this.userId);
      q = this._applyProfileFilter(q, profileIds, "array");
      const { data, error } = await q.order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map(r => this.rowToJournalEntry(r));
    });
  }

  private async getJournalEntry(id: string): Promise<JournalEntry | undefined> {
    const { data, error } = await this.supabase.from("journal_entries").select("*").eq("id", id).eq("user_id", this.userId).single();
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
    const { error } = await this.supabase.from("journal_entries").update({
      date: merged.date, mood: merged.mood, content: merged.content,
      tags: merged.tags, energy: merged.energy ?? null,
      gratitude: merged.gratitude || null, highlights: merged.highlights || null,
      ...((data as any).linkedProfiles ? { linked_profiles: (data as any).linkedProfiles } : {}),
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
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
      const { data, error } = await this.supabase.from("memories").select("*").eq("user_id", this.userId);
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
    const q = query.toLowerCase();
    const memories = await this.getMemories();
    return memories.filter(m =>
      (m.key || "").toLowerCase().includes(q) ||
      m.value.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q)
    );
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
    // PERF (durable-fix-phase1): DB pushdown via idx_goals_linked_profiles.
    let q = this.supabase.from("goals").select("*").eq("user_id", this.userId);
    q = this._applyProfileFilter(q, profileIds);
    const { data, error } = await q.order("created_at", { ascending: false });
    if (error) throw error;
    const goals = (data || []).map(r => this.rowToGoal(r));
    for (const goal of goals) {
      if (goal.status === "active") {
        goal.current = await this.computeGoalProgress(goal);
      }
    }
    return goals;
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    const { data, error } = await this.supabase.from("goals").select("*").eq("id", id).eq("user_id", this.userId).single();
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
    if ((data as any).linkedProfiles !== undefined) updates.linked_profiles = (data as any).linkedProfiles;
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

    const { error } = await this.supabase.from("goals").update(updates).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    return this.getGoal(id);
  }

  async deleteGoal(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("goals").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  private async computeGoalProgress(goal: Goal): Promise<number> {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    switch (goal.type) {
      case "weight_loss":
      case "weight_gain": {
        if (!goal.trackerId) return goal.current;
        const tracker = await this.getTracker(goal.trackerId);
        if (!tracker || tracker.entries.length === 0) return goal.current;
        const latest = tracker.entries[tracker.entries.length - 1];
        return parseFloat(latest.values.weight || latest.values.value || "0") || goal.current;
      }
      case "habit_streak": {
        if (!goal.habitId) return goal.current;
        const habit = await this.getHabit(goal.habitId);
        if (!habit) return goal.current;
        return habit.currentStreak;
      }
      case "fitness_distance": {
        if (!goal.trackerId) return goal.current;
        const tracker = await this.getTracker(goal.trackerId);
        if (!tracker) return goal.current;
        const entries = tracker.entries.filter(e => {
          const d = new Date(e.timestamp);
          return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
        });
        return entries.reduce((sum, e) => sum + (parseFloat(e.values.distance || e.computed?.distanceMiles || "0")), 0);
      }
      case "fitness_frequency": {
        if (!goal.trackerId) return goal.current;
        const tracker = await this.getTracker(goal.trackerId);
        if (!tracker) return goal.current;
        return tracker.entries.filter(e => {
          const d = new Date(e.timestamp);
          return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
        }).length;
      }
      case "spending_limit": {
        if (!goal.category) return goal.current;
        const expenses = await this.getExpenses();
        return expenses.filter(e => {
          const d = new Date(e.date);
          return d.getMonth() === thisMonth && d.getFullYear() === thisYear &&
            e.category.toLowerCase() === (goal.category || "").toLowerCase();
        }).reduce((sum, e) => sum + e.amount, 0);
      }
      case "tracker_target": {
        if (!goal.trackerId) return goal.current;
        const tracker = await this.getTracker(goal.trackerId);
        if (!tracker || tracker.entries.length === 0) return goal.current;
        const latest = tracker.entries[tracker.entries.length - 1];
        if (!tracker.fields?.length) return goal.current;
        const primary = tracker.fields.find((f: any) => f.isPrimary) || tracker.fields.find((f: any) => f.type === "number");
        if (primary) return parseFloat(latest.values[primary.name] || "0") || goal.current;
        return parseFloat(Object.values(latest.values)[0] as string || "0") || goal.current;
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
    const { error } = await this.supabase.from("domains").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
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
    const { data, error } = await this.supabase.from("entity_links").select("*").eq("user_id", this.userId)
      .or(`and(source_type.eq.${entityType},source_id.eq.${entityId}),and(target_type.eq.${entityType},target_id.eq.${entityId})`)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(r => this.rowToEntityLink(r));
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
    const { error } = await this.supabase.from("entity_links").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
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
        case "document": entity = await this.getDocument(otherId); break;
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
  async getStats(filterProfileId?: string, filterProfileIds?: string[]): Promise<DashboardStats> {
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
    // Best-effort pushdown: if the caller passed a filter that contains NO
    // self profile, the unified rule reduces to "linked_profiles ∩
    // selection ≠ ∅" — which the GIN-indexed cs.[id] check enforces. When
    // self IS in the selection, orphans (linkedProfiles = []) must also pass,
    // so we conservatively skip DB pushdown and let the JS filter do its job.
    const allProfiles = await profilesPromise;
    const _selfIds = selfIdsFrom(allProfiles);
    const _selfInFilter = !!fpIds && fpIds.some(id => _selfIds.has(id));
    const _dbFilterIds = fpIds && !_selfInFilter ? fpIds : undefined;
    const [
      allTasks, allExpenses, allTrackers, allHabits, allObligations,
      journalEntries, allEvents, artifacts, memories,
    ] = await Promise.all([
      this.getTasks(_dbFilterIds), this.getExpenses(_dbFilterIds), this.getTrackers(undefined, _dbFilterIds),
      this.getHabits(_dbFilterIds), this.getObligations(_dbFilterIds), this.getJournalEntries(_dbFilterIds),
      this.getEvents(_dbFilterIds), this.getArtifacts(_dbFilterIds), this.getMemories(),
    ]);

    // Use the unified rule (shared/profile-filter.ts) so server stats agree
    // with the client's Finance/Calendar views — see getDashboardEnhanced for
    // the full rationale.
    const filterCtxStats = { selectedIds: fpIds || [], allProfiles };
    const matchesProfile = (linkedProfiles: string[]) =>
      passesProfileFilter(linkedProfiles, filterCtxStats);
    const tasks = allTasks.filter(t => matchesProfile(t.linkedProfiles));
    const expenses = allExpenses.filter(e => matchesProfile(e.linkedProfiles));
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
    const weekStartStr = weekStart.toISOString().slice(0, 10);
    const todayCompleted = allActiveHabits.filter(h => {
      if (h.frequency === "daily") {
        const tpd = h.targetPerDay || 1;
        return h.checkins.filter(c => c.date === todayStr2).length >= tpd;
      }
      // weekly: completed if any checkin exists this week
      return h.checkins.some(c => c.date >= weekStartStr && c.date <= todayStr2);
    }).length;
    const habitCompletionRate = allActiveHabits.length > 0 ? Math.round((todayCompleted / allActiveHabits.length) * 100) : 0;

    // BUG-20260528-upcoming-window: getStats() used a 7-day window while
    // getDashboardEnhanced() used 30 days. Tile count permanently differed
    // from popup count. Unified to 30 days via UPCOMING_BILL_WINDOW_DAYS.
    const upcomingCutoff = new Date(now.getTime() + UPCOMING_BILL_WINDOW_DAYS * MS_PER_DAY);
    const upcomingObs = obligations.filter(o => {
      const due = new Date(o.nextDueDate);
      return due <= upcomingCutoff;
    });
    // BUG-20260528-monthly-multipliers: previously used truncated 4.33/2.17.
    // Now uses exact fractions via shared toMonthlyAmount so this total
    // matches the Finance page and dashboard-enhanced.
    const monthlyObTotal = obligations.reduce(
      (s, o) => s + toMonthlyAmount(o.amount, o.frequency),
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
        ...tasks.filter(t => t.status === 'done').slice(-3).map(t => ({
          type: 'task_completed',
          description: `Completed: ${t.title}`,
          timestamp: t.createdAt,
        })),
        ...expenses.slice(-3).map(e => ({
          type: 'expense',
          description: `$${e.amount} — ${e.description}`,
          timestamp: e.date || e.createdAt,
        })),
      ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 10),
      totalHabits: habits.length,
      habitCompletionRate,
      totalObligations: obligations.length,
      upcomingObligations: upcomingObs.length,
      monthlyObligationTotal: Math.round(monthlyObTotal),
      journalStreak,
      currentMood,
      totalArtifacts: artifacts.length,
      totalMemories: memories.length,
    };
  }

  // ============================================================
  // ENHANCED DASHBOARD
  // ============================================================
  async getDashboardEnhanced(filterProfileId?: string, filterProfileIds?: string[]): Promise<any> {
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
    const _dbFilterIdsEnh = fpIds && !_selfInFilterEnh ? fpIds : undefined;
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
    const filterCtx = { selectedIds: fpIds || [], allProfiles };
    const matchesProfileEnhanced = (linkedProfiles: string[]) =>
      passesProfileFilter(linkedProfiles, filterCtx);
    const allTrackers = rawTrackers.filter(t => matchesProfileEnhanced(t.linkedProfiles));
    const allExpenses = rawExpenses.filter(e => matchesProfileEnhanced(e.linkedProfiles));
    const allObligations = rawObligations.filter(o => matchesProfileEnhanced(o.linkedProfiles));
    const allTasks = rawTasks.filter(t => matchesProfileEnhanced(t.linkedProfiles));
    const allEvents = rawEvents.filter(e => matchesProfileEnhanced(e.linkedProfiles));
    // Filter documents by profile
    const filteredDocs = documents.filter(d => matchesProfileEnhanced(d.linkedProfiles));
    const expiringDocs: any[] = [];
    for (const doc of filteredDocs) {
      const ed = doc.extractedData || {};
      const dateFields = ['expiration_date', 'expirationDate', 'expiry', 'expires', 'exp_date', 'expiration', 'valid_until', 'validUntil', 'end_date', 'endDate', 'renewal_date', 'renewalDate'];
      for (const key of Object.keys(ed)) {
        const lk = key.toLowerCase().replace(/[\s_-]+/g, '');
        const isDateField = dateFields.some(df => lk.includes(df.toLowerCase().replace(/[\s_-]+/g, '')));
        if (!isDateField) continue;
        const val = ed[key];
        if (!val || typeof val !== 'string') continue;
        const parsed = new Date(val);
        if (isNaN(parsed.getTime())) continue;
        const daysUntil = Math.ceil((parsed.getTime() - now.getTime()) / 86400000);
        expiringDocs.push({ documentId: doc.id, documentName: doc.name, documentType: doc.type, fieldName: key, expirationDate: val, daysUntil, status: daysUntil < 0 ? 'expired' : daysUntil <= 30 ? 'expiring_soon' : daysUntil <= 90 ? 'upcoming' : 'ok' });
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
      const recent = t.entries.filter(e => new Date(e.timestamp).getTime() >= sevenDaysAgoMs);
      const primaryField = t.fields.find((f: any) => f.isPrimary) || t.fields[0];
      if (!primaryField || recent.length === 0) continue;
      const values = recent.map(e => Number(e.values[primaryField.name])).filter(v => !isNaN(v));
      if (values.length === 0) continue;
      const latest = values[values.length - 1];
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const trend = values.length >= 2 ? (values[values.length - 1] - values[0]) : 0;
      // For hydration trackers, calculate today's total
      const isHydration = t.name.toLowerCase().includes('hydration') || t.name.toLowerCase().includes('water');
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
      let dailyTotal: number | undefined;
      if (isHydration) {
        dailyTotal = t.entries
          .filter(e => e.timestamp.startsWith(todayStr))
          .reduce((s, e) => s + (Number(e.values[primaryField.name]) || 0), 0);
      }
      healthSnapshot.push({ trackerId: t.id, name: t.name, category: t.category, unit: primaryField.unit || t.unit || '', latestValue: latest, average: Math.round(avg * 10) / 10, trend: trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat', trendValue: Math.round(Math.abs(trend) * 10) / 10, entryCount: recent.length, lastEntry: recent[recent.length - 1]?.timestamp, dailyTotal });
    }

    const monthlyExpenses = allExpenses.filter(e => (e.date || '').slice(0, 7) === userYearMonth);
    const spendByCategory: Record<string, number> = {};
    for (const e of monthlyExpenses) spendByCategory[e.category] = (spendByCategory[e.category] || 0) + e.amount;
    const totalMonthlySpend = monthlyExpenses.reduce((s, e) => s + e.amount, 0);

    // Previous month YYYY-MM, computed in the user's timezone
    const [yStr, mStr] = userYearMonth.split('-');
    const prevMonthIndex = parseInt(mStr, 10) - 2; // 0-indexed previous month
    const prevYear = prevMonthIndex < 0 ? parseInt(yStr, 10) - 1 : parseInt(yStr, 10);
    const prevMonth = ((prevMonthIndex % 12) + 12) % 12;
    const lastMonthYM = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}`;
    const lastMonthExpenses = allExpenses.filter(e => (e.date || '').slice(0, 7) === lastMonthYM);
    const lastMonthTotal = lastMonthExpenses.reduce((s, e) => s + e.amount, 0);

    const upcomingBills = allObligations.filter(o => { const due = new Date(o.nextDueDate); const daysUntil = Math.ceil((due.getTime() - now.getTime()) / 86400000); return daysUntil <= 30; }).sort((a, b) => new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime()).map(o => ({ id: o.id, name: o.name, amount: o.amount, dueDate: o.nextDueDate, daysUntil: Math.ceil((new Date(o.nextDueDate).getTime() - now.getTime()) / 86400000), autopay: o.autopay, category: o.category }));

    // BUG-20260528-monthly-multipliers: unify to exact 52/12, 26/12 via shared toMonthlyAmount.
    const monthlyObligationTotal = allObligations.reduce(
      (s, o) => s + toMonthlyAmount(o.amount, o.frequency),
      0,
    );

    const overdueTasks = allTasks.filter(t => { if (t.status === 'done' || !t.dueDate) return false; return new Date(t.dueDate) < now; }).map(t => ({ id: t.id, title: t.title, dueDate: t.dueDate!, priority: t.priority }));

    // BUG-NW-2/3 fix (2026-06-03): build asset / liability breakdown arrays here
    // so the Net Worth popup never recomputes its own per-row math. The popup
    // renders these arrays directly and the rows always sum to the total.
    // `subscription` is intentionally excluded from assetBreakdown.
    // Source of truth: shared/asset-value.ts. Do NOT inline a local copy of
    // these type sets — drift here silently desyncs dashboard net worth.
    const assetChildTypes = ASSET_PROFILE_TYPES;
    const liabilityChildTypes = LIABILITY_PROFILE_TYPES;
    const noFilterBreak = !fpIds || fpIds.length === 0;
    // Ownership share for the selected filter, via the shared model. Nesting
    // (parentProfileId) is NOT consulted — ownership is explicit links, else
    // Self owns 100%. Selecting the asset/liability profile itself = full value.
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
      if (!assetChildTypes.has(p.type)) continue;
      const gross = resolveAssetValue(p.fields);
      if (gross <= 0) continue;
      const share = shareForAsset(p);
      if (share <= 0) continue;
      assetBreakdown.push({ id: p.id, name: p.name, type: p.type, grossValue: gross, share, value: gross * share / 100 });
    }
    assetBreakdown.sort((a, b) => b.value - a.value);
    const liabilityBreakdown: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }> = [];
    for (const p of allProfiles) {
      if (!liabilityChildTypes.has(p.type)) continue;
      const gross = resolveLiabilityValue(p.fields);
      if (gross <= 0) continue;
      const share = shareForLiability(p);
      if (share <= 0) continue;
      liabilityBreakdown.push({ id: p.id, name: p.name, type: p.type, grossValue: gross, share, value: gross * share / 100 });
    }
    liabilityBreakdown.sort((a, b) => b.value - a.value);

    const todaysEvents = allEvents.filter(e => e.date === today).map(e => ({ id: e.id, title: e.title, time: e.time, endTime: e.endTime, category: e.category, location: e.location }));

    return {
      expiringDocuments: expiringDocs.filter(d => d.status !== 'ok'),
      healthSnapshot,
      financeSnapshot: {
        totalMonthlySpend, lastMonthTotal,
        spendTrend: lastMonthTotal > 0 ? Math.round(((totalMonthlySpend - lastMonthTotal) / lastMonthTotal) * 100) : (totalMonthlySpend > 0 ? 100 : 0),
        spendByCategory, upcomingBills,
        monthlyObligationTotal: Math.round(monthlyObligationTotal),
        totalAssetValue: (() => {
          // Asset profiles: vehicles, real estate, investments, accounts, generic assets, even loans
          // (a loan profile may carry the asset's market value separately from its remaining balance).
          // BUG-NW-1 fix (2026-06-03): `subscription` removed — subscriptions are recurring expenses,
          // never balance-sheet items. They were leaking $cost into Net Worth via resolveAssetValue's
          // fields.cost candidate path.
          const childTypes = ASSET_PROFILE_TYPES;
          // Same ownership-share rule as assetBreakdown (shared model) — keep
          // the total and the per-row breakdown in lockstep.
          return allProfiles.reduce((s, p) => {
            if (!childTypes.has(p.type)) return s;
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
          const liabilityTypes = LIABILITY_PROFILE_TYPES;
          // Same ownership-share rule as liabilityBreakdown (shared model).
          return allProfiles.reduce((s, p) => {
            if (!liabilityTypes.has(p.type)) return s;
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
  async getNetWorthHistory(profileId?: string, lookbackDays: number = 1): Promise<Array<{ snapshotDate: string; assetsTotal: number; liabilitiesTotal: number; netWorth: number }>> {
    const today = getUserToday(this._timezone);
    const since = tzAddDays(today, -Math.max(1, lookbackDays));
    let q = this.supabase.from("net_worth_snapshots")
      .select("snapshot_date, assets_total, liabilities_total, net_worth")
      .eq("user_id", this.userId)
      .gte("snapshot_date", since);
    q = profileId ? q.eq("profile_id", profileId) : q.is("profile_id", null);
    const { data, error } = await q.order("snapshot_date", { ascending: false });
    if (error) throw error;
    return (data || []).map((r: any) => ({
      snapshotDate: r.snapshot_date,
      assetsTotal: Number(r.assets_total || 0),
      liabilitiesTotal: Number(r.liabilities_total || 0),
      netWorth: Number(r.net_worth || 0),
    }));
  }

  // ============================================================
  // INSIGHTS
  // ============================================================
  async getInsights(filterProfileId?: string): Promise<Insight[]> {
    const profiles = await this.getProfiles();
    const allTrackers = await this.getTrackers();
    const allTasks = await this.getTasks();
    const allExpenses = await this.getExpenses();
    const allHabits = await this.getHabits();
    const allObligations = await this.getObligations();
    const journal = await this.getJournalEntries();
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
    return generateInsights(profiles, trackers, tasks, expenses, habits, obligations, journal);
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
    const [profiles, trackers, tasks, expenses, habits, obligations, artifacts, journal, memories] = await Promise.all([
      this.getProfiles(),
      this.getTrackers(),
      this.getTasks(),
      this.getExpenses(),
      this.getHabits(),
      this.getObligations(),
      this.getArtifacts(),
      this.getJournalEntries(),
      this.getMemories(),
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
        ? Promise.all([...needed.document].map(id => this.getDocument(id).catch(() => null).then(d => d ? { ...d, fileData: undefined } : null)))
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
    const { data } = await this.supabase.from("preferences").select("value").eq("user_id", this.userId).eq("key", key).single();
    return data ? data.value : null;
  }

  async setPreference(key: string, value: string): Promise<void> {
    // Upsert: try update, then insert
    const { data: existing } = await this.supabase.from("preferences").select("key").eq("user_id", this.userId).eq("key", key).single();
    if (existing) {
      await this.supabase.from("preferences").update({ value }).eq("user_id", this.userId).eq("key", key);
    } else {
      await this.supabase.from("preferences").insert({ user_id: this.userId, key, value });
    }
  }

  // ============================================================
  // BUDGETS (stored in preferences table as JSON)
  // ============================================================

  async getBudgets(month: string, profileIds?: string[]): Promise<Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>> {
    const { data } = await this.supabase.from("preferences")
      .select("value")
      .eq("user_id", this.userId)
      .eq("key", `budget:${month}`)
      .single();
    if (!data?.value) return [];
    let parsed: Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>;
    try { parsed = JSON.parse(data.value); } catch { return []; }
    if (!profileIds) return parsed;
    // Entries with no profileId are shared/all and always returned; otherwise
    // only entries whose profileId is in the requested set.
    const wanted = new Set(profileIds);
    return parsed.filter(b => !b.profileId || wanted.has(b.profileId));
  }

  async setBudgets(month: string, budgets: Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>): Promise<void> {
    const { data: existing } = await this.supabase.from("preferences")
      .select("id")
      .eq("user_id", this.userId)
      .eq("key", `budget:${month}`)
      .single();
    if (existing) {
      await this.supabase.from("preferences")
        .update({ value: JSON.stringify(budgets) })
        .eq("id", existing.id);
    } else {
      await this.supabase.from("preferences").insert({
        user_id: this.userId,
        key: `budget:${month}`,
        value: JSON.stringify(budgets),
      });
    }
  }

  async addBudget(month: string, category: string, amount: number, notes?: string, profileId?: string): Promise<{id: string; category: string; amount: number; notes?: string; profileId?: string}> {
    const budgets = await this.getBudgets(month);
    // Dedupe on (category, profileId) so the same category can carry a
    // different cap per profile (shared entries use a null profileId).
    const existing = budgets.find(b => b.category.toLowerCase() === category.toLowerCase() && (b.profileId || null) === (profileId || null));
    if (existing) {
      existing.amount = amount;
      if (notes) existing.notes = notes;
      await this.setBudgets(month, budgets);
      return existing;
    }
    const entry = { id: crypto.randomUUID(), category, amount, notes, profileId };
    budgets.push(entry);
    await this.setBudgets(month, budgets);
    return entry;
  }

  async updateBudget(month: string, budgetId: string, updates: {amount?: number; category?: string; notes?: string; profileId?: string}): Promise<boolean> {
    const budgets = await this.getBudgets(month);
    const b = budgets.find(x => x.id === budgetId);
    if (!b) return false;
    if (updates.amount !== undefined) b.amount = updates.amount;
    if (updates.category) b.category = updates.category;
    if (updates.notes !== undefined) b.notes = updates.notes;
    if (updates.profileId !== undefined) b.profileId = updates.profileId;
    await this.setBudgets(month, budgets);
    return true;
  }

  async deleteBudget(month: string, budgetId: string): Promise<boolean> {
    const budgets = await this.getBudgets(month);
    const idx = budgets.findIndex(b => b.id === budgetId);
    if (idx === -1) return false;
    budgets.splice(idx, 1);
    await this.setBudgets(month, budgets);
    return true;
  }

  async copyBudgetsToMonth(fromMonth: string, toMonth: string): Promise<number> {
    const source = await this.getBudgets(fromMonth);
    if (source.length === 0) return 0;
    const newBudgets = source.map(b => ({ ...b, id: crypto.randomUUID() }));
    await this.setBudgets(toMonth, newBudgets);
    return newBudgets.length;
  }

  // ============================================================
  // REMINDERS (fired by GET /api/cron/fire-due-reminders)
  // ============================================================
  // Service role bypasses RLS, so every query filters by user_id ourselves.
  private mapReminder(row: any): Reminder {
    return {
      id: row.id,
      title: row.title,
      fireAt: row.fire_at,
      firedAt: row.fired_at ?? null,
      profileId: row.profile_id ?? null,
      channel: row.channel || "in_app",
      createdAt: row.created_at,
    };
  }

  async createReminder(data: { title: string; fireAt: string; profileId?: string }): Promise<Reminder> {
    const { data: row, error } = await this.supabase.from("reminders").insert({
      user_id: this.userId,
      profile_id: data.profileId || null,
      title: data.title,
      fire_at: data.fireAt,
      channel: "in_app",
    }).select().single();
    if (error) throw error;
    this.logActivity("reminder", `Set reminder: ${data.title}`);
    return this.mapReminder(row);
  }

  async listReminders(filter?: { dueBefore?: Date }): Promise<Reminder[]> {
    let q = this.supabase.from("reminders").select("*")
      .eq("user_id", this.userId)
      .is("fired_at", null)
      .is("deleted_at", null);
    if (filter?.dueBefore) q = q.lte("fire_at", filter.dueBefore.toISOString());
    const { data, error } = await q.order("fire_at", { ascending: true });
    if (error) throw error;
    return (data || []).map(r => this.mapReminder(r));
  }

  async markReminderFired(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("reminders")
      .update({ fired_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    return true;
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
    const update: any = { confirmed: true, received_date: new Date().toISOString().slice(0, 10) };
    if (actual_amount != null) update.actual_amount = actual_amount;
    const { data, error } = await this.supabase.from('paychecks').update(update)
      .eq('id', id).eq('user_id', this.userId).select().single();
    if (error) throw error;
    return data;
  }

  async deletePaycheck(id: string): Promise<void> {
    await this.supabase.from('paychecks').delete()
      .eq('id', id).eq('user_id', this.userId);
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

  // ============================================================
  // CASHFLOW PROJECTIONS
  // ============================================================
  // ⚠️  Same RLS-bypass concern — always filter by user_id.
  async getCashflow(month?: string): Promise<any[]> {
    const m = month || new Date().toISOString().slice(0, 7);
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
  async deleteAllUserData(): Promise<{ deleted: Record<string, number> }> {
    const deleted: Record<string, number> = {};
    const uid = this.userId;

    // Order matters: delete child tables first, then parent tables
    // FIX 4 Phase 2: profile_<type> junction tables have been dropped.
    const tables = [
      // Child tables
      "tracker_entries", "habit_checkins", "obligation_payments", "domain_entries",
      "entity_links", "audit_log",
      // Standalone data tables
      "expenses", "tasks", "events", "documents", "trackers", "habits",
      "obligations", "artifacts", "journal_entries", "memories", "goals",
      "domains", "incomes", "paychecks", "loan_amortization", "cashflow_projections",
      // Preferences (clears settings but not profile)
      "preferences",
    ];

    for (const table of tables) {
      try {
        const { count, error } = await this.supabase
          .from(table)
          .delete({ count: "exact" })
          .eq("user_id", uid);
        if (!error) {
          deleted[table] = count || 0;
        }
      } catch {
        // Table may not exist — skip silently
      }
    }

    return { deleted };
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
    return true;
  }

  async getLiabilityPayments(liabilityProfileId: string): Promise<LiabilityPayment[]> {
    const { data, error } = await this.supabase.from("liability_payments")
      .select("*").eq("user_id", this.userId).eq("liability_profile_id", liabilityProfileId)
      .order("payment_date", { ascending: false });
    if (error) throw error;
    return (data || []).map(r => this.rowToLiabilityPayment(r));
  }

  async createLiabilityPayment(data: InsertLiabilityPayment): Promise<LiabilityPayment> {
    const now = new Date().toISOString();
    const id = randomUUID();
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
    const assetChildTypes = ASSET_PROFILE_TYPES;
    const liabilityChildTypes = LIABILITY_PROFILE_TYPES;
    // This profile's ownership share of an item: the item itself = 100%; else
    // the profile's explicit ownership %, or 100% if it's Self and the item has
    // no explicit owners.
    const shareForItem = (p: any, links: Map<string, OwnershipLink[]>): number => {
      if (p.id === profileId) return 100;
      return shareForParties([profileId], links.get(p.id), selfId);
    };
    const assets: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }> = [];
    for (const p of allProfiles) {
      if (!assetChildTypes.has(p.type)) continue;
      const gross = resolveAssetValue(p.fields);
      if (gross <= 0) continue;
      const share = shareForItem(p, assetLinksByAsset);
      if (share <= 0) continue;
      assets.push({ id: p.id, name: p.name, type: p.type, grossValue: gross, share, value: Math.round(gross * share) / 100 });
    }
    const liabilities: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }> = [];
    for (const p of allProfiles) {
      if (!liabilityChildTypes.has(p.type)) continue;
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
    // history
    await this.recordOwnershipHistory({
      linkKind: "asset_party", linkId: id,
      subjectId: data.assetProfileId, counterpartyId: data.partyProfileId,
      action: "create",
      fieldChanged: null, oldValue: null,
      newValue: JSON.stringify({ pct: row.ownership_percentage, role: row.role }),
      changedBy: "user", note: null,
    });
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
    // record history per changed field
    if (patch.ownershipPercentage !== undefined && Number(existing.ownership_percentage) !== Number(patch.ownershipPercentage)) {
      await this.recordOwnershipHistory({
        linkKind: "asset_party", linkId: id,
        subjectId: existing.asset_profile_id, counterpartyId: existing.party_profile_id,
        action: "update", fieldChanged: "ownership_percentage",
        oldValue: String(existing.ownership_percentage), newValue: String(patch.ownershipPercentage),
        changedBy: "user", note: null,
      });
    }
    if (patch.role !== undefined && existing.role !== patch.role) {
      await this.recordOwnershipHistory({
        linkKind: "asset_party", linkId: id,
        subjectId: existing.asset_profile_id, counterpartyId: existing.party_profile_id,
        action: "update", fieldChanged: "role",
        oldValue: existing.role, newValue: String(patch.role),
        changedBy: "user", note: null,
      });
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
    await this.recordOwnershipHistory({
      linkKind: "asset_party", linkId: id,
      subjectId: existing.asset_profile_id, counterpartyId: existing.party_profile_id,
      action: "delete", fieldChanged: null,
      oldValue: JSON.stringify({ pct: existing.ownership_percentage, role: existing.role }),
      newValue: null, changedBy: "user", note: null,
    });
    return true;
  }

  /**
   * Atomically replace the OWNER set of an asset — the single source-of-truth
   * write for ownership. Validates the full set (each 0–100, no dupes, totals
   * exactly 100% unless empty), then applies the minimal diff in a SAFE ORDER
   * so the per-asset sum never transiently exceeds 100 (which the DB guardrail
   * rejects): removals + decreases first, then increases + additions.
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

    // Current OWNER-role links for this asset (ignore co_signer/etc.).
    const existingAll = await this.getAssetPartyLinks(assetProfileId);
    const existing = existingAll.filter((l) => {
      const r = (l.role || "owner").toLowerCase();
      return r === "owner" || r === "co_owner" || r === "co-owner";
    });
    const existingByParty = new Map(existing.map((l) => [l.partyProfileId, l]));
    const desiredByParty = new Map(desired.map((o) => [o.partyProfileId, o]));

    // Phase A — lower the running sum first (safe under the >100 guardrail):
    //   delete parties no longer present, and decrease shrinking ones.
    for (const l of existing) {
      if (!desiredByParty.has(l.partyProfileId)) {
        await this.deleteAssetPartyLink(l.id);
      }
    }
    for (const o of desired) {
      const cur = existingByParty.get(o.partyProfileId);
      if (cur && o.ownershipPercentage < Number(cur.ownershipPercentage)) {
        await this.updateAssetPartyLink(cur.id, { ownershipPercentage: o.ownershipPercentage });
      }
    }
    // Phase B — raise the running sum: increases then brand-new owners.
    for (const o of desired) {
      const cur = existingByParty.get(o.partyProfileId);
      if (cur && o.ownershipPercentage > Number(cur.ownershipPercentage)) {
        await this.updateAssetPartyLink(cur.id, { ownershipPercentage: o.ownershipPercentage });
      }
    }
    for (const o of desired) {
      if (!existingByParty.has(o.partyProfileId)) {
        await this.createAssetPartyLink({ assetProfileId, partyProfileId: o.partyProfileId, ownershipPercentage: o.ownershipPercentage, role: "owner" } as InsertAssetPartyLink);
      }
    }
    return this.getAssetPartyLinks(assetProfileId);
  }

  async getOwnershipHistory(opts?: { subjectId?: string; counterpartyId?: string; limit?: number }): Promise<OwnershipHistoryEntry[]> {
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
}
