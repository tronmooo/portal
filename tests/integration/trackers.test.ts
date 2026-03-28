/**
 * Integration tests — Trackers + Entries API
 * Covers: CRUD trackers, log entries, delete entries, profile linking
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "./mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "./setup";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

describe("Trackers API", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  // ── GET /api/trackers ────────────────────────────────────────────────────

  it("GET /api/trackers returns empty array initially", async () => {
    const res = await request(app).get("/api/trackers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // ── POST /api/trackers ───────────────────────────────────────────────────

  it("POST /api/trackers creates tracker", async () => {
    const res = await request(app)
      .post("/api/trackers")
      .send({ name: "Weight", category: "health", unit: "lbs" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Weight");
    expect(res.body.category).toBe("health");
    expect(res.body.unit).toBe("lbs");
    expect(res.body.id).toBeTruthy();
    expect(res.body.entries).toEqual([]);
  });

  it("POST /api/trackers returns 400 for empty name", async () => {
    const res = await request(app)
      .post("/api/trackers")
      .send({ name: "" });

    expect(res.status).toBe(400);
  });

  it("POST /api/trackers creates tracker with fields", async () => {
    const res = await request(app)
      .post("/api/trackers")
      .send({
        name: "Workout",
        fields: [
          { name: "duration", type: "duration", unit: "min", isPrimary: true },
          { name: "type", type: "select", options: ["cardio", "strength"] },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.fields).toHaveLength(2);
    expect(res.body.fields[0].isPrimary).toBe(true);
  });

  // ── POST /api/trackers/:id/entries ───────────────────────────────────────

  it("POST /api/trackers/:id/entries logs an entry", async () => {
    const tracker = await mockStorage.createTracker({ name: "Steps" });

    const res = await request(app)
      .post(`/api/trackers/${tracker.id}/entries`)
      .send({
        trackerId: tracker.id,
        values: { steps: 8500 },
        mood: "good",
      });

    expect(res.status).toBe(201);
    expect(res.body.values.steps).toBe(8500);
    expect(res.body.mood).toBe("good");
    expect(res.body.id).toBeTruthy();
  });

  it("POST /api/trackers/:id/entries returns 404 for nonexistent tracker", async () => {
    const res = await request(app)
      .post("/api/trackers/ghost-tracker/entries")
      .send({ trackerId: "ghost-tracker", values: { x: 1 } });

    expect(res.status).toBe(404);
  });

  it("entry appears in tracker's entry list after logging", async () => {
    const tracker = await mockStorage.createTracker({ name: "Blood Pressure" });

    await request(app)
      .post(`/api/trackers/${tracker.id}/entries`)
      .send({ trackerId: tracker.id, values: { systolic: 120, diastolic: 80 } });

    const res = await request(app).get(`/api/trackers/${tracker.id}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(1);
    expect(res.body.entries[0].values.systolic).toBe(120);
  });

  it("can log multiple entries to the same tracker", async () => {
    const tracker = await mockStorage.createTracker({ name: "Weight" });

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/trackers/${tracker.id}/entries`)
        .send({ trackerId: tracker.id, values: { weight: 170 + i } });
    }

    const res = await request(app).get(`/api/trackers/${tracker.id}`);
    expect(res.body.entries.length).toBe(3);
  });

  // ── DELETE /api/trackers/:id/entries/:entryId ────────────────────────────

  it("DELETE entry removes it from the tracker", async () => {
    const tracker = await mockStorage.createTracker({ name: "Sleep" });
    const entryRes = await request(app)
      .post(`/api/trackers/${tracker.id}/entries`)
      .send({ trackerId: tracker.id, values: { hours: 7.5 } });

    const entryId = entryRes.body.id;

    const del = await request(app).delete(
      `/api/trackers/${tracker.id}/entries/${entryId}`
    );
    expect(del.status).toBe(204);

    const check = await request(app).get(`/api/trackers/${tracker.id}`);
    expect(check.body.entries.length).toBe(0);
  });

  // ── PATCH /api/trackers/:id ──────────────────────────────────────────────

  it("PATCH /api/trackers/:id updates tracker name", async () => {
    const tracker = await mockStorage.createTracker({ name: "Old Name" });

    const res = await request(app)
      .patch(`/api/trackers/${tracker.id}`)
      .send({ name: "New Name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
  });

  // ── DELETE /api/trackers/:id ─────────────────────────────────────────────

  it("DELETE /api/trackers/:id removes the tracker", async () => {
    const tracker = await mockStorage.createTracker({ name: "Temp" });

    const del = await request(app).delete(`/api/trackers/${tracker.id}`);
    expect(del.status).toBe(204);

    const list = await request(app).get("/api/trackers");
    expect(list.body.length).toBe(0);
  });

  it("DELETE nonexistent tracker returns 404", async () => {
    const res = await request(app).delete("/api/trackers/nope");
    expect(res.status).toBe(404);
  });
});
