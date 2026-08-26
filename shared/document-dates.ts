// shared/document-dates.ts — one row per thing to act on.
// =============================================================================
//
// USER REPORT (2026-08-26): "Why does it say two documents when there's only
// one document present? Something's not updating correctly — I deleted one and
// it's still there."
//
// Both halves of that report have the same cause. A single document can carry
// several dated fields — a homeowners policy prints an EXPIRATION and a
// PREMIUM DUE date, often on the same day — and the date-rule engine correctly
// derives one rule per field. Every document-dates surface then rendered one
// row per RULE, so one document appeared as two identical-looking rows, the
// badge counted 2, and deleting "the duplicate" document changed nothing
// because there never was a second document.
//
// `dedupeRules` cannot fix this: it merges one real-world date described by two
// different SYSTEMS (a licence expiry held on a person and on the uploaded
// licence), and deliberately never merges within one record, because two
// payments owned by one person on one day are two payments. That reasoning is
// right for rules in general and wrong for this surface, where the question is
// not "how many dates exist" but "how many things must I act on".
//
// So this module groups by RECORD AND DAY: one card per (record, date), naming
// every kind of date it covers. Nothing is dropped — a merged row carries every
// rule id it stands for, so dismissing it dismisses all of them and the badge
// counts what the eye counts.
//
// Pure and deterministic. Pinned by tests/document-dates-group.test.ts.

import { ruleTypeLabel, type DateRuleType } from "./date-rules";

export interface DocumentDateRow {
  documentId?: string;
  documentName?: string;
  documentType?: string;
  expirationDate?: string;
  daysUntil?: number;
  ruleId?: string;
  ruleType?: string;
  ruleSubtype?: string;
  sourceEntityType?: string;
  [key: string]: any;
}

export interface GroupedDocumentDate extends DocumentDateRow {
  /** Every rule this card stands for — dismissing the card dismisses them all. */
  ruleIds: string[];
  /** The kinds of date that fall on this day, in first-seen order. */
  ruleTypes: string[];
  /** "Expiration · Premium due" — what to print under the record's name. */
  typesLabel: string;
  /** How many rules were merged (1 = nothing was merged). */
  mergedCount: number;
  /** The record's name with the trailing "— Expiration" stripped. */
  baseName: string;
}

/**
 * The record's own name, without the date-type suffix the rule engine appends.
 *
 * A rule's label is `${record name} — ${type}`, so two dates on one document
 * read as two different names ("… — Expiration", "… — Due"). Grouped rows show
 * the record once and list the types separately.
 */
export function documentDateBaseName(label: string | undefined | null): string {
  const name = String(label ?? "").trim();
  // Match the em-dash separator the rule engine uses, not any stray hyphen in
  // the document's own title ("Policy 2024-2025 — Expiration" keeps its dates).
  const at = name.lastIndexOf(" — ");
  return at > 0 ? name.slice(0, at).trim() : name;
}

/** Stable identity for a card: one record, one calendar day. */
function groupKey(row: DocumentDateRow): string {
  const record = String(row.documentId ?? "");
  const kind = String(row.sourceEntityType ?? "document");
  const day = String(row.expirationDate ?? "").slice(0, 10);
  // A row with no record id can only stand for itself — falling back to a
  // shared empty key would merge unrelated dates into one card.
  return record ? `${kind}:${record}:${day}` : `rule:${row.ruleId ?? Math.random()}`;
}

/**
 * Collapse rules that describe the same record on the same day into one row.
 *
 * Input order is preserved (these lists arrive sorted by urgency), and the
 * surviving row keeps the most urgent `daysUntil` of the group.
 */
export function groupDocumentDates(
  rows: readonly DocumentDateRow[] | undefined | null,
): GroupedDocumentDate[] {
  const byKey = new Map<string, GroupedDocumentDate>();
  for (const row of rows || []) {
    if (!row) continue;
    const key = groupKey(row);
    const existing = byKey.get(key);
    const type = String(row.ruleType ?? "");
    if (!existing) {
      byKey.set(key, {
        ...row,
        ruleIds: row.ruleId ? [String(row.ruleId)] : [],
        ruleTypes: type ? [type] : [],
        typesLabel: type ? ruleTypeLabel(type as DateRuleType) : "",
        mergedCount: 1,
        baseName: documentDateBaseName(row.documentName),
      });
      continue;
    }
    if (row.ruleId && !existing.ruleIds.includes(String(row.ruleId))) {
      existing.ruleIds.push(String(row.ruleId));
    }
    if (type && !existing.ruleTypes.includes(type)) {
      existing.ruleTypes.push(type);
      existing.typesLabel = existing.ruleTypes
        .map((t) => ruleTypeLabel(t as DateRuleType))
        .join(" · ");
    }
    existing.mergedCount += 1;
    // The card inherits the most urgent reading of the day it stands for.
    if (typeof row.daysUntil === "number"
      && (typeof existing.daysUntil !== "number" || row.daysUntil < existing.daysUntil)) {
      existing.daysUntil = row.daysUntil;
    }
  }
  return [...byKey.values()];
}

/** How many distinct RECORDS these rows describe — what "1 document" means. */
export function countDocumentDateRecords(
  rows: readonly DocumentDateRow[] | undefined | null,
): number {
  const seen = new Set<string>();
  for (const row of rows || []) {
    if (!row) continue;
    seen.add(String(row.documentId ?? row.ruleId ?? ""));
  }
  seen.delete("");
  return seen.size;
}

/** Every rule id a grouped row stands for — what a dismiss must cover. */
export function ruleIdsOf(row: GroupedDocumentDate | DocumentDateRow): string[] {
  const grouped = (row as GroupedDocumentDate).ruleIds;
  if (Array.isArray(grouped) && grouped.length > 0) return grouped;
  return row.ruleId ? [String(row.ruleId)] : [];
}
