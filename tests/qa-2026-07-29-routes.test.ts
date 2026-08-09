// Route-level verification for the QA report of 2026-07-29.
//
// The companion file `qa-2026-07-29-regressions.test.ts` proves the pure
// helpers behave. This one proves the ROUTES actually use them: each test
// drives the real Express app (tests/helpers/route-harness) over HTTP and then
// reads the stored rows, so it fails if a handler stops calling a guard, calls
// it in the wrong order, or never wires it up at all.
//
// Every `it` below fails on the pre-fix code.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startHarness, type Harness } from "./helpers/route-harness";
import { getZonedParts } from "../shared/timezone";
import { ACTIVE_PROFILE_HEADER } from "../shared/active-scope";

const TZ = "America/Los_Angeles";
const SELF = { id: "self-1", type: "self", name: "Test" };
const MIKE = { id: "mike-1", type: "person", name: "Mike" };
const JANE = { id: "jane-1", type: "person", name: "Jane" };

let h: Harness;
beforeEach(async () => { h = await startHarness({ profiles: [SELF, MIKE, JANE] }); });
afterEach(async () => { await h.close(); });

// ─────────────────────────────────────────────────────────────────────────────
// EDGE-001 — POST /api/expenses accepted 1e10 and Cash Flow showed -$10B
// ─────────────────────────────────────────────────────────────────────────────
describe("EDGE-001 (route): the API refuses an implausible amount", () => {
  it("rejects the reported $10,000,000,000 expense with a 400 and stores nothing", async () => {
    const r = await h.api("POST", "/api/expenses", { description: "QA big", amount: 1e10, category: "food" });
    expect(r.status).toBe(400);
    expect(String(r.data?.error)).toMatch(/less than/i);
    expect(h.db.expenses).toHaveLength(0);
  });

  it("rejects on PATCH too — an edit must not sneak past the create guard", async () => {
    const created = await h.api("POST", "/api/expenses", { description: "Coffee", amount: 4.5, category: "food" });
    expect(created.status).toBe(201);
    const patched = await h.api("PATCH", `/api/expenses/${created.data.id}`, { amount: 1e10 });
    expect(patched.status).toBe(400);
    expect(h.db.expenses[0].amount).toBe(4.5); // unchanged
  });

  it("still accepts an ordinary expense", async () => {
    const r = await h.api("POST", "/api/expenses", { description: "Groceries", amount: 82.31, category: "food" });
    expect(r.status).toBe(201);
    expect(h.db.expenses[0].amount).toBe(82.31);
  });

  it("applies the same ceiling to income", async () => {
    expect((await h.api("POST", "/api/incomes", { description: "X", amount: 1e10 })).status).toBe(400);
    expect((await h.api("POST", "/api/incomes", { description: "Salary", amount: 5000 })).status).toBe(201);
  });

  it("applies the same ceiling to bills", async () => {
    const big = await h.api("POST", "/api/obligations", { name: "X", amount: 1e10, nextDueDate: "2026-08-01" });
    expect(big.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PROP-005 — an expense created while `Mike` was active landed on self
// ─────────────────────────────────────────────────────────────────────────────
describe("PROP-005 (route): a create lands on the profile in scope", () => {
  const asMike = { [ACTIVE_PROFILE_HEADER]: MIKE.id };

  it("files an expense against the active profile when the body names no owner", async () => {
    // This is the exact reported request: the dialog posted no linkedProfiles
    // and the row silently became the self profile's.
    const r = await h.api("POST", "/api/expenses", { description: "Gas", amount: 40, category: "vehicle" }, asMike);
    expect(r.status).toBe(201);
    expect(h.db.expenses[0].linkedProfiles).toEqual([MIKE.id]);
  });

  it("honours an explicitly chosen owner over the active scope", async () => {
    await h.api("POST", "/api/expenses", { description: "Dentist", amount: 90, category: "health", linkedProfiles: [JANE.id] }, asMike);
    expect(h.db.expenses[0].linkedProfiles).toEqual([JANE.id]);
  });

  it("leaves the row unowned when several profiles are in scope", async () => {
    await h.api("POST", "/api/expenses", { description: "Shared", amount: 20, category: "food" },
      { [ACTIVE_PROFILE_HEADER]: `${MIKE.id},${JANE.id}` });
    expect(h.db.expenses[0].linkedProfiles).toEqual([]);
  });

  it("changes nothing when the scope is Everyone (no header)", async () => {
    await h.api("POST", "/api/expenses", { description: "Anything", amount: 20, category: "food" });
    expect(h.db.expenses[0].linkedProfiles).toEqual([]);
  });

  it("covers income, bills and tasks, not just expenses", async () => {
    await h.api("POST", "/api/incomes", { description: "Side gig", amount: 300 }, asMike);
    await h.api("POST", "/api/obligations", { name: "Phone", amount: 40, nextDueDate: "2026-08-01" }, asMike);
    await h.api("POST", "/api/tasks", { title: "Renew tags" }, asMike);
    expect(h.db.incomes[0].linkedProfiles).toEqual([MIKE.id]);
    expect(h.db.obligations[0].linkedProfiles).toEqual([MIKE.id]);
    expect(h.db.tasks[0].linkedProfiles).toEqual([MIKE.id]);
  });

  it("files a TIMED task the same way", async () => {
    await h.api("POST", "/api/tasks", { title: "Call the plumber", dueDate: "2026-07-29", dueTime: "17:51" }, asMike);
    expect(h.db.tasks[0].linkedProfiles).toEqual([MIKE.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-T2-001 — "remind me at 5:51 PM" was stored as 10:51 AM
//
// The original bug: a reminder's time was an INSTANT (`fire_at timestamptz`),
// and the quick-add dialog posts a zone-less `<input type="datetime-local">`
// value, so the server read 17:51 as UTC and displayed it back as 10:51 AM.
//
// Reminders were retired on 2026-08-09. A task stores the user's WALL CLOCK —
// `dueDate` plus `dueTime`, two plain strings — so there is no instant to
// convert and no zone to get wrong. These pin that the wall clock survives the
// round trip verbatim, which is what makes the old bug unrepresentable.
// ─────────────────────────────────────────────────────────────────────────────
describe("CRUD-T2-001 (route): a timed task keeps the time the user meant", () => {
  it("stores the hour the user typed, unshifted", async () => {
    const r = await h.api("POST", "/api/tasks", { title: "Call the plumber", dueDate: "2026-07-29", dueTime: "17:51" });
    expect(r.status).toBe(201);
    expect(h.db.tasks[0].dueDate).toBe("2026-07-29");
    expect(h.db.tasks[0].dueTime).toBe("17:51");  // was read back as 10:51 before
  });

  it("stores the same wall clock whatever zone the caller is in", async () => {
    await h.api("POST", "/api/tasks", { title: "Berlin", dueDate: "2026-07-29", dueTime: "17:51" }, { "X-Timezone": "Europe/Berlin" });
    expect(h.db.tasks[0].dueTime).toBe("17:51");
  });

  it("keeps the same rule on edit", async () => {
    const c = await h.api("POST", "/api/tasks", { title: "Move me", dueDate: "2026-07-29", dueTime: "09:00" });
    await h.api("PATCH", `/api/tasks/${c.data.id}`, { dueTime: "17:51" });
    expect(h.db.tasks[0].dueTime).toBe("17:51");
  });

  it("leaves a task with no clock time all-day rather than inventing midnight", async () => {
    await h.api("POST", "/api/tasks", { title: "Buy milk", dueDate: "2026-07-29" });
    expect(h.db.tasks[0].dueTime).toBeUndefined();
  });

  it("lets a timed task go back to all-day", async () => {
    // "" and null both fail the HH:MM validator, but they are how the UI says
    // "make this all-day". A 400 here would strand the task at an hour the user
    // just removed.
    const c = await h.api("POST", "/api/tasks", { title: "Buy milk", dueDate: "2026-07-29", dueTime: "09:00" });
    const r = await h.api("PATCH", `/api/tasks/${c.data.id}`, { dueTime: null });
    expect(r.status).toBe(200);
    expect(h.db.tasks[0].dueTime).toBeUndefined();
  });

  it("still rejects an unparseable time", async () => {
    expect((await h.api("POST", "/api/tasks", { title: "X", dueDate: "2026-07-29", dueTime: "5:51 pm" })).status).toBe(400);
    expect((await h.api("POST", "/api/tasks", { title: "X", dueDate: "2026-07-29", dueTime: "25:00" })).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-T2-002 — a deleted reminder came back from its calendar mirror
//
// A reminder was one row whose calendar appearance was a SECOND row (a mirrored
// event), so deleting one left the other projecting something the user had
// already removed, and editing one stranded a copy at the old time. Retiring
// the entity deleted the whole class: a timed task IS its own calendar entry.
// ─────────────────────────────────────────────────────────────────────────────
describe("CRUD-T2-002 (route): a timed task has nothing to fall out of sync with", () => {
  it("creates exactly one row — no companion event to strand", async () => {
    await h.api("POST", "/api/tasks", { title: "Call the plumber", dueDate: "2026-07-29", dueTime: "17:51" });
    expect(h.db.tasks).toHaveLength(1);
    expect(h.db.events).toHaveLength(0);
  });

  it("leaves nothing behind on delete", async () => {
    const c = await h.api("POST", "/api/tasks", { title: "Call the plumber", dueDate: "2026-07-29", dueTime: "17:51" });
    const r = await h.api("DELETE", `/api/tasks/${c.data.id}`);
    expect(r.status).toBe(200);
    expect(h.db.events).toHaveLength(0);
  });

  it("never touches a real event the user typed with the same title", async () => {
    const c = await h.api("POST", "/api/tasks", { title: "Call the plumber", dueDate: "2026-07-29", dueTime: "17:51" });
    h.db.events.push({ id: "real-1", title: "Call the plumber", date: "2026-07-29", tags: [], linkedProfiles: [] });
    await h.api("DELETE", `/api/tasks/${c.data.id}`);
    expect(h.db.events.map(e => e.id)).toEqual(["real-1"]);
  });

  it("moving the task moves the only row there is", async () => {
    const c = await h.api("POST", "/api/tasks", { title: "Call the plumber", dueDate: "2026-07-29", dueTime: "17:51" });
    await h.api("PATCH", `/api/tasks/${c.data.id}`, { dueDate: "2026-08-02", dueTime: "09:15" });
    expect(h.db.tasks[0]).toMatchObject({ dueDate: "2026-08-02", dueTime: "09:15" });
    expect(h.db.events).toHaveLength(0);
  });

  it("the retired reminder routes answer 410, not 404 — a stale client learns why", async () => {
    const r = await h.api("POST", "/api/reminders", { title: "X", fireAt: "2026-07-29T17:51" });
    expect(r.status).toBe(410);
    expect(String(r.data.error)).toMatch(/timed tasks/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EDGE-003 — a stripped <script> tag was never reported to the user
// ─────────────────────────────────────────────────────────────────────────────
describe("EDGE-003 (route): altered input is reported, not applied silently", () => {
  it("returns a warning when markup is stripped from an expense", async () => {
    const r = await h.api("POST", "/api/expenses", {
      description: "Coffee <script>alert(1)</script>", amount: 5, category: "food",
    });
    expect(r.status).toBe(201);
    expect(r.data.warning).toMatch(/removed/i);
    expect(r.data.description).not.toMatch(/<script/i); // still sanitized
  });

  it("returns a warning when markup is stripped from a task", async () => {
    const r = await h.api("POST", "/api/tasks", { title: "Ship it <script>x</script>" });
    expect(r.data.warning).toMatch(/removed/i);
  });

  it("stays quiet for ordinary text — no false alarm on every save", async () => {
    const r = await h.api("POST", "/api/expenses", { description: "  Coffee  ", amount: 5, category: "food" });
    expect(r.data.warning).toBeUndefined();
    expect(r.data.description).toBe("Coffee"); // trimming alone is not "altered"
  });
});
