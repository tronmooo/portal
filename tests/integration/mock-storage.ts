import { randomUUID } from "crypto";
import type {
  IStorage,
} from "../../server/storage";
import type {
  Profile, InsertProfile, ProfileDetail, TimelineEntry,
  Tracker, InsertTracker, TrackerEntry, InsertTrackerEntry,
  Task, InsertTask,
  Expense, InsertExpense,
  CalendarEvent, InsertEvent, CalendarTimelineItem,
  Document, InsertDocument,
  Habit, InsertHabit, HabitCheckin,
  Obligation, InsertObligation, ObligationPayment,
  Artifact, InsertArtifact, ChecklistItem,
  JournalEntry, InsertJournalEntry,
  MemoryItem, InsertMemory,
  Domain, InsertDomain, DomainEntry,
  Goal, InsertGoal,
  EntityLink, InsertEntityLink,
  DashboardStats, Insight,
  EVENT_CATEGORY_COLORS,
} from "../../shared/schema";

function now(): string {
  return new Date().toISOString();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * In-memory IStorage implementation for tests.
 * Call reset() in beforeEach to start each test with a clean slate.
 */
export class InMemoryStorage implements IStorage {
  private profiles: Profile[] = [];
  private trackers: Tracker[] = [];
  private tasks: Task[] = [];
  private expenses: Expense[] = [];
  private events: CalendarEvent[] = [];
  private documents: Document[] = [];
  private habits: Habit[] = [];
  private obligations: Obligation[] = [];
  private artifacts: Artifact[] = [];
  private journal: JournalEntry[] = [];
  private memories: MemoryItem[] = [];
  private goals: Goal[] = [];
  private domains: Domain[] = [];
  private domainEntries: DomainEntry[] = [];
  private entityLinks: EntityLink[] = [];
  private preferences: Map<string, string> = new Map();

  reset() {
    this.profiles = [];
    this.trackers = [];
    this.tasks = [];
    this.expenses = [];
    this.events = [];
    this.documents = [];
    this.habits = [];
    this.obligations = [];
    this.artifacts = [];
    this.journal = [];
    this.memories = [];
    this.goals = [];
    this.domains = [];
    this.domainEntries = [];
    this.entityLinks = [];
    this.preferences = new Map();
  }

  // ── Profiles ─────────────────────────────────────────────────────────────

  async getProfiles(): Promise<Profile[]> {
    return [...this.profiles];
  }

  async getProfile(id: string): Promise<Profile | undefined> {
    return this.profiles.find((p) => p.id === id);
  }

  async getProfileDetail(id: string): Promise<ProfileDetail | undefined> {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) return undefined;
    return {
      ...profile,
      relatedTrackers: this.trackers.filter((t) =>
        t.linkedProfiles.includes(id)
      ),
      relatedExpenses: this.expenses.filter((e) =>
        e.linkedProfiles.includes(id)
      ),
      relatedTasks: this.tasks.filter((t) => t.linkedProfiles.includes(id)),
      relatedEvents: this.events.filter((e) => e.linkedProfiles.includes(id)),
      relatedDocuments: this.documents.filter((d) =>
        d.linkedProfiles.includes(id)
      ),
      relatedObligations: this.obligations.filter((o) =>
        o.linkedProfiles.includes(id)
      ),
      childProfiles: this.profiles.filter((p) => p.parentProfileId === id),
      timeline: [] as TimelineEntry[],
    };
  }

  async createProfile(data: InsertProfile): Promise<Profile> {
    const profile: Profile = {
      id: randomUUID(),
      type: data.type,
      name: data.name,
      fields: data.fields ?? {},
      tags: data.tags ?? [],
      notes: data.notes ?? "",
      documents: [],
      linkedTrackers: [],
      linkedExpenses: [],
      linkedTasks: [],
      linkedEvents: [],
      parentProfileId: data.parentProfileId,
      createdAt: now(),
      updatedAt: now(),
    };
    this.profiles.push(profile);
    return profile;
  }

  async updateProfile(
    id: string,
    data: Partial<Profile>
  ): Promise<Profile | undefined> {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx === -1) return undefined;
    this.profiles[idx] = { ...this.profiles[idx], ...data, updatedAt: now() };
    return this.profiles[idx];
  }

  async deleteProfile(id: string): Promise<boolean> {
    const idx = this.profiles.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.profiles.splice(idx, 1);
    return true;
  }

  async linkProfileTo(
    profileId: string,
    entityType: string,
    entityId: string
  ): Promise<void> {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) return;
    const key =
      `linked${entityType.charAt(0).toUpperCase() + entityType.slice(1)}s` as keyof Profile;
    const list = profile[key] as string[] | undefined;
    if (Array.isArray(list) && !list.includes(entityId)) {
      list.push(entityId);
    }
  }

  async unlinkProfileFrom(
    profileId: string,
    entityType: string,
    entityId: string
  ): Promise<void> {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (!profile) return;
    const key =
      `linked${entityType.charAt(0).toUpperCase() + entityType.slice(1)}s` as keyof Profile;
    const list = profile[key] as string[] | undefined;
    if (Array.isArray(list)) {
      const i = list.indexOf(entityId);
      if (i !== -1) list.splice(i, 1);
    }
  }

  async getSelfProfile(): Promise<Profile | undefined> {
    return this.profiles.find((p) => p.type === "self");
  }

  // ── Trackers ──────────────────────────────────────────────────────────────

  async getTrackers(): Promise<Tracker[]> {
    return [...this.trackers];
  }

  async getTracker(id: string): Promise<Tracker | undefined> {
    return this.trackers.find((t) => t.id === id);
  }

  async createTracker(data: InsertTracker): Promise<Tracker> {
    const tracker: Tracker = {
      id: randomUUID(),
      name: data.name,
      category: data.category ?? "custom",
      unit: data.unit,
      icon: data.icon,
      fields: data.fields ?? [],
      entries: [],
      linkedProfiles: [],
      createdAt: now(),
    };
    this.trackers.push(tracker);
    return tracker;
  }

  async updateTracker(
    id: string,
    data: Partial<Tracker>
  ): Promise<Tracker | undefined> {
    const idx = this.trackers.findIndex((t) => t.id === id);
    if (idx === -1) return undefined;
    this.trackers[idx] = { ...this.trackers[idx], ...data };
    return this.trackers[idx];
  }

  async logEntry(data: InsertTrackerEntry): Promise<TrackerEntry | undefined> {
    const tracker = this.trackers.find((t) => t.id === data.trackerId);
    if (!tracker) return undefined;
    const entry: TrackerEntry = {
      id: randomUUID(),
      values: data.values,
      computed: {},
      notes: data.notes,
      mood: data.mood,
      tags: data.tags ?? [],
      timestamp: now(),
    };
    tracker.entries.push(entry);
    return entry;
  }

  async deleteTrackerEntry(
    trackerId: string,
    entryId: string
  ): Promise<boolean> {
    const tracker = this.trackers.find((t) => t.id === trackerId);
    if (!tracker) return false;
    const idx = tracker.entries.findIndex((e) => e.id === entryId);
    if (idx === -1) return false;
    tracker.entries.splice(idx, 1);
    return true;
  }

  async deleteTracker(id: string): Promise<boolean> {
    const idx = this.trackers.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.trackers.splice(idx, 1);
    return true;
  }

  async migrateUnlinkedTrackersToSelf(): Promise<number> {
    const self = this.profiles.find((p) => p.type === "self");
    if (!self) return 0;
    let count = 0;
    for (const t of this.trackers) {
      if (t.linkedProfiles.length === 0) {
        t.linkedProfiles.push(self.id);
        count++;
      }
    }
    return count;
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  async getTasks(): Promise<Task[]> {
    return [...this.tasks];
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.find((t) => t.id === id);
  }

  async createTask(data: InsertTask): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      title: data.title,
      description: data.description,
      status: "todo",
      priority: data.priority ?? "medium",
      dueDate: data.dueDate,
      linkedProfiles: data.linkedProfiles ?? [],
      tags: data.tags ?? [],
      createdAt: now(),
    };
    this.tasks.push(task);
    return task;
  }

  async updateTask(
    id: string,
    data: Partial<Task>
  ): Promise<Task | undefined> {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return undefined;
    this.tasks[idx] = { ...this.tasks[idx], ...data };
    return this.tasks[idx];
  }

  async deleteTask(id: string): Promise<boolean> {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    return true;
  }

  // ── Expenses ──────────────────────────────────────────────────────────────

  async getExpenses(): Promise<Expense[]> {
    return [...this.expenses];
  }

  async getExpense(id: string): Promise<Expense | undefined> {
    return this.expenses.find((e) => e.id === id);
  }

  async createExpense(data: InsertExpense): Promise<Expense> {
    const expense: Expense = {
      id: randomUUID(),
      amount: data.amount,
      category: data.category ?? "general",
      description: data.description,
      vendor: data.vendor,
      isRecurring: data.isRecurring,
      linkedProfiles: data.linkedProfiles ?? [],
      tags: data.tags ?? [],
      date: data.date ?? today(),
      createdAt: now(),
    };
    this.expenses.push(expense);
    return expense;
  }

  async updateExpense(
    id: string,
    data: Partial<Expense>
  ): Promise<Expense | undefined> {
    const idx = this.expenses.findIndex((e) => e.id === id);
    if (idx === -1) return undefined;
    this.expenses[idx] = { ...this.expenses[idx], ...data };
    return this.expenses[idx];
  }

  async deleteExpense(id: string): Promise<boolean> {
    const idx = this.expenses.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.expenses.splice(idx, 1);
    return true;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  async getEvents(): Promise<CalendarEvent[]> {
    return [...this.events];
  }

  async getEvent(id: string): Promise<CalendarEvent | undefined> {
    return this.events.find((e) => e.id === id);
  }

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
      category: data.category ?? "personal",
      color: data.color,
      recurrence: data.recurrence ?? "none",
      recurrenceEnd: data.recurrenceEnd,
      linkedProfiles: data.linkedProfiles ?? [],
      linkedDocuments: data.linkedDocuments ?? [],
      tags: data.tags ?? [],
      source: data.source ?? "manual",
      createdAt: now(),
    };
    this.events.push(event);
    return event;
  }

  async updateEvent(
    id: string,
    data: Partial<CalendarEvent>
  ): Promise<CalendarEvent | undefined> {
    const idx = this.events.findIndex((e) => e.id === id);
    if (idx === -1) return undefined;
    this.events[idx] = { ...this.events[idx], ...data };
    return this.events[idx];
  }

  async deleteEvent(id: string): Promise<boolean> {
    const idx = this.events.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.events.splice(idx, 1);
    return true;
  }

  async getCalendarTimeline(
    startDate: string,
    endDate: string
  ): Promise<CalendarTimelineItem[]> {
    const start = new Date(startDate);
    const end = new Date(endDate);
    return this.events
      .filter((e) => {
        const d = new Date(e.date);
        return d >= start && d <= end;
      })
      .map((e) => ({
        id: `event-${e.id}`,
        type: "event" as const,
        title: e.title,
        date: e.date,
        time: e.time,
        endTime: e.endTime,
        allDay: e.allDay,
        color: e.color ?? "#4F98A3",
        category: e.category,
        description: e.description,
        location: e.location,
        linkedProfiles: e.linkedProfiles,
        sourceId: e.id,
      }));
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  async getDocuments(): Promise<Document[]> {
    return [...this.documents];
  }

  async getDocument(id: string): Promise<Document | undefined> {
    return this.documents.find((d) => d.id === id);
  }

  async createDocument(data: Partial<InsertDocument> & { name: string; type: string } & Record<string, unknown>): Promise<Document> {
    const doc: Document = {
      id: randomUUID(),
      name: data.name,
      type: data.type,
      mimeType: (data.mimeType as string) ?? "application/octet-stream",
      fileData: (data.fileData as string) ?? "",
      storagePath: data.storagePath as string | undefined,
      extractedData: (data.extractedData as Record<string, any>) ?? {},
      linkedProfiles: (data.linkedProfiles as string[]) ?? [],
      tags: (data.tags as string[]) ?? [],
      createdAt: now(),
    };
    this.documents.push(doc);
    return doc;
  }

  async updateDocument(
    id: string,
    data: Partial<Document>
  ): Promise<Document | undefined> {
    const idx = this.documents.findIndex((d) => d.id === id);
    if (idx === -1) return undefined;
    this.documents[idx] = { ...this.documents[idx], ...data };
    return this.documents[idx];
  }

  async deleteDocument(id: string): Promise<boolean> {
    const idx = this.documents.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    this.documents.splice(idx, 1);
    return true;
  }

  async getDocumentsForProfile(profileId: string): Promise<Document[]> {
    return this.documents.filter((d) => d.linkedProfiles.includes(profileId));
  }

  // ── Habits ────────────────────────────────────────────────────────────────

  async getHabits(): Promise<Habit[]> {
    return [...this.habits];
  }

  async getHabit(id: string): Promise<Habit | undefined> {
    return this.habits.find((h) => h.id === id);
  }

  async createHabit(data: InsertHabit): Promise<Habit> {
    const habit: Habit = {
      id: randomUUID(),
      name: data.name,
      icon: data.icon,
      color: data.color,
      frequency: data.frequency ?? "daily",
      targetDays: data.targetDays,
      currentStreak: 0,
      longestStreak: 0,
      checkins: [],
      createdAt: now(),
    };
    this.habits.push(habit);
    return habit;
  }

  async checkinHabit(
    habitId: string,
    date?: string,
    value?: number,
    notes?: string
  ): Promise<HabitCheckin | undefined> {
    const habit = this.habits.find((h) => h.id === habitId);
    if (!habit) return undefined;
    const checkin: HabitCheckin = {
      id: randomUUID(),
      date: date ?? today(),
      value,
      notes,
      timestamp: now(),
    };
    habit.checkins.push(checkin);
    habit.currentStreak += 1;
    if (habit.currentStreak > habit.longestStreak) {
      habit.longestStreak = habit.currentStreak;
    }
    return checkin;
  }

  async updateHabit(
    id: string,
    data: Partial<Habit>
  ): Promise<Habit | undefined> {
    const idx = this.habits.findIndex((h) => h.id === id);
    if (idx === -1) return undefined;
    this.habits[idx] = { ...this.habits[idx], ...data };
    return this.habits[idx];
  }

  async deleteHabit(id: string): Promise<boolean> {
    const idx = this.habits.findIndex((h) => h.id === id);
    if (idx === -1) return false;
    this.habits.splice(idx, 1);
    return true;
  }

  // ── Obligations ───────────────────────────────────────────────────────────

  async getObligations(): Promise<Obligation[]> {
    return [...this.obligations];
  }

  async getObligation(id: string): Promise<Obligation | undefined> {
    return this.obligations.find((o) => o.id === id);
  }

  async createObligation(data: InsertObligation): Promise<Obligation> {
    const obligation: Obligation = {
      id: randomUUID(),
      name: data.name,
      amount: data.amount,
      frequency: data.frequency ?? "monthly",
      category: data.category ?? "general",
      nextDueDate: data.nextDueDate,
      autopay: data.autopay ?? false,
      status: "active",
      linkedProfiles: data.linkedProfiles ?? [],
      payments: [],
      notes: data.notes,
      createdAt: now(),
    };
    this.obligations.push(obligation);
    return obligation;
  }

  async updateObligation(
    id: string,
    data: Partial<Obligation>
  ): Promise<Obligation | undefined> {
    const idx = this.obligations.findIndex((o) => o.id === id);
    if (idx === -1) return undefined;
    this.obligations[idx] = { ...this.obligations[idx], ...data };
    return this.obligations[idx];
  }

  async payObligation(
    obligationId: string,
    amount: number,
    method?: string,
    confirmationNumber?: string
  ): Promise<ObligationPayment | undefined> {
    const obligation = this.obligations.find((o) => o.id === obligationId);
    if (!obligation) return undefined;
    const payment: ObligationPayment = {
      id: randomUUID(),
      amount,
      date: today(),
      method,
      confirmationNumber,
      createdAt: now(),
    };
    obligation.payments.push(payment);
    return payment;
  }

  async deleteObligation(id: string): Promise<boolean> {
    const idx = this.obligations.findIndex((o) => o.id === id);
    if (idx === -1) return false;
    this.obligations.splice(idx, 1);
    return true;
  }

  // ── Artifacts ─────────────────────────────────────────────────────────────

  async getArtifacts(): Promise<Artifact[]> {
    return [...this.artifacts];
  }

  async getArtifact(id: string): Promise<Artifact | undefined> {
    return this.artifacts.find((a) => a.id === id);
  }

  async createArtifact(data: InsertArtifact): Promise<Artifact> {
    const artifact: Artifact = {
      id: randomUUID(),
      type: data.type,
      title: data.title,
      content: data.content ?? "",
      items: (data.items ?? []).map((item, i) => ({
        id: randomUUID(),
        text: item.text,
        checked: item.checked ?? false,
        order: i,
      })),
      tags: data.tags ?? [],
      linkedProfiles: [],
      pinned: data.pinned ?? false,
      createdAt: now(),
      updatedAt: now(),
    };
    this.artifacts.push(artifact);
    return artifact;
  }

  async updateArtifact(
    id: string,
    data: Partial<Artifact>
  ): Promise<Artifact | undefined> {
    const idx = this.artifacts.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;
    this.artifacts[idx] = { ...this.artifacts[idx], ...data, updatedAt: now() };
    return this.artifacts[idx];
  }

  async toggleChecklistItem(
    artifactId: string,
    itemId: string
  ): Promise<Artifact | undefined> {
    const artifact = this.artifacts.find((a) => a.id === artifactId);
    if (!artifact) return undefined;
    const item = artifact.items.find((i) => i.id === itemId);
    if (!item) return undefined;
    item.checked = !item.checked;
    return artifact;
  }

  async deleteArtifact(id: string): Promise<boolean> {
    const idx = this.artifacts.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    this.artifacts.splice(idx, 1);
    return true;
  }

  // ── Journal ───────────────────────────────────────────────────────────────

  async getJournalEntries(): Promise<JournalEntry[]> {
    return [...this.journal];
  }

  async createJournalEntry(data: InsertJournalEntry): Promise<JournalEntry> {
    const entry: JournalEntry = {
      id: randomUUID(),
      date: data.date ?? today(),
      mood: data.mood,
      content: data.content ?? "",
      tags: data.tags ?? [],
      energy: data.energy,
      gratitude: data.gratitude,
      highlights: data.highlights,
      createdAt: now(),
    };
    this.journal.push(entry);
    return entry;
  }

  async updateJournalEntry(
    id: string,
    data: Partial<JournalEntry>
  ): Promise<JournalEntry | undefined> {
    const idx = this.journal.findIndex((j) => j.id === id);
    if (idx === -1) return undefined;
    this.journal[idx] = { ...this.journal[idx], ...data };
    return this.journal[idx];
  }

  async deleteJournalEntry(id: string): Promise<boolean> {
    const idx = this.journal.findIndex((j) => j.id === id);
    if (idx === -1) return false;
    this.journal.splice(idx, 1);
    return true;
  }

  // ── Memory ────────────────────────────────────────────────────────────────

  async getMemories(): Promise<MemoryItem[]> {
    return [...this.memories];
  }

  async saveMemory(data: InsertMemory): Promise<MemoryItem> {
    const existing = this.memories.find((m) => m.key === data.key);
    if (existing) {
      existing.value = data.value;
      existing.updatedAt = now();
      return existing;
    }
    const item: MemoryItem = {
      id: randomUUID(),
      key: data.key,
      value: data.value,
      category: data.category ?? "general",
      createdAt: now(),
      updatedAt: now(),
    };
    this.memories.push(item);
    return item;
  }

  async recallMemory(query: string): Promise<MemoryItem[]> {
    const q = query.toLowerCase();
    return this.memories.filter(
      (m) =>
        m.key.toLowerCase().includes(q) ||
        m.value.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q)
    );
  }

  async deleteMemory(id: string): Promise<boolean> {
    const idx = this.memories.findIndex((m) => m.id === id);
    if (idx === -1) return false;
    this.memories.splice(idx, 1);
    return true;
  }

  async updateMemory(
    id: string,
    data: Partial<MemoryItem>
  ): Promise<MemoryItem | undefined> {
    const idx = this.memories.findIndex((m) => m.id === id);
    if (idx === -1) return undefined;
    this.memories[idx] = { ...this.memories[idx], ...data, updatedAt: now() };
    return this.memories[idx];
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  async getGoals(): Promise<Goal[]> {
    return [...this.goals];
  }

  async getGoal(id: string): Promise<Goal | undefined> {
    return this.goals.find((g) => g.id === id);
  }

  async createGoal(data: InsertGoal): Promise<Goal> {
    const goal: Goal = {
      id: randomUUID(),
      title: data.title,
      type: data.type,
      target: data.target,
      current: data.startValue ?? 0,
      unit: data.unit,
      startValue: data.startValue,
      deadline: data.deadline,
      trackerId: data.trackerId,
      habitId: data.habitId,
      category: data.category,
      status: "active",
      milestones: (data.milestones ?? []).map((m) => ({
        ...m,
        reached: false,
      })),
      createdAt: now(),
      updatedAt: now(),
    };
    this.goals.push(goal);
    return goal;
  }

  async updateGoal(
    id: string,
    data: Partial<Goal>
  ): Promise<Goal | undefined> {
    const idx = this.goals.findIndex((g) => g.id === id);
    if (idx === -1) return undefined;
    this.goals[idx] = { ...this.goals[idx], ...data, updatedAt: now() };
    return this.goals[idx];
  }

  async deleteGoal(id: string): Promise<boolean> {
    const idx = this.goals.findIndex((g) => g.id === id);
    if (idx === -1) return false;
    this.goals.splice(idx, 1);
    return true;
  }

  // ── Domains ───────────────────────────────────────────────────────────────

  async getDomains(): Promise<Domain[]> {
    return [...this.domains];
  }

  async createDomain(data: InsertDomain): Promise<Domain> {
    const domain: Domain = {
      id: randomUUID(),
      name: data.name,
      slug: data.name.toLowerCase().replace(/\s+/g, "-"),
      icon: data.icon,
      color: data.color,
      description: data.description,
      fields: data.fields ?? [],
      createdAt: now(),
    };
    this.domains.push(domain);
    return domain;
  }

  async updateDomain(
    id: string,
    data: Partial<Domain>
  ): Promise<Domain | undefined> {
    const idx = this.domains.findIndex((d) => d.id === id);
    if (idx === -1) return undefined;
    this.domains[idx] = { ...this.domains[idx], ...data };
    return this.domains[idx];
  }

  async deleteDomain(id: string): Promise<boolean> {
    const idx = this.domains.findIndex((d) => d.id === id);
    if (idx === -1) return false;
    this.domains.splice(idx, 1);
    return true;
  }

  async getDomainEntries(domainId: string): Promise<DomainEntry[]> {
    return this.domainEntries.filter((e) => e.domainId === domainId);
  }

  async addDomainEntry(
    domainId: string,
    values: Record<string, any>,
    tags?: string[],
    notes?: string
  ): Promise<DomainEntry | undefined> {
    const domain = this.domains.find((d) => d.id === domainId);
    if (!domain) return undefined;
    const entry: DomainEntry = {
      id: randomUUID(),
      domainId,
      values,
      tags: tags ?? [],
      notes,
      createdAt: now(),
    };
    this.domainEntries.push(entry);
    return entry;
  }

  // ── Entity Links ──────────────────────────────────────────────────────────

  async getEntityLinks(
    entityType: string,
    entityId: string
  ): Promise<EntityLink[]> {
    return this.entityLinks.filter(
      (l) =>
        (l.sourceType === entityType && l.sourceId === entityId) ||
        (l.targetType === entityType && l.targetId === entityId)
    );
  }

  async createEntityLink(data: InsertEntityLink): Promise<EntityLink> {
    const link: EntityLink = {
      id: randomUUID(),
      sourceType: data.sourceType,
      sourceId: data.sourceId,
      targetType: data.targetType,
      targetId: data.targetId,
      relationship: data.relationship,
      confidence: data.confidence ?? 1,
      createdAt: now(),
    };
    this.entityLinks.push(link);
    return link;
  }

  async deleteEntityLink(id: string): Promise<boolean> {
    const idx = this.entityLinks.findIndex((l) => l.id === id);
    if (idx === -1) return false;
    this.entityLinks.splice(idx, 1);
    return true;
  }

  async getRelatedEntities(
    entityType: string,
    entityId: string
  ): Promise<any[]> {
    return this.entityLinks.filter(
      (l) =>
        (l.sourceType === entityType && l.sourceId === entityId) ||
        (l.targetType === entityType && l.targetId === entityId)
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  async getStats(filterProfileId?: string): Promise<DashboardStats> {
    return {
      totalProfiles: this.profiles.length,
      totalTrackers: this.trackers.length,
      totalTasks: this.tasks.length,
      activeTasks: this.tasks.filter((t) => t.status !== "done").length,
      totalExpenses: this.expenses.length,
      totalEvents: this.events.length,
      monthlySpend: this.expenses.reduce((s, e) => s + e.amount, 0),
      weeklyEntries: 0,
      streaks: [],
      recentActivity: [],
      totalHabits: this.habits.length,
      habitCompletionRate: 0,
      totalObligations: this.obligations.length,
      upcomingObligations: 0,
      monthlyObligationTotal: this.obligations.reduce(
        (s, o) => s + o.amount,
        0
      ),
      journalStreak: 0,
      totalArtifacts: this.artifacts.length,
      totalMemories: this.memories.length,
    };
  }

  async getDashboardEnhanced(
    filterProfileId?: string
  ): Promise<Record<string, unknown>> {
    const stats = await this.getStats(filterProfileId);
    return { stats };
  }

  // ── Insights ──────────────────────────────────────────────────────────────

  async getInsights(): Promise<Insight[]> {
    return [];
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async search(query: string): Promise<any[]> {
    const q = query.toLowerCase();
    const results: any[] = [];
    for (const p of this.profiles) {
      if (p.name.toLowerCase().includes(q)) {
        results.push({ type: "profile", ...p });
      }
    }
    for (const t of this.tasks) {
      if (t.title.toLowerCase().includes(q)) {
        results.push({ type: "task", ...t });
      }
    }
    return results;
  }

  // ── Preferences ───────────────────────────────────────────────────────────

  async getPreference(key: string): Promise<string | null> {
    return this.preferences.get(key) ?? null;
  }

  async setPreference(key: string, value: string): Promise<void> {
    this.preferences.set(key, value);
  }

  // Non-interface methods called by routes.ts (not in IStorage, but called via duck-typing)
  async propagateDocumentToAncestors(_documentId: string, _profileId: string): Promise<void> {
    // No-op in tests — document propagation is a Supabase-only feature
  }
}
