/**
 * Integration tests — Profile CRUD API
 * Covers: GET /api/profiles, POST, PATCH, DELETE, GET by ID, link/unlink
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "./mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "./setup";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

describe("Profiles API", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  // ── GET /api/profiles ────────────────────────────────────────────────────

  it("GET /api/profiles returns empty array when no profiles", async () => {
    const res = await request(app).get("/api/profiles");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it("GET /api/profiles returns all created profiles", async () => {
    await mockStorage.createProfile({ type: "person", name: "Alice" });
    await mockStorage.createProfile({ type: "pet", name: "Rex" });

    const res = await request(app).get("/api/profiles");
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
  });

  // ── POST /api/profiles ───────────────────────────────────────────────────

  it("POST /api/profiles creates a profile and returns 201", async () => {
    const res = await request(app)
      .post("/api/profiles")
      .send({ type: "person", name: "Bob" });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Bob");
    expect(res.body.type).toBe("person");
    expect(res.body.id).toBeTruthy();
  });

  it("POST /api/profiles returns 400 for missing name", async () => {
    const res = await request(app)
      .post("/api/profiles")
      .send({ type: "person" });

    expect(res.status).toBe(400);
  });

  it("POST /api/profiles returns 400 for invalid type", async () => {
    const res = await request(app)
      .post("/api/profiles")
      .send({ type: "robot", name: "Bot" });

    expect(res.status).toBe(400);
  });

  it("POST /api/profiles accepts all valid profile types", async () => {
    const types = [
      "person","pet","vehicle","account","property",
      "subscription","medical","self","loan","investment","asset",
    ];
    for (const type of types) {
      const res = await request(app)
        .post("/api/profiles")
        .send({ type, name: `Test ${type}` });
      expect(res.status).toBe(201);
    }
  });

  it("POST /api/profiles stores custom fields", async () => {
    const res = await request(app)
      .post("/api/profiles")
      .send({
        type: "person",
        name: "Charlie",
        fields: { birthday: "1990-01-01", bloodType: "O+" },
      });

    expect(res.status).toBe(201);
    expect(res.body.fields.birthday).toBe("1990-01-01");
  });

  // ── GET /api/profiles/:id ────────────────────────────────────────────────

  it("GET /api/profiles/:id returns profile detail", async () => {
    const profile = await mockStorage.createProfile({
      type: "person",
      name: "Diana",
    });

    const res = await request(app).get(`/api/profiles/${profile.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Diana");
  });

  it("GET /api/profiles/:id returns 404 for nonexistent profile", async () => {
    const res = await request(app).get("/api/profiles/nonexistent-id");
    expect(res.status).toBe(404);
  });

  // ── PATCH /api/profiles/:id ──────────────────────────────────────────────

  it("PATCH /api/profiles/:id updates profile name", async () => {
    const profile = await mockStorage.createProfile({
      type: "person",
      name: "Eve",
    });

    const res = await request(app)
      .patch(`/api/profiles/${profile.id}`)
      .send({ name: "Eve Updated" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Eve Updated");
  });

  it("PATCH /api/profiles/:id updates nested fields", async () => {
    const profile = await mockStorage.createProfile({
      type: "vehicle",
      name: "My Car",
    });

    const res = await request(app)
      .patch(`/api/profiles/${profile.id}`)
      .send({ fields: { make: "Toyota", year: 2020 } });

    expect(res.status).toBe(200);
    expect(res.body.fields.make).toBe("Toyota");
  });

  it("PATCH /api/profiles/:id returns 404 for missing profile", async () => {
    const res = await request(app)
      .patch("/api/profiles/ghost-id")
      .send({ name: "Ghost" });

    expect(res.status).toBe(404);
  });

  // ── DELETE /api/profiles/:id ─────────────────────────────────────────────

  it("DELETE /api/profiles/:id removes profile", async () => {
    const profile = await mockStorage.createProfile({
      type: "person",
      name: "Frank",
    });

    const del = await request(app).delete(`/api/profiles/${profile.id}`);
    expect(del.status).toBe(204);

    const get = await request(app).get(`/api/profiles/${profile.id}`);
    expect(get.status).toBe(404);
  });

  it("DELETE /api/profiles/:id returns 404 for missing profile", async () => {
    const res = await request(app).delete("/api/profiles/nobody");
    expect(res.status).toBe(404);
  });

  // ── Nested profiles ──────────────────────────────────────────────────────

  it("POST /api/profiles accepts parentProfileId for nested profiles", async () => {
    const parent = await mockStorage.createProfile({
      type: "person",
      name: "Parent",
    });

    const res = await request(app)
      .post("/api/profiles")
      .send({
        type: "asset",
        name: "Child Asset",
        parentProfileId: parent.id,
      });

    expect(res.status).toBe(201);
    expect(res.body.parentProfileId).toBe(parent.id);
  });

  it("GET /api/profiles/:id/detail includes child profiles", async () => {
    const parent = await mockStorage.createProfile({
      type: "person",
      name: "Parent",
    });
    await mockStorage.createProfile({
      type: "asset",
      name: "Child",
      parentProfileId: parent.id,
    });

    const res = await request(app).get(`/api/profiles/${parent.id}/detail`);
    expect(res.status).toBe(200);
    expect(res.body.childProfiles).toBeDefined();
    expect(res.body.childProfiles.length).toBe(1);
    expect(res.body.childProfiles[0].name).toBe("Child");
  });
});
