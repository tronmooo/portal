// ─── Read/write classification of AI tools ──────────────────────────────────
//
// THE single answer to "does this tool write user data?". Four copies of this
// list used to live across ai-engine.ts and routes.ts, kept in sync by a
// comment ("Kept in lockstep with…") — the exact manual-sync trap this module
// removes. tests/ai-tool-registry.test.ts machine-checks it against the tool
// registry: every tool is either here or carries a typed write action.
//
// A read-only tool skips the whole write contract: no envelope, no undo-ledger
// row, no change manifest, no cache bust, no context-cache invalidation.
// Misclassifying a write as a read makes its changes invisible to the client
// until an unrelated refetch; misclassifying a read as a write cold-starts
// caches for nothing. When in doubt, leave the tool OUT of this set — a
// pointless bust is cheaper than an invisible write.

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set<string>([
  "search", "get_summary", "get_profile_data", "recall_actions", "get_goal_progress",
  "get_related", "get_relationships", "get_liability_summary", "get_cashflow",
  "get_budget_summary", "query_net_worth_history", "get_loan_schedule", "query_calendar",
  "query_expenses", "query_tasks", "spending_analytics", "get_asset_rollup",
  "search_documents", "retrieve_document", "open_document", "navigate", "set_dashboard_scope",
  "generate_chart", "generate_table", "generate_report", "refresh_ai_summary",
  "get_entity_history",
  // recall_memory READS the memory store (save_memory/update_memory are the
  // writers). It was present in one of the four merged lists and absent from
  // the others — the exact drift this module ends.
  "recall_memory",
  // System diagnostics — find/validate/explain are pure reads;
  // refresh_dashboard mutates only server caches (no user data), so it is
  // deliberately here too: no envelope, no undo-ledger row to trip "undo that".
  "find_orphans", "validate_profile_isolation", "find_duplicates",
  "validate_dashboard_counts", "explain_dashboard_item", "refresh_dashboard",
  "get_missed_doses", "get_dose_history",
  // Notes lookup, and the temporal re-derivation. `sync_date_rules_for_entity`
  // writes nothing — Date Rules are derived from the canonical record, so
  // "syncing" is a read that reports what the record now projects.
  "search_notes", "sync_date_rules_for_entity",
  // Connected bank data (Stripe Financial Connections). These four are pure
  // reads over the authenticated user's own financial_* rows.
  // `refresh_financial_data` is deliberately NOT here — it is an action that
  // calls out to the institution, so it carries a typed action.
  "get_financial_summary", "search_financial_transactions",
  "get_spending_breakdown", "get_account_balances",
  // Manual accounts — a pure read over the user's own account profiles.
  "get_accounts",
]);

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

/**
 * ParsedAction types that never indicate a write — the chat route uses this
 * as a fallback signal for "did this turn mutate anything?" when a turn
 * produced no mutation manifest.
 */
export const READ_ONLY_ACTION_TYPES: ReadonlySet<string> = new Set<string>([
  "retrieve", "navigate", "set_dashboard_scope",
]);
