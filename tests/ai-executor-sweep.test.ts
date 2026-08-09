// tests/ai-executor-sweep.test.ts
//
// EVERY registered AI chat tool, actually executed.
//
// tests/ai-tool-registry.test.ts proves each tool is *wired* (definition ↔
// executor case). This suite proves each tool *runs*: all 140 tools in
// TOOL_DEFINITIONS are driven through the real executeTool against MemStorage,
// in lifecycle order (create → read → link → pay → update → complete →
// delete/restore → bulk), on one shared storage so entities persist between
// scenarios the way they do across a real chat session.
//
// What the first run of this sweep found (2026-08-09) — all fixed alongside it:
//   • MemStorage threw "not implemented" for every liability link, asset
//     ownership link, and liability payment — 10+ chat commands dead on the
//     dev backend.
//   • MemStorage.createPaycheck returned a row without storing it, so
//     confirm/delete paycheck could never find anything.
//   • deleteTask/deleteHabit hard-deleted, so restore_task / restore_habit
//     always reported "nothing to restore".
//   • undo_last_payment failed after a successful pay_obligation (obligation
//     payments were embedded; deleteLiabilityPayment didn't know about them).
//   • findOrphans read a `result.issues` field getOwnershipConsistency never
//     returns, reporting "everything healthy" no matter how much drift existed.
//   • create_artifact rejected checklists whose items were plain strings —
//     a shape the model regularly emits.
//   • update_budget / confirm_paycheck_received demanded row ids the model
//     doesn't have; they now resolve category / source names too.
//
// Exhaustiveness is enforced below: a tool added to TOOL_DEFINITIONS without a
// scenario here fails the suite by name.
import { describe, it, expect, beforeAll } from "vitest";
import { MemStorage, requestStorageContext } from "../server/storage";
import { TOOL_DEFINITIONS, executeTool } from "../server/ai-engine";
import { finalizeToolResult, buildTurnVerifyContext, recordActionLog } from "../server/ai-envelope";

const USER = "executor-sweep-user";

type Expectation =
  | "ok"     // must not throw and must not return { error }
  | "soft";  // a STRUCTURED error is accepted (needs an external service this
             // environment doesn't have) — but throwing is still a failure.

interface Scenario {
  tool: string;
  input: Record<string, any>;
  expect?: Expectation;
  note?: string;
  /** Extra assertion on the raw result. */
  verify?: (res: any, ctx: { storage: MemStorage; ids: Record<string, string> }) => void | Promise<void>;
}

// Placeholder tokens resolved at run time from earlier create_profile results.
const PROFILE_ID = (name: string) => `__PROFILE_ID:${name}__`;

const SCENARIOS: Scenario[] = [
  // ── Foundation: profiles & core entities ──────────────────────────────
  { tool: "create_profile", input: { type: "person", name: "Bob Miller", fields: { birthday: "1980-04-12", bloodType: "O+" } } },
  { tool: "create_profile", input: { type: "person", name: "Sarah Miller" } },
  { tool: "create_profile", input: { type: "pet", name: "Max", fields: { species: "dog", breed: "Beagle" } } },
  { tool: "create_profile", input: { type: "vehicle", name: "Honda Civic", fields: { make: "Honda", model: "Civic", year: 2020 }, forProfile: "Bob Miller" } },
  { tool: "create_profile", input: { type: "property", name: "123 Maple St", fields: { address: "123 Maple St" }, forProfile: "Bob Miller" } },
  {
    tool: "create_task", input: { title: "Renew sweep passport", priority: "high", dueDate: "2026-09-01" },
    verify: async (_res, { storage }) => {
      const tasks = await storage.getTasks();
      expect(tasks.some(t => t.title === "Renew sweep passport")).toBe(true);
    },
  },
  { tool: "create_task", input: { title: "Buy sweep milk" } },
  { tool: "create_reminder", input: { title: "Sweep dentist appointment", fireAt: "2026-09-10T15:00:00" } },
  { tool: "create_habit", input: { name: "Meditate", frequency: "daily", timeOfDay: "morning" } },
  { tool: "create_tracker", input: { name: "Weight", category: "health", unit: "lbs", fields: [{ name: "weight", type: "number", unit: "lbs" }] } },
  { tool: "create_tracker", input: { name: "Lisinopril", category: "medication", fields: [{ name: "dosage", type: "number", unit: "mg" }] } },
  { tool: "create_expense", input: { amount: 42.5, description: "Groceries at Safeway", category: "Food" } },
  { tool: "create_expense", input: { amount: 900, description: "New laptop", category: "Electronics" } },
  { tool: "create_event", input: { title: "Team offsite", date: "2026-09-15", time: "09:00" } },
  { tool: "create_obligation", input: { name: "Netflix", amount: 15.99, frequency: "monthly", nextDueDate: "2026-09-01" } },
  { tool: "create_liability", input: { name: "Civic Auto Loan", subtype: "auto_loan", currentBalance: 18000, annualRate: 5.9, monthlyPayment: 350, lender: "Chase" } },
  { tool: "create_goal", input: { title: "Lose 10 lbs", type: "decrease", target: 170, unit: "lbs", startValue: 180, deadline: "2026-12-31" } },
  {
    // Items as plain strings — the shape the model actually sends — must be
    // coerced, not rejected.
    tool: "create_artifact", input: { title: "Packing list", type: "checklist", content: "", items: ["Passport", "Charger", "Socks"] },
    verify: (res) => {
      expect(res?.result?.items?.length).toBe(3);
      expect(res?.result?.items?.[0]?.text).toBe("Passport");
    },
  },
  { tool: "create_artifact", input: { title: "Trip notes", type: "markdown", content: "# Trip\nSome notes." } },
  { tool: "create_document", input: { name: "Home insurance policy", content: "Policy #12345, expires 2027-01-01" } },
  { tool: "create_domain", input: { name: "Wine Cellar", description: "Track wine bottles" } },
  { tool: "create_budget", input: { category: "Food", amount: 500 } },
  { tool: "set_budget", input: { category: "Transport", amount: 200 } },
  { tool: "log_income", input: { amount: 3200, source: "Acme salary", category: "salary" } },
  { tool: "log_expected_paycheck", input: { source: "Acme Corp", amount: 3200, expected_date: "2026-08-25" } },
  { tool: "journal_entry", input: { content: "Great day today.", mood: "happy" } },
  { tool: "save_memory", input: { key: "seat-preference", value: "prefers window seats" } },
  { tool: "create_notification", input: { title: "Insurance renewal", message: "Policy renews soon", severity: "info" } },
  { tool: "schedule_medication_refills", input: { medicationName: "Lisinopril", startDate: "2026-08-09", pillsPerFill: 30, refills: 2, dosage: "10mg" } },
  { tool: "log_medication_dose", input: { medication: "Lisinopril" } },
  { tool: "skip_medication_dose", input: { medication: "Lisinopril", reason: "forgot" } },
  { tool: "log_tracker_entry", input: { trackerName: "Weight", values: { weight: 178 } } },
  { tool: "checkin_habit", input: { name: "Meditate" } },

  // ── Reads ─────────────────────────────────────────────────────────────
  { tool: "search", input: { query: "passport" } },
  { tool: "get_profile_data", input: { profileName: "Bob Miller" } },
  { tool: "get_summary", input: { entity_type: "all" } },
  { tool: "recall_memory", input: { query: "window seats" } },
  { tool: "get_goal_progress", input: {} },
  { tool: "get_budget_summary", input: {} },
  { tool: "query_net_worth_history", input: {} },
  { tool: "get_loan_schedule", input: { loan_id: "civic-loan" } },
  { tool: "get_liability_summary", input: {} },
  { tool: "get_cashflow", input: {} },
  { tool: "get_relationships", input: { profileName: "Bob Miller" } },
  { tool: "get_asset_rollup", input: { profileName: "123 Maple St" } },
  { tool: "query_calendar", input: { startDate: "2026-08-01", endDate: "2026-09-30" } },
  { tool: "query_expenses", input: { limit: 5 } },
  { tool: "query_tasks", input: { status: "active" } },
  { tool: "spending_analytics", input: { period: "this_month" } },
  { tool: "get_missed_doses", input: { medication: "Lisinopril", days: 7 } },
  { tool: "get_dose_history", input: { medication: "Lisinopril", days: 7 } },
  {
    // "tracker" (singular) is not in the schema enum but models emit it —
    // the alias normalizer must accept it.
    tool: "generate_chart", input: { chartType: "line", title: "Weight over time", dataSource: "tracker", trackerName: "Weight" },
  },
  { tool: "generate_table", input: { title: "All tasks", dataSource: "tasks", columns: ["title", "status"] } },
  { tool: "generate_report", input: { reportType: "financial" } },
  { tool: "search_documents", input: { query: "insurance" } },
  { tool: "open_document", input: { query: "Home insurance policy" } },
  { tool: "retrieve_document", input: { query: "insurance policy" } },
  { tool: "recall_actions", input: { count: 5 } },
  { tool: "get_entity_history", input: { entity_type: "task", name: "Renew sweep passport" } },
  { tool: "navigate", input: { page: "dashboard" } },
  { tool: "set_dashboard_scope", input: { profileName: "Bob Miller" } },
  { tool: "explain_dashboard_item", input: { name: "Renew sweep passport" } },
  {
    tool: "find_orphans", input: {},
    verify: (res) => {
      // The scan must report real counts, not the pre-fix unconditional "healthy".
      expect(res?.error).toBeUndefined();
      expect(typeof res?.issue_count).toBe("number");
      expect(typeof res?.scanned).toBe("number");
      expect(res.scanned).toBeGreaterThan(0);
    },
  },
  { tool: "validate_profile_isolation", input: {} },
  { tool: "find_duplicates", input: {} },
  { tool: "refresh_dashboard", input: {} },
  { tool: "validate_dashboard_counts", input: {} },
  { tool: "refresh_ai_summary", input: {} },
  { tool: "get_related", input: { entity_type: "profile", entity_id: PROFILE_ID("Bob Miller") } },

  // ── Links & ownership ─────────────────────────────────────────────────
  { tool: "link_liability_asset", input: { liabilityName: "Civic Auto Loan", assetName: "Honda Civic" } },
  { tool: "unlink_asset_from_liability", input: { liabilityName: "Civic Auto Loan", assetName: "Honda Civic" } },
  { tool: "link_asset_to_liability", input: { liabilityName: "Civic Auto Loan", assetName: "Honda Civic" } },
  { tool: "link_liability_owner", input: { liabilityName: "Civic Auto Loan", partyName: "Bob Miller", role: "owner", ownershipPct: 100 } },
  { tool: "link_asset_owner", input: { assetName: "Honda Civic", partyName: "Bob Miller", role: "owner", ownershipPct: 100 } },
  { tool: "split_ownership", input: { subjectName: "Honda Civic", subjectKind: "asset", splits: [{ partyName: "Bob Miller", pct: 60 }, { partyName: "Sarah Miller", pct: 40 }] } },
  { tool: "move_liability_to_asset", input: { liabilityName: "Civic Auto Loan", fromAssetName: "Honda Civic", toAssetName: "123 Maple St" } },
  { tool: "link_entities", input: { source_type: "profile", source_id: PROFILE_ID("Max"), target_type: "profile", target_id: PROFILE_ID("Bob Miller"), relationship: "owned_by" } },
  { tool: "link_document", input: { documentName: "Home insurance policy", profileName: "123 Maple St" } },

  // ── Payments & money flows ────────────────────────────────────────────
  {
    tool: "add_liability_payment", input: { liabilityName: "Civic Auto Loan", amount: 350, paymentDate: "2026-08-05" },
    verify: async (_res, { storage, ids }) => {
      const payments = await storage.getLiabilityPayments(ids["liability:Civic Auto Loan"] || "");
      expect(payments.length).toBeGreaterThan(0);
    },
  },
  { tool: "update_liability_payment", input: { liabilityName: "Civic Auto Loan", changes: { amount: 360 } } },
  { tool: "delete_liability_payment", input: { liabilityName: "Civic Auto Loan" } },
  { tool: "mark_loan_payment", input: { loanName: "Civic Auto Loan" } },
  { tool: "pay_obligation", input: { name: "Netflix", amount: 15.99 } },
  {
    // Undo after a real pay_obligation — the exact flow that used to fail with
    // "Couldn't remove the last payment".
    tool: "undo_last_payment", input: { billName: "Netflix" },
    verify: (res) => expect(res?.undone).toBe(true),
  },
  { tool: "confirm_paycheck_received", input: { paycheck_id: "Acme Corp", actual_amount: 3195 }, note: "source name, not id — executor resolves it" },
  { tool: "refund_expense", input: { expenseDescription: "New laptop", amount: 100 } },
  { tool: "convert_expense_to_asset", input: { expenseDescription: "New laptop" } },

  // ── Updates ───────────────────────────────────────────────────────────
  { tool: "update_profile", input: { name: "Bob Miller", changes: { phone: "555-0100" } } },
  { tool: "update_task", input: { title: "Renew sweep passport", changes: { priority: "medium" } } },
  { tool: "update_reminder", input: { title: "Sweep dentist appointment", newFireAt: "2026-09-11T16:00:00" } },
  { tool: "update_event", input: { title: "Team offsite", changes: { time: "10:00" } } },
  { tool: "update_habit", input: { name: "Meditate", changes: { timeOfDay: "evening" } } },
  { tool: "update_tracker", input: { trackerName: "Weight", changes: { unit: "kg" } } },
  { tool: "update_tracker_entry", input: { trackerName: "Weight", values: { weight: 177 } } },
  { tool: "update_expense", input: { description: "Groceries at Safeway", changes: { amount: 45 } } },
  { tool: "update_obligation", input: { name: "Netflix", changes: { amount: 17.99 } } },
  { tool: "update_liability", input: { name: "Civic Auto Loan", changes: { currentBalance: 17500 } } },
  { tool: "update_goal", input: { title: "Lose 10 lbs", currentProgress: 178 } },
  { tool: "update_journal", input: { date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }), find: "Great", replace: "Wonderful" } },
  { tool: "update_artifact", input: { title: "Trip notes", changes: { pinned: true } } },
  { tool: "toggle_artifact_item", input: { title: "Packing list", itemText: "Passport" } },
  { tool: "duplicate_artifact", input: { title: "Packing list" } },
  { tool: "update_income", input: { description: "Acme salary", changes: { amount: 3300 } } },
  { tool: "update_budget", input: { budgetId: "Food", amount: 550 }, note: "category name, not id — executor resolves it" },
  { tool: "copy_budgets_previous_month", input: { month: "2026-09" } },
  { tool: "update_memory", input: { query: "seat-preference", newValue: "prefers aisle seats" } },
  { tool: "update_domain", input: { name: "Wine Cellar", changes: { description: "Wine collection tracking" } } },
  { tool: "manage_document", input: { action: "rename", documentName: "Home insurance policy", newName: "Home insurance 2026" } },
  { tool: "configure_dashboard_sections", input: { action: "hide", section: "Upcoming" } },
  { tool: "set_notification_preferences", input: { mute_severities: ["info"] } },
  { tool: "mark_notifications_read", input: { which: "all" } },
  { tool: "dismiss_notifications", input: { which: "all" } },
  { tool: "sync_calendar", input: {}, expect: "soft", note: "needs a connected Google account" },
  { tool: "revalue_asset", input: { profileName: "Honda Civic" }, expect: "soft", note: "needs live web search + Anthropic API" },
  { tool: "upload_document", input: { fileName: "receipt.pdf" }, verify: (res) => expect(res?.hint).toBe("attachment_button") },

  // ── Completions / check-ins ───────────────────────────────────────────
  { tool: "complete_task", input: { title: "Buy sweep milk" } },
  { tool: "bulk_complete_tasks", input: { filter: "all" } },
  { tool: "complete_event", input: { title: "Team offsite" } },
  { tool: "uncomplete_habit", input: { name: "Meditate" } },

  // ── Deletes & restores ────────────────────────────────────────────────
  { tool: "delete_tracker_entry", input: { trackerName: "Weight" } },
  { tool: "delete_task", input: { title: "Renew sweep passport" } },
  {
    tool: "restore_task", input: { title: "Renew sweep passport" },
    verify: async (res, { storage }) => {
      expect(res?.restored).toBe(true);
      const tasks = await storage.getTasks();
      expect(tasks.some(t => t.title === "Renew sweep passport")).toBe(true);
    },
  },
  { tool: "delete_habit", input: { name: "Meditate" } },
  { tool: "restore_habit", input: { name: "Meditate" }, verify: (res) => expect(res?.restored).toBe(true) },
  { tool: "delete_reminder", input: { title: "Sweep dentist appointment" } },
  { tool: "delete_event", input: { title: "Team offsite" } },
  { tool: "delete_expense", input: { description: "Groceries at Safeway" } },
  { tool: "delete_income", input: { description: "Acme salary" } },
  { tool: "delete_paycheck", input: { source: "Acme Corp" } },
  { tool: "delete_budget", input: { category: "Transport" } },
  { tool: "delete_obligation", input: { name: "Netflix" } },
  { tool: "delete_goal", input: { title: "Lose 10 lbs" } },
  { tool: "delete_journal", input: { date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) } },
  { tool: "delete_artifact", input: { title: "Packing list (copy)" } },
  { tool: "delete_memory", input: { query: "seat-preference" } },
  { tool: "delete_domain", input: { name: "Wine Cellar" } },
  { tool: "delete_tracker", input: { name: "Weight" } },
  { tool: "delete_profile", input: { name: "Max" } },

  // ── Undo via the real action ledger ───────────────────────────────────
  // (seeded through the envelope in its scenario below, exactly as a chat
  // turn would record it)
  {
    tool: "undo_last_action", input: {},
    verify: (res) => expect(res?.undone).toBe(true),
  },

  // ── Bulk / system flows ───────────────────────────────────────────────
  { tool: "preview_bulk_action", input: { entity_types: ["task"], name_contains: "sweep milk" } },
  { tool: "execute_bulk_action", input: { confirm: true } },
  { tool: "merge_profiles", input: { source_name: "Sarah Miller", target_name: "Bob Miller" } },
  { tool: "repair_relations", input: { confirm: true } },

  // ── Connected-finance tools (need Stripe-linked accounts) ─────────────
  { tool: "get_financial_summary", input: {}, expect: "soft" },
  { tool: "search_financial_transactions", input: {}, expect: "soft" },
  { tool: "get_spending_breakdown", input: {}, expect: "soft" },
  { tool: "get_account_balances", input: {}, expect: "soft" },
  { tool: "refresh_financial_data", input: { confirm: true }, expect: "soft" },
];

describe("AI executor sweep — every registered tool actually runs", () => {
  const storage = new MemStorage();
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await requestStorageContext.run(storage, async () => {
      // Loan schedules only enter the app through the Finance → Loans import
      // UI (deliberately not a chat tool), so seed one for the loan tools.
      await (storage as any).createLoanSchedule([
        { loan_id: "civic-loan", loan_name: "Civic Auto Loan", payment_number: 1, payment_date: "2026-09-01", principal: 260, interest: 90, total_payment: 350, remaining_balance: 17740, paid: false },
        { loan_id: "civic-loan", loan_name: "Civic Auto Loan", payment_number: 2, payment_date: "2026-10-01", principal: 262, interest: 88, total_payment: 350, remaining_balance: 17478, paid: false },
      ]);
    });
  });

  it("covers every tool in TOOL_DEFINITIONS (add a scenario when you add a tool)", () => {
    const covered = new Set(SCENARIOS.map(s => s.tool));
    const uncovered = TOOL_DEFINITIONS.map(t => t.name).filter(n => !covered.has(n));
    expect(uncovered, `Tools registered but never exercised: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("has no scenario for a tool that doesn't exist", () => {
    const registered = new Set(TOOL_DEFINITIONS.map(t => t.name));
    const stale = SCENARIOS.map(s => s.tool).filter(n => !registered.has(n));
    expect(stale, `Scenarios for unregistered tools: ${stale.join(", ")}`).toEqual([]);
  });

  for (const [i, sc] of SCENARIOS.entries()) {
    it(`${String(i + 1).padStart(3, "0")} ${sc.tool}${sc.note ? ` (${sc.note})` : ""}`, async () => {
      await requestStorageContext.run(storage, async () => {
        // Resolve profile-id placeholders captured from earlier creates.
        const input = JSON.parse(JSON.stringify(sc.input));
        for (const k of Object.keys(input)) {
          const m = typeof input[k] === "string" && input[k].match(/^__PROFILE_ID:(.+)__$/);
          if (m) input[k] = ids[m[1]] || `unresolved:${m[1]}`;
        }

        // undo_last_action needs a ledger row; record one through the real
        // envelope, the same way processMessage does after every write.
        if (sc.tool === "undo_last_action") {
          const seedInput = { title: "Sweep undo probe task" };
          const raw = await executeTool("create_task", seedInput, USER);
          expect(raw?.error).toBeUndefined();
          const ctx = buildTurnVerifyContext(storage);
          const envelope = await finalizeToolResult("create_task", "create_task", seedInput, raw, ctx);
          await recordActionLog(ctx, "create_task", "create_task", seedInput, envelope, null);
        }

        const res = await executeTool(sc.tool, input, USER);

        if (sc.expect === "soft") {
          // Allowed to report a structured error (external dependency), but a
          // throw or an empty result would still have failed above/below.
          expect(res).toBeTruthy();
        } else if (res && typeof res === "object") {
          expect(res.error, `${sc.tool} returned error: ${res.error}`).toBeUndefined();
        }

        // Capture profile ids for later placeholder resolution.
        if (sc.tool === "create_profile") {
          const id = res?.id || res?.profile?.id || res?.result?.id;
          if (id) ids[sc.input.name] = id;
        }
        if (sc.tool === "create_liability") {
          const id = res?.id || res?.liability?.id || res?.profile?.id || res?.result?.id;
          if (id) ids[`liability:${sc.input.name}`] = id;
        }

        await sc.verify?.(res, { storage, ids });
      });
    });
  }
});
