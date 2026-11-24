// What the migrations in /migrations add, and therefore what the code may
// rely on finding in the database.
//
// WHY: twice a migration was merged and never run against production.
// 2026-11-09: 20260922 (ai_action_log.turn_id …) — two months of chat actions
// went unrecorded. 2026-11-24: its sibling 20260922_tracker_linked_habit and
// 20261115_auth_rate_limits were found missing the same way — a deleted habit
// left its tracker on the Trackers page, and the shared sign-in rate limit
// was not in force. Each time the code "degraded safely", so nothing failed
// loudly and nobody knew.
//
// GET /api/diagnostics/schema probes the database for every entry here and
// names what is missing. `npx tsx tests/live-schema-drift-check.ts` asserts
// production is missing nothing; run it after applying a migration and after
// a deploy. tests/schema-expectations.test.ts fails when a migration adds a
// column or table that is not listed here (or retired below with a reason).

export interface ExpectedColumn { table: string; column: string; migration: string }
export interface ExpectedTable { table: string; migration: string }

export const EXPECTED_COLUMNS: ExpectedColumn[] = [
  { table: "ai_action_log", column: "operation_id", migration: "20260922_ai_operation_ids_and_chat_runs.sql" },
  { table: "ai_action_log", column: "request_id", migration: "20260922_ai_operation_ids_and_chat_runs.sql" },
  { table: "ai_action_log", column: "turn_id", migration: "20260922_ai_operation_ids_and_chat_runs.sql" },
  { table: "artifacts", column: "metadata", migration: "002_artifact_types.sql" },
  { table: "documents", column: "deleted_at", migration: "006_zero_trust_rls.sql" },
  { table: "documents", column: "storage_path", migration: "006_zero_trust_rls.sql" },
  { table: "habits", column: "end_date", migration: "20260809_habit_window.sql" },
  { table: "habits", column: "linked_tracker_id", migration: "20260820_habit_linked_tracker.sql" },
  { table: "habits", column: "owner_profile_id", migration: "20260902_habit_owner_scoped_names.sql" },
  { table: "habits", column: "scheduled_time", migration: "20260707_habit_schedule.sql" },
  { table: "habits", column: "start_date", migration: "20260809_habit_window.sql" },
  { table: "habits", column: "time_of_day", migration: "20260707_habit_schedule.sql" },
  { table: "journal_entries", column: "title", migration: "20261120_journal_many_per_day_and_title.sql" },
  { table: "tasks", column: "due_time", migration: "20260809_reminders_to_timed_tasks.sql" },
  { table: "trackers", column: "linked_habit_id", migration: "20260922_tracker_linked_habit.sql" },
  { table: "trackers", column: "metric_definition", migration: "20260611_tracker_metric_definition.sql" },
  { table: "trackers", column: "owner_profile_id", migration: "20260824_tracker_owner_scoped_names.sql" },
  { table: "user_data_versions", column: "domains", migration: "20260825_user_domain_versions.sql" },
];

export const EXPECTED_TABLES: ExpectedTable[] = [
  { table: "ai_action_log", migration: "20260711_ai_action_log.sql" },
  { table: "ai_bulk_plans", migration: "20260711_ai_bulk_plans.sql" },
  { table: "ai_chat_runs", migration: "20260922_ai_operation_ids_and_chat_runs.sql" },
  { table: "asset_party_links", migration: "005_relationships_module.sql" },
  { table: "auth_rate_limits", migration: "20261115_auth_rate_limits.sql" },
  { table: "captures", migration: "20260615_captures.sql" },
  { table: "finance_imports", migration: "20260626_finance_imports.sql" },
  { table: "finance_sync_runs", migration: "20260805_stripe_financial_connections.sql" },
  { table: "finance_webhook_events", migration: "20260805_stripe_financial_connections.sql" },
  { table: "financial_accounts", migration: "20260805_stripe_financial_connections.sql" },
  { table: "financial_connections", migration: "20260805_stripe_financial_connections.sql" },
  { table: "financial_transaction_overrides", migration: "20260805_stripe_financial_connections.sql" },
  { table: "financial_transactions", migration: "20260805_stripe_financial_connections.sql" },
  { table: "financial_transfer_links", migration: "20260805_stripe_financial_connections.sql" },
  { table: "liability_asset_links", migration: "004_liabilities_module.sql" },
  { table: "liability_payments", migration: "004_liabilities_module.sql" },
  { table: "liability_profile_links", migration: "004_liabilities_module.sql" },
  { table: "net_worth_snapshots", migration: "20260604_net_worth_snapshots.sql" },
  { table: "ownership_history", migration: "005_relationships_module.sql" },
  { table: "response_cache", migration: "20260731_response_cache.sql" },
  { table: "stripe_account_holders", migration: "20260805_stripe_financial_connections.sql" },
  { table: "user_data_versions", migration: "010_user_data_versions.sql" },
  { table: "user_notifications", migration: "20260711_user_notifications.sql" },
];

/** Tables a migration created that are deliberately not in the database now. */
export const RETIRED_TABLES: Record<string, string> = {
  reminders: "dropped by 20260809_reminders_to_timed_tasks.sql (reminders became timed tasks)",
  entity_link_rules: "linkage v2 (20260511) was never rolled out; no server code reads it",
  entity_links_v2: "linkage v2 (20260511) was never rolled out; no server code reads it",
  entity_links_v2_backfill_rejects: "linkage v2 (20260511) was never rolled out; no server code reads it",
};

export interface SchemaGap { kind: "column" | "table"; table: string; column?: string; migration: string }

/** Postgres / PostgREST saying the table or column is not there (as opposed
 *  to "you may not read it", which proves it exists). */
export function isMissingSchemaError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = String(error.code || "");
  if (["PGRST204", "PGRST205", "42703", "42P01"].includes(code)) return true;
  return /could not find the (table|'.*' column)|column .* does not exist|relation .* does not exist/i.test(String(error.message || ""));
}

/** The migrations' statements, as (table, column) and created tables. Shared
 *  by the guard test; kept here so the parsing has one definition. */
export function parseMigrationSchema(sql: string): { columns: Array<{ table: string; column: string }>; tables: string[] } {
  const src = sql.replace(/--[^\n]*/g, "");
  const columns: Array<{ table: string; column: string }> = [];
  const alter = /ALTER TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+([\s\S]*?);/gi;
  for (let m; (m = alter.exec(src)); ) {
    const add = /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?/gi;
    for (let c; (c = add.exec(m[2])); ) columns.push({ table: m[1].toLowerCase(), column: c[1].toLowerCase() });
  }
  const tables: string[] = [];
  const create = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?"?(\w+)"?/gi;
  for (let m; (m = create.exec(src)); ) tables.push(m[1].toLowerCase());
  return { columns, tables };
}
