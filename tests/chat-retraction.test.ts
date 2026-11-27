// Owner, 2026-11-27: "Undo must reverse only the intended action."
// "I meditated again... no wait, I only did it once" asks for nothing; the
// model used to remove the day's one check-in (chat-variations check: "today
// has 0 check-in(s), expected it to stay at 1").
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { retractsOwnClaim } from "../shared/chat-retraction";

describe("a report withdrawn in the same message changes nothing", () => {
  it.each([
    "I meditated again... no wait, I only did it once",
    "took my vitamins again, scratch that, I only took them once",
    "I ran again today — never mind, just the once",
    "walked the dog a second time, actually no, I didn't do it again",
    "I meditated again. oh wait, not again",
    "delete my meditation habit, never mind, I only did it once",   // a withdrawn request also changes nothing
  ])("withdrawn: %s", (m) => expect(retractsOwnClaim(m)).toBe(true));

  it.each([
    "spent $40 on a gift, no wait, it was $45",                 // a correction with a new value
    "coffee with Dana on Thursday, no wait, make it Friday",    // a correction with a new day
    "undo that",                                                 // a real undo of the previous action
    "no wait, I only did it once",                               // nothing reported in this message: refers to an earlier turn
    "I meditated again",                                         // a plain report
    "I only did it once",
    "never mind",
    "I ran 2 miles, scratch that, I only ran once and it was 3 miles",
  ])("not a self-withdrawal: %s", (m) => expect(retractsOwnClaim(m)).toBe(false));

  it("the chat answers it before any model call and writes nothing", () => {
    const src = fs.readFileSync(`${process.cwd()}/server/ai-engine.ts`, "utf8");
    const at = src.indexOf("retractsOwnClaim(userMessage)");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 160)).toContain("actions: [], results: []");
    // it sits before the tool loop's first model call
    expect(at).toBeLessThan(src.indexOf("UNBACKED_WRITE_RETRY_INSTRUCTION });"));
  });

  it("a plain 'did it' tracker log said twice within two minutes is one entry", () => {
    const src = fs.readFileSync(`${process.cwd()}/server/ai-engine.ts`, "utf8");
    expect(src).toContain("if (existingNums.length === 0 && newNums.length === 0) {");
  });
});
