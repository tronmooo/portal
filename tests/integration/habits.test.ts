/**
 * Integration tests — Habits API
 * Covers: CRUD, check-in, streak tracking
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "./mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "./setup";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

describe("Habits API", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("GET /api/habits returns empty array", async () => {
    const res = await request(app).get("/api/habits");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST /api/habits creates habit with defaults", async () => {
    const res = await request(app)
      .post("/api/habits")
      .send({ name: "Drink water" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Drink water");
    expect(res.body.frequency).toBe("daily");
    expect(res.body.currentStreak).toBe(0);
    expect(res.body.longestStreak).toBe(0);
    expect(res.body.checkins).toEqual([]);
  });

  it("POST /api/habits returns 400 for empty name", async () => {
    const res = await request(app).post("/api/habits").send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("POST /api/habits supports weekly frequency", async () => {
    const res = await request(app)
      .post("/api/habits")
      .send({ name: "Go to gym", frequency: "weekly" });

    expect(res.status).toBe(201);
    expect(res.body.frequency).toBe("weekly");
  });

  it("POST /api/habits supports custom frequency with targetDays", async () => {
    const res = await request(app)
      .post("/api/habits")
      .send({
        name: "MWF Workout",
        frequency: "custom",
        targetDays: [1, 3, 5],
      });

    expect(res.status).toBe(201);
    expect(res.body.targetDays).toEqual([1, 3, 5]);
  });

  it("POST /api/habits/:id/checkin records a checkin today", async () => {
    const habit = await mockStorage.createHabit({ name: "Meditate" });

    const res = await request(app).post(`/api/habits/${habit.id}/checkin`).send({});

    expect(res.status).toBe(201);
    expect(res.body.date).toBeTruthy();
    expect(res.body.id).toBeTruthy();
  });

  it("checkin increases streak", async () => {
    const habit = await mockStorage.createHabit({ name: "Push-ups" });

    await request(app).post(`/api/habits/${habit.id}/checkin`).send({});

    const res = await request(app).get("/api/habits");
    const found = res.body.find((h: any) => h.id === habit.id);
    expect(found.currentStreak).toBeGreaterThan(0);
  });

  it("checkin with custom value", async () => {
    const habit = await mockStorage.createHabit({ name: "Glasses of water" });

    const res = await request(app)
      .post(`/api/habits/${habit.id}/checkin`)
      .send({ value: 8, notes: "Good day!" });

    expect(res.status).toBe(201);
    expect(res.body.value).toBe(8);
    expect(res.body.notes).toBe("Good day!");
  });

  it("POST /api/habits/:id/checkin returns 404 for nonexistent habit", async () => {
    const res = await request(app).post("/api/habits/ghost/checkin").send({});
    expect(res.status).toBe(404);
  });

  it("DELETE /api/habits/:id removes habit", async () => {
    const habit = await mockStorage.createHabit({ name: "Temp habit" });

    const del = await request(app).delete(`/api/habits/${habit.id}`);
    expect(del.status).toBe(204);

    const list = await request(app).get("/api/habits");
    expect(list.body.length).toBe(0);
  });

  it("can log multiple checkins to the same habit", async () => {
    const habit = await mockStorage.createHabit({ name: "Daily run" });

    for (const date of ["2024-06-01", "2024-06-02", "2024-06-03"]) {
      await request(app)
        .post(`/api/habits/${habit.id}/checkin`)
        .send({ date });
    }

    const res = await request(app).get("/api/habits");
    const found = res.body.find((h: any) => h.id === habit.id);
    expect(found.checkins.length).toBe(3);
  });
});
