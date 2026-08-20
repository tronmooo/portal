// END-TO-END unified intent routing: the real executeTool dispatcher and the
// real routing gate, driven against an in-memory store.
//
// The report that started this (2026-08-20): typing
//
//   "jane doe note:  I have the look that one gives somebody"
//
// answered "Journal entry saved for Jane Doe." The user said NOTE.
//
// Three things are pinned here, in the order the pipeline runs them:
//   1. the gate refuses a journal tool on an explicit note request;
//   2. create_note writes a real, profile-linked Note;
//   3. the temporal layer creates a Date Rule for a dated task and creates
//      NOTHING for a note or a journal entry, however dated their text is.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkContentRouting, routeContent } from "@shared/content-routing";

const SELF = { id: "p-self", name: "Robert Sennabaum", type: "self", fields: {}, tags: [] };
const JANE = { id: "p-jane", name: "Jane Doe", type: "person", fields: {}, tags: [] };

type Row = Record<string, any>;
const db: { artifacts: Row[]; journal: Row[]; tasks: Row[]; links: string[] } = {
  artifacts: [], journal: [], tasks: [], links: [],
};

function reseed() {
  db.artifacts = [];
  db.journal = [];
  db.tasks = [];
  db.links = [];
}

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;
const nowISO = () => new Date().toISOString();

vi.mock("../server/storage", () => ({
  storage: {
    _timezone: "America/Los_Angeles",
    getProfiles: async () => [SELF, JANE],
    getProfile: async (id: string) => [SELF, JANE].find(p => p.id === id),
    getHabits: async () => [], getGoals: async () => [], getEvents: async () => [],
    getTrackers: async () => [], getExpenses: async () => [], getObligations: async () => [],
    getMemories: async () => [], getDocuments: async () => [],

    getArtifacts: async () => db.artifacts,
    getArtifact: async (id: string) => db.artifacts.find(a => a.id === id),
    createArtifact: async (data: Row) => {
      const row = { id: nextId("a"), ...data, createdAt: nowISO(), updatedAt: nowISO() };
      db.artifacts.push(row);
      return row;
    },
    updateArtifact: async (id: string, patch: Row) => {
      const row = db.artifacts.find(a => a.id === id);
      if (!row) return undefined;
      Object.assign(row, patch, { updatedAt: nowISO() });
      return row;
    },
    deleteArtifact: async (id: string) => {
      const i = db.artifacts.findIndex(a => a.id === id);
      if (i === -1) return false;
      db.artifacts.splice(i, 1);
      return true;
    },

    getJournalEntries: async () => db.journal,
    createJournalEntry: async (data: Row) => {
      const row = { id: nextId("j"), linkedProfiles: [], ...data, createdAt: nowISO() };
      db.journal.push(row);
      return row;
    },
    updateJournalEntry: async (id: string, patch: Row) => {
      const row = db.journal.find(j => j.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },

    getTasks: async () => db.tasks,
    getTask: async (id: string) => db.tasks.find(t => t.id === id),
    createTask: async (data: Row) => {
      const row = { id: nextId("t"), status: "todo", linkedProfiles: [], tags: [], ...data, createdAt: nowISO() };
      db.tasks.push(row);
      return row;
    },
    updateTask: async (id: string, patch: Row) => {
      const row = db.tasks.find(t => t.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return row;
    },

    linkProfileTo: async (profileId: string, kind: string, id: string) => {
      db.links.push(`${profileId}:${kind}:${id}`);
      return true;
    },
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create: async () => ({ content: [] }) }; } }));

let executeTool: (name: string, input: any, userId?: string) => Promise<any>;
beforeEach(async () => {
  reseed();
  ({ executeTool } = await import("../server/ai-engine"));
});

const notes = () => db.artifacts.filter(a => a.type === "note");

// ─────────────────────────────────────────────────────────────────────────────

describe("1. the reported bug: an explicit note never becomes a journal entry", () => {
  const MSG = "jane doe note:  I have the look that one gives somebody";

  it("the gate refuses journal_entry for this message", () => {
    const v = checkContentRouting("journal_entry", MSG);
    expect(v).not.toBeNull();
    expect(v!.requestedKind).toBe("note");
    expect(v!.modelDirective).toMatch(/create_note/);
  });

  it("the gate allows create_note for this message", () => {
    expect(checkContentRouting("create_note", MSG)).toBeNull();
  });

  it("create_note writes a Note linked to Jane Doe, and no journal entry exists", async () => {
    const res = await executeTool("create_note", {
      content: "I have the look that one gives somebody", forProfile: "Jane Doe",
    }, "u1");

    expect(res?.error).toBeUndefined();
    expect(notes()).toHaveLength(1);
    expect(notes()[0].content).toBe("I have the look that one gives somebody");
    expect(notes()[0].linkedProfiles).toEqual([JANE.id]);
    expect(db.links).toContain(`${JANE.id}:artifact:${notes()[0].id}`);
    expect(db.journal).toHaveLength(0);
  });
});

describe("2. explicit intent survives content that looks like something else", () => {
  it("'create a note that I need to call Progressive tomorrow' → note, task tool refused", () => {
    const msg = "Create a note that I need to call Progressive tomorrow.";
    expect(checkContentRouting("create_note", msg)).toBeNull();
    expect(checkContentRouting("create_task", msg)).not.toBeNull();
  });

  it("an explicit journal request refuses create_note", () => {
    expect(checkContentRouting("create_note", "Journal this for Robert — today was good.")).not.toBeNull();
  });
});

describe("3. one message, several objects — the gate stays out of the way", () => {
  const MSG = "Journal this: I had a stressful day. Remind me to call my landlord tomorrow.";

  it("both objects are named, so neither tool is refused", () => {
    expect(routeContent(MSG).actions.map(a => a.kind)).toEqual(["journal", "task"]);
    expect(checkContentRouting("journal_entry", MSG)).toBeNull();
    expect(checkContentRouting("create_task", MSG)).toBeNull();
  });

  it("both writes land", async () => {
    await executeTool("journal_entry", { content: "I had a stressful day.", mood: "bad" }, "u1");
    await executeTool("create_task", { title: "Call my landlord", dueDate: "2026-08-21" }, "u1");
    expect(db.journal).toHaveLength(1);
    expect(db.tasks).toHaveLength(1);
    expect(db.tasks[0].dueDate).toBe("2026-08-21");
  });
});

describe("3b. habit vs task, and structured data, through the gate", () => {
  it("an explicit habit request refuses create_task", () => {
    const v = checkContentRouting("create_task", "Make drinking water a daily habit");
    expect(v).not.toBeNull();
    expect(v!.requestedKind).toBe("habit");
    expect(v!.modelDirective).toMatch(/create_habit/);
  });

  it("an explicit task request refuses create_habit", () => {
    const v = checkContentRouting("create_habit", "Add a task to meditate every morning");
    expect(v).not.toBeNull();
    expect(v!.requestedKind).toBe("task");
  });

  it("a recurring CHORE is left to create_task", () => {
    expect(checkContentRouting("create_task", "Take out the trash every Tuesday")).toBeNull();
  });

  it("structured writes are never gated — that is how the router's verdict gets acted on", () => {
    const msg = "Robert's email is robert@example.com";
    expect(routeContent(msg).actions[0].kind).toBe("profile_field");
    // update_profile is not in CONTENT_TOOL_KIND, so the gate is silent.
    expect(checkContentRouting("update_profile", msg)).toBeNull();
    // …and a note tool on the same message is likewise not refused: the read
    // was INFERRED, not explicit, so it informs the model without blocking it.
    expect(checkContentRouting("create_note", msg)).toBeNull();
  });
});

describe("4. profile isolation", () => {
  it("Jane's note does not surface in Robert's notes", async () => {
    await executeTool("create_note", { content: "Gate code is 4821", forProfile: "Jane Doe" }, "u1");
    const mine = await executeTool("search_notes", { forProfile: "Robert Sennabaum" }, "u1");
    expect(mine).toHaveLength(0);
    const hers = await executeTool("search_notes", { forProfile: "Jane Doe" }, "u1");
    expect(hers).toHaveLength(1);
  });
});

describe("5. idempotency — a retried turn does not duplicate", () => {
  it("the same note twice yields one row", async () => {
    const a = await executeTool("create_note", { content: "Sarah prefers morning appointments", forProfile: "Jane Doe" }, "u1");
    const b = await executeTool("create_note", { content: "Sarah prefers morning appointments.", forProfile: "Jane Doe" }, "u1");
    expect(notes()).toHaveLength(1);
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
  });

  it("the same journal text twice appends once", async () => {
    await executeTool("journal_entry", { content: "Played soccer at night.", entryDate: "2026-08-19" }, "u1");
    await executeTool("journal_entry", { content: "Played soccer at night.", entryDate: "2026-08-19" }, "u1");
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0].content.match(/Played soccer/g)).toHaveLength(1);
  });
});

describe("6. journal entry dates are not calendar dates", () => {
  it("'journal for yesterday' files under yesterday and creates no Date Rule", async () => {
    const res = await executeTool("journal_entry", {
      content: "I worked all day and played soccer at night.", entryDate: "2026-08-19",
    }, "u1");
    expect(res.entryDate).toBe("2026-08-19");
    expect(db.journal[0].date).toBe("2026-08-19");
    expect(res.dateRules).toEqual([]);
    const sync = await executeTool("sync_date_rules_for_entity", { system: "journal", id: db.journal[0].id }, "u1");
    expect(sync.rules).toEqual([]);
    expect(sync.reason).toMatch(/never own a Date Rule/);
  });

  it("appending to an existing day merges instead of failing the unique-day constraint", async () => {
    await executeTool("journal_entry", { content: "Morning was slow.", entryDate: "2026-08-20" }, "u1");
    const res = await executeTool("append_journal_entry", { content: "Evening picked up.", entryDate: "2026-08-20" }, "u1");
    expect(db.journal).toHaveLength(1);
    expect(res.appended).toBe(true);
    expect(db.journal[0].content).toMatch(/Morning was slow/);
    expect(db.journal[0].content).toMatch(/Evening picked up/);
  });
});

describe("7. notes with dates", () => {
  it("a note about an appointment is still a note, and reports the actionable date", async () => {
    const res = await executeTool("create_note", {
      content: "Robert's appointment is September 18 at 2 PM", forProfile: "Robert Sennabaum",
    }, "u1");
    expect(notes()).toHaveLength(1);
    expect(res.dateRules).toEqual([]);
    expect(res.actionableTime?.dateText).toMatch(/September 18/i);
    expect(res.suggestion).toMatch(/do NOT replace the note/i);
  });

  it("a historical year in a note is informational — no suggestion", async () => {
    const res = await executeTool("create_note", { content: "Robert moved to California in 2018" }, "u1");
    expect(res.actionableTime).toBeUndefined();
    expect(res.dateRules).toEqual([]);
  });
});

describe("8. tasks synchronise with the calendar", () => {
  it("a task with no date owns no Date Rule", async () => {
    const t = await executeTool("create_task", { title: "Buy dog food" }, "u1");
    const sync = await executeTool("sync_date_rules_for_entity", { system: "task", id: t.id }, "u1");
    expect(sync.rules).toEqual([]);
    expect(sync.reason).toMatch(/no actionable date/);
  });

  it("a dated task owns exactly one task_due rule", async () => {
    const t = await executeTool("create_task", {
      title: "Call Progressive", dueDate: "2026-08-21", dueTime: "14:00", forProfile: "Jane Doe",
    }, "u1");
    expect(t.dueTime).toBe("14:00");
    const sync = await executeTool("sync_date_rules_for_entity", { system: "task", id: t.id }, "u1");
    expect(sync.rules).toHaveLength(1);
    expect(sync.rules[0].ruleType).toBe("task_due");
    expect(sync.rules[0].baseDate).toBe("2026-08-21");
    expect(sync.rules[0].source.ownerIds).toContain(JANE.id);
  });

  it("a recurring task owns ONE recurring rule, not many rows", async () => {
    // A distinct title on purpose: the engine's 30-second in-memory create
    // lock is module-scoped and would suppress a second "Buy dog food".
    const t = await executeTool("create_task", {
      title: "Take out the trash", dueDate: "2026-08-22", recurrence: "weekly",
    }, "u1");
    expect(t.tags).toContain("recur:weekly");
    expect(db.tasks).toHaveLength(1);
    const sync = await executeTool("sync_date_rules_for_entity", { system: "task", id: t.id }, "u1");
    expect(sync.rules).toHaveLength(1);
    expect(sync.rules[0].ruleType).toBe("recurring_task");
    expect(sync.rules[0].recurring).toBe(true);
  });

  it("re-deriving the same task yields the same rule identity", async () => {
    const t = await executeTool("create_task", { title: "Renew registration", dueDate: "2026-10-09" }, "u1");
    const a = await executeTool("sync_date_rules_for_entity", { system: "task", id: t.id }, "u1");
    const b = await executeTool("sync_date_rules_for_entity", { system: "task", id: t.id }, "u1");
    expect(a.rules[0].key).toBe(b.rules[0].key);
  });

  it("clearing the due date removes the rule", async () => {
    const t = await executeTool("create_task", { title: "Call the vet", dueDate: "2026-09-01" }, "u1");
    expect((await executeTool("sync_date_rules_for_entity", { system: "task", id: t.id }, "u1")).rules).toHaveLength(1);
    db.tasks[0].dueDate = undefined;
    expect((await executeTool("sync_date_rules_for_entity", { system: "task", id: t.id }, "u1")).rules).toHaveLength(0);
  });
});

describe("9. note edit and delete", () => {
  it("update_note edits the matched note in place", async () => {
    await executeTool("create_note", { content: "The gate code is 4821", title: "Gate code" }, "u1");
    const res = await executeTool("update_note", { title: "Gate code", content: "The gate code is 9137" }, "u1");
    expect(res.content).toBe("The gate code is 9137");
    expect(notes()).toHaveLength(1);
  });

  it("delete_note removes it and touches no Date Rule", async () => {
    await executeTool("create_note", { content: "Dog food is in the garage", title: "Dog food" }, "u1");
    const res = await executeTool("delete_note", { title: "Dog food" }, "u1");
    expect(res.success).toBe(true);
    expect(notes()).toHaveLength(0);
    expect(res.dateRuleImpact).toMatch(/none/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. THE AUDIT: can any AI write path create a dated object that never reaches
//     the temporal layer?
//
// In this app a Date Rule is DERIVED, not stored (see shared/temporal-rules), so
// "reaching the temporal layer" means: the tool writes to a canonical system
// that shared/calendar-adapters reads. A tool that puts a date on a record no
// adapter looks at is a date that will never appear on the Calendar, Upcoming,
// or Recurring & Important Dates — and it is invisible until someone notices
// the gap by hand.
//
// This test enumerates every WRITE tool whose schema accepts a date and asserts
// each one lands in a covered system, or is listed below with a stated reason.
// A new dated tool fails this test until it is classified.

describe("10. temporal coverage audit — no dated write escapes the calendar", () => {
  const DATE_PARAM = /(date|due|expir|renew|when|schedule|recurrence|anniversar|birthday|at)$/i;

  /** Systems shared/calendar-adapters turns into CalendarSeries. */
  const COVERED_SYSTEMS = new Set(["task", "event", "profile", "document", "obligation", "liability", "habit"]);

  /**
   * Tools whose date is deliberately NOT a calendar date. Each entry is a
   * decision, not an oversight.
   */
  const EXEMPT: Record<string, string> = {
    journal_entry: "entry date records when the experience happened — not a commitment",
    append_journal_entry: "same as journal_entry",
    update_journal: "same as journal_entry",
    delete_journal: "same as journal_entry",
    create_note: "notes never own a Date Rule",
    update_note: "notes never own a Date Rule",
    delete_note: "notes never own a Date Rule",
    create_expense: "an expense is a past transaction, not a future date",
    update_expense: "past transaction",
    delete_expense: "past transaction",
    refund_expense: "past transaction",
    convert_expense_to_asset: "past transaction",
    log_tracker_entry: "a tracker entry is an observation at a timestamp",
    update_tracker_entry: "tracker observation",
    delete_tracker_entry: "tracker observation",
    log_medication_dose: "adherence record for a past dose",
    skip_medication_dose: "adherence record for a past dose",
    checkin_habit: "a check-in marks one occurrence of an existing habit schedule",
    uncomplete_habit: "same as checkin_habit",
    log_income: "income is recorded against a pay date already past",
    update_income: "recorded income",
    delete_income: "recorded income",
    add_liability_payment: "records a payment that happened",
    update_liability_payment: "records a payment that happened",
    delete_liability_payment: "records a payment that happened",
    mark_loan_payment: "records a payment that happened",
    add_liability_charge: "one billing period's amount on an existing schedule",
    set_liability_amount: "one billing period's amount on an existing schedule",
    pay_obligation: "marks one occurrence of an existing obligation schedule",
    undo_last_payment: "reverses a recorded payment",
    create_budget: "a budget is a monthly envelope, not a dated event",
    update_budget: "monthly envelope",
    set_budget: "monthly envelope",
    delete_budget: "monthly envelope",
    copy_budgets_previous_month: "monthly envelope",
    create_artifact: "artifacts are content, not schedule",
    update_artifact: "artifacts are content, not schedule",
    save_memory: "an abstract preference carries no schedule",
    update_memory: "abstract preference",
    log_expected_paycheck: "forecast income row, surfaced by the finance projections",
    confirm_paycheck_received: "recorded income",
    delete_paycheck: "recorded income",
    create_domain: "user-defined data table, not a schedule",
    update_domain: "user-defined data table, not a schedule",
    add_entry: "user-defined data table row",
    preview_bulk_action: "before_date SELECTS existing rows; the tool writes no date",
    execute_bulk_action: "same as preview_bulk_action",
  };

  /**
   * KNOWN PARALLEL PATHS, reported rather than silently tolerated.
   *
   * Habits USED to live here: seriesFromAll did not adapt them, so a daily
   * habit was invisible to the Calendar. `seriesFromHabits` closed that, and
   * "habit" is now a covered system above — this set is what remains.
   */
  const KNOWN_PARALLEL = new Set(["schedule_medication_refills"]);

  it("every dated write tool lands in an adapter-covered system", async () => {
    const { TOOL_DEFINITIONS, READ_ONLY_TOOLS } = await import("../server/ai-engine");
    const { TOOL_INTENT_ENTITY } = await import("@shared/ai-tool-routing");

    const ENTITY_SYSTEM: Record<string, string> = {
      task: "task", event: "event", asset: "profile", profile: "profile",
      liability: "liability", obligation: "obligation", document: "document",
      goal: "goal", habit: "habit", tracker: "tracker", expense: "expense",
      income: "income", journal: "journal", note: "note", memory: "memory",
      artifact: "artifact",
    };

    const uncovered: Array<{ tool: string; system: string; params: string[] }> = [];
    for (const tool of TOOL_DEFINITIONS as any[]) {
      if (READ_ONLY_TOOLS.has(tool.name)) continue;
      if (EXEMPT[tool.name] || KNOWN_PARALLEL.has(tool.name)) continue;
      const props = Object.keys(tool.input_schema?.properties || {});
      const dated = props.filter(p => DATE_PARAM.test(p));
      if (dated.length === 0) continue;
      const system = ENTITY_SYSTEM[TOOL_INTENT_ENTITY[tool.name]] ?? "(unmapped)";
      if (!COVERED_SYSTEMS.has(system)) uncovered.push({ tool: tool.name, system, params: dated });
    }

    expect(
      uncovered,
      "these tools accept a date but write to a system the temporal layer does not read — " +
      "classify each one (covered, EXEMPT with a reason, or KNOWN_PARALLEL):\n" +
      JSON.stringify(uncovered, null, 2),
    ).toEqual([]);
  });

  it("the three content tools resolve to the right temporal answer", async () => {
    const { ownsDateRules } = await import("@shared/temporal-rules");
    expect(ownsDateRules("task")).toBe(true);
    expect(ownsDateRules("note")).toBe(false);
    expect(ownsDateRules("journal")).toBe(false);
  });
});
