import { createClient, SupabaseClient } from "@supabase/supabase-js";
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
// SUPABASE STORAGE IMPLEMENTATION
// ============================================================

export class SupabaseStorage implements IStorage {
  private supabase: SupabaseClient;
  private userId: string;

  constructor(supabaseUrl: string, supabaseServiceKey: string, userId: string) {
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
    this.userId = userId;
  }

  setUserId(userId: string) { this.userId = userId; }

  private logActivity(_type: string, _description: string) {
    // No-op for Supabase — activity logging is SQLite-specific
  }

  // ---- ROW → OBJECT helpers ----
  // PostgreSQL uses snake_case; TypeScript uses camelCase.
  // JSONB columns are already parsed objects from Supabase.

  private rowToProfile(r: any): Profile {
    return {
      id: r.id, type: r.type, name: r.name, avatar: r.avatar || undefined,
      fields: r.fields || {}, tags: r.tags || [], notes: r.notes || "",
      documents: r.documents || [], linkedTrackers: r.linked_trackers || [],
      linkedExpenses: r.linked_expenses || [], linkedTasks: r.linked_tasks || [],
      linkedEvents: r.linked_events || [], createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private rowToTrackerEntry(r: any): TrackerEntry {
    return {
      id: r.id, values: r.entry_values || {}, computed: r.computed || {},
      notes: r.notes || undefined, mood: r.mood || undefined,
      tags: r.tags || undefined, timestamp: r.timestamp,
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
      id: r.id, amount: r.amount, category: r.category, description: r.description,
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
      fileData: r.file_data || "", extractedData: r.extracted_data || {},
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
      currentStreak: r.current_streak || 0, longestStreak: r.longest_streak || 0,
      checkins, createdAt: r.created_at,
    };
  }

  private rowToPayment(r: any): ObligationPayment {
    return {
      id: r.id, amount: r.amount, date: r.date,
      method: r.method || undefined, confirmationNumber: r.confirmation_number || undefined,
    };
  }

  private rowToObligation(r: any, payments: ObligationPayment[]): Obligation {
    return {
      id: r.id, name: r.name, amount: r.amount, frequency: r.frequency,
      category: r.category, nextDueDate: r.next_due_date, autopay: r.autopay || false,
      linkedProfiles: r.linked_profiles || [], payments,
      notes: r.notes || undefined, createdAt: r.created_at,
    };
  }

  private rowToArtifact(r: any): Artifact {
    return {
      id: r.id, type: r.type, title: r.title, content: r.content || "",
      items: r.items || [], tags: r.tags || [], linkedProfiles: r.linked_profiles || [],
      pinned: r.pinned || false, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  private rowToJournalEntry(r: any): JournalEntry {
    return {
      id: r.id, date: r.date, mood: r.mood as MoodLevel, content: r.content || "",
      tags: r.tags || [], energy: r.energy ?? undefined,
      gratitude: r.gratitude || undefined, highlights: r.highlights || undefined,
      createdAt: r.created_at,
    };
  }

  private rowToMemory(r: any): MemoryItem {
    return {
      id: r.id, key: r.key, value: r.value, category: r.category,
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
      milestones: r.milestones || [], createdAt: r.created_at, updatedAt: r.updated_at,
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
    const { data, error } = await this.supabase.from("profiles").select("*").eq("user_id", this.userId);
    if (error) throw error;
    return (data || []).map(r => this.rowToProfile(r));
  }

  async getProfile(id: string): Promise<Profile | undefined> {
    const { data, error } = await this.supabase.from("profiles").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    return this.rowToProfile(data);
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
    const { error } = await this.supabase.from("profiles").insert({
      id, user_id: this.userId, type: data.type, name: data.name,
      fields: data.fields || {}, tags: data.tags || [], notes: data.notes || "",
      documents: [], linked_trackers: [], linked_expenses: [],
      linked_tasks: [], linked_events: [], created_at: now, updated_at: now,
    });
    if (error) throw error;
    this.logActivity("profile", `Created profile: ${data.name}`);

    // Auto-generate calendar events from profile date fields
    await this.autoGenerateProfileEvents(id, data.type, data.name, data.fields || {});

    return (await this.getProfile(id))!;
  }

  /** Auto-create calendar events for profile date fields */
  private async autoGenerateProfileEvents(profileId: string, type: string, name: string, fields: Record<string, any>): Promise<void> {
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
    const merged = { ...existing, ...data };
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("profiles").update({
      type: merged.type, name: merged.name, avatar: merged.avatar || null,
      fields: merged.fields, tags: merged.tags, notes: merged.notes,
      documents: merged.documents, linked_trackers: merged.linkedTrackers,
      linked_expenses: merged.linkedExpenses, linked_tasks: merged.linkedTasks,
      linked_events: merged.linkedEvents, updated_at: now,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    return this.getProfile(id);
  }

  async deleteProfile(id: string): Promise<boolean> {
    const profile = await this.getProfile(id);
    if (!profile) return false;
    for (const docId of profile.documents) {
      const doc = await this.getDocument(docId);
      if (doc) {
        const newLinked = doc.linkedProfiles.filter(pid => pid !== id);
        await this.supabase.from("documents").update({ linked_profiles: newLinked }).eq("id", docId).eq("user_id", this.userId);
      }
    }
    const { error } = await this.supabase.from("profiles").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  async linkProfileTo(profileId: string, entityType: string, entityId: string): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) return;
    let field: string | undefined;
    let snakeField: string | undefined;
    switch (entityType) {
      case "tracker":
        if (!profile.linkedTrackers.includes(entityId)) { profile.linkedTrackers.push(entityId); field = "linkedTrackers"; snakeField = "linked_trackers"; }
        break;
      case "expense":
        if (!profile.linkedExpenses.includes(entityId)) { profile.linkedExpenses.push(entityId); field = "linkedExpenses"; snakeField = "linked_expenses"; }
        break;
      case "task":
        if (!profile.linkedTasks.includes(entityId)) { profile.linkedTasks.push(entityId); field = "linkedTasks"; snakeField = "linked_tasks"; }
        break;
      case "event":
        if (!profile.linkedEvents.includes(entityId)) { profile.linkedEvents.push(entityId); field = "linkedEvents"; snakeField = "linked_events"; }
        break;
      case "document":
        if (!profile.documents.includes(entityId)) { profile.documents.push(entityId); field = "documents"; snakeField = "documents"; }
        break;
    }
    if (field && snakeField) {
      await this.supabase.from("profiles").update({ [snakeField]: (profile as any)[field] }).eq("id", profileId).eq("user_id", this.userId);
    }
  }

  async unlinkProfileFrom(profileId: string, entityType: string, entityId: string): Promise<void> {
    const profile = await this.getProfile(profileId);
    if (!profile) return;
    let field: string | undefined;
    let snakeField: string | undefined;
    switch (entityType) {
      case "tracker":
        profile.linkedTrackers = profile.linkedTrackers.filter(id => id !== entityId);
        field = "linkedTrackers"; snakeField = "linked_trackers";
        break;
      case "expense":
        profile.linkedExpenses = profile.linkedExpenses.filter(id => id !== entityId);
        field = "linkedExpenses"; snakeField = "linked_expenses";
        break;
      case "task":
        profile.linkedTasks = profile.linkedTasks.filter(id => id !== entityId);
        field = "linkedTasks"; snakeField = "linked_tasks";
        break;
      case "event":
        profile.linkedEvents = profile.linkedEvents.filter(id => id !== entityId);
        field = "linkedEvents"; snakeField = "linked_events";
        break;
      case "document":
        profile.documents = profile.documents.filter(id => id !== entityId);
        field = "documents"; snakeField = "documents";
        break;
    }
    if (field && snakeField) {
      await this.supabase.from("profiles").update({ [snakeField]: (profile as any)[field] }).eq("id", profileId).eq("user_id", this.userId);
      // Also remove from entity_links table
      await this.supabase.from("entity_links").delete()
        .eq("user_id", this.userId)
        .eq("source_type", "profile")
        .eq("source_id", profileId)
        .eq("target_type", entityType)
        .eq("target_id", entityId);
    }
  }

  // Get the "self" profile (type="self") for this user — used for auto-linking
  async getSelfProfile(): Promise<Profile | undefined> {
    const { data, error } = await this.supabase.from("profiles").select("*").eq("user_id", this.userId).eq("type", "self").limit(1).single();
    if (error || !data) return undefined;
    return this.rowToProfile(data);
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
  async getTrackers(): Promise<Tracker[]> {
    const { data, error } = await this.supabase.from("trackers").select("*").eq("user_id", this.userId);
    if (error) throw error;
    const trackers: Tracker[] = [];
    for (const r of data || []) {
      const { data: entries } = await this.supabase.from("tracker_entries").select("*").eq("tracker_id", r.id).eq("user_id", this.userId).order("timestamp", { ascending: true });
      trackers.push(this.rowToTracker(r, (entries || []).map(e => this.rowToTrackerEntry(e))));
    }
    return trackers;
  }

  async getTracker(id: string): Promise<Tracker | undefined> {
    const { data, error } = await this.supabase.from("trackers").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    const { data: entries } = await this.supabase.from("tracker_entries").select("*").eq("tracker_id", id).eq("user_id", this.userId).order("timestamp", { ascending: true });
    return this.rowToTracker(data, (entries || []).map(e => this.rowToTrackerEntry(e)));
  }

  async createTracker(data: InsertTracker): Promise<Tracker> {
    // Dedup: check for existing tracker with same name (case-insensitive)
    const existing = await this.getTrackers();
    const dup = existing.find(t => t.name.toLowerCase() === data.name.toLowerCase());
    if (dup) return dup;

    const id = randomUUID();
    const now = new Date().toISOString();
    // Auto-link to self profile if no profiles are being set
    let initialLinkedProfiles: string[] = [];
    const selfProfile = await this.getSelfProfile();
    if (selfProfile) {
      initialLinkedProfiles = [selfProfile.id];
    }
    const { error } = await this.supabase.from("trackers").insert({
      id, user_id: this.userId, name: data.name, category: data.category || "custom",
      unit: data.unit || null, icon: data.icon || null, fields: data.fields || [],
      linked_profiles: initialLinkedProfiles, created_at: now,
    });
    if (error) throw error;
    // Also update the self profile's linkedTrackers
    if (selfProfile) {
      await this.linkProfileTo(selfProfile.id, "tracker", id);
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

    const computed = { ...computeSecondaryData(tracker.name, tracker.category, values), validated };
    const id = randomUUID();
    const ts = new Date().toISOString();
    const { error } = await this.supabase.from("tracker_entries").insert({
      id, user_id: this.userId, tracker_id: data.trackerId,
      entry_values: values, computed, notes: data.notes || null,
      mood: data.mood || null, tags: data.tags || null, timestamp: ts,
    });
    if (error) throw error;
    this.logActivity("tracker", `Logged ${tracker.name}`);
    return { id, values, computed, notes: data.notes, mood: data.mood as any, tags: data.tags, timestamp: ts };
  }

  async deleteTrackerEntry(trackerId: string, entryId: string): Promise<boolean> {
    const { error } = await this.supabase.from("tracker_entries").delete()
      .eq("id", entryId).eq("tracker_id", trackerId).eq("user_id", this.userId);
    return !error;
  }

  async deleteTracker(id: string): Promise<boolean> {
    // Delete entries first, then the tracker
    await this.supabase.from("tracker_entries").delete().eq("tracker_id", id).eq("user_id", this.userId);
    const { error } = await this.supabase.from("trackers").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // TASKS
  // ============================================================
  async getTasks(): Promise<Task[]> {
    const { data, error } = await this.supabase.from("tasks").select("*").eq("user_id", this.userId);
    if (error) throw error;
    return (data || []).map(r => this.rowToTask(r));
  }

  async getTask(id: string): Promise<Task | undefined> {
    const { data, error } = await this.supabase.from("tasks").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    return this.rowToTask(data);
  }

  async createTask(data: InsertTask): Promise<Task> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("tasks").insert({
      id, user_id: this.userId, title: data.title, description: data.description || null,
      status: "todo", priority: data.priority || "medium", due_date: data.dueDate || null,
      linked_profiles: [], tags: data.tags || [], created_at: now,
    });
    if (error) throw error;
    this.logActivity("task", `Created task: ${data.title}`);

    // Auto-generate calendar event for tasks with due dates
    // Tasks with due dates are shown in the calendar view automatically — no separate event needed.

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
    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("tasks").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // EXPENSES
  // ============================================================
  async getExpenses(): Promise<Expense[]> {
    const { data, error } = await this.supabase.from("expenses").select("*").eq("user_id", this.userId);
    if (error) throw error;
    return (data || []).map(r => this.rowToExpense(r));
  }

  private async getExpense(id: string): Promise<Expense | undefined> {
    const { data, error } = await this.supabase.from("expenses").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    return this.rowToExpense(data);
  }

  async createExpense(data: InsertExpense): Promise<Expense> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("expenses").insert({
      id, user_id: this.userId, amount: data.amount, category: data.category || "general",
      description: data.description, vendor: data.vendor || null,
      is_recurring: data.isRecurring || false, linked_profiles: [],
      tags: data.tags || [], date: data.date || now, created_at: now,
    });
    if (error) throw error;
    this.logActivity("expense", `${data.description} - $${data.amount}`);
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
    return this.getExpense(id);
  }

  async deleteExpense(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("expenses").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // EVENTS
  // ============================================================
  async getEvents(): Promise<CalendarEvent[]> {
    const { data, error } = await this.supabase.from("events").select("*").eq("user_id", this.userId);
    if (error) throw error;
    return (data || []).map(r => this.rowToEvent(r));
  }

  async getEvent(id: string): Promise<CalendarEvent | undefined> {
    const { data, error } = await this.supabase.from("events").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    return this.rowToEvent(data);
  }

  async createEvent(data: InsertEvent): Promise<CalendarEvent> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("events").insert({
      id, user_id: this.userId, title: data.title, date: data.date,
      time: data.time || null, end_time: data.endTime || null, end_date: data.endDate || null,
      all_day: data.allDay || false, description: data.description || null,
      location: data.location || null, category: data.category || "personal",
      color: data.color || null, recurrence: data.recurrence || "none",
      recurrence_end: data.recurrenceEnd || null,
      linked_profiles: data.linkedProfiles || [], linked_documents: data.linkedDocuments || [],
      tags: data.tags || [], source: data.source || "manual", created_at: now,
    });
    if (error) throw error;
    for (const pId of (data.linkedProfiles || [])) {
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
    return this.getEvent(id);
  }

  async deleteEvent(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("events").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
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
      // Show the next due date
      const baseDate = ob.nextDueDate.slice(0, 10);
      if (baseDate >= startDate && baseDate <= endDate) {
        items.push({ id: `obligation-${ob.id}-${baseDate}`, type: "obligation", title: `${ob.name} — $${ob.amount}`, date: baseDate, allDay: true, color: "#BB653B", category: ob.category, description: ob.autopay ? "Autopay enabled" : `$${ob.amount} due`, linkedProfiles: ob.linkedProfiles, sourceId: ob.id, meta: { amount: ob.amount, frequency: ob.frequency, autopay: ob.autopay } });
      }
      // Generate future occurrences based on frequency
      if (ob.frequency !== "once") {
        const base = new Date(ob.nextDueDate);
        for (let i = 1; i <= 24; i++) {
          const next = new Date(base);
          switch (ob.frequency) {
            case "weekly": next.setDate(next.getDate() + i * 7); break;
            case "biweekly": next.setDate(next.getDate() + i * 14); break;
            case "monthly": next.setMonth(next.getMonth() + i); break;
            case "quarterly": next.setMonth(next.getMonth() + i * 3); break;
            case "yearly": next.setFullYear(next.getFullYear() + i); break;
          }
          const nextStr = next.toISOString().slice(0, 10);
          if (nextStr > endDate) break;
          if (nextStr >= startDate) {
            items.push({ id: `obligation-${ob.id}-${nextStr}`, type: "obligation", title: `${ob.name} — $${ob.amount}`, date: nextStr, allDay: true, color: "#BB653B", category: ob.category, description: ob.autopay ? "Autopay enabled" : `$${ob.amount} due`, linkedProfiles: ob.linkedProfiles, sourceId: ob.id, meta: { amount: ob.amount, frequency: ob.frequency, autopay: ob.autopay } });
          }
        }
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

    // ── Profile-derived virtual events ──────────────────────────
    const profiles = await this.getProfiles();
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
            items.push({ id: `profile-birthday-${profile.id}-${d}`, type: "event", title: `🎂 ${profile.name}'s Birthday`, date: d, allDay: true, color: "#A86FDF", category: "family", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: profile.type } });
          }
        }
      }

      // Medical → nextVisit
      if (profile.type === "medical" && f.nextVisit) {
        const d = f.nextVisit.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({ id: `profile-medical-${profile.id}-${d}`, type: "event", title: `🏥 ${profile.name} — Visit`, date: d, allDay: true, color: "#6DAA45", category: "health", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "medical" } });
        }
      }

      // Vehicle → nextService
      if (profile.type === "vehicle" && f.nextService) {
        const d = f.nextService.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({ id: `profile-vehicle-${profile.id}-${d}`, type: "event", title: `🚗 ${profile.name} — Service`, date: d, allDay: true, color: "#BB653B", category: "other", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "vehicle" } });
        }
      }

      // Subscription → renewalDate
      if (profile.type === "subscription" && f.renewalDate) {
        const d = f.renewalDate.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({ id: `profile-subscription-${profile.id}-${d}`, type: "event", title: `🔄 ${profile.name} — Renewal`, date: d, allDay: true, color: "#D19900", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "subscription" } });
        }
      }

      // Loan → startDate or nextPayment
      if (profile.type === "loan" && (f.nextPayment || f.startDate)) {
        const d = (f.nextPayment || f.startDate).slice(0, 10);
        if (d >= startDate && d <= endDate) {
          const label = f.nextPayment ? "Payment Due" : "Start Date";
          items.push({ id: `profile-loan-${profile.id}-${d}`, type: "event", title: `💰 ${profile.name} — ${label}`, date: d, allDay: true, color: "#BB653B", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "loan" } });
        }
      }

      // Pet → nextVetVisit
      if (profile.type === "pet" && f.nextVetVisit) {
        const d = f.nextVetVisit.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({ id: `profile-pet-${profile.id}-${d}`, type: "event", title: `🐾 ${profile.name} — Vet Visit`, date: d, allDay: true, color: "#6DAA45", category: "health", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "pet" } });
        }
      }

      // Property → insurance expiry, lease end, etc.
      if (profile.type === "property") {
        if (f.insuranceExpiry) {
          const d = f.insuranceExpiry.slice(0, 10);
          if (d >= startDate && d <= endDate) {
            items.push({ id: `profile-property-ins-${profile.id}-${d}`, type: "event", title: `🏠 ${profile.name} — Insurance Expiry`, date: d, allDay: true, color: "#BB653B", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "property" } });
          }
        }
        if (f.leaseEnd) {
          const d = f.leaseEnd.slice(0, 10);
          if (d >= startDate && d <= endDate) {
            items.push({ id: `profile-property-lease-${profile.id}-${d}`, type: "event", title: `🏠 ${profile.name} — Lease End`, date: d, allDay: true, color: "#A13544", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "property" } });
          }
        }
      }

      // Investment → maturityDate
      if (profile.type === "investment" && f.maturityDate) {
        const d = f.maturityDate.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({ id: `profile-investment-${profile.id}-${d}`, type: "event", title: `📈 ${profile.name} — Maturity`, date: d, allDay: true, color: "#D19900", category: "finance", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "investment" } });
        }
      }

      // Account → expirationDate
      if (profile.type === "account" && f.expirationDate) {
        const d = f.expirationDate.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({ id: `profile-account-${profile.id}-${d}`, type: "event", title: `⚠️ ${profile.name} — Expires`, date: d, allDay: true, color: "#A13544", category: "other", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "account" } });
        }
      }

      // Asset → warrantyExpiry
      if (profile.type === "asset" && f.warrantyExpiry) {
        const d = f.warrantyExpiry.slice(0, 10);
        if (d >= startDate && d <= endDate) {
          items.push({ id: `profile-asset-${profile.id}-${d}`, type: "event", title: `🛡️ ${profile.name} — Warranty Expiry`, date: d, allDay: true, color: "#BB653B", category: "other", linkedProfiles: [profile.id], sourceId: profile.id, meta: { source: "profile", profileType: "asset" } });
        }
      }
    }

    // ── Document-extracted dates (expiry, renewal, due, appointment) ──────
    const documents = await this.getDocuments();
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
  async getDocuments(): Promise<Document[]> {
    const { data, error } = await this.supabase.from("documents").select("*").eq("user_id", this.userId);
    if (error) throw error;
    return (data || []).map(r => this.rowToDocument(r));
  }

  async getDocument(id: string): Promise<Document | undefined> {
    const { data, error } = await this.supabase.from("documents").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    return this.rowToDocument(data);
  }

  async createDocument(data: any): Promise<Document> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("documents").insert({
      id, user_id: this.userId, name: data.name, type: data.type || "other",
      mime_type: data.mimeType || "image/jpeg", file_data: data.fileData || "",
      extracted_data: data.extractedData || {}, linked_profiles: data.linkedProfiles || [],
      tags: data.tags || [], created_at: now,
    });
    if (error) throw error;
    for (const pid of (data.linkedProfiles || [])) {
      await this.linkProfileTo(pid, "document", id);
    }
    this.logActivity("document", `Stored document: ${data.name}`);
    return (await this.getDocument(id))!;
  }

  async updateDocument(id: string, data: Partial<Document>): Promise<Document | undefined> {
    const existing = await this.getDocument(id);
    if (!existing) return undefined;
    if (data.linkedProfiles) {
      for (const pid of existing.linkedProfiles) {
        if (!data.linkedProfiles.includes(pid)) {
          const profile = await this.getProfile(pid);
          if (profile) {
            const newDocs = profile.documents.filter(did => did !== id);
            await this.supabase.from("profiles").update({ documents: newDocs }).eq("id", pid).eq("user_id", this.userId);
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
    const { error } = await this.supabase.from("documents").update({
      name: merged.name, type: merged.type, mime_type: merged.mimeType,
      file_data: merged.fileData, extracted_data: merged.extractedData,
      linked_profiles: merged.linkedProfiles, tags: merged.tags,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    return this.getDocument(id);
  }

  async deleteDocument(id: string): Promise<boolean> {
    const doc = await this.getDocument(id);
    if (!doc) return false;
    for (const pid of doc.linkedProfiles) {
      const profile = await this.getProfile(pid);
      if (profile) {
        const newDocs = profile.documents.filter(did => did !== id);
        await this.supabase.from("profiles").update({ documents: newDocs }).eq("id", pid).eq("user_id", this.userId);
      }
    }
    const { error } = await this.supabase.from("documents").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  async getDocumentsForProfile(profileId: string): Promise<Document[]> {
    const allDocs = await this.getDocuments();
    return allDocs.filter(d => d.linkedProfiles.includes(profileId));
  }

  // ============================================================
  // HABITS
  // ============================================================
  async getHabits(): Promise<Habit[]> {
    const { data, error } = await this.supabase.from("habits").select("*").eq("user_id", this.userId);
    if (error) throw error;
    const habits: Habit[] = [];
    for (const r of data || []) {
      const { data: checkins } = await this.supabase.from("habit_checkins").select("*").eq("habit_id", r.id).eq("user_id", this.userId).order("date", { ascending: true });
      habits.push(this.rowToHabit(r, (checkins || []).map(c => this.rowToHabitCheckin(c))));
    }
    return habits;
  }

  async getHabit(id: string): Promise<Habit | undefined> {
    const { data, error } = await this.supabase.from("habits").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    const { data: checkins } = await this.supabase.from("habit_checkins").select("*").eq("habit_id", id).eq("user_id", this.userId).order("date", { ascending: true });
    return this.rowToHabit(data, (checkins || []).map(c => this.rowToHabitCheckin(c)));
  }

  async createHabit(data: InsertHabit): Promise<Habit> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("habits").insert({
      id, user_id: this.userId, name: data.name, icon: data.icon || null,
      color: data.color || null, frequency: data.frequency || "daily",
      target_days: data.targetDays || null, current_streak: 0, longest_streak: 0,
      created_at: now,
    });
    if (error) throw error;
    this.logActivity("habit", `Created habit: ${data.name}`);
    return (await this.getHabit(id))!;
  }

  async checkinHabit(habitId: string, date?: string, value?: number, notes?: string): Promise<HabitCheckin | undefined> {
    const habit = await this.getHabit(habitId);
    if (!habit) return undefined;
    const checkinDate = date || new Date().toISOString().slice(0, 10);
    const existing = habit.checkins.find(c => c.date === checkinDate);
    if (existing) return existing;
    const id = randomUUID();
    const ts = new Date().toISOString();
    const { error } = await this.supabase.from("habit_checkins").insert({
      id, user_id: this.userId, habit_id: habitId, date: checkinDate,
      value: value ?? null, notes: notes || null, timestamp: ts,
    });
    if (error) throw error;
    // Recalculate streaks
    const { data: allCheckins } = await this.supabase.from("habit_checkins").select("date").eq("habit_id", habitId).eq("user_id", this.userId);
    const { current, longest } = calculateStreak(allCheckins || []);
    await this.supabase.from("habits").update({
      current_streak: current, longest_streak: Math.max(longest, habit.longestStreak),
    }).eq("id", habitId).eq("user_id", this.userId);
    this.logActivity("habit", `Checked in: ${habit.name}`);
    return { id, date: checkinDate, value, notes, timestamp: ts };
  }

  async updateHabit(id: string, data: Partial<Habit>): Promise<Habit | undefined> {
    const existing = await this.getHabit(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    const { error } = await this.supabase.from("habits").update({
      name: merged.name, icon: merged.icon || null, color: merged.color || null,
      frequency: merged.frequency, target_days: merged.targetDays || null,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    return this.getHabit(id);
  }

  async deleteHabit(id: string): Promise<boolean> {
    await this.supabase.from("habit_checkins").delete().eq("habit_id", id).eq("user_id", this.userId);
    const { error } = await this.supabase.from("habits").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // OBLIGATIONS
  // ============================================================
  async getObligations(): Promise<Obligation[]> {
    const { data, error } = await this.supabase.from("obligations").select("*").eq("user_id", this.userId);
    if (error) throw error;
    const obligations: Obligation[] = [];
    for (const r of data || []) {
      const { data: payments } = await this.supabase.from("obligation_payments").select("*").eq("obligation_id", r.id).eq("user_id", this.userId).order("date", { ascending: true });
      obligations.push(this.rowToObligation(r, (payments || []).map(p => this.rowToPayment(p))));
    }
    return obligations;
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
    const { error } = await this.supabase.from("obligations").insert({
      id, user_id: this.userId, name: data.name, amount: data.amount,
      frequency: data.frequency || "monthly", category: data.category || "general",
      next_due_date: data.nextDueDate, autopay: data.autopay || false,
      linked_profiles: [], notes: data.notes || null, created_at: now,
    });
    if (error) throw error;
    this.logActivity("obligation", `Created obligation: ${data.name}`);

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
    const { error } = await this.supabase.from("obligations").update({
      name: merged.name, amount: merged.amount, frequency: merged.frequency,
      category: merged.category, next_due_date: merged.nextDueDate,
      autopay: merged.autopay, linked_profiles: merged.linkedProfiles,
      notes: merged.notes || null,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    return this.getObligation(id);
  }

  async payObligation(obligationId: string, amount: number, method?: string, confirmationNumber?: string): Promise<ObligationPayment | undefined> {
    const ob = await this.getObligation(obligationId);
    if (!ob) return undefined;
    const id = randomUUID();
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("obligation_payments").insert({
      id, user_id: this.userId, obligation_id: obligationId, amount, date: now,
      method: method || null, confirmation_number: confirmationNumber || null,
    });
    if (error) throw error;
    // Advance next due date
    const nextDue = new Date(ob.nextDueDate);
    switch (ob.frequency) {
      case "weekly": nextDue.setDate(nextDue.getDate() + 7); break;
      case "biweekly": nextDue.setDate(nextDue.getDate() + 14); break;
      case "monthly": nextDue.setMonth(nextDue.getMonth() + 1); break;
      case "quarterly": nextDue.setMonth(nextDue.getMonth() + 3); break;
      case "yearly": nextDue.setFullYear(nextDue.getFullYear() + 1); break;
    }
    await this.supabase.from("obligations").update({ next_due_date: nextDue.toISOString().slice(0, 10) }).eq("id", obligationId).eq("user_id", this.userId);
    this.logActivity("obligation", `Paid ${ob.name}: $${amount}`);
    return { id, amount, date: now, method, confirmationNumber };
  }

  async deleteObligation(id: string): Promise<boolean> {
    await this.supabase.from("obligation_payments").delete().eq("obligation_id", id).eq("user_id", this.userId);
    const { error } = await this.supabase.from("obligations").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // ARTIFACTS
  // ============================================================
  async getArtifacts(): Promise<Artifact[]> {
    const { data, error } = await this.supabase.from("artifacts").select("*").eq("user_id", this.userId);
    if (error) throw error;
    return (data || []).map(r => this.rowToArtifact(r));
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    const { data, error } = await this.supabase.from("artifacts").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    return this.rowToArtifact(data);
  }

  async createArtifact(data: InsertArtifact): Promise<Artifact> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const items: ChecklistItem[] = (data.items || []).map((item, i) => ({ id: randomUUID(), text: item.text, checked: item.checked ?? false, order: i }));
    const { error } = await this.supabase.from("artifacts").insert({
      id, user_id: this.userId, type: data.type, title: data.title,
      content: data.content || "", items, tags: data.tags || [],
      linked_profiles: [], pinned: data.pinned || false,
      created_at: now, updated_at: now,
    });
    if (error) throw error;
    this.logActivity("artifact", `Created ${data.type}: ${data.title}`);
    return (await this.getArtifact(id))!;
  }

  async updateArtifact(id: string, data: Partial<Artifact>): Promise<Artifact | undefined> {
    const existing = await this.getArtifact(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...data };
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("artifacts").update({
      type: merged.type, title: merged.title, content: merged.content,
      items: merged.items, tags: merged.tags, linked_profiles: merged.linkedProfiles,
      pinned: merged.pinned, updated_at: now,
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
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
  async getJournalEntries(): Promise<JournalEntry[]> {
    const { data, error } = await this.supabase.from("journal_entries").select("*").eq("user_id", this.userId).order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(r => this.rowToJournalEntry(r));
  }

  private async getJournalEntry(id: string): Promise<JournalEntry | undefined> {
    const { data, error } = await this.supabase.from("journal_entries").select("*").eq("id", id).eq("user_id", this.userId).single();
    if (error || !data) return undefined;
    return this.rowToJournalEntry(data);
  }

  async createJournalEntry(data: InsertJournalEntry): Promise<JournalEntry> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const { error } = await this.supabase.from("journal_entries").insert({
      id, user_id: this.userId, date: data.date || now.slice(0, 10), mood: data.mood,
      content: data.content || "", tags: data.tags || [], energy: data.energy ?? null,
      gratitude: data.gratitude || null, highlights: data.highlights || null,
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
    }).eq("id", id).eq("user_id", this.userId);
    if (error) throw error;
    return this.getJournalEntry(id);
  }

  async deleteJournalEntry(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("journal_entries").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  // ============================================================
  // MEMORY
  // ============================================================
  async getMemories(): Promise<MemoryItem[]> {
    const { data, error } = await this.supabase.from("memories").select("*").eq("user_id", this.userId);
    if (error) throw error;
    return (data || []).map(r => this.rowToMemory(r));
  }

  async saveMemory(data: InsertMemory): Promise<MemoryItem> {
    const now = new Date().toISOString();
    // Check if key exists — update
    const { data: existing } = await this.supabase.from("memories").select("*").eq("user_id", this.userId).eq("key", data.key).single();
    if (existing) {
      await this.supabase.from("memories").update({
        value: data.value, category: data.category || existing.category, updated_at: now,
      }).eq("id", existing.id).eq("user_id", this.userId);
      return this.rowToMemory({ ...existing, value: data.value, category: data.category || existing.category, updated_at: now });
    }
    const id = randomUUID();
    const { error } = await this.supabase.from("memories").insert({
      id, user_id: this.userId, key: data.key, value: data.value,
      category: data.category || "general", created_at: now, updated_at: now,
    });
    if (error) throw error;
    return { id, key: data.key, value: data.value, category: data.category || "general", createdAt: now, updatedAt: now };
  }

  async recallMemory(query: string): Promise<MemoryItem[]> {
    const q = query.toLowerCase();
    const memories = await this.getMemories();
    return memories.filter(m =>
      m.key.toLowerCase().includes(q) ||
      m.value.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q)
    );
  }

  async deleteMemory(id: string): Promise<boolean> {
    const { error } = await this.supabase.from("memories").delete().eq("id", id).eq("user_id", this.userId);
    return !error;
  }

  async updateMemory(id: string, data: Partial<any>): Promise<any | undefined> {
    const updates: Record<string, any> = {};
    if (data.value !== undefined) updates.value = data.value;
    if (data.category !== undefined) updates.category = data.category;
    const { data: result, error } = await this.supabase
      .from("memories")
      .update(updates)
      .eq("id", id)
      .eq("user_id", this.userId)
      .select()
      .single();
    if (error || !result) return undefined;
    return { id: result.id, key: result.key, value: result.value, category: result.category || "general", createdAt: result.created_at };
  }

  // ============================================================
  // GOALS
  // ============================================================
  async getGoals(): Promise<Goal[]> {
    const { data, error } = await this.supabase.from("goals").select("*").eq("user_id", this.userId).order("created_at", { ascending: false });
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
    const { error } = await this.supabase.from("goals").insert({
      id, user_id: this.userId, title: data.title, type: data.type, target: data.target,
      current: 0, unit: data.unit, start_value: data.startValue ?? null,
      deadline: data.deadline || null, tracker_id: data.trackerId || null,
      habit_id: data.habitId || null, category: data.category || null,
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
    if (data.milestones !== undefined) updates.milestones = data.milestones;
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

    const profiles = await this.getProfiles();
    const events = await this.getEvents();
    const artifacts = await this.getArtifacts();
    const memories = await this.getMemories();

    return {
      totalProfiles: profiles.length,
      totalTrackers: trackers.length,
      totalTasks: tasks.length,
      activeTasks: tasks.filter(t => t.status !== "done").length,
      totalExpenses: expenses.reduce((sum, e) => sum + e.amount, 0),
      totalEvents: events.length,
      monthlySpend: monthlyExpenses.reduce((sum, e) => sum + e.amount, 0),
      weeklyEntries,
      streaks,
      recentActivity: [
        ...trackers.flatMap(t => t.entries.slice(-2).map(e => ({
          type: 'tracker_entry',
          description: `Logged ${t.name}: ${Object.values(e.values).filter(v => typeof v === 'number').map(v => v).join(', ')}`,
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
    const profiles = await this.getProfiles();
    const selfProfile = profiles.find(p => p.type === 'self');
    const selfId = selfProfile?.id;
    const healthCategories = ['health', 'fitness', 'weight', 'sleep', 'blood_pressure', 'running', 'exercise', 'nutrition', 'wellness'];
    // Only show MY health trackers on the dashboard — filter to self-profile-linked or unlinked trackers
    const healthTrackers = trackers.filter(t => {
      const isHealthCategory = healthCategories.some(c => t.category.toLowerCase().includes(c) || t.name.toLowerCase().includes(c));
      if (!isHealthCategory) return false;
      // Only include if linked to self OR has no linked profiles (orphaned = mine)
      if (selfId && t.linkedProfiles.includes(selfId)) return true;
      if (t.linkedProfiles.length === 0) return true;
      return false;
    });
    const healthSnapshot: any[] = [];
    for (const t of healthTrackers) {
      const recent = t.entries.slice(-7);
      const primaryField = t.fields.find((f: any) => f.isPrimary) || t.fields[0];
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

    // Enhance with entity links
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
