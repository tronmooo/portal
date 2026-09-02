// A message that mixes activity REPORTS with one named command must not be
// read as exhaustively that command (2026-09-01 report: "I ran 2 miles …
// Sarah ate … and create a task to buy more chicken" → the task was created
// and all seven tracker logs were refused as "not what you asked for").
import { describe, it, expect } from "vitest";
import { parseTurnPlan } from "@shared/ai-intent";
import { checkToolAgainstIntent } from "@shared/ai-tool-routing";

const REPORTED =
  "I ran 2 miles this morning in about 19 minutes and drank 24 oz of water afterward. Sarah and I played soccer for 30 minutes this afternoon, pretty high intensity. Sarah ate some grilled chicken, rice, and broccoli afterward and drank a bottle of water. I also did 25 push-ups when we got home and create a task one time only to buy more chicken this week.";

describe("parseTurnPlan with activity reports alongside a named command", () => {
  it("still parses the task, but no longer claims to have parsed the whole message", () => {
    const plan = parseTurnPlan(REPORTED);
    expect(plan.intents.some((i) => i.entity === "task" && i.operation === "create")).toBe(true);
    expect(plan.exhaustive).toBe(false);
  });

  it("lets the tracker logs AND the task through the routing gate", () => {
    const plan = parseTurnPlan(REPORTED);
    expect(checkToolAgainstIntent("log_tracker_entry", plan)).toBeNull();
    expect(checkToolAgainstIntent("checkin_habit", plan)).toBeNull();
    expect(checkToolAgainstIntent("create_task", plan)).toBeNull();
  });

  it("a pure command message stays exhaustive, so a wrong-entity tool is still refused", () => {
    const plan = parseTurnPlan("Create a task to buy more chicken this week.");
    expect(plan.exhaustive).toBe(true);
    expect(checkToolAgainstIntent("log_tracker_entry", plan)?.mismatchType).toBe("entity_mismatch");
  });

  it("two commands with no reports stay exhaustive", () => {
    const plan = parseTurnPlan("Add a task to call the dentist. Create an event for Friday at 3pm called Standup.");
    expect(plan.exhaustive).toBe(true);
    expect(checkToolAgainstIntent("create_expense", plan)?.mismatchType).toBe("entity_mismatch");
  });
});
