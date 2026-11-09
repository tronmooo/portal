// What a chat action card says: the action that ran and the record it ran on.
//
// The server reduces ~110 write tools to ~30 action types, and about a third
// of the tools land in three generic buckets. Their cards read "UPDATE ENTITY
// / Update Entity", "LINK ENTITIES / Link Entities" — a profile merge showed
// as "DELETE ENTITY" — and named no record, because the card only looked for
// `title` / `name` / `description` while these tools call their target
// `liabilityName`, `billName`, `profileName`, … (2026-11-09 sweep of every
// chat tool). The server now stamps the tool on the action (`_tool`); this
// module turns it, and the tool's own input, into words.
//
// Pure, shared by the chat page and the tests.

/** Action types that say nothing about what happened. */
export const GENERIC_ACTION_TYPES = new Set([
  "update_entity", "delete_entity", "link_entities", "set_budget",
  "manage_document", "manage_domain", "revalue_asset", "log_paycheck", "retrieve",
]);

/** Tool names that do not read as a sentence when humanised. */
const LABEL_OVERRIDES: Record<string, string> = {
  preview_bulk_action: "Bulk change preview",
  execute_bulk_action: "Bulk change applied",
  undo_last_action: "Undo",
  undo_last_payment: "Undo payment",
  refresh_financial_data: "Refresh bank data",
  configure_dashboard_sections: "Dashboard layout",
  set_notification_preferences: "Notification settings",
  mark_notifications_read: "Mark notifications read",
  copy_budgets_previous_month: "Copy last month's budgets",
  log_expected_paycheck: "Expected paycheck",
  confirm_paycheck_received: "Paycheck received",
  convert_expense_to_asset: "Convert expense to asset",
  toggle_artifact_item: "Check off item",
  repair_relations: "Repair links",
  repair_profile_types: "Repair profile types",
  sync_calendar: "Sync calendar",
  link_entities: "Link records",
  manage_document: "Update document",
  upload_document: "Upload document",
};

/** "unlink_asset_from_liability" → "Unlink asset from liability". */
export function toolCardLabel(tool: unknown): string | null {
  if (typeof tool !== "string" || !/^[a-z][a-z0-9_]*$/.test(tool)) return null;
  if (LABEL_OVERRIDES[tool]) return LABEL_OVERRIDES[tool];
  const words = tool.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The label for a card: the specific tool when the action type is one of the
 * generic buckets, otherwise null (the page's own typed label stands).
 */
export function genericActionLabel(type: string, data: unknown): string | null {
  if (!GENERIC_ACTION_TYPES.has(type)) return null;
  return toolCardLabel((data as { _tool?: unknown } | null | undefined)?._tool);
}

// In reading order: the record's own name first, then the names tools give
// the record they act on, then the looser descriptors.
const SUBJECT_KEYS = [
  "title", "name", "description", "content",
  "liabilityName", "billName", "loanName", "assetName", "subjectName",
  "documentName", "trackerName", "medicationName", "habitName", "expenseDescription", "profileName",
  "source", "section", "category", "key", "itemText", "query", "which", "date",
] as const;

const clip = (v: string, max = 80): string => {
  const one = v.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** The record a card is about, from the tool's input. "" when it names none. */
export function actionCardSubject(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  // Two-sided tools read as "A → B".
  const pair = (a: string, b: string): string | null =>
    typeof d[a] === "string" && d[a] && typeof d[b] === "string" && d[b] ? `${clip(String(d[a]), 40)} → ${clip(String(d[b]), 40)}` : null;
  const two = pair("source_name", "target_name") || pair("fromAssetName", "toAssetName");
  if (two) return two;
  for (const key of SUBJECT_KEYS) {
    const v = d[key];
    if (typeof v === "string" && v.trim()) return clip(v);
  }
  return "";
}
