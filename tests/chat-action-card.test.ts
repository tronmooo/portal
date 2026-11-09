// What a chat action card says. Before 2026-11-09 about thirty write tools
// produced a card reading "UPDATE ENTITY / Update Entity" (a profile merge:
// "DELETE ENTITY") that named no record — found by replaying every tool's
// real reply through the chat page in a browser.
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { TOOL_DEFINITIONS, TOOL_ACTION_MAP, READ_ONLY_TOOLS } from "../server/ai-engine";
import { actionCardSubject, genericActionLabel, toolCardLabel, GENERIC_ACTION_TYPES } from "../shared/chat-action-card";

const tools = TOOL_DEFINITIONS as any[];
const writeTools = tools.filter((t) => !READ_ONLY_TOOLS.has(t.name));

// Tools whose input names no record: they act on a setting, a plan or "the
// last thing". Their card is the action alone. Listing one here is a decision,
// not a default — a tool that takes a name must show it.
const NO_SUBJECT = new Set([
  "restore_task", "restore_habit", "set_notification_preferences", "log_medication_dose", "skip_medication_dose",
  "journal_entry", "undo_last_action", "preview_bulk_action", "execute_bulk_action", "configure_dashboard_sections",
  "repair_relations", "repair_profile_types", "sync_calendar", "manage_document", "update_budget",
  "copy_budgets_previous_month", "upload_document", "refresh_financial_data", "confirm_paycheck_received",
  "bulk_complete_tasks", "link_entities",
]);

/** The tool's required string inputs, filled the way the model fills them. */
function sampleInput(tool: any): Record<string, unknown> {
  const props = tool.input_schema?.properties || {};
  const out: Record<string, unknown> = {};
  for (const key of tool.input_schema?.required || []) {
    const type = props[key]?.type;
    if (type === "string" && !props[key]?.enum) out[key] = `the ${key}`;
  }
  return out;
}

describe("chat action cards say what happened", () => {
  it("every write tool in a generic bucket gets its own label", () => {
    const generic = writeTools.filter((t) => GENERIC_ACTION_TYPES.has(TOOL_ACTION_MAP[t.name]));
    expect(generic.length).toBeGreaterThan(30);
    for (const t of generic) {
      const label = genericActionLabel(TOOL_ACTION_MAP[t.name], { _tool: t.name });
      expect(label, t.name).toBeTruthy();
      expect(label!, t.name).not.toMatch(/\bentit(y|ies)\b/i);
      expect(label!, t.name).not.toContain("_");
    }
  });

  it("the reported ones", () => {
    expect(genericActionLabel("delete_entity", { _tool: "execute_bulk_action" })).toBe("Bulk change applied");
    expect(genericActionLabel("update_profile", { _tool: "merge_profiles" })).toBeNull(); // typed label stands
    expect(genericActionLabel("link_entities", { _tool: "unlink_asset_from_liability" })).toBe("Unlink asset from liability");
    expect(genericActionLabel("update_entity", { _tool: "update_task" })).toBe("Update task");
    // A reply from a server that does not stamp the tool: the page's own label.
    expect(genericActionLabel("update_entity", { title: "x" })).toBeNull();
    expect(toolCardLabel("not a tool; DROP")).toBeNull();
  });

  it("every write tool that takes a name shows it on the card", () => {
    const silent: string[] = [];
    for (const t of writeTools) {
      const subject = actionCardSubject(sampleInput(t));
      if (!subject && !NO_SUBJECT.has(t.name)) silent.push(`${t.name} (required: ${(t.input_schema?.required || []).join(", ")})`);
      // …and nothing is on the exemption list that does not need to be.
      if (subject && NO_SUBJECT.has(t.name)) silent.push(`${t.name} is exempt but names "${subject}"`);
    }
    expect(silent, silent.join("\n")).toEqual([]);
  });

  it("reads the record from the names tools actually use", () => {
    expect(actionCardSubject({ liabilityName: "Auto Loan", amount: 250 })).toBe("Auto Loan");
    expect(actionCardSubject({ billName: "Internet" })).toBe("Internet");
    expect(actionCardSubject({ source_name: "Alicia", target_name: "Alice" })).toBe("Alicia → Alice");
    expect(actionCardSubject({ liabilityName: "Auto Loan", fromAssetName: "Truck", toAssetName: "Van" })).toBe("Truck → Van");
    expect(actionCardSubject({ title: "Buy milk", name: "ignored" })).toBe("Buy milk");
    expect(actionCardSubject({ _tool: "x", _turnId: "t", confirm: true })).toBe("");
    expect(actionCardSubject({ content: "word ".repeat(60) }).length).toBeLessThanOrEqual(80);
    expect(actionCardSubject(null)).toBe("");
  });

  it("the engine stamps the tool on the action, and the page reads both helpers", () => {
    const engine = fs.readFileSync(path.resolve(__dirname, "../server/ai-engine.ts"), "utf8");
    const built = engine.slice(engine.indexOf("actionForStream = {"));
    expect(built.slice(0, built.indexOf("};"))).toContain("_tool: toolUse.name");
    const page = fs.readFileSync(path.resolve(__dirname, "../client/src/pages/chat.tsx"), "utf8");
    expect(page).toContain("genericActionLabel(type, data)");
    expect(page).toContain("actionCardSubject(action.data)");
  });
});
