/**
 * Smoke tests — Verify the deployed app is healthy.
 *
 * These tests run against the actual running server (BASE_URL env var).
 * They do NOT use mock storage — they hit real endpoints.
 *
 * Run after every deployment:
 *   BASE_URL=https://your-app.com npx vitest run tests/smoke
 */

import { describe, it, expect } from "vitest";

const BASE_URL = process.env.BASE_URL || "";
const SKIP_SMOKE = !BASE_URL;

async function get(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  return res;
}

describe.skipIf(SKIP_SMOKE)("Smoke tests", () => {
  it("server is reachable", async () => {
    const res = await get("/");
    // Could be 200 (HTML) or redirect — just not a connection error
    expect(res.status).toBeLessThan(500);
  });

  it("API health endpoint is accessible", async () => {
    // The server should return something on /api routes
    const res = await get("/api/auth/config");
    // Could be 200 or 401 — just not a 500 or connection error
    expect(res.status).toBeLessThan(500);
  });

  it("/api/auth/config returns valid JSON", async () => {
    const res = await get("/api/auth/config");
    expect(res.headers.get("content-type")).toMatch(/json/);
    const json = await res.json();
    expect(json).toBeDefined();
  });

  it("unauthenticated /api/profiles returns 401, not 500", async () => {
    const res = await get("/api/profiles");
    // Should be 401 (auth required) — NOT a server error
    expect(res.status).toBe(401);
  });

  it("unauthenticated /api/trackers returns 401, not 500", async () => {
    const res = await get("/api/trackers");
    expect(res.status).toBe(401);
  });

  it("unauthenticated /api/tasks returns 401, not 500", async () => {
    const res = await get("/api/tasks");
    expect(res.status).toBe(401);
  });

  it("unauthenticated /api/expenses returns 401, not 500", async () => {
    const res = await get("/api/expenses");
    expect(res.status).toBe(401);
  });

  it("unauthenticated /api/habits returns 401, not 500", async () => {
    const res = await get("/api/habits");
    expect(res.status).toBe(401);
  });

  it("unauthenticated /api/obligations returns 401, not 500", async () => {
    const res = await get("/api/obligations");
    expect(res.status).toBe(401);
  });

  it("unauthenticated /api/events returns 401, not 500", async () => {
    const res = await get("/api/events");
    expect(res.status).toBe(401);
  });

  it("unauthenticated /api/documents returns 401, not 500", async () => {
    const res = await get("/api/documents");
    expect(res.status).toBe(401);
  });

  it("unknown API route returns 404, not 500", async () => {
    const res = await get("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
  });

  it("server returns security headers", async () => {
    const res = await get("/api/auth/config");
    // Should have some security headers
    const hasAnySecurityHeader =
      res.headers.has("x-content-type-options") ||
      res.headers.has("x-frame-options") ||
      res.headers.has("content-security-policy");
    expect(hasAnySecurityHeader).toBe(true);
  });
});
