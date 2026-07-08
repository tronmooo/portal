// ── UI-button ↔ AI-tool parity ───────────────────────────────────────────────
// The machine-checkable "the AI chat can do everything the dashboard can"
// contract. DASHBOARD_ACTIONS maps every user-facing action across the hub tabs
// (Executive / Finance / Wellness / popups / QuickAdd) to the AI tool that
// performs the same write. The test asserts each referenced tool actually
// exists in the registry, so a renamed/removed tool that breaks AI parity fails
// CI. When a new dashboard button is added, add its row here.
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "../server/ai-engine";

const toolNames = new Set(TOOL_DEFINITIONS.map((t: any) => t.name));

// action label → the AI tool(s) that achieve it from chat.
const DASHBOARD_ACTIONS: Record<string, string[]> = {
  // Finance tab
  "Add expense": ["create_expense"],
  "Edit expense": ["update_expense"],
  "Delete expense": ["delete_expense"],
  "Pay bill": ["pay_obligation"],
  "Add bill / obligation": ["create_obligation"],
  "Add income": ["log_income"],
  "Add expected paycheck": ["log_expected_paycheck"],
  "Confirm paycheck received": ["confirm_paycheck_received"],
  "Set / edit budget": ["set_budget", "create_budget", "update_budget"],
  "Add liability": ["create_liability"],
  "Add liability payment": ["add_liability_payment"],
  "Revalue asset": ["revalue_asset"],
  // Net-worth popup (entities)
  "Add asset/account profile": ["create_profile"],
  "Link asset owner / split ownership": ["link_asset_owner", "split_ownership"],
  "Link liability ↔ asset": ["link_liability_asset", "link_asset_to_liability"],
  // Executive dashboard
  "Add task": ["create_task"],
  "Complete task": ["complete_task"],
  "Add reminder": ["create_reminder"],
  "Add goal": ["create_goal"],
  "Update goal": ["update_goal"],
  "Add event": ["create_event"],
  "Refresh AI summary": ["refresh_ai_summary"],
  // Wellness tab
  "Toggle habit (check in)": ["checkin_habit"],
  "Un-check habit": ["uncomplete_habit"],
  "Quick-log tracker (weight/mood/sleep/steps/water)": ["log_tracker_entry"],
  "Mark medication taken": ["pay_obligation"],
  "Add habit": ["create_habit"],
  // Trackers / journal / documents / profiles
  "Create tracker (chat-only)": ["create_tracker"],
  "Write journal entry": ["journal_entry"],
  "Add / edit profile": ["create_profile", "update_profile"],
  "Upload / add document": ["upload_document", "create_document"],
  "Manage document (rename/link/move/delete)": ["manage_document"],
  "Save memory": ["save_memory"],
};

describe("UI-button ↔ AI-tool parity", () => {
  for (const [action, tools] of Object.entries(DASHBOARD_ACTIONS)) {
    it(`"${action}" has a real AI tool (${tools.join(" | ")})`, () => {
      const missing = tools.filter((t) => !toolNames.has(t));
      expect(missing, `unknown tools for "${action}": ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("covers a broad set of dashboard actions", () => {
    expect(Object.keys(DASHBOARD_ACTIONS).length).toBeGreaterThanOrEqual(25);
  });
});
