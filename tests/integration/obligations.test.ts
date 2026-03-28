/**
 * Integration tests — Obligations/Subscriptions API
 * Covers: CRUD, pay obligation, status management
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { InMemoryStorage } from "./mock-storage";
import { storageModuleMock, aiEngineMock, buildTestApp } from "./setup";

const mockStorage = new InMemoryStorage();

vi.mock("../../server/storage", () => storageModuleMock(mockStorage));
vi.mock("../../server/ai-engine", () => aiEngineMock());

describe("Obligations API", () => {
  let app: any;

  beforeEach(async () => {
    mockStorage.reset();
    app = await buildTestApp();
  });

  // ── GET ──────────────────────────────────────────────────────────────────

  it("GET /api/obligations returns empty array", async () => {
    const res = await request(app).get("/api/obligations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  // ── POST (create) ────────────────────────────────────────────────────────

  it("POST /api/obligations creates subscription", async () => {
    const res = await request(app)
      .post("/api/obligations")
      .send({
        name: "Netflix",
        amount: 15.99,
        frequency: "monthly",
        nextDueDate: "2024-07-01",
        category: "subscription",
      });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Netflix");
    expect(res.body.amount).toBe(15.99);
    expect(res.body.status).toBe("active");
    expect(res.body.payments).toEqual([]);
  });

  it("POST /api/obligations rejects zero amount", async () => {
    const res = await request(app)
      .post("/api/obligations")
      .send({ name: "Free", amount: 0, nextDueDate: "2024-07-01" });

    expect(res.status).toBe(400);
  });

  it("POST /api/obligations accepts all frequency types", async () => {
    const freqs = ["weekly","biweekly","monthly","quarterly","yearly","once"];
    for (const frequency of freqs) {
      const res = await request(app)
        .post("/api/obligations")
        .send({
          name: `${frequency} bill`,
          amount: 10,
          frequency,
          nextDueDate: "2024-07-01",
        });
      expect(res.status).toBe(201);
    }
  });

  it("POST /api/obligations sets autopay flag", async () => {
    const res = await request(app)
      .post("/api/obligations")
      .send({
        name: "Mortgage",
        amount: 2000,
        nextDueDate: "2024-07-01",
        autopay: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.autopay).toBe(true);
  });

  it("can link obligation to profile", async () => {
    const profile = await mockStorage.createProfile({
      type: "property",
      name: "Home",
    });

    const res = await request(app)
      .post("/api/obligations")
      .send({
        name: "HOA Fee",
        amount: 300,
        nextDueDate: "2024-07-01",
        linkedProfiles: [profile.id],
      });

    expect(res.status).toBe(201);
    expect(res.body.linkedProfiles).toContain(profile.id);
  });

  // ── PATCH (update) ───────────────────────────────────────────────────────

  it("PATCH /api/obligations/:id pauses obligation", async () => {
    const obligation = await mockStorage.createObligation({
      name: "Gym",
      amount: 50,
      nextDueDate: "2024-07-01",
    });

    const res = await request(app)
      .patch(`/api/obligations/${obligation.id}`)
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paused");
  });

  it("PATCH /api/obligations/:id cancels obligation", async () => {
    const obligation = await mockStorage.createObligation({
      name: "Magazine",
      amount: 10,
      nextDueDate: "2024-07-01",
    });

    const res = await request(app)
      .patch(`/api/obligations/${obligation.id}`)
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  it("PATCH /api/obligations/:id returns 404 for nonexistent", async () => {
    const res = await request(app)
      .patch("/api/obligations/ghost")
      .send({ amount: 99 });

    expect(res.status).toBe(404);
  });

  // ── POST /pay ────────────────────────────────────────────────────────────

  it("POST /api/obligations/:id/pay records payment", async () => {
    const obligation = await mockStorage.createObligation({
      name: "Rent",
      amount: 1200,
      nextDueDate: "2024-07-01",
    });

    const res = await request(app)
      .post(`/api/obligations/${obligation.id}/pay`)
      .send({
        amount: 1200,
        method: "bank_transfer",
        confirmationNumber: "TXN-12345",
      });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(1200);
    expect(res.body.method).toBe("bank_transfer");
    expect(res.body.confirmationNumber).toBe("TXN-12345");
  });

  it("payment is stored in obligation's payments array", async () => {
    const obligation = await mockStorage.createObligation({
      name: "Rent",
      amount: 1200,
      nextDueDate: "2024-07-01",
    });

    await mockStorage.payObligation(obligation.id, 1200, "check");

    const res = await request(app).get("/api/obligations");
    const found = res.body.find((o: any) => o.id === obligation.id);
    expect(found.payments.length).toBe(1);
  });

  it("POST /pay returns 404 for nonexistent obligation", async () => {
    const res = await request(app)
      .post("/api/obligations/ghost/pay")
      .send({ amount: 100 });

    expect(res.status).toBe(404);
  });

  // ── DELETE ───────────────────────────────────────────────────────────────

  it("DELETE /api/obligations/:id removes obligation", async () => {
    const obligation = await mockStorage.createObligation({
      name: "Temp",
      amount: 5,
      nextDueDate: "2024-07-01",
    });

    const del = await request(app).delete(`/api/obligations/${obligation.id}`);
    expect(del.status).toBe(204);

    const list = await request(app).get("/api/obligations");
    expect(list.body.length).toBe(0);
  });
});
