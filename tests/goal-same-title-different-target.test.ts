// A goal asked for under an existing goal's title, with a different target, is
// a question — never the old goal handed back as "Created" (chat-variations
// check on the preview, 2026-11-27: "save $5,000 for a vacation by June" beside
// a $3,000 "Save for Vacation" goal stored nothing and answered "Goal set").
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { goalRequestDiffers, goalConflictQuestion } from "../shared/goal-duplicate";

const existing = { title: "Save for Vacation", target: 3000, deadline: "2027-06-30", unit: "$" };

describe("a goal asked for again", () => {
  it("is the same goal when nothing asked for differs", () => {
    expect(goalRequestDiffers(existing, { target: 3000, deadline: "2027-06-30" })).toEqual([]);
    expect(goalRequestDiffers(existing, { target: "3000" })).toEqual([]);
    expect(goalRequestDiffers(existing, { target: "$3,000" })).toEqual([]);
    expect(goalRequestDiffers(existing, {})).toEqual([]);
  });

  it("differs by its target or its deadline", () => {
    expect(goalRequestDiffers(existing, { target: 5000, deadline: "2027-06-30" })).toEqual(["target"]);
    expect(goalRequestDiffers(existing, { target: 3000, deadline: "2027-12-31" })).toEqual(["deadline"]);
    expect(goalRequestDiffers(existing, { target: 5000, deadline: "2028-06-30" })).toEqual(["target", "deadline"]);
    expect(goalRequestDiffers({ title: "x", target: null }, { target: 10 })).toEqual(["target"]);
  });

  it("the question says nothing was saved and names both figures", () => {
    const q = goalConflictQuestion(existing, { target: 5000, deadline: "2027-06-30" });
    expect(q).toContain("NOTHING WAS SAVED");
    expect(q).toContain("$3,000");
    expect(q).toContain("$5,000");
    expect(q).toContain("update_goal");
  });

  it("the chat tool asks on a difference and reports a duplicate honestly", () => {
    const src = fs.readFileSync(`${process.cwd()}/server/ai-engine.ts`, "utf8");
    const at = src.lastIndexOf('case "create_goal": {');
    const tool = src.slice(at, src.indexOf("// Resolve tracker name to ID", at));
    expect(tool).toContain("goalRequestDiffers(");
    expect(tool).toContain("needsConfirmation: true");
    expect(tool).toContain("deduped: true");
    // the old behaviour: the existing row handed back bare, which the reply
    // envelope reported as `Created goal "…"`
    expect(tool).not.toMatch(/return dupGoal;/);
  });
});
