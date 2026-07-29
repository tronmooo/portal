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

  it("files a reminder's scalar profileId the same way", async () => {
    await h.api("POST", "/api/reminders", { title: "Call the plumber", fireAt: "2026-07-29T17:51" }, asMike);
    expect(h.db.reminders[0].profileId).toBe(MIKE.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-T2-001 — "remind me at 5:51 PM" was stored as 10:51 AM
// ─────────────────────────────────────────────────────────────────────────────
describe("CRUD-T2-001 (route): a reminder is stored at the time the user meant", () => {
  it("reads the quick-add dialog's zone-less datetime as the user's wall clock", async () => {
    const r = await h.api("POST", "/api/reminders", { title: "Call the plumber", fireAt: "2026-07-29T17:51" });
    expect(r.status).toBe(201);
    const parts = getZonedParts(h.db.reminders[0].fireAt, TZ);
    expect(parts.date).toBe("2026-07-29");
    expect(parts.hours).toBe(17);   // was 10 before the fix
    expect(parts.minutes).toBe(51);
  });

  it("uses the CALLER's zone, not a hard-coded one", async () => {
    await h.api("POST", "/api/reminders", { title: "Berlin", fireAt: "2026-07-29T17:51" }, { "X-Timezone": "Europe/Berlin" });
    expect(getZonedParts(h.db.reminders[0].fireAt, "Europe/Berlin").hours).toBe(17);
  });

  it("leaves a fully-qualified instant alone", async () => {
    await h.api("POST", "/api/reminders", { title: "UTC", fireAt: "2026-07-29T17:51:00Z" });
    expect(h.db.reminders[0].fireAt).toBe("2026-07-29T17:51:00.000Z");
  });

  it("keeps the same rule on edit", async () => {
    const c = await h.api("POST", "/api/reminders", { title: "Move me", fireAt: "2026-07-29T09:00" });
    await h.api("PATCH", `/api/reminders/${c.data.id}`, { fireAt: "2026-07-29T17:51" });
    expect(getZonedParts(h.db.reminders[0].fireAt, TZ).hours).toBe(17);
  });

  it("still rejects an unparseable time", async () => {
    expect((await h.api("POST", "/api/reminders", { title: "X", fireAt: "not a date" })).status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRUD-T2-002 — a deleted reminder came back from its calendar mirror
// ─────────────────────────────────────────────────────────────────────────────
describe("CRUD-T2-002 (route): a deleted reminder does not resurface", () => {
  // The state the chat tool leaves behind: a reminder row plus a companion
  // calendar event tagged "reminder" on the same local day.
  async function seedMirroredReminder() {
    const created = await h.api("POST", "/api/reminders", { title: "Call the plumber", fireAt: "2026-07-29T17:51" });
    h.db.events.push({
      id: "mirror-1", title: "Call the plumber", date: "2026-07-29", time: "17:51",
      tags: ["reminder"], linkedProfiles: [],
    });
    return created.data.id;
  }

  it("takes the calendar mirror with it on delete", async () => {
    const rid = await seedMirroredReminder();
    const r = await h.api("DELETE", `/api/reminders/${rid}`);
    expect(r.status).toBe(200);
    expect(h.db.reminders).toHaveLength(0);
    expect(h.db.events).toHaveLength(0); // the orphan that used to come back
  });

  it("leaves an unrelated real event with the same title alone", async () => {
    const rid = await seedMirroredReminder();
    h.db.events.push({ id: "real-1", title: "Call the plumber", date: "2026-07-29", tags: [], linkedProfiles: [] });
    await h.api("DELETE", `/api/reminders/${rid}`);
    expect(h.db.events.map(e => e.id)).toEqual(["real-1"]);
  });

  it("moves the mirror when the reminder time is edited", async () => {
    const rid = await seedMirroredReminder();
    await h.api("PATCH", `/api/reminders/${rid}`, { fireAt: "2026-08-02T09:15" });
    const mirror = h.db.events.find(e => e.id === "mirror-1");
    expect(mirror.date).toBe("2026-08-02");
    expect(mirror.time).toBe("09:15");
  });

  it("retitles the mirror when the reminder is renamed", async () => {
    const rid = await seedMirroredReminder();
    await h.api("PATCH", `/api/reminders/${rid}`, { title: "Call the electrician" });
    expect(h.db.events.find(e => e.id === "mirror-1").title).toBe("Call the electrician");
  });

  it("deleting an already-deleted reminder still 404s (no silent success)", async () => {
    expect((await h.api("DELETE", "/api/reminders/nope")).status).toBe(404);
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
