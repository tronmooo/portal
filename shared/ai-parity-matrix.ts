// ── AI ↔ Dashboard CRUD parity matrix ────────────────────────────────────────
// The single source of truth for "what can the AI chat do vs. what can the UI
// do". Every user-facing CRUD operation across the hub tabs (Executive /
// Trackers / Finance / Wellness / Assets / Liabilities / Calendar / Artifacts /
// Info) gets one row.
//
// Status semantics (machine-enforced by tests/ai-button-parity.test.ts):
//   "covered"  — the AI tool(s) exist in TOOL_DEFINITIONS today.        ✅
//   "added"    — tool(s) added by the 2026-07 parity effort; must exist. 🆕
//   "planned"  — tool(s) designed but NOT yet in the registry; the test
//                asserts they DON'T exist, so landing the tool forces the
//                status flip to "added" in the same commit.             🔜
//   "excluded" — deliberately NOT exposed to the AI; reason required.   🚫
//
// docs/ai-crud-parity.md is generated from this file by
// scripts/gen-ai-crud-parity.ts — regenerate after any change here.

export type ParityStatus = "covered" | "added" | "planned" | "excluded";

export interface ParityRow {
  /** Entity/domain, e.g. "Task", "Income", "Artifact". Groups the doc table. */
  entity: string;
  /** The operation as a user sees it, e.g. "Create", "Delete payment". */
  operation: string;
  /** Where the UI offers it (tab / popup / page). */
  ui: string;
  /** AI tool name(s) that achieve the same write from chat. Empty when excluded. */
  aiTools: string[];
  status: ParityStatus;
  /** Required for "excluded" rows — why the AI deliberately can't do this. */
  reason?: string;
}

export const PARITY_MATRIX: ParityRow[] = [
  // ── Tasks ──────────────────────────────────────────────────────────────────
  { entity: "Task", operation: "Create", ui: "Executive → Tasks popup / Quick-add", aiTools: ["create_task"], status: "covered" },
  { entity: "Task", operation: "Edit (title/description/due/priority)", ui: "Tasks popup row editor", aiTools: ["update_task"], status: "covered" },
  { entity: "Task", operation: "Complete", ui: "Tasks popup checkbox", aiTools: ["complete_task"], status: "covered" },
  { entity: "Task", operation: "Bulk complete", ui: "Tasks popup multi-select", aiTools: ["bulk_complete_tasks"], status: "covered" },
  { entity: "Task", operation: "Delete", ui: "Tasks popup row menu", aiTools: ["delete_task"], status: "covered" },
  { entity: "Task", operation: "Restore soft-deleted", ui: "Tasks popup undo toast", aiTools: ["restore_task"], status: "added" },
  // update_task passes tags through today but REPLACES the whole array — safe
  // additive tag ops (subtasks, recurrence, prio:critical) need the addTags /
  // removeTags merge extension (Batch C). Flips to "added" when that lands.
  { entity: "Task", operation: "Subtasks / recurrence / critical priority (tag-encoded)", ui: "Tasks popup composer + row editor", aiTools: ["update_task"], status: "added" },
  { entity: "Task", operation: "List / query", ui: "Tasks popup tabs", aiTools: ["query_tasks"], status: "covered" },

  // ── Habits ─────────────────────────────────────────────────────────────────
  { entity: "Habit", operation: "Create", ui: "Wellness → Habits popup", aiTools: ["create_habit"], status: "covered" },
  { entity: "Habit", operation: "Record one completion", ui: "Habits card + button / tap", aiTools: ["checkin_habit"], status: "covered" },
  { entity: "Habit", operation: "Record several completions at once (\"twice\")", ui: "Habits card + button, tapped repeatedly", aiTools: ["checkin_habit"], status: "added" },
  { entity: "Habit", operation: "Set today's total (\"I've only done it twice\")", ui: "Habits card − / + to the desired count", aiTools: ["checkin_habit"], status: "added" },
  { entity: "Habit", operation: "Undo one completion", ui: "Habits card − button", aiTools: ["uncomplete_habit"], status: "covered" },
  { entity: "Habit", operation: "Reset today's completions", ui: "Habits card row menu → Reset today", aiTools: ["uncomplete_habit"], status: "added" },
  { entity: "Habit", operation: "Change the daily target", ui: "Habits card target selector", aiTools: ["update_habit"], status: "added" },
  { entity: "Habit", operation: "Edit (rename/frequency/schedule)", ui: "Habits popup editor", aiTools: ["update_habit"], status: "covered" },
  { entity: "Habit", operation: "Delete", ui: "Habits popup row menu", aiTools: ["delete_habit"], status: "covered" },
  { entity: "Habit", operation: "Restore soft-deleted", ui: "Habits popup undo toast", aiTools: ["restore_habit"], status: "added" },

  // ── Trackers & entries ─────────────────────────────────────────────────────
  { entity: "Tracker", operation: "Create", ui: "Trackers tab → New tracker", aiTools: ["create_tracker"], status: "covered" },
  { entity: "Tracker", operation: "Rename / edit", ui: "Trackers tab card menu", aiTools: ["update_tracker"], status: "covered" },
  { entity: "Tracker", operation: "Delete", ui: "Trackers tab card menu", aiTools: ["delete_tracker"], status: "covered" },
  { entity: "Tracker entry", operation: "Log entry", ui: "Trackers tab / Wellness quick-log", aiTools: ["log_tracker_entry"], status: "covered" },
  { entity: "Tracker entry", operation: "Edit entry", ui: "Tracker detail entry row", aiTools: ["update_tracker_entry"], status: "covered" },
  { entity: "Tracker entry", operation: "Delete entry", ui: "Tracker detail entry row", aiTools: ["delete_tracker_entry"], status: "covered" },

  // ── Goals / projects ───────────────────────────────────────────────────────
  { entity: "Goal", operation: "Create", ui: "Executive → Projects / Goals section", aiTools: ["create_goal"], status: "covered" },
  { entity: "Goal", operation: "Update / progress / complete", ui: "Goals section editor", aiTools: ["update_goal"], status: "covered" },
  { entity: "Goal", operation: "Delete", ui: "Goals section row menu", aiTools: ["delete_goal"], status: "covered" },
  { entity: "Goal", operation: "Read progress", ui: "Goals section", aiTools: ["get_goal_progress"], status: "covered" },

  // ── Events / calendar ──────────────────────────────────────────────────────
  { entity: "Event", operation: "Create", ui: "Calendar tab / Quick-add", aiTools: ["create_event"], status: "covered" },
  { entity: "Event", operation: "Edit / reschedule", ui: "Calendar drag + editor", aiTools: ["update_event"], status: "covered" },
  { entity: "Event", operation: "Complete", ui: "Calendar item check", aiTools: ["complete_event"], status: "covered" },
  { entity: "Event", operation: "Delete", ui: "Calendar item menu", aiTools: ["delete_event"], status: "covered" },
  { entity: "Event", operation: "Query timeline", ui: "Calendar views / agenda", aiTools: ["query_calendar"], status: "covered" },
  { entity: "Event", operation: "Sync external calendar", ui: "Settings → Calendar sync", aiTools: ["sync_calendar"], status: "covered" },
  { entity: "Event", operation: "Export .ics file", ui: "Calendar item → Export", aiTools: [], status: "excluded", reason: "Browser file download — nothing for chat to return." },

  // ── Reminders ──────────────────────────────────────────────────────────────
  { entity: "Reminder", operation: "Create", ui: "Quick-add → Reminder", aiTools: ["create_reminder"], status: "covered" },
  { entity: "Reminder", operation: "Edit / move time", ui: "(no UI surface — chat only)", aiTools: ["update_reminder"], status: "added" },
  { entity: "Reminder", operation: "Delete", ui: "(no UI surface — chat only)", aiTools: ["delete_reminder"], status: "added" },

  // ── Expenses ───────────────────────────────────────────────────────────────
  { entity: "Expense", operation: "Create", ui: "Finance tab / Quick-add", aiTools: ["create_expense"], status: "covered" },
  { entity: "Expense", operation: "Edit", ui: "Finance expense row", aiTools: ["update_expense"], status: "covered" },
  { entity: "Expense", operation: "Delete", ui: "Finance expense row", aiTools: ["delete_expense"], status: "covered" },
  { entity: "Expense", operation: "Refund", ui: "Finance expense row menu", aiTools: ["refund_expense"], status: "covered" },
  { entity: "Expense", operation: "Query / analytics", ui: "Finance filters + charts", aiTools: ["query_expenses", "spending_analytics"], status: "covered" },
  { entity: "Expense", operation: "Convert to asset", ui: "Expense row → Convert", aiTools: ["convert_expense_to_asset"], status: "covered" },

  // ── Incomes ────────────────────────────────────────────────────────────────
  { entity: "Income", operation: "Create", ui: "Finance → Income / Cash-flow popup", aiTools: ["log_income"], status: "covered" },
  { entity: "Income", operation: "Edit", ui: "Finance income row", aiTools: ["update_income"], status: "added" },
  { entity: "Income", operation: "Delete", ui: "Finance income row", aiTools: ["delete_income"], status: "added" },

  // ── Paychecks ──────────────────────────────────────────────────────────────
  { entity: "Paycheck", operation: "Log expected", ui: "Finance → Paychecks", aiTools: ["log_expected_paycheck"], status: "covered" },
  { entity: "Paycheck", operation: "Confirm received (actual amount)", ui: "Paycheck row → Confirm", aiTools: ["confirm_paycheck_received"], status: "covered" },
  { entity: "Paycheck", operation: "Delete", ui: "Paycheck row menu", aiTools: ["delete_paycheck"], status: "added" },

  // ── Budgets ────────────────────────────────────────────────────────────────
  { entity: "Budget", operation: "Set / create category budget", ui: "Budget popup", aiTools: ["set_budget", "create_budget"], status: "covered" },
  { entity: "Budget", operation: "Edit amount", ui: "Budget popup row", aiTools: ["update_budget"], status: "covered" },
  { entity: "Budget", operation: "Delete", ui: "Budget popup row", aiTools: ["delete_budget"], status: "covered" },
  { entity: "Budget", operation: "Read summary", ui: "Budget popup / hero tile", aiTools: ["get_budget_summary"], status: "covered" },
  { entity: "Budget", operation: "Copy previous month", ui: "Budget popup → Copy last month", aiTools: ["copy_budgets_previous_month"], status: "added" },

  // ── Obligations / bills ────────────────────────────────────────────────────
  { entity: "Bill", operation: "Create", ui: "Liabilities tab / Quick-add → Bill", aiTools: ["create_obligation"], status: "covered" },
  { entity: "Bill", operation: "Edit (name/amount/frequency/due)", ui: "Bill row editor", aiTools: ["update_obligation"], status: "covered" },
  { entity: "Bill", operation: "Delete", ui: "Bill row menu", aiTools: ["delete_obligation"], status: "covered" },
  { entity: "Bill", operation: "Pay (record payment)", ui: "Bill row → Pay", aiTools: ["pay_obligation"], status: "covered" },
  { entity: "Bill", operation: "Undo last payment", ui: "Bill row → Undo payment", aiTools: ["undo_last_payment"], status: "added" },
  { entity: "Bill", operation: "Pay a specific occurrence (by month/date)", ui: "Bill schedule occurrence row → Pay", aiTools: ["pay_obligation"], status: "covered" },
  { entity: "Bill", operation: "Skip an occurrence", ui: "Bill schedule occurrence row → Skip", aiTools: ["update_obligation"], status: "covered" },
  { entity: "Bill", operation: "Pause / resume schedule", ui: "Bill schedule header toggle", aiTools: ["update_obligation"], status: "covered" },
  // Batch B: update_obligation gained occurrenceDate/rescheduleTo/
  // occurrenceAmount/occurrenceNotes params wired to rescheduleOccurrence and
  // setOccurrenceFields.
  { entity: "Bill", operation: "Reschedule an occurrence / override its amount", ui: "Bill schedule occurrence row → Edit", aiTools: ["update_obligation"], status: "added" },

  // ── Liabilities (loans / mortgages) ────────────────────────────────────────
  { entity: "Liability", operation: "Create", ui: "Liabilities tab / Net-worth popup", aiTools: ["create_liability"], status: "covered" },
  { entity: "Liability", operation: "Edit (balance/rate/terms)", ui: "Liability detail page", aiTools: ["update_liability"], status: "covered" },
  { entity: "Liability", operation: "Delete", ui: "Liability detail → Delete", aiTools: ["delete_profile"], status: "covered" },
  { entity: "Liability", operation: "Record payment", ui: "Liability detail → Add payment", aiTools: ["add_liability_payment"], status: "covered" },
  { entity: "Liability", operation: "Edit a recorded payment", ui: "Liability payments list", aiTools: ["update_liability_payment"], status: "added" },
  { entity: "Liability", operation: "Delete a recorded payment", ui: "Liability payments list", aiTools: ["delete_liability_payment"], status: "added" },
  { entity: "Liability", operation: "Read summary / payoff", ui: "Liability detail header", aiTools: ["get_liability_summary"], status: "covered" },
  { entity: "Loan", operation: "Read amortization schedule", ui: "Finance → Loans", aiTools: ["get_loan_schedule"], status: "covered" },
  { entity: "Loan", operation: "Mark scheduled payment paid", ui: "Loan schedule row → Mark paid", aiTools: ["mark_loan_payment"], status: "added" },
  { entity: "Loan", operation: "Create amortization schedule (bulk rows)", ui: "Finance → Loans import", aiTools: [], status: "excluded", reason: "Bulk tabular input — an import concern, not a chat command." },

  // ── Assets / net worth / profiles ──────────────────────────────────────────
  { entity: "Profile", operation: "Create (person/pet/asset/vehicle/property/subscription)", ui: "Info tab / Net-worth popup → Add", aiTools: ["create_profile"], status: "covered" },
  { entity: "Profile", operation: "Edit fields / rename / notes", ui: "Profile Info editor", aiTools: ["update_profile"], status: "covered" },
  { entity: "Profile", operation: "Delete", ui: "Profile menu → Delete", aiTools: ["delete_profile"], status: "covered" },
  { entity: "Profile", operation: "Read profile data", ui: "Info tab", aiTools: ["get_profile_data"], status: "covered" },
  { entity: "Profile", operation: "Upload photo/avatar", ui: "Profile header → camera", aiTools: [], status: "excluded", reason: "Binary image upload — not expressible as a chat command." },
  { entity: "Asset", operation: "Revalue", ui: "Asset detail → Update value", aiTools: ["revalue_asset"], status: "covered" },
  { entity: "Asset", operation: "Link owner / split ownership", ui: "Asset detail → Ownership", aiTools: ["link_asset_owner", "split_ownership"], status: "covered" },
  { entity: "Asset", operation: "Link / unlink liability", ui: "Asset & liability detail pages", aiTools: ["link_liability_asset", "link_asset_to_liability", "unlink_asset_from_liability"], status: "covered" },
  { entity: "Asset", operation: "Move liability to another asset", ui: "Liability detail → Move", aiTools: ["move_liability_to_asset"], status: "covered" },
  { entity: "Asset", operation: "Read rollup / relationships", ui: "Assets tab / Net-worth popup", aiTools: ["get_asset_rollup", "get_relationships", "get_related"], status: "covered" },
  { entity: "Asset", operation: "Generic entity link", ui: "Profile → Link entity", aiTools: ["link_entities"], status: "covered" },
  { entity: "Net worth", operation: "Read history / cashflow", ui: "Hero KPIs + popups", aiTools: ["query_net_worth_history", "get_cashflow"], status: "covered" },

  // ── Documents ──────────────────────────────────────────────────────────────
  { entity: "Document", operation: "Create (note/record)", ui: "Documents section → New", aiTools: ["create_document"], status: "covered" },
  { entity: "Document", operation: "Upload file (via chat attachment)", ui: "Documents → Upload", aiTools: ["upload_document"], status: "covered" },
  { entity: "Document", operation: "Rename / link / move / unlink / delete / re-extract", ui: "Document viewer menu", aiTools: ["manage_document"], status: "covered" },
  { entity: "Document", operation: "Search / open / retrieve", ui: "Documents list + search", aiTools: ["search_documents", "open_document", "retrieve_document"], status: "covered" },
  { entity: "Document", operation: "Email document out", ui: "Document viewer → Email", aiTools: [], status: "excluded", reason: "Sends content to an external recipient — outward-facing action kept behind an explicit UI click." },
  { entity: "Document", operation: "Replace file binary", ui: "Document viewer → Replace", aiTools: [], status: "excluded", reason: "Binary file upload — not expressible as a chat command." },

  // ── Journal ────────────────────────────────────────────────────────────────
  { entity: "Journal", operation: "Create entry", ui: "Journal page / Quick-add note", aiTools: ["journal_entry"], status: "covered" },
  { entity: "Journal", operation: "Edit entry", ui: "Journal entry editor", aiTools: ["update_journal"], status: "covered" },
  { entity: "Journal", operation: "Delete entry", ui: "Journal entry menu", aiTools: ["delete_journal"], status: "covered" },

  // ── Memories (AI facts) ────────────────────────────────────────────────────
  { entity: "Memory", operation: "Save", ui: "(chat-first) Info tab shows saved facts", aiTools: ["save_memory"], status: "covered" },
  { entity: "Memory", operation: "Recall", ui: "Info tab facts list", aiTools: ["recall_memory"], status: "covered" },
  { entity: "Memory", operation: "Edit value", ui: "Info tab fact row editor", aiTools: ["update_memory"], status: "added" },
  { entity: "Memory", operation: "Delete", ui: "Info tab fact row menu", aiTools: ["delete_memory"], status: "covered" },

  // ── Artifacts ──────────────────────────────────────────────────────────────
  { entity: "Artifact", operation: "Create (list/note/doc)", ui: "Artifacts tab → New", aiTools: ["create_artifact"], status: "covered" },
  { entity: "Artifact", operation: "Edit content", ui: "Artifact editor", aiTools: ["update_artifact"], status: "covered" },
  { entity: "Artifact", operation: "Delete", ui: "Artifact card menu", aiTools: ["delete_artifact"], status: "covered" },
  // Handler + storage already pass `pinned` through — only the tool's schema
  // description omits it. Batch D adds the schema text; flips to "added".
  { entity: "Artifact", operation: "Pin / unpin", ui: "Artifact card pin toggle", aiTools: ["update_artifact"], status: "added" },
  { entity: "Artifact", operation: "Duplicate", ui: "Artifact card menu → Duplicate", aiTools: ["duplicate_artifact"], status: "added" },
  { entity: "Artifact", operation: "Toggle checklist item", ui: "Artifact checklist checkbox", aiTools: ["toggle_artifact_item"], status: "added" },
  { entity: "Artifact", operation: "Share / unshare public link", ui: "Artifact menu → Share", aiTools: [], status: "excluded", reason: "Publishes content at a public URL — outward-facing action kept behind an explicit UI click." },

  // ── Notifications ──────────────────────────────────────────────────────────
  { entity: "Notification", operation: "Dismiss one / all", ui: "Notification bell", aiTools: ["dismiss_notifications"], status: "added" },

  // ── Custom domains ─────────────────────────────────────────────────────────
  { entity: "Domain", operation: "Create / update / delete", ui: "Custom domain manager", aiTools: ["create_domain", "update_domain", "delete_domain"], status: "covered" },

  // ── Reporting / meta (read-only, for completeness) ─────────────────────────
  { entity: "Reporting", operation: "Charts / tables / reports", ui: "Chat-rendered outputs", aiTools: ["generate_chart", "generate_table", "generate_report"], status: "covered" },
  { entity: "Reporting", operation: "Refresh AI summary", ui: "Executive → AI summary", aiTools: ["refresh_ai_summary"], status: "covered" },
  { entity: "Meta", operation: "Global search / summary / navigation / action history", ui: "Search bar / nav", aiTools: ["search", "get_summary", "navigate", "recall_actions"], status: "covered" },
  { entity: "Meta", operation: "Undo last action", ui: "Chat action-card Undo button", aiTools: ["undo_last_action"], status: "added" },
  { entity: "Meta", operation: "Record change history / audit trail", ui: "(chat-first) activity feed", aiTools: ["get_entity_history"], status: "added" },
  { entity: "Meta", operation: "Bulk delete (preview → confirm → execute)", ui: "(chat-first) multi-select delete", aiTools: ["preview_bulk_action", "execute_bulk_action"], status: "added" },
  { entity: "System", operation: "Merge duplicate profiles (preview → confirm)", ui: "(chat-first) profile cleanup", aiTools: ["merge_profiles", "execute_bulk_action"], status: "added" },
  { entity: "System", operation: "Orphan scan + repair", ui: "Settings → data health", aiTools: ["find_orphans", "repair_relations"], status: "added" },
  { entity: "System", operation: "Profile-isolation validation", ui: "(chat-first) data health", aiTools: ["validate_profile_isolation"], status: "added" },
  { entity: "System", operation: "Duplicate detection", ui: "(chat-first) data health", aiTools: ["find_duplicates"], status: "added" },
  { entity: "System", operation: "Dashboard refresh + count validation", ui: "Dashboard reload", aiTools: ["refresh_dashboard", "validate_dashboard_counts"], status: "added" },
  { entity: "System", operation: "Explain dashboard placement", ui: "(chat-first) section rules", aiTools: ["explain_dashboard_item"], status: "added" },
  { entity: "Notification", operation: "Create custom notification", ui: "(chat-first) bell entries", aiTools: ["create_notification"], status: "added" },
  { entity: "Notification", operation: "Mark read / mute preferences", ui: "Notification bell", aiTools: ["mark_notifications_read", "set_notification_preferences"], status: "added" },
  { entity: "Medication", operation: "Log / skip doses", ui: "Health → medication tracker entries", aiTools: ["log_medication_dose", "skip_medication_dose"], status: "added" },
  { entity: "Medication", operation: "Adherence / dose history", ui: "Health → medication tracker", aiTools: ["get_missed_doses", "get_dose_history"], status: "added" },
  { entity: "Document", operation: "Link to profile/asset", ui: "Document card → link", aiTools: ["link_document"], status: "added" },

  // ── App-level operations excluded by design ────────────────────────────────
  { entity: "Settings", operation: "Customize dashboard layout", ui: "Dashboard → Customize", aiTools: ["configure_dashboard_sections"], status: "added" },
  { entity: "Settings", operation: "Bank-CSV / ChatGPT finance import", ui: "Settings + dashboard import dialogs", aiTools: [], status: "excluded", reason: "Multi-step file/preview/commit import flows — chat handles individual records instead." },
  { entity: "Settings", operation: "Full data export / import", ui: "Dashboard menu", aiTools: [], status: "excluded", reason: "Whole-account file transfer — kept behind explicit UI actions." },
  { entity: "Settings", operation: "Delete ALL data", ui: "Settings → Danger zone", aiTools: [], status: "excluded", reason: "Catastrophic destructive action — must never be reachable through a chat message." },
  { entity: "Settings", operation: "Auth / onboarding / password", ui: "Sign-in + settings", aiTools: [], status: "excluded", reason: "Security-sensitive account management." },
];

/** Rows that map to at least one AI tool (i.e. everything not excluded). */
export const NON_EXCLUDED_ROWS = PARITY_MATRIX.filter((r) => r.status !== "excluded");
