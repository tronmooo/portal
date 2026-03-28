/**
 * Integration tests — Calendar Events API
 * Covers: CRUD, recurrence, categories, timeline endpoint
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "./mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "./setup";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

describe("Events API", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("GET /api/events returns empty array", async () => {
    const res = await request(app).get("/api/events");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST /api/events creates event", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({ title: "Team Meeting", date: "2024-06-15", time: "10:00" });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe("Team Meeting");
    expect(res.body.date).toBe("2024-06-15");
    expect(res.body.time).toBe("10:00");
    expect(res.body.source).toBe("manual");
  });

  it("POST /api/events returns 400 for empty title", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({ title: "", date: "2024-06-15" });

    expect(res.status).toBe(400);
  });

  it("POST /api/events accepts all-day flag", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({ title: "Holiday", date: "2024-07-04", allDay: true });

    expect(res.status).toBe(201);
    expect(res.body.allDay).toBe(true);
  });

  it("POST /api/events supports recurring events", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({
        title: "Weekly Standup",
        date: "2024-06-03",
        time: "09:00",
        recurrence: "weekly",
        recurrenceEnd: "2024-12-31",
      });

    expect(res.status).toBe(201);
    expect(res.body.recurrence).toBe("weekly");
    expect(res.body.recurrenceEnd).toBe("2024-12-31");
  });

  it("POST /api/events accepts all recurrence patterns", async () => {
    const patterns = ["none","daily","weekly","biweekly","monthly","yearly"];
    for (const recurrence of patterns) {
      const res = await request(app)
        .post("/api/events")
        .send({ title: `${recurrence} event`, date: "2024-06-01", recurrence });
      expect(res.status).toBe(201);
    }
  });

  it("POST /api/events accepts all category types", async () => {
    const categories = [
      "personal","work","health","finance",
      "family","social","travel","education","other",
    ];
    for (const category of categories) {
      const res = await request(app)
        .post("/api/events")
        .send({ title: `${category} event`, date: "2024-06-01", category });
      expect(res.status).toBe(201);
      expect(res.body.category).toBe(category);
    }
  });

  it("POST /api/events with source=chat marks AI-created event", async () => {
    const res = await request(app)
      .post("/api/events")
      .send({
        title: "Doctor Appointment",
        date: "2024-06-20",
        source: "chat",
      });

    expect(res.status).toBe(201);
    expect(res.body.source).toBe("chat");
  });

  it("PATCH /api/events/:id updates event", async () => {
    const event = await mockStorage.createEvent({
      title: "Old Title",
      date: "2024-06-01",
    });

    const res = await request(app)
      .patch(`/api/events/${event.id}`)
      .send({ title: "Updated Title", date: "2024-06-02" });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Updated Title");
  });

  it("PATCH /api/events/:id returns 404 for nonexistent", async () => {
    const res = await request(app)
      .patch("/api/events/ghost")
      .send({ title: "Nope" });

    expect(res.status).toBe(404);
  });

  it("DELETE /api/events/:id removes event", async () => {
    const event = await mockStorage.createEvent({
      title: "Temp",
      date: "2024-06-01",
    });

    const del = await request(app).delete(`/api/events/${event.id}`);
    expect(del.status).toBe(204);

    const list = await request(app).get("/api/events");
    expect(list.body.length).toBe(0);
  });

  it("event can be linked to profiles", async () => {
    const profile = await mockStorage.createProfile({
      type: "medical",
      name: "Dr Smith",
    });

    const res = await request(app)
      .post("/api/events")
      .send({
        title: "Checkup",
        date: "2024-06-20",
        linkedProfiles: [profile.id],
      });

    expect(res.status).toBe(201);
    expect(res.body.linkedProfiles).toContain(profile.id);
  });

  // ── Calendar timeline ────────────────────────────────────────────────────

  it("GET /api/calendar/timeline returns events in date range", async () => {
    await mockStorage.createEvent({ title: "In Range", date: "2024-06-15" });
    await mockStorage.createEvent({ title: "Out of Range", date: "2024-07-20" });

    const res = await request(app).get(
      "/api/calendar/timeline?start=2024-06-01&end=2024-06-30"
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Timeline items have a "title" field from CalendarTimelineItem
    const titles = res.body.map((item: any) => item.title);
    expect(titles.some((t: string) => t.includes("In Range"))).toBe(true);
    expect(titles.every((t: string) => !t.includes("Out of Range"))).toBe(true);
  });
});
