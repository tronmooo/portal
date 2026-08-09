// ── Envelope + verification unit tests (server/ai-envelope.ts) ───────────────
// Stub-storage tests for the standard tool-result envelope: read-back
// existence, duplicate counting, profile isolation, delete semantics, and —
// critically — raw-result spread preservation (the chat UI's undo cards and
// the entityId extraction in processMessage read raw keys off the result).
import { describe, it, expect } from "vitest";
import { finalizeToolResult, buildTurnVerifyContext, classifyOperation } from "../server/ai-envelope";

const PROFILES = [
  { id: "self-1", type: "self", name: "Me" },
  { id: "mike-1", type: "person", name: "Mike" },
];

function stubStorage(overrides: Record<string, any> = {}): any {
  return {
    getProfiles: async () => PROFILES,
    getTasks: async () => [],
    getExpenses: async () => [],
    getIncomes: async () => [],
    getEvents: async () => [],
    getHabits: async () => [],
    getTrackers: async () => [],
    getGoals: async () => [],
    getObligations: async () => [],
    getJournalEntries: async () => [],
    getMemories: async () => [],
    getArtifacts: async () => [],
    listReminders: async () => [],
    getReminder: async () => undefined,
    getDocuments: async () => [],
    getPaychecks: async () => [],
    getTrackerEntry: async () => undefined,
    ...overrides,
  };
}

describe("classifyOperation", () => {
  it("classifies create/log/journal/save/duplicate as create", () => {
    for (const t of ["create_task", "log_income", "journal_entry", "save_memory", "duplicate_artifact", "add_liability_payment"])
      expect(classifyOperation(t), t).toBe("create");
  });
  it("classifies delete_* as delete and the rest as update", () => {
    expect(classifyOperation("delete_expense")).toBe("delete");
    expect(classifyOperation("complete_task")).toBe("update");
    expect(classifyOperation("pay_obligation")).toBe("update");
    expect(classifyOperation("restore_task")).toBe("update");
  });
});

describe("finalizeToolResult", () => {
  it("create: read-back exists + duplicate_count + isolation valid", async () => {
    const storage = stubStorage({
      getTasks: async () => [
        { id: "t1", title: "Buy milk", linkedProfiles: ["mike-1"] },
        { id: "t0", title: "Buy milk!", linkedProfiles: [] }, // normalized duplicate
      ],
    });
    const ctx = buildTurnVerifyContext(storage);
    const env = await finalizeToolResult("create_task", "create_task", { title: "Buy milk" }, { id: "t1", title: "Buy milk" }, ctx);
    expect(env.success).toBe(true);
    expect(env.action).toBe("create_task");
    expect(env.entity).toMatchObject({ type: "task", id: "t1", name: "Buy milk" });
    expect(env.verification.database_record_exists).toBe(true);
    expect(env.verification.duplicate_count).toBe(1);
    expect(env.verification.profile_isolation_valid).toBe(true);
  });

  it("create: isolation flags a linked profile that is not the user's", async () => {
    const storage = stubStorage({
      getTasks: async () => [{ id: "t9", title: "X", linkedProfiles: ["someone-elses-profile"] }],
    });
    const ctx = buildTurnVerifyContext(storage);
    const env = await finalizeToolResult("create_task", "create_task", { title: "X" }, { id: "t9" }, ctx);
    expect(env.verification.profile_isolation_valid).toBe(false);
  });

  // Production audit 2026-07-29, blocker #2: a write we affirmatively read back
  // as absent is a FAILED write. This used to assert `success: true` on the
  // theory that the envelope only reports and "the MODEL decides how to phrase
  // it" — in production the model did not decide correctly, and told users
  // their data was saved when no row existed. The envelope now decides.
  it("create: missing read-back row is a failure, not a success", async () => {
    const ctx = buildTurnVerifyContext(stubStorage()); // empty task list
    const env = await finalizeToolResult("create_task", "create_task", { title: "Ghost" }, { id: "nope" }, ctx);
    expect(env.success).toBe(false);
    expect(env.verification.database_record_exists).toBe(false);
    expect(env.error).toMatch(/could NOT be confirmed/i);
    // The failure message must not read as a success to the model.
    expect(env.message).toMatch(/do NOT report success/i);
  });

  // ── Blocker #2 regression: tracker entries (the "logged 24 oz" defect) ─────
  // `log_tracker_entry` was absent from the tool→entity map entirely, so a
  // logged entry got a `success: true` envelope with NO verification at all.
  describe("tracker entries are verified by primary key", () => {
    it("log_tracker_entry: confirmed row reports success", async () => {
      const storage = stubStorage({
        getTrackerEntry: async (id: string) =>
          id === "te-1" ? { id: "te-1", values: { ounces: 24 }, timestamp: "2026-07-29T00:00:00Z" } : undefined,
      });
      const ctx = buildTurnVerifyContext(storage);
      const env = await finalizeToolResult(
        "log_tracker_entry", "log_entry",
        { trackerName: "Hydration", values: { ounces: 24 } },
        { id: "te-1", values: { ounces: 24 } }, ctx,
      );
      expect(env.success).toBe(true);
      expect(env.verification.database_record_exists).toBe(true);
      expect(env.entity).toMatchObject({ type: "trackerEntry", id: "te-1" });
    });

    it("log_tracker_entry: absent row is a failure, never a silent success", async () => {
      // Exactly the audited scenario: the tool returned an entry object, but
      // the database has no such row.
      const ctx = buildTurnVerifyContext(stubStorage()); // getTrackerEntry → undefined
      const env = await finalizeToolResult(
        "log_tracker_entry", "log_entry",
        { trackerName: "Hydration", values: { ounces: 24 } },
        { id: "te-ghost", values: { ounces: 24 } }, ctx,
      );
      expect(env.success).toBe(false);
      expect(env.verification.database_record_exists).toBe(false);
      expect(env.error).toMatch(/could NOT be confirmed/i);
    });

    it("uses the by-id read-back, not the truncated tracker list", async () => {
      // A real entry that the (capped) tracker list does not include must
      // still verify as existing — otherwise a good write reports as failed.
      let listCalls = 0;
      const storage = stubStorage({
        getTrackers: async () => { listCalls++; return [{ id: "tr-1", name: "Hydration", entries: [] }]; },
        getTrackerEntry: async (id: string) => ({ id, values: { ounces: 24 } }),
      });
      const ctx = buildTurnVerifyContext(storage);
      const env = await finalizeToolResult(
        "log_tracker_entry", "log_entry", { trackerName: "Hydration" }, { id: "te-old" }, ctx,
      );
      expect(env.success).toBe(true);
      expect(env.verification.database_record_exists).toBe(true);
      expect(listCalls).toBe(0); // never paid for the list read
    });

    it("delete_tracker_entry: gone means the delete is confirmed", async () => {
      const ctx = buildTurnVerifyContext(stubStorage());
      const env = await finalizeToolResult(
        "delete_tracker_entry", "delete_entity", {}, { deleted: true, id: "te-1" }, ctx,
      );
      expect(env.success).toBe(true);
      expect(env.verification.database_record_exists).toBe(false);
    });
  });

  // ── Regression: the "reminder system save failure" ────────────────────────
  // create_reminder returns the mirrored CALENDAR EVENT's id as its top-level
  // `id` so the chat card's Undo targets the visible calendar entry. Read-back
  // then looked that event id up in the reminders table, never found it, and
  // told users six genuinely-saved reminders "could NOT be confirmed …
  // Nothing was saved" — permanently, since the (title, fire_at) dedup makes
  // every retry return the same rows and fail identically.
  describe("_verify hint: tools whose card id is not the row they wrote", () => {
    const REM = { id: "rem-1", title: "Put out the trash", fireAt: "2026-08-06T19:00:00Z" };
    const remStorage = () => stubStorage({
      getReminder: async (id: string) => (id === REM.id ? REM : undefined),
      listReminders: async () => { throw new Error("must not scan the pending list"); },
    });
    const remResult = {
      id: "evt-9",                 // the mirrored calendar event
      _verify: { type: "reminder", id: REM.id },
      reminderId: REM.id,
      eventId: "evt-9",
      title: REM.title,
    };

    it("verifies the reminder row, not the mirrored event", async () => {
      const env = await finalizeToolResult(
        "create_reminder", "create_reminder", { title: REM.title }, remResult, buildTurnVerifyContext(remStorage()),
      );
      expect(env.success).toBe(true);
      expect(env.verification.database_record_exists).toBe(true);
      expect(env.entity).toMatchObject({ type: "reminder", id: REM.id });
      // The card still deep-links to the calendar entry.
      expect(env.id).toBe("evt-9");
    });

    it("strips the hint so it never reaches the model or the client", async () => {
      const env = await finalizeToolResult(
        "create_reminder", "create_reminder", { title: REM.title }, remResult, buildTurnVerifyContext(remStorage()),
      );
      expect(env._verify).toBeUndefined();
      expect(env.reminderId).toBe(REM.id); // every other raw key survives
    });

    it("still fails a reminder that genuinely was not written", async () => {
      const env = await finalizeToolResult(
        "create_reminder", "create_reminder", { title: "Ghost" },
        { id: "evt-9", _verify: { type: "reminder", id: "rem-ghost" } },
        buildTurnVerifyContext(remStorage()),
      );
      expect(env.success).toBe(false);
      expect(env.error).toMatch(/could NOT be confirmed/i);
      expect(env._verify).toBeUndefined();
    });

    it("without a hint, falls back to the raw result id", async () => {
      const env = await finalizeToolResult(
        "create_reminder", "create_reminder", { title: REM.title },
        { id: REM.id, title: REM.title },
        buildTurnVerifyContext(remStorage()),
      );
      expect(env.success).toBe(true);
      expect(env.entity).toMatchObject({ type: "reminder", id: REM.id });
    });
  });

  it("delete: a row still present after delete is a failure", async () => {
    const storage = stubStorage({
      getExpenses: async () => [{ id: "e1", description: "coffee", linkedProfiles: [] }],
    });
    const ctx = buildTurnVerifyContext(storage);
    const env = await finalizeToolResult("delete_expense", "delete_entity", { description: "coffee" }, { deleted: true, id: "e1" }, ctx);
    expect(env.success).toBe(false);
    expect(env.error).toMatch(/still exists/i);
  });

  it("delete: absence of the live row means the delete is confirmed", async () => {
    const ctx = buildTurnVerifyContext(stubStorage()); // row gone from list
    const env = await finalizeToolResult("delete_expense", "delete_entity", { description: "coffee" }, { deleted: true, id: "e1" }, ctx);
    expect(env.verification.database_record_exists).toBe(false);
  });

  it("update: existence-only (no duplicate_count)", async () => {
    const storage = stubStorage({
      getHabits: async () => [{ id: "h1", name: "Stretch", linkedProfiles: [] }],
    });
    const ctx = buildTurnVerifyContext(storage);
    const env = await finalizeToolResult("update_habit", "update_entity", { name: "Stretch" }, { updated: true, habit: { id: "h1" } }, ctx);
    expect(env.verification.database_record_exists).toBe(true);
    expect(env.verification.duplicate_count).toBeUndefined();
    expect(env.verification.profile_isolation_valid).toBe(true); // orphan → self rule
  });

  it("preserves every raw key (spread last) — undo cards depend on this", async () => {
    const storage = stubStorage({ getProfiles: async () => PROFILES });
    const ctx = buildTurnVerifyContext(storage);
    const raw = { id: "p1", updated: true, _previousState: { fields: { a: 1 } }, profile: { id: "p1" } };
    const env = await finalizeToolResult("update_profile", "update_profile", { name: "Mike" }, raw, ctx);
    expect(env.id).toBe("p1");
    expect(env._previousState).toEqual({ fields: { a: 1 } });
    expect(env.profile).toEqual({ id: "p1" });
  });

  it("unmapped tools get the envelope without verification", async () => {
    const ctx = buildTurnVerifyContext(stubStorage());
    const env = await finalizeToolResult("set_budget", "set_budget", { category: "food", amount: 100 }, { success: true, budget: { id: "b1" } }, ctx);
    expect(env.action).toBe("set_budget");
    expect(env.verification).toBeUndefined();
  });

  it("never throws — a broken storage returns the raw result", async () => {
    const storage = stubStorage({ getTasks: async () => { throw new Error("boom"); }, getProfiles: async () => { throw new Error("boom"); } });
    const ctx = buildTurnVerifyContext(storage);
    const raw = { id: "t1", title: "X" };
    const env = await finalizeToolResult("create_task", "create_task", { title: "X" }, raw, ctx);
    // list fetch failed → no verification computed, but envelope still forms
    expect(env.id).toBe("t1");
    expect(env.success).toBe(true);
  });

  it("prefers the handler's own message when present", async () => {
    const ctx = buildTurnVerifyContext(stubStorage());
    const env = await finalizeToolResult("copy_budgets_previous_month", "set_budget", {}, { copied: 3, message: "Copied 3 budgets from 2026-06 to 2026-07" }, ctx);
    expect(env.message).toBe("Copied 3 budgets from 2026-06 to 2026-07");
  });
});

// ── trimExtractedFields (model-facing document field view) ───────────────────
import { trimExtractedFields } from "../server/ai-envelope";

describe("trimExtractedFields", () => {
  it("keeps scalar fields (the license-plate case) and drops nested/blob values", () => {
    const out = trimExtractedFields({
      licenseNumber: "8YPJ480",
      make: "HOND",
      year: 2021,
      valid: true,
      nested: { deep: "object" },
      list: [1, 2, 3],
      blob: "x".repeat(5000),
      empty: "",
      nil: null,
    });
    expect(out).toEqual({ licenseNumber: "8YPJ480", make: "HOND", year: "2021", valid: "true" });
  });

  it("bounds key count and value length", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 50; i++) big[`k${i}`] = "v".repeat(500);
    const out = trimExtractedFields(big)!;
    expect(Object.keys(out)).toHaveLength(30);
    expect(out.k0).toHaveLength(120);
  });

  it("returns undefined for empty/invalid input", () => {
    expect(trimExtractedFields(null)).toBeUndefined();
    expect(trimExtractedFields([])).toBeUndefined();
    expect(trimExtractedFields({})).toBeUndefined();
    expect(trimExtractedFields({ only: { nested: true } })).toBeUndefined();
  });
});

// ── requested_name_matches ──────────────────────────────────────────────────
// The 2026-08-09 report's shape: a write that SUCCEEDS against a record the
// user never named ("Updated the Dodge Ram 2025" on a request to create one).
// Reported, never enforced — legitimate normalization (dedup suffixes,
// canonical tracker names) keeps names from matching exactly.
describe("finalizeToolResult — requested_name_matches", () => {
  it("true when the written record carries the requested name", async () => {
    const storage = stubStorage({ getProfiles: async () => [...PROFILES, { id: "p1", name: "Dodge Ram 2025" }] });
    const env = await finalizeToolResult(
      "create_profile", "create_profile",
      { name: "Dodge Ram 2025" }, { id: "p1", name: "Dodge Ram 2025" },
      buildTurnVerifyContext(storage),
    );
    expect(env.success).toBe(true);
    expect(env.verification.requested_name_matches).toBe(true);
  });

  it("false when the write landed on a different record", async () => {
    const storage = stubStorage({ getProfiles: async () => [...PROFILES, { id: "p2", name: "Honda CR-V" }] });
    const env = await finalizeToolResult(
      "update_profile", "update_profile",
      { name: "Dodge Ram 2025" }, { id: "p2", name: "Honda CR-V" },
      buildTurnVerifyContext(storage),
    );
    expect(env.verification.requested_name_matches).toBe(false);
    // Reported, not enforced — the write itself is still a success.
    expect(env.success).toBe(true);
  });

  it("tolerates a dedup suffix on the written name", async () => {
    const storage = stubStorage({ getHabits: async () => [{ id: "h1", name: "Walk the Dog - Rex" }] });
    const env = await finalizeToolResult(
      "create_habit", "create_habit",
      { name: "Walk the Dog" }, { id: "h1", name: "Walk the Dog - Rex" },
      buildTurnVerifyContext(storage),
    );
    expect(env.verification.requested_name_matches).toBe(true);
  });

  it("omits the check when the input named nothing", async () => {
    const storage = stubStorage({ getExpenses: async () => [{ id: "e1", description: "coffee" }] });
    const env = await finalizeToolResult(
      "create_expense", "log_expense",
      { amount: 5 }, { id: "e1" },
      buildTurnVerifyContext(storage),
    );
    expect(env.verification?.requested_name_matches).toBeUndefined();
  });
});

// ── docContentMatches (document content search) ──────────────────────────────
import { docContentMatches } from "../server/ai-envelope";

describe("docContentMatches", () => {
  const reg = { licenseNumber: "8YPJ480", make: "HOND", model: "CR-V", expirationDate: "2027-03-28" };
  it("matches on field VALUES (a plate) and KEYS (licenseNumber)", () => {
    expect(docContentMatches(reg, "8ypj480")).toBe(true);
    expect(docContentMatches(reg, "licensenumber")).toBe(true);
    expect(docContentMatches(reg, "hond")).toBe(true);
  });
  it("bidirectional token match: 'Honda' finds the doc's abbreviated make 'HOND'", () => {
    expect(docContentMatches(reg, "honda registration expiry")).toBe(true);
    expect(docContentMatches(reg, "honda")).toBe(true);
  });
  it("no match for unrelated queries / empty fields", () => {
    expect(docContentMatches(reg, "netflix subscription")).toBe(false);
    expect(docContentMatches({}, "anything")).toBe(false);
    expect(docContentMatches(null, "anything")).toBe(false);
  });
});
