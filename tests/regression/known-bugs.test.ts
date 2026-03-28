/**
 * Regression tests — Known bugs that have been fixed.
 * Add a test here for every bug fix to prevent regressions.
 *
 * Format: describe the bug, what caused it, what the fix was, and test it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "../integration/mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "../integration/setup";
import {
  insertExpenseSchema,
  insertObligationSchema,
  insertTrackerEntrySchema,
  insertProfileSchema,
  insertEntityLinkSchema,
} from "../../shared/schema";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

// ── Bug: C-1 — Global storage race condition ──────────────────────────────────
// Bug: Storage singleton caused cross-user data leakage under concurrent requests.
// Fix: AsyncLocalStorage provides per-request scoped storage.
describe("Bug C-1: Per-request storage isolation", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("simultaneous requests do not share data state", async () => {
    // Create two separate expense amounts in parallel
    const [res1, res2] = await Promise.all([
      request(app)
        .post("/api/expenses")
        .send({ amount: 111, description: "Request 1" }),
      request(app)
        .post("/api/expenses")
        .send({ amount: 222, description: "Request 2" }),
    ]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    // Each should get its own ID
    expect(res1.body.id).not.toBe(res2.body.id);
    // Amounts should not be swapped
    expect(res1.body.amount).toBe(111);
    expect(res2.body.amount).toBe(222);
  });
});

// ── Bug: Negative expense amounts were accepted ───────────────────────────────
// Bug: Expenses with negative amounts created invalid data and broke totals.
// Fix: Zod schema now enforces amount > 0.
describe("Bug: Negative expense validation", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("rejects negative expense amounts at API level", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .send({ amount: -10, description: "Negative" });
    expect(res.status).toBe(400);
  });

  it("rejects zero expense amounts at schema level", () => {
    const result = insertExpenseSchema.safeParse({ amount: 0, description: "Zero" });
    expect(result.success).toBe(false);
  });

  it("rejects zero obligation amounts at schema level", () => {
    const result = insertObligationSchema.safeParse({
      name: "Free",
      amount: 0,
      nextDueDate: "2024-07-01",
    });
    expect(result.success).toBe(false);
  });
});

// ── Bug: Profile type validation ──────────────────────────────────────────────
// Bug: Invalid profile types were stored, causing UI rendering errors.
// Fix: Zod enum validation on insertProfileSchema.
describe("Bug: Profile type validation", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("rejects unknown profile types", async () => {
    const res = await request(app)
      .post("/api/profiles")
      .send({ type: "spaceship", name: "USS Enterprise" });
    expect(res.status).toBe(400);
  });

  it("rejects empty profile name", async () => {
    const res = await request(app)
      .post("/api/profiles")
      .send({ type: "person", name: "" });
    expect(res.status).toBe(400);
  });
});

// ── Bug: Tracker entry for nonexistent tracker ────────────────────────────────
// Bug: Logging an entry for a nonexistent tracker ID silently failed,
//      returning 200 with no data instead of 404.
// Fix: Check tracker existence before creating entry.
describe("Bug: Tracker entry 404 handling", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("returns 404 when logging entry to nonexistent tracker", async () => {
    const res = await request(app)
      .post("/api/trackers/does-not-exist/entries")
      .send({ trackerId: "does-not-exist", values: { weight: 175 } });
    expect(res.status).toBe(404);
  });
});

// ── Bug: Habit checkin for nonexistent habit ──────────────────────────────────
// Bug: Checking in to a nonexistent habit returned 200 with null.
// Fix: Return 404 when habit not found.
describe("Bug: Habit checkin 404 handling", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("returns 404 when checking into nonexistent habit", async () => {
    const res = await request(app)
      .post("/api/habits/nonexistent-habit/checkin")
      .send({});
    expect(res.status).toBe(404);
  });
});

// ── Bug: Obligation payment for nonexistent obligation ───────────────────────
// Bug: Paying a nonexistent obligation created orphan payment records.
// Fix: Validate obligation exists before creating payment.
describe("Bug: Obligation payment 404 handling", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("returns 404 when paying nonexistent obligation", async () => {
    const res = await request(app)
      .post("/api/obligations/ghost-obligation/pay")
      .send({ amount: 100 });
    expect(res.status).toBe(404);
  });
});

// ── Bug: PATCH nonexistent resources returning 200 ───────────────────────────
// Bug: Updating a nonexistent resource returned 200 with null body
//      instead of 404, causing silent data loss in the UI.
describe("Bug: PATCH returns 404 for nonexistent resources", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("PATCH /api/profiles/:id returns 404 for nonexistent profile", async () => {
    const res = await request(app)
      .patch("/api/profiles/ghost")
      .send({ name: "Ghost" });
    expect(res.status).toBe(404);
  });

  it("PATCH /api/tasks/:id returns 404 for nonexistent task", async () => {
    const res = await request(app)
      .patch("/api/tasks/ghost")
      .send({ status: "done" });
    expect(res.status).toBe(404);
  });

  it("PATCH /api/expenses/:id returns 404 for nonexistent expense", async () => {
    const res = await request(app)
      .patch("/api/expenses/ghost")
      .send({ amount: 99 });
    expect(res.status).toBe(404);
  });

  it("PATCH /api/events/:id returns 404 for nonexistent event", async () => {
    const res = await request(app)
      .patch("/api/events/ghost")
      .send({ title: "Ghost" });
    expect(res.status).toBe(404);
  });
});

// ── Bug: Mood validation ──────────────────────────────────────────────────────
// Bug: Invalid mood values were stored, causing chart rendering errors.
// Fix: Zod enum validation.
describe("Bug: Tracker entry mood validation", () => {
  it("rejects invalid mood values at schema level", () => {
    const result = insertTrackerEntrySchema.safeParse({
      trackerId: "x",
      values: {},
      mood: "amazing", // valid for journal, NOT for tracker entries
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid tracker mood values", () => {
    for (const mood of ["great", "good", "okay", "bad", "terrible"]) {
      const result = insertTrackerEntrySchema.safeParse({
        trackerId: "x",
        values: {},
        mood,
      });
      expect(result.success).toBe(true);
    }
  });
});

// ── Bug: Memory upsert — duplicate keys create duplicates ────────────────────
// Bug: Saving a memory with an existing key created a duplicate instead of updating.
// Fix: InMemoryStorage.saveMemory checks for existing key and updates.
describe("Bug: Memory upsert behavior", () => {
  it("saving same memory key twice updates the value, not duplicates", async () => {
    const storage = new InMemoryStorage();
    await storage.saveMemory({ key: "birthday", value: "1990-01-01" });
    await storage.saveMemory({ key: "birthday", value: "1990-01-15" });

    const memories = await storage.getMemories();
    const birthday = memories.filter((m) => m.key === "birthday");
    expect(birthday.length).toBe(1);
    expect(birthday[0].value).toBe("1990-01-15"); // Updated value
  });
});

// ── Bug: Entity link confidence out of bounds ─────────────────────────────────
// Bug: Entity links could be created with confidence > 1 or < 0.
// Fix: Zod min(0).max(1) validation.
describe("Bug: Entity link confidence validation", () => {
  it("rejects confidence > 1", () => {
    const result = insertEntityLinkSchema.safeParse({
      sourceType: "profile",
      sourceId: "p1",
      targetType: "document",
      targetId: "d1",
      relationship: "owns",
      confidence: 1.1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    const result = insertEntityLinkSchema.safeParse({
      sourceType: "profile",
      sourceId: "p1",
      targetType: "document",
      targetId: "d1",
      relationship: "owns",
      confidence: -0.1,
    });
    expect(result.success).toBe(false);
  });
});
