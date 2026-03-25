import Database from "better-sqlite3";
import path from "path";
import { randomUUID } from "crypto";
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
  type MemoryItem, type InsertMemory,
  type Domain, type InsertDomain, type DomainEntry,
  type MoodLevel,
  type Goal, type InsertGoal,
  type EntityLink, type InsertEntityLink,
} from "@shared/schema";
import { type IStorage, computeSecondaryData } from "./storage";

// ---- JSON helpers ----
function toJSON(val: any): string { return JSON.stringify(val ?? null); }
function fromJSON<T>(val: string | null | undefined, fallback: T): T {
  if (val == null) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

// ---- Streak calculator ----
function calculateStreak(checkins: { date: string }[]): { current: number; longest: number } {
  if (checkins.length === 0) return { current: 0, longest: 0 };
  const dates = [...new Set(checkins.map(c => c.date))].sort().reverse();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let current = 0;
  const startIdx = dates[0] === today ? 0 : dates[0] === yesterday ? 0 : -1;
  if (startIdx >= 0) {
    for (let i = 0; i < dates.length; i++) {
      const expected = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const expected2 = new Date(Date.now() - (i + 1) * 86400000).toISOString().slice(0, 10);
      if (dates.includes(expected) || (i === 0 && dates.includes(expected2))) { current++; } else { break; }
    }
  }
  const allDates = [...new Set(checkins.map(c => c.date))].sort();
  let tempStreak = 1;
  let longest = 1;
  for (let i = 1; i < allDates.length; i++) {
    const prev = new Date(allDates[i - 1]);
    const curr = new Date(allDates[i]);
    const diff = (curr.getTime() - prev.getTime()) / 86400000;
    if (diff === 1) { tempStreak++; longest = Math.max(longest, tempStreak); } else { tempStreak = 1; }
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
    const allFE = fitnessTrackers.flatMap(t => t.entries).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    let streak = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) {
      const checkDate = new Date(today); checkDate.setDate(checkDate.getDate() - i);
      const dayStr = checkDate.toISOString().slice(0, 10);
      const hasEntry = allFE.some(e => e.timestamp.slice(0, 10) === dayStr);
      if (hasEntry) streak++; else if (i > 0) break;
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
    const moodScores: Record<string, number> = { amazing: 5, good: 4, neutral: 3, bad: 2, awful: 1 };
    const avg = recentJournal.reduce((s, j) => s + (moodScores[j.mood] || 3), 0) / recentJournal.length;
    if (avg <= 2.5) { insights.push({ id: randomUUID(), type: "mood_trend", title: "Mood has been low this week", description: "Your journal entries suggest a tough stretch. Consider reaching out to someone or doing something you enjoy.", severity: "warning", data: { avgMood: avg }, createdAt: now.toISOString() }); }
    else if (avg >= 4) { insights.push({ id: randomUUID(), type: "mood_trend", title: "Great mood this week", description: "You've been feeling positive. Keep doing what's working!", severity: "positive", data: { avgMood: avg }, createdAt: now.toISOString() }); }
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
// SQLITE STORAGE IMPLEMENTATION
// ============================================================

export class SqliteStorage implements IStorage {
  private db: Database.Database;

  constructor() {
    const dbPath = path.join(process.cwd(), "lifeos.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initTables();
    this.maybeSeed();
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT,
        fields TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '', documents TEXT NOT NULL DEFAULT '[]',
        linkedTrackers TEXT NOT NULL DEFAULT '[]', linkedExpenses TEXT NOT NULL DEFAULT '[]',
        linkedTasks TEXT NOT NULL DEFAULT '[]', linkedEvents TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trackers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'custom',
        unit TEXT, icon TEXT, fields TEXT NOT NULL DEFAULT '[]',
        linkedProfiles TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tracker_entries (
        id TEXT PRIMARY KEY, trackerId TEXT NOT NULL,
        "values" TEXT NOT NULL DEFAULT '{}', computed TEXT NOT NULL DEFAULT '{}',
        notes TEXT, mood TEXT, tags TEXT DEFAULT '[]', timestamp TEXT NOT NULL,
        FOREIGN KEY (trackerId) REFERENCES trackers(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
        status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
        dueDate TEXT, linkedProfiles TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS expenses (
        id TEXT PRIMARY KEY, amount REAL NOT NULL, category TEXT NOT NULL DEFAULT 'general',
        description TEXT NOT NULL, vendor TEXT, isRecurring INTEGER DEFAULT 0,
        linkedProfiles TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
        date TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL, time TEXT,
        endTime TEXT, endDate TEXT, allDay INTEGER NOT NULL DEFAULT 0,
        description TEXT, location TEXT, category TEXT NOT NULL DEFAULT 'personal',
        color TEXT, recurrence TEXT NOT NULL DEFAULT 'none', recurrenceEnd TEXT,
        linkedProfiles TEXT NOT NULL DEFAULT '[]', linkedDocuments TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'manual',
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'other',
        mimeType TEXT NOT NULL DEFAULT 'image/jpeg', fileData TEXT NOT NULL DEFAULT '',
        extractedData TEXT NOT NULL DEFAULT '{}', linkedProfiles TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS habits (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, color TEXT,
        frequency TEXT NOT NULL DEFAULT 'daily', targetDays TEXT,
        currentStreak INTEGER NOT NULL DEFAULT 0, longestStreak INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS habit_checkins (
        id TEXT PRIMARY KEY, habitId TEXT NOT NULL, date TEXT NOT NULL,
        value REAL, notes TEXT, timestamp TEXT NOT NULL,
        FOREIGN KEY (habitId) REFERENCES habits(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS obligations (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, amount REAL NOT NULL,
        frequency TEXT NOT NULL DEFAULT 'monthly', category TEXT NOT NULL DEFAULT 'general',
        nextDueDate TEXT NOT NULL, autopay INTEGER NOT NULL DEFAULT 0,
        linkedProfiles TEXT NOT NULL DEFAULT '[]', notes TEXT,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS obligation_payments (
        id TEXT PRIMARY KEY, obligationId TEXT NOT NULL, amount REAL NOT NULL,
        date TEXT NOT NULL, method TEXT, confirmationNumber TEXT,
        FOREIGN KEY (obligationId) REFERENCES obligations(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', items TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]', linkedProfiles TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal_entries (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, mood TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
        energy INTEGER, gratitude TEXT, highlights TEXT, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS domains (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
        icon TEXT, color TEXT, description TEXT,
        fields TEXT NOT NULL DEFAULT '[]', createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS domain_entries (
        id TEXT PRIMARY KEY, domainId TEXT NOT NULL,
        "values" TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]',
        notes TEXT, createdAt TEXT NOT NULL,
        FOREIGN KEY (domainId) REFERENCES domains(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL,
        target REAL NOT NULL, current REAL NOT NULL DEFAULT 0, unit TEXT NOT NULL,
        start_value REAL, deadline TEXT, tracker_id TEXT, habit_id TEXT,
        category TEXT, status TEXT NOT NULL DEFAULT 'active',
        milestones TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
        description TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entity_links (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relationship TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_links_unique
        ON entity_links(source_type, source_id, target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_entity_links_source
        ON entity_links(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_entity_links_target
        ON entity_links(target_type, target_id);
      CREATE TABLE IF NOT EXISTS preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private maybeSeed() {
    // No seed data in production
  }

  private logActivity(type: string, description: string) {
    this.db.prepare("INSERT INTO activity_log (type, description, timestamp) VALUES (?, ?, ?)").run(type, description, new Date().toISOString());
    // Keep max 50
    this.db.prepare("DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT 50)").run();
  }

  // ---- ROW → OBJECT helpers ----
  private rowToProfile(r: any): Profile {
    return { id: r.id, type: r.type, name: r.name, avatar: r.avatar || undefined, fields: fromJSON(r.fields, {}), tags: fromJSON(r.tags, []), notes: r.notes || "", documents: fromJSON(r.documents, []), linkedTrackers: fromJSON(r.linkedTrackers, []), linkedExpenses: fromJSON(r.linkedExpenses, []), linkedTasks: fromJSON(r.linkedTasks, []), linkedEvents: fromJSON(r.linkedEvents, []), createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  private rowToTracker(r: any): Tracker {
    const entries = this.db.prepare("SELECT * FROM tracker_entries WHERE trackerId = ? ORDER BY timestamp ASC").all(r.id).map((e: any) => this.rowToTrackerEntry(e));
    return { id: r.id, name: r.name, category: r.category, unit: r.unit || undefined, icon: r.icon || undefined, fields: fromJSON(r.fields, []), entries, linkedProfiles: fromJSON(r.linkedProfiles, []), createdAt: r.createdAt };
  }

  private rowToTrackerEntry(r: any): TrackerEntry {
    return { id: r.id, values: fromJSON(r.values, {}), computed: fromJSON(r.computed, {}), notes: r.notes || undefined, mood: r.mood || undefined, tags: fromJSON(r.tags, undefined), timestamp: r.timestamp };
  }

  private rowToTask(r: any): Task {
    return { id: r.id, title: r.title, description: r.description || undefined, status: r.status, priority: r.priority, dueDate: r.dueDate || undefined, linkedProfiles: fromJSON(r.linkedProfiles, []), tags: fromJSON(r.tags, []), createdAt: r.createdAt };
  }

  private rowToExpense(r: any): Expense {
    return { id: r.id, amount: r.amount, category: r.category, description: r.description, vendor: r.vendor || undefined, isRecurring: r.isRecurring === 1 ? true : undefined, linkedProfiles: fromJSON(r.linkedProfiles, []), tags: fromJSON(r.tags, []), date: r.date, createdAt: r.createdAt };
  }

  private rowToEvent(r: any): CalendarEvent {
    return { id: r.id, title: r.title, date: r.date, time: r.time || undefined, endTime: r.endTime || undefined, endDate: r.endDate || undefined, allDay: r.allDay === 1, description: r.description || undefined, location: r.location || undefined, category: r.category as EventCategory, color: r.color || undefined, recurrence: r.recurrence as any, recurrenceEnd: r.recurrenceEnd || undefined, linkedProfiles: fromJSON(r.linkedProfiles, []), linkedDocuments: fromJSON(r.linkedDocuments, []), tags: fromJSON(r.tags, []), source: r.source as any, createdAt: r.createdAt };
  }

  private rowToDocument(r: any): Document {
    return { id: r.id, name: r.name, type: r.type, mimeType: r.mimeType, fileData: r.fileData, extractedData: fromJSON(r.extractedData, {}), linkedProfiles: fromJSON(r.linkedProfiles, []), tags: fromJSON(r.tags, []), createdAt: r.createdAt };
  }

  private rowToHabit(r: any): Habit {
    const checkins = this.db.prepare("SELECT * FROM habit_checkins WHERE habitId = ? ORDER BY date ASC").all(r.id).map((c: any) => this.rowToHabitCheckin(c));
    return { id: r.id, name: r.name, icon: r.icon || undefined, color: r.color || undefined, frequency: r.frequency, targetDays: fromJSON(r.targetDays, undefined), currentStreak: r.currentStreak, longestStreak: r.longestStreak, checkins, createdAt: r.createdAt };
  }

  private rowToHabitCheckin(r: any): HabitCheckin {
    return { id: r.id, date: r.date, value: r.value ?? undefined, notes: r.notes || undefined, timestamp: r.timestamp };
  }

  private rowToObligation(r: any): Obligation {
    const payments = this.db.prepare("SELECT * FROM obligation_payments WHERE obligationId = ? ORDER BY date ASC").all(r.id).map((p: any) => this.rowToPayment(p));
    return { id: r.id, name: r.name, amount: r.amount, frequency: r.frequency, category: r.category, nextDueDate: r.nextDueDate, autopay: r.autopay === 1, linkedProfiles: fromJSON(r.linkedProfiles, []), payments, notes: r.notes || undefined, createdAt: r.createdAt };
  }

  private rowToPayment(r: any): ObligationPayment {
    return { id: r.id, amount: r.amount, date: r.date, method: r.method || undefined, confirmationNumber: r.confirmationNumber || undefined };
  }

  private rowToArtifact(r: any): Artifact {
    return { id: r.id, type: r.type, title: r.title, content: r.content, items: fromJSON(r.items, []), tags: fromJSON(r.tags, []), linkedProfiles: fromJSON(r.linkedProfiles, []), pinned: r.pinned === 1, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  private rowToJournalEntry(r: any): JournalEntry {
    return { id: r.id, date: r.date, mood: r.mood as MoodLevel, content: r.content, tags: fromJSON(r.tags, []), energy: r.energy ?? undefined, gratitude: fromJSON(r.gratitude, undefined), highlights: fromJSON(r.highlights, undefined), createdAt: r.createdAt };
  }

  private rowToMemory(r: any): MemoryItem {
    return { id: r.id, key: r.key, value: r.value, category: r.category, createdAt: r.createdAt, updatedAt: r.updatedAt };
  }

  private rowToDomain(r: any): Domain {
    return { id: r.id, name: r.name, slug: r.slug, icon: r.icon || undefined, color: r.color || undefined, description: r.description || undefined, fields: fromJSON(r.fields, []), createdAt: r.createdAt };
  }

  private rowToDomainEntry(r: any): DomainEntry {
    return { id: r.id, domainId: r.domainId, values: fromJSON(r.values, {}), tags: fromJSON(r.tags, []), notes: r.notes || undefined, createdAt: r.createdAt };
  }

  // ============================================================
  // PROFILES
  // ============================================================
  async getProfiles(): Promise<Profile[]> {
    return this.db.prepare("SELECT * FROM profiles").all().map((r: any) => this.rowToProfile(r));
  }
  async getProfile(id: string): Promise<Profile | undefined> {
    const r = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as any;
    return r ? this.rowToProfile(r) : undefined;
  }
  async getProfileDetail(id: string): Promise<ProfileDetail | undefined> {
    const profile = await this.getProfile(id);
    if (!profile) return undefined;

    const allTrackers = await this.getTrackers();
    const allExpenses = await this.getExpenses();
    const allTasks = await this.getTasks();
    const allEvents = await this.getEvents();
    const allDocs = await this.getDocuments();
    const allObs = await this.getObligations();

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
    for (const e of relatedExpenses) timeline.push({ id: e.id, type: "expense", title: e.description, description: `$${e.amount} - ${e.category}`, timestamp: e.date });
    for (const t of relatedTasks) timeline.push({ id: t.id, type: "task", title: t.title, description: `${t.status} - ${t.priority}`, timestamp: t.createdAt });
    for (const e of relatedEvents) timeline.push({ id: e.id, type: "event", title: e.title, description: e.description, timestamp: e.date });
    for (const d of relatedDocuments) timeline.push({ id: d.id, type: "document", title: d.name, description: d.type, timestamp: d.createdAt });
    for (const o of relatedObligations) timeline.push({ id: o.id, type: "obligation", title: o.name, description: `$${o.amount}/${o.frequency}`, timestamp: o.createdAt });
    timeline.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return { ...profile, relatedTrackers, relatedExpenses, relatedTasks, relatedEvents, relatedDocuments, relatedObligations, timeline };
  }

  async createProfile(data: InsertProfile): Promise<Profile> {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare("INSERT INTO profiles (id, type, name, fields, tags, notes, documents, linkedTrackers, linkedExpenses, linkedTasks, linkedEvents, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', ?, ?)").run(id, data.type, data.name, toJSON(data.fields || {}), toJSON(data.tags || []), data.notes || "", now, now);
    this.logActivity("profile", `Created profile: ${data.name}`);
    await this.autoGenerateProfileEvents(id, data.type, data.name, data.fields || {});
    return (await this.getProfile(id))!;
  }

  private async autoGenerateProfileEvents(profileId: string, type: string, name: string, fields: Record<string, any>): Promise<void> {
    const eventDefs: { fieldKey: string; titleFn: (n: string) => string; category: string; recurrence: string; color: string }[] = [];
    switch (type) {
      case "person": case "self":
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
        break;
      case "loan":
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
    for (const def of eventDefs) {
      const dateVal = fields[def.fieldKey];
      if (dateVal && typeof dateVal === "string" && dateVal.length >= 10) {
        try {
          await this.createEvent({
            title: def.titleFn(name),
            date: dateVal.slice(0, 10),
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

  async updateProfile(id: string, data: Partial<Profile>): Promise<Profile | undefined> {
    const existing = await this.getProfile(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
    this.db.prepare("UPDATE profiles SET type=?, name=?, avatar=?, fields=?, tags=?, notes=?, documents=?, linkedTrackers=?, linkedExpenses=?, linkedTasks=?, linkedEvents=?, updatedAt=? WHERE id=?").run(merged.type, merged.name, merged.avatar || null, toJSON(merged.fields), toJSON(merged.tags), merged.notes, toJSON(merged.documents), toJSON(merged.linkedTrackers), toJSON(merged.linkedExpenses), toJSON(merged.linkedTasks), toJSON(merged.linkedEvents), merged.updatedAt, id);
    return this.getProfile(id);
  }

  async deleteProfile(id: string): Promise<boolean> {
    const profile = await this.getProfile(id);
    if (!profile) return false;
    // Remove from linked documents
    for (const docId of profile.documents) {
      const doc = await this.getDocument(docId);
      if (doc) {
        const newLinked = doc.linkedProfiles.filter(pid => pid !== id);
        this.db.prepare("UPDATE documents SET linkedProfiles=? WHERE id=?").run(toJSON(newLinked), docId);
      }
    }
    this.db.prepare("DELETE FROM profiles WHERE id=?").run(id);
    return true;
  }

  async linkProfileTo(profileId: string, entityType: string, entityId: string): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) return;
    let field: string | undefined;
    switch (entityType) {
      case "tracker": if (!profile.linkedTrackers.includes(entityId)) { profile.linkedTrackers.push(entityId); field = "linkedTrackers"; } break;
      case "expense": if (!profile.linkedExpenses.includes(entityId)) { profile.linkedExpenses.push(entityId); field = "linkedExpenses"; } break;
      case "task": if (!profile.linkedTasks.includes(entityId)) { profile.linkedTasks.push(entityId); field = "linkedTasks"; } break;
      case "event": if (!profile.linkedEvents.includes(entityId)) { profile.linkedEvents.push(entityId); field = "linkedEvents"; } break;
      case "document": if (!profile.documents.includes(entityId)) { profile.documents.push(entityId); field = "documents"; } break;
    }
    if (field) {
      this.db.prepare(`UPDATE profiles SET ${field}=? WHERE id=?`).run(toJSON((profile as any)[field]), profileId);
    }
  }

  async unlinkProfileFrom(profileId: string, entityType: string, entityId: string): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) return;
    let field: string | undefined;
    switch (entityType) {
      case "tracker": profile.linkedTrackers = profile.linkedTrackers.filter(id => id !== entityId); field = "linkedTrackers"; break;
      case "expense": profile.linkedExpenses = profile.linkedExpenses.filter(id => id !== entityId); field = "linkedExpenses"; break;
      case "task": profile.linkedTasks = profile.linkedTasks.filter(id => id !== entityId); field = "linkedTasks"; break;
      case "event": profile.linkedEvents = profile.linkedEvents.filter(id => id !== entityId); field = "linkedEvents"; break;
      case "document": profile.documents = profile.documents.filter(id => id !== entityId); field = "documents"; break;
    }
    if (field) {
      this.db.prepare(`UPDATE profiles SET ${field}=? WHERE id=?`).run(toJSON((profile as any)[field]), profileId);
    }
  }

  async getSelfProfile(): Promise<Profile | undefined> {
    const r = this.db.prepare("SELECT * FROM profiles WHERE type='self' LIMIT 1").get() as any;
    return r ? this.rowToProfile(r) : undefined;
  }

  // ============================================================
  // TRACKERS
  // ============================================================
  async getTrackers(): Promise<Tracker[]> {
    return this.db.prepare("SELECT * FROM trackers").all().map((r: any) => this.rowToTracker(r));
  }
  async getTracker(id: string): Promise<Tracker | undefined> {
    const r = this.db.prepare("SELECT * FROM trackers WHERE id = ?").get(id) as any;
    return r ? this.rowToTracker(r) : undefined;
  }
  async createTracker(data: InsertTracker): Promise<Tracker> {
    const id = randomUUID();
    this.db.prepare("INSERT INTO trackers (id, name, category, unit, icon, fields, linkedProfiles, createdAt) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)").run(id, data.name, data.category || "custom", data.unit || null, data.icon || null, toJSON(data.fields || []), new Date().toISOString());
    this.logActivity("tracker", `Created tracker: ${data.name}`);
    return (await this.getTracker(id))!;
  }
  async updateTracker(id: string, data: Partial<Tracker>): Promise<Tracker | undefined> {
    const existing = await this.getTracker(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    this.db.prepare("UPDATE trackers SET name=?, category=?, unit=?, icon=?, fields=?, linkedProfiles=? WHERE id=?").run(merged.name, merged.category, merged.unit || null, merged.icon || null, toJSON(merged.fields), toJSON(merged.linkedProfiles), id);
    this.logActivity("tracker", `Updated tracker: ${merged.name}`);
    return this.getTracker(id);
  }
  async logEntry(data: InsertTrackerEntry): Promise<TrackerEntry | undefined> {
    const tracker = await this.getTracker(data.trackerId);
    if (!tracker) return undefined;
    const computed = computeSecondaryData(tracker.name, tracker.category, data.values);
    const id = randomUUID();
    const ts = new Date().toISOString();
    this.db.prepare('INSERT INTO tracker_entries (id, trackerId, "values", computed, notes, mood, tags, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, data.trackerId, toJSON(data.values), toJSON(computed), data.notes || null, data.mood || null, toJSON(data.tags || null), ts);
    let desc = `Logged ${tracker.name}: ${JSON.stringify(data.values)}`;
    if (computed.caloriesBurned) desc += ` (~${computed.caloriesBurned} cal burned)`;
    if (computed.pace) desc += ` (${computed.pace} pace)`;
    if (computed.caloriesConsumed) desc += ` (${computed.caloriesConsumed} cal)`;
    if (computed.bloodPressureCategory) desc += ` (${computed.bloodPressureCategory})`;
    if (computed.sleepQuality) desc += ` (${computed.sleepQuality} quality)`;
    this.logActivity("tracker", desc);
    return { id, values: data.values, computed, notes: data.notes, mood: data.mood as any, tags: data.tags, timestamp: ts };
  }
  async deleteTrackerEntry(trackerId: string, entryId: string): Promise<boolean> {
    const tracker = await this.getTracker(trackerId);
    if (!tracker) return false;
    const result = this.db.prepare("DELETE FROM tracker_entries WHERE id=? AND trackerId=?").run(entryId, trackerId);
    if (result.changes > 0) { this.logActivity("tracker", `Deleted entry from tracker: ${tracker.name}`); return true; }
    return false;
  }
  async deleteTracker(id: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM trackers WHERE id=?").run(id);
    return result.changes > 0;
  }

  async migrateUnlinkedTrackersToSelf(): Promise<number> {
    const self = await this.getSelfProfile();
    if (!self) return 0;
    const trackers = await this.getTrackers();
    let count = 0;
    for (const tracker of trackers) {
      if (tracker.linkedProfiles.length === 0) {
        tracker.linkedProfiles.push(self.id);
        this.db.prepare("UPDATE trackers SET linkedProfiles=? WHERE id=?").run(toJSON(tracker.linkedProfiles), tracker.id);
        await this.linkProfileTo(self.id, "tracker", tracker.id);
        count++;
      }
    }
    return count;
  }

  // ============================================================
  // TASKS
  // ============================================================
  async getTasks(): Promise<Task[]> {
    return this.db.prepare("SELECT * FROM tasks").all().map((r: any) => this.rowToTask(r));
  }
  async getTask(id: string): Promise<Task | undefined> {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as any;
    return r ? this.rowToTask(r) : undefined;
  }
  async createTask(data: InsertTask): Promise<Task> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO tasks (id, title, description, status, priority, dueDate, linkedProfiles, tags, createdAt) VALUES (?, ?, ?, 'todo', ?, ?, '[]', ?, ?)").run(id, data.title, data.description || null, data.priority || "medium", data.dueDate || null, toJSON(data.tags || []), now);
    this.logActivity("task", `Created task: ${data.title}`);
    return (await this.getTask(id))!;
  }
  async updateTask(id: string, data: Partial<Task>): Promise<Task | undefined> {
    const existing = await this.getTask(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    this.db.prepare("UPDATE tasks SET title=?, description=?, status=?, priority=?, dueDate=?, linkedProfiles=?, tags=? WHERE id=?").run(merged.title, merged.description || null, merged.status, merged.priority, merged.dueDate || null, toJSON(merged.linkedProfiles), toJSON(merged.tags), id);
    if (data.status === "done") this.logActivity("task", `Completed: ${existing.title}`);
    return this.getTask(id);
  }
  async deleteTask(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM tasks WHERE id=?").run(id).changes > 0;
  }

  // ============================================================
  // EXPENSES
  // ============================================================
  async getExpenses(): Promise<Expense[]> {
    return this.db.prepare("SELECT * FROM expenses").all().map((r: any) => this.rowToExpense(r));
  }
  async createExpense(data: InsertExpense): Promise<Expense> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO expenses (id, amount, category, description, vendor, isRecurring, linkedProfiles, tags, date, createdAt) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)").run(id, data.amount, data.category || "general", data.description, data.vendor || null, data.isRecurring ? 1 : 0, toJSON(data.tags || []), data.date || now, now);
    this.logActivity("expense", `${data.description} - $${data.amount}${data.vendor ? ` at ${data.vendor}` : ""}`);
    return (await this.getExpense(id))!;
  }
  private async getExpense(id: string): Promise<Expense | undefined> {
    const r = this.db.prepare("SELECT * FROM expenses WHERE id=?").get(id) as any;
    return r ? this.rowToExpense(r) : undefined;
  }
  async updateExpense(id: string, data: Partial<Expense>): Promise<Expense | undefined> {
    const existing = await this.getExpense(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    this.db.prepare("UPDATE expenses SET amount=?, category=?, description=?, vendor=?, isRecurring=?, linkedProfiles=?, tags=?, date=? WHERE id=?").run(merged.amount, merged.category, merged.description, merged.vendor || null, merged.isRecurring ? 1 : 0, toJSON(merged.linkedProfiles), toJSON(merged.tags), merged.date, id);
    this.logActivity("expense", `Updated expense: ${merged.description}`);
    return this.getExpense(id);
  }
  async deleteExpense(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM expenses WHERE id=?").run(id).changes > 0;
  }

  // ============================================================
  // EVENTS
  // ============================================================
  async getEvents(): Promise<CalendarEvent[]> {
    return this.db.prepare("SELECT * FROM events").all().map((r: any) => this.rowToEvent(r));
  }
  async getEvent(id: string): Promise<CalendarEvent | undefined> {
    const r = this.db.prepare("SELECT * FROM events WHERE id=?").get(id) as any;
    return r ? this.rowToEvent(r) : undefined;
  }
  async createEvent(data: InsertEvent): Promise<CalendarEvent> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO events (id, title, date, time, endTime, endDate, allDay, description, location, category, color, recurrence, recurrenceEnd, linkedProfiles, linkedDocuments, tags, source, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, data.title, data.date, data.time || null, data.endTime || null, data.endDate || null, data.allDay ? 1 : 0, data.description || null, data.location || null, data.category || "personal", data.color || null, data.recurrence || "none", data.recurrenceEnd || null, toJSON(data.linkedProfiles || []), toJSON(data.linkedDocuments || []), toJSON(data.tags || []), data.source || "manual", now);
    // Link to profiles
    for (const pId of (data.linkedProfiles || [])) {
      await this.linkProfileTo(pId, "event", id);
    }
    this.logActivity("event", `Created event: ${data.title} on ${data.date}${data.recurrence && data.recurrence !== "none" ? ` (${data.recurrence})` : ""}`);
    return (await this.getEvent(id))!;
  }
  async updateEvent(id: string, data: Partial<CalendarEvent>): Promise<CalendarEvent | undefined> {
    const existing = await this.getEvent(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    this.db.prepare("UPDATE events SET title=?, date=?, time=?, endTime=?, endDate=?, allDay=?, description=?, location=?, category=?, color=?, recurrence=?, recurrenceEnd=?, linkedProfiles=?, linkedDocuments=?, tags=?, source=? WHERE id=?").run(merged.title, merged.date, merged.time || null, merged.endTime || null, merged.endDate || null, merged.allDay ? 1 : 0, merged.description || null, merged.location || null, merged.category, merged.color || null, merged.recurrence, merged.recurrenceEnd || null, toJSON(merged.linkedProfiles), toJSON(merged.linkedDocuments), toJSON(merged.tags), merged.source, id);
    this.logActivity("event", `Updated event: ${merged.title}`);
    return this.getEvent(id);
  }
  async deleteEvent(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM events WHERE id=?").run(id).changes > 0;
  }

  // ============================================================
  // CALENDAR TIMELINE
  // ============================================================
  async getCalendarTimeline(startDate: string, endDate: string): Promise<CalendarTimelineItem[]> {
    const items: CalendarTimelineItem[] = [];
    const events = await this.getEvents();
    for (const ev of events) {
      const color = ev.color || EVENT_CATEGORY_COLORS[ev.category] || "#4F98A3";
      const baseDate = ev.date.slice(0, 10);
      if (baseDate >= startDate && baseDate <= endDate) {
        items.push({ id: `event-${ev.id}-${baseDate}`, type: "event", title: ev.title, date: baseDate, time: ev.time, endTime: ev.endTime, allDay: ev.allDay, color, category: ev.category, description: ev.description, location: ev.location, linkedProfiles: ev.linkedProfiles, sourceId: ev.id, meta: { recurrence: ev.recurrence, tags: ev.tags, source: ev.source } });
      }
      if (ev.recurrence !== "none") {
        const base = new Date(ev.date);
        for (let i = 1; i <= 90; i++) {
          const next = new Date(base);
          switch (ev.recurrence) {
            case "daily": next.setDate(next.getDate() + i); break;
            case "weekly": next.setDate(next.getDate() + i * 7); break;
            case "biweekly": next.setDate(next.getDate() + i * 14); break;
            case "monthly": next.setMonth(next.getMonth() + i); break;
            case "yearly": next.setFullYear(next.getFullYear() + i); break;
          }
          const nextStr = next.toISOString().slice(0, 10);
          if (nextStr > endDate) break;
          if (ev.recurrenceEnd && nextStr > ev.recurrenceEnd) break;
          if (nextStr >= startDate) {
            items.push({ id: `event-${ev.id}-${nextStr}`, type: "event", title: ev.title, date: nextStr, time: ev.time, endTime: ev.endTime, allDay: ev.allDay, color, category: ev.category, description: ev.description, location: ev.location, linkedProfiles: ev.linkedProfiles, sourceId: ev.id, meta: { recurrence: ev.recurrence, tags: ev.tags, source: ev.source } });
          }
        }
      }
    }

    const tasks = await this.getTasks();
    for (const task of tasks) {
      if (task.dueDate) {
        const d = task.dueDate.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({ id: `task-${task.id}`, type: "task", title: task.title, date: d, allDay: true, color: task.priority === "high" ? "#A13544" : task.priority === "medium" ? "#BB653B" : "#797876", category: "task", description: task.description, completed: task.status === "done", linkedProfiles: task.linkedProfiles, sourceId: task.id, meta: { priority: task.priority, status: task.status } });
        }
      }
    }

    const obligations = await this.getObligations();
    for (const ob of obligations) {
      const d = ob.nextDueDate.slice(0, 10);
      if (d >= startDate && d <= endDate) {
        items.push({ id: `obligation-${ob.id}`, type: "obligation", title: `${ob.name} — $${ob.amount}`, date: d, allDay: true, color: "#BB653B", category: ob.category, description: ob.autopay ? "Autopay enabled" : undefined, linkedProfiles: ob.linkedProfiles, sourceId: ob.id, meta: { amount: ob.amount, frequency: ob.frequency, autopay: ob.autopay } });
      }
    }

    const habits = await this.getHabits();
    for (const habit of habits) {
      for (const checkin of habit.checkins) {
        const d = checkin.date;
        if (d >= startDate && d <= endDate) {
          items.push({ id: `habit-${habit.id}-${d}`, type: "habit", title: habit.name, date: d, allDay: true, color: habit.color || "#4F98A3", completed: true, linkedProfiles: [], sourceId: habit.id, meta: { streak: habit.currentStreak, icon: habit.icon } });
        }
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
  async getDocuments(): Promise<Document[]> {
    return this.db.prepare("SELECT * FROM documents").all().map((r: any) => this.rowToDocument(r));
  }
  async getDocument(id: string): Promise<Document | undefined> {
    const r = this.db.prepare("SELECT * FROM documents WHERE id=?").get(id) as any;
    return r ? this.rowToDocument(r) : undefined;
  }
  async createDocument(data: any): Promise<Document> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO documents (id, name, type, mimeType, fileData, extractedData, linkedProfiles, tags, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, data.name, data.type || "other", data.mimeType || "image/jpeg", data.fileData || "", toJSON(data.extractedData || {}), toJSON(data.linkedProfiles || []), toJSON(data.tags || []), now);
    // Link to profiles
    for (const pid of (data.linkedProfiles || [])) {
      await this.linkProfileTo(pid, "document", id);
    }
    this.logActivity("document", `Stored document: ${data.name}`);
    return (await this.getDocument(id))!;
  }
  async updateDocument(id: string, data: Partial<Document>): Promise<Document | undefined> {
    const existing = await this.getDocument(id);
    if (!existing) return undefined;
    // Handle profile linking changes
    if (data.linkedProfiles) {
      for (const pid of existing.linkedProfiles) {
        if (!data.linkedProfiles.includes(pid)) {
          const profile = await this.getProfile(pid);
          if (profile) {
            const newDocs = profile.documents.filter(did => did !== id);
            this.db.prepare("UPDATE profiles SET documents=? WHERE id=?").run(toJSON(newDocs), pid);
          }
        }
      }
      for (const pid of data.linkedProfiles) {
        if (!existing.linkedProfiles.includes(pid)) {
          await this.linkProfileTo(pid, "document", id);
        }
      }
    }
    const merged = { ...existing, ...data };
    this.db.prepare("UPDATE documents SET name=?, type=?, mimeType=?, fileData=?, extractedData=?, linkedProfiles=?, tags=? WHERE id=?").run(merged.name, merged.type, merged.mimeType, merged.fileData, toJSON(merged.extractedData), toJSON(merged.linkedProfiles), toJSON(merged.tags), id);
    this.logActivity("document", `Updated document: ${merged.name}`);
    return this.getDocument(id);
  }
  async deleteDocument(id: string): Promise<boolean> {
    const doc = await this.getDocument(id);
    if (!doc) return false;
    for (const pid of doc.linkedProfiles) {
      const profile = await this.getProfile(pid);
      if (profile) {
        const newDocs = profile.documents.filter(did => did !== id);
        this.db.prepare("UPDATE profiles SET documents=? WHERE id=?").run(toJSON(newDocs), pid);
      }
    }
    this.logActivity("document", `Deleted document: ${doc.name}`);
    return this.db.prepare("DELETE FROM documents WHERE id=?").run(id).changes > 0;
  }
  async getDocumentsForProfile(profileId: string): Promise<Document[]> {
    const allDocs = await this.getDocuments();
    return allDocs.filter(d => d.linkedProfiles.includes(profileId));
  }

  // ============================================================
  // HABITS
  // ============================================================
  async getHabits(): Promise<Habit[]> {
    return this.db.prepare("SELECT * FROM habits").all().map((r: any) => this.rowToHabit(r));
  }
  async getHabit(id: string): Promise<Habit | undefined> {
    const r = this.db.prepare("SELECT * FROM habits WHERE id=?").get(id) as any;
    return r ? this.rowToHabit(r) : undefined;
  }
  async createHabit(data: InsertHabit): Promise<Habit> {
    const id = randomUUID();
    this.db.prepare("INSERT INTO habits (id, name, icon, color, frequency, targetDays, currentStreak, longestStreak, createdAt) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)").run(id, data.name, data.icon || null, data.color || null, data.frequency || "daily", data.targetDays ? toJSON(data.targetDays) : null, new Date().toISOString());
    this.logActivity("habit", `Created habit: ${data.name}`);
    return (await this.getHabit(id))!;
  }
  async checkinHabit(habitId: string, date?: string, value?: number, notes?: string): Promise<HabitCheckin | undefined> {
    const habit = await this.getHabit(habitId);
    if (!habit) return undefined;
    const checkinDate = date || new Date().toISOString().slice(0, 10);
    // Don't double-checkin same day
    const existing = habit.checkins.find(c => c.date === checkinDate);
    if (existing) return existing;
    const id = randomUUID();
    const ts = new Date().toISOString();
    this.db.prepare("INSERT INTO habit_checkins (id, habitId, date, value, notes, timestamp) VALUES (?, ?, ?, ?, ?, ?)").run(id, habitId, checkinDate, value ?? null, notes || null, ts);
    // Recalculate streaks
    const allCheckins = this.db.prepare("SELECT * FROM habit_checkins WHERE habitId=?").all(habitId) as any[];
    const { current, longest } = calculateStreak(allCheckins);
    this.db.prepare("UPDATE habits SET currentStreak=?, longestStreak=? WHERE id=?").run(current, Math.max(longest, habit.longestStreak), habitId);
    this.logActivity("habit", `Checked in: ${habit.name}${value ? ` (${value})` : ""}`);
    return { id, date: checkinDate, value, notes, timestamp: ts };
  }
  async updateHabit(id: string, data: Partial<Habit>): Promise<Habit | undefined> {
    const existing = await this.getHabit(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    this.db.prepare("UPDATE habits SET name=?, icon=?, color=?, frequency=?, targetDays=? WHERE id=?").run(merged.name, merged.icon || null, merged.color || null, merged.frequency, merged.targetDays ? toJSON(merged.targetDays) : null, id);
    this.logActivity("habit", `Updated habit: ${merged.name}`);
    return this.getHabit(id);
  }
  async deleteHabit(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM habits WHERE id=?").run(id).changes > 0;
  }

  // ============================================================
  // OBLIGATIONS
  // ============================================================
  async getObligations(): Promise<Obligation[]> {
    return this.db.prepare("SELECT * FROM obligations").all().map((r: any) => this.rowToObligation(r));
  }
  async getObligation(id: string): Promise<Obligation | undefined> {
    const r = this.db.prepare("SELECT * FROM obligations WHERE id=?").get(id) as any;
    return r ? this.rowToObligation(r) : undefined;
  }
  async createObligation(data: InsertObligation): Promise<Obligation> {
    const id = randomUUID();
    this.db.prepare("INSERT INTO obligations (id, name, amount, frequency, category, nextDueDate, autopay, linkedProfiles, notes, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)").run(id, data.name, data.amount, data.frequency || "monthly", data.category || "general", data.nextDueDate, data.autopay ? 1 : 0, data.notes || null, new Date().toISOString());
    this.logActivity("obligation", `Created obligation: ${data.name} ($${data.amount}/${data.frequency || "monthly"})`);

    // Auto-generate calendar event for obligation due date
    if (data.nextDueDate) {
      try {
        const freqMap: Record<string, string> = { weekly: "weekly", biweekly: "biweekly", monthly: "monthly", quarterly: "monthly", yearly: "yearly" };
        const recurrence = freqMap[data.frequency || "monthly"] || "monthly";
        await this.createEvent({
          title: `\u{1F4B3} ${data.name} \u2014 $${data.amount}`,
          date: data.nextDueDate.slice(0, 10),
          allDay: true,
          category: "finance",
          color: "#BB653B",
          recurrence: recurrence as any,
          linkedProfiles: [],
          linkedDocuments: [],
          tags: ["auto-generated", "obligation"],
          source: "ai",
          description: data.autopay ? "Autopay enabled" : `$${data.amount} due`,
        });
      } catch (e) {
        console.error(`Auto-event generation failed for obligation: ${data.name}`, e);
      }
    }

    return (await this.getObligation(id))!;
  }
  async updateObligation(id: string, data: Partial<Obligation>): Promise<Obligation | undefined> {
    const existing = await this.getObligation(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    this.db.prepare("UPDATE obligations SET name=?, amount=?, frequency=?, category=?, nextDueDate=?, autopay=?, linkedProfiles=?, notes=? WHERE id=?").run(merged.name, merged.amount, merged.frequency, merged.category, merged.nextDueDate, merged.autopay ? 1 : 0, toJSON(merged.linkedProfiles), merged.notes || null, id);
    this.logActivity("obligation", `Updated obligation: ${merged.name}`);
    return this.getObligation(id);
  }
  async payObligation(obligationId: string, amount: number, method?: string, confirmationNumber?: string): Promise<ObligationPayment | undefined> {
    const ob = await this.getObligation(obligationId);
    if (!ob) return undefined;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO obligation_payments (id, obligationId, amount, date, method, confirmationNumber) VALUES (?, ?, ?, ?, ?, ?)").run(id, obligationId, amount, now, method || null, confirmationNumber || null);
    // Advance next due date
    const nextDue = new Date(ob.nextDueDate);
    switch (ob.frequency) {
      case "weekly": nextDue.setDate(nextDue.getDate() + 7); break;
      case "biweekly": nextDue.setDate(nextDue.getDate() + 14); break;
      case "monthly": nextDue.setMonth(nextDue.getMonth() + 1); break;
      case "quarterly": nextDue.setMonth(nextDue.getMonth() + 3); break;
      case "yearly": nextDue.setFullYear(nextDue.getFullYear() + 1); break;
    }
    this.db.prepare("UPDATE obligations SET nextDueDate=? WHERE id=?").run(nextDue.toISOString().slice(0, 10), obligationId);
    this.logActivity("obligation", `Paid ${ob.name}: $${amount}`);
    return { id, amount, date: now, method, confirmationNumber };
  }
  async deleteObligation(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM obligations WHERE id=?").run(id).changes > 0;
  }

  // ============================================================
  // ARTIFACTS
  // ============================================================
  async getArtifacts(): Promise<Artifact[]> {
    return this.db.prepare("SELECT * FROM artifacts").all().map((r: any) => this.rowToArtifact(r));
  }
  async getArtifact(id: string): Promise<Artifact | undefined> {
    const r = this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as any;
    return r ? this.rowToArtifact(r) : undefined;
  }
  async createArtifact(data: InsertArtifact): Promise<Artifact> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const items: ChecklistItem[] = (data.items || []).map((item, i) => ({ id: randomUUID(), text: item.text, checked: item.checked ?? false, order: i }));
    this.db.prepare("INSERT INTO artifacts (id, type, title, content, items, tags, linkedProfiles, pinned, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)").run(id, data.type, data.title, data.content || "", toJSON(items), toJSON(data.tags || []), data.pinned ? 1 : 0, now, now);
    this.logActivity("artifact", `Created ${data.type}: ${data.title}`);
    return (await this.getArtifact(id))!;
  }
  async updateArtifact(id: string, data: Partial<Artifact>): Promise<Artifact | undefined> {
    const existing = await this.getArtifact(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data, updatedAt: new Date().toISOString() };
    this.db.prepare("UPDATE artifacts SET type=?, title=?, content=?, items=?, tags=?, linkedProfiles=?, pinned=?, updatedAt=? WHERE id=?").run(merged.type, merged.title, merged.content, toJSON(merged.items), toJSON(merged.tags), toJSON(merged.linkedProfiles), merged.pinned ? 1 : 0, merged.updatedAt, id);
    return this.getArtifact(id);
  }
  async toggleChecklistItem(artifactId: string, itemId: string): Promise<Artifact | undefined> {
    const a = await this.getArtifact(artifactId);
    if (!a) return undefined;
    const item = a.items.find(i => i.id === itemId);
    if (item) item.checked = !item.checked;
    const now = new Date().toISOString();
    this.db.prepare("UPDATE artifacts SET items=?, updatedAt=? WHERE id=?").run(toJSON(a.items), now, artifactId);
    return this.getArtifact(artifactId);
  }
  async deleteArtifact(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM artifacts WHERE id=?").run(id).changes > 0;
  }

  // ============================================================
  // JOURNAL
  // ============================================================
  async getJournalEntries(): Promise<JournalEntry[]> {
    return this.db.prepare("SELECT * FROM journal_entries ORDER BY createdAt DESC").all().map((r: any) => this.rowToJournalEntry(r));
  }
  async createJournalEntry(data: InsertJournalEntry): Promise<JournalEntry> {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO journal_entries (id, date, mood, content, tags, energy, gratitude, highlights, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, data.date || now.slice(0, 10), data.mood, data.content || "", toJSON(data.tags || []), data.energy ?? null, data.gratitude ? toJSON(data.gratitude) : null, data.highlights ? toJSON(data.highlights) : null, now);
    this.logActivity("journal", `Journal entry — mood: ${data.mood}`);
    return (await this.getJournalEntry(id))!;
  }
  private async getJournalEntry(id: string): Promise<JournalEntry | undefined> {
    const r = this.db.prepare("SELECT * FROM journal_entries WHERE id=?").get(id) as any;
    return r ? this.rowToJournalEntry(r) : undefined;
  }
  async updateJournalEntry(id: string, data: Partial<JournalEntry>): Promise<JournalEntry | undefined> {
    const existing = await this.getJournalEntry(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    this.db.prepare("UPDATE journal_entries SET date=?, mood=?, content=?, tags=?, energy=?, gratitude=?, highlights=? WHERE id=?").run(merged.date, merged.mood, merged.content, toJSON(merged.tags), merged.energy ?? null, merged.gratitude ? toJSON(merged.gratitude) : null, merged.highlights ? toJSON(merged.highlights) : null, id);
    this.logActivity("journal", `Updated journal entry — mood: ${merged.mood}`);
    return this.getJournalEntry(id);
  }
  async deleteJournalEntry(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM journal_entries WHERE id=?").run(id).changes > 0;
  }

  // ============================================================
  // MEMORY
  // ============================================================
  async getMemories(): Promise<MemoryItem[]> {
    return this.db.prepare("SELECT * FROM memories").all().map((r: any) => this.rowToMemory(r));
  }
  async saveMemory(data: InsertMemory): Promise<MemoryItem> {
    const now = new Date().toISOString();
    // Check if key exists — update
    const existing = this.db.prepare("SELECT * FROM memories WHERE key=?").get(data.key) as any;
    if (existing) {
      this.db.prepare("UPDATE memories SET value=?, category=?, updatedAt=? WHERE id=?").run(data.value, data.category || existing.category, now, existing.id);
      return this.rowToMemory({ ...existing, value: data.value, category: data.category || existing.category, updatedAt: now });
    }
    const id = randomUUID();
    this.db.prepare("INSERT INTO memories (id, key, value, category, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)").run(id, data.key, data.value, data.category || "general", now, now);
    return { id, key: data.key, value: data.value, category: data.category || "general", createdAt: now, updatedAt: now };
  }
  async recallMemory(query: string): Promise<MemoryItem[]> {
    const q = `%${query.toLowerCase()}%`;
    return this.db.prepare("SELECT * FROM memories WHERE LOWER(key) LIKE ? OR LOWER(value) LIKE ? OR LOWER(category) LIKE ?").all(q, q, q).map((r: any) => this.rowToMemory(r));
  }
  async deleteMemory(id: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM memories WHERE id=?").run(id).changes > 0;
  }

  async updateMemory(id: string, data: Partial<any>): Promise<any | undefined> {
    const existing = this.db.prepare("SELECT * FROM memories WHERE id=?").get(id) as any;
    if (!existing) return undefined;
    const value = data.value !== undefined ? data.value : existing.value;
    const category = data.category !== undefined ? data.category : existing.category;
    this.db.prepare("UPDATE memories SET value=?, category=? WHERE id=?").run(value, category, id);
    const r = this.db.prepare("SELECT * FROM memories WHERE id=?").get(id) as any;
    return r ? this.rowToMemory(r) : undefined;
  }

  // ============================================================
  // GOALS
  // ============================================================
  private rowToGoal(r: any): Goal {
    return {
      id: r.id, title: r.title, type: r.type, target: r.target, current: r.current,
      unit: r.unit, startValue: r.start_value ?? undefined, deadline: r.deadline || undefined,
      trackerId: r.tracker_id || undefined, habitId: r.habit_id || undefined,
      category: r.category || undefined, status: r.status,
      milestones: fromJSON(r.milestones, []),
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  async getGoals(): Promise<Goal[]> {
    const rows = this.db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all();
    const goals = rows.map((r: any) => this.rowToGoal(r));
    // Auto-compute progress for each goal
    for (const goal of goals) {
      if (goal.status === "active") {
        const computed = await this.computeGoalProgress(goal);
        goal.current = computed;
      }
    }
    return goals;
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    const r = this.db.prepare("SELECT * FROM goals WHERE id=?").get(id) as any;
    if (!r) return undefined;
    const goal = this.rowToGoal(r);
    if (goal.status === "active") {
      goal.current = await this.computeGoalProgress(goal);
    }
    return goal;
  }

  async createGoal(data: InsertGoal): Promise<Goal> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const milestones = (data.milestones || []).map(m => ({ ...m, reached: false }));
    this.db.prepare(
      "INSERT INTO goals (id, title, type, target, current, unit, start_value, deadline, tracker_id, habit_id, category, status, milestones, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      id, data.title, data.type, data.target, 0, data.unit,
      data.startValue ?? null, data.deadline || null,
      data.trackerId || null, data.habitId || null,
      data.category || null, "active", toJSON(milestones), now, now
    );
    this.logActivity("goal", `Created goal: ${data.title}`);
    return this.rowToGoal(this.db.prepare("SELECT * FROM goals WHERE id=?").get(id) as any);
  }

  async updateGoal(id: string, data: Partial<Goal>): Promise<Goal | undefined> {
    const existing = this.db.prepare("SELECT * FROM goals WHERE id=?").get(id) as any;
    if (!existing) return undefined;
    const now = new Date().toISOString();
    const updates: string[] = [];
    const params: any[] = [];
    if (data.title !== undefined) { updates.push("title=?"); params.push(data.title); }
    if (data.type !== undefined) { updates.push("type=?"); params.push(data.type); }
    if (data.target !== undefined) { updates.push("target=?"); params.push(data.target); }
    if (data.current !== undefined) { updates.push("current=?"); params.push(data.current); }
    if (data.unit !== undefined) { updates.push("unit=?"); params.push(data.unit); }
    if (data.startValue !== undefined) { updates.push("start_value=?"); params.push(data.startValue); }
    if (data.deadline !== undefined) { updates.push("deadline=?"); params.push(data.deadline); }
    if (data.trackerId !== undefined) { updates.push("tracker_id=?"); params.push(data.trackerId); }
    if (data.habitId !== undefined) { updates.push("habit_id=?"); params.push(data.habitId); }
    if (data.category !== undefined) { updates.push("category=?"); params.push(data.category); }
    if (data.status !== undefined) { updates.push("status=?"); params.push(data.status); }
    if (data.milestones !== undefined) { updates.push("milestones=?"); params.push(toJSON(data.milestones)); }
    updates.push("updated_at=?"); params.push(now);
    params.push(id);
    this.db.prepare(`UPDATE goals SET ${updates.join(", ")} WHERE id=?`).run(...params);
    this.logActivity("goal", `Updated goal: ${data.title || existing.title}`);
    return this.getGoal(id);
  }

  async deleteGoal(id: string): Promise<boolean> {
    const goal = this.db.prepare("SELECT title FROM goals WHERE id=?").get(id) as any;
    const deleted = this.db.prepare("DELETE FROM goals WHERE id=?").run(id).changes > 0;
    if (deleted && goal) this.logActivity("goal", `Deleted goal: ${goal.title}`);
    return deleted;
  }

  /**
   * Auto-compute current progress for a goal based on linked data.
   */
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
        const val = parseFloat(latest.values.weight || latest.values.value || "0");
        return val || goal.current;
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
        // Sum distance entries this month/quarter
        const entries = tracker.entries.filter(e => {
          const d = new Date(e.timestamp);
          return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
        });
        return entries.reduce((sum, e) => {
          const dist = parseFloat(e.values.distance || e.computed?.distanceMiles || "0");
          return sum + dist;
        }, 0);
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
        const monthlyInCategory = expenses.filter(e => {
          const d = new Date(e.date);
          return d.getMonth() === thisMonth && d.getFullYear() === thisYear &&
            e.category.toLowerCase() === (goal.category || "").toLowerCase();
        });
        return monthlyInCategory.reduce((sum, e) => sum + e.amount, 0);
      }

      case "tracker_target": {
        if (!goal.trackerId) return goal.current;
        const tracker = await this.getTracker(goal.trackerId);
        if (!tracker || tracker.entries.length === 0) return goal.current;
        const latest = tracker.entries[tracker.entries.length - 1];
        // Use the primary field or first numeric value
        const primary = tracker.fields.find(f => f.isPrimary) || tracker.fields.find(f => f.type === "number");
        if (primary) {
          return parseFloat(latest.values[primary.name] || "0") || goal.current;
        }
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
    return this.db.prepare("SELECT * FROM domains").all().map((r: any) => this.rowToDomain(r));
  }
  async createDomain(data: InsertDomain): Promise<Domain> {
    const id = randomUUID();
    const slug = data.name.toLowerCase().replace(/\s+/g, "-");
    this.db.prepare("INSERT INTO domains (id, name, slug, icon, color, description, fields, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, data.name, slug, data.icon || null, data.color || null, data.description || null, toJSON(data.fields || []), new Date().toISOString());
    this.logActivity("domain", `Created domain: ${data.name}`);
    return (await this.getDomain(id))!;
  }
  async updateDomain(id: string, data: Partial<any>): Promise<any | undefined> {
    const existing = await this.getDomain(id);
    if (!existing) return undefined;
    const name = data.name !== undefined ? data.name : existing.name;
    const description = data.description !== undefined ? data.description : existing.description;
    const fields = data.fields !== undefined ? data.fields : existing.fields;
    this.db.prepare("UPDATE domains SET name=?, description=?, fields=? WHERE id=?").run(name, description || null, toJSON(fields || []), id);
    return await this.getDomain(id);
  }
  async deleteDomain(id: string): Promise<boolean> {
    this.db.prepare("DELETE FROM domain_entries WHERE domainId=?").run(id);
    return this.db.prepare("DELETE FROM domains WHERE id=?").run(id).changes > 0;
  }
  private async getDomain(id: string): Promise<Domain | undefined> {
    const r = this.db.prepare("SELECT * FROM domains WHERE id=?").get(id) as any;
    return r ? this.rowToDomain(r) : undefined;
  }
  async getDomainEntries(domainId: string): Promise<DomainEntry[]> {
    return this.db.prepare("SELECT * FROM domain_entries WHERE domainId=?").all(domainId).map((r: any) => this.rowToDomainEntry(r));
  }
  async addDomainEntry(domainId: string, values: Record<string, any>, tags?: string[], notes?: string): Promise<DomainEntry | undefined> {
    const domain = await this.getDomain(domainId);
    if (!domain) return undefined;
    const id = randomUUID();
    this.db.prepare('INSERT INTO domain_entries (id, domainId, "values", tags, notes, createdAt) VALUES (?, ?, ?, ?, ?, ?)').run(id, domainId, toJSON(values), toJSON(tags || []), notes || null, new Date().toISOString());
    this.logActivity("domain", `Added entry to ${domain.name}`);
    const r = this.db.prepare("SELECT * FROM domain_entries WHERE id=?").get(id) as any;
    return r ? this.rowToDomainEntry(r) : undefined;
  }

  // ============================================================
  // DASHBOARD
  // ============================================================
  async getStats(): Promise<DashboardStats> {
    const tasks = await this.getTasks();
    const expenses = await this.getExpenses();
    const trackers = await this.getTrackers();
    const habits = await this.getHabits();
    const obligations = await this.getObligations();
    const journalEntries = await this.getJournalEntries();
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    const monthlyExpenses = expenses.filter(e => { const dd = new Date(e.date); return dd.getMonth() === thisMonth && dd.getFullYear() === thisYear; });
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    let weeklyEntries = 0;
    for (const t of trackers) weeklyEntries += t.entries.filter(e => new Date(e.timestamp) > weekAgo).length;

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

    const sevenDaysOut = new Date(now.getTime() + 7 * 86400000);
    const upcomingObs = obligations.filter(o => { const due = new Date(o.nextDueDate); return due >= now && due <= sevenDaysOut; });
    const monthlyObTotal = obligations.filter(o => o.frequency === "monthly" || o.frequency === "biweekly" || o.frequency === "weekly").reduce((s, o) => s + o.amount, 0);

    let journalStreak = 0;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 0; i < 30; i++) {
      const dayStr = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
      if (journalEntries.some(j => j.date === dayStr)) journalStreak++; else if (i > 0) break;
    }

    const recentJournal = [...journalEntries].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const currentMood = recentJournal.length > 0 ? recentJournal[0].mood as MoodLevel : undefined;

    const profileCount = (this.db.prepare("SELECT COUNT(*) as c FROM profiles").get() as any).c;
    const trackerCount = (this.db.prepare("SELECT COUNT(*) as c FROM trackers").get() as any).c;
    const eventCount = (this.db.prepare("SELECT COUNT(*) as c FROM events").get() as any).c;
    const artifactCount = (this.db.prepare("SELECT COUNT(*) as c FROM artifacts").get() as any).c;
    const memoryCount = (this.db.prepare("SELECT COUNT(*) as c FROM memories").get() as any).c;

    const recentActivity = this.db.prepare("SELECT type, description, timestamp FROM activity_log ORDER BY id DESC LIMIT 10").all() as any[];

    return {
      totalProfiles: profileCount,
      totalTrackers: trackerCount,
      totalTasks: tasks.length,
      activeTasks: tasks.filter(t => t.status !== "done").length,
      totalExpenses: expenses.reduce((sum, e) => sum + e.amount, 0),
      totalEvents: eventCount,
      monthlySpend: monthlyExpenses.reduce((sum, e) => sum + e.amount, 0),
      weeklyEntries,
      streaks,
      recentActivity,
      totalHabits: habits.length,
      habitCompletionRate,
      totalObligations: obligations.length,
      upcomingObligations: upcomingObs.length,
      monthlyObligationTotal: monthlyObTotal,
      journalStreak,
      currentMood,
      totalArtifacts: artifactCount,
      totalMemories: memoryCount,
    };
  }

  // ============================================================
  // ENHANCED DASHBOARD
  // ============================================================
  async getDashboardEnhanced(): Promise<any> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    const documents = await this.getDocuments();
    const expiringDocs: any[] = [];
    for (const doc of documents) {
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

    const trackers = await this.getTrackers();
    const healthCategories = ['health', 'fitness', 'weight', 'sleep', 'blood_pressure', 'running', 'exercise', 'nutrition', 'wellness'];
    const healthTrackers = trackers.filter(t => healthCategories.some(c => t.category.toLowerCase().includes(c) || t.name.toLowerCase().includes(c)));
    const healthSnapshot: any[] = [];
    for (const t of healthTrackers) {
      const recent = t.entries.slice(-7);
      const primaryField = t.fields.find(f => f.isPrimary) || t.fields[0];
      if (!primaryField || recent.length === 0) continue;
      const values = recent.map(e => Number(e.values[primaryField.name])).filter(v => !isNaN(v));
      if (values.length === 0) continue;
      const latest = values[values.length - 1];
      const avg = values.reduce((s, v) => s + v, 0) / values.length;
      const trend = values.length >= 2 ? (values[values.length - 1] - values[0]) : 0;
      healthSnapshot.push({ trackerId: t.id, name: t.name, category: t.category, unit: primaryField.unit || t.unit || '', latestValue: latest, average: Math.round(avg * 10) / 10, trend: trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat', trendValue: Math.round(Math.abs(trend) * 10) / 10, entryCount: recent.length, lastEntry: recent[recent.length - 1]?.timestamp });
    }

    const expenses = await this.getExpenses();
    const monthlyExpenses = expenses.filter(e => { const d = new Date(e.date); return d.getMonth() === thisMonth && d.getFullYear() === thisYear; });
    const spendByCategory: Record<string, number> = {};
    for (const e of monthlyExpenses) spendByCategory[e.category] = (spendByCategory[e.category] || 0) + e.amount;
    const totalMonthlySpend = monthlyExpenses.reduce((s, e) => s + e.amount, 0);

    const lastMonthDate = new Date(thisYear, thisMonth - 1, 1);
    const lastMonthExpenses = expenses.filter(e => { const d = new Date(e.date); return d.getMonth() === lastMonthDate.getMonth() && d.getFullYear() === lastMonthDate.getFullYear(); });
    const lastMonthTotal = lastMonthExpenses.reduce((s, e) => s + e.amount, 0);

    const obligations = await this.getObligations();
    const upcomingBills = obligations.filter(o => { const due = new Date(o.nextDueDate); const daysUntil = Math.ceil((due.getTime() - now.getTime()) / 86400000); return daysUntil <= 30; }).sort((a, b) => new Date(a.nextDueDate).getTime() - new Date(b.nextDueDate).getTime()).map(o => ({ id: o.id, name: o.name, amount: o.amount, dueDate: o.nextDueDate, daysUntil: Math.ceil((new Date(o.nextDueDate).getTime() - now.getTime()) / 86400000), autopay: o.autopay, category: o.category }));

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

    const tasks = await this.getTasks();
    const overdueTasks = tasks.filter(t => { if (t.status === 'done' || !t.dueDate) return false; return new Date(t.dueDate) < now; }).map(t => ({ id: t.id, title: t.title, dueDate: t.dueDate!, priority: t.priority }));

    const events = await this.getEvents();
    const todaysEvents = events.filter(e => e.date === today).map(e => ({ id: e.id, title: e.title, time: e.time, endTime: e.endTime, category: e.category, location: e.location }));

    return {
      expiringDocuments: expiringDocs.filter(d => d.status !== 'ok'),
      healthSnapshot,
      financeSnapshot: { totalMonthlySpend, lastMonthTotal, spendTrend: lastMonthTotal > 0 ? Math.round(((totalMonthlySpend - lastMonthTotal) / lastMonthTotal) * 100) : 0, spendByCategory, upcomingBills, monthlyObligationTotal: Math.round(monthlyObligationTotal) },
      overdueTasks,
      todaysEvents,
      totalDocuments: documents.length,
    };
  }

  // ============================================================
  // INSIGHTS
  // ============================================================
  async getInsights(): Promise<Insight[]> {
    const profiles = await this.getProfiles();
    const trackers = await this.getTrackers();
    const tasks = await this.getTasks();
    const expenses = await this.getExpenses();
    const habits = await this.getHabits();
    const obligations = await this.getObligations();
    const journal = await this.getJournalEntries();
    return generateInsights(profiles, trackers, tasks, expenses, habits, obligations, journal);
  }

  // ============================================================
  // ENTITY LINKS
  // ============================================================
  private rowToEntityLink(r: any): EntityLink {
    return {
      id: r.id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      targetType: r.target_type,
      targetId: r.target_id,
      relationship: r.relationship,
      confidence: r.confidence,
      createdAt: r.created_at,
    };
  }

  async getEntityLinks(entityType: string, entityId: string): Promise<EntityLink[]> {
    const rows = this.db.prepare(
      `SELECT * FROM entity_links WHERE (source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?) ORDER BY created_at DESC`
    ).all(entityType, entityId, entityType, entityId) as any[];
    return rows.map(r => this.rowToEntityLink(r));
  }

  async createEntityLink(data: InsertEntityLink): Promise<EntityLink> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const confidence = data.confidence ?? 1;
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO entity_links (id, source_type, source_id, target_type, target_id, relationship, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, data.sourceType, data.sourceId, data.targetType, data.targetId, data.relationship, confidence, now);
    } catch {
      // Duplicate — find existing
      const existing = this.db.prepare(
        `SELECT * FROM entity_links WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?`
      ).get(data.sourceType, data.sourceId, data.targetType, data.targetId) as any;
      if (existing) return this.rowToEntityLink(existing);
    }
    // Return what we inserted (or re-fetch in case INSERT OR IGNORE skipped)
    const row = this.db.prepare(`SELECT * FROM entity_links WHERE id = ?`).get(id) as any;
    if (row) return this.rowToEntityLink(row);
    // If INSERT OR IGNORE skipped, fetch the existing one
    const existing = this.db.prepare(
      `SELECT * FROM entity_links WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?`
    ).get(data.sourceType, data.sourceId, data.targetType, data.targetId) as any;
    return this.rowToEntityLink(existing);
  }

  async deleteEntityLink(id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM entity_links WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  async getRelatedEntities(entityType: string, entityId: string): Promise<any[]> {
    const links = await this.getEntityLinks(entityType, entityId);
    const related: any[] = [];

    for (const link of links) {
      // Determine which side is the "other" entity
      const otherType = (link.sourceType === entityType && link.sourceId === entityId)
        ? link.targetType : link.sourceType;
      const otherId = (link.sourceType === entityType && link.sourceId === entityId)
        ? link.targetId : link.sourceId;

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
        // Strip fileData from documents to keep payloads small
        if (otherType === "document" && entity.fileData) {
          const { fileData, ...rest } = entity;
          entity = rest;
        }
        related.push({
          ...entity,
          _type: otherType,
          _linkId: link.id,
          _relationship: link.relationship,
          _confidence: link.confidence,
        });
      }
    }

    return related;
  }

  // ============================================================
  // SEARCH
  // ============================================================
  async search(query: string): Promise<any[]> {
    const q = query.toLowerCase();
    const results: any[] = [];
    const profiles = await this.getProfiles();
    for (const p of profiles) {
      if (p.name.toLowerCase().includes(q) || p.type.includes(q) || p.tags.some(t => t.includes(q))) results.push({ ...p, _type: "profile" });
    }
    const trackers = await this.getTrackers();
    for (const t of trackers) {
      if (t.name.toLowerCase().includes(q) || t.category.includes(q)) results.push({ ...t, _type: "tracker" });
    }
    const tasks = await this.getTasks();
    for (const t of tasks) {
      if (t.title.toLowerCase().includes(q) || t.tags.some(tag => tag.includes(q))) results.push({ ...t, _type: "task" });
    }
    const expenses = await this.getExpenses();
    for (const e of expenses) {
      if (e.description.toLowerCase().includes(q) || e.category.includes(q) || (e.vendor && e.vendor.toLowerCase().includes(q))) results.push({ ...e, _type: "expense" });
    }
    const habits = await this.getHabits();
    for (const h of habits) {
      if (h.name.toLowerCase().includes(q)) results.push({ ...h, _type: "habit" });
    }
    const obligations = await this.getObligations();
    for (const o of obligations) {
      if (o.name.toLowerCase().includes(q) || o.category.includes(q)) results.push({ ...o, _type: "obligation" });
    }
    const artifacts = await this.getArtifacts();
    for (const a of artifacts) {
      if (a.title.toLowerCase().includes(q) || a.content.toLowerCase().includes(q) || a.tags.some(t => t.includes(q))) results.push({ ...a, _type: "artifact" });
    }
    const journal = await this.getJournalEntries();
    for (const j of journal) {
      if (j.content.toLowerCase().includes(q) || j.tags.some(t => t.includes(q))) results.push({ ...j, _type: "journal" });
    }
    const memories = await this.getMemories();
    for (const m of memories) {
      if (m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q)) results.push({ ...m, _type: "memory" });
    }

    // Enhance with entity links: for each direct match, check for related entities not already in results
    const existingIds = new Set(results.map((r: any) => r.id));
    for (const result of [...results]) {
      const type = result._type;
      if (!type || !result.id) continue;
      try {
        const links = await this.getEntityLinks(type, result.id);
        for (const link of links) {
          const otherType = (link.sourceType === type && link.sourceId === result.id) ? link.targetType : link.sourceType;
          const otherId = (link.sourceType === type && link.sourceId === result.id) ? link.targetId : link.sourceId;
          if (existingIds.has(otherId)) continue;
          existingIds.add(otherId);
          let entity: any = null;
          switch (otherType) {
            case "profile": entity = await this.getProfile(otherId); break;
            case "task": entity = await this.getTask(otherId); break;
            case "event": entity = await this.getEvent(otherId); break;
            case "habit": entity = await this.getHabit(otherId); break;
            case "obligation": entity = await this.getObligation(otherId); break;
            case "tracker": entity = await this.getTracker(otherId); break;
            case "expense": {
              const exps = await this.getExpenses();
              entity = exps.find(e => e.id === otherId) || null;
              break;
            }
            case "document": {
              const doc = await this.getDocument(otherId);
              if (doc) { const { fileData, ...rest } = doc; entity = rest; }
              break;
            }
          }
          if (entity) {
            results.push({ ...entity, _type: otherType, _related: true, _relationship: link.relationship, _confidence: link.confidence });
          }
        }
      } catch { /* skip on error */ }
    }

    return results;
  }

  // ============================================================
  // PREFERENCES
  // ============================================================
  async getPreference(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM preferences WHERE key = ?").get(key) as any;
    return row ? row.value : null;
  }

  async setPreference(key: string, value: string): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)").run(key, value);
  }

  // ============================================================
  // SEED DATA
  // ============================================================
  private seedData() {
    return;
  }
}
