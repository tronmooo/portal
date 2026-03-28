/**
 * Integration tests — Documents API
 * Covers: CRUD, profile linking, metadata storage
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "./mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "./setup";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=";

describe("Documents API", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  it("GET /api/documents returns empty array", async () => {
    const res = await request(app).get("/api/documents");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("POST /api/documents creates document with base64 data", async () => {
    const res = await request(app)
      .post("/api/documents")
      .send({
        name: "Driver's License",
        type: "drivers_license",
        mimeType: "image/jpeg",
        fileData: TINY_JPEG_B64,
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Driver's License");
    expect(res.body.type).toBe("drivers_license");
    expect(res.body.id).toBeTruthy();
  });

  it("POST /api/documents stores extracted data", async () => {
    const res = await request(app)
      .post("/api/documents")
      .send({
        name: "Insurance Card",
        type: "insurance",
        mimeType: "image/jpeg",
        fileData: TINY_JPEG_B64,
        extractedData: { policyNumber: "POL-123", expiry: "2025-12-31" },
      });

    expect(res.status).toBe(201);
    expect(res.body.extractedData.policyNumber).toBe("POL-123");
  });

  it("document can be linked to a profile at creation", async () => {
    const profile = await mockStorage.createProfile({
      type: "person",
      name: "Alice",
    });

    const res = await request(app)
      .post("/api/documents")
      .send({
        name: "Passport",
        type: "passport",
        mimeType: "image/jpeg",
        fileData: TINY_JPEG_B64,
        linkedProfiles: [profile.id],
      });

    expect(res.status).toBe(201);
    expect(res.body.linkedProfiles).toContain(profile.id);
  });

  it("PATCH /api/documents/:id updates document metadata", async () => {
    const doc = await mockStorage.createDocument({
      name: "Old Name",
      type: "other",
      mimeType: "image/jpeg",
      fileData: TINY_JPEG_B64,
    });

    const res = await request(app)
      .patch(`/api/documents/${doc.id}`)
      .send({ name: "Renamed Document" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed Document");
  });

  it("PATCH /api/documents/:id updates tags", async () => {
    const doc = await mockStorage.createDocument({
      name: "Receipt",
      type: "receipt",
      mimeType: "image/jpeg",
      fileData: TINY_JPEG_B64,
    });

    const res = await request(app)
      .patch(`/api/documents/${doc.id}`)
      .send({ tags: ["tax", "2024", "business"] });

    expect(res.status).toBe(200);
    expect(res.body.tags).toContain("tax");
  });

  it("DELETE /api/documents/:id removes document", async () => {
    const doc = await mockStorage.createDocument({
      name: "Temp",
      type: "other",
      mimeType: "image/jpeg",
      fileData: TINY_JPEG_B64,
    });

    const del = await request(app).delete(`/api/documents/${doc.id}`);
    expect(del.status).toBe(204);

    const list = await request(app).get("/api/documents");
    expect(list.body.length).toBe(0);
  });

  it("GET /api/documents returns all documents", async () => {
    await mockStorage.createDocument({ name: "Doc 1", type: "other", mimeType: "image/jpeg", fileData: "" });
    await mockStorage.createDocument({ name: "Doc 2", type: "other", mimeType: "image/jpeg", fileData: "" });

    const res = await request(app).get("/api/documents");
    expect(res.body.length).toBe(2);
  });
});
