/**
 * Unit tests for shared/schema.ts — Zod validation boundaries.
 * These are pure tests with no I/O and run very fast.
 */

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
  insertDomainSchema,
  insertGoalSchema,
  insertEntityLinkSchema,
  EVENT_CATEGORY_COLORS,
} from "../../shared/schema";

// ── Profile ───────────────────────────────────────────────────────────────────

describe("insertProfileSchema", () => {
  it("accepts valid profile data", () => {
    const result = insertProfileSchema.safeParse({
      type: "person",
      name: "Alice",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing name", () => {
    const result = insertProfileSchema.safeParse({ type: "person", name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid profile type", () => {
    const result = insertProfileSchema.safeParse({
      type: "alien",
      name: "Bob",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid profile types", () => {
    const types = [
      "person","pet","vehicle","account","property",
      "subscription","medical","self","loan","investment","asset",
    ];
    for (const type of types) {
      const result = insertProfileSchema.safeParse({ type, name: "Test" });
      expect(result.success).toBe(true);
    }
  });

  it("defaults fields to empty object", () => {
    const result = insertProfileSchema.parse({ type: "self", name: "Me" });
    expect(result.fields).toEqual({});
  });

  it("defaults tags to empty array", () => {
    const result = insertProfileSchema.parse({ type: "self", name: "Me" });
    expect(result.tags).toEqual([]);
  });

  it("defaults notes to empty string", () => {
    const result = insertProfileSchema.parse({ type: "self", name: "Me" });
    expect(result.notes).toBe("");
  });

  it("accepts optional parentProfileId", () => {
    const result = insertProfileSchema.parse({
      type: "asset",
      name: "Car",
      parentProfileId: "parent-123",
    });
    expect(result.parentProfileId).toBe("parent-123");
  });
});

// ── Tracker ───────────────────────────────────────────────────────────────────

describe("insertTrackerSchema", () => {
  it("accepts minimal valid tracker", () => {
    const result = insertTrackerSchema.safeParse({ name: "Weight" });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = insertTrackerSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("defaults category to custom", () => {
    const result = insertTrackerSchema.parse({ name: "My Tracker" });
    expect(result.category).toBe("custom");
  });

  it("accepts valid field types", () => {
    const result = insertTrackerSchema.parse({
      name: "Workout",
      fields: [
        { name: "duration", type: "duration" },
        { name: "reps", type: "number" },
        { name: "notes", type: "text" },
        { name: "done", type: "boolean" },
        { name: "mood", type: "select", options: ["good", "bad"] },
      ],
    });
    expect(result.fields).toHaveLength(5);
  });

  it("rejects invalid field type", () => {
    const result = insertTrackerSchema.safeParse({
      name: "Bad",
      fields: [{ name: "x", type: "invalid_type" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("insertTrackerEntrySchema", () => {
  it("accepts valid entry", () => {
    const result = insertTrackerEntrySchema.parse({
      trackerId: "abc",
      values: { weight: 175 },
    });
    expect(result.trackerId).toBe("abc");
  });

  it("accepts mood enum values", () => {
    const moods = ["great", "good", "okay", "bad", "terrible"];
    for (const mood of moods) {
      const result = insertTrackerEntrySchema.safeParse({
        trackerId: "x",
        values: {},
        mood,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid mood", () => {
    const result = insertTrackerEntrySchema.safeParse({
      trackerId: "x",
      values: {},
      mood: "excellent",
    });
    expect(result.success).toBe(false);
  });
});

// ── Task ─────────────────────────────────────────────────────────────────────

describe("insertTaskSchema", () => {
  it("accepts minimal valid task", () => {
    const result = insertTaskSchema.safeParse({ title: "Buy milk" });
    expect(result.success).toBe(true);
  });

  it("rejects empty title", () => {
    const result = insertTaskSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });

  it("defaults priority to medium", () => {
    const result = insertTaskSchema.parse({ title: "Do thing" });
    expect(result.priority).toBe("medium");
  });

  it("accepts all priority levels", () => {
    for (const priority of ["low", "medium", "high"]) {
      const result = insertTaskSchema.safeParse({ title: "T", priority });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid priority", () => {
    const result = insertTaskSchema.safeParse({
      title: "T",
      priority: "urgent",
    });
    expect(result.success).toBe(false);
  });
});

// ── Expense ───────────────────────────────────────────────────────────────────

describe("insertExpenseSchema", () => {
  it("accepts valid expense", () => {
    const result = insertExpenseSchema.safeParse({
      amount: 42.5,
      description: "Lunch",
    });
    expect(result.success).toBe(true);
  });

  it("rejects zero amount", () => {
    const result = insertExpenseSchema.safeParse({
      amount: 0,
      description: "Free lunch",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative amount", () => {
    const result = insertExpenseSchema.safeParse({
      amount: -10,
      description: "Refund",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty description", () => {
    const result = insertExpenseSchema.safeParse({
      amount: 10,
      description: "",
    });
    expect(result.success).toBe(false);
  });

  it("defaults category to general", () => {
    const result = insertExpenseSchema.parse({ amount: 10, description: "x" });
    expect(result.category).toBe("general");
  });
});

// ── Event ─────────────────────────────────────────────────────────────────────

describe("insertEventSchema", () => {
  it("accepts minimal event", () => {
    const result = insertEventSchema.safeParse({
      title: "Doctor Appointment",
      date: "2024-06-01",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty title", () => {
    const result = insertEventSchema.safeParse({ title: "", date: "2024-06-01" });
    expect(result.success).toBe(false);
  });

  it("defaults allDay to false", () => {
    const result = insertEventSchema.parse({ title: "T", date: "2024-01-01" });
    expect(result.allDay).toBe(false);
  });

  it("defaults recurrence to none", () => {
    const result = insertEventSchema.parse({ title: "T", date: "2024-01-01" });
    expect(result.recurrence).toBe("none");
  });

  it("accepts all recurrence patterns", () => {
    const patterns = ["none", "daily", "weekly", "biweekly", "monthly", "yearly"];
    for (const recurrence of patterns) {
      const result = insertEventSchema.safeParse({
        title: "T",
        date: "2024-01-01",
        recurrence,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all event categories", () => {
    const categories = [
      "personal","work","health","finance",
      "family","social","travel","education","other",
    ];
    for (const category of categories) {
      const result = insertEventSchema.safeParse({
        title: "T",
        date: "2024-01-01",
        category,
      });
      expect(result.success).toBe(true);
    }
  });
});

// ── Habit ─────────────────────────────────────────────────────────────────────

describe("insertHabitSchema", () => {
  it("accepts minimal habit", () => {
    const result = insertHabitSchema.safeParse({ name: "Exercise" });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = insertHabitSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("defaults frequency to daily", () => {
    const result = insertHabitSchema.parse({ name: "Meditate" });
    expect(result.frequency).toBe("daily");
  });

  it("accepts custom frequency with targetDays", () => {
    const result = insertHabitSchema.parse({
      name: "Gym",
      frequency: "custom",
      targetDays: [1, 3, 5], // Mon, Wed, Fri
    });
    expect(result.targetDays).toEqual([1, 3, 5]);
  });

  it("rejects targetDays out of range", () => {
    const result = insertHabitSchema.safeParse({
      name: "Gym",
      targetDays: [0, 7], // 7 is invalid (0-6 only)
    });
    expect(result.success).toBe(false);
  });
});

// ── Obligation ────────────────────────────────────────────────────────────────

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
      name: "Netflix",
      amount: 0,
      nextDueDate: "2024-07-01",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative amount", () => {
    const result = insertObligationSchema.safeParse({
      name: "Netflix",
      amount: -5,
      nextDueDate: "2024-07-01",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all frequency values", () => {
    const freqs = ["weekly","biweekly","monthly","quarterly","yearly","once"];
    for (const frequency of freqs) {
      const result = insertObligationSchema.safeParse({
        name: "Bill",
        amount: 10,
        nextDueDate: "2024-07-01",
        frequency,
      });
      expect(result.success).toBe(true);
    }
  });

  it("defaults autopay to false", () => {
    const result = insertObligationSchema.parse({
      name: "Rent",
      amount: 1200,
      nextDueDate: "2024-07-01",
    });
    expect(result.autopay).toBe(false);
  });
});

// ── Artifact ──────────────────────────────────────────────────────────────────

describe("insertArtifactSchema", () => {
  it("accepts valid note", () => {
    const result = insertArtifactSchema.safeParse({
      type: "note",
      title: "My Note",
      content: "Some text here",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid checklist", () => {
    const result = insertArtifactSchema.safeParse({
      type: "checklist",
      title: "Shopping",
      items: [{ text: "Milk" }, { text: "Eggs", checked: true }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const result = insertArtifactSchema.safeParse({
      type: "todo",
      title: "Bad",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const result = insertArtifactSchema.safeParse({
      type: "note",
      title: "",
    });
    expect(result.success).toBe(false);
  });
});

// ── Journal ───────────────────────────────────────────────────────────────────

describe("insertJournalEntrySchema", () => {
  it("accepts valid entry", () => {
    const result = insertJournalEntrySchema.safeParse({ mood: "good" });
    expect(result.success).toBe(true);
  });

  it("accepts all mood levels", () => {
    const moods = ["amazing","great","good","okay","neutral","bad","awful","terrible"];
    for (const mood of moods) {
      const result = insertJournalEntrySchema.safeParse({ mood });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid mood", () => {
    const result = insertJournalEntrySchema.safeParse({ mood: "meh" });
    expect(result.success).toBe(false);
  });

  it("rejects energy outside 1-5", () => {
    expect(insertJournalEntrySchema.safeParse({ mood: "good", energy: 0 }).success).toBe(false);
    expect(insertJournalEntrySchema.safeParse({ mood: "good", energy: 6 }).success).toBe(false);
    expect(insertJournalEntrySchema.safeParse({ mood: "good", energy: 3 }).success).toBe(true);
  });
});

// ── Memory ────────────────────────────────────────────────────────────────────

describe("insertMemorySchema", () => {
  it("accepts valid memory", () => {
    const result = insertMemorySchema.safeParse({
      key: "favorite_food",
      value: "pizza",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty key", () => {
    const result = insertMemorySchema.safeParse({ key: "", value: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects empty value", () => {
    const result = insertMemorySchema.safeParse({ key: "x", value: "" });
    expect(result.success).toBe(false);
  });

  it("defaults category to general", () => {
    const result = insertMemorySchema.parse({ key: "x", value: "y" });
    expect(result.category).toBe("general");
  });
});

// ── Entity Link ───────────────────────────────────────────────────────────────

describe("insertEntityLinkSchema", () => {
  it("accepts valid link", () => {
    const result = insertEntityLinkSchema.safeParse({
      sourceType: "profile",
      sourceId: "p1",
      targetType: "document",
      targetId: "d1",
      relationship: "document_for",
    });
    expect(result.success).toBe(true);
  });

  it("rejects confidence out of 0-1 range", () => {
    const result = insertEntityLinkSchema.safeParse({
      sourceType: "profile",
      sourceId: "p1",
      targetType: "document",
      targetId: "d1",
      relationship: "related_to",
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("defaults confidence to 1", () => {
    const result = insertEntityLinkSchema.parse({
      sourceType: "a",
      sourceId: "1",
      targetType: "b",
      targetId: "2",
      relationship: "related",
    });
    expect(result.confidence).toBe(1);
  });
});

// ── EVENT_CATEGORY_COLORS ─────────────────────────────────────────────────────

describe("EVENT_CATEGORY_COLORS", () => {
  it("has a color for every event category", () => {
    const categories = [
      "personal","work","health","finance",
      "family","social","travel","education","other",
    ];
    for (const cat of categories) {
      expect(EVENT_CATEGORY_COLORS[cat as keyof typeof EVENT_CATEGORY_COLORS]).toBeDefined();
      expect(EVENT_CATEGORY_COLORS[cat as keyof typeof EVENT_CATEGORY_COLORS]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
