// tests/qa-2026-08-22-run002.test.ts
//
// QA run 002 (2026-08-22, "Five sentences, twenty facts"). Each block below is
// one reported defect, reproduced first and then pinned.
//
//   B1   "I walked the dog, spent $38 on gas, and John's new email is …"
//        dropped two of three actions to a "routing conflict"
//   B1b  the dog-walk habit mis-targeted a generic Walking tracker
//   B2   a SAVED bill payment was reported as "Nothing was saved"
//   B3   paying a bill (or retrying after B2's false failure) advanced the
//        recurrence two cycles — September vanished from the schedule
//   B4   "Add Sarah's birthday as May 8" became only a calendar rule; the
//        profile never got a BIRTHDAY field
//   B5   duplicate Hydration trackers split the day's water log, so the
//        Wellness ring never moved
//   B9   recur:yearly / ranchor:1 / migrated:reminder rendered as tag chips
//   B12  person cards on the Everyone grid bounced back to the grid
//   B13  a just-created expense rendered "19h ago" in Recent Activity
import { describe, it, expect } from "vitest";
import { parseTurnPlan } from "@shared/ai-intent";
import { checkToolAgainstIntent } from "@shared/ai-tool-routing";
import { detectHabitMetric } from "@shared/habit-metric";
import { getUserToday, DEFAULT_TIMEZONE } from "@shared/timezone";
import { MemStorage, requestStorageContext } from "../server/storage";
import { executeTool } from "../server/ai-engine";
import { finalizeToolResult, buildTurnVerifyContext } from "../server/ai-envelope";
import { readDailyTotal } from "../client/src/lib/wellness-metrics";
import { visibleTaskTags } from "@shared/hidden-task-tags";
import { reconcileInfoRoute } from "../client/src/components/hub/hub-routes";
import type { Tracker } from "@shared/schema";

const run = <T>(storage: MemStorage, fn: () => Promise<T>) => requestStorageContext.run(storage, fn);

// ─────────────────────────────────────────────────────────────────────────────
// B1 — a message the parser only half-understands must not gate the half it
// missed. The write-verb clause splitter can't decompose this sentence (no
// clause starts with a write verb), so it parsed as ONE expense intent and —
// because that lone read was declared `exhaustive` — the gate blocked the
// habit check-in and the profile update as "wrong entity".
// ─────────────────────────────────────────────────────────────────────────────

describe("B1 — the intent gate stands down on messages it can't fully read", () => {
  const MSG = "I walked the dog this morning, spent $38 on gas, and John's new email is johnsmith@gmail.com";

  it("does not claim the whole message was understood", () => {
    expect(parseTurnPlan(MSG).exhaustive).toBe(false);
  });

  it("allows every tool the dropped clauses need", () => {
    const plan = parseTurnPlan(MSG);
    for (const tool of ["checkin_habit", "log_tracker_entry", "update_profile", "create_expense"]) {
      expect(checkToolAgainstIntent(tool, plan), tool).toBeNull();
    }
  });

  it("still gates a fully-understood single request", () => {
    // The safety valve must not have been welded open: a message the parser
    // reads completely still blocks the wrong tool.
    const plan = parseTurnPlan("Create an asset for my Dodge ram 2025 it's white four-wheel-drive");
    expect(plan.exhaustive).toBe(true);
    expect(checkToolAgainstIntent("checkin_habit", plan)?.mismatchType).toBe("entity_mismatch");
  });

  it("still gates a multi-request message it fully decomposed", () => {
    const plan = parseTurnPlan("Add a task to call the dentist and log $20 for lunch");
    expect(plan.exhaustive).toBe(true);
    expect(checkToolAgainstIntent("create_task", plan)).toBeNull();
    expect(checkToolAgainstIntent("create_expense", plan)).toBeNull();
  });
});

describe("B1b — a specific habit never adopts a generic tracker", () => {
  it("'Walk the Dog' offers only its own names as tracker candidates", () => {
    const m = detectHabitMetric("Walk the Dog")!;
    expect(m.specific).toBe(true);
    expect(m.candidates).toEqual(["Walk the Dog", "Walk Dog"]);
    // The generic activity names must be gone: with two "Walking" trackers in
    // the account, `candidates[2] === "Walking"` is what mis-targeted the
    // check-in (and would have persisted the link onto the habit).
    expect(m.candidates).not.toContain("Walking");
    expect(m.candidates).not.toContain("Steps");
  });

  it("a generic habit still folds into the canonical tracker", () => {
    // "Drink More Water" is not a particular water — "More" is filler, and the
    // habit must keep reusing an existing Hydration tracker.
    const m = detectHabitMetric("Drink More Water")!;
    expect(m.specific ?? false).toBe(false);
    expect(m.candidates).toContain("Hydration");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B2 / B3 — pay_obligation. The payment row's id is not an obligations-table
// id, so read-back verification scanned the wrong list, reported a saved
// payment as "Nothing was saved", and the model's retry then advanced the due
// date a SECOND cycle: Sep 15 became Oct 15 and September disappeared.
// ─────────────────────────────────────────────────────────────────────────────

describe("B2/B3 — paying a bill verifies, and repeats are idempotent", () => {
  const seed = async (storage: MemStorage) =>
    run(storage, () => storage.createObligation({
      name: "QA Phone Bill", amount: 92, frequency: "monthly", nextDueDate: "2026-08-15",
      category: "utilities",
    } as any));

  it("a successful payment's envelope confirms the write (B2)", async () => {
    const storage = new MemStorage();
    await seed(storage);
    const input = { name: "phone bill", amount: 92, __userMessage: "I paid my phone bill today" };
    const res: any = await run(storage, () => executeTool("pay_obligation", input, "user-qa-b2"));
    expect(res.error).toBeUndefined();
    const env: any = await run(storage, () =>
      finalizeToolResult("pay_obligation", "pay_obligation", input, res, buildTurnVerifyContext(storage)));
    // The bug: database_record_exists === false → "Nothing was saved. Tell the
    // user the save failed and to try again" — for a payment that HAD saved.
    expect(env.verification?.database_record_exists).not.toBe(false);
    expect(env.success).not.toBe(false);
    expect(String(env.error || "")).not.toMatch(/could NOT be confirmed/i);
  });

  it("paying twice posts once and advances one cycle (B3)", async () => {
    const storage = new MemStorage();
    const ob = await seed(storage);
    const input = { name: "phone bill", amount: 92, __userMessage: "I paid my phone bill today" };
    await run(storage, () => executeTool("pay_obligation", input, "user-qa-b3"));
    // The retry a false failure report invites — and the user's own manual
    // retry after being told to "try again".
    await run(storage, () => executeTool("pay_obligation", input, "user-qa-b3"));
    const after: any = (await run(storage, () => storage.getObligations())).find((o: any) => o.id === ob.id);
    expect(after.payments).toHaveLength(1);
    // One cycle from Aug 15 is Sep 15. The double advance read Oct 15.
    expect(after.nextDueDate).toBe("2026-09-15");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B4 — a birthday stated without a year ("May 8") resolves to the UPCOMING
// May 8, so the old `year < thisYear` guard treated it as an occurrence and
// never wrote the profile field. When the user stated no year and the profile
// holds no birthday, the month/day IS the fact — it belongs on the profile.
// ─────────────────────────────────────────────────────────────────────────────

describe("B4 — a yearless birthday lands on the profile", () => {
  const nextMay8 = () => {
    const today = getUserToday(DEFAULT_TIMEZONE);
    const y = Number(today.slice(0, 4));
    return today.slice(5) <= "05-08" ? `${y}-05-08` : `${y + 1}-05-08`;
  };

  it("writes the BIRTHDAY field when no year was stated", async () => {
    const storage = new MemStorage();
    const sarah = await run(storage, () => storage.createProfile({ type: "person", name: "Sarah Miller" } as any));
    const res: any = await run(storage, () => executeTool("create_event", {
      title: "Sarah Miller's Birthday", date: nextMay8(), recurrence: "yearly",
      forProfile: "Sarah Miller",
      __userMessage: "Add Sarah's birthday as May 8, make a note that she hates cilantro, and remind me every year a week before her birthday",
    }, "user-qa-b4"));
    expect(res.error).toBeUndefined();
    expect(res.result?.savedTo).toBe("profile");
    const after: any = await run(storage, () => storage.getProfile(sarah.id));
    const fields = after?.fields || {};
    expect(fields.dateOfBirth ?? fields.birthday).toBe(nextMay8());
  });

  it("never overwrites a real date of birth with an occurrence", async () => {
    const storage = new MemStorage();
    const joe = await run(storage, () => storage.createProfile({
      type: "person", name: "Joe Miller", fields: { dateOfBirth: "1990-05-08" },
    } as any));
    const res: any = await run(storage, () => executeTool("create_event", {
      title: "Joe Miller's Birthday", date: nextMay8(), recurrence: "yearly",
      forProfile: "Joe Miller",
      __userMessage: "add Joe's birthday to the calendar for May 8",
    }, "user-qa-b4b"));
    expect(res.result?.savedTo).not.toBe("profile");
    const after: any = await run(storage, () => storage.getProfile(joe.id));
    expect(after?.fields?.dateOfBirth).toBe("1990-05-08");
  });

  it("a stated past year is still stored as the date of birth", async () => {
    const storage = new MemStorage();
    const ann = await run(storage, () => storage.createProfile({ type: "person", name: "Ann Lee" } as any));
    const res: any = await run(storage, () => executeTool("create_event", {
      title: "Ann Lee's Birthday", date: "1994-07-10", recurrence: "yearly",
      forProfile: "Ann Lee",
      __userMessage: "Ann's birthday is July 10, 1994",
    }, "user-qa-b4c"));
    expect(res.result?.savedTo).toBe("profile");
    const after: any = await run(storage, () => storage.getProfile(ann.id));
    expect(after?.fields?.dateOfBirth).toBe("1994-07-10");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B5 — the daily total for additive metrics must survive duplicate trackers.
// The chat wrote 32 oz into the profile-owned Hydration; the ring read the
// first name-match and stayed at 16.
// ─────────────────────────────────────────────────────────────────────────────

describe("B5 — readDailyTotal sums across duplicate trackers", () => {
  const t = (partial: Partial<Tracker>): Tracker => ({
    id: "t", name: "T", category: "health", unit: "", icon: "",
    fields: [{ name: "ounces", type: "number", unit: "oz", isPrimary: true }],
    entries: [], linkedProfiles: [], createdAt: "2026-01-01T00:00:00Z",
    ...partial,
  } as Tracker);
  const now = new Date().toISOString();

  it("today's entries in BOTH Hydration trackers count", () => {
    const trackers = [
      t({ id: "h-new", name: "Hydration", entries: [{ id: "e1", timestamp: now, values: { ounces: 16 } }] as any }),
      t({ id: "h-owned", name: "Hydration", entries: [{ id: "e2", timestamp: now, values: { ounces: 32 } }] as any }),
    ];
    expect(readDailyTotal(trackers, [/hydration|water/], { unit: "oz" }).value).toBe(48);
  });

  it("an entry logged only into the SECOND duplicate still reaches the total", () => {
    const trackers = [
      t({ id: "h-new", name: "Hydration", entries: [] }),
      t({ id: "h-owned", name: "Hydration", entries: [{ id: "e2", timestamp: now, values: { ounces: 32 } }] as any }),
    ];
    expect(readDailyTotal(trackers, [/hydration|water/], { unit: "oz" }).value).toBe(32);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B9 — system-encoded task tags are machine state, not chips. The Tasks page
// printed recur:yearly · ranchor:1 · migrated:reminder · runtil:2027-08-03 as
// visible badges.
// ─────────────────────────────────────────────────────────────────────────────

describe("B9 — internal task tags never render", () => {
  it("hides every leaked tag from the report, keeps the user's own", () => {
    expect(visibleTaskTags([
      "recur:yearly", "ranchor:1", "migrated:reminder", "runtil:2027-08-03",
      "rcount:3", "rdone:1", "rpaused", "prio:high", "st:1:buy milk", "allday",
      "groceries", "family",
    ])).toEqual(["groceries", "family"]);
  });

  it("tolerates missing tags", () => {
    expect(visibleTaskTags(undefined)).toEqual([]);
    expect(visibleTaskTags(null)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B12 — under "Everyone", tapping a person card (or opening a deep link)
// bounced straight back to the people grid: the scope reconciler rewrote
// every /profiles/<id>/info to infoTabRoute([]) === "/profiles". A pure
// NAVIGATION to a person who is in scope must stand; a SCOPE change away from
// them still reconciles (the 2026-07-25 invariant).
// ─────────────────────────────────────────────────────────────────────────────

describe("B12 — person cards open under Everyone", () => {
  it("a navigation to an in-scope person stands", () => {
    expect(reconcileInfoRoute("/profiles/alice-id/info", [], { scopeChanged: false })).toBeNull();
    expect(reconcileInfoRoute("/profiles/alice-id/info", ["alice-id", "bob-id"], { scopeChanged: false })).toBeNull();
  });

  it("a scope change away from the person still reconciles", () => {
    expect(reconcileInfoRoute("/profiles/alice-id/info", [], { scopeChanged: true })).toBe("/profiles");
    expect(reconcileInfoRoute("/profiles/alice-id/info", [])).toBe("/profiles");
  });

  it("an OUT-of-scope person reconciles even on pure navigation", () => {
    expect(reconcileInfoRoute("/profiles/alice-id/info", ["bob-id"], { scopeChanged: false }))
      .toBe("/profiles/bob-id/info");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B13 — Recent Activity stamps an expense with the moment it was created, not
// its date-only value (which, read as UTC midnight, rendered "19h ago").
// ─────────────────────────────────────────────────────────────────────────────

describe("B13 — a fresh expense is 'just now', not '19h ago'", () => {
  it("recentActivity carries the createdAt instant", async () => {
    const storage = new MemStorage();
    const today = getUserToday(DEFAULT_TIMEZONE);
    await run(storage, () => storage.createExpense({ description: "Gas", amount: 38, category: "transport", date: today } as any));
    const stats: any = await run(storage, () => storage.getStats());
    const row = (stats.recentActivity || []).find((r: any) => r.type === "expense");
    expect(row).toBeTruthy();
    const ageMs = Date.now() - new Date(row.timestamp).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(60_000);
  });
});
