import { z } from "zod";

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
  type: "create_profile" | "create_tracker" | "log_entry" | "create_task" | "log_expense" | "create_event" | "update_profile" | "create_goal" | "create_habit" | "checkin_habit" | "create_obligation" | "pay_obligation" | "journal_entry" | "create_artifact" | "save_memory" | "recall_memory" | "retrieve" | "unknown";
  category: string;
  data: Record<string, any>;
  confirmed?: boolean;
}

// ============================================================
// CHAT
// ============================================================

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  actions?: ParsedAction[];
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
  };
  documentPreviews?: Array<{
    id: string;
    name: string;
    mimeType: string;
    data: string;
  }>;
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
      suggestedEvent?: string;
    }>;
    targetProfile?: { name: string; id?: string; type?: string; isNew?: boolean };
    trackerEntries?: Array<{ trackerName: string; values: Record<string, any> }>;
    documentPreview?: { id: string; name: string; mimeType: string; data: string };
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

export type ProfileType = "person" | "pet" | "vehicle" | "account" | "property" | "subscription" | "medical" | "self" | "loan" | "investment" | "asset";

export interface Profile {
  id: string;
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
  type: z.enum(["person", "pet", "vehicle", "account", "property", "subscription", "medical", "self", "loan", "investment", "asset"]),
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
}

export interface TrackerField {
  name: string;
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
  mood?: "great" | "good" | "okay" | "bad" | "terrible";
  tags?: string[];
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
});

export type InsertTracker = z.infer<typeof insertTrackerSchema>;

export const insertTrackerEntrySchema = z.object({
  trackerId: z.string(),
  values: z.record(z.any()),
  notes: z.string().optional(),
  mood: z.enum(["great", "good", "okay", "bad", "terrible"]).optional(),
  tags: z.array(z.string()).optional(),
});

export type InsertTrackerEntry = z.infer<typeof insertTrackerEntrySchema>;

// ============================================================
// HABITS — with streaks and check-ins
// ============================================================

export type HabitFrequency = "daily" | "weekly" | "custom";

export interface Habit {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  frequency: HabitFrequency;
  targetDays?: number[]; // 0=Sun..6=Sat for custom frequency
  currentStreak: number;
  longestStreak: number;
  checkins: HabitCheckin[];
  createdAt: string;
}

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
});

export type InsertHabit = z.infer<typeof insertHabitSchema>;

// ============================================================
// OBLIGATIONS — recurring bills, subscriptions, dues
// ============================================================

export type ObligationFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly" | "once";

export type ObligationStatus = "active" | "paused" | "cancelled";

export interface Obligation {
  id: string;
  name: string;
  amount: number;
  frequency: ObligationFrequency;
  category: string; // rent, utilities, insurance, subscription, loan, etc.
  nextDueDate: string;
  autopay: boolean;
  status: ObligationStatus;
  linkedProfiles: string[];
  payments: ObligationPayment[];
  notes?: string;
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

export const insertObligationSchema = z.object({
  name: z.string().min(1),
  amount: z.number().positive("Amount must be positive"),
  frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly", "once"]).default("monthly"),
  category: z.string().default("general"),
  nextDueDate: z.string(),
  autopay: z.boolean().default(false),
  notes: z.string().optional(),
  linkedProfiles: z.array(z.string()).optional().default([]),
});

export type InsertObligation = z.infer<typeof insertObligationSchema>;

// ============================================================
// ARTIFACTS — checklists and notes
// ============================================================

export type ArtifactType = "checklist" | "note";

export interface Artifact {
  id: string;
  type: ArtifactType;
  title: string;
  content: string; // For notes: the body text
  items: ChecklistItem[]; // For checklists
  tags: string[];
  linkedProfiles: string[];
  pinned: boolean;
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
  type: z.enum(["checklist", "note"]),
  title: z.string().min(1),
  content: z.string().default(""),
  items: z.array(z.object({
    text: z.string(),
    checked: z.boolean().default(false),
  })).default([]),
  tags: z.array(z.string()).optional().default([]),
  pinned: z.boolean().default(false),
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

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: "todo" | "in_progress" | "done";
  priority: "low" | "medium" | "high";
  dueDate?: string;
  linkedProfiles: string[];
  tags: string[];
  createdAt: string;
}

export const insertTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  dueDate: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  linkedProfiles: z.array(z.string()).optional().default([]),
});

export type InsertTask = z.infer<typeof insertTaskSchema>;

// ============================================================
// FINANCE (unchanged)
// ============================================================

export interface Expense {
  id: string;
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
  amount: z.number().positive("Amount must be a positive number"),
  category: z.string().default("general"),
  description: z.string().min(1, "Description must be non-empty"),
  vendor: z.string().optional(),
  isRecurring: z.boolean().optional(),
  date: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  linkedProfiles: z.array(z.string()).optional().default([]),
});

export type InsertExpense = z.infer<typeof insertExpenseSchema>;

// ============================================================
// CALENDAR EVENTS (expanded with recurrence, categories, linking)
// ============================================================

export type RecurrencePattern = "none" | "daily" | "weekly" | "biweekly" | "monthly" | "yearly";

export type EventCategory = "personal" | "work" | "health" | "finance" | "family" | "social" | "travel" | "education" | "other";

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
  recurrence: z.enum(["none", "daily", "weekly", "biweekly", "monthly", "yearly"]).default("none"),
  recurrenceEnd: z.string().optional(),
  linkedProfiles: z.array(z.string()).optional().default([]),
  linkedDocuments: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  source: z.enum(["manual", "chat", "ai", "external"]).default("manual"),
});

export type InsertEvent = z.infer<typeof insertEventSchema>;

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
  name: string;
  type: string; // "drivers_license", "medical_report", "receipt", "insurance", "passport", "other"
  mimeType: string; // "image/jpeg", "application/pdf", etc.
  fileData: string; // base64 encoded file data (legacy — new docs use storagePath)
  storagePath?: string; // Supabase Storage path (new docs)
  extractedData: Record<string, any>;
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

export type InsertDocument = z.infer<typeof insertDocumentSchema>;

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
  childProfiles: Profile[];  // Nested profiles (assets, subscriptions, loans, etc.)
  timeline: TimelineEntry[];
}

export interface TimelineEntry {
  id: string;
  type: "tracker" | "expense" | "task" | "event" | "document" | "note" | "habit" | "obligation" | "journal";
  title: string;
  description?: string;
  data?: Record<string, any>;
  timestamp: string;
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
