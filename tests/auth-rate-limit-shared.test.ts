// Sign-in throttling must hold across serverless instances.
//
// 2026-11-15: 12 wrong-password sign-ins in a row from one address against
// production were all let through. The limit (10 a minute) was counted in a
// Map inside each instance, and the attempts were spread across instances.
//
// These tests drive the REAL auth routes on two separate Express apps — two
// "instances", each with its own in-memory Map — that share one database
// double, and prove (a) the limit trips across them, and (b) a broken shared
// store never blocks a sign-in.
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

// The shared store, as migrations/20261115_auth_rate_limits.sql implements it.
const rows = new Map<string, { count: number; resetAt: number }>();
const rpcCalls: Array<{ fn: string; args: any }> = [];
let rpcMode: "ok" | "error" | "throw" | "hang" = "ok";

function rateLimitHit(args: any): boolean {
  const now = Date.now();
  const row = rows.get(args.p_key);
  if (!row || row.resetAt <= now) {
    rows.set(args.p_key, { count: 1, resetAt: now + args.p_window_ms });
    return 1 > args.p_max;
  }
  row.count++;
  return row.count > args.p_max;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (rpcMode === "throw") throw new Error("connection refused");
      if (rpcMode === "hang") return new Promise(() => {});
      if (rpcMode === "error") {
        return Promise.resolve({ data: null, error: { message: "function auth_rate_limit_hit does not exist" } });
      }
      return Promise.resolve({ data: rateLimitHit(args), error: null });
    },
    auth: {
      // Every sign-in here is a wrong password.
      signInWithPassword: async () => ({ data: { user: null, session: null }, error: { message: "Invalid login credentials" } }),
    },
  }),
}));

process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";

const servers: Server[] = [];

/** One "serverless instance": its own app, its own in-memory counters. */
async function bootInstance(): Promise<(body: unknown) => Promise<number>> {
  const { registerAuthRoutes } = await import("../server/auth");
  const app = express();
  app.use(express.json());
  registerAuthRoutes(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.status;
  };
}

const WRONG = { email: "someone@example.com", password: "wrong-password" };

beforeEach(() => {
  rows.clear();
  rpcCalls.length = 0;
  rpcMode = "ok";
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
});

describe("sign-in rate limit across instances", () => {
  it("refuses the 11th attempt in a minute even when attempts alternate between two instances", async () => {
    const a = await bootInstance();
    const b = await bootInstance();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push(await (i % 2 === 0 ? a : b)(WRONG));

    // Each instance saw only 6 attempts — under its own limit of 10.
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("stores a hash, never the caller's address or email", async () => {
    const a = await bootInstance();
    await a(WRONG);
    expect(rpcCalls.length).toBe(1);
    expect(rpcCalls[0].fn).toBe("auth_rate_limit_hit");
    expect(rpcCalls[0].args.p_key).toMatch(/^[0-9a-f]{64}$/);
    expect(rpcCalls[0].args).toMatchObject({ p_max: 10, p_window_ms: 60000 });
  });
});

describe("the shared store can never block a sign-in", () => {
  for (const mode of ["error", "throw"] as const) {
    it(`falls back to the in-memory limit when the database call fails (${mode})`, async () => {
      rpcMode = mode;
      const a = await bootInstance();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push(await a(WRONG));
      // Reaches the sign-in itself (400 = wrong password) until the instance's
      // own counter trips, exactly as before the shared store existed.
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
      expect(statuses.slice(10)).toEqual([429, 429]);
    });
  }

  it("gives up on a database call that never answers, then skips the store for a while", async () => {
    const { createSharedRateLimiter } = await import("../server/auth-rate-limit");
    let calls = 0;
    const overLimit = createSharedRateLimiter(
      () => ({ rpc: () => { calls++; return new Promise(() => {}); } }),
      { timeoutMs: 20, cooldownMs: 60_000 },
    );
    const started = Date.now();
    expect(await overLimit("signin", "1.2.3.4", 10, 60000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    // Cooling down: the next call does not touch the database at all.
    expect(await overLimit("signin", "1.2.3.4", 10, 60000)).toBe(false);
    expect(calls).toBe(1);
  });

  it("answers 'not limited' when no database client is configured", async () => {
    const { createSharedRateLimiter } = await import("../server/auth-rate-limit");
    const overLimit = createSharedRateLimiter(() => null);
    expect(await overLimit("signin", "1.2.3.4", 10, 60000)).toBe(false);
  });
});
