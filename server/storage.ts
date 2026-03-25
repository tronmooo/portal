import {
  type Profile, type InsertProfile,
  type Tracker, type InsertTracker, type TrackerEntry, type InsertTrackerEntry,
  type Task, type InsertTask,
  type Expense, type InsertExpense,
  type CalendarEvent, type InsertEvent, type CalendarTimelineItem,
  type EventCategory, EVENT_CATEGORY_COLORS,
  type Document, type DashboardStats,
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
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // Profiles
  getProfiles(): Promise<Profile[]>;
  getProfile(id: string): Promise<Profile | undefined>;
  getProfileDetail(id: string): Promise<ProfileDetail | undefined>;
  createProfile(data: InsertProfile): Promise<Profile>;
  updateProfile(id: string, data: Partial<Profile>): Promise<Profile | undefined>;
  deleteProfile(id: string): Promise<boolean>;
  linkProfileTo(profileId: string, entityType: string, entityId: string): Promise<void>;
  unlinkProfileFrom(profileId: string, entityType: string, entityId: string): Promise<void>;
  getSelfProfile(): Promise<Profile | undefined>;

  // Trackers
  getTrackers(): Promise<Tracker[]>;
  getTracker(id: string): Promise<Tracker | undefined>;
  createTracker(data: InsertTracker): Promise<Tracker>;
  updateTracker(id: string, data: Partial<Tracker>): Promise<Tracker | undefined>;
  logEntry(data: InsertTrackerEntry): Promise<TrackerEntry | undefined>;
  deleteTrackerEntry(trackerId: string, entryId: string): Promise<boolean>;
  deleteTracker(id: string): Promise<boolean>;
  migrateUnlinkedTrackersToSelf(): Promise<number>;

  // Tasks
  getTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  createTask(data: InsertTask): Promise<Task>;
  updateTask(id: string, data: Partial<Task>): Promise<Task | undefined>;
  deleteTask(id: string): Promise<boolean>;

  // Expenses
  getExpenses(): Promise<Expense[]>;
  createExpense(data: InsertExpense): Promise<Expense>;
  updateExpense(id: string, data: Partial<Expense>): Promise<Expense | undefined>;
  deleteExpense(id: string): Promise<boolean>;

  // Events
  getEvents(): Promise<CalendarEvent[]>;
  getEvent(id: string): Promise<CalendarEvent | undefined>;
  createEvent(data: InsertEvent): Promise<CalendarEvent>;
  updateEvent(id: string, data: Partial<CalendarEvent>): Promise<CalendarEvent | undefined>;
  deleteEvent(id: string): Promise<boolean>;

  // Unified calendar timeline
  getCalendarTimeline(startDate: string, endDate: string): Promise<CalendarTimelineItem[]>;

  // Documents
  getDocuments(): Promise<Document[]>;
  getDocument(id: string): Promise<Document | undefined>;
  createDocument(data: any): Promise<Document>;
  updateDocument(id: string, data: Partial<Document>): Promise<Document | undefined>;
  deleteDocument(id: string): Promise<boolean>;
  getDocumentsForProfile(profileId: string): Promise<Document[]>;

  // Habits
  getHabits(): Promise<Habit[]>;
  getHabit(id: string): Promise<Habit | undefined>;
  createHabit(data: InsertHabit): Promise<Habit>;
  checkinHabit(habitId: string, date?: string, value?: number, notes?: string): Promise<HabitCheckin | undefined>;
  updateHabit(id: string, data: Partial<Habit>): Promise<Habit | undefined>;
  deleteHabit(id: string): Promise<boolean>;

  // Obligations
  getObligations(): Promise<Obligation[]>;
  getObligation(id: string): Promise<Obligation | undefined>;
  createObligation(data: InsertObligation): Promise<Obligation>;
  updateObligation(id: string, data: Partial<Obligation>): Promise<Obligation | undefined>;
  payObligation(obligationId: string, amount: number, method?: string, confirmationNumber?: string): Promise<ObligationPayment | undefined>;
  deleteObligation(id: string): Promise<boolean>;

  // Artifacts
  getArtifacts(): Promise<Artifact[]>;
  getArtifact(id: string): Promise<Artifact | undefined>;
  createArtifact(data: InsertArtifact): Promise<Artifact>;
  updateArtifact(id: string, data: Partial<Artifact>): Promise<Artifact | undefined>;
  toggleChecklistItem(artifactId: string, itemId: string): Promise<Artifact | undefined>;
  deleteArtifact(id: string): Promise<boolean>;

  // Journal
  getJournalEntries(): Promise<JournalEntry[]>;
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
  getGoals(): Promise<Goal[]>;
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
  getStats(): Promise<DashboardStats>;
  getDashboardEnhanced(): Promise<any>;

  // Insights
  getInsights(): Promise<Insight[]>;

  // Search
  search(query: string): Promise<any[]>;

  // Preferences
  getPreference(key: string): Promise<string | null>;
  setPreference(key: string, value: string): Promise<void>;
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

  // BMI from weight tracker
  if (name === "weight" || name.includes("body weight")) {
    const weight = parseFloat(values.weight) || parseFloat(values.value) || 0;
    if (weight > 0) {
      const heightInches = 70;
      computed.bmi = Math.round((weight / (heightInches * heightInches)) * 703 * 10) / 10;
    }
  }

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

// ---- Streak calculator for habits ----
function calculateStreak(checkins: { date: string }[]): { current: number; longest: number } {
  if (checkins.length === 0) return { current: 0, longest: 0 };
  const dates = [...new Set(checkins.map(c => c.date))].sort().reverse();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let current = 0;
  let longest = 0;
  let tempStreak = 0;

  // Check if today or yesterday has a check-in (allow 1-day gap for "current")
  const startIdx = dates[0] === today ? 0 : dates[0] === yesterday ? 0 : -1;

  if (startIdx >= 0) {
    for (let i = 0; i < dates.length; i++) {
      const expected = new Date(Date.now() - (i) * 86400000).toISOString().slice(0, 10);
      // Allow starting from yesterday
      const expected2 = new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 10);
      if (dates.includes(expected) || (i === 0 && dates.includes(expected2))) {
        current++;
      } else {
        break;
      }
    }
  }

  // Calculate longest streak from all dates
  const allDates = [...new Set(checkins.map(c => c.date))].sort();
  tempStreak = 1;
  longest = 1;
  for (let i = 1; i < allDates.length; i++) {
    const prev = new Date(allDates[i - 1]);
    const curr = new Date(allDates[i]);
    const diff = (curr.getTime() - prev.getTime()) / 86400000;
    if (diff === 1) {
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
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) {
      const checkDate = new Date(today); checkDate.setDate(checkDate.getDate() - i);
      const dayStr = checkDate.toISOString().slice(0, 10);
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
    const moodScores: Record<string, number> = { amazing: 5, good: 4, neutral: 3, bad: 2, awful: 1 };
    const avg = recentJournal.reduce((s, j) => s + (moodScores[j.mood] || 3), 0) / recentJournal.length;
    if (avg <= 2.5) {
      insights.push({
        id: randomUUID(), type: "mood_trend",
        title: "Mood has been low this week",
        description: "Your journal entries suggest a tough stretch. Consider reaching out to someone or doing something you enjoy.",
        severity: "warning", data: { avgMood: avg }, createdAt: now.toISOString(),
      });
    } else if (avg >= 4) {
      insights.push({
        id: randomUUID(), type: "mood_trend",
        title: "Great mood this week",
        description: "You've been feeling positive. Keep doing what's working!",
        severity: "positive", data: { avgMood: avg }, createdAt: now.toISOString(),
      });
    }
  }

  // 9. Calorie summary
  const todayStr = now.toISOString().slice(0, 10);
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
  async getProfiles() { return Array.from(this.profiles.values()); }
  async getProfile(id: string) { return this.profiles.get(id); }

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
    const relatedDocuments = allDocs.filter(d => d.linkedProfiles.includes(id) || profile.documents.includes(d.id));
    const relatedObligations = allObs.filter(o => o.linkedProfiles.includes(id));

    const timeline: TimelineEntry[] = [];
    for (const t of relatedTrackers) {
      for (const e of t.entries) {
        timeline.push({ id: e.id, type: "tracker", title: `${t.name} logged`, description: Object.entries(e.values).map(([k, v]) => `${k}: ${v}`).join(", "), data: { ...e.values, computed: e.computed }, timestamp: e.timestamp });
      }
    }
    for (const e of relatedExpenses) { timeline.push({ id: e.id, type: "expense", title: e.description, description: `$${e.amount} - ${e.category}`, timestamp: e.date }); }
    for (const t of relatedTasks) { timeline.push({ id: t.id, type: "task", title: t.title, description: `${t.status} - ${t.priority}`, timestamp: t.createdAt }); }
    for (const e of relatedEvents) { timeline.push({ id: e.id, type: "event", title: e.title, description: e.description, timestamp: e.date }); }
    for (const d of relatedDocuments) { timeline.push({ id: d.id, type: "document", title: d.name, description: d.type, timestamp: d.createdAt }); }
    for (const o of relatedObligations) { timeline.push({ id: o.id, type: "obligation", title: o.name, description: `$${o.amount}/${o.frequency}`, timestamp: o.createdAt }); }
    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return { ...profile, relatedTrackers, relatedExpenses, relatedTasks, relatedEvents, relatedDocuments, relatedObligations, timeline };
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
    // Remove this profile from any linked documents
    for (const docId of profile.documents) {
      const doc = this.documents.get(docId);
      if (doc) {
        doc.linkedProfiles = doc.linkedProfiles.filter(pid => pid !== id);
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

  async getSelfProfile(): Promise<Profile | undefined> {
    return Array.from(this.profiles.values()).find(p => p.type === "self");
  }

  // ---- Trackers ----
  async getTrackers() { return Array.from(this.trackers.values()); }
  async getTracker(id: string) { return this.trackers.get(id); }
  async createTracker(data: InsertTracker): Promise<Tracker> {
    const tracker: Tracker = { id: randomUUID(), ...data, fields: data.fields || [], entries: [], linkedProfiles: [], createdAt: new Date().toISOString() };
    this.trackers.set(tracker.id, tracker);
    this.logActivity("tracker", `Created tracker: ${tracker.name}`);
    return tracker;
  }
  async logEntry(data: InsertTrackerEntry): Promise<TrackerEntry | undefined> {
    const tracker = this.trackers.get(data.trackerId);
    if (!tracker) return undefined;
    const computed = computeSecondaryData(tracker.name, tracker.category, data.values);
    const entry: TrackerEntry = { id: randomUUID(), values: data.values, computed, notes: data.notes, mood: data.mood as any, tags: data.tags, timestamp: new Date().toISOString() };
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
    const updated = { ...t, ...data };
    this.tasks.set(id, updated);
    if (data.status === "done") this.logActivity("task", `Completed: ${t.title}`);
    return updated;
  }
  async deleteTask(id: string) { return this.tasks.delete(id); }

  // ---- Expenses ----
  async getExpenses() { return Array.from(this.expenses.values()); }
  async createExpense(data: InsertExpense): Promise<Expense> {
    const expense: Expense = { id: randomUUID(), ...data, linkedProfiles: [], tags: data.tags || [], date: data.date || new Date().toISOString(), createdAt: new Date().toISOString() };
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
  async getCalendarTimeline(startDate: string, endDate: string): Promise<CalendarTimelineItem[]> {
    const items: CalendarTimelineItem[] = [];

    // 1. Calendar events (expand recurrence)
    for (const ev of this.events.values()) {
      const color = ev.color || EVENT_CATEGORY_COLORS[ev.category] || "#4F98A3";
      // Add base event
      const baseDate = ev.date.slice(0, 10);
      if (baseDate >= startDate && baseDate <= endDate) {
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
          meta: { recurrence: ev.recurrence, tags: ev.tags, source: ev.source },
        });
      }
      // Expand recurring
      if (ev.recurrence !== "none") {
        const base = new Date(ev.date);
        for (let i = 1; i <= 90; i++) {
          const next = new Date(base);
          switch (ev.recurrence) {
            case "daily":    next.setDate(next.getDate() + i); break;
            case "weekly":   next.setDate(next.getDate() + i * 7); break;
            case "biweekly": next.setDate(next.getDate() + i * 14); break;
            case "monthly":  next.setMonth(next.getMonth() + i); break;
            case "yearly":   next.setFullYear(next.getFullYear() + i); break;
          }
          const nextStr = next.toISOString().slice(0, 10);
          if (nextStr > endDate) break;
          if (ev.recurrenceEnd && nextStr > ev.recurrenceEnd) break;
          if (nextStr >= startDate) {
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

    // 4. Habits — show as daily markers for dates they're checked in
    for (const habit of this.habits.values()) {
      for (const checkin of habit.checkins) {
        const d = checkin.date;
        if (d >= startDate && d <= endDate) {
          items.push({
            id: `habit-${habit.id}-${d}`,
            type: "habit",
            title: habit.name,
            date: d,
            allDay: true,
            color: habit.color || "#4F98A3",
            completed: true,
            linkedProfiles: [],
            sourceId: habit.id,
            meta: { streak: habit.currentStreak, icon: habit.icon },
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
    const habit: Habit = { id: randomUUID(), ...data, frequency: data.frequency || "daily", currentStreak: 0, longestStreak: 0, checkins: [], createdAt: new Date().toISOString() };
    this.habits.set(habit.id, habit);
    this.logActivity("habit", `Created habit: ${habit.name}`);
    return habit;
  }
  async checkinHabit(habitId: string, date?: string, value?: number, notes?: string): Promise<HabitCheckin | undefined> {
    const habit = this.habits.get(habitId);
    if (!habit) return undefined;
    const checkinDate = date || new Date().toISOString().slice(0, 10);
    // Don't double-checkin same day
    if (habit.checkins.some(c => c.date === checkinDate)) return habit.checkins.find(c => c.date === checkinDate);
    const checkin: HabitCheckin = { id: randomUUID(), date: checkinDate, value, notes, timestamp: new Date().toISOString() };
    habit.checkins.push(checkin);
    // Recalculate streaks
    const { current, longest } = calculateStreak(habit.checkins);
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
    const obligation: Obligation = { id: randomUUID(), ...data, autopay: data.autopay ?? false, linkedProfiles: [], payments: [], createdAt: new Date().toISOString() };
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
    const nextDue = new Date(ob.nextDueDate);
    switch (ob.frequency) {
      case "weekly": nextDue.setDate(nextDue.getDate() + 7); break;
      case "biweekly": nextDue.setDate(nextDue.getDate() + 14); break;
      case "monthly": nextDue.setMonth(nextDue.getMonth() + 1); break;
      case "quarterly": nextDue.setMonth(nextDue.getMonth() + 3); break;
      case "yearly": nextDue.setFullYear(nextDue.getFullYear() + 1); break;
    }
    ob.nextDueDate = nextDue.toISOString().slice(0, 10);
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
    const artifact: Artifact = { id: randomUUID(), ...data, items, tags: data.tags || [], linkedProfiles: [], pinned: data.pinned ?? false, createdAt: now, updatedAt: now };
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
      id: randomUUID(), date: data.date || new Date().toISOString().slice(0, 10),
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
  async getStats(): Promise<DashboardStats> {
    const tasks = Array.from(this.tasks.values());
    const expenses = Array.from(this.expenses.values());
    const trackers = Array.from(this.trackers.values());
    const habits = Array.from(this.habits.values());
    const obligations = Array.from(this.obligations.values());
    const journalEntries = Array.from(this.journal.values());
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    const monthlyExpenses = expenses.filter(e => { const dd = new Date(e.date); return dd.getMonth() === thisMonth && dd.getFullYear() === thisYear; });
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    let weeklyEntries = 0;
    for (const t of trackers) { weeklyEntries += t.entries.filter(e => new Date(e.timestamp) > weekAgo).length; }

    const streaks: { name: string; days: number }[] = [];
    for (const t of trackers) {
      if (t.entries.length < 2) continue;
      let streak = 0;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      for (let i = 0; i < 30; i++) {
        const checkDate = new Date(today); checkDate.setDate(checkDate.getDate() - i);
        const dayStr = checkDate.toISOString().slice(0, 10);
        if (t.entries.some(e => e.timestamp.slice(0, 10) === dayStr)) streak++; else if (i > 0) break;
      }
      if (streak >= 2) streaks.push({ name: t.name, days: streak });
    }

    // Habit completion rate (last 7 days)
    const totalDailyHabits = habits.filter(h => h.frequency === "daily").length;
    let completedCheckins = 0;
    if (totalDailyHabits > 0) {
      for (let i = 0; i < 7; i++) {
        const dayStr = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
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
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) {
      const dayStr = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
      if (journalEntries.some(j => j.date === dayStr)) journalStreak++; else if (i > 0) break;
    }

    const recentJournal = journalEntries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const currentMood = recentJournal.length > 0 ? recentJournal[0].mood as MoodLevel : undefined;

    return {
      totalProfiles: this.profiles.size,
      totalTrackers: this.trackers.size,
      totalTasks: tasks.length,
      activeTasks: tasks.filter(t => t.status !== "done").length,
      totalExpenses: expenses.reduce((sum, e) => sum + e.amount, 0),
      totalEvents: this.events.size,
      monthlySpend: monthlyExpenses.reduce((sum, e) => sum + e.amount, 0),
      weeklyEntries,
      streaks,
      recentActivity: this.activity.slice(0, 10),
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
  async getDashboardEnhanced(): Promise<any> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    // Document expiration alerts — scan extractedData for date fields
    const documents = Array.from(this.documents.values());
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
    const trackers = Array.from(this.trackers.values());
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
    const expenses = Array.from(this.expenses.values());
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

    const obligations = Array.from(this.obligations.values());
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
    const tasks = Array.from(this.tasks.values());
    const overdueTasks = tasks.filter(t => {
      if (t.status === 'done' || !t.dueDate) return false;
      return new Date(t.dueDate) < now;
    }).map(t => ({ id: t.id, title: t.title, dueDate: t.dueDate!, priority: t.priority }));

    // Today's events
    const events = Array.from(this.events.values());
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
      todaysEvents,
      totalDocuments: documents.length,
    };
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
}

// Storage factory — uses Supabase if env vars are set, otherwise falls back to SQLite
// IMPORTANT: Lazy initialization — dotenv.config() must run before first access.
// ES module static imports hoist, so we can't eagerly call createStorage() at
// module load time. Instead, we defer creation until the first property access.
// SqliteStorage is loaded dynamically to avoid importing better-sqlite3 in serverless environments

let _storageInstance: IStorage | null = null;

function getStorage(): IStorage {
  if (!_storageInstance) {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && supabaseKey) {
      const { SupabaseStorage } = require('./supabase-storage');
      console.log('[storage] Using Supabase PostgreSQL storage');
      _storageInstance = new SupabaseStorage(supabaseUrl, supabaseKey, 'anonymous');
    } else {
      // Dynamic import — use eval to prevent esbuild from resolving at bundle time
      const mod = eval('require')("./sqlite-storage");
      const { SqliteStorage } = mod;
      console.log('[storage] Using SQLite local storage (env vars not found)');
      _storageInstance = new SqliteStorage();
    }
  }
  return _storageInstance!;
}

// Proxy that lazily initializes storage on first property access
export const storage: IStorage = new Proxy({} as IStorage, {
  get(_target, prop, receiver) {
    const instance = getStorage();
    const value = (instance as any)[prop];
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  },
  set(_target, prop, value) {
    const instance = getStorage();
    (instance as any)[prop] = value;
    return true;
  },
});

// Helper to check if we're using Supabase storage
export function isSupabaseStorage(): boolean {
  return !!(process.env.VITE_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
