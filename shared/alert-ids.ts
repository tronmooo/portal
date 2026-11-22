// shared/alert-ids.ts — one identity for a dated alert, whatever shape it takes.
// =============================================================================
//
// OWNER REPORT (2026-11-22): "I dismissed the Home Depot expiration and it came
// back."
//
// One expired document reaches the dashboard in two shapes: a DOCUMENT row
// ("Home Depot Purchase — Expiration", from enhanced.expiringDocuments) and an
// ALERT row ("Expired: Home Depot Purchase", from /api/notifications). Each had
// its own dismiss store under its own key — the document row a 30-day
// localStorage snooze keyed on the rule id, the alert a server preference keyed
// on the notification id — so hiding one shape let the other take its place.
//
// Both shapes describe the same fact: this date, at this field, on this record.
// This module is the one spelling of that fact. The notification service builds
// its id here, the document rows derive the same id here, and every dismissal
// is stored under it in the `dismissed_notifications` preference (server-side,
// so it follows the user across devices and never lapses on its own).
//
// The DATE is part of the id on purpose (D244): a dismissal is of one fact. A
// renewed document carries a new date, so its alert is new again.

export interface DateAlertSource {
  /** "document" or "profile" — what record carries the date. */
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  /** The field's path (nested dates) or, for a top-level field, its key. */
  path?: string | null;
  /** The rule's ISO day. */
  date?: string | null;
}

/** The id of the alert a dated field raises. Empty when the row is unidentifiable. */
export function dateAlertId(src: DateAlertSource): string {
  const entity = String(src.sourceEntityId ?? "").trim();
  const path = String(src.path ?? "").trim();
  const date = String(src.date ?? "").trim();
  if (!entity || !path || !date) return "";
  const kind = src.sourceEntityType === "document" ? "doc" : "profile";
  return `${kind}-exp-${entity}-${path}-${date}`;
}

/** The same id, read off an `enhanced.expiringDocuments` row. */
export function alertIdOfDateRow(row: any): string {
  if (!row) return "";
  return dateAlertId({
    // Rows written before `sourceEntityType` existed were documents only.
    sourceEntityType: row.sourceEntityType ?? "document",
    sourceEntityId: row.documentId ?? row.id,
    path: row.fieldPath || row.fieldName,
    date: row.expirationDate,
  });
}

/**
 * Every alert id a row stands for. A grouped card (one record, one day) can
 * cover several dated fields, and dismissing the card dismisses them all.
 */
export function alertIdsOfDateRow(row: any): string[] {
  const grouped = row?.alertIds;
  if (Array.isArray(grouped) && grouped.length > 0) return grouped.filter(Boolean);
  const id = alertIdOfDateRow(row);
  return id ? [id] : [];
}

/** Is every alert this row stands for dismissed? (A row with no id never is.) */
export function isDateRowDismissed(row: any, dismissed: ReadonlySet<string> | readonly string[] | null | undefined): boolean {
  if (!dismissed) return false;
  const has = (id: string) => (dismissed instanceof Set ? dismissed.has(id) : (dismissed as readonly string[]).includes(id));
  const ids = alertIdsOfDateRow(row);
  return ids.length > 0 && ids.every(has);
}
