import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../server/storage";

let storage: MemStorage;

beforeEach(() => {
  storage = new MemStorage();
});

// ============================================================
// Profiles
// ============================================================
describe("Profiles", () => {
  it("creates a profile", async () => {
    const profile = await storage.createProfile({ type: "person", name: "Alex" });
    expect(profile.id).toBeDefined();
    expect(profile.name).toBe("Alex");
    expect(profile.type).toBe("person");
    expect(profile.tags).toEqual([]);
    expect(profile.documents).toEqual([]);
  });

  it("gets profiles", async () => {
    await storage.createProfile({ type: "person", name: "Alex" });
    await storage.createProfile({ type: "pet", name: "Buddy" });
    const profiles = await storage.getProfiles();
    expect(profiles.length).toBe(2);
  });

  it("gets profile by id", async () => {
    const created = await storage.createProfile({ type: "person", name: "Alex" });
    const found = await storage.getProfile(created.id);
    expect(found?.name).toBe("Alex");
  });

  it("returns undefined for non-existent profile", async () => {
    const found = await storage.getProfile("nonexistent");
    expect(found).toBeUndefined();
  });

  it("updates a profile", async () => {
    const profile = await storage.createProfile({ type: "person", name: "Alex" });
    const updated = await storage.updateProfile(profile.id, { name: "Alexander" });
    expect(updated?.name).toBe("Alexander");
  });

  it("deletes a profile", async () => {
    const profile = await storage.createProfile({ type: "person", name: "Alex" });
    await storage.deleteProfile(profile.id);
    expect(await storage.getProfile(profile.id)).toBeUndefined();
  });

  it("gets self profile", async () => {
    await storage.createProfile({ type: "self", name: "Me" });
    const self = await storage.getSelfProfile();
    expect(self?.name).toBe("Me");
    expect(self?.type).toBe("self");
  });
});

// ============================================================
// Profile Linking
// ============================================================
describe("Profile Linking", () => {
  it("links tracker to profile", async () => {
    const profile = await storage.createProfile({ type: "person", name: "Alex" });
    const tracker = await storage.createTracker({ name: "Weight", category: "health" });
    await storage.linkProfileTo(profile.id, "tracker", tracker.id);
    const updated = await storage.getProfile(profile.id);
    expect(updated?.linkedTrackers).toContain(tracker.id);
  });

  it("links expense to profile", async () => {
    const profile = await storage.createProfile({ type: "person", name: "Alex" });
    const expense = await storage.createExpense({ amount: 50, description: "Gas", category: "vehicle", tags: [], linkedProfiles: [] });
    await storage.linkProfileTo(profile.id, "expense", expense.id);
    const updated = await storage.getProfile(profile.id);
    expect(updated?.linkedExpenses).toContain(expense.id);
  });

  it("links document to profile", async () => {
    const profile = await storage.createProfile({ type: "person", name: "Alex" });
    await storage.linkProfileTo(profile.id, "document", "doc-id");
    const updated = await storage.getProfile(profile.id);
    expect(updated?.documents).toContain("doc-id");
  });

  it("does not duplicate links", async () => {
    const profile = await storage.createProfile({ type: "person", name: "Alex" });
    await storage.linkProfileTo(profile.id, "tracker", "t1");
    await storage.linkProfileTo(profile.id, "tracker", "t1");
    const updated = await storage.getProfile(profile.id);
    expect(updated?.linkedTrackers.filter(id => id === "t1").length).toBe(1);
  });

  it("unlinks entity from profile", async () => {
    const profile = await storage.createProfile({ type: "person", name: "Alex" });
    await storage.linkProfileTo(profile.id, "task", "task-1");
    await storage.unlinkProfileFrom(profile.id, "task", "task-1");
    const updated = await storage.getProfile(profile.id);
    expect(updated?.linkedTasks).not.toContain("task-1");
  });
});

// ============================================================
// Propagation
// ============================================================
describe("Propagation", () => {
  it("propagates document to ancestor profiles", async () => {
    const parent = await storage.createProfile({ type: "self", name: "Me" });
    const child = await storage.createProfile({ type: "vehicle", name: "Honda", parentProfileId: parent.id });
    const propagated = await storage.propagateDocumentToAncestors("doc-1", child.id);
    expect(propagated).toContain(parent.id);
    const parentProfile = await storage.getProfile(parent.id);
    expect(parentProfile?.documents).toContain("doc-1");
  });

  it("propagates entity to ancestor profiles", async () => {
    const parent = await storage.createProfile({ type: "self", name: "Me" });
    const child = await storage.createProfile({ type: "vehicle", name: "Honda", parentProfileId: parent.id });
    const expense = await storage.createExpense({ amount: 100, description: "Oil change", category: "vehicle", tags: [], linkedProfiles: [] });
    await storage.linkProfileTo(child.id, "expense", expense.id);
    const propagated = await storage.propagateEntityToAncestors("expense", expense.id, child.id);
    expect(propagated).toContain(parent.id);
    const parentProfile = await storage.getProfile(parent.id);
    expect(parentProfile?.linkedExpenses).toContain(expense.id);
  });

  it("returns empty when no parent", async () => {
    const profile = await storage.createProfile({ type: "person", name: "Alex" });
    const propagated = await storage.propagateDocumentToAncestors("doc-1", profile.id);
    expect(propagated).toEqual([]);
  });
});

// ============================================================
// Tasks
// ============================================================
describe("Tasks", () => {
  it("creates a task with linkedProfiles", async () => {
    const task = await storage.createTask({ title: "Buy groceries", tags: [], linkedProfiles: ["p1"] });
    expect(task.title).toBe("Buy groceries");
    expect(task.linkedProfiles).toEqual(["p1"]);
    expect(task.status).toBe("todo");
  });

  it("creates a task with default priority", async () => {
    const task = await storage.createTask({ title: "Test", tags: [], linkedProfiles: [] });
    expect(task.priority).toBe("medium");
  });

  it("gets task by id", async () => {
    const created = await storage.createTask({ title: "Test", tags: [], linkedProfiles: [] });
    const found = await storage.getTask(created.id);
    expect(found?.title).toBe("Test");
  });

  it("updates task status", async () => {
    const task = await storage.createTask({ title: "Test", tags: [], linkedProfiles: [] });
    const updated = await storage.updateTask(task.id, { status: "done" });
    expect(updated?.status).toBe("done");
  });

  it("deletes a task", async () => {
    const task = await storage.createTask({ title: "Test", tags: [], linkedProfiles: [] });
    await storage.deleteTask(task.id);
    const tasks = await storage.getTasks();
    expect(tasks.length).toBe(0);
  });
});

// ============================================================
// Expenses
// ============================================================
describe("Expenses", () => {
  it("creates an expense", async () => {
    const expense = await storage.createExpense({
      amount: 42.50,
      description: "Lunch",
      category: "food",
      tags: ["eating-out"],
      linkedProfiles: [],
    });
    expect(expense.amount).toBe(42.50);
    expect(expense.category).toBe("food");
    expect(expense.linkedProfiles).toEqual([]);
  });

  it("gets expense by id", async () => {
    const created = await storage.createExpense({ amount: 10, description: "Test", category: "general", tags: [], linkedProfiles: [] });
    const found = await storage.getExpense(created.id);
    expect(found?.amount).toBe(10);
  });

  it("returns undefined for non-existent expense", async () => {
    expect(await storage.getExpense("nonexistent")).toBeUndefined();
  });
});

// ============================================================
// Habits
// ============================================================
describe("Habits", () => {
  it("creates a habit with linkedProfiles", async () => {
    const habit = await storage.createHabit({ name: "Exercise", linkedProfiles: ["p1"] });
    expect(habit.name).toBe("Exercise");
    expect(habit.linkedProfiles).toEqual(["p1"]);
    expect(habit.currentStreak).toBe(0);
    expect(habit.checkins).toEqual([]);
  });

  it("checks in to a habit", async () => {
    const habit = await storage.createHabit({ name: "Exercise" });
    const checkin = await storage.checkinHabit(habit.id);
    expect(checkin).toBeDefined();
    expect(checkin?.date).toBeDefined();
    const updated = await storage.getHabit(habit.id);
    expect(updated?.checkins.length).toBe(1);
  });

  it("returns undefined for checkin on non-existent habit", async () => {
    const checkin = await storage.checkinHabit("nonexistent");
    expect(checkin).toBeUndefined();
  });
});

// ============================================================
// Obligations
// ============================================================
describe("Obligations", () => {
  it("creates an obligation with status", async () => {
    const ob = await storage.createObligation({
      name: "Netflix",
      amount: 15.99,
      frequency: "monthly",
      category: "subscription",
      nextDueDate: "2024-07-01",
      autopay: true,
      linkedProfiles: [],
    });
    expect(ob.name).toBe("Netflix");
    expect(ob.status).toBe("active");
    expect(ob.autopay).toBe(true);
    expect(ob.payments).toEqual([]);
  });

  it("records a payment", async () => {
    const ob = await storage.createObligation({
      name: "Rent",
      amount: 1500,
      frequency: "monthly",
      category: "housing",
      nextDueDate: "2024-07-01",
      autopay: false,
      linkedProfiles: [],
    });
    const payment = await storage.payObligation(ob.id, 1500, "bank_transfer");
    expect(payment?.amount).toBe(1500);
    expect(payment?.method).toBe("bank_transfer");
    const updated = await storage.getObligation(ob.id);
    expect(updated?.payments.length).toBe(1);
    // Next due date should advance by one month
    expect(updated?.nextDueDate).not.toBe("2024-07-01");
  });
});

// ============================================================
// Journal
// ============================================================
describe("Journal", () => {
  it("creates a journal entry with linkedProfiles", async () => {
    const entry = await storage.createJournalEntry({
      mood: "good",
      content: "Nice day",
      linkedProfiles: ["p1"],
    });
    expect(entry.mood).toBe("good");
    expect(entry.linkedProfiles).toEqual(["p1"]);
  });

  it("updates a journal entry", async () => {
    const entry = await storage.createJournalEntry({ mood: "good", content: "Nice day" });
    const updated = await storage.updateJournalEntry(entry.id, { mood: "great" });
    expect(updated?.mood).toBe("great");
  });
});

// ============================================================
// Goals
// ============================================================
describe("Goals", () => {
  it("creates a goal with defaults", async () => {
    const goal = await storage.createGoal({
      title: "Lose Weight",
      type: "weight_loss",
      target: 10,
      unit: "lbs",
    });
    expect(goal.current).toBe(0);
    expect(goal.status).toBe("active");
    expect(goal.linkedProfiles).toEqual([]);
  });

  it("creates a goal with linkedProfiles", async () => {
    const goal = await storage.createGoal({
      title: "Save Money",
      type: "savings",
      target: 5000,
      unit: "dollars",
      linkedProfiles: ["p1"],
    });
    expect(goal.linkedProfiles).toEqual(["p1"]);
  });

  it("creates a goal with milestones", async () => {
    const goal = await storage.createGoal({
      title: "Run Marathon",
      type: "fitness_distance",
      target: 26.2,
      unit: "miles",
      milestones: [{ value: 5, label: "5K" }, { value: 13.1, label: "Half" }],
    });
    expect(goal.milestones.length).toBe(2);
    expect(goal.milestones[0].reached).toBe(false);
  });
});

// ============================================================
// Artifacts
// ============================================================
describe("Artifacts", () => {
  it("creates a checklist artifact", async () => {
    const artifact = await storage.createArtifact({
      type: "checklist",
      title: "Shopping",
      content: "",
      items: [{ text: "Milk", checked: false }, { text: "Eggs", checked: true }],
      tags: [],
      pinned: false,
    });
    expect(artifact.items.length).toBe(2);
    expect(artifact.items[0].text).toBe("Milk");
    expect(artifact.items[1].checked).toBe(true);
    expect(artifact.items[0].id).toBeDefined();
  });

  it("toggles a checklist item", async () => {
    const artifact = await storage.createArtifact({
      type: "checklist",
      title: "Test",
      content: "",
      items: [{ text: "Item", checked: false }],
      tags: [],
      pinned: false,
    });
    const itemId = artifact.items[0].id;
    const updated = await storage.toggleChecklistItem(artifact.id, itemId);
    expect(updated?.items[0].checked).toBe(true);
  });
});

// ============================================================
// Memory
// ============================================================
describe("Memory", () => {
  it("saves and recalls a memory", async () => {
    await storage.saveMemory({ key: "favorite_food", value: "Pizza", category: "preferences" });
    const results = await storage.recallMemory("food");
    expect(results.length).toBe(1);
    expect(results[0].value).toBe("Pizza");
  });

  it("updates existing memory with same key", async () => {
    await storage.saveMemory({ key: "name", value: "Alex" });
    await storage.saveMemory({ key: "name", value: "Alexander" });
    const results = await storage.recallMemory("name");
    expect(results.length).toBe(1);
    expect(results[0].value).toBe("Alexander");
  });
});

// ============================================================
// Trackers
// ============================================================
describe("Trackers", () => {
  it("creates a tracker", async () => {
    const tracker = await storage.createTracker({
      name: "Weight",
      category: "health",
      fields: [{ name: "weight", type: "number", unit: "lbs" }],
    });
    expect(tracker.name).toBe("Weight");
    expect(tracker.linkedProfiles).toEqual([]);
    expect(tracker.entries).toEqual([]);
  });

  it("logs an entry", async () => {
    const tracker = await storage.createTracker({
      name: "Weight",
      category: "health",
      fields: [{ name: "weight", type: "number" }],
    });
    const entry = await storage.logEntry({
      trackerId: tracker.id,
      values: { weight: 183 },
    });
    expect(entry?.values.weight).toBe(183);
    const updated = await storage.getTracker(tracker.id);
    expect(updated?.entries.length).toBe(1);
  });

  it("deletes a tracker entry", async () => {
    const tracker = await storage.createTracker({ name: "Weight", category: "health" });
    const entry = await storage.logEntry({ trackerId: tracker.id, values: { weight: 183 } });
    expect(entry).toBeDefined();
    const deleted = await storage.deleteTrackerEntry(tracker.id, entry!.id);
    expect(deleted).toBe(true);
    const updated = await storage.getTracker(tracker.id);
    expect(updated?.entries.length).toBe(0);
  });
});

// ============================================================
// Events
// ============================================================
describe("Events", () => {
  it("creates an event", async () => {
    const event = await storage.createEvent({
      title: "Meeting",
      date: "2024-06-15",
      category: "work",
      source: "manual",
      recurrence: "none",
      tags: [],
      linkedProfiles: [],
      linkedDocuments: [],
    });
    expect(event.title).toBe("Meeting");
    expect(event.source).toBe("manual");
  });

  it("gets event by id", async () => {
    const created = await storage.createEvent({
      title: "Test",
      date: "2024-01-01",
      category: "personal",
      source: "manual",
      recurrence: "none",
      tags: [],
      linkedProfiles: [],
      linkedDocuments: [],
    });
    const found = await storage.getEvent(created.id);
    expect(found?.title).toBe("Test");
  });
});

// ============================================================
// Stats (Profile Filtering)
// ============================================================
describe("Stats with Profile Filtering", () => {
  it("returns stats for all data when no filter", async () => {
    await storage.createTask({ title: "Task 1", tags: [], linkedProfiles: [] });
    await storage.createExpense({ amount: 50, description: "Lunch", category: "food", tags: [], linkedProfiles: [] });
    const stats = await storage.getStats();
    expect(stats.totalTasks).toBe(1);
    // totalExpenses is the sum of amounts, not count
    expect(stats.totalExpenses).toBe(50);
  });

  it("filters stats by profile", async () => {
    const profile = await storage.createProfile({ type: "self", name: "Me" });
    await storage.createTask({ title: "My Task", tags: [], linkedProfiles: [profile.id] });
    await storage.createTask({ title: "Other Task", tags: [], linkedProfiles: ["other-id"] });
    const stats = await storage.getStats(profile.id);
    // Self profile should see its linked tasks + unlinked tasks
    expect(stats.totalTasks).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// getDashboardEnhanced (Profile Isolation)
// ============================================================
describe("getDashboardEnhanced Profile Filtering", () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  it("returns all data when no profileId filter", async () => {
    await storage.createTask({ title: "Task A", tags: [], linkedProfiles: ["p1"], dueDate: yesterday, status: "todo" });
    await storage.createTask({ title: "Task B", tags: [], linkedProfiles: ["p2"], dueDate: yesterday, status: "todo" });
    const dashboard = await storage.getDashboardEnhanced();
    expect(dashboard.overdueTasks.length).toBe(2);
  });

  it("filters overdue tasks by profile", async () => {
    const alex = await storage.createProfile({ type: "person", name: "Alex" });
    const buddy = await storage.createProfile({ type: "pet", name: "Buddy" });
    await storage.createTask({ title: "Alex Task", tags: [], linkedProfiles: [alex.id], dueDate: yesterday, status: "todo" });
    await storage.createTask({ title: "Buddy Task", tags: [], linkedProfiles: [buddy.id], dueDate: yesterday, status: "todo" });
    await storage.createTask({ title: "Shared Task", tags: [], linkedProfiles: [alex.id, buddy.id], dueDate: yesterday, status: "todo" });

    const alexDashboard = await storage.getDashboardEnhanced(alex.id);
    const alexTaskTitles = alexDashboard.overdueTasks.map((t: any) => t.title);
    expect(alexTaskTitles).toContain("Alex Task");
    expect(alexTaskTitles).toContain("Shared Task");
    expect(alexTaskTitles).not.toContain("Buddy Task");

    const buddyDashboard = await storage.getDashboardEnhanced(buddy.id);
    const buddyTaskTitles = buddyDashboard.overdueTasks.map((t: any) => t.title);
    expect(buddyTaskTitles).toContain("Buddy Task");
    expect(buddyTaskTitles).toContain("Shared Task");
    expect(buddyTaskTitles).not.toContain("Alex Task");
  });

  it("self profile sees unlinked entities", async () => {
    const self = await storage.createProfile({ type: "self", name: "Me" });
    const other = await storage.createProfile({ type: "person", name: "Other" });
    await storage.createTask({ title: "Unlinked Task", tags: [], linkedProfiles: [], dueDate: yesterday, status: "todo" });
    await storage.createTask({ title: "Other Task", tags: [], linkedProfiles: [other.id], dueDate: yesterday, status: "todo" });

    const selfDashboard = await storage.getDashboardEnhanced(self.id);
    const selfTaskTitles = selfDashboard.overdueTasks.map((t: any) => t.title);
    expect(selfTaskTitles).toContain("Unlinked Task");
    expect(selfTaskTitles).not.toContain("Other Task");

    const otherDashboard = await storage.getDashboardEnhanced(other.id);
    const otherTaskTitles = otherDashboard.overdueTasks.map((t: any) => t.title);
    expect(otherTaskTitles).not.toContain("Unlinked Task");
    expect(otherTaskTitles).toContain("Other Task");
  });

  it("filters expenses by profile", async () => {
    const alex = await storage.createProfile({ type: "person", name: "Alex" });
    await storage.createExpense({ amount: 50, description: "Alex lunch", category: "food", tags: [], linkedProfiles: [alex.id], date: today });
    await storage.createExpense({ amount: 200, description: "Other expense", category: "auto", tags: [], linkedProfiles: ["other-id"], date: today });

    const dashboard = await storage.getDashboardEnhanced(alex.id);
    expect(dashboard.financeSnapshot.totalMonthlySpend).toBe(50);
  });

  it("filters obligations by profile", async () => {
    const alex = await storage.createProfile({ type: "person", name: "Alex" });
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    await storage.createObligation({ name: "Alex Rent", amount: 1000, frequency: "monthly", category: "housing", status: "active", linkedProfiles: [alex.id], nextDueDate: nextWeek });
    await storage.createObligation({ name: "Other Bill", amount: 500, frequency: "monthly", category: "utilities", status: "active", linkedProfiles: ["other-id"], nextDueDate: nextWeek });

    const dashboard = await storage.getDashboardEnhanced(alex.id);
    const billNames = dashboard.financeSnapshot.upcomingBills.map((b: any) => b.name);
    expect(billNames).toContain("Alex Rent");
    expect(billNames).not.toContain("Other Bill");
  });

  it("filters today's events by profile", async () => {
    const alex = await storage.createProfile({ type: "person", name: "Alex" });
    await storage.createEvent({ title: "Alex Meeting", date: today, category: "work", source: "manual", recurrence: "none", tags: [], linkedProfiles: [alex.id], linkedDocuments: [] });
    await storage.createEvent({ title: "Other Event", date: today, category: "personal", source: "manual", recurrence: "none", tags: [], linkedProfiles: ["other-id"], linkedDocuments: [] });

    const dashboard = await storage.getDashboardEnhanced(alex.id);
    const eventTitles = dashboard.todaysEvents.map((e: any) => e.title);
    expect(eventTitles).toContain("Alex Meeting");
    expect(eventTitles).not.toContain("Other Event");
  });

  it("multi-profile expense appears in both profiles but not others", async () => {
    const alex = await storage.createProfile({ type: "person", name: "Alex" });
    const sarah = await storage.createProfile({ type: "person", name: "Sarah" });
    const buddy = await storage.createProfile({ type: "pet", name: "Buddy" });
    await storage.createExpense({ amount: 300, description: "Family dinner", category: "food", tags: [], linkedProfiles: [alex.id, sarah.id], date: today });

    const alexDash = await storage.getDashboardEnhanced(alex.id);
    expect(alexDash.financeSnapshot.totalMonthlySpend).toBe(300);
    const sarahDash = await storage.getDashboardEnhanced(sarah.id);
    expect(sarahDash.financeSnapshot.totalMonthlySpend).toBe(300);
    const buddyDash = await storage.getDashboardEnhanced(buddy.id);
    expect(buddyDash.financeSnapshot.totalMonthlySpend).toBe(0);
  });
});

// ============================================================
// Calendar Timeline (Profile Filtering)
// ============================================================
describe("Calendar Timeline Profile Filtering", () => {
  it("getCalendarTimeline returns all items", async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    await storage.createEvent({ title: "Event A", date: tomorrow, category: "work", source: "manual", recurrence: "none", tags: [], linkedProfiles: ["p1"], linkedDocuments: [] });
    await storage.createEvent({ title: "Event B", date: tomorrow, category: "personal", source: "manual", recurrence: "none", tags: [], linkedProfiles: ["p2"], linkedDocuments: [] });

    const start = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const end = nextWeek;
    const items = await storage.getCalendarTimeline(start, end);
    expect(items.length).toBeGreaterThanOrEqual(2);
  });
});
