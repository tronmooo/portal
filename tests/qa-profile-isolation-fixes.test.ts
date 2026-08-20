// Regression tests for the QA pass of 2026-08-20 (profile-isolation sweep).
//
// Six defects, one describe block each. Every test asserts the OBSERVED
// symptom, not the implementation, so the fixes cannot quietly regress into
// "the code still looks right but the screen is still wrong".

import { describe, it, expect } from "vitest";
import { resolveLiabilityDueDate, dueDateFromDueDay, deriveScheduleFields } from "../shared/liability-schedule";
import { parseBirthdayLabel } from "../shared/date-rules";
import { detectEntities, parseTurnPlan } from "../shared/ai-intent";
import { checkToolAgainstIntent } from "../shared/ai-tool-routing";
import { childProfileTimelineEntry } from "../shared/schema";
import { validateToolInput } from "../server/ai-engine";

// ── 1. "No due date" on liabilities created with a monthly due day ──────────
describe("liability due date from a bare dueDay", () => {
  it("resolves a monthly dueDay that carries no dated spelling", () => {
    // create_liability stores "due on the 15th" as fields.dueDay and nothing
    // else. Every reader used to stop at the dated spellings and render
    // "No due date" for a liability the user had given an explicit due day.
    expect(resolveLiabilityDueDate({ dueDay: 15 }, "2026-08-20")).toBe("2026-09-15");
    expect(resolveLiabilityDueDate({ dueDay: 25 }, "2026-08-20")).toBe("2026-08-25");
  });

  it("accepts the other spellings the profile writer produces", () => {
    expect(dueDateFromDueDay({ due_day: "10" }, "2026-08-20")).toBe("2026-09-10");
    expect(dueDateFromDueDay({ paymentDueDay: 3 }, "2026-08-20")).toBe("2026-09-03");
    expect(dueDateFromDueDay({ payment_due_day: 3 }, "2026-08-20")).toBe("2026-09-03");
  });

  it("clamps a dueDay past the end of a short month", () => {
    expect(dueDateFromDueDay({ dueDay: 31 }, "2026-02-05")).toBe("2026-02-28");
  });

  it("never lets dueDay shadow a real dated spelling", () => {
    expect(resolveLiabilityDueDate({ nextPaymentDate: "2026-09-02", dueDay: 15 }, "2026-08-20"))
      .toBe("2026-09-02");
  });

  it("returns null when there is genuinely no due information", () => {
    expect(resolveLiabilityDueDate({}, "2026-08-20")).toBeNull();
    expect(dueDateFromDueDay({ dueDay: 0 }, "2026-08-20")).toBeNull();
    expect(dueDateFromDueDay({ dueDay: 32 }, "2026-08-20")).toBeNull();
  });

  it("still drives the schedule from dueDay, anchored to the caller's today", () => {
    const out = deriveScheduleFields({ monthlyPayment: 222, dueDay: 15 }, "auto_loan", "2026-08-20");
    expect(out.dueDate).toBe("2026-09-15");
    expect(out.nextDueDate).toBe("2026-09-15");
  });
});

// ── 2. Birthday saved as an event but never onto the profile ────────────────
describe("parseBirthdayLabel strips title decoration", () => {
  it("reads the name out of the emoji title the tool guidance asks for", () => {
    // The chat prompt tells the model to title the event "🎂 <Name>'s Birthday".
    // With the cake left on the front the captured name was "🎂 Bob", which
    // matched no profile — so the birthday stayed an ordinary event and the
    // person's profile field was never written.
    expect(parseBirthdayLabel("🎂 Bob QA's Birthday")).toEqual({ name: "Bob QA", kind: "birthday" });
    expect(parseBirthdayLabel("🎉 Anniversary")).toEqual({ name: "", kind: "anniversary" });
  });

  it("leaves undecorated titles exactly as they were", () => {
    expect(parseBirthdayLabel("Joe's Birthday")).toEqual({ name: "Joe", kind: "birthday" });
    expect(parseBirthdayLabel("Anniversary")).toEqual({ name: "", kind: "anniversary" });
  });

  it("still refuses anything that is a party rather than a label", () => {
    expect(parseBirthdayLabel("🎂 Birthday party at Chuck E Cheese")).toBeNull();
    expect(parseBirthdayLabel("🎂 Joe's 40th Birthday Bash")).toBeNull();
  });
});

// ── 3. Multi-object requests locked onto one entity type ────────────────────
describe("multi-entity requests are not refused as wrong-entity", () => {
  const MSG = "Add a blue bicycle asset for Bob, a dental loan liability, and a note for Bob";

  it("sees every entity the message names, not just the first", () => {
    const named = detectEntities(MSG);
    expect(named).toContain("asset");
    expect(named).toContain("liability");
    expect(named).toContain("note");
  });

  it("does not call a single-entity read of a multi-entity message exhaustive", () => {
    // `exhaustive` is what arms the routing gate. A one-intent read of a
    // three-object request is precisely the "clause we could not classify"
    // case the flag exists to report.
    expect(parseTurnPlan(MSG).exhaustive).toBe(false);
  });

  it("lets the liability and the note tools through", () => {
    const plan = parseTurnPlan(MSG);
    expect(checkToolAgainstIntent("create_liability", plan)).toBeNull();
    expect(checkToolAgainstIntent("create_note", plan)).toBeNull();
    expect(checkToolAgainstIntent("create_profile", plan)).toBeNull();
  });

  it("keeps gating a single-entity request", () => {
    const plan = parseTurnPlan("Add a task to call the dentist");
    const violation = checkToolAgainstIntent("create_liability", plan);
    expect(violation?.mismatchType).toBe("entity_mismatch");
  });

  it("does not treat a bare dollar amount as a second named entity", () => {
    // The `expense` rule matches "$40" on its own — far too weak a signal to
    // conclude a second object was requested, which would disarm the gate for
    // every message carrying a price.
    expect(detectEntities("Add a blue bicycle asset worth $1,111 for Bob")).toEqual(["asset"]);
    expect(parseTurnPlan("Add a blue bicycle asset worth $1,111 for Bob").exhaustive).toBe(true);
  });
});

// ── 5. A person's Activity tab showed nothing ───────────────────────────────
describe("child profiles are activity", () => {
  it("renders a liability child as a timeline row with its balance", () => {
    const row = childProfileTimelineEntry({
      id: "1a1cd17e", name: "Dental Loan", type: "liability",
      fields: { currentBalance: 222 }, createdAt: "2026-08-20T10:00:00Z",
    });
    expect(row).toMatchObject({
      id: "1a1cd17e", type: "profile", title: "Dental Loan",
      description: "Liability — $222", timestamp: "2026-08-20T10:00:00Z",
    });
  });

  it("renders an asset child with its value", () => {
    const row = childProfileTimelineEntry({
      id: "fe20d8e4", name: "Blue Bicycle", type: "asset",
      fields: { currentValue: 1111 }, createdAt: "2026-08-20T10:05:00Z",
    });
    expect(row.description).toBe("Asset — $1,111");
  });

  it("falls back to a plain label when the record carries no figure", () => {
    const row = childProfileTimelineEntry({
      id: "x", name: "Red Tablet", type: "asset", fields: {}, createdAt: "2026-08-20T10:05:00Z",
    });
    expect(row.description).toBe("Asset added");
  });
});

// ── 4. A task asked for the due date its own request already carried ────────
describe("create_task parses a due date instead of discarding it", () => {
  it("keeps a date the model expressed in words", () => {
    // Anything not already ISO used to be cleared outright, so the task was
    // created with no due date and the reply then asked for the one the
    // request already contained.
    const v = validateToolInput("create_task", {
      title: "Renew Jane's registration", dueDate: "August 25, 2026",
    });
    expect(v.normalized.dueDate).toBe("2026-08-25");
    expect(v.warnings).toEqual([]);
  });

  it("normalizes the slashed spellings too", () => {
    expect(validateToolInput("create_task", { title: "x", dueDate: "2026/08/25" }).normalized.dueDate)
      .toBe("2026-08-25");
  });

  it("leaves an ISO date untouched", () => {
    const v = validateToolInput("create_task", { title: "x", dueDate: "2026-08-25" });
    expect(v.normalized.dueDate).toBe("2026-08-25");
  });

  it("still clears — and warns about — a value no parser can read", () => {
    const v = validateToolInput("create_task", { title: "x", dueDate: "whenever" });
    expect(v.normalized.dueDate).toBeUndefined();
    expect(v.warnings.join(" ")).toMatch(/not valid/);
  });
});
