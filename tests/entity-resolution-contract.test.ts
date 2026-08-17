// Build-time guard: no completion tool may report absence from a single-type
// lookup.
//
// The 2026-08-17 report was not "the habit lookup is broken" — the habit lookup
// was fine. It was `complete_task` answering "no such task, want me to create
// it?" for a name that existed as a HABIT, because it only ever queried tasks.
// The model then relayed that partial answer as a fact.
//
// Fixing the one command would have left the same hole in complete_event,
// checkin_habit and anything added next quarter. This test is the invariant:
// every handler in the completion family must consult the shared resolver
// (server/entity-resolver.ts) before it can return "not found".
//
// If you add a new "mark X done" tool, add it to COMPLETION_TOOLS and route its
// miss-path through resolveActionable. Do not delete an entry to make this pass.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { ACTIONABLE_KINDS } from "../shared/entity-resolution";

const ENGINE = readFileSync(path.resolve(__dirname, "..", "server/ai-engine.ts"), "utf8");

/** Tools that answer "the user says they finished something named X". */
const COMPLETION_TOOLS = ["complete_task", "checkin_habit", "complete_event"];

/** Extract the body of `case "<tool>": { … }` by brace balance. */
function caseBody(tool: string): string {
  const start = ENGINE.indexOf(`case "${tool}": {`);
  if (start === -1) throw new Error(`handler for ${tool} not found`);
  let depth = 0;
  for (let i = ENGINE.indexOf("{", start); i < ENGINE.length; i++) {
    const c = ENGINE[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return ENGINE.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces in ${tool}`);
}

describe("contract: existence is decided by the database, across every type", () => {
  it.each(COMPLETION_TOOLS)("%s consults the shared resolver before reporting absence", (tool) => {
    const body = caseBody(tool);
    expect(
      body.includes("resolveActionable"),
      `${tool} can return "not found" without asking whether the name exists as ` +
      `another actionable type. Route its miss-path through resolveActionable ` +
      `(server/entity-resolver.ts) — that is the whole point of the 2026-08-17 fix.`,
    ).toBe(true);
  });

  it.each(COMPLETION_TOOLS)("%s honours an explicitly named kind", (tool) => {
    const body = caseBody(tool);
    // Saying "habit" must never complete a task of the same name, and vice
    // versa — each handler gates its cross-type branch on `explicit`.
    expect(
      /resolved\.explicit\s*!==/.test(body),
      `${tool} acts across entity types without checking whether the user named ` +
      `a kind. "Mark habit Buy groceries done" must not touch the task.`,
    ).toBe(true);
  });

  it("the resolver covers every actionable kind", () => {
    // A kind missing here is a kind whose records chat cannot find.
    expect([...ACTIONABLE_KINDS].sort()).toEqual(["event", "goal", "habit", "task"]);
  });

  it("habit scoping uses EVERY self profile, not the first one found", () => {
    const body = caseBody("checkin_habit");
    expect(
      /selfIds/.test(body) && !/find\(p => p\.type === "self"\)/.test(body),
      "checkin_habit narrowed habits to the FIRST self profile. An account with " +
      "two self rows then had half its habits invisible to chat while the " +
      "dashboard (selfIdsFrom) showed them all.",
    ).toBe(true);
  });

  it("the resolver reads through the same storage layer the UI does", () => {
    const resolver = readFileSync(path.resolve(__dirname, "..", "server/entity-resolver.ts"), "utf8");
    // No direct table access — it must go through `storage`, which is where
    // user scoping and soft-delete exclusion live.
    expect(/\.from\(["'`]/.test(resolver), "resolver queries tables directly").toBe(false);
    expect(/supabase/i.test(resolver), "resolver bypasses the storage layer").toBe(false);
  });
});
