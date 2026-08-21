// The three reference failures from the QA report, plus the leak the old
// "never use history for a profile" rule was written to prevent.

import { describe, it, expect } from "vitest";
import {
  emptyConversationContext,
  rememberTurn,
  resolveConversationReference,
  resolveSubjectProfile,
  hasReferringExpression,
  referencedType,
  lastEntityOfType,
  renderConversationContext,
  CONTEXT_TURN_WINDOW,
} from "@shared/conversation-context";

const SARAH = { id: "sarah-1", name: "Sarah Miller" };
const JOHN = { id: "john-1", name: "John Hancock" };

/** "Sarah has a dentist appointment on September 8 at 2pm" */
function afterDentist() {
  return rememberTurn(emptyConversationContext(), {
    profiles: [SARAH],
    entities: [
      { id: "evt-1", type: "event", name: "Dentist appointment", profileId: SARAH.id, operation: "create" },
    ],
  });
}

/** "Sarah owns a MacBook Air worth $1,200" */
function afterMacbook() {
  return rememberTurn(emptyConversationContext(), {
    profiles: [SARAH],
    entities: [
      { id: "asset-1", type: "asset", name: "MacBook Air", profileId: SARAH.id, operation: "create" },
    ],
  });
}

/** "Sarah takes a multivitamin every morning" */
function afterVitamin() {
  return rememberTurn(emptyConversationContext(), {
    profiles: [SARAH],
    entities: [
      { id: "habit-1", type: "habit", name: "Multivitamin", profileId: SARAH.id, operation: "create" },
    ],
  });
}

describe("QA req 4 — 'Remind me two days before'", () => {
  it("resolves to the appointment created last turn", () => {
    const ctx = afterDentist();
    const ref = resolveConversationReference(ctx, "Remind me two days before");
    expect(ref?.id).toBe("evt-1");
    expect(ref?.type).toBe("event");
  });

  it("resolves 'the appointment' by its type noun", () => {
    const ctx = afterDentist();
    expect(referencedType("move the appointment to Friday")).toBe("event");
    expect(resolveConversationReference(ctx, "move the appointment to Friday")?.id).toBe("evt-1");
  });

  it("keeps the reminder on Sarah, not the account owner", () => {
    const ctx = afterDentist();
    expect(resolveSubjectProfile(ctx, "Remind me two days before")?.id).toBe(SARAH.id);
  });
});

describe("QA req 15 — 'Actually it's probably worth $950 now'", () => {
  it("resolves to the MacBook, not to a vehicle or a new record", () => {
    const ctx = afterMacbook();
    const ref = resolveConversationReference(ctx, "Actually I checked and it's probably worth $950 now");
    expect(ref?.id).toBe("asset-1");
    expect(ref?.name).toBe("MacBook Air");
  });

  it("resolves the named form too", () => {
    const ctx = afterMacbook();
    expect(resolveConversationReference(ctx, "the MacBook is worth $950")?.id).toBe("asset-1");
  });

  it("does not drift to another profile's asset", () => {
    // John's car is remembered too, and is NEWER — but the message names the
    // MacBook, and a name match outranks recency.
    const ctx = rememberTurn(afterMacbook(), {
      profiles: [JOHN],
      entities: [{ id: "asset-2", type: "asset", name: "Toyota Camry", profileId: JOHN.id, operation: "create" }],
    });
    const ref = resolveConversationReference(ctx, "the MacBook Air is worth $950 now");
    expect(ref?.id).toBe("asset-1");
    expect(ref?.profileId).toBe(SARAH.id);
  });
});

describe("QA req 4 + 8 — 'She already took it today'", () => {
  it("resolves 'it' to the multivitamin habit", () => {
    const ctx = afterVitamin();
    const ref = resolveConversationReference(ctx, "She already took it today");
    expect(ref?.id).toBe("habit-1");
    expect(ref?.type).toBe("habit");
  });

  it("resolves 'she' to Sarah", () => {
    const ctx = afterVitamin();
    const subject = resolveSubjectProfile(ctx, "She already took it today");
    expect(subject?.id).toBe(SARAH.id);
  });
});

describe("QA req 14 — a profile is never adopted without a reference", () => {
  it("returns nothing when the message refers to nobody", () => {
    const ctx = afterVitamin();
    // No pronoun, no reference — this is about the account owner, and Sarah
    // must not be inherited from the previous turn.
    expect(resolveSubjectProfile(ctx, "I ran 3 miles this morning")).toBeNull();
    expect(resolveSubjectProfile(ctx, "Add milk to my grocery list")).toBeNull();
  });

  it("does not treat first-person pronouns as a reference to someone else", () => {
    const ctx = afterVitamin();
    expect(resolveSubjectProfile(ctx, "I took my vitamin")).toBeNull();
  });

  it("resolves nothing at all on an empty conversation", () => {
    const ctx = emptyConversationContext();
    expect(resolveConversationReference(ctx, "change it to Friday")).toBeNull();
    expect(resolveSubjectProfile(ctx, "she took it")).toBeNull();
  });
});

describe("reference detection", () => {
  it("sees referring expressions", () => {
    for (const m of [
      "She already took it today",
      "Remind me two days before that",
      "move the appointment",
      "it's worth $950",
      "delete this",
    ]) {
      expect(hasReferringExpression(m), m).toBe(true);
    }
  });

  it("does not invent one", () => {
    for (const m of [
      "Sarah owns a MacBook Air worth $1,200",
      "I ran 3 miles",
      "Add a habit to floss",
    ]) {
      expect(hasReferringExpression(m), m).toBe(false);
    }
  });
});

describe("bookkeeping", () => {
  it("tracks the per-type slots the report asks for", () => {
    let ctx = afterDentist();
    ctx = rememberTurn(ctx, {
      entities: [{ id: "habit-9", type: "habit", name: "Floss", operation: "create" }],
    });
    expect(lastEntityOfType(ctx, "event")?.id).toBe("evt-1");
    expect(lastEntityOfType(ctx, "habit")?.id).toBe("habit-9");
    expect(lastEntityOfType(ctx, "asset")).toBeNull();
  });

  it("tracks last created and last updated separately", () => {
    let ctx = afterMacbook();
    expect(ctx.lastCreatedEntityId).toBe("asset-1");
    ctx = rememberTurn(ctx, {
      entities: [{ id: "asset-1", type: "asset", name: "MacBook Air", operation: "update" }],
    });
    expect(ctx.lastUpdatedEntityId).toBe("asset-1");
    // Touching a record again moves it to the front rather than duplicating it.
    expect(ctx.entities.filter((e) => e.id === "asset-1")).toHaveLength(1);
  });

  it("stops resolving once the reference falls out of the window", () => {
    let ctx = afterDentist();
    for (let i = 0; i < CONTEXT_TURN_WINDOW; i++) {
      ctx = rememberTurn(ctx, {});
    }
    expect(resolveConversationReference(ctx, "move the appointment")).toBeNull();
  });

  it("is pure — remembering a turn does not mutate the previous context", () => {
    const before = afterDentist();
    const snapshot = JSON.parse(JSON.stringify(before));
    rememberTurn(before, { entities: [{ id: "x", type: "task", name: "T", operation: "create" }] });
    expect(before).toEqual(snapshot);
  });
});

describe("what the model is shown", () => {
  it("names the subject and the records, with ids", () => {
    const block = renderConversationContext(afterDentist());
    expect(block).toContain("Sarah Miller");
    expect(block).toContain("sarah-1");
    expect(block).toContain("Dentist appointment");
    expect(block).toContain("evt-1");
  });

  it("is empty when there is nothing to resolve against", () => {
    expect(renderConversationContext(emptyConversationContext())).toBe("");
  });
});
