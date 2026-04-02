import { describe, it, expect } from "vitest";
import {
  insertProfileSchema,
  insertTrackerSchema,
  insertTrackerEntrySchema,
  insertTaskSchema,
  insertExpenseSchema,
  insertEventSchema,
  insertHabitSchema,
  insertObligationSchema,
  insertArtifactSchema,
  insertJournalEntrySchema,
  insertMemorySchema,
  insertGoalSchema,
  insertDocumentSchema,
  insertEntityLinkSchema,
  insertDomainSchema,
  MOOD_SCORES,
} from "@shared/schema";

// ============================================================
// Profile Schema
// ============================================================
describe("insertProfileSchema", () => {
  it("accepts valid profile", () => {
    const result = insertProfileSchema.safeParse({
      type: "person",
      name: "Alex",
    });
    expect(result.success).toBe(true);
  });

  it("requires name", () => {
    const result = insertProfileSchema.safeParse({ type: "person" });
    expect(result.success).toBe(false);
  });

  it("requires valid type", () => {
    const result = insertProfileSchema.safeParse({ type: "invalid", name: "Test" });
    expect(result.success).toBe(false);
  });

  it("accepts all profile types", () => {
    const types = ["person", "pet", "vehicle", "account", "property", "subscription", "medical", "self", "loan", "investment", "asset"];
    for (const type of types) {
      const result = insertProfileSchema.safeParse({ type, name: "Test" });
      expect(result.success).toBe(true);
    }
  });

  it("defaults fields to empty object", () => {
    const result = insertProfileSchema.parse({ type: "person", name: "Test" });
    expect(result.fields).toEqual({});
  });

  it("defaults tags to empty array", () => {
    const result = insertProfileSchema.parse({ type: "person", name: "Test" });
    expect(result.tags).toEqual([]);
  });

  it("rejects empty name", () => {
    const result = insertProfileSchema.safeParse({ type: "person", name: "" });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// Task Schema
// ============================================================
describe("insertTaskSchema", () => {
  it("accepts valid task", () => {
    const result = insertTaskSchema.safeParse({ title: "Buy groceries" });
    expect(result.success).toBe(true);
  });

  it("requires title", () => {
    expect(insertTaskSchema.safeParse({}).success).toBe(false);
    expect(insertTaskSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("defaults priority to medium", () => {
    const result = insertTaskSchema.parse({ title: "Test" });
    expect(result.priority).toBe("medium");
  });

  it("defaults linkedProfiles to empty array", () => {
    const result = insertTaskSchema.parse({ title: "Test" });
    expect(result.linkedProfiles).toEqual([]);
  });

  it("rejects invalid priority", () => {
    const result = insertTaskSchema.safeParse({ title: "Test", priority: "critical" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid priorities", () => {
    for (const p of ["low", "medium", "high"]) {
      expect(insertTaskSchema.safeParse({ title: "Test", priority: p }).success).toBe(true);
    }
  });
});

// ============================================================
// Expense Schema
// ============================================================
describe("insertExpenseSchema", () => {
  it("accepts valid expense", () => {
    const result = insertExpenseSchema.safeParse({
      amount: 50.25,
      description: "Lunch",
    });
    expect(result.success).toBe(true);
  });

  it("rejects zero amount", () => {
    expect(insertExpenseSchema.safeParse({ amount: 0, description: "Free" }).success).toBe(false);
  });

  it("rejects negative amount", () => {
    expect(insertExpenseSchema.safeParse({ amount: -10, description: "Refund" }).success).toBe(false);
  });

  it("requires description", () => {
    expect(insertExpenseSchema.safeParse({ amount: 10 }).success).toBe(false);
    expect(insertExpenseSchema.safeParse({ amount: 10, description: "" }).success).toBe(false);
  });

  it("defaults category to general", () => {
    const result = insertExpenseSchema.parse({ amount: 10, description: "Test" });
    expect(result.category).toBe("general");
  });

  it("defaults linkedProfiles to empty array", () => {
    const result = insertExpenseSchema.parse({ amount: 10, description: "Test" });
    expect(result.linkedProfiles).toEqual([]);
  });
});

// ============================================================
// Event Schema
// ============================================================
describe("insertEventSchema", () => {
  it("accepts valid event", () => {
    const result = insertEventSchema.safeParse({
      title: "Meeting",
      date: "2024-06-15",
    });
    expect(result.success).toBe(true);
  });

  it("requires title", () => {
    expect(insertEventSchema.safeParse({ date: "2024-06-15" }).success).toBe(false);
  });

  it("requires date", () => {
    expect(insertEventSchema.safeParse({ title: "Meeting" }).success).toBe(false);
  });

  it("defaults recurrence to none", () => {
    const result = insertEventSchema.parse({ title: "Meeting", date: "2024-01-01" });
    expect(result.recurrence).toBe("none");
  });

  it("defaults source to manual", () => {
    const result = insertEventSchema.parse({ title: "Meeting", date: "2024-01-01" });
    expect(result.source).toBe("manual");
  });

  it("accepts all event categories", () => {
    const categories = ["personal", "work", "health", "finance", "family", "social", "travel", "education", "other"];
    for (const cat of categories) {
      const result = insertEventSchema.safeParse({ title: "Test", date: "2024-01-01", category: cat });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all recurrence patterns", () => {
    const patterns = ["none", "daily", "weekly", "biweekly", "monthly", "yearly"];
    for (const p of patterns) {
      const result = insertEventSchema.safeParse({ title: "Test", date: "2024-01-01", recurrence: p });
      expect(result.success).toBe(true);
    }
  });
});

// ============================================================
// Habit Schema
// ============================================================
describe("insertHabitSchema", () => {
  it("accepts valid habit", () => {
    const result = insertHabitSchema.safeParse({ name: "Exercise" });
    expect(result.success).toBe(true);
  });

  it("defaults frequency to daily", () => {
    const result = insertHabitSchema.parse({ name: "Exercise" });
    expect(result.frequency).toBe("daily");
  });

  it("accepts custom targetDays", () => {
    const result = insertHabitSchema.safeParse({
      name: "Gym",
      frequency: "custom",
      targetDays: [1, 3, 5], // Mon, Wed, Fri
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid targetDays values", () => {
    const result = insertHabitSchema.safeParse({
      name: "Gym",
      targetDays: [7], // out of range
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================
// Obligation Schema
// ============================================================
describe("insertObligationSchema", () => {
  it("accepts valid obligation", () => {
    const result = insertObligationSchema.safeParse({
      name: "Netflix",
      amount: 15.99,
      nextDueDate: "2024-07-01",
    });
    expect(result.success).toBe(true);
  });

  it("rejects zero amount", () => {
    const result = insertObligationSchema.safeParse({
      name: "Free",
      amount: 0,
      nextDueDate: "2024-07-01",
    });
    expect(result.success).toBe(false);
  });

  it("defaults frequency to monthly", () => {
    const result = insertObligationSchema.parse({
      name: "Rent",
      amount: 1500,
      nextDueDate: "2024-07-01",
    });
    expect(result.frequency).toBe("monthly");
  });

  it("defaults autopay to false", () => {
    const result = insertObligationSchema.parse({
      name: "Rent",
      amount: 1500,
      nextDueDate: "2024-07-01",
    });
    expect(result.autopay).toBe(false);
  });

  it("defaults linkedProfiles to empty array", () => {
    const result = insertObligationSchema.parse({
      name: "Rent",
      amount: 1500,
      nextDueDate: "2024-07-01",
    });
    expect(result.linkedProfiles).toEqual([]);
  });
});

// ============================================================
// Journal Entry Schema
// ============================================================
describe("insertJournalEntrySchema", () => {
  it("accepts valid journal entry", () => {
    const result = insertJournalEntrySchema.safeParse({
      mood: "good",
      content: "Had a great day",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all mood levels", () => {
    const moods = ["amazing", "great", "good", "okay", "neutral", "bad", "awful", "terrible"];
    for (const mood of moods) {
      expect(insertJournalEntrySchema.safeParse({ mood }).success).toBe(true);
    }
  });

  it("rejects invalid mood", () => {
    expect(insertJournalEntrySchema.safeParse({ mood: "happy" }).success).toBe(false);
  });

  it("accepts energy in range 1-5", () => {
    expect(insertJournalEntrySchema.safeParse({ mood: "good", energy: 3 }).success).toBe(true);
    expect(insertJournalEntrySchema.safeParse({ mood: "good", energy: 0 }).success).toBe(false);
    expect(insertJournalEntrySchema.safeParse({ mood: "good", energy: 6 }).success).toBe(false);
  });
});

// ============================================================
// Goal Schema
// ============================================================
describe("insertGoalSchema", () => {
  it("accepts valid goal", () => {
    const result = insertGoalSchema.safeParse({
      title: "Lose 10 lbs",
      type: "weight_loss",
      target: 10,
      unit: "lbs",
    });
    expect(result.success).toBe(true);
  });

  it("requires all mandatory fields", () => {
    expect(insertGoalSchema.safeParse({ title: "Test" }).success).toBe(false);
    expect(insertGoalSchema.safeParse({ title: "Test", type: "custom" }).success).toBe(false);
    expect(insertGoalSchema.safeParse({ title: "Test", type: "custom", target: 10 }).success).toBe(false);
  });

  it("accepts all goal types", () => {
    const types = ["weight_loss", "weight_gain", "savings", "habit_streak", "spending_limit", "fitness_distance", "fitness_frequency", "tracker_target", "custom"];
    for (const type of types) {
      expect(insertGoalSchema.safeParse({ title: "Test", type, target: 10, unit: "x" }).success).toBe(true);
    }
  });
});

// ============================================================
// Tracker Schema
// ============================================================
describe("insertTrackerSchema", () => {
  it("accepts valid tracker", () => {
    const result = insertTrackerSchema.safeParse({ name: "Weight" });
    expect(result.success).toBe(true);
  });

  it("defaults category to custom", () => {
    const result = insertTrackerSchema.parse({ name: "Weight" });
    expect(result.category).toBe("custom");
  });

  it("accepts fields", () => {
    const result = insertTrackerSchema.safeParse({
      name: "BP",
      fields: [{ name: "systolic", type: "number" }, { name: "diastolic", type: "number" }],
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// Tracker Entry Schema
// ============================================================
describe("insertTrackerEntrySchema", () => {
  it("accepts valid entry", () => {
    const result = insertTrackerEntrySchema.safeParse({
      trackerId: "abc-123",
      values: { weight: 183 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts all mood values", () => {
    const moods = ["amazing", "great", "good", "okay", "neutral", "bad", "awful", "terrible"];
    for (const mood of moods) {
      expect(insertTrackerEntrySchema.safeParse({ trackerId: "x", values: {}, mood }).success).toBe(true);
    }
  });
});

// ============================================================
// Document Schema
// ============================================================
describe("insertDocumentSchema", () => {
  it("accepts valid document", () => {
    const result = insertDocumentSchema.safeParse({
      name: "License",
      fileData: "base64data...",
    });
    expect(result.success).toBe(true);
  });

  it("requires name and fileData", () => {
    expect(insertDocumentSchema.safeParse({ name: "License" }).success).toBe(false);
    expect(insertDocumentSchema.safeParse({ fileData: "data" }).success).toBe(false);
  });

  it("defaults type to other", () => {
    const result = insertDocumentSchema.parse({ name: "Doc", fileData: "abc" });
    expect(result.type).toBe("other");
  });
});

// ============================================================
// Artifact Schema
// ============================================================
describe("insertArtifactSchema", () => {
  it("accepts valid checklist", () => {
    const result = insertArtifactSchema.safeParse({
      type: "checklist",
      title: "Shopping List",
      items: [{ text: "Milk" }, { text: "Eggs" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid note", () => {
    const result = insertArtifactSchema.safeParse({
      type: "note",
      title: "Meeting Notes",
      content: "Discussed project timeline",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    expect(insertArtifactSchema.safeParse({ type: "todo", title: "Test" }).success).toBe(false);
  });
});

// ============================================================
// Memory Schema
// ============================================================
describe("insertMemorySchema", () => {
  it("accepts valid memory", () => {
    const result = insertMemorySchema.safeParse({
      key: "favorite_food",
      value: "Pizza",
    });
    expect(result.success).toBe(true);
  });

  it("requires key and value", () => {
    expect(insertMemorySchema.safeParse({ key: "test" }).success).toBe(false);
    expect(insertMemorySchema.safeParse({ value: "test" }).success).toBe(false);
  });

  it("defaults category to general", () => {
    const result = insertMemorySchema.parse({ key: "test", value: "val" });
    expect(result.category).toBe("general");
  });
});

// ============================================================
// Entity Link Schema
// ============================================================
describe("insertEntityLinkSchema", () => {
  it("accepts valid link", () => {
    const result = insertEntityLinkSchema.safeParse({
      sourceType: "profile",
      sourceId: "abc",
      targetType: "document",
      targetId: "def",
      relationship: "belongs_to",
    });
    expect(result.success).toBe(true);
  });

  it("defaults confidence to 1", () => {
    const result = insertEntityLinkSchema.parse({
      sourceType: "profile",
      sourceId: "abc",
      targetType: "document",
      targetId: "def",
      relationship: "belongs_to",
    });
    expect(result.confidence).toBe(1);
  });

  it("rejects confidence out of range", () => {
    expect(insertEntityLinkSchema.safeParse({
      sourceType: "profile", sourceId: "a", targetType: "doc", targetId: "b", relationship: "x", confidence: 1.5,
    }).success).toBe(false);
  });
});

// ============================================================
// Domain Schema
// ============================================================
describe("insertDomainSchema", () => {
  it("accepts valid domain", () => {
    const result = insertDomainSchema.safeParse({ name: "Recipes" });
    expect(result.success).toBe(true);
  });

  it("requires name", () => {
    expect(insertDomainSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================
// MOOD_SCORES
// ============================================================
describe("MOOD_SCORES", () => {
  it("has 8 mood levels", () => {
    expect(Object.keys(MOOD_SCORES).length).toBe(8);
  });

  it("ranges from 1 to 8", () => {
    const values = Object.values(MOOD_SCORES);
    expect(Math.min(...values)).toBe(1);
    expect(Math.max(...values)).toBe(8);
  });

  it("has all expected moods", () => {
    expect(MOOD_SCORES.amazing).toBe(8);
    expect(MOOD_SCORES.terrible).toBe(1);
    expect(MOOD_SCORES.good).toBe(6);
    expect(MOOD_SCORES.neutral).toBe(4);
  });
});
