// "I want to save $5,000 for a vacation by June" beside a $3,000 vacation
// goal: create_goal stopped to ASK (I16), the model replied as if it had
// updated the goal, the claim gate rightly refused that — and the person was
// told "1 step didn't go through" instead of being asked (chat variations on
// the preview, 2026-11-28). A step that asked is answered with its question.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { honestFailureReply } from "../shared/ai-claim-check";
import { goalConflictQuestion } from "../shared/goal-duplicate";
import { isInternalDirective } from "../shared/ai-message-kinds";

const q = goalConflictQuestion({ title: "Vacation", target: 3000, deadline: "2027-06-30" } as any, { target: 5000, deadline: "2027-06-30" } as any);

describe("a step that asked is answered with its question", () => {
  it("the goal conflict question is written for the person", () => {
    expect(isInternalDirective(q)).toBe(false);
    expect(q).toMatch(/3,000/);
    expect(q).toMatch(/5,000/);
    expect(q).toMatch(/\?/);
  });
  it("honestFailureReply returns the question, not 'didn't go through'", () => {
    const reply = honestFailureReply([{ tool: "create_goal", status: "failed", question: q }]);
    expect(reply).toBe(q);
    expect(reply).not.toMatch(/didn'?t go through/);
  });
  it("a failure with no question is still the honest failure", () => {
    expect(honestFailureReply([{ tool: "create_goal", status: "failed" }])).toMatch(/1 step didn't go through/);
  });
  it("the chat engine carries a needsConfirmation question onto the operation and into the check", () => {
    const src = readFileSync("server/ai-engine.ts", "utf8");
    expect(src).toMatch(/needsConfirmation === true && typeof result\?\.error === "string"\s*&& !isInternalDirective\(result\.error\) \? \{ question: String\(result\.error\) \}/);
    expect(src).toMatch(/\.\.\.\(op\.question \? \{ question: op\.question \} : \{\}\)/);
  });
});
