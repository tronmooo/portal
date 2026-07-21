import { logger } from "./logger";
import { AsyncLocalStorage } from "node:async_hooks";
import { getUserToday, addDays as tzAddDays, toLocalDateStr, parseLocalDate, DEFAULT_TIMEZONE } from "@shared/timezone";
import { stripTrackerOwnerSuffix, stripOwnerPossessivePrefix } from "@shared/entity-naming";
import { parseRecurringMeta } from "@shared/recurring-dates";

// Per-request storage context — eliminates the global userId race condition (C-1)
// Auth middleware runs storage within this context so all downstream code
// automatically gets the request-scoped storage instance.
export const requestStorageContext = new AsyncLocalStorage<IStorage>();
import {
  type Profile, type InsertProfile,
  type Tracker, type InsertTracker, type TrackerEntry, type InsertTrackerEntry,
  type Task, type InsertTask,
  type Expense, type InsertExpense,
  type CalendarEvent, type InsertEvent, type CalendarTimelineItem,
  type EventCategory, EVENT_CATEGORY_COLORS,
  type Document, type InsertDocument, type DashboardStats,
  type ProfileDetail, type TimelineEntry, type Insight,
  type ComputedData,
  type Habit, type InsertHabit, type HabitCheckin,
  type Obligation, type InsertObligation, type ObligationPayment,
  type Artifact, type InsertArtifact, type ChecklistItem,
  type JournalEntry, type InsertJournalEntry,
  type MemoryItem, type InsertMemory,
  type Domain, type InsertDomain, type DomainEntry,
  type MoodLevel,
  type Goal, type InsertGoal,
  type EntityLink, type InsertEntityLink,
  type Income, type InsertIncome,
  MOOD_SCORES,
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface Reminder {
  id: string;
  title: string;
  fireAt: string;
  firedAt?: string | null;
  profileId?: string | null;
  channel: string;
  createdAt: string;
}

export interface IStorage {
  // Profiles
  getProfiles(): Promise<Profile[]>;
  getProfilesLite?(): Promise<Profile[]>;
  getProfile(id: string): Promise<Profile | undefined>;
  getProfileDetail(id: string): Promise<ProfileDetail | undefined>;
  createProfile(data: InsertProfile): Promise<Profile>;
  updateProfile(id: string, data: Partial<Profile>): Promise<Profile | undefined>;
  deleteProfile(id: string): Promise<boolean>;
  linkProfileTo(profileId: string, entityType: string, entityId: string): Promise<void>;
  unlinkProfileFrom(profileId: string, entityType: string, entityId: string): Promise<void>;
  propagateDocumentToAncestors(documentId: string, profileId: string): Promise<string[]>;
  propagateEntityToAncestors(entityType: string, entityId: string, profileId: string): Promise<string[]>;
  getSelfProfile(): Promise<Profile | undefined>;
  wouldCreateCycle(userId: string, profileId: string, newParentId: string | null): Promise<boolean>;

  // Trackers
  getTrackers(daysBack?: number, profileIds?: string[]): Promise<Tracker[]>;
  getTracker(id: string): Promise<Tracker | undefined>;
  createTracker(data: InsertTracker): Promise<Tracker>;
  updateTracker(id: string, data: Partial<Tracker>): Promise<Tracker | undefined>;
  logEntry(data: InsertTrackerEntry): Promise<TrackerEntry | undefined>;
  updateTrackerEntry(trackerId: string, entryId: string, patch: { values?: Record<string, any>; notes?: string; mood?: any; tags?: string[]; timestamp?: string }): Promise<TrackerEntry | undefined>;
  deleteTrackerEntry(trackerId: string, entryId: string): Promise<boolean>;
  deleteTracker(id: string): Promise<boolean>;
  migrateUnlinkedTrackersToSelf(): Promise<number>;

  // Tasks
  getTasks(profileIds?: string[]): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  createTask(data: InsertTask): Promise<Task>;
  updateTask(id: string, data: Partial<Task>): Promise<Task | undefined>;
  deleteTask(id: string): Promise<boolean>;

  // Expenses
  getExpenses(profileIds?: string[]): Promise<Expense[]>;
  getExpense(id: string): Promise<Expense | undefined>;
  createExpense(data: InsertExpense): Promise<Expense>;
  updateExpense(id: string, data: Partial<Expense>): Promise<Expense | undefined>;
  deleteExpense(id: string): Promise<boolean>;

  // Events
  getEvents(profileIds?: string[]): Promise<CalendarEvent[]>;
  getEvent(id: string): Promise<CalendarEvent | undefined>;
  createEvent(data: InsertEvent): Promise<CalendarEvent>;
  updateEvent(id: string, data: Partial<CalendarEvent>): Promise<CalendarEvent | undefined>;
  deleteEvent(id: string): Promise<boolean>;

  // Unified calendar timeline
  getCalendarTimeline(startDate: string, endDate: string, profileIds?: string[]): Promise<CalendarTimelineItem[]>;

  // Documents
  getDocuments(profileIds?: string[]): Promise<Document[]>;
  getDocument(id: string): Promise<Document | undefined>;
  createDocument(data: Partial<InsertDocument> & { name: string; type: string } & Record<string, unknown>): Promise<Document>;
  updateDocument(id: string, data: Partial<Document>): Promise<Document | undefined>;
  deleteDocument(id: string): Promise<boolean>;
  getDocumentsForProfile(profileId: string): Promise<Document[]>;

  // Habits
  getHabits(profileIds?: string[]): Promise<Habit[]>;
  getHabit(id: string): Promise<Habit | undefined>;
  createHabit(data: InsertHabit): Promise<Habit>;
  checkinHabit(habitId: string, date?: string, value?: number, notes?: string): Promise<HabitCheckin | undefined>;
  updateHabit(id: string, data: Partial<Habit>): Promise<Habit | undefined>;
  deleteHabit(id: string): Promise<boolean>;

  // Obligations
  getObligations(profileIds?: string[]): Promise<Obligation[]>;
  getObligation(id: string): Promise<Obligation | undefined>;
  createObligation(data: InsertObligation): Promise<Obligation>;
  updateObligation(id: string, data: Partial<Obligation>): Promise<Obligation | undefined>;
  payObligation(obligationId: string, amount: number, method?: string, confirmationNumber?: string): Promise<ObligationPayment | undefined>;
  deleteObligation(id: string): Promise<boolean>;

  // Artifacts
  getArtifacts(profileIds?: string[]): Promise<Artifact[]>;
  getArtifact(id: string): Promise<Artifact | undefined>;
  createArtifact(data: InsertArtifact): Promise<Artifact>;
  updateArtifact(id: string, data: Partial<Artifact>): Promise<Artifact | undefined>;
  toggleChecklistItem(artifactId: string, itemId: string): Promise<Artifact | undefined>;
  deleteArtifact(id: string): Promise<boolean>;
  // Optional public-share helpers (only implemented by SupabaseStorage; in-memory falls back to updateArtifact).
  getArtifactByShareToken?(token: string): Promise<Artifact | undefined>;
  setArtifactShareToken?(id: string, token: string | null): Promise<Artifact | undefined>;

  // Journal
  getJournalEntries(profileIds?: string[]): Promise<JournalEntry[]>;
  createJournalEntry(data: InsertJournalEntry): Promise<JournalEntry>;
  updateJournalEntry(id: string, data: Partial<JournalEntry>): Promise<JournalEntry | undefined>;
  deleteJournalEntry(id: string): Promise<boolean>;

  // Memory
  getMemories(): Promise<MemoryItem[]>;
  saveMemory(data: InsertMemory): Promise<MemoryItem>;
  recallMemory(query: string): Promise<MemoryItem[]>;
  deleteMemory(id: string): Promise<boolean>;
  updateMemory(id: string, data: Partial<MemoryItem>): Promise<MemoryItem | undefined>;

  // Goals
  getGoals(profileIds?: string[]): Promise<Goal[]>;
  getGoal(id: string): Promise<Goal | undefined>;
  createGoal(data: InsertGoal): Promise<Goal>;
  updateGoal(id: string, data: Partial<Goal>): Promise<Goal | undefined>;
  deleteGoal(id: string): Promise<boolean>;

  // Domains
  getDomains(): Promise<Domain[]>;
  createDomain(data: InsertDomain): Promise<Domain>;
  updateDomain(id: string, data: Partial<Domain>): Promise<Domain | undefined>;
  deleteDomain(id: string): Promise<boolean>;
  getDomainEntries(domainId: string): Promise<DomainEntry[]>;
  addDomainEntry(domainId: string, values: Record<string, any>, tags?: string[], notes?: string): Promise<DomainEntry | undefined>;

  // Entity Links
  getEntityLinks(entityType: string, entityId: string): Promise<EntityLink[]>;
  createEntityLink(data: InsertEntityLink): Promise<EntityLink>;
  deleteEntityLink(id: string): Promise<boolean>;
  getRelatedEntities(entityType: string, entityId: string): Promise<any[]>;

  // Dashboard
  getStats(filterProfileId?: string, filterProfileIds?: string[]): Promise<DashboardStats>;
  getDashboardEnhanced(filterProfileId?: string, filterProfileIds?: string[]): Promise<Record<string, unknown>>;

  // Net-worth snapshots (W4-5)
  takeNetWorthSnapshot(profileIds?: string[]): Promise<Array<{ profileId: string | null; assetsTotal: number; liabilitiesTotal: number; netWorth: number; snapshotDate: string }>>;
  getNetWorthHistory(profileId?: string, lookbackDays?: number): Promise<Array<{ snapshotDate: string; assetsTotal: number; liabilitiesTotal: number; netWorth: number }>>;

  // Insights
  getInsights(): Promise<Insight[]>;

  // Search
  search(query: string): Promise<any[]>;

  // Preferences
  getPreference(key: string): Promise<string | null>;
  setPreference(key: string, value: string): Promise<void>;

  // Income
  getIncomes(profileIds?: string[]): Promise<Income[]>;
  createIncome(data: InsertIncome): Promise<Income>;
  updateIncome(id: string, data: Partial<Income>): Promise<Income | undefined>;
  deleteIncome(id: string): Promise<boolean>;

  // Soft-delete restore & misc
  restoreTask(id: string): Promise<boolean>;
  restoreHabit(id: string): Promise<boolean>;
  getDeletedTasks(limit?: number): Promise<Task[]>;
  getDeletedHabits(limit?: number): Promise<Habit[]>;
  /** Generic soft-delete restore for entity types without a dedicated method. */
  restoreEntity(entityType: string, id: string): Promise<boolean>;

  // AI action ledger (undo + audit for chat mutations)
  createAiActionLog(entry: import("@shared/schema").InsertAiActionLog): Promise<import("@shared/schema").AiActionLog | undefined>;
  listAiActionLog(opts?: { limit?: number; entityType?: string; entityId?: string; includeUndone?: boolean }): Promise<import("@shared/schema").AiActionLog[]>;
  markActionUndone(id: string, undoneByLogId?: string): Promise<void>;

  // AI bulk plans (preview → confirm → execute)
  createAiBulkPlan(plan: { operation: string; criteria: any; planHash: string; preview: any; expiresAt: string }): Promise<{ id: string; operation: string; criteria: any; planHash: string; preview: any; status: string; expiresAt: string }>;
  getAiBulkPlan(planId: string): Promise<{ id: string; operation: string; criteria: any; planHash: string; preview: any; status: string; expiresAt: string } | undefined>;
  getLatestPendingAiBulkPlan(): Promise<{ id: string; operation: string; criteria: any; planHash: string; preview: any; status: string; expiresAt: string } | undefined>;
  setAiBulkPlanStatus(planId: string, status: string, patch?: { affected?: any; executedAt?: string }): Promise<void>;

  // User-created notifications (custom rows merged into the computed bell list)
  createUserNotification(n: { title: string; message?: string; severity?: string; entityType?: string; entityId?: string }): Promise<{ id: string; title: string; message: string; severity: string; createdAt: string }>;
  listUserNotifications(opts?: { includeDismissed?: boolean; limit?: number }): Promise<Array<{ id: string; title: string; message: string; severity: string; entityType?: string | null; entityId?: string | null; createdAt: string; readAt?: string | null; dismissedAt?: string | null }>>;
  markUserNotifications(field: "read" | "dismissed", ids?: string[]): Promise<number>;
  deleteHabitCheckin(habitId: string, checkinId: string): Promise<boolean>;
  migrateDocumentsToStorage(): Promise<{ migrated: number; errors: string[] }>;

  // Budgets
  getBudgets(month: string, profileIds?: string[]): Promise<Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>>;
  setBudgets(month: string, budgets: Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>): Promise<void>;
  addBudget(month: string, category: string, amount: number, notes?: string, profileId?: string): Promise<{id: string; category: string; amount: number; notes?: string; profileId?: string}>;
  updateBudget(month: string, budgetId: string, updates: {amount?: number; category?: string; notes?: string; profileId?: string}): Promise<boolean>;
  deleteBudget(month: string, budgetId: string): Promise<boolean>;
  copyBudgetsToMonth(fromMonth: string, toMonth: string): Promise<number>;

  // Reminders (real, fired by GET /api/cron/fire-due-reminders)
  createReminder(data: { title: string; fireAt: string; profileId?: string }): Promise<Reminder>;
  listReminders(filter?: { dueBefore?: Date }): Promise<Reminder[]>;
  markReminderFired(id: string): Promise<boolean>;
  updateReminder(id: string, data: { title?: string; fireAt?: string; profileId?: string | null }): Promise<Reminder | undefined>;
  deleteReminder(id: string): Promise<boolean>;

  // Paychecks
  getPaychecks(): Promise<any[]>;
  createPaycheck(paycheck: { source: string; amount: number; expected_date: string; notes?: string }): Promise<any>;
  confirmPaycheck(id: string, actual_amount?: number): Promise<any>;
  deletePaycheck(id: string): Promise<void>;

  // Loan Amortization
  getLoanSchedule(loanId: string): Promise<any[]>;
  getAllLoanSchedules(): Promise<any[]>;
  createLoanSchedule(entries: Array<{ loan_id: string; loan_name: string; payment_number: number; payment_date: string; principal_amount: number; interest_amount: number; total_payment: number; remaining_balance: number }>): Promise<any[]>;
  markLoanPayment(id: string): Promise<any>;

  // Cashflow Projections
  getCashflow(month?: string): Promise<any[]>;
  upsertCashflow(entry: { month: string; week: number; projected_income?: number; projected_expenses?: number; actual_income?: number; actual_expenses?: number }): Promise<any>;

  // Bulk delete all user data (preserves profiles)
  deleteAllUserData(): Promise<{ deleted: Record<string, number> }>;

  // Finance imports ("Import from ChatGPT") — batch history + undo.
  createFinanceImport(rec: import("./finance-import").FinanceImportRecordInput): Promise<import("./finance-import").FinanceImportRecord>;
  listFinanceImports(limit?: number): Promise<import("./finance-import").FinanceImportRecord[]>;
  getFinanceImport(id: string): Promise<import("./finance-import").FinanceImportRecord | null>;
  setFinanceImportStatus(id: string, status: "committed" | "undone"): Promise<void>;

  // Liabilities (Phase 1)
  getLiabilityAssetLinks(liabilityProfileId?: string): Promise<import("@shared/schema").LiabilityAssetLink[]>;
  getLiabilityAssetLinksForAsset(assetProfileId: string): Promise<import("@shared/schema").LiabilityAssetLink[]>;
  createLiabilityAssetLink(data: import("@shared/schema").InsertLiabilityAssetLink): Promise<import("@shared/schema").LiabilityAssetLink>;
  updateLiabilityAssetLink(id: string, patch: Partial<import("@shared/schema").InsertLiabilityAssetLink>): Promise<import("@shared/schema").LiabilityAssetLink | undefined>;
  deleteLiabilityAssetLink(id: string): Promise<boolean>;

  getLiabilityProfileLinks(liabilityProfileId?: string): Promise<import("@shared/schema").LiabilityProfileLink[]>;
  getLiabilityProfileLinksForParty(partyProfileId: string): Promise<import("@shared/schema").LiabilityProfileLink[]>;
  createLiabilityProfileLink(data: import("@shared/schema").InsertLiabilityProfileLink): Promise<import("@shared/schema").LiabilityProfileLink>;
  updateLiabilityProfileLink(id: string, patch: Partial<import("@shared/schema").InsertLiabilityProfileLink>): Promise<import("@shared/schema").LiabilityProfileLink | undefined>;
  deleteLiabilityProfileLink(id: string): Promise<boolean>;
  ensureLiabilityOwnerLink(id: string): Promise<void>;

  getLiabilityPayments(liabilityProfileId: string): Promise<import("@shared/schema").LiabilityPayment[]>;
  createLiabilityPayment(data: import("@shared/schema").InsertLiabilityPayment): Promise<import("@shared/schema").LiabilityPayment>;
  updateLiabilityPayment(id: string, data: Partial<import("@shared/schema").InsertLiabilityPayment>): Promise<import("@shared/schema").LiabilityPayment | undefined>;
  deleteLiabilityPayment(id: string): Promise<boolean>;

  // Asset ↔ party links (Phase 1 of relationships module)
  getAssetPartyLinks(assetProfileId?: string): Promise<import("@shared/schema").AssetPartyLink[]>;
  getAssetPartyLinksForParty(partyProfileId: string): Promise<import("@shared/schema").AssetPartyLink[]>;
  getProfileAssetValue(profileId: string): Promise<{ assetValue: number; liabilityValue: number; netValue: number; assets: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }>; liabilities: Array<{ id: string; name: string; type: string; grossValue: number; share: number; value: number }> }>;
  createAssetPartyLink(data: import("@shared/schema").InsertAssetPartyLink): Promise<import("@shared/schema").AssetPartyLink>;
  updateAssetPartyLink(id: string, patch: Partial<import("@shared/schema").InsertAssetPartyLink>): Promise<import("@shared/schema").AssetPartyLink | undefined>;
  deleteAssetPartyLink(id: string): Promise<boolean>;
  /** Atomically replace the OWNER set of an asset (single source of truth write).
   *  Validates the full set totals 100% (or is empty), then applies the minimal
   *  safe diff. Pass [] to clear ownership (asset reverts to Self-100%). */
  setAssetOwners(assetProfileId: string, owners: Array<{ partyProfileId: string; ownershipPercentage: number }>): Promise<import("@shared/schema").AssetPartyLink[]>;
  setLiabilityOwners(liabilityProfileId: string, owners: Array<{ partyProfileId: string; ownershipPercentage: number }>): Promise<import("@shared/schema").LiabilityProfileLink[]>;

  // Ownership history (audit log)
  getOwnershipHistory(opts?: { subjectId?: string; counterpartyId?: string; limit?: number }): Promise<import("@shared/schema").OwnershipHistoryEntry[]>;
  recordOwnershipHistory(entry: Omit<import("@shared/schema").OwnershipHistoryEntry, "id" | "changedAt">): Promise<import("@shared/schema").OwnershipHistoryEntry>;
  deleteOwnershipHistoryEntry(id: string): Promise<boolean>;

  // Ownership-consolidation invariant probe (Stage 6 guardrail).
  getOwnershipConsistency?(): Promise<{
    disagreementCount: number;
    jsonbOnlyCount: number;
    /** Stage 5: assets/liabilities where fields.ownerProfileId disagrees with relational link table. */
    financeDisagreementCount: number;
    perType: Record<string, { disagree: number; jsonbOnly: number; agree: number; total: number }>;
  }>;

  /** [P0.5] Repair counterpart to getOwnershipConsistency: strips
   *  linked_profiles entries pointing at non-existent profiles, routing every
   *  fix through the single ownership writer (setOwners). `details` is capped
   *  at 50 entries. Optional for the same reason getOwnershipConsistency is —
   *  only the Supabase backend implements the invariant probes. */
  /** Cross-instance cache coherence (migration 010). Optional: MemStorage has no instances. */
  getDataVersion?(): Promise<number>;
  bumpDataVersion?(): Promise<number>;
  repairOwnershipConsistency?(): Promise<{ scanned: number; repaired: number; details: string[] }>;

  // Universal Captures (PR Y) ---------------------------------------------
  getCaptures?(opts?: { status?: string; ownerProfileId?: string; limit?: number }): Promise<import("@shared/schema").Capture[]>;
  getCapture?(id: string): Promise<import("@shared/schema").Capture | undefined>;
  createCapture?(data: import("@shared/schema").InsertCapture): Promise<import("@shared/schema").Capture>;
  updateCapture?(id: string, patch: Partial<import("@shared/schema").Capture>): Promise<import("@shared/schema").Capture | undefined>;
  deleteCapture?(id: string): Promise<boolean>;
}

// ---- Human-readable tracker value formatting ----

export function formatTrackerValues(trackerName: string, values: Record<string, any>, unit?: string): string {
  const lower = trackerName.toLowerCase();
  const parts: string[] = [];
  
  // Sleep: show as "7.5 hours" not "hours: 7.5"
  if (lower.includes('sleep')) {
    if (values.hours != null) parts.push(`${values.hours} hours`);
    if (values.quality) parts.push(`${values.quality} quality`);
    if (values.bedtime) parts.push(`bedtime ${values.bedtime}`);
    if (values.wakeTime) parts.push(`woke ${values.wakeTime}`);
    return parts.join(', ') || Object.values(values).join(', ');
  }
  
  // Weight: show as "183 lbs" not "weight: 183"
  if (lower.includes('weight')) {
    const w = values.weight ?? values.value;
    if (w != null) return `${w} ${unit || 'lbs'}`;
  }
  
  // Blood pressure: show as "120/80" not "systolic: 120, diastolic: 80"
  if (lower.includes('blood pressure') || lower.includes('bp')) {
    const sys = values.systolic ?? values.sbp;
    const dia = values.diastolic ?? values.dbp;
    if (sys != null && dia != null) {
      const pulse = values.pulse ?? values.heartRate;
      return `${sys}/${dia}${pulse ? ` pulse ${pulse}` : ''}`;
    }
  }
  
  // Calories/nutrition: show as "500 kcal" not "calories: 500"
  if (lower.includes('calori') || lower.includes('nutrition') || lower.includes('meal')) {
    if (values.calories != null) parts.push(`${values.calories} kcal`);
    if (values.name || values.meal) parts.push(values.name || values.meal);
    if (values.protein) parts.push(`${values.protein}g protein`);
    return parts.join(', ') || Object.values(values).join(', ');
  }
  
  // Running/exercise: show as "3 mi in 25:00" not "distance: 3, duration: 25:00"
  if (lower.includes('run') || lower.includes('exercise') || lower.includes('workout')) {
    if (values.distance != null) parts.push(`${values.distance} mi`);
    if (values.duration) parts.push(`in ${values.duration}`);
    if (values.calories) parts.push(`${values.calories} cal`);
    return parts.join(' ') || Object.values(values).join(', ');
  }
  
  // Generic: show primary value with unit, then other fields
  const primaryValue = values.value ?? Object.values(values).find(v => typeof v === 'number');
  if (primaryValue != null && Object.keys(values).length === 1) {
    return `${primaryValue}${unit ? ` ${unit}` : ''}`;
  }
  
  // Fallback: key-value pairs but cleaner
  return Object.entries(values)
    .filter(([k, v]) => v != null && v !== '' && k !== '_notes' && k !== 'notes')
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');
}

// ---- Secondary data computation ----

export function computeSecondaryData(trackerName: string, category: string, values: Record<string, any>): ComputedData {
  const computed: ComputedData = {};
  const name = trackerName.toLowerCase();

  // Running / Cardio
  if (name.includes("run") || name.includes("jog") || (category === "fitness" && values.distance)) {
    const distance = parseFloat(values.distance) || 0;
    const duration = parseDuration(values.duration);
    if (distance > 0) {
      computed.distanceMiles = distance;
      computed.caloriesBurned = Math.round(distance * 100);
      computed.intensity = distance > 6 ? "extreme" : distance > 4 ? "high" : distance > 2 ? "moderate" : "low";
    }
    if (duration > 0 && distance > 0) {
      computed.durationMinutes = duration;
      const paceSecondsPerMile = (duration * 60) / distance;
      computed.paceSeconds = Math.round(paceSecondsPerMile);
      const paceMin = Math.floor(paceSecondsPerMile / 60);
      const paceSec = Math.round(paceSecondsPerMile % 60);
      computed.pace = `${paceMin}:${String(paceSec).padStart(2, "0")}/mi`;
    }
    if (computed.paceSeconds) {
      if (computed.paceSeconds < 420) computed.heartRateZone = "peak";
      else if (computed.paceSeconds < 510) computed.heartRateZone = "cardio";
      else if (computed.paceSeconds < 600) computed.heartRateZone = "fat_burn";
      else computed.heartRateZone = "recovery";
    }
  }

  // Walking
  if (name.includes("walk") || name.includes("hike")) {
    const distance = parseFloat(values.distance) || parseFloat(values.steps) / 2000 || 0;
    if (distance > 0) {
      computed.distanceMiles = distance;
      computed.caloriesBurned = Math.round(distance * 80);
      computed.intensity = "low";
      computed.heartRateZone = "fat_burn";
    }
  }

  // Cycling
  if (name.includes("cycl") || name.includes("bike") || name.includes("ride")) {
    const distance = parseFloat(values.distance) || 0;
    if (distance > 0) {
      computed.distanceMiles = distance;
      computed.caloriesBurned = Math.round(distance * 50);
      computed.intensity = distance > 20 ? "high" : distance > 10 ? "moderate" : "low";
    }
  }

  // Weight / Gym
  if (name.includes("weight") && category === "fitness") {
    const duration = parseDuration(values.duration) || 45;
    computed.caloriesBurned = Math.round(duration * 7);
    computed.durationMinutes = duration;
    computed.intensity = "moderate";
  }

  // Yoga / Stretching
  if (name.includes("yoga") || name.includes("stretch") || name.includes("pilates")) {
    const duration = parseDuration(values.duration) || 30;
    computed.caloriesBurned = Math.round(duration * 4);
    computed.durationMinutes = duration;
    computed.intensity = "low";
    computed.heartRateZone = "recovery";
  }

  // Swimming
  if (name.includes("swim")) {
    const duration = parseDuration(values.duration) || 30;
    computed.caloriesBurned = Math.round(duration * 10);
    computed.durationMinutes = duration;
    computed.intensity = "high";
    computed.heartRateZone = "cardio";
  }

  // Blood pressure
  if (name.includes("blood pressure") || name.includes("bp")) {
    const sys = parseFloat(values.systolic) || 0;
    const dia = parseFloat(values.diastolic) || 0;
    if (sys > 0 && dia > 0) {
      if (sys >= 180 || dia >= 120) computed.bloodPressureCategory = "crisis";
      else if (sys >= 140 || dia >= 90) computed.bloodPressureCategory = "high_stage2";
      else if ((sys >= 130 && sys <= 139) || (dia >= 80 && dia <= 89)) computed.bloodPressureCategory = "high_stage1";
      else if (sys >= 120 && sys <= 129 && dia < 80) computed.bloodPressureCategory = "elevated";
      else computed.bloodPressureCategory = "normal";
    }
  }

  // BMI computation removed — height is not known at log time (was hardcoded at 70 inches)

  // Sleep
  if (name.includes("sleep")) {
    const hours = parseFloat(values.hours) || parseFloat(values.duration) || parseFloat(values.value) || 0;
    if (hours > 0) {
      computed.durationMinutes = Math.round(hours * 60);
      if (hours >= 8) computed.sleepQuality = "excellent";
      else if (hours >= 7) computed.sleepQuality = "good";
      else if (hours >= 6) computed.sleepQuality = "fair";
      else computed.sleepQuality = "poor";
    }
  }

  // Food / Nutrition
  if (name.includes("food") || name.includes("meal") || name.includes("nutrition") || name.includes("eat") || category === "nutrition") {
    const calories = parseFloat(values.calories) || 0;
    if (calories > 0) computed.caloriesConsumed = calories;
    const protein = parseFloat(values.protein) || 0;
    const carbs = parseFloat(values.carbs) || 0;
    const fat = parseFloat(values.fat) || 0;
    if (protein > 0 || carbs > 0 || fat > 0) {
      computed.macros = { protein, carbs, fat, fiber: parseFloat(values.fiber) || 0 };
      if (!computed.caloriesConsumed && (protein || carbs || fat)) {
        computed.caloriesConsumed = Math.round(protein * 4 + carbs * 4 + fat * 9);
      }
    }
  }

  return computed;
}

function parseDuration(val: any): number {
  if (!val) return 0;
  if (typeof val === "number") return val;
  const str = String(val);
  const parts = str.split(":");
  if (parts.length === 2) return parseInt(parts[0]) + parseInt(parts[1]) / 60;
  if (parts.length === 3) return parseInt(parts[0]) * 60 + parseInt(parts[1]) + parseInt(parts[2]) / 60;
  return parseFloat(str) || 0;
}

// ---- Streak calculator for habits (supports targetPerDay) ----
function calculateStreak(checkins: { date: string }[], targetPerDay: number = 1, timezone: string = DEFAULT_TIMEZONE): { current: number; longest: number } {
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

  const todayStr = getUserToday(timezone);
  const yesterdayStr = tzAddDays(todayStr, -1);

  let current = 0;

  // Check if the most recent complete day is today or yesterday (allow 1-day gap for "current")
  if (completeDates[0] === todayStr || completeDates[0] === yesterdayStr) {
    let expectedDate = completeDates[0];
    for (let i = 0; i < completeDates.length; i++) {
      if (completeDates[i] === expectedDate) {
        current++;
        expectedDate = tzAddDays(expectedDate, -1);
      } else if (completeDates[i] < expectedDate) {
        break;
      }
    }
  }

  // Calculate longest streak from all complete dates
  const allDates = [...completeDates].sort();
  let tempStreak = 1;
  let longest = 1;
  for (let i = 1; i < allDates.length; i++) {
    if (allDates[i] === tzAddDays(allDates[i - 1], 1)) {
      tempStreak++;
      longest = Math.max(longest, tempStreak);
    } else {
      tempStreak = 1;
    }
  }

  return { current: Math.max(current, 0), longest: Math.max(longest, current) };
}

// ---- Insight generation (expanded) ----

function generateInsights(
  profiles: Profile[],
  trackers: Tracker[],
  tasks: Task[],
  expenses: Expense[],
  habits: Habit[],
  obligations: Obligation[],
  journal: JournalEntry[],
): Insight[] {
  const insights: Insight[] = [];
  const now = new Date();

  // 1. Weight trend
  const weightTracker = trackers.find(t => t.name.toLowerCase().includes("weight") && t.category === "health");
  if (weightTracker && weightTracker.entries.length >= 3) {
    const recent = weightTracker.entries.slice(-5);
    const firstVal = parseFloat(recent[0].values.weight || recent[0].values.value || "0");
    const lastVal = parseFloat(recent[recent.length - 1].values.weight || recent[recent.length - 1].values.value || "0");
    const diff = lastVal - firstVal;
    if (Math.abs(diff) > 0.5) {
      insights.push({
        id: randomUUID(), type: "health_correlation",
        title: diff < 0 ? "Weight trending down" : "Weight trending up",
        description: `Your weight has ${diff < 0 ? "decreased" : "increased"} by ${Math.abs(diff).toFixed(1)} lbs over the last ${recent.length} entries. ${diff < 0 ? "Great progress — keep it up." : "Consider reviewing your nutrition and activity levels."}`,
        severity: diff < 0 ? "positive" : "info",
        relatedEntityType: "tracker", relatedEntityId: weightTracker.id,
        data: { change: diff, entries: recent.length }, createdAt: now.toISOString(),
      });
    }
  }

  // 2. Exercise streak
  const fitnessTrackers = trackers.filter(t => t.category === "fitness");
  if (fitnessTrackers.length > 0) {
    const allFitnessEntries = fitnessTrackers.flatMap(t => t.entries).sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    let streak = 0;
    const todayFitness = getUserToday();
    for (let i = 0; i < 30; i++) {
      const dayStr = tzAddDays(todayFitness, -i);
      const hasEntry = allFitnessEntries.some(e => e.timestamp.slice(0, 10) === dayStr);
      if (hasEntry) streak++; else if (i > 0) break;
    }
    if (streak >= 2) {
      insights.push({
        id: randomUUID(), type: "streak",
        title: `${streak}-day fitness streak`,
        description: `You've worked out ${streak} days in a row. ${streak >= 7 ? "Incredible consistency!" : streak >= 3 ? "Building great momentum." : "Keep it going!"}`,
        severity: "positive", data: { streak }, createdAt: now.toISOString(),
      });
    }
  }

  // 3. Blood pressure alert
  const bpTracker = trackers.find(t => t.name.toLowerCase().includes("blood pressure") || t.name.toLowerCase().includes("bp"));
  if (bpTracker && bpTracker.entries.length > 0) {
    const latest = bpTracker.entries[bpTracker.entries.length - 1];
    const sys = parseFloat(latest.values.systolic);
    const dia = parseFloat(latest.values.diastolic);
    if (sys >= 140 || dia >= 90) {
      insights.push({
        id: randomUUID(), type: "anomaly",
        title: "Elevated blood pressure detected",
        description: `Your latest reading (${sys}/${dia}) is above the recommended range.`,
        severity: "warning", relatedEntityType: "tracker", relatedEntityId: bpTracker.id,
        data: { systolic: sys, diastolic: dia }, createdAt: now.toISOString(),
      });
    }
  }

  // 4. Spending trend
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const monthlyExpenses = expenses.filter(e => {
    const d = new Date(e.date); return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  });
  const monthTotal = monthlyExpenses.reduce((s, e) => s + e.amount, 0);
  if (monthTotal > 0) {
    const topCategory = Object.entries(
      monthlyExpenses.reduce((acc: Record<string, number>, e) => { acc[e.category] = (acc[e.category] || 0) + e.amount; return acc; }, {})
    ).sort((a, b) => b[1] - a[1])[0];
    if (topCategory) {
      insights.push({
        id: randomUUID(), type: "spending_trend",
        title: `$${monthTotal.toFixed(0)} spent this month`,
        description: `Top category: ${topCategory[0]} ($${topCategory[1].toFixed(0)}).`,
        severity: monthTotal > 1000 ? "warning" : "info",
        data: { total: monthTotal, topCategory: topCategory[0] }, createdAt: now.toISOString(),
      });
    }
  }

  // 5. Overdue tasks
  const overdueTasks = tasks.filter(t => {
    if (t.status === "done" || !t.dueDate) return false;
    return new Date(t.dueDate) < now;
  });
  if (overdueTasks.length > 0) {
    insights.push({
      id: randomUUID(), type: "reminder",
      title: `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? "s" : ""}`,
      description: overdueTasks.map(t => t.title).join(", "),
      severity: "negative", data: { taskIds: overdueTasks.map(t => t.id) }, createdAt: now.toISOString(),
    });
  }

  // 6. Habit streaks
  for (const habit of habits) {
    if (habit.currentStreak >= 3) {
      insights.push({
        id: randomUUID(), type: "habit_streak",
        title: `${habit.currentStreak}-day ${habit.name} streak`,
        description: `${habit.currentStreak >= 7 ? "Amazing consistency!" : "Keep building the habit!"}${habit.longestStreak > habit.currentStreak ? ` Your record is ${habit.longestStreak} days.` : " This is your personal best!"}`,
        severity: "positive", relatedEntityType: "habit", relatedEntityId: habit.id,
        data: { current: habit.currentStreak, longest: habit.longestStreak }, createdAt: now.toISOString(),
      });
    }
  }

  // 7. Upcoming obligations
  const sevenDaysOut = new Date(now.getTime() + 7 * 86400000);
  const upcomingObs = obligations.filter(o => {
    const due = new Date(o.nextDueDate);
    return due >= now && due <= sevenDaysOut;
  });
  if (upcomingObs.length > 0) {
    const totalDue = upcomingObs.reduce((s, o) => s + o.amount, 0);
    insights.push({
      id: randomUUID(), type: "obligation_due",
      title: `$${totalDue.toFixed(0)} due this week`,
      description: upcomingObs.map(o => `${o.name}: $${o.amount}`).join(", "),
      severity: "warning", data: { obligations: upcomingObs.map(o => o.id), total: totalDue }, createdAt: now.toISOString(),
    });
  }

  // 8. Mood trend
  const recentJournal = journal.filter(j => {
    const d = new Date(j.createdAt); return (now.getTime() - d.getTime()) < 7 * 86400000;
  });
  if (recentJournal.length >= 3) {
    const avg = recentJournal.reduce((s, j) => s + (MOOD_SCORES[j.mood] || 4), 0) / recentJournal.length;
    if (avg <= 3.0) {
      insights.push({
        id: randomUUID(), type: "mood_trend",
        title: "Mood has been low this week",
        description: "Your journal entries suggest a tough stretch. Consider reaching out to someone or doing something you enjoy.",
        severity: "warning", data: { avgMood: avg }, createdAt: now.toISOString(),
      });
    } else if (avg >= 6) {
      insights.push({
        id: randomUUID(), type: "mood_trend",
        title: "Great mood this week",
        description: "You've been feeling positive. Keep doing what's working!",
        severity: "positive", data: { avgMood: avg }, createdAt: now.toISOString(),
      });
    }
  }

  // 9. Calorie summary
  const todayStr = getUserToday();
  let totalCalsBurned = 0;
  for (const t of trackers) {
    for (const e of t.entries) {
      if (e.timestamp.slice(0, 10) === todayStr && e.computed?.caloriesBurned) {
        totalCalsBurned += e.computed.caloriesBurned;
      }
    }
  }
  if (totalCalsBurned > 0) {
    insights.push({
      id: randomUUID(), type: "health_correlation",
      title: `${totalCalsBurned} calories burned today`,
      description: `Based on your logged activities. ${totalCalsBurned > 500 ? "Great active day!" : "Every bit counts."}`,
      severity: "positive", data: { caloriesBurned: totalCalsBurned }, createdAt: now.toISOString(),
    });
  }

  // 10. Stale trackers suggestion
  if (trackers.length > 0) {
    const noRecentEntries = trackers.filter(t => {
      if (t.entries.length === 0) return true;
      const last = new Date(t.entries[t.entries.length - 1].timestamp);
      return (now.getTime() - last.getTime()) > 3 * 86400000;
    });
    if (noRecentEntries.length > 0) {
      insights.push({
        id: randomUUID(), type: "suggestion",
        title: "Trackers need attention",
        description: `${noRecentEntries.map(t => t.name).join(", ")} haven't been updated in 3+ days.`,
        severity: "info", data: { trackerIds: noRecentEntries.map(t => t.id) }, createdAt: now.toISOString(),
      });
    }
  }

  return insights;
}

// ============================================================
// STORAGE IMPLEMENTATION
// ============================================================

/**
 * @deprecated MemStorage is NOT used in production or tests. The runtime
 * storage is SupabaseStorage (see getStorage() at the bottom of this file),
 * which is hard-required by an env-var assertion. This class is kept only
 * as a reference implementation of the IStorage interface — do NOT add
 * production logic to it. Bugs #34/#35/#36 against MemStorage parity are
 * therefore unreachable; if you ever wire MemStorage back in, audit the
 * full IStorage surface against SupabaseStorage first.
 */
export class MemStorage implements IStorage {
  private profiles: Map<string, Profile> = new Map();
  private trackers: Map<string, Tracker> = new Map();
  private tasks: Map<string, Task> = new Map();
  private expenses: Map<string, Expense> = new Map();
  private events: Map<string, CalendarEvent> = new Map();
  private documents: Map<string, Document> = new Map();
  private habits: Map<string, Habit> = new Map();
  private obligations: Map<string, Obligation> = new Map();
  private artifacts: Map<string, Artifact> = new Map();
  private journal: Map<string, JournalEntry> = new Map();
  private memories: Map<string, MemoryItem> = new Map();
  private goals: Map<string, Goal> = new Map();
  private domains: Map<string, Domain> = new Map();
  private domainEntries: Map<string, DomainEntry> = new Map();
  private entityLinks: Map<string, EntityLink> = new Map();
  private activity: { type: string; description: string; timestamp: string }[] = [];

  constructor() {
    // No seed data in production
  }

  private seedData() {
    return;
  }

  private logActivity(type: string, description: string) {
    this.activity.unshift({ type, description, timestamp: new Date().toISOString() });
    if (this.activity.length > 50) this.activity.pop();
  }

  // ---- Profiles ----
  async getProfiles() {
    const all = Array.from(this.profiles.values());
    return all.map(p => this.healProfileName(p, all));
  }
  async getProfile(id: string) {
    const p = this.profiles.get(id);
    return p ? this.healProfileName(p, Array.from(this.profiles.values())) : p;
  }
  // Parity with SupabaseStorage: strip a legacy possessive owner prefix from
  // child/asset profile names ("Craig's Ford F250" → "Ford F250").
  private healProfileName(p: Profile, all: Profile[]): Profile {
    const CHILD_TYPES = new Set(["vehicle", "asset", "subscription", "loan", "investment", "account", "property"]);
    if (!CHILD_TYPES.has(p.type as string)) return p;
    const parentName = p.parentProfileId ? all.find(x => x.id === p.parentProfileId)?.name : undefined;
    const personNames = all.filter(x => x.type === "person" || x.type === "self").map(x => x.name);
    const cleaned = stripOwnerPossessivePrefix(p.name, [parentName, ...personNames]);
    return cleaned === p.name ? p : { ...p, name: cleaned };
  }

  async getProfileDetail(id: string): Promise<ProfileDetail | undefined> {
    const profile = this.profiles.get(id);
    if (!profile) return undefined;

    const allTrackers = Array.from(this.trackers.values());
    const allExpenses = Array.from(this.expenses.values());
    const allTasks = Array.from(this.tasks.values());
    const allEvents = Array.from(this.events.values());
    const allDocs = Array.from(this.documents.values());
    const allObs = Array.from(this.obligations.values());

    const relatedTrackers = allTrackers.filter(t => t.linkedProfiles.includes(id));
    const relatedExpenses = allExpenses.filter(e => e.linkedProfiles.includes(id) || profile.linkedExpenses.includes(e.id));
    const relatedTasks = allTasks.filter(t => t.linkedProfiles.includes(id) || profile.linkedTasks.includes(t.id));
    const relatedEvents = allEvents.filter(e => e.linkedProfiles.includes(id) || profile.linkedEvents.includes(e.id));
    // PERF 2026-07-21: metadata only — never embed base64 file blobs in the
    // aggregation (SupabaseStorage already does this; MemStorage was shipping
    // full fileData per doc, which dominated the dev-path payload).
    const relatedDocuments = allDocs
      .filter(d => d.linkedProfiles.includes(id) || profile.documents.includes(d.id))
      .map(d => (d.fileData ? { ...d, fileData: "" } : d));
    const relatedObligations = allObs.filter(o => o.linkedProfiles.includes(id));
    // Parity with SupabaseStorage: journal entries linked to this profile.
    const relatedJournal = Array.from(this.journal.values()).filter(j => (j.linkedProfiles || []).includes(id));

    const timeline: TimelineEntry[] = [];
    for (const t of relatedTrackers) {
      for (const e of t.entries) {
        timeline.push({ id: e.id, type: "tracker", title: `${t.name} logged`, description: formatTrackerValues(t.name, e.values, t.unit), data: { ...e.values, computed: e.computed }, timestamp: e.timestamp });
      }
    }
    for (const e of relatedExpenses) { timeline.push({ id: e.id, type: "expense", title: e.description, description: `$${e.amount} - ${e.category}`, timestamp: e.date }); }
    for (const t of relatedTasks) { timeline.push({ id: t.id, type: "task", title: t.title, description: `${t.status} - ${t.priority}`, timestamp: t.createdAt }); }
    for (const e of relatedEvents) { timeline.push({ id: e.id, type: "event", title: e.title, description: e.description, timestamp: e.date }); }
    for (const d of relatedDocuments) { timeline.push({ id: d.id, type: "document", title: d.name, description: d.type, timestamp: d.createdAt }); }
    for (const o of relatedObligations) { timeline.push({ id: o.id, type: "obligation", title: o.name, description: `$${o.amount}/${o.frequency}`, timestamp: o.createdAt }); }
    for (const j of relatedJournal) { timeline.push({ id: j.id, type: "journal", title: j.content?.slice(0, 80) || "Journal entry", description: j.mood ? `Mood: ${j.mood}` : undefined, timestamp: j.date || j.createdAt }); }
    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Find child profiles (assets, subscriptions, loans nested under this profile)
    const allProfiles = await this.getProfiles();
    const childProfiles = allProfiles.filter(p => p.parentProfileId === profile.id);

    const relatedHabits = Array.from(this.habits.values()).filter(h => (h.linkedProfiles || []).includes(id));

    // PERF 2026-07-21: same additive caps as SupabaseStorage.getProfileDetail —
    // newest N per section + true *Total/*Sum sibling fields (see
    // capProfileDetailLists in supabase-storage.ts).
    const capped = capProfileDetailLists({
      relatedTrackers, relatedExpenses, relatedEvents, relatedDocuments, relatedJournal, timeline,
      profileId: id,
    });
    return { ...profile, ...capped, relatedTasks, relatedObligations, relatedHabits, childProfiles };
  }

  async createProfile(data: InsertProfile): Promise<Profile> {
    const now = new Date().toISOString();
    const profile: Profile = { id: randomUUID(), ...data, fields: data.fields || {}, tags: data.tags || [], notes: data.notes || "", documents: [], linkedTrackers: [], linkedExpenses: [], linkedTasks: [], linkedEvents: [], createdAt: now, updatedAt: now };
    this.profiles.set(profile.id, profile);
    this.logActivity("profile", `Created profile: ${profile.name}`);
    return profile;
  }

  async updateProfile(id: string, data: Partial<Profile>) {
    const p = this.profiles.get(id);
    if (!p) return undefined;
    const updated = { ...p, ...data, updatedAt: new Date().toISOString() };
    this.profiles.set(id, updated);
    return updated;
  }

  async deleteProfile(id: string): Promise<boolean> {
    const profile = this.profiles.get(id);
    if (!profile) return false;

    // Cascade delete: for each entity type, if sole owner → delete; if shared → remove profile ID from linkedProfiles

    // 1. Trackers (and their entries)
    for (const [tid, tracker] of this.trackers) {
      if (tracker.linkedProfiles.includes(id)) {
        if (tracker.linkedProfiles.length <= 1) {
          this.trackers.delete(tid);
        } else {
          tracker.linkedProfiles = tracker.linkedProfiles.filter(pid => pid !== id);
        }
      }
    }

    // 2. Expenses
    for (const [eid, expense] of this.expenses) {
      if (expense.linkedProfiles.includes(id)) {
        if (expense.linkedProfiles.length <= 1) {
          this.expenses.delete(eid);
        } else {
          expense.linkedProfiles = expense.linkedProfiles.filter(pid => pid !== id);
        }
      }
    }

    // 3. Tasks
    for (const [tid, task] of this.tasks) {
      if (task.linkedProfiles.includes(id)) {
        if (task.linkedProfiles.length <= 1) {
          this.tasks.delete(tid);
        } else {
          task.linkedProfiles = task.linkedProfiles.filter(pid => pid !== id);
        }
      }
    }

    // 4. Habits (and their check-ins are embedded)
    for (const [hid, habit] of this.habits) {
      if ((habit.linkedProfiles || []).includes(id)) {
        if ((habit.linkedProfiles || []).length <= 1) {
          this.habits.delete(hid);
        } else {
          habit.linkedProfiles = (habit.linkedProfiles || []).filter(pid => pid !== id);
        }
      }
    }

    // 5. Obligations
    for (const [oid, ob] of this.obligations) {
      if (ob.linkedProfiles.includes(id)) {
        if (ob.linkedProfiles.length <= 1) {
          this.obligations.delete(oid);
        } else {
          ob.linkedProfiles = ob.linkedProfiles.filter(pid => pid !== id);
        }
      }
    }

    // 6. Events
    for (const [eid, ev] of this.events) {
      if (ev.linkedProfiles.includes(id)) {
        if (ev.linkedProfiles.length <= 1) {
          this.events.delete(eid);
        } else {
          ev.linkedProfiles = ev.linkedProfiles.filter(pid => pid !== id);
        }
      }
    }

    // 7. Documents
    for (const [did, doc] of this.documents) {
      if ((doc.linkedProfiles || []).includes(id)) {
        if ((doc.linkedProfiles || []).length <= 1) {
          this.documents.delete(did);
        } else {
          doc.linkedProfiles = (doc.linkedProfiles || []).filter(pid => pid !== id);
        }
      }
    }

    // 8. Artifacts
    for (const [aid, art] of this.artifacts) {
      if ((art.linkedProfiles || []).includes(id)) {
        if ((art.linkedProfiles || []).length <= 1) {
          this.artifacts.delete(aid);
        } else {
          art.linkedProfiles = (art.linkedProfiles || []).filter(pid => pid !== id);
        }
      }
    }

    // 9. Goals
    for (const [gid, goal] of this.goals) {
      if ((goal.linkedProfiles || []).includes(id)) {
        if ((goal.linkedProfiles || []).length <= 1) {
          this.goals.delete(gid);
        } else {
          goal.linkedProfiles = (goal.linkedProfiles || []).filter(pid => pid !== id);
        }
      }
    }

    // 10. Journal entries
    for (const [jid, entry] of this.journal) {
      if ((entry.linkedProfiles || []).includes(id)) {
        if ((entry.linkedProfiles || []).length <= 1) {
          this.journal.delete(jid);
        } else {
          entry.linkedProfiles = (entry.linkedProfiles || []).filter(pid => pid !== id);
        }
      }
    }

    // 11. Entity links
    for (const [elid, link] of this.entityLinks) {
      if ((link.sourceType === "profile" && link.sourceId === id) ||
          (link.targetType === "profile" && link.targetId === id)) {
        this.entityLinks.delete(elid);
      }
    }

    return this.profiles.delete(id);
  }

  async linkProfileTo(profileId: string, entityType: string, entityId: string) {
    const p = this.profiles.get(profileId);
    if (!p) return;
    switch (entityType) {
      case "tracker": if (!p.linkedTrackers.includes(entityId)) p.linkedTrackers.push(entityId); break;
      case "expense": if (!p.linkedExpenses.includes(entityId)) p.linkedExpenses.push(entityId); break;
      case "task": if (!p.linkedTasks.includes(entityId)) p.linkedTasks.push(entityId); break;
      case "event": if (!p.linkedEvents.includes(entityId)) p.linkedEvents.push(entityId); break;
      case "document": if (!p.documents.includes(entityId)) p.documents.push(entityId); break;
    }
  }

  async unlinkProfileFrom(profileId: string, entityType: string, entityId: string) {
    const p = this.profiles.get(profileId);
    if (!p) return;
    switch (entityType) {
      case "tracker": p.linkedTrackers = p.linkedTrackers.filter(id => id !== entityId); break;
      case "expense": p.linkedExpenses = p.linkedExpenses.filter(id => id !== entityId); break;
      case "task": p.linkedTasks = p.linkedTasks.filter(id => id !== entityId); break;
      case "event": p.linkedEvents = p.linkedEvents.filter(id => id !== entityId); break;
      case "document": p.documents = p.documents.filter(id => id !== entityId); break;
    }
  }

  async propagateDocumentToAncestors(_documentId: string, _profileId: string): Promise<string[]> {
    return []; // stub — propagation handled in Supabase storage
  }

  async propagateEntityToAncestors(_entityType: string, _entityId: string, _profileId: string): Promise<string[]> {
    return []; // stub — propagation handled in Supabase storage
  }

  async getSelfProfile(): Promise<Profile | undefined> {
    return Array.from(this.profiles.values()).find(p => p.type === "self");
  }

  async wouldCreateCycle(_userId: string, profileId: string, newParentId: string | null): Promise<boolean> {
    // MemStorage is dev-only. The walk-up parent-chain check below matches the
    // production SupabaseStorage implementation behavior-for-behavior (both
    // guard against pre-existing cycles via a visited set), so no further
    // work is needed here.
    if (!newParentId) return false;
    if (newParentId === profileId) return true;
    let current: Profile | undefined = this.profiles.get(newParentId);
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.id)) break; // guard against existing cycles
      visited.add(current.id);
      const parentId = current.parentProfileId;
      if (!parentId) break;
      if (parentId === profileId) return true;
      current = this.profiles.get(parentId);
    }
    return false;
  }

  // ---- Trackers ----
  async getTrackers() { return Array.from(this.trackers.values()).map(t => this.healTrackerName(t)); }
  async getTracker(id: string) { const t = this.trackers.get(id); return t ? this.healTrackerName(t) : t; }
  // Parity with SupabaseStorage: strip a legacy "<Name> - <Owner>" suffix using
  // the tracker's own linked profiles' names (display-only in MemStorage).
  private healTrackerName(t: Tracker): Tracker {
    const ownerNames = (t.linkedProfiles || [])
      .map(id => this.profiles.get(id)?.name)
      .filter(Boolean) as string[];
    if (!ownerNames.length) return t;
    const cleaned = stripTrackerOwnerSuffix(t.name, ownerNames);
    return cleaned === t.name ? t : { ...t, name: cleaned };
  }
  async createTracker(data: InsertTracker): Promise<Tracker> {
    const tracker: Tracker = { id: randomUUID(), ...data, fields: data.fields || [], entries: [], linkedProfiles: [], createdAt: new Date().toISOString() };
    this.trackers.set(tracker.id, tracker);
    this.logActivity("tracker", `Created tracker: ${tracker.name}`);
    return tracker;
  }
  async logEntry(data: InsertTrackerEntry): Promise<TrackerEntry | undefined> {
    const tracker = this.trackers.get(data.trackerId);
    if (!tracker) return undefined;
    // Mirror supabase-storage: provenance metadata moves from values into computed.
    const { _enrichment: enrichmentMeta, ...values } = { ...data.values } as Record<string, any>;
    const computed = { ...computeSecondaryData(tracker.name, tracker.category, values), ...(enrichmentMeta ? { enrichment: enrichmentMeta } : {}) } as any;
    const entry: TrackerEntry = { id: randomUUID(), values, computed, notes: data.notes, mood: data.mood as any, tags: data.tags, timestamp: data.timestamp || new Date().toISOString() };
    tracker.entries.push(entry);
    let desc = `Logged ${tracker.name}: ${JSON.stringify(data.values)}`;
    if (computed.caloriesBurned) desc += ` (~${computed.caloriesBurned} cal burned)`;
    if (computed.pace) desc += ` (${computed.pace} pace)`;
    if (computed.caloriesConsumed) desc += ` (${computed.caloriesConsumed} cal)`;
    if (computed.bloodPressureCategory) desc += ` (${computed.bloodPressureCategory})`;
    if (computed.sleepQuality) desc += ` (${computed.sleepQuality} quality)`;
    this.logActivity("tracker", desc);
    return entry;
  }
  async updateTracker(id: string, data: Partial<Tracker>): Promise<Tracker | undefined> {
    const tracker = this.trackers.get(id);
    if (!tracker) return undefined;
    const updated = { ...tracker, ...data };
    this.trackers.set(id, updated);
    this.logActivity("tracker", `Updated tracker: ${updated.name}`);
    return updated;
  }
  async updateTrackerEntry(trackerId: string, entryId: string, patch: { values?: Record<string, any>; notes?: string; mood?: any; tags?: string[]; timestamp?: string }): Promise<TrackerEntry | undefined> {
    const tracker = this.trackers.get(trackerId);
    if (!tracker) return undefined;
    const idx = tracker.entries.findIndex(e => e.id === entryId);
    if (idx === -1) return undefined;
    const existing = tracker.entries[idx];
    const updated: TrackerEntry = {
      ...existing,
      values: patch.values ? { ...existing.values, ...patch.values } : existing.values,
      notes: patch.notes !== undefined ? patch.notes : existing.notes,
      mood: patch.mood !== undefined ? patch.mood : existing.mood,
      tags: patch.tags !== undefined ? patch.tags : existing.tags,
      timestamp: patch.timestamp || existing.timestamp,
    };
    tracker.entries[idx] = updated;
    this.logActivity("tracker", `Updated entry on tracker: ${tracker.name}`);
    return updated;
  }
  async deleteTrackerEntry(trackerId: string, entryId: string): Promise<boolean> {
    const tracker = this.trackers.get(trackerId);
    if (!tracker) return false;
    const idx = tracker.entries.findIndex(e => e.id === entryId);
    if (idx === -1) return false;
    tracker.entries.splice(idx, 1);
    this.logActivity("tracker", `Deleted entry from tracker: ${tracker.name}`);
    return true;
  }
  async deleteTracker(id: string) { return this.trackers.delete(id); }
  async migrateUnlinkedTrackersToSelf(): Promise<number> {
    const self = await this.getSelfProfile();
    if (!self) return 0;
    let count = 0;
    for (const tracker of this.trackers.values()) {
      if (tracker.linkedProfiles.length === 0) {
        tracker.linkedProfiles.push(self.id);
        if (!self.linkedTrackers.includes(tracker.id)) self.linkedTrackers.push(tracker.id);
        count++;
      }
    }
    return count;
  }

  // ---- Tasks ----
  async getTasks() { return Array.from(this.tasks.values()); }
  async getTask(id: string) { return this.tasks.get(id); }
  async createTask(data: InsertTask): Promise<Task> {
    const task: Task = { id: randomUUID(), ...data, status: "todo", priority: data.priority || "medium", linkedProfiles: [], tags: data.tags || [], createdAt: new Date().toISOString() };
    this.tasks.set(task.id, task);
    this.logActivity("task", `Created task: ${task.title}`);
    return task;
  }
  async updateTask(id: string, data: Partial<Task>) {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const updated = { ...t, ...data, updatedAt: new Date().toISOString() };
    this.tasks.set(id, updated);
    if (data.status === "done") this.logActivity("task", `Completed: ${t.title}`);
    return updated;
  }
  async deleteTask(id: string) { return this.tasks.delete(id); }

  // ---- Expenses ----
  async getExpenses() { return Array.from(this.expenses.values()); }
  async getExpense(id: string) { return this.expenses.get(id); }
  async createExpense(data: InsertExpense): Promise<Expense> {
    const expense: Expense = { id: randomUUID(), ...data, category: data.category || "general", linkedProfiles: data.linkedProfiles || [], tags: data.tags || [], date: data.date || new Date().toISOString(), createdAt: new Date().toISOString() };
    this.expenses.set(expense.id, expense);
    this.logActivity("expense", `${data.description} - $${data.amount}${data.vendor ? ` at ${data.vendor}` : ""}`);
    return expense;
  }
  async updateExpense(id: string, data: Partial<Expense>): Promise<Expense | undefined> {
    const expense = this.expenses.get(id);
    if (!expense) return undefined;
    const updated = { ...expense, ...data };
    this.expenses.set(id, updated);
    this.logActivity("expense", `Updated expense: ${updated.description}`);
    return updated;
  }
  async deleteExpense(id: string): Promise<boolean> { return this.expenses.delete(id); }

  // ---- Events ----
  async getEvents() { return Array.from(this.events.values()); }
  async getEvent(id: string) { return this.events.get(id); }
  async createEvent(data: InsertEvent): Promise<CalendarEvent> {
    const event: CalendarEvent = {
      id: randomUUID(),
      title: data.title,
      date: data.date,
      time: data.time,
      endTime: data.endTime,
      endDate: data.endDate,
      allDay: data.allDay ?? false,
      description: data.description,
      location: data.location,
      category: data.category || "personal",
      color: data.color,
      recurrence: data.recurrence || "none",
      recurrenceEnd: data.recurrenceEnd,
      linkedProfiles: data.linkedProfiles || [],
      linkedDocuments: data.linkedDocuments || [],
      tags: data.tags || [],
      source: data.source || "manual",
      createdAt: new Date().toISOString(),
    };
    this.events.set(event.id, event);
    // Link to profiles
    for (const pId of event.linkedProfiles) {
      const p = this.profiles.get(pId);
      if (p && !p.linkedEvents.includes(event.id)) p.linkedEvents.push(event.id);
    }
    this.logActivity("event", `Created event: ${event.title} on ${event.date}${event.recurrence !== "none" ? ` (${event.recurrence})` : ""}`);
    return event;
  }
  async updateEvent(id: string, data: Partial<CalendarEvent>): Promise<CalendarEvent | undefined> {
    const event = this.events.get(id);
    if (!event) return undefined;
    const updated = { ...event, ...data };
    this.events.set(id, updated);
    this.logActivity("event", `Updated event: ${updated.title}`);
    return updated;
  }
  async deleteEvent(id: string): Promise<boolean> { return this.events.delete(id); }

  // ---- Unified Calendar Timeline ----
  async getCalendarTimeline(startDate: string, endDate: string, _profileIds?: string[]): Promise<CalendarTimelineItem[]> {
    const items: CalendarTimelineItem[] = [];

    // 1. Calendar events (expand recurrence). Recurring Dates per-occurrence
    // state (rd:done/rd:skip/rd:paused/rd:archived tags — see
    // shared/recurring-dates) applies here exactly like the Supabase timeline.
    const rdTodayISO = new Date().toLocaleDateString("en-CA");
    for (const ev of this.events.values()) {
      const color = ev.color || EVENT_CATEGORY_COLORS[ev.category] || "#4F98A3";
      const rdMeta = parseRecurringMeta(ev.tags);
      if (rdMeta.archived) continue;
      const rdShow = (dateISO: string) =>
        !rdMeta.skippedDates.includes(dateISO) && !(rdMeta.paused && dateISO >= rdTodayISO && !rdMeta.completedDates.includes(dateISO));
      // Add base event
      const baseDate = ev.date.slice(0, 10);
      if (baseDate >= startDate && baseDate <= endDate && rdShow(baseDate)) {
        items.push({
          id: `event-${ev.id}-${baseDate}`,
          type: "event",
          title: ev.title,
          date: baseDate,
          time: ev.time,
          endTime: ev.endTime,
          allDay: ev.allDay,
          color,
          category: ev.category,
          description: ev.description,
          location: ev.location,
          linkedProfiles: ev.linkedProfiles,
          sourceId: ev.id,
          completed: rdMeta.completedDates.includes(baseDate),
          meta: { recurrence: ev.recurrence, tags: ev.tags, source: ev.source },
        });
      }
      // Expand recurring
      if (ev.recurrence !== "none") {
        const base = parseLocalDate(ev.date);
        for (let i = 1; i <= 90; i++) {
          const next = new Date(base);
          switch (ev.recurrence) {
            case "daily":    next.setDate(next.getDate() + i); break;
            case "weekly":   next.setDate(next.getDate() + i * 7); break;
            case "biweekly": next.setDate(next.getDate() + i * 14); break;
            case "monthly":  next.setMonth(next.getMonth() + i); break;
            case "yearly":   next.setFullYear(next.getFullYear() + i); break;
          }
          const nextStr = next.toLocaleDateString('en-CA');
          if (nextStr > endDate) break;
          if (ev.recurrenceEnd && nextStr > ev.recurrenceEnd) break;
          if (nextStr >= startDate && rdShow(nextStr)) {
            items.push({
              id: `event-${ev.id}-${nextStr}`,
              type: "event",
              title: ev.title,
              date: nextStr,
              time: ev.time,
              endTime: ev.endTime,
              allDay: ev.allDay,
              color,
              category: ev.category,
              description: ev.description,
              location: ev.location,
              linkedProfiles: ev.linkedProfiles,
              sourceId: ev.id,
              completed: rdMeta.completedDates.includes(nextStr),
              meta: { recurrence: ev.recurrence, tags: ev.tags, source: ev.source },
            });
          }
        }
      }
    }

    // 2. Tasks with due dates
    for (const task of this.tasks.values()) {
      if (task.dueDate) {
        const d = task.dueDate.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({
            id: `task-${task.id}`,
            type: "task",
            title: task.title,
            date: d,
            allDay: true,
            color: task.priority === "high" ? "#A13544" : task.priority === "medium" ? "#BB653B" : "#797876",
            category: "task",
            description: task.description,
            completed: task.status === "done",
            linkedProfiles: task.linkedProfiles,
            sourceId: task.id,
            meta: { priority: task.priority, status: task.status },
          });
        }
      }
    }

    // 3. Obligations by nextDueDate
    for (const ob of this.obligations.values()) {
      const d = ob.nextDueDate.slice(0, 10);
      if (d >= startDate && d <= endDate) {
        items.push({
          id: `obligation-${ob.id}`,
          type: "obligation",
          title: `${ob.name} — $${ob.amount}`,
          date: d,
          allDay: true,
          color: "#BB653B",
          category: ob.category,
          description: ob.autopay ? "Autopay enabled" : undefined,
          linkedProfiles: ob.linkedProfiles,
          sourceId: ob.id,
          meta: { amount: ob.amount, frequency: ob.frequency, autopay: ob.autopay },
        });
      }
    }

    // 4. Habits — show on each applicable day in the range (daily, weekly, custom)
    for (const habit of this.habits.values()) {
      const start = parseLocalDate(startDate);
      const end = parseLocalDate(endDate);
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toLocaleDateString('en-CA');
        const dayOfWeek = d.getDay();
        const showOnDay = habit.frequency === "daily" ||
          (habit.frequency === "weekly" && (habit.targetDays?.includes(dayOfWeek) ?? dayOfWeek === 1)) ||
          (habit.frequency === "custom" && habit.targetDays?.includes(dayOfWeek));
        if (showOnDay) {
          const checkedToday = habit.checkins.filter(c => c.date === dateStr).length;
          const target = habit.targetPerDay || 1;
          const isDone = checkedToday >= target;
          items.push({
            id: `habit-${habit.id}-${dateStr}`,
            type: "habit",
            title: habit.name + (target > 1 ? ` (${checkedToday}/${target})` : ""),
            date: dateStr,
            allDay: true,
            color: isDone ? "#10B981" : (habit.color || "#8B5CF6"),
            completed: isDone,
            linkedProfiles: habit.linkedProfiles || [],
            sourceId: habit.id,
            meta: { streak: habit.currentStreak, icon: habit.icon, frequency: habit.frequency },
          });
        }
      }
    }

    // Sort by date then time
    items.sort((a, b) => {
      const cmp = a.date.localeCompare(b.date);
      if (cmp !== 0) return cmp;
      if (a.allDay && !b.allDay) return -1;
      if (!a.allDay && b.allDay) return 1;
      return (a.time || "").localeCompare(b.time || "");
    });

    return items;
  }

  // ---- Documents ----
  async getDocuments() { return Array.from(this.documents.values()); }
  async getDocument(id: string) { return this.documents.get(id); }
  async createDocument(data: any): Promise<Document> {
    const document: Document = {
      id: randomUUID(),
      name: data.name,
      type: data.type || "other",
      mimeType: data.mimeType || "image/jpeg",
      fileData: data.fileData || "",
      extractedData: data.extractedData || {},
      linkedProfiles: data.linkedProfiles || [],
      tags: data.tags || [],
      createdAt: new Date().toISOString(),
    };
    this.documents.set(document.id, document);
    // Link to profiles
    for (const pid of document.linkedProfiles) {
      const profile = this.profiles.get(pid);
      if (profile && !profile.documents.includes(document.id)) {
        profile.documents.push(document.id);
      }
    }
    this.logActivity("document", `Stored document: ${document.name}`);
    return document;
  }
  async updateDocument(id: string, data: Partial<Document>): Promise<Document | undefined> {
    const doc = this.documents.get(id);
    if (!doc) return undefined;
    // If linkedProfiles is being updated, sync profile.documents arrays
    if (data.linkedProfiles) {
      // Remove from profiles no longer linked
      for (const pid of doc.linkedProfiles) {
        if (!data.linkedProfiles.includes(pid)) {
          const profile = this.profiles.get(pid);
          if (profile) profile.documents = profile.documents.filter(did => did !== id);
        }
      }
      // Add to newly linked profiles
      for (const pid of data.linkedProfiles) {
        if (!doc.linkedProfiles.includes(pid)) {
          const profile = this.profiles.get(pid);
          if (profile && !profile.documents.includes(id)) profile.documents.push(id);
        }
      }
    }
    const updated = { ...doc, ...data };
    this.documents.set(id, updated);
    this.logActivity("document", `Updated document: ${updated.name}`);
    return updated;
  }
  async deleteDocument(id: string): Promise<boolean> {
    const doc = this.documents.get(id);
    if (!doc) return false;
    // Remove from linked profiles
    for (const pid of doc.linkedProfiles) {
      const profile = this.profiles.get(pid);
      if (profile) profile.documents = profile.documents.filter(did => did !== id);
    }
    this.logActivity("document", `Deleted document: ${doc.name}`);
    return this.documents.delete(id);
  }
  async getDocumentsForProfile(profileId: string): Promise<Document[]> {
    return Array.from(this.documents.values()).filter(d => d.linkedProfiles.includes(profileId));
  }

  // ---- Habits ----
  async getHabits() { return Array.from(this.habits.values()); }
  async getHabit(id: string) { return this.habits.get(id); }
  async createHabit(data: InsertHabit): Promise<Habit> {
    const habit: Habit = { id: randomUUID(), ...data, frequency: data.frequency || "daily", targetPerDay: data.targetPerDay || 1, timeOfDay: data.timeOfDay ?? undefined, scheduledTime: data.scheduledTime ?? undefined, currentStreak: 0, longestStreak: 0, checkins: [], createdAt: new Date().toISOString() };
    this.habits.set(habit.id, habit);
    this.logActivity("habit", `Created habit: ${habit.name}`);
    return habit;
  }
  async checkinHabit(habitId: string, date?: string, value?: number, notes?: string): Promise<HabitCheckin | undefined> {
    const habit = this.habits.get(habitId);
    if (!habit) return undefined;
    const checkinDate = date || getUserToday();
    // Allow multiple check-ins per day up to targetPerDay (matches Supabase implementation)
    const todayCheckins = habit.checkins.filter(c => c.date === checkinDate);
    const maxPerDay = habit.targetPerDay || 1;
    if (todayCheckins.length >= maxPerDay) {
      return todayCheckins[todayCheckins.length - 1];
    }
    const checkin: HabitCheckin = { id: randomUUID(), date: checkinDate, value, notes, timestamp: new Date().toISOString() };
    habit.checkins.push(checkin);
    // Recalculate streaks (with targetPerDay support)
    const { current, longest } = calculateStreak(habit.checkins, habit.targetPerDay || 1);
    habit.currentStreak = current;
    habit.longestStreak = Math.max(longest, habit.longestStreak);
    this.logActivity("habit", `Checked in: ${habit.name}${value ? ` (${value})` : ""}`);
    return checkin;
  }
  async updateHabit(id: string, data: Partial<Habit>): Promise<Habit | undefined> {
    const habit = this.habits.get(id);
    if (!habit) return undefined;
    const updated = { ...habit, ...data };
    this.habits.set(id, updated);
    return updated;
  }
  async deleteHabit(id: string) { return this.habits.delete(id); }

  // ---- Obligations ----
  async getObligations() { return Array.from(this.obligations.values()); }
  async getObligation(id: string) { return this.obligations.get(id); }
  async createObligation(data: InsertObligation): Promise<Obligation> {
    const d: any = data;
    const obligation: Obligation = {
      id: randomUUID(),
      name: d.name, amount: d.amount, nextDueDate: d.nextDueDate,
      notes: d.notes,
      category: d.category || "general",
      frequency: d.frequency || "monthly",
      autopay: d.autopay ?? false,
      status: "active",
      kind: d.kind || "bill",
      leadTimeDays: d.leadTimeDays ?? 3,
      autoLogExpense: d.autoLogExpense ?? false,
      currency: d.currency || "USD",
      linkedProfiles: d.linkedProfiles || [],
      linkedAssetId: d.linkedAssetId || undefined,
      linkedLiabilityId: d.linkedLiabilityId || undefined,
      linkedDocumentId: d.linkedDocumentId || undefined,
      recurrenceEnd: d.recurrenceEnd || undefined,
      icon: d.icon || undefined,
      payments: [],
      createdAt: new Date().toISOString(),
    };
    this.obligations.set(obligation.id, obligation);
    this.logActivity("obligation", `Created obligation: ${obligation.name} ($${obligation.amount}/${obligation.frequency})`);
    return obligation;
  }
  async updateObligation(id: string, data: Partial<Obligation>): Promise<Obligation | undefined> {
    const ob = this.obligations.get(id);
    if (!ob) return undefined;
    const updated = { ...ob, ...data };
    this.obligations.set(id, updated);
    this.logActivity("obligation", `Updated obligation: ${updated.name}`);
    return updated;
  }
  async payObligation(obligationId: string, amount: number, method?: string, confirmationNumber?: string): Promise<ObligationPayment | undefined> {
    const ob = this.obligations.get(obligationId);
    if (!ob) return undefined;
    const payment: ObligationPayment = { id: randomUUID(), amount, date: new Date().toISOString(), method, confirmationNumber };
    ob.payments.push(payment);
    // Advance next due date
    const nextDue = parseLocalDate(ob.nextDueDate);
    switch (ob.frequency) {
      case "weekly": nextDue.setDate(nextDue.getDate() + 7); break;
      case "biweekly": nextDue.setDate(nextDue.getDate() + 14); break;
      case "monthly": nextDue.setMonth(nextDue.getMonth() + 1); break;
      case "quarterly": nextDue.setMonth(nextDue.getMonth() + 3); break;
      case "yearly": nextDue.setFullYear(nextDue.getFullYear() + 1); break;
    }
    ob.nextDueDate = nextDue.toLocaleDateString('en-CA');
    this.logActivity("obligation", `Paid ${ob.name}: $${amount}`);
    return payment;
  }
  async deleteObligation(id: string) { return this.obligations.delete(id); }

  // ---- Artifacts ----
  async getArtifacts() { return Array.from(this.artifacts.values()); }
  async getArtifact(id: string) { return this.artifacts.get(id); }
  async createArtifact(data: InsertArtifact): Promise<Artifact> {
    const now = new Date().toISOString();
    const items: ChecklistItem[] = (data.items || []).map((item, i) => ({
      id: randomUUID(), text: item.text, checked: item.checked ?? false, order: i,
    }));
    const artifact: Artifact = {
      id: randomUUID(), ...data, items,
      tags: data.tags || [], linkedProfiles: data.linkedProfiles || [],
      pinned: data.pinned ?? false,
      language: (data as any).language,
      dataBindings: (data as any).dataBindings,
      chartData: (data as any).chartData,
      createdAt: now, updatedAt: now,
    };
    this.artifacts.set(artifact.id, artifact);
    this.logActivity("artifact", `Created ${artifact.type}: ${artifact.title}`);
    return artifact;
  }
  async updateArtifact(id: string, data: Partial<Artifact>) {
    const a = this.artifacts.get(id);
    if (!a) return undefined;
    const updated = { ...a, ...data, updatedAt: new Date().toISOString() };
    this.artifacts.set(id, updated);
    return updated;
  }
  async toggleChecklistItem(artifactId: string, itemId: string) {
    const a = this.artifacts.get(artifactId);
    if (!a) return undefined;
    const item = a.items.find(i => i.id === itemId);
    if (item) item.checked = !item.checked;
    a.updatedAt = new Date().toISOString();
    return a;
  }
  async deleteArtifact(id: string) { return this.artifacts.delete(id); }

  // ---- Journal ----
  async getJournalEntries() { return Array.from(this.journal.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()); }
  async createJournalEntry(data: InsertJournalEntry): Promise<JournalEntry> {
    const entry: JournalEntry = {
      id: randomUUID(), date: data.date || getUserToday(),
      mood: data.mood, content: data.content || "", tags: data.tags || [],
      energy: data.energy, gratitude: data.gratitude, highlights: data.highlights,
      createdAt: new Date().toISOString(),
    };
    this.journal.set(entry.id, entry);
    this.logActivity("journal", `Journal entry — mood: ${entry.mood}`);
    return entry;
  }
  async updateJournalEntry(id: string, data: Partial<JournalEntry>): Promise<JournalEntry | undefined> {
    const entry = this.journal.get(id);
    if (!entry) return undefined;
    const updated = { ...entry, ...data };
    this.journal.set(id, updated);
    this.logActivity("journal", `Updated journal entry — mood: ${updated.mood}`);
    return updated;
  }
  async deleteJournalEntry(id: string) { return this.journal.delete(id); }

  // ---- Memory ----
  async getMemories() { return Array.from(this.memories.values()); }
  async saveMemory(data: InsertMemory): Promise<MemoryItem> {
    // Check if key exists — update
    const existing = Array.from(this.memories.values()).find(m => m.key === data.key);
    if (existing) {
      existing.value = data.value;
      existing.category = data.category || existing.category;
      existing.updatedAt = new Date().toISOString();
      return existing;
    }
    const memory: MemoryItem = { id: randomUUID(), ...data, category: data.category || "general", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.memories.set(memory.id, memory);
    return memory;
  }
  async recallMemory(query: string): Promise<MemoryItem[]> {
    const q = query.toLowerCase();
    return Array.from(this.memories.values()).filter(m =>
      m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)
    );
  }
  async deleteMemory(id: string) { return this.memories.delete(id); }
  async updateMemory(id: string, data: Partial<MemoryItem>): Promise<MemoryItem | undefined> {
    const memory = this.memories.get(id);
    if (!memory) return undefined;
    const updated = { ...memory, ...data, updatedAt: new Date().toISOString() };
    this.memories.set(id, updated);
    return updated;
  }

  // ---- Goals ----
  async getGoals(): Promise<Goal[]> { return Array.from(this.goals.values()); }
  async getGoal(id: string): Promise<Goal | undefined> { return this.goals.get(id); }
  async createGoal(data: InsertGoal): Promise<Goal> {
    const now = new Date().toISOString();
    const goal: Goal = {
      id: randomUUID(), ...data, current: 0, status: "active",
      milestones: (data.milestones || []).map(m => ({ ...m, reached: false })),
      linkedProfiles: (data as any).linkedProfiles || [],
      createdAt: now, updatedAt: now,
    };
    this.goals.set(goal.id, goal);
    return goal;
  }
  async updateGoal(id: string, data: Partial<Goal>): Promise<Goal | undefined> {
    const goal = this.goals.get(id);
    if (!goal) return undefined;
    const updated = { ...goal, ...data, updatedAt: new Date().toISOString() };
    this.goals.set(id, updated);
    return updated;
  }
  async deleteGoal(id: string): Promise<boolean> { return this.goals.delete(id); }

  // ---- Domains ----
  async getDomains() { return Array.from(this.domains.values()); }
  async createDomain(data: InsertDomain): Promise<Domain> {
    const domain: Domain = { id: randomUUID(), ...data, slug: data.name.toLowerCase().replace(/\s+/g, "-"), fields: data.fields || [], createdAt: new Date().toISOString() };
    this.domains.set(domain.id, domain);
    this.logActivity("domain", `Created domain: ${domain.name}`);
    return domain;
  }
  async updateDomain(id: string, data: Partial<Domain>): Promise<Domain | undefined> {
    const domain = this.domains.get(id);
    if (!domain) return undefined;
    const updated = { ...domain, ...data };
    this.domains.set(id, updated);
    return updated;
  }
  async deleteDomain(id: string): Promise<boolean> {
    // Delete domain entries first
    for (const [entryId, entry] of this.domainEntries) {
      if (entry.domainId === id) this.domainEntries.delete(entryId);
    }
    return this.domains.delete(id);
  }
  async getDomainEntries(domainId: string): Promise<DomainEntry[]> {
    return Array.from(this.domainEntries.values()).filter(e => e.domainId === domainId);
  }
  async addDomainEntry(domainId: string, values: Record<string, any>, tags?: string[], notes?: string): Promise<DomainEntry | undefined> {
    const domain = this.domains.get(domainId);
    if (!domain) return undefined;
    const entry: DomainEntry = { id: randomUUID(), domainId, values, tags: tags || [], notes, createdAt: new Date().toISOString() };
    this.domainEntries.set(entry.id, entry);
    this.logActivity("domain", `Added entry to ${domain.name}`);
    return entry;
  }

  // ---- Dashboard ----
  async getStats(filterProfileId?: string, filterProfileIds?: string[]): Promise<DashboardStats> {
    // Build the active filter ID list. Single id collapses to [id]; empty/none = no filter.
    const ids: string[] = filterProfileIds && filterProfileIds.length > 0
      ? filterProfileIds
      : (filterProfileId ? [filterProfileId] : []);
    const filterActive = ids.length > 0;
    // Resolve self-profile membership: if any selected ID is a 'self' profile, items with
    // an empty linkedProfiles list (legacy/owner-only items) should match — they belong to self.
    const allProfilesArr = Array.from(this.profiles.values());
    const selfMatch = filterActive && ids.some(id => allProfilesArr.find(p => p.id === id)?.type === 'self');
    const matchesFilter = (linked: string[] | undefined | null): boolean => {
      if (!filterActive) return true;
      const arr = Array.isArray(linked) ? linked : [];
      if (arr.length === 0) return selfMatch;
      return arr.some(id => ids.includes(id));
    };
    const allTasks = Array.from(this.tasks.values());
    const allExpenses = Array.from(this.expenses.values());
    const allTrackers = Array.from(this.trackers.values());
    const allHabits = Array.from(this.habits.values());
    const allObligations = Array.from(this.obligations.values());
    const allJournal = Array.from(this.journal.values());
    const tasks = allTasks.filter(t => matchesFilter((t as any).linkedProfiles));
    const expenses = allExpenses.filter(e => matchesFilter((e as any).linkedProfiles));
    const trackers = allTrackers.filter(t => matchesFilter((t as any).linkedProfiles));
    const habits = allHabits.filter(h => matchesFilter((h as any).linkedProfiles));
    const obligations = allObligations.filter(o => matchesFilter((o as any).linkedProfiles));
    const journalEntries = allJournal.filter(j => matchesFilter((j as any).linkedProfiles));
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    const monthlyExpenses = expenses.filter(e => { const dd = new Date(e.date); return dd.getMonth() === thisMonth && dd.getFullYear() === thisYear; });
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    let weeklyEntries = 0;
    for (const t of trackers) { weeklyEntries += t.entries.filter(e => new Date(e.timestamp) > weekAgo).length; }

    const streaks: { name: string; days: number }[] = [];
    const todayStrStreaks = getUserToday();
    for (const t of trackers) {
      if (t.entries.length < 2) continue;
      let streak = 0;
      for (let i = 0; i < 30; i++) {
        const dayStr = tzAddDays(todayStrStreaks, -i);
        if (t.entries.some(e => e.timestamp.slice(0, 10) === dayStr)) streak++; else if (i > 0) break;
      }
      if (streak >= 2) streaks.push({ name: t.name, days: streak });
    }

    // Habit completion rate (last 7 days)
    const totalDailyHabits = habits.filter(h => h.frequency === "daily").length;
    let completedCheckins = 0;
    if (totalDailyHabits > 0) {
      for (let i = 0; i < 7; i++) {
        const dayStr = tzAddDays(todayStrStreaks, -i);
        for (const h of habits) {
          if (h.checkins.some(c => c.date === dayStr)) completedCheckins++;
        }
      }
    }
    const habitCompletionRate = totalDailyHabits > 0 ? Math.round((completedCheckins / (totalDailyHabits * 7)) * 100) : 0;

    // Upcoming obligations (within 7 days)
    const sevenDaysOut = new Date(now.getTime() + 7 * 86400000);
    const upcomingObs = obligations.filter(o => { const due = new Date(o.nextDueDate); return due >= now && due <= sevenDaysOut; });

    const monthlyObTotal = obligations.filter(o => o.frequency === "monthly" || o.frequency === "biweekly" || o.frequency === "weekly")
      .reduce((s, o) => s + o.amount, 0);

    // Journal streak
    let journalStreak = 0;
    for (let i = 0; i < 30; i++) {
      const dayStr = tzAddDays(todayStrStreaks, -i);
      if (journalEntries.some(j => j.date === dayStr)) journalStreak++; else if (i > 0) break;
    }

    const recentJournal = journalEntries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const currentMood = recentJournal.length > 0 ? recentJournal[0].mood as MoodLevel : undefined;

    return {
      totalProfiles: filterActive ? ids.length : this.profiles.size,
      totalTrackers: trackers.length,
      totalTasks: tasks.length,
      activeTasks: tasks.filter(t => (t.status || "").trim().toLowerCase() !== "done").length,
      totalExpenses: expenses.reduce((sum, e) => sum + e.amount, 0),
      totalEvents: filterActive
        ? Array.from(this.events.values()).filter(e => matchesFilter((e as any).linkedProfiles)).length
        : this.events.size,
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
            if (nums.length === 1) return `${t.name}: ${nums[0][1]} ${nums[0][0]}`;
            const summary = nums.slice(0, 2).map(([k, v]) => `${v} ${k}`).join(', ');
            return `${t.name}: ${summary}${nums.length > 2 ? ` (+${nums.length - 2} more)` : ''}`;
          })(),
          timestamp: e.timestamp,
        }))),
        // Newest completions first, stamped with COMPLETION time (updatedAt) —
        // mirrors the SupabaseStorage fix so dev-mode matches production.
        ...tasks.filter(t => t.status === 'done')
          .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime())
          .slice(0, 3).map(t => ({
            type: 'task_completed',
            description: `Completed: ${t.title}`,
            timestamp: t.updatedAt || t.createdAt,
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
      monthlyObligationTotal: monthlyObTotal,
      journalStreak,
      currentMood,
      totalArtifacts: this.artifacts.size,
      totalMemories: this.memories.size,
    };
  }

  // ---- Enhanced Dashboard Data ----
  async getDashboardEnhanced(filterProfileId?: string, filterProfileIds?: string[]): Promise<any> {
    const now = new Date();
    const today = getUserToday();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    // Build active filter, supporting multi-profile selection (was previously ignored).
    const ids: string[] = filterProfileIds && filterProfileIds.length > 0
      ? filterProfileIds
      : (filterProfileId ? [filterProfileId] : []);
    const filterActive = ids.length > 0;
    const allProfilesArr = Array.from(this.profiles.values());
    const selfMatch = filterActive && ids.some(id => allProfilesArr.find(p => p.id === id)?.type === 'self');
    const matchesFilter = (linked: string[] | undefined | null): boolean => {
      if (!filterActive) return true;
      const arr = Array.isArray(linked) ? linked : [];
      if (arr.length === 0) return selfMatch;
      return arr.some(id => ids.includes(id));
    };

    // Document expiration alerts — scan extractedData for date fields
    const documents = Array.from(this.documents.values()).filter(d => matchesFilter((d as any).linkedProfiles));
    const expiringDocs: any[] = [];
    for (const doc of documents) {
      const ed = doc.extractedData || {};
      // Look for common expiration-related fields
      const dateFields = ['expiration_date', 'expirationDate', 'expiry', 'expires', 'exp_date',
        'expiration', 'valid_until', 'validUntil', 'end_date', 'endDate', 'renewal_date', 'renewalDate'];
      for (const key of Object.keys(ed)) {
        const lk = key.toLowerCase().replace(/[\s_-]+/g, '');
        const isDateField = dateFields.some(df => lk.includes(df.toLowerCase().replace(/[\s_-]+/g, '')));
        if (!isDateField) continue;
        const val = ed[key];
        if (!val || typeof val !== 'string') continue;
        const parsed = new Date(val);
        if (isNaN(parsed.getTime())) continue;
        const daysUntil = Math.ceil((parsed.getTime() - now.getTime()) / 86400000);
        expiringDocs.push({
          documentId: doc.id,
          documentName: doc.name,
          documentType: doc.type,
          fieldName: key,
          expirationDate: val,
          daysUntil,
          status: daysUntil < 0 ? 'expired' : daysUntil <= 30 ? 'expiring_soon' : daysUntil <= 90 ? 'upcoming' : 'ok',
        });
      }
    }
    // Sort by urgency
    expiringDocs.sort((a, b) => a.daysUntil - b.daysUntil);

    // Health snapshot — aggregate recent tracker data from health-related trackers
    const trackers = Array.from(this.trackers.values()).filter(t => matchesFilter((t as any).linkedProfiles));
    const healthCategories = ['health', 'fitness', 'weight', 'sleep', 'blood_pressure', 'running', 'exercise', 'nutrition', 'wellness'];
    const healthTrackers = trackers.filter(t => healthCategories.some(c => t.category.toLowerCase().includes(c) || t.name.toLowerCase().includes(c)));
    const healthSnapshot: any[] = [];
    for (const t of healthTrackers) {
      const recent = t.entries.slice(-7); // last 7 entries
      const primaryField = t.fields.find(f => f.isPrimary) || t.fields[0];
      if (!primaryField || recent.length === 0) continue;
      const values = recent.map(e => Number(e.values[primaryField.name])).filter(v => !isNaN(v));
      if (values.length === 0) continue;
      const latest = values[values.length - 1];
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const trend = values.length >= 2 ? (values[values.length - 1] - values[0]) : 0;
      healthSnapshot.push({
        trackerId: t.id,
        name: t.name,
        category: t.category,
        unit: primaryField.unit || t.unit || '',
        latestValue: latest,
        average: Math.round(avg * 10) / 10,
        trend: trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat',
        trendValue: Math.round(Math.abs(trend) * 10) / 10,
        entryCount: recent.length,
        lastEntry: recent[recent.length - 1]?.timestamp,
      });
    }

    // Finance snapshot — spending by category this month + upcoming bills
    const expenses = Array.from(this.expenses.values()).filter(e => matchesFilter((e as any).linkedProfiles));
    const monthlyExpenses = expenses.filter(e => {
      const d = new Date(e.date);
      return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    });
    const spendByCategory: Record<string, number> = {};
    for (const e of monthlyExpenses) {
      spendByCategory[e.category] = (spendByCategory[e.category] || 0) + e.amount;
    }
    const totalMonthlySpend = monthlyExpenses.reduce((s, e) => s + e.amount, 0);

    // Last month comparison
    const lastMonthDate = new Date(thisYear, thisMonth - 1, 1);
    const lastMonthExpenses = expenses.filter(e => {
      const d = new Date(e.date);
      return d.getMonth() === lastMonthDate.getMonth() && d.getFullYear() === lastMonthDate.getFullYear();
    });
    const lastMonthTotal = lastMonthExpenses.reduce((s, e) => s + e.amount, 0);

    const obligations = Array.from(this.obligations.values()).filter(o => matchesFilter((o as any).linkedProfiles));
    const upcomingBills = obligations
      .filter(o => {
        const due = new Date(o.nextDueDate);
        const daysUntil = Math.ceil((due.getTime() - now.getTime()) / 86400000);
        return daysUntil <= 30;
      })
      .sort((a, b) => new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime())
      .map(o => ({
        id: o.id,
        name: o.name,
        amount: o.amount,
        dueDate: o.nextDueDate,
        daysUntil: Math.ceil((new Date(o.nextDueDate).getTime() - now.getTime()) / 86400000),
        autopay: o.autopay,
        category: o.category,
      }));

    const monthlyObligationTotal = obligations.reduce((s, o) => {
      switch (o.frequency) {
        case 'weekly': return s + o.amount * 4.33;
        case 'biweekly': return s + o.amount * 2.17;
        case 'monthly': return s + o.amount;
        case 'quarterly': return s + o.amount / 3;
        case 'yearly': return s + o.amount / 12;
        default: return s;
      }
    }, 0);

    // Overdue tasks
    const tasks = Array.from(this.tasks.values()).filter(t => matchesFilter((t as any).linkedProfiles));
    const overdueTasks = tasks.filter(t => {
      if (t.status === 'done' || !t.dueDate) return false;
      return new Date(t.dueDate) < now;
    }).map(t => ({ id: t.id, title: t.title, dueDate: t.dueDate!, priority: t.priority }));

    // Tasks due today
    const tasksDueToday = tasks.filter(t => {
      if (t.status === 'done' || !t.dueDate) return false;
      return t.dueDate.slice(0, 10) === today;
    }).map(t => ({ id: t.id, title: t.title, dueDate: t.dueDate!, priority: t.priority }));

    // Today's events
    const events = Array.from(this.events.values()).filter(e => matchesFilter((e as any).linkedProfiles));
    const todaysEvents = events.filter(e => e.date === today)
      .map(e => ({ id: e.id, title: e.title, time: e.time, endTime: e.endTime, category: e.category, location: e.location }));

    return {
      expiringDocuments: expiringDocs.filter(d => d.status !== 'ok'),
      healthSnapshot,
      financeSnapshot: {
        totalMonthlySpend,
        lastMonthTotal,
        spendTrend: lastMonthTotal > 0 ? Math.round(((totalMonthlySpend - lastMonthTotal) / lastMonthTotal) * 100) : 0,
        spendByCategory,
        upcomingBills,
        monthlyObligationTotal: Math.round(monthlyObligationTotal),
      },
      overdueTasks,
      tasksDueToday,
      todaysEvents,
      totalDocuments: documents.length,
    };
  }

  // ---- Net-worth snapshots (W4-5) ----
  // In-memory backend is dev-only and has no snapshot store; the real
  // persistence lives in SupabaseStorage. Stubs keep IStorage satisfied.
  async takeNetWorthSnapshot(_profileIds?: string[]): Promise<Array<{ profileId: string | null; assetsTotal: number; liabilitiesTotal: number; netWorth: number; snapshotDate: string }>> {
    return [];
  }
  async getNetWorthHistory(_profileId?: string, _lookbackDays?: number): Promise<Array<{ snapshotDate: string; assetsTotal: number; liabilitiesTotal: number; netWorth: number }>> {
    return [];
  }

  // ---- Insights ----
  async getInsights(): Promise<Insight[]> {
    return generateInsights(
      Array.from(this.profiles.values()),
      Array.from(this.trackers.values()),
      Array.from(this.tasks.values()),
      Array.from(this.expenses.values()),
      Array.from(this.habits.values()),
      Array.from(this.obligations.values()),
      Array.from(this.journal.values()),
    );
  }

  // ---- Entity Links ----
  async getEntityLinks(entityType: string, entityId: string): Promise<EntityLink[]> {
    return Array.from(this.entityLinks.values()).filter(
      l => (l.sourceType === entityType && l.sourceId === entityId) ||
           (l.targetType === entityType && l.targetId === entityId)
    );
  }

  async createEntityLink(data: InsertEntityLink): Promise<EntityLink> {
    // Check for duplicate
    const existing = Array.from(this.entityLinks.values()).find(
      l => l.sourceType === data.sourceType && l.sourceId === data.sourceId &&
           l.targetType === data.targetType && l.targetId === data.targetId
    );
    if (existing) return existing;
    const link: EntityLink = {
      id: randomUUID(),
      sourceType: data.sourceType,
      sourceId: data.sourceId,
      targetType: data.targetType,
      targetId: data.targetId,
      relationship: data.relationship,
      confidence: data.confidence ?? 1,
      createdAt: new Date().toISOString(),
    };
    this.entityLinks.set(link.id, link);
    return link;
  }

  async deleteEntityLink(id: string): Promise<boolean> {
    return this.entityLinks.delete(id);
  }

  async getRelatedEntities(entityType: string, entityId: string): Promise<any[]> {
    const links = await this.getEntityLinks(entityType, entityId);
    const related: any[] = [];
    for (const link of links) {
      const otherType = (link.sourceType === entityType && link.sourceId === entityId) ? link.targetType : link.sourceType;
      const otherId = (link.sourceType === entityType && link.sourceId === entityId) ? link.targetId : link.sourceId;
      let entity: any = null;
      switch (otherType) {
        case "profile": entity = this.profiles.get(otherId); break;
        case "tracker": entity = this.trackers.get(otherId); break;
        case "task": entity = this.tasks.get(otherId); break;
        case "expense": entity = this.expenses.get(otherId); break;
        case "event": entity = this.events.get(otherId); break;
        case "habit": entity = this.habits.get(otherId); break;
        case "obligation": entity = this.obligations.get(otherId); break;
        case "document": {
          const doc = this.documents.get(otherId);
          if (doc) { const { fileData, ...rest } = doc; entity = rest; }
          break;
        }
      }
      if (entity) {
        related.push({ ...entity, _type: otherType, _linkId: link.id, _relationship: link.relationship, _confidence: link.confidence });
      }
    }
    return related;
  }

  // ---- Search ----
  async search(query: string): Promise<any[]> {
    const q = query.toLowerCase();
    const results: any[] = [];
    for (const p of this.profiles.values()) {
      if (p.name.toLowerCase().includes(q) || p.type.includes(q) || p.tags.some(t => t.includes(q))) results.push({ ...p, _type: "profile" });
    }
    for (const t of this.trackers.values()) {
      if (t.name.toLowerCase().includes(q) || t.category.includes(q)) results.push({ ...t, _type: "tracker" });
    }
    for (const t of this.tasks.values()) {
      if (t.title.toLowerCase().includes(q) || t.tags.some(tag => tag.includes(q))) results.push({ ...t, _type: "task" });
    }
    for (const e of this.expenses.values()) {
      if (e.description.toLowerCase().includes(q) || e.category.includes(q) || (e.vendor && e.vendor.toLowerCase().includes(q))) results.push({ ...e, _type: "expense" });
    }
    for (const h of this.habits.values()) {
      if (h.name.toLowerCase().includes(q)) results.push({ ...h, _type: "habit" });
    }
    for (const o of this.obligations.values()) {
      if (o.name.toLowerCase().includes(q) || o.category.includes(q)) results.push({ ...o, _type: "obligation" });
    }
    for (const a of this.artifacts.values()) {
      if (a.title.toLowerCase().includes(q) || a.content.toLowerCase().includes(q) || a.tags.some(t => t.includes(q))) results.push({ ...a, _type: "artifact" });
    }
    for (const j of this.journal.values()) {
      if (j.content.toLowerCase().includes(q) || j.tags.some(t => t.includes(q))) results.push({ ...j, _type: "journal" });
    }
    for (const m of this.memories.values()) {
      if (m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q)) results.push({ ...m, _type: "memory" });
    }
    return results;
  }

  // ---- Preferences ----
  private preferences: Map<string, string> = new Map();

  async getPreference(key: string): Promise<string | null> {
    return this.preferences.get(key) ?? null;
  }

  async setPreference(key: string, value: string): Promise<void> {
    this.preferences.set(key, value);
  }

  // Income stubs (in-memory)
  private incomes = new Map<string, Income>();
  async getIncomes(): Promise<Income[]> { return Array.from(this.incomes.values()); }
  async createIncome(data: InsertIncome): Promise<Income> {
    const income: Income = { ...data, id: randomUUID(), createdAt: new Date().toISOString() } as Income;
    this.incomes.set(income.id, income);
    return income;
  }
  async updateIncome(id: string, data: Partial<Income>): Promise<Income | undefined> {
    const existing = this.incomes.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...data };
    this.incomes.set(id, updated);
    return updated;
  }
  async deleteIncome(id: string): Promise<boolean> { return this.incomes.delete(id); }

  // Soft-delete restore stubs
  async restoreTask(_id: string): Promise<boolean> { return false; }
  async restoreHabit(_id: string): Promise<boolean> { return false; }
  async getDeletedTasks(_limit?: number): Promise<Task[]> { return []; }
  async getDeletedHabits(_limit?: number): Promise<Habit[]> { return []; }
  async restoreEntity(_entityType: string, _id: string): Promise<boolean> { return false; }

  // AI action ledger stubs (in-memory, bounded)
  private aiActionLogStore: import("@shared/schema").AiActionLog[] = [];
  async createAiActionLog(entry: import("@shared/schema").InsertAiActionLog): Promise<import("@shared/schema").AiActionLog | undefined> {
    const row: import("@shared/schema").AiActionLog = {
      id: crypto.randomUUID(), tool: entry.tool, actionType: entry.actionType,
      entityType: entry.entityType ?? null, entityId: entry.entityId ?? null, entityName: entry.entityName ?? null,
      input: entry.input ?? null, before: entry.before ?? null, after: entry.after ?? null,
      reversible: entry.reversible ?? false, reversePlan: entry.reversePlan ?? null,
      source: entry.source || "chat", createdAt: new Date().toISOString(),
      undoneAt: null, undoneByLogId: null,
    };
    this.aiActionLogStore.unshift(row);
    if (this.aiActionLogStore.length > 200) this.aiActionLogStore.pop();
    return row;
  }
  async listAiActionLog(opts: { limit?: number; entityType?: string; entityId?: string; includeUndone?: boolean } = {}): Promise<import("@shared/schema").AiActionLog[]> {
    return this.aiActionLogStore
      .filter(r => (!opts.entityType || r.entityType === opts.entityType)
        && (!opts.entityId || r.entityId === opts.entityId)
        && (opts.includeUndone || !r.undoneAt))
      .slice(0, Math.min(opts.limit || 20, 100));
  }
  async markActionUndone(id: string, undoneByLogId?: string): Promise<void> {
    const r = this.aiActionLogStore.find(x => x.id === id);
    if (r) { r.undoneAt = new Date().toISOString(); r.undoneByLogId = undoneByLogId ?? null; }
  }
  // AI bulk plan stubs (in-memory, bounded)
  private aiBulkPlanStore = new Map<string, { id: string; operation: string; criteria: any; planHash: string; preview: any; status: string; affected?: any; expiresAt: string; executedAt?: string }>();
  async createAiBulkPlan(plan: { operation: string; criteria: any; planHash: string; preview: any; expiresAt: string }) {
    const row = { id: crypto.randomUUID(), status: "pending", ...plan };
    this.aiBulkPlanStore.set(row.id, row);
    if (this.aiBulkPlanStore.size > 50) {
      const oldest = this.aiBulkPlanStore.keys().next().value;
      if (oldest) this.aiBulkPlanStore.delete(oldest);
    }
    return row;
  }
  async getAiBulkPlan(planId: string) { return this.aiBulkPlanStore.get(planId); }
  async getLatestPendingAiBulkPlan() {
    return [...this.aiBulkPlanStore.values()].reverse().find(p => p.status === "pending");
  }
  async setAiBulkPlanStatus(planId: string, status: string, patch?: { affected?: any; executedAt?: string }): Promise<void> {
    const row = this.aiBulkPlanStore.get(planId);
    if (row) Object.assign(row, { status }, patch?.affected !== undefined ? { affected: patch.affected } : {}, patch?.executedAt ? { executedAt: patch.executedAt } : {});
  }

  // User notification stubs (in-memory, bounded)
  private userNotificationStore: Array<{ id: string; title: string; message: string; severity: string; entityType?: string | null; entityId?: string | null; createdAt: string; readAt?: string | null; dismissedAt?: string | null }> = [];
  async createUserNotification(n: { title: string; message?: string; severity?: string; entityType?: string; entityId?: string }) {
    const row = {
      id: crypto.randomUUID(), title: n.title, message: n.message || "",
      severity: ["critical", "warning", "info"].includes(String(n.severity)) ? String(n.severity) : "info",
      entityType: n.entityType ?? null, entityId: n.entityId ?? null,
      createdAt: new Date().toISOString(), readAt: null as string | null, dismissedAt: null as string | null,
    };
    this.userNotificationStore.unshift(row);
    if (this.userNotificationStore.length > 200) this.userNotificationStore.pop();
    return row;
  }
  async listUserNotifications(opts: { includeDismissed?: boolean; limit?: number } = {}) {
    return this.userNotificationStore
      .filter(r => opts.includeDismissed || !r.dismissedAt)
      .slice(0, Math.min(opts.limit || 50, 200));
  }
  async markUserNotifications(field: "read" | "dismissed", ids?: string[]): Promise<number> {
    const col = field === "read" ? "readAt" : "dismissedAt";
    let n = 0;
    for (const r of this.userNotificationStore) {
      if ((r as any)[col]) continue;
      if (ids && ids.length > 0 && !ids.includes(r.id)) continue;
      (r as any)[col] = new Date().toISOString();
      n++;
    }
    return n;
  }
  async deleteHabitCheckin(_habitId: string, _checkinId: string): Promise<boolean> { return false; }
  async migrateDocumentsToStorage(): Promise<{ migrated: number; errors: string[] }> { return { migrated: 0, errors: ["Not supported in MemStorage"] }; }

  // Budget stubs
  private budgetStore = new Map<string, Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>>();
  async getBudgets(month: string, profileIds?: string[]) {
    const all = this.budgetStore.get(month) || [];
    if (!profileIds) return all;
    const wanted = new Set(profileIds);
    return all.filter(b => !b.profileId || wanted.has(b.profileId));
  }
  async setBudgets(month: string, budgets: Array<{id: string; category: string; amount: number; notes?: string; profileId?: string}>) { this.budgetStore.set(month, budgets); }
  async addBudget(month: string, category: string, amount: number, notes?: string, profileId?: string) {
    const list = this.budgetStore.get(month) || [];
    const existing = list.find(b => b.category.toLowerCase() === category.toLowerCase() && (b.profileId || null) === (profileId || null));
    if (existing) {
      existing.amount = amount;
      if (notes) existing.notes = notes;
      this.budgetStore.set(month, list);
      return existing;
    }
    const budget = { id: crypto.randomUUID(), category, amount, notes, profileId };
    list.push(budget);
    this.budgetStore.set(month, list);
    return budget;
  }
  async updateBudget(month: string, budgetId: string, updates: {amount?: number; category?: string; notes?: string; profileId?: string}) {
    const list = this.budgetStore.get(month) || [];
    const idx = list.findIndex(b => b.id === budgetId);
    if (idx === -1) return false;
    Object.assign(list[idx], updates);
    return true;
  }
  async deleteBudget(month: string, budgetId: string) {
    const list = this.budgetStore.get(month) || [];
    const idx = list.findIndex(b => b.id === budgetId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    this.budgetStore.set(month, list);
    return true;
  }
  async copyBudgetsToMonth(fromMonth: string, toMonth: string) {
    const source = this.budgetStore.get(fromMonth) || [];
    const copied = source.map(b => ({ ...b, id: crypto.randomUUID() }));
    this.budgetStore.set(toMonth, copied);
    return copied.length;
  }

  // Finance imports (in-memory; MemStorage is dev-only).
  private financeImports = new Map<string, any>();
  async createFinanceImport(rec: any) {
    const row = { ...rec, createdAt: new Date().toISOString(), undoneAt: null };
    this.financeImports.set(rec.id, row);
    return row;
  }
  async listFinanceImports(limit = 50) {
    return Array.from(this.financeImports.values())
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
      .slice(0, limit);
  }
  async getFinanceImport(id: string) { return this.financeImports.get(id) || null; }
  async setFinanceImportStatus(id: string, status: "committed" | "undone") {
    const row = this.financeImports.get(id);
    if (row) { row.status = status; if (status === "undone") row.undoneAt = new Date().toISOString(); }
  }

  // Reminder stubs
  private reminderStore: Reminder[] = [];
  async createReminder(data: { title: string; fireAt: string; profileId?: string }): Promise<Reminder> {
    const reminder: Reminder = {
      id: crypto.randomUUID(),
      title: data.title,
      fireAt: data.fireAt,
      firedAt: null,
      profileId: data.profileId ?? null,
      channel: "in_app",
      createdAt: new Date().toISOString(),
    };
    this.reminderStore.push(reminder);
    return reminder;
  }
  async listReminders(filter?: { dueBefore?: Date }): Promise<Reminder[]> {
    return this.reminderStore.filter(r => {
      if (r.firedAt) return false;
      if (filter?.dueBefore && new Date(r.fireAt) > filter.dueBefore) return false;
      return true;
    });
  }
  async markReminderFired(id: string): Promise<boolean> {
    const r = this.reminderStore.find(x => x.id === id);
    if (!r) return false;
    r.firedAt = new Date().toISOString();
    return true;
  }
  async updateReminder(id: string, data: { title?: string; fireAt?: string; profileId?: string | null }): Promise<Reminder | undefined> {
    const r = this.reminderStore.find(x => x.id === id);
    if (!r) return undefined;
    if (data.title !== undefined) r.title = data.title;
    if (data.fireAt !== undefined) r.fireAt = data.fireAt;
    if (data.profileId !== undefined) (r as any).profileId = data.profileId;
    return r;
  }
  async deleteReminder(id: string): Promise<boolean> {
    const idx = this.reminderStore.findIndex(x => x.id === id);
    if (idx === -1) return false;
    this.reminderStore.splice(idx, 1);
    return true;
  }

  // Paycheck stubs
  async getPaychecks() { return []; }
  async createPaycheck(p: any) { return { id: crypto.randomUUID(), ...p }; }
  async confirmPaycheck(id: string, _actual_amount?: number) { return { id, confirmed: true }; }
  async deletePaycheck(_id: string) {}

  // Loan stubs
  async getLoanSchedule(_loanId: string) { return []; }
  async getAllLoanSchedules() { return []; }
  async createLoanSchedule(entries: any[]) { return entries; }
  async markLoanPayment(id: string) { return { id, paid: true }; }

  // Cashflow stubs
  async getCashflow(_month?: string) { return []; }
  async upsertCashflow(entry: any) { return entry; }

  // Bulk delete all user data (in-memory)
  async deleteAllUserData(): Promise<{ deleted: Record<string, number> }> {
    const deleted: Record<string, number> = {};
    deleted.expenses = this.expenses.size; this.expenses.clear();
    deleted.tasks = this.tasks.size; this.tasks.clear();
    deleted.habits = this.habits.size; this.habits.clear();
    deleted.trackers = this.trackers.size; this.trackers.clear();
    deleted.obligations = this.obligations.size; this.obligations.clear();
    deleted.events = this.events.size; this.events.clear();
    deleted.documents = this.documents.size; this.documents.clear();
    deleted.journal = this.journal.size; this.journal.clear();
    deleted.goals = this.goals.size; this.goals.clear();
    deleted.artifacts = this.artifacts.size; this.artifacts.clear();
    deleted.memories = this.memories.size; this.memories.clear();
    deleted.incomes = this.incomes.size; this.incomes.clear();
    deleted.domains = this.domains.size; this.domains.clear();
    deleted.domainEntries = this.domainEntries.size; this.domainEntries.clear();
    deleted.entityLinks = this.entityLinks.size; this.entityLinks.clear();
    this.preferences.clear();
    return { deleted };
  }

  // Liabilities — stubs (MemStorage is dev-only; no persistence needed).
  async getLiabilityAssetLinks(_id?: string) { return []; }
  async getLiabilityAssetLinksForAsset(_id: string) { return []; }
  async createLiabilityAssetLink(_data: any): Promise<any> { throw new Error("MemStorage: liability links not implemented"); }
  async updateLiabilityAssetLink(_id: string, _patch: any): Promise<any> { return undefined; }
  async deleteLiabilityAssetLink(_id: string) { return false; }
  async getLiabilityProfileLinks(_id?: string) { return []; }
  async getLiabilityProfileLinksForParty(_id: string) { return []; }
  async createLiabilityProfileLink(_data: any): Promise<any> { throw new Error("MemStorage: liability links not implemented"); }
  async updateLiabilityProfileLink(_id: string, _patch: any): Promise<any> { return undefined; }
  async deleteLiabilityProfileLink(_id: string) { return false; }
  async ensureLiabilityOwnerLink(_id: string) { /* MemStorage: no-op */ }
  async getAssetPartyLinks(_id?: string) { return []; }
  async getAssetPartyLinksForParty(_id: string) { return []; }
  async getProfileAssetValue(_profileId: string) { return { assetValue: 0, liabilityValue: 0, netValue: 0, assets: [], liabilities: [] }; }
  async createAssetPartyLink(_data: any): Promise<any> { throw new Error("MemStorage: asset party links not implemented"); }
  async updateAssetPartyLink(_id: string, _patch: any) { return undefined; }
  async deleteAssetPartyLink(_id: string) { return false; }
  async setAssetOwners(_assetProfileId: string, _owners: any[]): Promise<any[]> { return []; }
  async setLiabilityOwners(_liabilityProfileId: string, _owners: any[]): Promise<any[]> { return []; }
  async getOwnershipHistory(_opts?: any) { return []; }
  async recordOwnershipHistory(_entry: any): Promise<any> { return { id: "mem", changedAt: new Date().toISOString(), ..._entry }; }
  async deleteOwnershipHistoryEntry(_id: string) { return false; }
  async getLiabilityPayments(_id: string) { return []; }
  async createLiabilityPayment(_data: any): Promise<any> { throw new Error("MemStorage: liability payments not implemented"); }
  async updateLiabilityPayment(_id: string, _data: any): Promise<any> { return undefined; }
  async deleteLiabilityPayment(_id: string) { return false; }

  // Universal Captures (PR Y) ---------------------------------------------
  private captures: Map<string, import("@shared/schema").Capture> = new Map();
  async getCaptures(opts?: { status?: string; ownerProfileId?: string; limit?: number }) {
    let list = Array.from(this.captures.values());
    if (opts?.status) list = list.filter(c => c.status === opts.status);
    if (opts?.ownerProfileId) list = list.filter(c => c.ownerProfileId === opts.ownerProfileId);
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    if (opts?.limit) list = list.slice(0, opts.limit);
    return list;
  }
  async getCapture(id: string) { return this.captures.get(id); }
  async createCapture(data: import("@shared/schema").InsertCapture): Promise<import("@shared/schema").Capture> {
    const now = new Date().toISOString();
    const capture: import("@shared/schema").Capture = {
      id: randomUUID(),
      type: (data.type as any) || "unknown",
      ownerProfileId: data.ownerProfileId ?? null,
      title: data.title || "",
      rawInput: data.rawInput,
      structuredData: data.structuredData || {},
      metadata: data.metadata || {},
      relationships: data.relationships || [],
      source: data.source || "chat",
      confidence: data.confidence ?? 0.5,
      status: (data.status as any) || "pending",
      projections: data.projections || [],
      clarifyingQuestion: data.clarifyingQuestion ?? null,
      createdAt: now, updatedAt: now,
    };
    this.captures.set(capture.id, capture);
    return capture;
  }
  async updateCapture(id: string, patch: Partial<import("@shared/schema").Capture>) {
    const existing = this.captures.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    this.captures.set(id, updated);
    return updated;
  }
  async deleteCapture(id: string) { return this.captures.delete(id); }
}

// Storage factory — uses Supabase if env vars are set, otherwise falls back to SQLite
// IMPORTANT: Lazy initialization — dotenv.config() must run before first access.
// SupabaseStorage is the only backend. SQLite was removed to eliminate
// the maintenance burden of two diverging implementations.
import { SupabaseStorage, capProfileDetailLists } from './supabase-storage';

let _storageInstance: IStorage | null = null;

function getStorage(): IStorage {
  if (!_storageInstance) {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required. SQLite backend has been removed.");
    }
    logger.info("storage", "Using Supabase PostgreSQL storage");
    _storageInstance = new SupabaseStorage(supabaseUrl, supabaseKey, 'anonymous');
  }
  return _storageInstance!;
}

// Proxy that returns the per-request storage instance if available,
// otherwise falls back to the global singleton (for auth routes, startup, etc.)
export const storage: IStorage = new Proxy({} as IStorage, {
  get(_target, prop, _receiver) {
    // Prefer per-request scoped instance from AsyncLocalStorage
    const requestScoped = requestStorageContext.getStore();
    const instance = requestScoped || getStorage();
    const value = (instance as any)[prop];
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  },
  set(_target, prop, value) {
    const requestScoped = requestStorageContext.getStore();
    const instance = requestScoped || getStorage();
    (instance as any)[prop] = value;
    return true;
  },
});

/**
 * Create a new storage instance scoped to a specific userId.
 * Used by auth middleware to eliminate the global userId race condition.
 */
export function createScopedStorage(userId: string): IStorage {
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseKey) {
    return new SupabaseStorage(supabaseUrl, supabaseKey, userId);
  }
  throw new Error("Supabase env vars required for scoped storage");
}

export function isSupabaseStorage(): boolean {
  return !!(process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
