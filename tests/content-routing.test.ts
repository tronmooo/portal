// The twelve sentences from the 2026-08-20 spec, run against the semantic
// layer. Each one names WHAT should be created and for WHOM; this file pins
// the deterministic classifier that answers the first half of that question.
//
// The bug that started it: "jane doe note: I have the look that one gives
// somebody" was filed as a Journal Entry. It is the first case below.

import { describe, it, expect } from "vitest";
import {
  classifyContent,
  classifyClause,
  routeContent,
  detectExplicitKind,
  detectStructuredDomain,
  extractProfileHint,
  isBareFilingDirective,
  CONTENT_CONFIDENCE_FLOOR,
} from "@shared/content-routing";

describe("the reported bug", () => {
  it("'jane doe note: …' is a NOTE for Jane Doe, not a journal entry", () => {
    const c = classifyContent("jane doe note:  I have the look that one gives somebody");
    expect(c.kind).toBe("note");
    expect(c.explicit).toBe(true);
    expect(c.profileHint?.toLowerCase()).toBe("jane doe");
  });
});

describe("explicit intent always wins", () => {
  it.each([
    ["Create a note for Robert saying he likes morning appointments.", "note"],
    ["Journal this for Robert — he seemed happier today.", "journal"],
    ["Create a task for Robert to call his doctor.", "task"],
    ["Make a note that I need to call Progressive tomorrow.", "note"],
    ["Add to Mike's journal that he had a great day.", "journal"],
    ["Remind me to call the landlord tomorrow.", "task"],
  ])("%s → %s", (msg, kind) => {
    const c = classifyContent(msg);
    expect(c.kind).toBe(kind);
    expect(c.explicit).toBe(true);
  });

  it("a Note request with actionable time stays a Note", () => {
    const c = classifyContent("Create a note that Robert's appointment is September 18 at 2 PM.");
    expect(c.kind).toBe("note");
    expect(c.structuredDomain).toBeUndefined();
  });
});

describe("structured domain objects take priority", () => {
  it.each([
    ["My birthday is July 10, 1994.", "profile_dob"],
    ["Robert's driver's license expires July 18, 2034.", "document_expiration"],
    ["I spent $38 at Costco.", "expense"],
  ])("%s → structured/%s", (msg, domain) => {
    const c = classifyContent(msg);
    expect(c.kind).toBe("structured");
    expect(c.structuredDomain).toBe(domain);
  });

  it("work ABOUT a structured record is a Task, not a field edit", () => {
    const c = classifyContent("I need to renew my registration before October 10.");
    expect(c.kind).toBe("task");
    expect(detectStructuredDomain("I need to renew my registration before October 10.")).toBeNull();
  });
});

describe("the twelve spec sentences", () => {
  const cases: Array<[string, string, string | null]> = [
    ["Remember that Robert's gate code is 4821.", "note", "Robert"],
    ["Robert needs to call Progressive.", "task", "Robert"],
    ["Robert needs to call Progressive tomorrow at 2 PM.", "task", "Robert"],
    ["Journal for Robert: today was a really good day and he seemed much happier.", "journal", "Robert"],
    ["Journal for yesterday: I worked all day and played soccer at night.", "journal", null],
    ["Remember that Robert's birthday is July 10, 1994.", "structured", "Robert"],
    ["Robert's driver's license expires July 18, 2034.", "structured", "Robert"],
    ["Remind Robert to renew his license one month before it expires.", "task", "Robert"],
    ["Create a note for Robert that his license expires July 18, 2034.", "note", "Robert"],
    ["Buy dog food every Saturday.", "task", null],
  ];
  it.each(cases)("%s → %s", (msg, kind) => {
    expect(classifyContent(msg).kind).toBe(kind);
  });
  it.each(cases.filter(c => c[2]))("%s → profile %s", (msg, _kind, who) => {
    expect(extractProfileHint(msg)).toBe(who);
  });
});

describe("note vs journal vs task on the same subject", () => {
  it("Robert likes Italian food → note", () => {
    expect(classifyClause("Robert likes Italian food.").kind).toBe("note");
  });
  it("Robert and I had Italian food tonight → journal", () => {
    expect(classifyClause("Robert and I had Italian food tonight and had a really good conversation.").kind).toBe("journal");
  });
  it("Take Robert to the Italian restaurant Friday → task", () => {
    expect(classifyClause("Take Robert to the Italian restaurant Friday.").kind).toBe("task");
  });
});

describe("one message, several objects", () => {
  it("journal + task from one sentence pair", () => {
    const plan = routeContent("Journal this: I had a stressful day. Remind me to call my landlord tomorrow.");
    expect(plan.actions.map(a => a.kind)).toEqual(["journal", "task"]);
  });

  it("a trailing filing directive re-files the narrative, it is not a second object", () => {
    const plan = routeContent("I bought dog food Saturday and my dog loved it. Journal this.");
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].kind).toBe("journal");
    expect(plan.actions[0].clause).toMatch(/dog food/i);
  });

  it("recognises bare filing directives", () => {
    expect(isBareFilingDirective("Journal this.")).toBe(true);
    expect(isBareFilingDirective("Save this in my journal")).toBe(true);
    expect(isBareFilingDirective("Journal this: I had a stressful day")).toBe(false);
  });
});

describe("silence when unsure", () => {
  it("gibberish gets no confident read", () => {
    expect(classifyContent("asdf qwerty").confidence).toBeLessThan(CONTENT_CONFIDENCE_FLOOR);
  });
  it("detectExplicitKind returns null when no object is named", () => {
    expect(detectExplicitKind("Robert likes Italian food")).toBeNull();
  });
});
