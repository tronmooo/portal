// tests/reminder-create-verification.test.ts
//
// End-to-end guard for the "reminder system save failure" that wasn't one.
//
// A long chat request created tasks, events, bills and a goal successfully but
// reported six reminders as "❌ failed to save (server read-back error)". The
// rows were in the database the whole time. `create_reminder` returns the
// mirrored CALENDAR EVENT's id as its top-level `id` so the chat action card's
// Undo targets the visible calendar entry; the envelope's post-write read-back
// then looked that event id up in the REMINDERS table, never found it, and
// declared the write failed — which also stripped the action from the chat UI
// and skipped the undo ledger.
//
// The retry it offered could never succeed either: createReminder dedups on
// (title, fire_at) and the mirror dedups on (title, date), so every retry
// returned the same rows and failed identically.
//
// This runs the REAL executor against the real envelope (in-memory storage), so
// it fails if either side of the contract drifts — not just if a hand-built
// result shape stops matching.
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";
import { finalizeToolResult, buildTurnVerifyContext } from "../server/ai-envelope";

const USER = "user-reminder-verify";

/** Run the real create_reminder tool, then the real envelope, as chat does. */
async function createReminderViaChat(storage: MemStorage, input: Record<string, any>) {
  return requestStorageContext.run(storage, async () => {
    const raw = await executeTool("create_reminder", input, USER);
    if (raw?.error) return { raw, envelope: raw };
    const envelope = await finalizeToolResult(
      "create_reminder", "create_reminder", input, raw, buildTurnVerifyContext(storage),
    );
    return { raw, envelope };
  });
}

describe("create_reminder → envelope verification", () => {
  let storage: MemStorage;
  beforeEach(() => { storage = new MemStorage(); });

  it("reports success for a reminder that really was written", async () => {
    const { raw, envelope } = await createReminderViaChat(storage, {
      title: "Put out the trash",
      fireAt: "2027-08-05T19:00:00",
    });

    // The bug in one assertion: this said false while the row existed.
    expect(envelope.success).toBe(true);
    expect(envelope.error).toBeUndefined();
    expect(envelope.verification.database_record_exists).toBe(true);

    // Verification targeted the reminder row, not the mirrored event.
    expect(envelope.entity).toMatchObject({ type: "reminder", id: raw.reminderId });

    // And the row is genuinely there.
    const stored = await requestStorageContext.run(storage, () => storage.listReminders());
    expect(stored.map(r => r.id)).toContain(raw.reminderId);
  });

  it("still surfaces the calendar entry to the chat card, and hides the hint", async () => {
    const { raw, envelope } = await createReminderViaChat(storage, {
      title: "Take the bins out",
      fireAt: "2027-09-09T19:00:00",
    });
    // The mirror event is what Undo and the deep link point at.
    expect(raw.eventId).toBeTruthy();
    expect(envelope.id).toBe(raw.eventId);
    expect(envelope.reminderId).toBe(raw.reminderId);
    // The verification hint is internal and must not leak.
    expect(envelope._verify).toBeUndefined();
  });

  it("a repeat of the same request reconciles instead of failing forever", async () => {
    const input = { title: "Water the plants", fireAt: "2027-10-14T19:00:00" };
    const first = await createReminderViaChat(storage, input);
    const second = await createReminderViaChat(storage, input);

    // Dedup returns the SAME reminder row rather than inserting a second...
    expect(second.raw.reminderId).toBe(first.raw.reminderId);
    // ...and the retry reports honestly instead of "the save failed, try again".
    expect(second.envelope.success).toBe(true);

    const stored = await requestStorageContext.run(storage, () => storage.listReminders());
    expect(stored.filter(r => r.title === input.title)).toHaveLength(1);
  });

  it("an open-ended repeat generates a standing horizon, not a single reminder", async () => {
    // "every Thursday at 7pm, no end date" — count deliberately omitted.
    const { envelope } = await createReminderViaChat(storage, {
      title: "Sweep the porch",
      fireAt: "2027-11-04T19:00:00",
      recurrence: "weekly",
    });
    expect(envelope.success).toBe(true);

    const stored = await requestStorageContext.run(storage, () => storage.listReminders());
    const series = stored.filter(r => r.title === "Sweep the porch");
    expect(series.length).toBeGreaterThan(50); // was 1 before the horizon fix

    // Every occurrence lands on the same weekday at the same WALL-CLOCK time.
    // Asserting a fixed 7-day UTC delta would be wrong: the series deliberately
    // steps calendar days in the user's zone, so the gap across a DST boundary
    // is 169 hours, not 168 — that is the promise being kept, not broken.
    const local = (iso: string) =>
      new Date(iso).toLocaleString("en-US", {
        timeZone: "America/Los_Angeles", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
      });
    const stamps = new Set(series.slice(0, 60).map(r => local(r.fireAt)));
    expect(Array.from(stamps)).toEqual(["Thu 19:00"]);

    // ...and the reply names the date the series actually runs through.
    expect(envelope.message).toMatch(/through/i);
  });

  it("quarterly steps by calendar months, anchored and clamped", async () => {
    const { envelope } = await createReminderViaChat(storage, {
      title: "Replace the air filter",
      fireAt: "2027-10-01T09:00:00",
      recurrence: "quarterly",
      count: 4,
    });
    expect(envelope.success).toBe(true);

    const stored = await requestStorageContext.run(storage, () => storage.listReminders());
    const months = stored
      .filter(r => r.title === "Replace the air filter")
      .map(r => r.fireAt.slice(0, 7))
      .sort();
    expect(months).toEqual(["2027-10", "2028-01", "2028-04", "2028-07"]);
  });

  it("rejects an unparseable time instead of writing a junk row", async () => {
    const { envelope } = await createReminderViaChat(storage, { title: "Nonsense", fireAt: "whenever" });
    expect(envelope.error).toBeTruthy();
    const stored = await requestStorageContext.run(storage, () => storage.listReminders());
    expect(stored).toHaveLength(0);
  });
});

describe("complete_task retires the reminder it was set for", () => {
  it("cancels a matching pending reminder and says so", async () => {
    const storage = new MemStorage();
    const result = await requestStorageContext.run(storage, async () => {
      await executeTool("create_task", { title: "Renew passport", priority: "high" }, USER);
      await executeTool("create_reminder", { title: "Renew passport", fireAt: "2027-06-01T10:00:00" }, USER);
      const before = await storage.listReminders();
      const done = await executeTool("complete_task", { title: "Renew passport" }, USER);
      const after = await storage.listReminders();
      return { before, done, after };
    });

    expect(result.before.length).toBeGreaterThan(0);
    expect(result.after).toHaveLength(0);
    expect(result.done.clearedReminders).toBe(1);
    expect(result.done.message).toMatch(/cancelled/i);
  });

  it("leaves unrelated reminders alone", async () => {
    const storage = new MemStorage();
    const remaining = await requestStorageContext.run(storage, async () => {
      await executeTool("create_task", { title: "Renew passport" }, USER);
      await executeTool("create_reminder", { title: "Call the dentist", fireAt: "2027-06-01T10:00:00" }, USER);
      await executeTool("complete_task", { title: "Renew passport" }, USER);
      return storage.listReminders();
    });
    expect(remaining.map(r => r.title)).toEqual(["Call the dentist"]);
  });
});

// ── Deleting a schedule written as several rows ──────────────────────────────
//
// Reported 2026-08-04: "This would be considered a recurring task and if I
// delete it in the tasks, it should also be deleted in the calendar tab as
// well, especially in the recurring tab."
//
// The monthly refill is six task rows with no recurrence tag. Deleting one left
// the other five on the calendar and kept the schedule listed as recurring.
describe("delete_task on a materialized schedule", () => {
  // A distinct medication per test: the executor's in-memory dedup lock is
  // module-level and would suppress a re-seed of the same titles.
  const refillsFor = (med: string) => [
    { title: `Refill ${med} prescription (100mg) - August`, dueDate: "2027-08-08" },
    { title: `Refill ${med} prescription (100mg) - September`, dueDate: "2027-09-07" },
    { title: `Refill ${med} prescription (100mg) - October`, dueDate: "2027-10-07" },
  ];

  async function seed(storage: MemStorage, med: string) {
    return requestStorageContext.run(storage, async () => {
      for (const r of refillsFor(med)) await executeTool("create_task", r, USER);
    });
  }

  it("removes every occurrence, not just the one named", async () => {
    const storage = new MemStorage();
    await seed(storage, "Propranolol");
    const out = await requestStorageContext.run(storage, async () => {
      const res = await executeTool("delete_task", { title: "Refill Propranolol prescription (100mg) - September" }, USER);
      const left = (await storage.getTasks()).filter((t: any) => !t.deletedAt && /Propranolol/.test(t.title));
      return { res, left };
    });

    expect(out.res.seriesDeleted).toBe(true);
    expect(out.res.count).toBe(3);
    expect(out.res.recurrence).toBe("monthly");
    // Gone from the tasks table, which is what the calendar and the recurring
    // tab both read — one delete, every surface.
    expect(out.left).toHaveLength(0);
  });

  it("tells the model to report it as a repeating task", async () => {
    const storage = new MemStorage();
    await seed(storage, "Metformin");
    const res = await requestStorageContext.run(storage, () =>
      executeTool("delete_task", { title: "Refill Metformin" }, USER));
    expect(res.message).toMatch(/whole/i);
    expect(res.message).toMatch(/monthly/i);
    expect(res.message).toMatch(/calendar/i);
  });

  // Naming the SCHEDULE rather than one occurrence used to be refused:
  // "Multiple matches for 'Refill Propranolol'. Please be more specific."
  // Every one of those matches is the thing the user meant.
  it("resolves 'which one?' into the series instead of refusing", async () => {
    const storage = new MemStorage();
    await seed(storage, "Lisinopril");
    const out = await requestStorageContext.run(storage, async () => {
      const res = await executeTool("delete_task", { title: "Refill Lisinopril" }, USER);
      const left = (await storage.getTasks()).filter((t: any) => /Lisinopril/.test(t.title));
      return { res, left };
    });
    expect(out.res.error).toBeUndefined();
    expect(out.res.seriesDeleted).toBe(true);
    expect(out.res.count).toBe(3);
    expect(out.left).toHaveLength(0);
  });

  // ...but a genuinely ambiguous title across UNRELATED tasks must still ask.
  it("still refuses when the matches are not one schedule", async () => {
    const storage = new MemStorage();
    const res = await requestStorageContext.run(storage, async () => {
      await executeTool("create_task", { title: "Pay the water bill", dueDate: "2027-08-04" }, USER);
      await executeTool("create_task", { title: "Pay the power bill", dueDate: "2027-08-05" }, USER);
      return executeTool("delete_task", { title: "Pay the" }, USER);
    });
    expect(res.error).toMatch(/multiple|specific|not found/i);
    expect(res.seriesDeleted).toBeUndefined();
  });

  it("leaves an ordinary one-off task deleting exactly one row", async () => {
    const storage = new MemStorage();
    const out = await requestStorageContext.run(storage, async () => {
      await executeTool("create_task", { title: "Book the chimney sweep", dueDate: "2027-08-04" }, USER);
      await executeTool("create_task", { title: "Order new tyres", dueDate: "2027-08-15" }, USER);
      const res = await executeTool("delete_task", { title: "Book the chimney sweep" }, USER);
      const left = (await storage.getTasks()).filter((t: any) => !t.deletedAt);
      return { res, left };
    });
    expect(out.res.seriesDeleted).toBeUndefined();
    expect(out.left.map((t: any) => t.title)).toEqual(["Order new tyres"]);
  });
});
