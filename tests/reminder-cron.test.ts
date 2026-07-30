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

  it("runs at most once a day, because a faster schedule fails the whole deploy", () => {
    // Vercel's Hobby plan caps cron jobs at once per day (and two jobs total)
    // and REJECTS a more frequent schedule at deploy time — the deployment
    // fails, so nothing ships, not just the cron. This bit us: an hourly
    // "0 * * * *" here is why the Executive-tab redesign sat on main while
    // production kept serving the old bundle.
    //
    // Daily is enough. The user-visible symptom (June reminders still on
    // screen in July) is fixed independently by the feed's reminderStaleHours
    // window in shared/attention.ts, which does not depend on this running.
    for (const c of cfg.crons || []) {
      const [minute, hour] = String(c.schedule).split(/\s+/);
      expect(minute, `${c.path}: minute must be fixed, got "${c.schedule}"`).toMatch(/^\d+$/);
      expect(hour, `${c.path}: hour must be fixed, got "${c.schedule}"`).toMatch(/^\d+$/);
    }
  });

  it("stays within the two-job Hobby limit", () => {
    expect((cfg.crons || []).length).toBeLessThanOrEqual(2);
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
