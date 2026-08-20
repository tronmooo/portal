import { z } from "zod";
import {
  type TrackerMetricDefinition,
  trackerMetricDefinitionSchema,
} from "./tracker-metric-definition";
export type { TrackerMetricDefinition } from "./tracker-metric-definition";

// ============================================================
// SHARED CONSTANTS
// ============================================================

/** Unified mood scores used across storage backends. Scale: 1-8. */
export const MOOD_SCORES: Record<string, number> = {
  amazing: 8, great: 7, good: 6, okay: 5, neutral: 4, bad: 3, awful: 2, terrible: 1,
};

// ============================================================
// STRUCTURED AI ACTIONS — The universal action system
// ============================================================

export type AIActionType =
  | "CREATE_DOMAIN"
  | "ADD_ENTRY"
  | "CREATE_PROFILE"
  | "UPDATE_PROFILE"
  | "CREATE_TRACKER"
  | "LOG_ENTRY"
  | "CREATE_TASK"
  | "UPDATE_TASK"
  | "LOG_EXPENSE"
  | "CREATE_EVENT"
  | "CREATE_ARTIFACT"
  | "CHECKIN_HABIT"
  | "CREATE_HABIT"
  | "CREATE_OBLIGATION"
  | "PAY_OBLIGATION"
  | "JOURNAL_ENTRY"
  | "QUERY_DATA"
  | "GENERATE_REPORT"
  | "SAVE_MEMORY"
  | "RECALL_MEMORY"
  | "NAVIGATE"
  | "SHOW_TOAST"
  | "RESPOND"
  | "CLARIFY"
  | "ERROR";

export interface AIAction {
  type: AIActionType;
  category?: string;
  data: Record<string, any>;
  confirmed?: boolean;
}

// Legacy compat
export interface ParsedAction {
  type:
    // Creates / logs (undoable in the chat UI)
    | "create_profile" | "create_tracker" | "log_entry" | "create_task" | "log_expense"
    | "create_event" | "create_goal" | "create_habit" | "create_obligation"
    | "journal_entry" | "create_artifact" | "save_memory" | "create_liability"
    | "add_liability_payment" | "log_income" | "log_paycheck"
    // State changes
    | "complete_task" | "delete_task" | "complete_event" | "checkin_habit" | "uncomplete_habit"
    | "delete_habit" | "pay_obligation" | "update_profile" | "delete_tracker_entry"
    | "update_tracker_entry" | "recall_memory"
    // Generic write buckets (2026-07: cover the ~40 tools that used to fall
    // through to "retrieve" so every write surfaces as a typed action)
    | "update_entity" | "delete_entity" | "link_entities" | "set_budget"
    | "revalue_asset" | "manage_domain" | "manage_document"
    // Reads
    | "retrieve" | "unknown";
  category: string;
  data: Record<string, any>;
  confirmed?: boolean;
}

// ============================================================
// CHAT
// ============================================================

/**
 * One database change made by a chat turn, described so the client can show it
 * WITHOUT waiting for a refetch.
 *
 * Before this existed the AI reply said "Added it" and the client's only
 * response was to invalidate every /api/* query and wait — so navigating to the
 * page that lists the new row raced the refetch and, more often than not, the
 * row wasn't there until a manual refresh. The manifest closes that gap: the
 * row it carries is written straight into the matching cached lists, and the
 * domains it names drive the background reconcile.
 *
 * `entityType: null` with `domains: ["everything"]` is the deliberate fallback
 * for a write whose shape we can't name (bulk plans, link/unlink, undo) — the
 * client degrades to the old blanket invalidation rather than missing the write.
 */
export interface ChatMutation {
  op: "create" | "update" | "delete";
  /** Entity vocabulary from shared/entity-domains.ts; null when unmapped. */
  entityType: string | null;
  /** Cache domains this write ripples into (shared/entity-domains.ts Domain). */
  domains: string[];
  /** Primary key of the affected row, when the tool reported one. */
  id?: string;
  /** List endpoint whose cached rows can be patched in place; null if none. */
  endpoint?: string | null;
  /** The row as written, for create/update. Omitted for deletes (id suffices). */
  row?: Record<string, any>;
  /** Tool that produced this change — diagnostics only. */
  tool?: string;
}


export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  actions?: ParsedAction[];
  /** Per-operation outcome report for multi-action messages — one row per
   * requested write (success AND failure), so the UI can show exactly which
   * actions landed. Mirrors OperationOutcome in server/ai-bulk-log.ts. */
  operations?: Array<{
    index: number;
    raw: string;
    tool: string;
    status: "ok" | "failed" | "skipped" | "deduped";
    error?: string;
    entityId?: string;
    trackerName?: string;
    createdTracker?: { id: string; name: string };
    detail?: string;
    turnId?: string;
    sourceMessageId?: string;
  }>;
  /** Turn identity — set by the server on every assistant reply. Action cards
   *  and operation rows render only under the message whose turnId they carry,
   *  so historical actions never re-attach to a newer response. */
  turnId?: string;
  sourceMessageId?: string;
  attachment?: {
    name: string;
    mimeType: string;
    data: string; // base64
    previewUrl?: string;
  };
  documentPreview?: {
    id: string;
    name: string;
    mimeType: string;
    data: string; // base64 for inline display
    extractedData?: Record<string, any>;
    type?: string;
  };
  documentPreviews?: Array<{
    id: string;
    name: string;
    mimeType: string;
    data: string;
    extractedData?: Record<string, any>;
    type?: string;
  }>;
  /** Inline Smart Fill suggestion chip — click to open SmartFillDialog with this file. */
  smartFillSuggestion?: {
    fileName: string;
    mimeType: string;
    base64: string;
    label?: string;
  };
  pendingExtraction?: {
    extractionId: string;
    fileName: string;
    documentType: string;
    label: string;
    extractedFields: Array<{
      key: string;
      label: string;
      value: any;
      selected: boolean;
      isDate: boolean;
      category?: string;
      suggestedEvent?: string;
    }>;
    targetProfile?: { name: string; id?: string; type?: string; isNew?: boolean };
    trackerEntries?: Array<{ trackerName: string; values: Record<string, any> }>;
    documentPreview?: { id: string; name: string; mimeType: string; data: string };
    pendingFinancial?: any;
  };
  results?: Array<Record<string, any>>;
  // Rich visual output — inline charts, tables, reports
  charts?: Array<{
    type: string;
    title: string;
    subtitle?: string;
    data: Array<Record<string, any>>;
    series: Array<{ dataKey: string; name: string; color?: string; type?: string; stackId?: string }>;
    xAxisKey: string;
    xAxisLabel?: string;
    yAxisLabel?: string;
    showLegend?: boolean;
    showGrid?: boolean;
    height?: number;
    nameKey?: string;
    valueKey?: string;
  }>;
  tables?: Array<{
    title: string;
    subtitle?: string;
    columns: Array<{ key: string; label: string; align?: string; format?: string }>;
    rows: Array<Record<string, any>>;
    summary?: Record<string, any>;
  }>;
  report?: {
    title: string;
    subtitle?: string;
    generatedAt: string;
    sections: Array<{
      heading: string;
      content?: string;
      metrics?: Array<{ label: string; value: string | number; change?: string; changeType?: string }>;
      chart?: any;
      table?: any;
    }>;
  };
}

// ============================================================
// CUSTOM DOMAINS
// ============================================================

export interface Domain {
  id: string;
  name: string;
  slug: string;
  icon?: string;
  color?: string;
  description?: string;
  fields: DomainField[];
  createdAt: string;
}

export interface DomainField {
  name: string;
  type: "text" | "number" | "boolean" | "date" | "select" | "url" | "currency";
  options?: string[];
  required?: boolean;
}

export interface DomainEntry {
  id: string;
  domainId: string;
  values: Record<string, any>;
  tags: string[];
  notes?: string;
  createdAt: string;
}

export const insertDomainSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(z.object({
    name: z.string(),
    type: z.enum(["text", "number", "boolean", "date", "select", "url", "currency"]),
    options: z.array(z.string()).optional(),
    required: z.boolean().optional(),
  })).default([]),
});

export type InsertDomain = z.infer<typeof insertDomainSchema>;

// ============================================================
// PROFILES (expanded types)
// ============================================================

export type ProfileType = "person" | "pet" | "vehicle" | "account" | "property" | "subscription" | "medical" | "self" | "loan" | "investment" | "asset" | "liability";

// ============================================================
// LIABILITY SUBTYPES (type_key when type === 'liability')
// ============================================================
export type LiabilitySubtype =
  | "mortgage" | "auto_loan" | "credit_card" | "student_loan"
  | "medical_debt" | "business_loan" | "tax_debt" | "line_of_credit"
  | "bnpl" | "personal_loan" | "financing" | "utility_plan" | "custom";

export const LIABILITY_SUBTYPES: ReadonlyArray<{ key: LiabilitySubtype; label: string; icon?: string }> = [
  { key: "mortgage",       label: "Mortgage" },
  { key: "auto_loan",      label: "Auto Loan" },
  { key: "credit_card",    label: "Credit Card" },
  { key: "student_loan",   label: "Student Loan" },
  { key: "medical_debt",   label: "Medical Debt" },
  { key: "business_loan",  label: "Business Loan" },
  { key: "tax_debt",       label: "Tax Debt" },
  { key: "line_of_credit", label: "Line of Credit" },
  { key: "bnpl",           label: "BNPL / Installment" },
  { key: "personal_loan",  label: "Personal Loan" },
  { key: "financing",      label: "Financing Agreement" },
  { key: "utility_plan",   label: "Utility Payment Plan" },
  { key: "custom",         label: "Custom" },
];

export interface Profile {
  id: string;
  deletedAt?: string | null;
  type: ProfileType;
  type_key?: string; // Registry type key (e.g., 'vehicle', 'mortgage', 'streaming')
  name: string;
  avatar?: string;
  fields: Record<string, any>;
  tags: string[];
  notes: string;
  documents: string[];
  linkedTrackers: string[];
  linkedExpenses: string[];
  linkedTasks: string[];
  linkedEvents: string[];
  parentProfileId?: string;  // Nested profile: this profile belongs to another profile
  linkedObligationId?: string; // Links subscription/loan profile to its obligation record
  createdAt: string;
  updatedAt: string;
}

export const insertProfileSchema = z.object({
  type: z.enum(["person", "pet", "vehicle", "account", "property", "subscription", "medical", "self", "loan", "investment", "asset", "liability"]),
  type_key: z.string().optional(),
  name: z.string().min(1),
  fields: z.record(z.any()).optional().default({}),
  tags: z.array(z.string()).optional().default([]),
  notes: z.string().optional().default(""),
  parentProfileId: z.string().optional(),
});

export type InsertProfile = z.infer<typeof insertProfileSchema>;

// ============================================================
// TRACKERS (unchanged from Phase 1)
// ============================================================

export interface Tracker {
  id: string;
  name: string;
  category: string;
  unit?: string;
  icon?: string;
  fields: TrackerField[];
  entries: TrackerEntry[];
  linkedProfiles: string[];
  createdAt: string;
  /**
   * PR H: Canonical metric metadata. Optional for backward compatibility —
   * existing trackers without metadata fall back to category defaults via
   * getDefaultMetricDefinition(category) at read time.
   */
  metricDefinition?: TrackerMetricDefinition;
  /**
   * PERF (2026-07-21): when a tracker is embedded in ProfileDetail its
   * `entries` list is capped to the most recent N. entriesTotal carries the
   * TRUE entry count so the UI can offer "Show all N" (full history loads
   * lazily via GET /api/trackers/:id). Absent (or === entries.length) when
   * nothing was capped. Additive — `entries` keeps its name and shape.
   */
  entriesTotal?: number;
}

export interface TrackerField {
  name: string;
  /** Display override. Omit to derive one from `name` via trackerFieldLabel(). */
  label?: string;
  type: "number" | "text" | "boolean" | "select" | "duration";
  options?: string[];
  unit?: string;
  isPrimary?: boolean;
}

export interface TrackerEntry {
  id: string;
  values: Record<string, any>;
  computed: ComputedData;
  notes?: string;
  mood?: MoodLevel;
  tags?: string[];
  forProfile?: string; // Legacy: profile context for entry display
  profileId?: string;  // Profile ID this entry belongs to (for ownership + cascade delete)
  timestamp: string;
}

export interface ComputedData {
  caloriesBurned?: number;
  caloriesConsumed?: number;
  macros?: { protein: number; carbs: number; fat: number; fiber?: number };
  pace?: string;
  paceSeconds?: number;
  heartRateZone?: "recovery" | "fat_burn" | "cardio" | "peak";
  avgHeartRate?: number;
  distanceMiles?: number;
  durationMinutes?: number;
  intensity?: "low" | "moderate" | "high" | "extreme";
  bmi?: number;
  bloodPressureCategory?: "normal" | "elevated" | "high_stage1" | "high_stage2" | "crisis";
  sleepQuality?: "poor" | "fair" | "good" | "excellent";
  validated?: boolean;
  /** Per-value provenance from the estimation engine (shared/estimation-engine
   * Enrichment): which fields were calculated vs estimated, confidence,
   * methods, and the assumptions registry. Lives here — never in values. */
  enrichment?: any;
}

export const insertTrackerSchema = z.object({
  name: z.string().min(1),
  category: z.string().default("custom"),
  unit: z.string().optional(),
  icon: z.string().optional(),
  fields: z.array(z.object({
    name: z.string(),
    type: z.enum(["number", "text", "boolean", "select", "duration"]),
    options: z.array(z.string()).optional(),
    unit: z.string().optional(),
    isPrimary: z.boolean().optional(),
  })).default([]),
  metricDefinition: trackerMetricDefinitionSchema.optional(),
});

export type InsertTracker = z.infer<typeof insertTrackerSchema>;

export const insertTrackerEntrySchema = z.object({
  trackerId: z.string(),
  values: z.record(z.any()),
  notes: z.string().optional(),
  // Bug #37: aligned with the master journal MoodLevel so AI-emitted moods
  // (amazing/neutral/awful) don't get rejected by Zod when logged to a
  // tracker entry. Both schemas now share the same 8-level vocabulary.
  mood: z.enum(["amazing", "great", "good", "okay", "neutral", "bad", "awful", "terrible"]).optional(),
  tags: z.array(z.string()).optional(),
  forProfile: z.string().optional(),
  profileId: z.string().optional(),
  timestamp: z.string().optional(),
});

export type InsertTrackerEntry = z.infer<typeof insertTrackerEntrySchema>;

// ============================================================
// HABITS — with streaks and check-ins
// ============================================================

export type HabitFrequency = "daily" | "weekly" | "custom";

// When during the day a habit is meant to happen. "custom" pairs with
// scheduledTime (HH:MM); "anytime" means no particular slot. This drives the
// Morning/Afternoon/Evening/Night grouping on the Habits screen instead of
// inferring the slot from the last check-in timestamp.
export type HabitTimeOfDay = "morning" | "afternoon" | "evening" | "bedtime" | "anytime";

export interface Habit {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  frequency: HabitFrequency;
  targetDays?: number[]; // 0=Sun..6=Sat for custom frequency
  /**
   * Completions required on each scheduled DAY (default 1, e.g. 3 for "brush
   * teeth 3× daily"). Each one is its own check-in row with its own timestamp —
   * see shared/habit-progress.ts for the day-progress math.
   */
  targetPerDay: number;
  /**
   * The window the habit is scheduled in. Together with `targetPerDay` these
   * keep three different commitments from collapsing into one shape:
   *
   *   "2x per day"            targetPerDay 2, no endDate      → 2 a day, open-ended
   *   "daily for 2 days"      targetPerDay 1, endDate = +1d   → 1 a day, 2 days
   *   "2x per day for 7 days" targetPerDay 2, endDate = +6d   → 14 occurrences
   *
   * Both are YYYY-MM-DD, inclusive. `startDate` absent = scheduled from
   * creation; `endDate` absent = open-ended, which is the common case.
   */
  startDate?: string;
  endDate?: string;
  timeOfDay?: HabitTimeOfDay; // Scheduled slot; editable from the habit profile
  scheduledTime?: string; // "HH:MM" (24h) when timeOfDay is "custom" or a precise time is set
  currentStreak: number;
  longestStreak: number;
  checkins: HabitCheckin[];
  linkedProfiles?: string[];
  createdAt: string;
}

/**
 * ONE completion of a habit. A habit needing three completions a day has three
 * of these on that date, each with its own timestamp — they are never collapsed
 * into a counter, so any single one can be undone without disturbing the rest.
 */
export interface HabitCheckin {
  id: string;
  date: string; // YYYY-MM-DD
  value?: number; // Optional numeric value (e.g., glasses of water)
  notes?: string;
  timestamp: string;
}

export const insertHabitSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  frequency: z.enum(["daily", "weekly", "custom"]).default("daily"),
  targetDays: z.array(z.number().min(0).max(6)).optional(),
  targetPerDay: z.number().min(1).max(10).default(1),
  // Nullable so a PATCH can clear the window ("make it open-ended") rather than
  // only ever narrowing it.
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullable().optional(),
  // Nullable so a PATCH can explicitly clear a habit's schedule (send null),
  // not just leave it unset (undefined).
  timeOfDay: z.enum(["morning", "afternoon", "evening", "bedtime", "anytime"]).nullable().optional(),
  scheduledTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM (24h)").nullable().optional(),
});

export type InsertHabit = z.input<typeof insertHabitSchema>;

// ============================================================
// OBLIGATIONS — recurring bills, subscriptions, dues
// ============================================================

export type ObligationFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "once";

export type ObligationStatus = "active" | "paused" | "cancelled";

// Wave 16: kind classifies the *real-life shape* of the commitment so the UI,
// icons, side-effects, and dashboard cards can specialize per type. Backward
// compatible — defaults to 'bill' for any legacy row that doesn't have it.
export type ObligationKind =
  | "bill"
  | "subscription"
  | "loan_payment"
  | "medication"
  | "maintenance"
  | "appointment"
  | "habit"
  | "doc_expiration"
  | "task";

export const OBLIGATION_KIND_META: Record<ObligationKind, { label: string; icon: string; color: string; defaultLeadDays: number; }> = {
  bill:            { label: "Bill",            icon: "Receipt",     color: "#BB653B", defaultLeadDays: 3 },
  subscription:    { label: "Subscription",    icon: "Repeat",      color: "#5591C7", defaultLeadDays: 2 },
  loan_payment:    { label: "Loan payment",    icon: "CreditCard",  color: "#A13544", defaultLeadDays: 5 },
  medication:      { label: "Medication",      icon: "Pill",        color: "#6DAA45", defaultLeadDays: 0 },
  maintenance:     { label: "Maintenance",     icon: "Wrench",      color: "#797876", defaultLeadDays: 7 },
  appointment:     { label: "Appointment",     icon: "CalendarClock", color: "#A86FDF", defaultLeadDays: 1 },
  habit:           { label: "Habit",           icon: "Activity",    color: "#20808D", defaultLeadDays: 0 },
  doc_expiration:  { label: "Document expires",icon: "FileWarning", color: "#D19900", defaultLeadDays: 30 },
  task:            { label: "Task",            icon: "CheckSquare", color: "#4F98A3", defaultLeadDays: 0 },
};

export type OccurrenceStatus = "pending" | "done" | "skipped" | "late" | "rescheduled";

export interface ObligationOccurrence {
  id: string;
  obligationId: string;
  dueAt: string;            // YYYY-MM-DD (current, may be rescheduled)
  originalDueAt: string;    // YYYY-MM-DD (the canonical slot it represents)
  status: OccurrenceStatus;
  completedAt?: string;
  actualAmount?: number;
  notes?: string;
  paymentId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Obligation {
  id: string;
  name: string;
  amount: number;
  frequency: ObligationFrequency;
  category: string; // rent, utilities, insurance, subscription, loan, etc.
  kind: ObligationKind;          // Wave 16 — life-shape classifier
  nextDueDate: string;
  autopay: boolean;
  status: ObligationStatus;
  leadTimeDays: number;          // Wave 16 — how many days in advance to remind
  autoLogExpense: boolean;       // Wave 16 — when done, also create an expense row
  linkedProfiles: string[];
  linkedAssetId?: string;
  linkedLiabilityId?: string;
  linkedDocumentId?: string;
  recurrenceEnd?: string;        // YYYY-MM-DD — stop generating occurrences after this date
  currency: string;
  icon?: string;
  payments: ObligationPayment[];
  notes?: string;
  fields?: Record<string, any>;
  /**
   * How the amount behaves each cycle — see shared/liability-billing.
   * "fixed" (the default) means `amount` IS the amount. For "variable" and
   * "usage_based", `amount` is the CURRENT total of the next due billing
   * period (base + that period's charges, or its posted actual), while
   * `baseAmount` is the definition's figure. Every consumer — upcoming bills,
   * cash flow, the calendar — reads `amount` and is therefore right for both.
   */
  billingModel?: string;
  /** The definition's per-period amount, before this period's charges. */
  baseAmount?: number;
  /** True when `amount` is still a forecast rather than a posted charge. */
  amountIsEstimate?: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface ObligationPayment {
  id: string;
  amount: number;
  date: string;
  method?: string;
  confirmationNumber?: string;
  createdAt?: string;
}

// Sane hard ceiling for money fields — beyond any real transaction, but blocks
// absurd/overflow values (e.g. a $1e15 expense the API previously accepted).
export const MAX_MONEY = 1_000_000_000_000; // $1 trillion

// Ceiling for a SINGLE ledger transaction (one expense, one income line, one
// bill instalment). MAX_MONEY is the right bound for a balance-sheet position
// (a portfolio, a mortgage) but far too loose for a transaction: QA report
// 2026-07-29 EDGE-001 entered `1e10` in the Add Expense amount field, the API
// accepted it, and Cash Flow rendered -$9,999,972,024 — a number that then had
// to be hunted down and deleted by hand. The field's own `valuemax` was already
// $1B; this makes that the enforced contract on BOTH sides of the wire.
export const MAX_TRANSACTION_AMOUNT = 1_000_000_000; // $1 billion

/** Amount above which a UI should ask "did you really mean this?" before saving. */
export const LARGE_TRANSACTION_AMOUNT = 1_000_000; // $1 million

/** The one message every surface shows when a transaction blows the ceiling. */
export const TRANSACTION_TOO_LARGE_MESSAGE =
  `Amount must be less than $${MAX_TRANSACTION_AMOUNT.toLocaleString("en-US")}. Check for a typo or a stray zero.`;

export const insertObligationSchema = z.object({
  name: z.string().min(1),
  amount: z.number().nonnegative("Amount must be 0 or positive").max(MAX_TRANSACTION_AMOUNT, TRANSACTION_TOO_LARGE_MESSAGE),
  frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly", "once"]).default("monthly"),
  category: z.string().default("general"),
  kind: z.enum(["bill","subscription","loan_payment","medication","maintenance","appointment","habit","doc_expiration","task"]).default("bill"),
  nextDueDate: z.string(),
  autopay: z.boolean().default(false),
  status: z.enum(["active", "paused", "cancelled"]).optional(),
  notes: z.string().optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
  autoLogExpense: z.boolean().optional(),
  linkedProfiles: z.array(z.string()).optional().default([]),
  linkedAssetId: z.string().uuid().optional().nullable(),
  linkedLiabilityId: z.string().uuid().optional().nullable(),
  linkedDocumentId: z.string().uuid().optional().nullable(),
  recurrenceEnd: z.string().optional(),
  currency: z.string().optional(),
  icon: z.string().optional(),
  /**
   * How this bill's amount behaves each cycle — see shared/liability-billing.
   * "fixed" is the same amount every period; "variable" recurs but the amount
   * changes; "usage_based" is a base price plus charges accrued in the period.
   * Defaults to "fixed" so existing bills keep their exact behaviour.
   */
  billingModel: z.enum(["fixed", "variable", "usage_based", "one_time", "installment"]).optional(),
});

export type InsertObligation = z.input<typeof insertObligationSchema>;

// ============================================================
// ARTIFACTS — checklists and notes
// ============================================================

export type ArtifactType = 
  | "checklist" | "note"
  | "markdown" | "code" | "html" | "react" | "svg" | "mermaid" | "chart"
  | "doc" | "sheet"; // doc = rich-text Word-style; sheet = Excel-style grid

export interface SheetCell {
  v?: string | number | null; // raw value
  f?: string;                 // formula (starts with "="); v is the cached eval
}

/** Wave 14: per-cell display format (Google Sheets-style number formatting / styling). */
export interface SheetCellFormat {
  /** Number format: "plain" (default), "currency" ($), "percent" (%), "number" (with decimals), "date". */
  numberFormat?: "plain" | "currency" | "percent" | "number" | "date";
  /** Decimal places when numberFormat is "currency", "percent", or "number". Default 2. */
  decimals?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** Tailwind text-align value. */
  align?: "left" | "center" | "right";
  /** Background color (any CSS color). */
  bg?: string;
  /** Foreground/text color (any CSS color). */
  fg?: string;
}

export interface SheetData {
  rows: number;                       // grid height
  cols: number;                       // grid width
  cells: Record<string, SheetCell>;   // sparse map keyed by "r,c" (e.g. "0,0")
  colWidths?: Record<number, number>; // optional column width overrides
  rowHeights?: Record<number, number>;
  /** Wave 14: optional per-cell display formats keyed by "r,c". */
  formats?: Record<string, SheetCellFormat>;
  /** Wave 14: optional sheet name (shown in the bottom tab bar). */
  sheetName?: string;
}

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  content: string; // For notes: body text. For code: the code. For chart: JSON. For doc: HTML.
  items: ChecklistItem[]; // For checklists
  tags: string[];
  linkedProfiles: string[];
  pinned: boolean;
  language?: string;        // For code artifacts: "python" | "javascript" | "sql" | "typescript" etc.
  dataBindings?: {          // For chart/dynamic artifacts
    tool: string;           // e.g. "spending_analytics"  
    params: Record<string, any>;  // e.g. { period: "month", profileId: "abc" }
  };
  chartData?: any[];        // Pre-computed chart data (fallback if dataBindings query fails)
  chartType?: "bar" | "line" | "area" | "pie";  // For "chart" type — picks Recharts component. Defaults to "bar".
  sheetData?: SheetData;    // For "sheet" type only
  source?: "chat" | "manual" | "ai"; // where the artifact was created from
  shareToken?: string;     // Optional public share token. When set, /share/:token shows a read-only view.
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  order: number;
}

export const insertArtifactSchema = z.object({
  type: z.enum(["checklist", "note", "markdown", "code", "html", "react", "svg", "mermaid", "chart", "doc", "sheet"]),
  title: z.string().min(1),
  // Cap at ~2 MB of HTML/markdown/code to prevent runaway docs from filling the
  // artifacts table. Most legitimate docs are well under 200 KB.
  content: z.string().max(2_000_000).default(""),
  items: z.array(z.object({
    text: z.string(),
    checked: z.boolean().default(false),
  })).default([]),
  tags: z.array(z.string()).optional().default([]),
  pinned: z.boolean().default(false),
  linkedProfiles: z.array(z.string()).optional().default([]),
  language: z.string().optional(),
  dataBindings: z.object({
    tool: z.string(),
    params: z.record(z.any()).default({}),
  }).optional(),
  chartData: z.array(z.any()).optional(),
  chartType: z.enum(["bar", "line", "area", "pie"]).optional(),
  // Sheet payload — only used when type === "sheet". Hard caps protect the DB.
  sheetData: z.object({
    rows: z.number().int().min(1).max(10000),
    cols: z.number().int().min(1).max(200),
    cells: z.record(z.object({
      v: z.union([z.string(), z.number(), z.null()]).optional(),
      f: z.string().max(2000).optional(),
    })),
    colWidths: z.record(z.number()).optional(),
    rowHeights: z.record(z.number()).optional(),
  }).optional(),
  source: z.enum(["chat", "manual", "ai"]).optional(),
});

export type InsertArtifact = z.infer<typeof insertArtifactSchema>;

// ============================================================
// JOURNAL / MOOD
// ============================================================

export type MoodLevel = "amazing" | "great" | "good" | "okay" | "neutral" | "bad" | "awful" | "terrible";

export interface JournalEntry {
  id: string;
  date: string; // YYYY-MM-DD
  mood: MoodLevel;
  content: string;
  tags: string[];
  energy?: number; // 1-5
  gratitude?: string[];
  highlights?: string[];
  linkedProfiles?: string[];
  createdAt: string;
}

export const insertJournalEntrySchema = z.object({
  date: z.string().optional(),
  mood: z.enum(["amazing", "great", "good", "okay", "neutral", "bad", "awful", "terrible"]),
  content: z.string().default(""),
  tags: z.array(z.string()).optional().default([]),
  energy: z.number().min(1).max(5).optional(),
  gratitude: z.array(z.string()).optional(),
  highlights: z.array(z.string()).optional(),
});

export type InsertJournalEntry = z.infer<typeof insertJournalEntrySchema>;

// ============================================================
// MEMORY — AI memory system
// ============================================================

export interface MemoryItem {
  id: string;
  key: string; // Short key (e.g., "favorite_food", "birthday")
  value: string;
  category: string; // preferences, facts, health, goals
  createdAt: string;
  updatedAt: string;
}

export const insertMemorySchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  category: z.string().default("general"),
});

export type InsertMemory = z.infer<typeof insertMemorySchema>;

// ============================================================
// TASKS (unchanged)
// ============================================================

/**
 * A to-do. Portol models scheduled life with exactly two entities — EVENTS
 * (things that happen) and TASKS (things you do) — so a task carries a clock
 * time of its own rather than delegating timed intent to a third "reminder"
 * kind. `dueTime` is the wall-clock time on `dueDate` in the user's zone; it
 * puts the task on the calendar at that hour and is when its notification
 * fires. Repetition lives in `tags` (shared/recurrence: recur:/runtil:/rcount:).
 */
export interface Task {
  id: string;
  deletedAt?: string | null;
  title: string;
  description?: string;
  status: "todo" | "in_progress" | "done";
  priority: "low" | "medium" | "high";
  dueDate?: string;
  /** HH:MM, 24-hour, in the user's timezone. Absent = an all-day to-do. */
  dueTime?: string;
  linkedProfiles: string[];
  tags: string[];
  createdAt: string;
  /** Last write time — for a done task this is when it was completed. */
  updatedAt?: string;
}

/** HH:MM, 24-hour. Rejects "9am", "25:00" and other things that aren't a time. */
export const CLOCK_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const insertTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  dueDate: z.string().optional(),
  dueTime: z.string().regex(CLOCK_TIME_RE, "Use HH:MM (24-hour)").optional(),
  tags: z.array(z.string()).optional().default([]),
  linkedProfiles: z.array(z.string()).optional().default([]),
});

export type InsertTask = z.input<typeof insertTaskSchema>;

// ============================================================
// FINANCE (unchanged)
// ============================================================

export interface Expense {
  id: string;
  deletedAt?: string | null;
  amount: number;
  category: string;
  description: string;
  vendor?: string;
  isRecurring?: boolean;
  linkedProfiles: string[];
  tags: string[];
  date: string;
  createdAt: string;
}

export const insertExpenseSchema = z.object({
  amount: z.number().positive("Amount must be a positive number").max(MAX_TRANSACTION_AMOUNT, TRANSACTION_TOO_LARGE_MESSAGE),
  category: z.string().default("general"),
  description: z.string().min(1, "Description must be non-empty"),
  vendor: z.string().optional(),
  isRecurring: z.boolean().optional(),
  date: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  linkedProfiles: z.array(z.string()).optional().default([]),
});

export type InsertExpense = z.input<typeof insertExpenseSchema>;

// ============================================================
// CALENDAR EVENTS (expanded with recurrence, categories, linking)
// ============================================================

/**
 * A named cadence, or `weekly:<days>` for a specific set of weekdays
 * (0 = Sunday), e.g. "weekly:1,3,5" for Mon/Wed/Fri. The parametrized form is
 * expanded by `weekdaySetFor` in shared/recurring-dates, which every consumer
 * routes through — including `weekdays` (Mon–Fri) and `weekends` (Sat/Sun),
 * which are just fixed day sets under the same rule.
 */
export type RecurrencePattern =
  | "none" | "daily" | "weekdays" | "weekends" | "weekly" | "biweekly" | "monthly" | "yearly"
  | `weekly:${string}`;

export const NAMED_RECURRENCE_PATTERNS = [
  "none", "daily", "weekdays", "weekends", "weekly", "biweekly", "monthly", "yearly",
] as const;

const WEEKDAY_SET_TOKEN_RE = /^weekly:[0-6](,[0-6])*$/;

export function isRecurrencePattern(v: unknown): v is RecurrencePattern {
  return typeof v === "string"
    && ((NAMED_RECURRENCE_PATTERNS as readonly string[]).includes(v) || WEEKDAY_SET_TOKEN_RE.test(v));
}

/**
 * Accepts a named pattern OR the `weekly:<days>` form.
 *
 * `z.custom` rather than a `z.union`: InsertEvent is derived from `z.input`,
 * and a union with a `z.string()` branch widens its input type to plain
 * `string` — which would quietly un-type every CalendarEvent.recurrence.
 */
export const recurrencePatternSchema = z.custom<RecurrencePattern>(
  isRecurrencePattern,
  { message: "Use a named cadence or weekly:<days>, e.g. weekly:1,3,5 for Mon/Wed/Fri" },
);

export type EventCategory = "personal" | "work" | "health" | "finance" | "family" | "social" | "travel" | "education" | "other";
// ============================================================
// INCOME
// ============================================================

export interface Income {
  id: string;
  description: string;
  amount: number;
  category: string;
  frequency: string;
  date?: string;
  linkedProfiles: string[];
  tags: string[];
  deletedAt?: string | null;
  createdAt: string;
}

export const insertIncomeSchema = z.object({
  description: z.string().min(1),
  amount: z.number().positive().max(MAX_TRANSACTION_AMOUNT, TRANSACTION_TOO_LARGE_MESSAGE),
  category: z.string().default("salary"),
  frequency: z.string().default("monthly"),
  date: z.string().optional(),
  linkedProfiles: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
});

export type InsertIncome = z.input<typeof insertIncomeSchema>;

export type ExpenseCategory = "general" | "food" | "transport" | "health" | "pet" | "vehicle" | "entertainment" | "shopping" | "utilities" | "housing" | "insurance" | "subscription" | "education" | "personal" | "automotive" | "travel";
export type ObligationCategory = "housing" | "utilities" | "insurance" | "subscription" | "loan" | "medical" | "education" | "transportation" | "communication" | "general";

export const EVENT_CATEGORY_COLORS: Record<EventCategory, string> = {
  personal: "#4F98A3",
  work: "#6B7280",
  health: "#6DAA45",
  finance: "#BB653B",
  family: "#A86FDF",
  social: "#5591C7",
  travel: "#20808D",
  education: "#D19900",
  other: "#797876",
};

export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  endDate?: string;
  allDay: boolean;
  description?: string;
  location?: string;
  category: EventCategory;
  color?: string;
  recurrence: RecurrencePattern;
  recurrenceEnd?: string;
  linkedProfiles: string[];
  linkedDocuments: string[];
  tags: string[];
  source: "manual" | "chat" | "ai" | "external";
  createdAt: string;
}

export const insertEventSchema = z.object({
  title: z.string().min(1),
  date: z.string(),
  time: z.string().optional(),
  endTime: z.string().optional(),
  endDate: z.string().optional(),
  allDay: z.boolean().default(false),
  description: z.string().optional(),
  location: z.string().optional(),
  category: z.enum(["personal", "work", "health", "finance", "family", "social", "travel", "education", "other"]).default("personal"),
  color: z.string().optional(),
  recurrence: recurrencePatternSchema.default("none"),
  recurrenceEnd: z.string().optional(),
  linkedProfiles: z.array(z.string()).optional().default([]),
  linkedDocuments: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  source: z.enum(["manual", "chat", "ai", "external"]).default("manual"),
});

export type InsertEvent = z.input<typeof insertEventSchema>;

// ============================================================
// UNIFIED CALENDAR TIMELINE ITEM (virtual, not stored)
// ============================================================

export type CalendarItemType = "event" | "task" | "habit" | "obligation";

export interface CalendarTimelineItem {
  id: string;
  type: CalendarItemType;
  title: string;
  date: string;
  time?: string;
  endTime?: string;
  allDay: boolean;
  color: string;
  category?: string;
  description?: string;
  location?: string;
  completed?: boolean;
  linkedProfiles: string[];
  sourceId: string; // ID of the original entity
  meta?: Record<string, any>;
}

// ============================================================
// DOCUMENTS — uploaded files with AI extraction
// ============================================================

export interface Document {
  id: string;
  deletedAt?: string | null;
  name: string;
  title?: string; // Display title (extracted or user-provided)
  type: string; // "drivers_license", "medical_report", "receipt", "insurance", "passport", "other"
  mimeType: string; // "image/jpeg", "application/pdf", etc.
  fileData: string; // base64 encoded file data (legacy — new docs use storagePath)
  storagePath?: string; // Supabase Storage path (new docs)
  storage_path?: string; // DB column alias (snake_case)
  extractedData: Record<string, any>;
  fields?: Record<string, any>; // Additional structured fields from extraction
  expirationDate?: string; // Document expiration date
  linkedProfiles: string[];
  tags: string[];
  createdAt: string;
}

export interface ProfileDocument {
  id: string;
  documentId: string;
  profileId: string;
  label: string; // "Driver's License", "Medical Report", etc.
  addedAt: string;
}

export const insertDocumentSchema = z.object({
  name: z.string().min(1),
  type: z.string().default("other"),
  mimeType: z.string().default("image/jpeg"),
  fileData: z.string(), // base64
  extractedData: z.record(z.any()).optional().default({}),
  linkedProfiles: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
});

export type InsertDocument = z.input<typeof insertDocumentSchema>;

// ============================================================
// GOALS — measurable goals with progress tracking
// ============================================================

export interface Goal {
  id: string;
  title: string;
  type: "weight_loss" | "weight_gain" | "savings" | "habit_streak" | "spending_limit" | "fitness_distance" | "fitness_frequency" | "tracker_target" | "custom";
  target: number;
  current: number;
  unit: string;
  startValue?: number;
  deadline?: string;
  trackerId?: string;
  habitId?: string;
  category?: string;
  status: "active" | "completed" | "abandoned";
  milestones: Array<{ value: number; label: string; reached: boolean; reachedAt?: string }>;
  linkedProfiles: string[];
  createdAt: string;
  updatedAt: string;
}

export interface InsertGoal {
  title: string;
  type: Goal["type"];
  target: number;
  unit: string;
  startValue?: number;
  deadline?: string;
  trackerId?: string;
  habitId?: string;
  category?: string;
  milestones?: Array<{ value: number; label: string }>;
}

export const insertGoalSchema = z.object({
  title: z.string().min(1),
  type: z.enum(["weight_loss", "weight_gain", "savings", "habit_streak", "spending_limit", "fitness_distance", "fitness_frequency", "tracker_target", "custom"]),
  target: z.number(),
  unit: z.string(),
  startValue: z.number().optional(),
  deadline: z.string().optional(),
  trackerId: z.string().optional(),
  habitId: z.string().optional(),
  category: z.string().optional(),
  milestones: z.array(z.object({ value: z.number(), label: z.string() })).optional(),
});

// ============================================================
// ENTITY LINKS — cross-entity relationship engine
// ============================================================

export interface EntityLink {
  id: string;
  sourceType: string;  // "profile" | "document" | "expense" | "task" | "tracker" | "event" | "habit" | "obligation"
  sourceId: string;
  targetType: string;
  targetId: string;
  relationship: string; // "belongs_to", "paid_for", "tracks", "document_for", "related_to"
  confidence: number;   // 0-1, 1 = explicit/manual, 0.5-0.9 = AI-inferred
  createdAt: string;
}

export interface InsertEntityLink {
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
  relationship: string;
  confidence?: number;
}

export const insertEntityLinkSchema = z.object({
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  relationship: z.string().min(1),
  confidence: z.number().min(0).max(1).optional().default(1),
});

// ============================================================
// AI INSIGHTS (expanded)
// ============================================================

export interface Insight {
  id: string;
  type: "health_correlation" | "spending_trend" | "reminder" | "streak" | "anomaly" | "suggestion" | "habit_streak" | "obligation_due" | "mood_trend";
  title: string;
  description: string;
  severity: "info" | "warning" | "positive" | "negative";
  relatedEntityType?: string;
  relatedEntityId?: string;
  data?: Record<string, any>;
  createdAt: string;
}

// ============================================================
// PROFILE DETAIL (aggregated — expanded)
// ============================================================

export interface ProfileDetail extends Profile {
  relatedTrackers: Tracker[];
  relatedExpenses: Expense[];
  relatedTasks: Task[];
  relatedEvents: CalendarEvent[];
  relatedDocuments: Document[];
  relatedObligations: Obligation[];
  relatedHabits: Habit[];
  childProfiles: Profile[];  // Nested profiles (assets, subscriptions, loans, etc.)
  timeline: TimelineEntry[];
  // Cost of ownership: expenses that belong to the assets this person owns,
  // derived (not duplicated) so the owner sees the full cost. Each entry is the
  // original Expense row plus `_viaAsset` (source asset) and `_ownershipPercentage`.
  // Only present on person-like profiles; empty otherwise.
  ownedAssetExpenses?: (Expense & { _viaAsset?: { id: string; name: string; type?: string }; _ownershipPercentage?: number })[];
  // Journal entries linked to this profile (capped — see totals below).
  relatedJournal?: JournalEntry[];
  // PERF (2026-07-21, large-profile first paint): the related* lists above are
  // CAPPED to the most recent N per section so a data-heavy profile doesn't
  // ship megabytes on first paint. These sibling fields are ADDITIVE — every
  // existing field keeps its name and shape — and carry the TRUE totals so the
  // client can render "Show all N" affordances and exact headline counts/sums.
  // When a list is not capped, total === list.length.
  relatedExpensesTotal?: number;      // true count of all related expenses
  relatedExpensesSum?: number;        // sum of ALL related expense amounts (not just the capped page)
  relatedExpensesOwnedSum?: number;   // sum over expenses whose linkedProfiles[0] === this profile (the Finance tab's strict-ownership rule)
  relatedExpensesOwnedCount?: number; // count under the same strict-ownership rule
  relatedEventsTotal?: number;        // true count of all related events
  relatedJournalTotal?: number;       // true count of all related journal entries
  relatedDocumentsTotal?: number;     // true count of all related documents
  timelineTotal?: number;             // timeline length before capping
  trackerEntriesTotal?: number;       // true count of tracker entries across relatedTrackers
}

export interface TimelineEntry {
  id: string;
  type: "tracker" | "expense" | "task" | "event" | "document" | "note" | "habit" | "obligation" | "journal" | "profile";
  title: string;
  description?: string;
  data?: Record<string, any>;
  timestamp: string;
}

/** Human label for a profile row's type, for feeds and summaries. */
const PROFILE_TYPE_LABEL: Record<string, string> = {
  liability: "Liability", loan: "Liability", asset: "Asset", vehicle: "Vehicle",
  property: "Property", account: "Account", investment: "Investment",
  subscription: "Subscription", person: "Person", pet: "Pet", medical: "Medical",
  self: "Profile",
};

/**
 * THE timeline row for a profile's own record (an asset, a liability, an
 * account nested under it).
 *
 * A person's activity feed used to carry only the things LINKED to them —
 * tasks, expenses, events, documents — and never the records filed UNDER them.
 * So adding an asset and a liability to someone and opening their Activity tab
 * showed "No activity yet", which is the one reading that was certainly wrong.
 * Both storage implementations build the row through here so the two feeds
 * cannot drift.
 */
export function childProfileTimelineEntry(child: {
  id: string; name?: string; type?: string; type_key?: string | null;
  fields?: Record<string, any> | null; createdAt?: string; updatedAt?: string;
}): TimelineEntry {
  const label = PROFILE_TYPE_LABEL[String(child.type || "")] || "Record";
  const f = child.fields || {};
  const amount = [
    f.currentBalance, f.currentValue, f.value, f.balance, f.purchasePrice,
  ].map((v) => Number(v)).find((n) => Number.isFinite(n) && n !== 0);
  return {
    id: child.id,
    type: "profile",
    title: child.name || label,
    description: amount != null
      ? `${label} — $${Math.abs(amount).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
      : `${label} added`,
    timestamp: child.createdAt || child.updatedAt || new Date(0).toISOString(),
  };
}

// ============================================================
// DASHBOARD STATS (expanded)
// ============================================================

export interface DashboardStats {
  totalProfiles: number;
  totalTrackers: number;
  totalTasks: number;
  activeTasks: number;
  totalExpenses: number;
  totalEvents: number;
  monthlySpend: number;
  weeklyEntries: number;
  streaks: { name: string; days: number }[];
  recentActivity: { type: string; description: string; timestamp: string }[];
  // Phase 2 additions
  totalHabits: number;
  habitCompletionRate: number; // 0-100%
  totalObligations: number;
  upcomingObligations: number; // Due within 7 days
  monthlyObligationTotal: number;
  journalStreak: number; // Days in a row with journal entries
  currentMood?: MoodLevel;
  totalArtifacts: number;
  totalMemories: number;
}

// ============================================================
// LIABILITIES — links + payments (Phase 1 of Liability module)
// ============================================================

export type LiabilityPartyRole = "owner" | "co_signer" | "guarantor" | "responsible_party" | "authorized_user";

export interface LiabilityAssetLink {
  id: string;
  liabilityProfileId: string;
  assetProfileId: string;
  ownershipPercentage: number;    // 0..100
  allocationAmount?: number | null; // optional hard $ allocation
  role: string;                    // "collateral" | "improvement" | "shared" | custom
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LiabilityProfileLink {
  id: string;
  liabilityProfileId: string;
  partyProfileId: string;
  ownershipPercentage: number;
  role: LiabilityPartyRole;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LiabilityPaymentType =
  | "standard" | "minimum" | "custom" | "extra_principal"
  | "interest_only" | "partial" | "payoff" | "reversal"
  | "deferred" | "skipped";

export interface LiabilityPayment {
  id: string;
  liabilityProfileId: string;
  paymentDate: string;      // YYYY-MM-DD
  amount: number;
  principalPortion: number;
  interestPortion: number;
  fees: number;
  remainingBalanceAfter?: number | null;
  paymentType: LiabilityPaymentType;
  sourceAccount?: string | null;
  documentId?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const insertLiabilityAssetLinkSchema = z.object({
  liabilityProfileId: z.string().uuid(),
  assetProfileId: z.string().uuid(),
  ownershipPercentage: z.number().min(0).max(100).default(100),
  allocationAmount: z.number().nonnegative().nullable().optional(),
  role: z.string().default("collateral"),
  notes: z.string().nullable().optional(),
});
export type InsertLiabilityAssetLink = z.input<typeof insertLiabilityAssetLinkSchema>;

export const insertLiabilityProfileLinkSchema = z.object({
  liabilityProfileId: z.string().uuid(),
  partyProfileId: z.string().uuid(),
  ownershipPercentage: z.number().min(0).max(100).default(100),
  role: z.enum(["owner", "co_signer", "guarantor", "responsible_party", "authorized_user"]).default("owner"),
  notes: z.string().nullable().optional(),
});
export type InsertLiabilityProfileLink = z.input<typeof insertLiabilityProfileLinkSchema>;

// ============================================================
// RELATIONSHIPS — asset_party_links + ownership_history
// ============================================================

export type AssetPartyRole = "owner" | "co_owner" | "beneficiary" | "trustee" | "custodian" | "authorized_user";

export interface AssetPartyLink {
  id: string;
  assetProfileId: string;
  partyProfileId: string;
  ownershipPercentage: number;
  role: AssetPartyRole;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const insertAssetPartyLinkSchema = z.object({
  assetProfileId: z.string().uuid(),
  partyProfileId: z.string().uuid(),
  ownershipPercentage: z.number().min(0).max(100).default(100),
  role: z.enum(["owner", "co_owner", "beneficiary", "trustee", "custodian", "authorized_user"]).default("owner"),
  effectiveFrom: z.string().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type InsertAssetPartyLink = z.input<typeof insertAssetPartyLinkSchema>;

export type OwnershipLinkKind = "asset_party" | "liability_party" | "liability_asset";
export type OwnershipAction = "create" | "update" | "delete" | "move";

export interface OwnershipHistoryEntry {
  id: string;
  linkKind: OwnershipLinkKind;
  linkId?: string | null;
  subjectId?: string | null;
  counterpartyId?: string | null;
  action: OwnershipAction;
  fieldChanged?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  changedBy: string;        // 'user' | 'ai'
  note?: string | null;
  changedAt: string;
}

export const insertLiabilityPaymentSchema = z.object({
  liabilityProfileId: z.string().uuid(),
  paymentDate: z.string(),
  amount: z.number().nonnegative(),
  principalPortion: z.number().nonnegative().default(0),
  interestPortion: z.number().nonnegative().default(0),
  fees: z.number().nonnegative().default(0),
  remainingBalanceAfter: z.number().nullable().optional(),
  paymentType: z.enum([
    "standard", "minimum", "custom", "extra_principal",
    "interest_only", "partial", "payoff", "reversal",
    "deferred", "skipped",
  ]).default("standard"),
  sourceAccount: z.string().nullable().optional(),
  documentId: z.string().uuid().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type InsertLiabilityPayment = z.input<typeof insertLiabilityPaymentSchema>;

/**
 * Phase 1 liability migration: legacy profiles may still carry type='loan'
 * until a user-initiated re-save. Treat both 'loan' and 'liability' as the
 * same logical kind throughout the app.
 */
export function isLiabilityType(t: string | null | undefined): boolean {
  return t === "liability" || t === "loan";
}

// =============================================================================
// Universal Capture Layer (PR Y)
// =============================================================================
// A Capture is the universal envelope for ANY piece of information the user
// gives the app — a text message, a document, a spoken note, a sensor reading.
// Every chat input lands as a Capture first; downstream handlers (expense
// creator, tracker logger, etc.) read from it and produce "projections" —
// concrete rows in the existing typed tables (expenses, trackers, etc.).
//
// This lets the app accept data even when its type is unknown, low-confidence,
// or doesn't fit any existing schema. The raw input is never lost.
// =============================================================================

export type CaptureType =
  | "expense" | "income" | "obligation"
  | "tracker_entry" | "tracker_create"
  | "task" | "event" | "reminder" | "habit"
  | "profile_fact" | "profile_create"
  | "asset" | "liability"
  | "document" | "medical_record"
  | "note" | "unknown";

export type CaptureStatus =
  | "pending"           // saved, waiting on user confirmation (low confidence)
  | "projected"         // successfully routed to a typed row
  | "dismissed"         // user discarded
  | "failed";           // routing attempted and errored

export interface CaptureProjection {
  /** Which typed table the capture became (e.g. "expense", "tracker_entry"). */
  kind: string;
  /** The id of the row that was created. */
  id: string;
  /** When the projection was made. */
  at: string;
}

export interface Capture {
  id: string;
  /** Best guess at the entity type. "unknown" until classified. */
  type: CaptureType;
  /** Profile this capture belongs to. Defaults to self when unclear. */
  ownerProfileId: string | null;
  /** Short human-readable label. */
  title: string;
  /** The raw input as received — NEVER mutated. */
  rawInput: string;
  /** Best-effort extraction into named fields. May contain anything. */
  structuredData: Record<string, unknown>;
  /** Anything that doesn't fit structuredData (units, hints, source-specific). */
  metadata: Record<string, unknown>;
  /** Other entity ids this capture relates to (assets, vehicles, people, etc.). */
  relationships: Array<{ kind: string; id: string; label?: string }>;
  /** Where it came from: "chat" | "document" | "api" | "voice" | etc. */
  source: string;
  /** Classifier confidence 0–1. */
  confidence: number;
  /** State of this capture. */
  status: CaptureStatus;
  /** Typed rows produced from this capture (one capture can produce many). */
  projections: CaptureProjection[];
  /** Optional follow-up question the AI wants to ask the user. */
  clarifyingQuestion?: string | null;
  createdAt: string;
  updatedAt: string;
}

export const insertCaptureSchema = z.object({
  type: z.string().default("unknown"),
  ownerProfileId: z.string().uuid().nullable().optional(),
  title: z.string().default(""),
  rawInput: z.string(),
  structuredData: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
  relationships: z.array(z.object({
    kind: z.string(),
    id: z.string(),
    label: z.string().optional(),
  })).default([]),
  source: z.string().default("chat"),
  confidence: z.number().min(0).max(1).default(0.5),
  status: z.enum(["pending", "projected", "dismissed", "failed"]).default("pending"),
  projections: z.array(z.object({
    kind: z.string(),
    id: z.string(),
    at: z.string(),
  })).default([]),
  clarifyingQuestion: z.string().nullable().optional(),
});
export type InsertCapture = z.input<typeof insertCaptureSchema>;


// ============================================================
// AI ACTION LEDGER (undo + audit for chat mutations)
// ============================================================
// One row per successful AI-chat write, with enough context to reverse it.
// Powers undo_last_action / get_entity_history and the /api/activity feed.

export interface AiActionLog {
  id: string;
  tool: string;
  actionType: string;
  entityType?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  input?: Record<string, unknown> | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reversible: boolean;
  /** {op:'delete'|'restore'|'reapply_before'|'recreate'|'restore_set', ...} */
  reversePlan?: Record<string, unknown> | null;
  source: "chat" | "bulk" | "undo" | string;
  createdAt: string;
  undoneAt?: string | null;
  undoneByLogId?: string | null;
}

export interface InsertAiActionLog {
  tool: string;
  actionType: string;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  input?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reversible?: boolean;
  reversePlan?: Record<string, unknown>;
  source?: string;
}
