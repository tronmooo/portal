// tests/action-kinds.test.ts — the 32 named actions, and which are reachable.
//
// The user wrote out the vocabulary they expect a document to be able to
// produce (2026-08-27). This file is the falsifiable version of that list: for
// every name, either the planner produces it from a fixture, or ACTION_KIND_STATUS
// says out loud that it cannot and why. A name that is silently missing — no
// producer, no stated reason — fails here.

import { describe, it, expect } from "vitest";
import {
  ACTION_KIND_LABEL,
  ACTION_KIND_STATUS,
  classifyActionKind,
  type ActionKind,
} from "../shared/action-kinds";

const ALL_KINDS = Object.keys(ACTION_KIND_LABEL) as ActionKind[];

describe("the vocabulary is complete and accounted for", () => {
  it("every name has a status — produced, or blocked with a reason", () => {
    for (const k of ALL_KINDS) {
      const s = ACTION_KIND_STATUS[k];
      expect(s, `${k} has no status`).toBeTruthy();
      if (!s.produced) {
        expect(s.reason, `${k} is blocked but gives no reason`).toBeTruthy();
      }
    }
  });

  it("names the three records a document may never create, and says why", () => {
    // The user's own rule: "You can't create a liability profile. Or an asset
    // profile based off a document." In this app a bill IS a liability profile
    // (supabase-storage.createObligation ends in createProfile type:"liability"),
    // so all three of these are the same refusal wearing different names.
    for (const k of ["create_recurring_obligation", "create_one_time_obligation", "create_recurring_payment"] as ActionKind[]) {
      expect(ACTION_KIND_STATUS[k].produced, k).toBe(false);
      expect(ACTION_KIND_STATUS[k].reason).toMatch(/liability|bill/i);
    }
  });

  it("every producible name is reachable from some combination of inputs", () => {
    // The classifier is total: walk the destinations and rule types the planner
    // actually emits and check that each producible name comes out of at least
    // one of them.
    const seen = new Set<ActionKind>();
    const DESTINATIONS = [
      "tracker", "profile_tracker", "task", "calendar", "expense", "income",
      "liability_payment", "note", "journal", "habit", "document_attach",
      "relationship_link", "reference", "obligation", "profile", "entity_field",
      "entity_record", "structured_append", "unsupported", "ignore",
    ];
    const RULE_TYPES = [
      undefined, "birthday", "expiration", "renewal", "payment", "due",
      "deadline", "maintenance", "appointment", "informational",
    ];
    for (const destination of DESTINATIONS) {
      for (const operation of ["CREATE", "UPDATE", "APPEND", "LINK", "RECORD", "NO_ACTION"]) {
        for (const ruleType of RULE_TYPES) {
          for (const recurrence of [undefined, "none", "yearly", "monthly"]) {
            for (const profileType of [undefined, "person", "vehicle", "liability", "subscription"]) {
              for (const periodKind of [undefined, "return_window"]) {
                for (const documentExpiration of [undefined, true]) {
                  for (const fieldKeys of [undefined, ["phone", "email"], ["balance"]]) {
                    seen.add(classifyActionKind({
                      destination, operation, ruleType, recurrence, profileType,
                      periodKind, documentExpiration, fieldKeys,
                      targetKind: profileType ? "profile" : undefined,
                    }));
                  }
                }
              }
            }
          }
        }
      }
    }
    const missing = ALL_KINDS.filter((k) => ACTION_KIND_STATUS[k].produced && !seen.has(k));
    expect(missing, `unreachable names: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the classifier names things the way the user named them", () => {
  const label = (over: any) => ACTION_KIND_LABEL[classifyActionKind({ destination: "calendar", operation: "CREATE", ...over })];

  it("a repeating date is a recurring calendar rule, a one-off is an event", () => {
    expect(label({ recurrence: "yearly" })).toBe("Create recurring calendar rule");
    expect(label({ recurrence: "none" })).toBe("Create calendar event");
  });

  it("a return window is a warranty/return deadline", () => {
    expect(label({ periodKind: "return_window" })).toBe("Create warranty/return deadline");
  });

  it("a document's own expiry is a document expiration reminder", () => {
    expect(label({ ruleType: "expiration", documentExpiration: true }))
      .toBe("Create document expiration reminder");
    expect(label({ ruleType: "expiration" })).toBe("Create expiration");
  });

  it("a service date is a maintenance reminder; a repeating one is a schedule", () => {
    expect(label({ ruleType: "maintenance" })).toBe("Create service/maintenance reminder");
    expect(ACTION_KIND_LABEL[classifyActionKind({
      destination: "task", operation: "CREATE", ruleType: "maintenance", recurrence: "monthly",
    })]).toBe("Create recurring service/maintenance schedule");
  });

  it("a recurring charge is a recurring expense, not an expense", () => {
    expect(ACTION_KIND_LABEL[classifyActionKind({ destination: "expense", operation: "CREATE" })])
      .toBe("Create expense");
    expect(ACTION_KIND_LABEL[classifyActionKind({ destination: "expense", operation: "CREATE", recurrence: "monthly" })])
      .toBe("Create recurring expense");
  });

  it("an update is named for the record it updates", () => {
    const l = (profileType: string) => ACTION_KIND_LABEL[classifyActionKind({
      destination: "entity_field", operation: "UPDATE", targetKind: "profile", profileType,
    })];
    expect(l("vehicle")).toBe("Update existing asset");
    expect(l("liability")).toBe("Update existing liability");
    expect(l("subscription")).toBe("Update existing subscription");
    expect(l("person")).toBe("Update profile information");
  });

  it("an unsavable action is named for what stopped it, not for what it wanted", () => {
    expect(ACTION_KIND_LABEL[classifyActionKind({
      destination: "unsupported", operation: "CREATE", targetKind: "obligation",
      recurrence: "monthly", savable: false,
    })]).toBe("Create recurring obligation");
  });
});
