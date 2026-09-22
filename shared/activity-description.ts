// shared/activity-description.ts — how a tracker entry reads in Recent Activity.
//
// Both storages (server/storage.ts, server/supabase-storage.ts) build the
// dashboard's activity feed independently; this is the one place the wording
// lives. Pure, no I/O.
//
// QA 2026-09-18 BUG-16: the unit slot must hold a REAL unit ("181.2 lbs",
// "140 mg/dL"), never the field name or the word "value". A tracker's field
// carries its unit; the tracker's own unit covers a bare `value` field.
//
// QA 2026-09-18 (low, chat cluster): "Brush Teeth: 1 completions" — a count
// field glued to a singular value — and the same row twice with identical
// text and timestamp, because a twice-daily habit check-in mirrors two tracker
// entries stamped with the same moment.
//
// Pinned by tests/chat-engine-qa-2026-09-18.test.ts.

import { resolveTrackerUnit } from "./tracker-units";

export interface DescribableTrackerField {
  name: string;
  unit?: string | null;
  type?: string;
  isPrimary?: boolean;
}

export interface DescribableTracker {
  name: string;
  unit?: string | null;
  fields?: DescribableTrackerField[] | null;
}

/** Keys that are internal bookkeeping on an entry, never shown. */
const HIDDEN_KEY = /^_/;

/** "1 completions" → "1 completion"; "2 completions" stays; "1 steps" → "1 step". */
export function countWithUnit(value: number, key: string): string {
  const k = String(key || "").trim();
  if (value !== 1 && value !== -1) return `${value} ${k}`;
  const lower = k.toLowerCase();
  // Abbreviations and mass nouns have no singular form.
  if (/^(lbs|kg|oz|ml|mg|hrs|mins|secs|calories|carbs|kcal|cals)$/.test(lower)) return `${value} ${k}`;
  if (/ies$/.test(lower)) return `${value} ${k.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(lower)) return `${value} ${k}`;
  if (/s$/.test(lower)) return `${value} ${k.slice(0, -1)}`;
  return `${value} ${k}`;
}

/** Field names that are really a count of the thing itself. */
const COUNT_LIKE = /^(completions?|count|times|sessions?|reps|sets|servings?|cups?|glasses|bottles|doses?|pills?|cigarettes?|drinks?|steps?)$/i;

/**
 * "181.2 lbs" for a weight tracker's `weight` (or bare `value`) field, "140
 * mg/dL" for glucose, "1 completion" for a habit mirror, "2 cups" for coffee.
 * The unit comes from the entry's field, then from the tracker; a field with
 * no unit reads as a count of its own name, pluralised correctly. The words
 * "value" and a field name are never used AS a unit.
 */
export function formatEntryValue(tracker: DescribableTracker, key: string, value: number): string {
  const fields = tracker.fields || [];
  const field = fields.find((f) => f && f.name === key);
  const trackerUnit = String(tracker.unit || "").trim();
  const fieldUnit = String(field?.unit || "").trim();
  const isBareValue = /^(value|amount|reading|measurement)$/i.test(key);
  const unit = fieldUnit
    || ((isBareValue || (field?.isPrimary && fields.length <= 1) || fields.length === 0) ? trackerUnit : "");
  // A tracker whose "unit" is a count marker ("×", "x", "count") is a count of
  // the field, not a unit worth printing.
  if (unit && !/^(×|x|count|n\/a|-)$/i.test(unit) && unit.toLowerCase() !== key.toLowerCase()) {
    return `${value} ${unit}`;
  }
  if (isBareValue) return `${value}`;
  if (COUNT_LIKE.test(key)) return countWithUnit(value, key);
  // BUG-16 (dashboard cluster): a field that declares no unit still has a
  // canonical one ("weight" → lbs, "systolic" → mmHg, "heart_rate" → bpm) —
  // shared/tracker-units is the one table. Only then fall back to a count.
  const canonical = resolveTrackerUnit(tracker as any, key).trim();
  if (canonical && canonical.toLowerCase() !== key.toLowerCase()) return `${value} ${canonical}`;
  return countWithUnit(value, key);
}

/** One line for a tracker entry's values, with real units. */
export function describeTrackerEntry(tracker: DescribableTracker, values: Record<string, unknown> | null | undefined): string {
  const name = tracker.name;
  const nums = Object.entries(values || {}).filter(([k, v]) => typeof v === "number" && !HIDDEN_KEY.test(k)) as [string, number][];
  const strs = Object.entries(values || {}).filter(([k, v]) => typeof v === "string" && v && !HIDDEN_KEY.test(k)) as [string, string][];
  if (nums.length === 0 && strs.length === 0) return `Logged ${name}`;
  if (nums.length === 0) return `${name}: ${strs.slice(0, 2).map(([, v]) => v).join(", ")}`;
  const summary = nums.slice(0, 2).map(([k, v]) => formatEntryValue(tracker, k, v)).join(", ");
  return `${name}: ${summary}${nums.length > 2 ? ` (+${nums.length - 2} more)` : ""}`;
}

/** Same line when only the tracker's name is known (no field metadata). */
export function describeEntryValues(trackerName: string, values: Record<string, unknown> | null | undefined): string {
  return describeTrackerEntry({ name: trackerName }, values);
}

export interface ActivityRow {
  /** Rule 36: the SOURCE entity's id (expense / task / payment / entry). */
  id?: string;
  type: string;
  description: string;
  timestamp: string | Date | null | undefined;
}

/**
 * The identity of an activity row. Rule 36: rows carry the canonical event
 * id, so the feed dedupes on `${type}|${id}` — two different expenses that
 * happen to read "$4.00 — Coffee" at the same minute are two rows, and one
 * event reaching the feed twice (a re-sorted merge, a retried write) is one.
 * The text key is only the fallback for a row with no id.
 */
export function activityRowKey(r: ActivityRow): string {
  if (r.id != null && String(r.id) !== "") return `${r.type}|${String(r.id)}`;
  const ts = r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp ?? "");
  return `${r.type}|${r.description}|${ts}`;
}

/**
 * Collapse rows that are the same EVENT (same type + source id), or — for
 * rows with no id — that say the same thing at the same moment. A 2×/day
 * habit mirrors two entries with one timestamp; when those entries are two
 * records they are two rows, when one record is listed twice it is one.
 */
export function dedupeActivityRows<T extends ActivityRow>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const key = activityRowKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
