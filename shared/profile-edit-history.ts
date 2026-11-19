// What changed when a profile was edited — the rows of the History tab.
//
// The History tab only ever read the ownership log, so an asset's history was
// a single "create" (the owner link made with the asset) however many times
// its fields were edited by hand or by chat (2026-11-19). An edit is recorded
// as the list of fields it changed, with the value before and after.
//
// Pure: no I/O. server/profile-history.ts stores and reads these.

import { fieldKeyLabel } from "./field-label";
import { looselyEqual } from "./profile-field-canon";
import { isSystemFieldKey } from "./system-fields";

export interface ProfileFieldChange {
  /** Storage key ("purchasePrice"), or "name" / "notes" for the columns. */
  field: string;
  /** What a person reads ("Purchase Price"). */
  label: string;
  from: string | null;
  to: string | null;
}

/** One row of the History tab that came from an edit (not an ownership change). */
export interface ProfileEditEntry {
  id: string;
  kind: "edit";
  action: "update";
  changedBy: "user" | "ai";
  changedAt: string;
  changes: ProfileFieldChange[];
  /** Shown when the edit is known but its field-level detail is not. */
  note?: string | null;
}

const MAX_VALUE_CHARS = 120;

/** A stored value as History text; null for "nothing there". */
export function historyValueText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return null;
    return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS - 1)}…` : s;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.filter((v) => v !== null && v !== undefined && typeof v !== "object").map(String);
    return parts.length ? historyValueText(parts.join(", ")) : null;
  }
  return null; // nested groups are not single values
}

const scalarFields = (fields: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return out;
  for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
    if (isSystemFieldKey(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) continue;
    out[k] = v;
  }
  return out;
};

/**
 * Bookkeeping the app writes beside a value (its provenance and timestamp).
 * They move with every edit of the value they describe and say nothing a
 * person asked to change.
 */
const BOOKKEEPING = /(Source|AsOf|UpdatedAt|EnteredValue|EnteredValueAsOf)$/;

/**
 * The fields an edit changed. `before` and `after` are profile rows (or just
 * `{ name, notes, fields }`). A key present on only one side counts as a
 * change from/to nothing; values that only differ in spelling ("599" vs 599)
 * do not.
 */
export function diffProfileEdit(
  before: { name?: unknown; notes?: unknown; fields?: unknown } | null | undefined,
  after: { name?: unknown; notes?: unknown; fields?: unknown } | null | undefined,
): ProfileFieldChange[] {
  if (!before || !after) return [];
  const changes: ProfileFieldChange[] = [];
  const push = (field: string, label: string, a: unknown, b: unknown) => {
    const from = historyValueText(a);
    const to = historyValueText(b);
    if (from === to) return;
    if (from !== null && to !== null && looselyEqual(from, to)) return;
    changes.push({ field, label, from, to });
  };
  if (after.name !== undefined) push("name", "Name", before.name, after.name);
  if (after.notes !== undefined) push("notes", "Notes", before.notes, after.notes);
  const a = scalarFields(before.fields);
  const b = scalarFields(after.fields);
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (BOOKKEEPING.test(key)) continue;
    push(key, fieldKeyLabel(key), a[key], b[key]);
  }
  return changes;
}
