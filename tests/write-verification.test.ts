// Post-write verification — the "Portol said it saved and it didn't" class.
//
// User QA 2026-07-27 reported the same failure shape across six features: a
// tracker entry that never existed, a profile rename that silently no-opped, a
// note filed under the account owner instead of the named profile, a medication
// likewise, an expense reassignment that kept a stale link — and in EVERY case
// the assistant reported success.
//
// Root cause: finalizeToolResult asserted `success: true` unconditionally. It
// computed `verification.database_record_exists` and then ignored it, so the
// contradicting evidence shipped inside a payload labelled success. These tests
// pin the verdict logic, and equally that a WORKING write is never failed.
import { describe, it, expect } from "vitest";
import {
  finalizeToolResult, buildTurnVerifyContext, verifyAppliedChanges, verifyRequestedProfile,
} from "../server/ai-envelope";

const PROFILES = [
  { id: "self-1", name: "Me", type: "self" },
  { id: "p-craig", name: "Craig", type: "person" },
  { id: "p-rex", name: "Rex", type: "pet" },
];

/** Minimal storage double — only the list reads the envelope performs. */
const storageWith = (over: Record<string, any[]>): any => ({
  getProfiles: async () => over.profiles ?? PROFILES,
  getTasks: async () => over.tasks ?? [],
  getExpenses: async () => over.expenses ?? [],
  getIncomes: async () => [],
  getEvents: async () => [],
  getHabits: async () => [],
  getTrackers: async () => over.trackers ?? [],
  getGoals: async () => [],
  getObligations: async () => [],
  getJournalEntries: async () => over.journal ?? [],
  getMemories: async () => [],
  getArtifacts: async () => [],
  listReminders: async () => [],
  getDocuments: async () => over.documents ?? [],
  getPaychecks: async () => [],
});

const ctxWith = (over: Record<string, any[]> = {}) => buildTurnVerifyContext(storageWith(over));

describe("honest success — a write whose read-back fails must NOT report success", () => {
  it("fails a tracker entry that left no database row", async () => {
    // The reported case: "24 oz saved", displayed immediately, gone on refresh.
    const ctx = ctxWith({ trackers: [{ id: "t1", name: "Hydration", entries: [] }] });
    const out = await finalizeToolResult(
      "log_tracker_entry", "tracker",
      { trackerName: "Hydration", values: { amount: 24 } },
      { id: "entry-missing", values: { amount: 24 } },
      ctx,
    );
    expect(out.success).toBe(false);
    expect(out.verification_failed).toBe(true);
    expect(out.error).toMatch(/no database row exists/i);
    expect(out.verification.database_record_exists).toBe(false);
  });

  it("passes a tracker entry that IS in the database", async () => {
    const ctx = ctxWith({
      trackers: [{ id: "t1", name: "Hydration", entries: [{ id: "e1", values: { amount: 24 } }] }],
    });
    const out = await finalizeToolResult(
      "log_tracker_entry", "tracker",
      { trackerName: "Hydration", values: { amount: 24 } },
      { id: "e1", values: { amount: 24 } },
      ctx,
    );
    expect(out.success).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.verification.database_record_exists).toBe(true);
  });

  it("fails a delete whose record is still there", async () => {
    const ctx = ctxWith({ tasks: [{ id: "task-1", title: "Test task" }] });
    const out = await finalizeToolResult("delete_task", "task", { title: "Test task" }, { id: "task-1" }, ctx);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/still exists/i);
  });
});

describe("applied-change verification — 'row exists' is not proof the edit landed", () => {
  it("fails a profile rename that silently no-opped, naming the field", async () => {
    // Exactly the reported case: birthday + notes applied, rename did not.
    const ctx = ctxWith({
      profiles: PROFILES.map(p => p.id === "p-craig"
        ? { ...p, fields: { birthday: "1990-04-02" }, notes: "updated" }   // name UNCHANGED
        : p),
    });
    const out = await finalizeToolResult(
      "update_profile", "profile",
      { name: "Craig", changes: { name: "Craig Jr", notes: "updated", fields: { birthday: "1990-04-02" } } },
      { id: "p-craig" },
      ctx,
    );
    expect(out.success).toBe(false);
    expect(out.verification.fields_not_applied).toEqual(["name"]);
    expect(out.verification.fields_applied).toEqual(expect.arrayContaining(["notes", "fields.birthday"]));
    expect(out.error).toMatch(/did NOT persist: name/);
  });

  it("fails a journal date change that didn't take", async () => {
    const ctx = ctxWith({ journal: [{ id: "j1", content: "new content", date: "2026-07-20" }] });
    const out = await finalizeToolResult(
      "update_journal", "journal",
      { date: "2026-07-20", changes: { content: "new content", date: "2026-07-18" } },
      { id: "j1" },
      ctx,
    );
    expect(out.success).toBe(false);
    expect(out.verification.fields_not_applied).toEqual(["date"]);
  });

  it("passes when every requested change landed", async () => {
    const ctx = ctxWith({ tasks: [{ id: "t1", title: "Renamed", status: "done", priority: "high" }] });
    const out = await finalizeToolResult(
      "update_task", "task",
      { title: "Old", changes: { title: "Renamed", status: "done", priority: "high" } },
      { id: "t1" },
      ctx,
    );
    expect(out.success).toBe(true);
    expect(out.verification.fields_not_applied).toBeUndefined();
  });
});

describe("verifyAppliedChanges — must not raise FALSE failures", () => {
  const row = {
    title: "Ship it", status: "completed", amount: 1200, dueDate: "2026-08-15T00:00:00.000Z",
    tags: ["a", "b"], autopay: true, fields: { birthday: "1990-04-02" },
  };

  it("accepts values storage canonicalized on the way in", () => {
    expect(verifyAppliedChanges({ status: "done" }, row).notApplied).toEqual([]);      // done ≡ completed
    expect(verifyAppliedChanges({ amount: "1200" }, row).notApplied).toEqual([]);      // string number
    expect(verifyAppliedChanges({ dueDate: "2026-08-15" }, row).notApplied).toEqual([]); // date vs timestamp
    expect(verifyAppliedChanges({ tags: ["B", "a"] }, row).notApplied).toEqual([]);    // order/case
    expect(verifyAppliedChanges({ autopay: "true" as any }, row).notApplied).toEqual([]);
    expect(verifyAppliedChanges({ title: " Ship it " }, row).notApplied).toEqual([]);  // whitespace
  });

  it("cannot verify a key the row doesn't carry — reports nothing rather than failing", () => {
    const r = verifyAppliedChanges({ someServerRenamedThing: "x" }, row);
    expect(r.notApplied).toEqual([]);
    expect(r.applied).toEqual([]);
  });

  it("verifies a rename INSIDE changes rather than mistaking it for a lookup key", () => {
    // `name`/`title`/`date` are lookup keys at the tool input's top level, but
    // inside `changes` they are the values being applied. Treating them as
    // lookups is exactly what let the failed rename report success.
    expect(verifyAppliedChanges({ title: "Ship it" }, row).applied).toEqual(["title"]);
    expect(verifyAppliedChanges({ name: "not-a-column" }, row).notApplied).toEqual([]); // row has no `name`
  });

  it("still catches a real miss", () => {
    expect(verifyAppliedChanges({ title: "Something else" }, row).notApplied).toEqual(["title"]);
    expect(verifyAppliedChanges({ fields: { birthday: "2000-01-01" } }, row).notApplied).toEqual(["fields.birthday"]);
  });
});

describe("requested-profile verification — 'isolation valid' says nothing about WHOSE", () => {
  it("fails a note filed under the account owner instead of the named profile", async () => {
    const r = await verifyRequestedProfile(
      { forProfile: "Craig" }, { id: "d1", linkedProfiles: ["self-1"] }, ctxWith(),
    );
    expect(r.applied).toBe(false);
  });

  it("fails a medication attached to the owner rather than the person named", async () => {
    const ctx = ctxWith({ trackers: [{ id: "tr1", name: "Lisinopril", linkedProfiles: ["self-1"], entries: [{ id: "e1" }] }] });
    const out = await finalizeToolResult(
      "create_tracker", "tracker",
      { name: "Lisinopril", forProfile: "Rex" },
      { id: "tr1" }, ctx,
    );
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/NOT attributed to the requested profile "Rex"/);
  });

  it("flags a reassignment that added the destination but kept a stale link", async () => {
    const r = await verifyRequestedProfile(
      { forProfile: "Craig" }, { id: "e1", linkedProfiles: ["p-craig", "self-1"] }, ctxWith(),
    );
    expect(r.applied).toBe(true);
    expect(r.unexpected).toEqual(["self-1"]);
  });

  it("passes a clean attribution to exactly the requested profile", async () => {
    const r = await verifyRequestedProfile(
      { forProfile: "Craig" }, { id: "e1", linkedProfiles: ["p-craig"] }, ctxWith(),
    );
    expect(r).toEqual({ applied: true });
  });

  it("stays silent when the request named no profile", async () => {
    expect(await verifyRequestedProfile({}, { id: "x", linkedProfiles: ["self-1"] }, ctxWith())).toEqual({});
  });

  it("stays silent when the named profile doesn't exist (a different error owns that)", async () => {
    expect(await verifyRequestedProfile({ forProfile: "Nobody" }, { id: "x", linkedProfiles: ["self-1"] }, ctxWith())).toEqual({});
  });
});

describe("the envelope still never breaks a tool", () => {
  it("returns the raw result when the storage read throws", async () => {
    const ctx = buildTurnVerifyContext({ getTasks: async () => { throw new Error("db down"); } } as any);
    const out = await finalizeToolResult("update_task", "task", { changes: { title: "x" } }, { id: "t1" }, ctx);
    expect(out.success).toBe(true); // no evidence of failure = no accusation
  });
});
