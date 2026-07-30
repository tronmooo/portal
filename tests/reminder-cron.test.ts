// tests/reminder-cron.test.ts — the reminder firer is actually reachable.
//
// `cronFireDueReminders` was fully implemented, correct, and completely dead:
// vercel.json had no `crons` block (despite a comment in routes.ts claiming it
// did), and the handler only accepted `?key=`, which Vercel Cron cannot send —
// it authenticates with `Authorization: Bearer $CRON_SECRET`.
//
// The visible consequence: reminders were never stamped `fired_at`, and
// `listReminders` filters on `fired_at IS NULL` with no lower bound on
// `fire_at`, so a reminder from June was still served as "active" in July. The
// 2026-07-29 report shows eight of them on screen.
//
// These two assertions are what nobody was making.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { startHarness, type Harness } from "./helpers/route-harness";

const SECRET = "test-cron-secret";
const ROUTE = "/api/cron/fire-due-reminders";

describe("vercel.json schedules the reminder firer", () => {
  const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "vercel.json"), "utf8"));

  it("has a crons entry pointing at the route", () => {
    const paths = (cfg.crons || []).map((c: any) => c.path);
    expect(paths, "no cron schedules the reminder firer").toContain(ROUTE);
  });

  it("gives it a schedule", () => {
    const entry = (cfg.crons || []).find((c: any) => c.path === ROUTE);
    expect(entry?.schedule).toMatch(/^[\d*/,\- ]+$/);
  });
});

describe(`GET ${ROUTE} auth`, () => {
  let h: Harness;
  let prevSecret: string | undefined;
  beforeEach(async () => {
    prevSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevSecret;
  });

  it("rejects an unauthenticated call", async () => {
    const r = await h.api("GET", ROUTE);
    expect(r.status).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    const r = await h.api("GET", `${ROUTE}?key=nope`);
    expect(r.status).toBe(401);
    const b = await h.api("GET", ROUTE, undefined, { Authorization: "Bearer nope" });
    expect(b.status).toBe(401);
  });

  it("accepts the Bearer header Vercel Cron actually sends", async () => {
    // Past the auth gate is all this proves — the handler then needs Supabase
    // admin credentials the test environment doesn't have, so it 500s. A 401
    // here is the regression: it means the schedule fires into a closed door.
    const r = await h.api("GET", ROUTE, undefined, { Authorization: `Bearer ${SECRET}` });
    expect(r.status).not.toBe(401);
  });

  it("still accepts ?key= for a manual run", async () => {
    const r = await h.api("GET", `${ROUTE}?key=${SECRET}`);
    expect(r.status).not.toBe(401);
  });
});
