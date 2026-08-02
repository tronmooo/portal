// shared/cache-domains.ts
//
// ONE map from "which AI tool ran" to "which cached data it invalidates",
// shared by the server (which stamps it onto the SSE stream) and the client
// (which acts on it).
//
// WHY IT EXISTS
// -------------
// A chat turn commits its writes seconds before the model finishes talking —
// the `tool_result` frame is emitted the instant `storage.createTracker()`
// returns. The client used to ignore those frames entirely and, at the END of
// the turn, invalidate EVERY `/api/*` query with a blanket predicate. That is
// both too late (nothing refreshes while the reply streams) and too broad (one
// `create_task` refetched calendar, finance, documents, profiles and insights).
//
// With this map the client refreshes exactly the domains a tool touched, the
// moment that tool lands.
//
// THE RULE FOR NEW TOOLS
// ----------------------
// Every write tool needs an entry. `tests/chat-domain-map.test.ts` fails the
// build when a tool in TOOL_ACTION_MAP has no mapping, so a new tool cannot
// silently under-invalidate — the failure mode being prevented is the one the
// user reported on 2026-08-02: a write lands, nothing on screen knows, and the
// only fix is reloading the whole app.
//
// When unsure, map to ["everything"]. Over-invalidating costs a few requests;
// under-invalidating shows the user stale data and makes them refresh.

/** A logical category of cached data. The cache bus expands each to its keys. */
export type Domain =
  | "tasks"
  | "habits"
  | "trackers"
  | "profiles"
  | "assets"
  | "liabilities"
  | "people"
  | "documents"
  | "expenses"
  | "incomes"
  | "obligations"
  | "budgets"
  | "goals"
  | "events"
  | "journal"
  | "notifications"
  | "reminders"
  | "artifacts"
  | "domains"
  | "preferences"
  | "dashboard"   // KPI tiles + dashboard-enhanced + stats
  | "everything"; // nuclear — anything unmapped, or a tool that can touch all

/** Ownership/link edits move records between people, so they touch all three. */
const LINK_DOMAINS: Domain[] = ["assets", "liabilities", "profiles"];

export const TOOL_DOMAIN_MAP: Record<string, Domain[]> = {
  // Reads that still carry a ParsedAction — nothing cached changed.
  recall_memory: [],
  preview_bulk_action: [],
  save_memory: [],
  update_memory: [],
  delete_memory: [],

  // Profiles / assets
  create_profile: ["profiles"],
  update_profile: ["profiles"],
  delete_profile: ["profiles"],
  merge_profiles: ["profiles", "people", "assets", "liabilities"],
  revalue_asset: ["assets"],
  convert_expense_to_asset: ["assets", "expenses"],
  repair_relations: ["profiles", "people"],

  // Tasks
  create_task: ["tasks"],
  update_task: ["tasks"],
  complete_task: ["tasks"],
  bulk_complete_tasks: ["tasks"],
  delete_task: ["tasks"],
  restore_task: ["tasks"],

  // Habits
  create_habit: ["habits"],
  checkin_habit: ["habits"],
  uncomplete_habit: ["habits"],
  update_habit: ["habits"],
  delete_habit: ["habits"],
  restore_habit: ["habits"],

  // Anything-goes tools — these can rewrite any domain, so they say so.
  undo_last_action: ["everything"],
  execute_bulk_action: ["everything"],

  // Notifications / reminders / preferences
  create_notification: ["notifications"],
  mark_notifications_read: ["notifications"],
  dismiss_notifications: ["notifications"],
  set_notification_preferences: ["notifications", "preferences"],
  configure_dashboard_sections: ["preferences", "dashboard"],
  create_reminder: ["reminders"],
  update_reminder: ["reminders"],
  delete_reminder: ["reminders"],

  // Trackers
  create_tracker: ["trackers"],
  update_tracker: ["trackers"],
  delete_tracker: ["trackers"],
  log_tracker_entry: ["trackers"],
  delete_tracker_entry: ["trackers"],
  update_tracker_entry: ["trackers"],
  log_medication_dose: ["trackers"],
  skip_medication_dose: ["trackers"],

  // Expenses / income / paychecks
  create_expense: ["expenses"],
  update_expense: ["expenses"],
  delete_expense: ["expenses"],
  refund_expense: ["expenses"],
  log_income: ["incomes"],
  update_income: ["incomes"],
  delete_income: ["incomes"],
  log_expected_paycheck: ["incomes"],
  confirm_paycheck_received: ["incomes"],
  delete_paycheck: ["incomes"],

  // Budgets
  create_budget: ["budgets"],
  set_budget: ["budgets"],
  update_budget: ["budgets"],
  delete_budget: ["budgets"],
  copy_budgets_previous_month: ["budgets"],

  // Liabilities / ownership links
  create_liability: ["liabilities"],
  update_liability: ["liabilities"],
  add_liability_payment: ["liabilities", "obligations"],
  update_liability_payment: ["liabilities", "obligations"],
  delete_liability_payment: ["liabilities", "obligations"],
  move_liability_to_asset: LINK_DOMAINS,
  link_liability_asset: LINK_DOMAINS,
  link_liability_owner: LINK_DOMAINS,
  link_asset_to_liability: LINK_DOMAINS,
  unlink_asset_from_liability: LINK_DOMAINS,
  link_asset_owner: LINK_DOMAINS,
  split_ownership: LINK_DOMAINS,
  link_entities: LINK_DOMAINS,

  // Events / calendar
  create_event: ["events"],
  update_event: ["events"],
  delete_event: ["events"],
  complete_event: ["events"],
  sync_calendar: ["events"],
  schedule_medication_refills: ["events", "trackers"],

  // Obligations
  create_obligation: ["obligations"],
  pay_obligation: ["obligations"],
  update_obligation: ["obligations"],
  delete_obligation: ["obligations"],
  mark_loan_payment: ["obligations", "liabilities"],
  undo_last_payment: ["obligations", "liabilities"],

  // Journal
  journal_entry: ["journal"],
  update_journal: ["journal"],
  delete_journal: ["journal"],

  // Goals
  create_goal: ["goals"],
  update_goal: ["goals"],
  delete_goal: ["goals"],

  // Artifacts / notes
  create_artifact: ["artifacts"],
  update_artifact: ["artifacts"],
  delete_artifact: ["artifacts"],
  duplicate_artifact: ["artifacts"],
  toggle_artifact_item: ["artifacts"],

  // Documents
  create_document: ["documents"],
  upload_document: ["documents"],
  manage_document: ["documents"],
  link_document: ["documents", "profiles"],

  // Custom field schemas — they render on profiles.
  create_domain: ["domains", "profiles"],
  update_domain: ["domains", "profiles"],
  delete_domain: ["domains", "profiles"],
};

/**
 * The domains a finished tool call invalidates.
 *
 * `null` means "this tool is not in the map" — the caller decides. The server
 * turns that into `["everything"]` for a write tool and `[]` for a read-only
 * one, because only the server knows which is which (READ_ONLY_TOOLS).
 */
export function domainsForTool(toolName: string): Domain[] | null {
  const hit = TOOL_DOMAIN_MAP[toolName];
  return hit ? hit : null;
}
