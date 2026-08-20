// The temporal layer: which canonical records own a Date Rule, which never do,
// and what makes two derivations of the same rule the same rule.
//
// The rules here are DERIVED from the record through shared/calendar-adapters —
// the same code path the Calendar, Upcoming and Recurring & Important Dates
// surfaces read — so a rule that this module reports is, by construction, a
// date those surfaces draw.

import { describe, it, expect } from "vitest";
import {
  dateRuleKey,
  deriveDateRulesForRecord,
  ownsDateRules,
  findActionableTime,
  NON_TEMPORAL_ENTITIES,
} from "@shared/temporal-rules";

const task = (over: Record<string, any> = {}) => ({
  id: "t1", title: "Call Progressive", status: "todo", priority: "medium",
  linkedProfiles: ["p-robert"], tags: [], createdAt: "2026-08-20T00:00:00Z", ...over,
});

describe("a Task with no time information owns no Date Rule", () => {
  it("'Buy dog food' produces nothing for the calendar", () => {
    expect(deriveDateRulesForRecord("u1", "task", task({ title: "Buy dog food", dueDate: undefined }))).toEqual([]);
  });
});

describe("a Task with a due date owns a task_due rule", () => {
  const rules = deriveDateRulesForRecord("u1", "task", task({ dueDate: "2026-08-21", dueTime: "14:00" }));
  it("derives exactly one rule", () => expect(rules).toHaveLength(1));
  it("is a one-off due rule anchored on the due date", () => {
    expect(rules[0].ruleType).toBe("task_due");
    expect(rules[0].recurring).toBe(false);
    expect(rules[0].baseDate).toBe("2026-08-21");
  });
  it("carries the owning profile so scope filtering works", () => {
    expect(rules[0].source.ownerIds).toContain("p-robert");
  });
});

describe("a recurring Task owns a recurring_task rule, not many rows", () => {
  const rules = deriveDateRulesForRecord("u1", "task",
    task({ title: "Buy dog food", dueDate: "2026-08-22", tags: ["recur:weekly"] }));
  it("is one rule", () => expect(rules).toHaveLength(1));
  it("repeats weekly", () => {
    expect(rules[0].ruleType).toBe("recurring_task");
    expect(rules[0].recurring).toBe(true);
    expect(rules[0].recurrence).toBe("weekly");
  });
});

describe("a profile date of birth owns a birthday rule", () => {
  const rules = deriveDateRulesForRecord("u1", "profile", {
    id: "p-robert", name: "Robert", type: "person", fields: { birthday: "1994-07-10" }, tags: [],
  });
  it("derives a yearly birthday rule", () => {
    const b = rules.find(r => r.ruleType === "birthday");
    expect(b).toBeTruthy();
    expect(b!.recurring).toBe(true);
    expect(b!.source.field).toBe("fields.birthday");
  });
});

describe("notes and journal entries never own a Date Rule", () => {
  it("the set is explicit", () => {
    expect(NON_TEMPORAL_ENTITIES.has("note")).toBe(true);
    expect(NON_TEMPORAL_ENTITIES.has("journal")).toBe(true);
    expect(ownsDateRules("task")).toBe(true);
    expect(ownsDateRules("note")).toBe(false);
    expect(ownsDateRules("journal")).toBe(false);
  });
});

describe("idempotency", () => {
  it("user + entity + field + rule type identifies the rule", () => {
    const a = dateRuleKey("u1", "task", "t1", "dueDate", "task_due");
    const b = dateRuleKey("u1", "task", "t1", "dueDate", "task_due");
    expect(a).toBe(b);
    expect(a).not.toBe(dateRuleKey("u2", "task", "t1", "dueDate", "task_due"));
    expect(a).not.toBe(dateRuleKey("u1", "task", "t1", "dueDate", "recurring_task"));
  });

  it("re-deriving the same record yields the same key", () => {
    const rec = task({ dueDate: "2026-08-21" });
    const first = deriveDateRulesForRecord("u1", "task", rec)[0];
    const second = deriveDateRulesForRecord("u1", "task", rec)[0];
    expect(first.key).toBe(second.key);
  });
});

describe("actionable time inside prose", () => {
  it("an appointment date in note text is actionable", () => {
    const hit = findActionableTime("Robert's appointment is September 18 at 2 PM");
    expect(hit.actionable).toBe(true);
  });
  it("a bare historical year is not", () => {
    expect(findActionableTime("Robert moved to California in 2018").actionable).toBe(false);
  });
  it("a dentist follow-up inside a journal entry is", () => {
    expect(findActionableTime("My dentist told me to come back October 12").actionable).toBe(true);
  });
});
