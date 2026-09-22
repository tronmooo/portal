// Rule 1 — reads can never mutate data.
//
// The classifier decides a turn's mutation budget from the CURRENT message
// alone. It must say READ for the questions in the rule, and it must NOT say
// READ for anything that asks for a change — including polite requests that
// happen to end in a question mark, corrections, confirmations, and
// activity reports. When in doubt it says UNKNOWN, which gates nothing.
import { describe, it, expect } from "vitest";
import { classifyTurnScope, isReadOnlyTurn } from "@shared/turn-scope";
import { operationIdFor, canonicalizeToolInput, readOnlyTurnViolation } from "@shared/ai-operation-ids";

describe("classifyTurnScope — READ turns get no mutation budget", () => {
  const reads = [
    "Where did this expense save?",
    "What bills are due?",
    "Show my loan balance",
    "Find my license plate",
    "What's my next loan payment?",
    "When is the truck payment due",
    "Did I log my run today?",
    "Did you save that expense?",
    "How much did I spend on gas this month?",
    "List my tasks for tomorrow",
    "Which habits did I complete this week?",
    "How do I add an expense?",
    "Is the electric bill paid?",
    "Do I have a task for the dentist?",
    "Tell me what changed today",
    "what did you just change?",
    "Where did the $549.50 estimate go?",
  ];
  for (const m of reads) {
    it(`READ: ${m}`, () => {
      const s = classifyTurnScope(m);
      expect(s.intent).toBe("READ");
      expect(s.allowedMutations).toBe("none");
      expect(isReadOnlyTurn(m)).toBe(true);
    });
  }
});

describe("classifyTurnScope — requests keep their mutation budget", () => {
  const writes = [
    "Can you add a task to call mom?",
    "Could you please log $40 for gas?",
    "Would you mind creating a habit to stretch?",
    "add a task to call mom",
    "Log 2 miles?",
    "Delete the dentist appointment",
    "Change the Dodge Ram's color to white",
    "wait that gas was actually 72.50",
    "yes",
    "confirm",
    "do it again",
    "What bills are due? Also add a task to pay rent",
    "Show my tasks and mark the laundry one done",
    "Remind me to call the dentist tomorrow",
    "I ran 2 miles this morning and had a chicken sandwich",
    "Mark the electric bill paid?",
    "Pay the electric bill",
    "Remember that I like tea",
  ];
  for (const m of writes) {
    it(`not READ: ${m}`, () => {
      const s = classifyTurnScope(m);
      expect(s.allowedMutations).toBe("all");
      expect(isReadOnlyTurn(m)).toBe(false);
    });
  }

  it("names the operation for single-purpose requests", () => {
    expect(classifyTurnScope("add a task to call mom").intent).toBe("CREATE");
    expect(classifyTurnScope("delete the dentist appointment").intent).toBe("DELETE");
    expect(classifyTurnScope("rename my truck loan to Ram loan").intent).toBe("UPDATE");
    expect(classifyTurnScope("What bills are due? Also add a task to pay rent").intent).toBe("MIXED");
  });

  it("never gates an empty or unclassifiable message", () => {
    expect(classifyTurnScope("").allowedMutations).toBe("all");
    expect(classifyTurnScope("   ").allowedMutations).toBe("all");
    expect(classifyTurnScope("hmm").allowedMutations).toBe("all");
  });

  it("carries a reason for the log line", () => {
    expect(classifyTurnScope("What bills are due?").reason).toMatch(/question/);
  });
});

describe("readOnlyTurnViolation", () => {
  it("is a model-facing refusal with no user-facing card", () => {
    const v = readOnlyTurnViolation("log_income", "paycheck");
    expect(v.mismatchType).toBe("read_only_turn");
    expect(v.modelDirective).toMatch(/QUESTION/);
    expect(v.modelDirective).toMatch(/log_income/);
    expect(v.userMessage).toBe("");
  });
});

// Rule 2 — operation ids are a pure function of the request.
describe("operationIdFor", () => {
  it("is stable for the same request, tool and input", () => {
    const a = operationIdFor({ requestId: "req_1", tool: "log_income", input: { amount: 500, source: "Acme" }, ordinal: 1 });
    const b = operationIdFor({ requestId: "req_1", tool: "log_income", input: { source: "Acme", amount: 500 }, ordinal: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^op_log_income_[0-9a-f]{16}$/);
  });
  it("differs by request, tool, input and ordinal", () => {
    const base = { requestId: "req_1", tool: "log_income", input: { amount: 500 }, ordinal: 1 };
    expect(operationIdFor({ ...base, requestId: "req_2" })).not.toBe(operationIdFor(base));
    expect(operationIdFor({ ...base, tool: "create_expense" })).not.toBe(operationIdFor(base));
    expect(operationIdFor({ ...base, input: { amount: 501 } })).not.toBe(operationIdFor(base));
    expect(operationIdFor({ ...base, ordinal: 2 })).not.toBe(operationIdFor(base));
  });
  it("ignores engine context keys and whitespace", () => {
    expect(canonicalizeToolInput({ b: " x ", a: 1, __userMessage: "hi", c: undefined }))
      .toBe(canonicalizeToolInput({ a: 1, b: "x" }));
  });
});

// Rule 1 — a read turn's answer may describe history; only a fresh
// first-person write claim is a lie on a turn that could not write.
import { checkClaims, isFirstPersonWriteClaim } from "@shared/ai-claim-check";
describe("claim check on a read-only turn", () => {
  it("lets a description of an earlier save through", () => {
    const r = checkClaims({ reply: "Your Acme paycheck of $2,500 was saved under Income on the Finance page.", operations: [], readOnlyTurn: true });
    expect(r.unsupportedSuccess).toBe(false);
  });
  it("still refuses a first-person claim of a write that did not happen", () => {
    const r = checkClaims({ reply: "I've logged your $2,500 paycheck.", operations: [], readOnlyTurn: true });
    expect(r.unsupportedSuccess).toBe(true);
    expect(isFirstPersonWriteClaim("Done — added the task.")).toBe(true);
    expect(isFirstPersonWriteClaim("It was saved yesterday.")).toBe(false);
  });
  it("is unchanged on a write turn", () => {
    const r = checkClaims({ reply: "Your paycheck was saved.", operations: [] });
    expect(r.unsupportedSuccess).toBe(true);
  });
});
