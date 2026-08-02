// ── AI tool registry coverage (the "test it like an MCP server" guard) ───────
// Key-free, deterministic, always runs in CI. Proves the AI command bus is
// internally complete: every declared tool has a handler, a valid schema, and
// every WRITE tool surfaces as a typed action (not the "retrieve" fallback that
// silently swallowed ~40 tools before 2026-07).
//
// This does NOT call the Anthropic API — it introspects the registry
// (TOOL_DEFINITIONS + TOOL_ACTION_MAP + READ_ONLY_TOOLS) and source-scans
// executeTool for `case "<tool>":` handler labels. The live end-to-end sweep
// lives in scripts/verify-dashboard-commands.ts.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { TOOL_DEFINITIONS, TOOL_ACTION_MAP, READ_ONLY_TOOLS } from "../server/ai-engine";

const SRC = fs.readFileSync(path.resolve(__dirname, "../server/ai-engine.ts"), "utf8");
const toolNames = TOOL_DEFINITIONS.map((t: any) => t.name);
// Handler case labels present anywhere in the file (executeTool is one big
// switch; a `case "x":` for every tool is sufficient evidence of a handler).
const handlerCases = new Set(
  Array.from(SRC.matchAll(/case\s+["']([a-z_]+)["']\s*:/g)).map((m) => m[1]),
);

describe("AI tool registry", () => {
  it("declares a healthy number of tools", () => {
    expect(toolNames.length).toBeGreaterThanOrEqual(90);
    // no duplicate tool names
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });

  it("every tool has a name + a valid input_schema", () => {
    for (const t of TOOL_DEFINITIONS as any[]) {
      expect(typeof t.name, JSON.stringify(t)).toBe("string");
      expect(t.input_schema, `${t.name} input_schema`).toBeTruthy();
      expect(t.input_schema.type, `${t.name} schema type`).toBe("object");
    }
  });

  it("every tool has an executeTool handler case", () => {
    const missing = toolNames.filter((n) => !handlerCases.has(n));
    expect(missing, `tools with no handler case: ${missing.join(", ")}`).toEqual([]);
  });

  it("every WRITE tool maps to a typed action (not the retrieve fallback)", () => {
    const writeTools = toolNames.filter((n) => !READ_ONLY_TOOLS.has(n));
    // recall_memory is read-only-ish but intentionally carries its own type.
    const unmapped = writeTools.filter(
      (n) => !TOOL_ACTION_MAP[n] || (TOOL_ACTION_MAP[n] === "retrieve"),
    );
    expect(unmapped, `write tools falling through to "retrieve": ${unmapped.join(", ")}`).toEqual([]);
  });

  it("READ_ONLY_TOOLS only lists real tools", () => {
    const bogus = [...READ_ONLY_TOOLS].filter((n) => !toolNames.includes(n));
    expect(bogus, `READ_ONLY_TOOLS entries that are not real tools: ${bogus.join(", ")}`).toEqual([]);
  });

  it("TOOL_ACTION_MAP only lists real tools", () => {
    const bogus = Object.keys(TOOL_ACTION_MAP).filter((n) => !toolNames.includes(n));
    expect(bogus, `TOOL_ACTION_MAP keys that are not real tools: ${bogus.join(", ")}`).toEqual([]);
  });

  it("every tool is classified as either read-only or write-mapped (full coverage)", () => {
    const unclassified = toolNames.filter(
      (n) => !READ_ONLY_TOOLS.has(n) && !TOOL_ACTION_MAP[n],
    );
    expect(unclassified, `tools missing from both maps: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("every mega-plan whitelist tool is a real write tool with a typed action", async () => {
    const { MEGA_ACTION_TOOLS } = await import("../server/ai-mega-plan");
    for (const n of MEGA_ACTION_TOOLS) {
      expect(toolNames.includes(n), `MEGA_ACTION_TOOLS entry "${n}" is not in TOOL_DEFINITIONS`).toBe(true);
      expect(handlerCases.has(n), `MEGA_ACTION_TOOLS entry "${n}" has no executeTool handler`).toBe(true);
      expect(TOOL_ACTION_MAP[n], `MEGA_ACTION_TOOLS entry "${n}" has no TOOL_ACTION_MAP type`).toBeTruthy();
      expect(READ_ONLY_TOOLS.has(n), `MEGA_ACTION_TOOLS entry "${n}" is read-only`).toBe(false);
    }
  });
});
