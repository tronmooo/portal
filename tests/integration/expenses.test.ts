/**
 * Integration tests — Expenses API
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "./mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "./setup";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

describe("Expenses API", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("GET /api/expenses returns empty array", async () => {
    const res = await request(app).get("/api/expenses");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST /api/expenses creates expense", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .send({ amount: 12.5, description: "Coffee", category: "food" });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(12.5);
    expect(res.body.description).toBe("Coffee");
    expect(res.body.category).toBe("food");
  });

  it("POST /api/expenses rejects negative amount", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .send({ amount: -5, description: "Refund" });

    expect(res.status).toBe(400);
  });

  it("POST /api/expenses rejects zero amount", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .send({ amount: 0, description: "Free" });

    expect(res.status).toBe(400);
  });

  it("POST /api/expenses rejects missing description", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .send({ amount: 10 });

    expect(res.status).toBe(400);
  });

  it("POST /api/expenses defaults category to general", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .send({ amount: 10, description: "Misc" });

    expect(res.status).toBe(201);
    expect(res.body.category).toBe("general");
  });

  it("POST /api/expenses accepts optional vendor", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .send({ amount: 50, description: "Grocery run", vendor: "Whole Foods" });

    expect(res.status).toBe(201);
    expect(res.body.vendor).toBe("Whole Foods");
  });

  it("POST /api/expenses marks recurring expense", async () => {
    const res = await request(app)
      .post("/api/expenses")
      .send({ amount: 200, description: "Gym membership", isRecurring: true });

    expect(res.status).toBe(201);
    expect(res.body.isRecurring).toBe(true);
  });

  it("PATCH /api/expenses/:id updates amount", async () => {
    const expense = await mockStorage.createExpense({
      amount: 10,
      description: "Coffee",
    });

    const res = await request(app)
      .patch(`/api/expenses/${expense.id}`)
      .send({ amount: 15 });

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(15);
  });

  it("PATCH /api/expenses/:id returns 404 for nonexistent expense", async () => {
    const res = await request(app)
      .patch("/api/expenses/ghost")
      .send({ amount: 10 });

    expect(res.status).toBe(404);
  });

  it("DELETE /api/expenses/:id removes expense", async () => {
    const expense = await mockStorage.createExpense({
      amount: 100,
      description: "Test",
    });

    const del = await request(app).delete(`/api/expenses/${expense.id}`);
    expect(del.status).toBe(204);

    const list = await request(app).get("/api/expenses");
    expect(list.body.length).toBe(0);
  });

  it("expense can be linked to a profile", async () => {
    const profile = await mockStorage.createProfile({
      type: "vehicle",
      name: "My Car",
    });

    const res = await request(app)
      .post("/api/expenses")
      .send({
        amount: 45.0,
        description: "Gas fill-up",
        linkedProfiles: [profile.id],
      });

    expect(res.status).toBe(201);
    expect(res.body.linkedProfiles).toContain(profile.id);
  });
});
