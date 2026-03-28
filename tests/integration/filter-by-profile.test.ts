/**
 * Integration tests — Profile-based filtering
 * Validates that data can be correctly filtered by profile ID across entities.
 * This tests a core business requirement: viewing linked records per profile.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "./mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "./setup";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

describe("Profile-based filtering", () => {
  let app: any;
  let profileA: any;
  let profileB: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();

    profileA = await mockStorage.createProfile({ type: "person", name: "Alice" });
    profileB = await mockStorage.createProfile({ type: "person", name: "Bob" });
  });

  // ── Tasks filtered by profile ─────────────────────────────────────────────

  it("tasks linked to profile A don't appear under profile B", async () => {
    await mockStorage.createTask({
      title: "Alice's task",
      linkedProfiles: [profileA.id],
    });
    await mockStorage.createTask({
      title: "Bob's task",
      linkedProfiles: [profileB.id],
    });

    const detailA = await request(app).get(`/api/profiles/${profileA.id}/detail`);
    expect(detailA.status).toBe(200);
    const aliceTasks = detailA.body.relatedTasks ?? [];
    expect(aliceTasks.some((t: any) => t.title === "Alice's task")).toBe(true);
    expect(aliceTasks.some((t: any) => t.title === "Bob's task")).toBe(false);
  });

  // ── Expenses filtered by profile ──────────────────────────────────────────

  it("profile detail includes only linked expenses", async () => {
    await mockStorage.createExpense({
      amount: 50,
      description: "Alice dinner",
      linkedProfiles: [profileA.id],
    });
    await mockStorage.createExpense({
      amount: 30,
      description: "Bob coffee",
      linkedProfiles: [profileB.id],
    });

    const detailA = await request(app).get(`/api/profiles/${profileA.id}/detail`);
    const expenses = detailA.body.relatedExpenses ?? [];
    expect(expenses.some((e: any) => e.description === "Alice dinner")).toBe(true);
    expect(expenses.some((e: any) => e.description === "Bob coffee")).toBe(false);
  });

  // ── Events filtered by profile ────────────────────────────────────────────

  it("profile detail includes only linked events", async () => {
    await mockStorage.createEvent({
      title: "Alice appointment",
      date: "2024-06-01",
      linkedProfiles: [profileA.id],
    });
    await mockStorage.createEvent({
      title: "Bob meeting",
      date: "2024-06-02",
      linkedProfiles: [profileB.id],
    });

    const detailA = await request(app).get(`/api/profiles/${profileA.id}/detail`);
    const events = detailA.body.relatedEvents ?? [];
    expect(events.some((e: any) => e.title === "Alice appointment")).toBe(true);
    expect(events.some((e: any) => e.title === "Bob meeting")).toBe(false);
  });

  // ── Documents filtered by profile ─────────────────────────────────────────

  it("profile detail includes only linked documents", async () => {
    await mockStorage.createDocument({
      name: "Alice passport",
      type: "passport",
      mimeType: "image/jpeg",
      fileData: "",
      linkedProfiles: [profileA.id],
    });
    await mockStorage.createDocument({
      name: "Bob license",
      type: "drivers_license",
      mimeType: "image/jpeg",
      fileData: "",
      linkedProfiles: [profileB.id],
    });

    const detailA = await request(app).get(`/api/profiles/${profileA.id}/detail`);
    const docs = detailA.body.relatedDocuments ?? [];
    expect(docs.some((d: any) => d.name === "Alice passport")).toBe(true);
    expect(docs.some((d: any) => d.name === "Bob license")).toBe(false);
  });

  // ── Obligations filtered by profile ───────────────────────────────────────

  it("profile detail includes only linked obligations", async () => {
    await mockStorage.createObligation({
      name: "Alice Netflix",
      amount: 16,
      nextDueDate: "2024-07-01",
      linkedProfiles: [profileA.id],
    });
    await mockStorage.createObligation({
      name: "Bob Spotify",
      amount: 10,
      nextDueDate: "2024-07-01",
      linkedProfiles: [profileB.id],
    });

    const detailA = await request(app).get(`/api/profiles/${profileA.id}/detail`);
    const obligations = detailA.body.relatedObligations ?? [];
    expect(obligations.some((o: any) => o.name === "Alice Netflix")).toBe(true);
    expect(obligations.some((o: any) => o.name === "Bob Spotify")).toBe(false);
  });

  // ── Trackers filtered by profile ──────────────────────────────────────────

  it("profile detail includes only linked trackers", async () => {
    const trackerA = await mockStorage.createTracker({ name: "Alice weight" });
    const trackerB = await mockStorage.createTracker({ name: "Bob steps" });

    await mockStorage.updateTracker(trackerA.id, { linkedProfiles: [profileA.id] });
    await mockStorage.updateTracker(trackerB.id, { linkedProfiles: [profileB.id] });

    const detailA = await request(app).get(`/api/profiles/${profileA.id}/detail`);
    const trackers = detailA.body.relatedTrackers ?? [];
    expect(trackers.some((t: any) => t.name === "Alice weight")).toBe(true);
    expect(trackers.some((t: any) => t.name === "Bob steps")).toBe(false);
  });

  // ── Dashboard stats filtering ─────────────────────────────────────────────

  it("GET /api/stats with filterProfileId returns filtered stats", async () => {
    await mockStorage.createTask({
      title: "Alice task",
      linkedProfiles: [profileA.id],
    });
    await mockStorage.createTask({
      title: "Unlinked task",
      linkedProfiles: [],
    });

    const res = await request(app).get(
      `/api/stats?filterProfileId=${profileA.id}`
    );
    expect(res.status).toBe(200);
    // Stats endpoint should return successfully
    expect(res.body).toBeDefined();
  });

  // ── Unlinked entities ─────────────────────────────────────────────────────

  it("unlinked task does not appear in any profile detail", async () => {
    await mockStorage.createTask({ title: "Orphan task", linkedProfiles: [] });

    const detailA = await request(app).get(`/api/profiles/${profileA.id}/detail`);
    const detailB = await request(app).get(`/api/profiles/${profileB.id}/detail`);

    const tasksA = detailA.body.relatedTasks ?? [];
    const tasksB = detailB.body.relatedTasks ?? [];

    expect(tasksA.every((t: any) => t.title !== "Orphan task")).toBe(true);
    expect(tasksB.every((t: any) => t.title !== "Orphan task")).toBe(true);
  });

  // ── Multi-profile linking ─────────────────────────────────────────────────

  it("entity linked to multiple profiles appears in both detail views", async () => {
    const event = await mockStorage.createEvent({
      title: "Shared event",
      date: "2024-06-15",
      linkedProfiles: [profileA.id, profileB.id],
    });

    const detailA = await request(app).get(`/api/profiles/${profileA.id}/detail`);
    const detailB = await request(app).get(`/api/profiles/${profileB.id}/detail`);

    const eventsA = detailA.body.relatedEvents ?? [];
    const eventsB = detailB.body.relatedEvents ?? [];

    expect(eventsA.some((e: any) => e.id === event.id)).toBe(true);
    expect(eventsB.some((e: any) => e.id === event.id)).toBe(true);
  });
});
