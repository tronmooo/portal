// Directional entity authorization — the regression corpus for the routing
// mistakes that blanket compatibility sets could not catch.
//
// The gate used to ask "are these two entities similar?" over symmetric sets:
//
//     ["expense", "income"]                  ← opposite cash directions
//     ["obligation", "liability", "expense"] ← a service bill is not a debt
//     ["tracker", "journal"]                 ← a narrative is not a log entry
//     ["goal", "habit", "tracker"]           ← a goal is not a habit
//     ["task", "event"]                      ← a timed task is not an event
//
// Membership being symmetric meant every one of those pairs was mutually
// substitutable, so log_income could serve "log a $20 expense" and
// log_tracker_entry could serve "journal this". Each case below states a
// direction and pins which way it runs.

import { describe, it, expect } from "vitest";
import { parseTurnPlan, detectEntity } from "@shared/ai-intent";
import { checkToolAgainstIntent } from "@shared/ai-tool-routing";
import {
  isWriteAuthorized,
  explainAuthorization,
  ENTITY_ALLOWANCES,
  DOCUMENTED_REFUSALS,
} from "@shared/ai-policy";

/** Did the gate let this tool serve this message? */
const allows = (msg: string, tool: string) =>
  checkToolAgainstIntent(tool, parseTurnPlan(msg)) === null;

// ── Cash direction ──────────────────────────────────────────────────────────

describe("money direction is non-negotiable", () => {
  it("refuses an income tool on an expense request, and the reverse", () => {
    expect(allows("Log a $20 expense for lunch", "create_expense")).toBe(true);
    expect(allows("Log a $20 expense for lunch", "log_income")).toBe(false);

    expect(allows("Log $500 of income from my paycheck", "log_income")).toBe(true);
    expect(allows("Log $500 of income from my paycheck", "create_expense")).toBe(false);
  });

  // A dollar amount says money moved. It does not say WHICH WAY, so it must
  // not outrank the word the user actually used — under position-only
  // ordering "Log $500 of income" parsed as an expense because the "$" came
  // first, and the symmetric set absorbed the error.
  it("does not let a bare dollar amount outrank a stated direction", () => {
    expect(detectEntity("Log $500 of income from my paycheck").entity).toBe("income");
    expect(detectEntity("$400 paycheck deposited").entity).toBe("income");
    expect(detectEntity("Log a $20 expense for lunch").entity).toBe("expense");
  });

  it("still reads a bare amount as spending when nothing states a direction", () => {
    expect(detectEntity("log $20 for lunch").entity).toBe("expense");
  });
});

// ── Bill vs debt vs expense ─────────────────────────────────────────────────

describe("a bill is not a bare expense", () => {
  it("refuses a plain expense tool once the user said 'bill'", () => {
    expect(allows("Add a bill for Netflix at $16 a month", "create_obligation")).toBe(true);
    expect(allows("Add a bill for Netflix at $16 a month", "create_expense")).toBe(false);
  });

  // The one-way half: spending language CAN describe settling something owed,
  // so a payment-shaped message may be served by the obligation tool. The
  // reverse direction stays refused — a bill row carries a schedule and a due
  // date that a bare expense row would lose.
  it("lets payment-shaped spending reach the obligation tool", () => {
    expect(isWriteAuthorized("expense", "obligation", "log a $120 payment for the electric bill")).toBe(true);
    expect(isWriteAuthorized("obligation", "expense", "log a $120 payment for the electric bill")).toBe(false);
  });

  it("keeps unrelated spending away from the obligation tool", () => {
    expect(isWriteAuthorized("expense", "obligation", "log $20 for lunch")).toBe(false);
    expect(isWriteAuthorized("expense", "liability", "log $20 for lunch")).toBe(false);
  });

  it("treats bills and debts as one family, both ways", () => {
    expect(isWriteAuthorized("obligation", "liability")).toBe(true);
    expect(isWriteAuthorized("liability", "obligation")).toBe(true);
  });
});

// ── Narrative vs measurement ────────────────────────────────────────────────

describe("a journal narrative is not a tracker entry", () => {
  it("refuses a tracker log on an explicit journal request", () => {
    const msg = "Journal this: I felt great after running";
    expect(allows(msg, "journal_entry")).toBe(true);
    expect(allows(msg, "log_tracker_entry")).toBe(false);
  });

  it("refuses journal prose on an explicit tracker request", () => {
    expect(isWriteAuthorized("tracker", "journal")).toBe(false);
  });

  // The 2026-08-20 report: a message that said NOTE answered "Journal entry
  // saved". Note and journal stay separate in both directions.
  it("keeps note and journal apart", () => {
    expect(allows("Add a note that Jane prefers email", "create_note")).toBe(true);
    expect(allows("Add a note that Jane prefers email", "journal_entry")).toBe(false);
    expect(isWriteAuthorized("journal", "note")).toBe(false);
  });
});

// ── Goal vs habit vs tracker ────────────────────────────────────────────────

describe("a goal, a habit and a tracker are three requests", () => {
  it("does not let a goal authorize a habit", () => {
    const msg = "Create a goal to read 12 books this year";
    expect(allows(msg, "create_goal")).toBe(true);
    expect(allows(msg, "create_habit")).toBe(false);
  });

  it("does not let a tracker request create a habit or a goal", () => {
    const msg = "Create a tracker for my water intake";
    expect(allows(msg, "create_tracker")).toBe(true);
    expect(allows(msg, "create_habit")).toBe(false);
    expect(allows(msg, "create_goal")).toBe(false);
  });

  it("does not let a habit request create a goal", () => {
    expect(allows("Make meditation a habit", "create_habit")).toBe(true);
    expect(allows("Make meditation a habit", "create_goal")).toBe(false);
  });

  // Measurement runs downhill only: a goal is measured by a tracker and a
  // measurable habit links to one, so creating the tracker serves the request.
  it("still allows the measurement a goal or habit needs", () => {
    expect(allows("Create a goal to read 12 books this year", "create_tracker")).toBe(true);
    expect(allows("Make meditation a habit", "create_tracker")).toBe(true);
    expect(isWriteAuthorized("tracker", "goal")).toBe(false);
    expect(isWriteAuthorized("tracker", "habit")).toBe(false);
  });
});

// ── Task vs event ───────────────────────────────────────────────────────────

describe("a timed task is not an event", () => {
  it("refuses a task tool on an explicit event request", () => {
    const msg = "Create me a reoccurring event soccer at 7 AM on Tuesdays";
    expect(allows(msg, "create_event")).toBe(true);
    expect(allows(msg, "create_task")).toBe(false);
  });

  // When the user reaches for both words the gate has no business picking a
  // winner — that is a routing judgement for the prompt, not a block.
  it("stands down when the message names both", () => {
    const msg = "Add my dentist appointment to my tasks";
    expect(allows(msg, "create_task")).toBe(true);
    expect(allows(msg, "create_event")).toBe(true);
  });
});

// ── Unchanged ground ────────────────────────────────────────────────────────

describe("same-storage entities stay interchangeable", () => {
  it("keeps asset and profile as one entity", () => {
    expect(isWriteAuthorized("asset", "profile")).toBe(true);
    expect(isWriteAuthorized("profile", "asset")).toBe(true);
    expect(allows("Create an asset for my Dodge Ram 2025", "create_profile")).toBe(true);
  });

  it("still refuses a habit tool on an asset request", () => {
    expect(allows("Create an asset for my Dodge Ram 2025", "create_habit")).toBe(false);
  });

  it("never gates an unclassified intent", () => {
    expect(isWriteAuthorized("unknown", "expense")).toBe(true);
    expect(isWriteAuthorized("expense", "unknown")).toBe(true);
  });
});

// ── The table itself ────────────────────────────────────────────────────────

describe("the allowance table", () => {
  it("gives every allowance a written reason", () => {
    for (const rule of ENTITY_ALLOWANCES) {
      expect(rule.reason, `${rule.asked}→${rule.wrote}`).toBeTruthy();
    }
  });

  it("reports the reason that authorized a direction", () => {
    expect(explainAuthorization("goal", "tracker")?.reason).toMatch(/measured by a tracker/);
    expect(explainAuthorization("habit", "goal")).toBeNull();
  });

  // Every refusal documented as deliberate must still refuse. A conditional
  // allowance can re-open one of these for a specific message shape; none of
  // them may be open with no message at all.
  it("keeps every documented refusal refused", () => {
    for (const { asked, wrote, reason } of DOCUMENTED_REFUSALS) {
      expect(reason, `${asked}→${wrote}`).toBeTruthy();
      expect(isWriteAuthorized(asked, wrote), `${asked}→${wrote} must stay refused`).toBe(false);
    }
  });
});
