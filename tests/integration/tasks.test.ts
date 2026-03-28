/**
 * Integration tests — Tasks API
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "./mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "./setup";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

describe("Tasks API", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("GET /api/tasks returns empty array", async () => {
    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST /api/tasks creates task with default status=todo", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "Buy groceries" });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Buy groceries");
    expect(res.body.status).toBe("todo");
    expect(res.body.priority).toBe("medium");
  });

  it("POST /api/tasks accepts all priority levels", async () => {
    for (const priority of ["low", "medium", "high"]) {
      const res = await request(app)
        .post("/api/tasks")
        .send({ title: `${priority} task`, priority });
      expect(res.status).toBe(201);
      expect(res.body.priority).toBe(priority);
    }
  });

  it("POST /api/tasks returns 400 for empty title", async () => {
    const res = await request(app).post("/api/tasks").send({ title: "" });
    expect(res.status).toBe(400);
  });

  it("PATCH /api/tasks/:id updates status", async () => {
    const task = await mockStorage.createTask({ title: "Do laundry" });

    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("PATCH /api/tasks/:id marks task done", async () => {
    const task = await mockStorage.createTask({ title: "Fix bug" });

    const res = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("PATCH /api/tasks/:id returns 404 for nonexistent task", async () => {
    const res = await request(app)
      .patch("/api/tasks/ghost")
      .send({ status: "done" });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/tasks/:id removes task", async () => {
    const task = await mockStorage.createTask({ title: "Temp task" });

    const del = await request(app).delete(`/api/tasks/${task.id}`);
    expect(del.status).toBe(204);

    const list = await request(app).get("/api/tasks");
    expect(list.body.length).toBe(0);
  });

  it("DELETE nonexistent task returns 404", async () => {
    const res = await request(app).delete("/api/tasks/nobody");
    expect(res.status).toBe(404);
  });

  it("task can be linked to profiles", async () => {
    const profile = await mockStorage.createProfile({
      type: "person",
      name: "Alice",
    });

    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "Visit Alice", linkedProfiles: [profile.id] });

    expect(res.status).toBe(201);
    expect(res.body.linkedProfiles).toContain(profile.id);
  });

  it("task supports due date", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "Submit report", dueDate: "2024-12-31" });

    expect(res.status).toBe(201);
    expect(res.body.dueDate).toBe("2024-12-31");
  });

  it("GET /api/tasks returns all tasks", async () => {
    await mockStorage.createTask({ title: "Task 1" });
    await mockStorage.createTask({ title: "Task 2" });
    await mockStorage.createTask({ title: "Task 3" });

    const res = await request(app).get("/api/tasks");
    expect(res.body.length).toBe(3);
  });
});
