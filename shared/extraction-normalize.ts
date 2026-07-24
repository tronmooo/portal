// shared/extraction-normalize.ts — pure helpers for document-extraction.
//
// The document pipeline (server/ai-engine.ts processFileUpload +
// server/routes.ts confirm-extraction) used to assume "one extractedData key =
// one scalar value = at most one date". Real documents break that assumption:
//
//   - A vet exam report lists a "Preventive care due in the future" TABLE with
//     several items each carrying their own due date (Rabies 6/4/2029,
//     DAPP 6/4/2027, Fecal Exam 12/16/2023). The model naturally returns these
//     as a nested object or an array — which the old code stringified to
//     "[object Object]" and dropped, so NONE of the due dates were extracted.
//   - Dates are printed as "6/4/2029" (single-digit month/day). The old regex
//     required zero-padded "06/04/2029", so even a clean single date field was
//     never recognised or turned into a calendar event.
//
// These helpers are pure (no I/O) so both the server extraction path and the
// confirm/calendar path share ONE date parser and ONE flattener, and so the
// behaviour is locked by unit tests (tests/extraction-normalize.test.ts).

/** Month name → 1-based index, for "Jun 4, 2026" style dates. */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Parse any reasonable human/printed date into canonical "YYYY-MM-DD", or
 * return null if there's no recognisable date. Handles:
 *   - ISO            2029-06-04 / 2029/06/04
 *   - US slash/dash  6/4/2029, 06/04/2029, 6-4-2029   (M/D/Y — US convention)
 *   - Month name     "Jun 4, 2029", "June 4 2029", "4 Jun 2029"
 * Accepts a date embedded in a larger string (returns the first one found).
 */
export function normalizeDateString(input: unknown): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;

  // ISO first: YYYY-MM-DD or YYYY/MM/DD
  let m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // US numeric: M/D/YYYY (also M-D-YYYY). Single OR double digit.
  m = s.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) {
    const mo = +m[1], d = +m[2], y = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // Month-name: "Jun 4, 2029" / "June 4 2029"
  m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const d = +m[2], y = +m[3];
    if (mo && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // Month-name day-first: "4 Jun 2029"
  m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    const d = +m[1], y = +m[3];
    if (mo && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  return null;
}

/** True if the string contains a recognisable date in any supported format. */
export function containsDate(input: unknown): boolean {
  return normalizeDateString(input) !== null;
}

// Values a document uses to mean "this cell is intentionally blank". A vet
// schedule prints "—" for every item with no due date; those must NEVER become
// fields (the model occasionally echoes them instead of omitting them).
const PLACEHOLDER_VALUES = new Set([
  "", "-", "--", "---", "—", "–", "n/a", "na", "none", "null", "tbd", "n.a.", "—-", "not applicable", "pending",
]);

/** True if a value is empty or a "no value" placeholder and should be dropped. */
export function isPlaceholderValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "boolean" || typeof value === "number") return false;
  const s = String(value).trim().toLowerCase();
  if (s === "") return true;
  // Strip surrounding punctuation/dashes so "—", "- -", "( n/a )" all match.
  const stripped = s.replace(/[\s().]/g, "");
  if (PLACEHOLDER_VALUES.has(s) || PLACEHOLDER_VALUES.has(stripped)) return true;
  // A value made up entirely of dashes/em-dashes is a blank cell.
  if (/^[-–—]+$/.test(stripped)) return true;
  return false;
}

// Field keys that name the "what" of a row (so a {name, dueDate} array element
// can be flattened to "Rabies due date" instead of "vaccines 1 dueDate").
const NAME_HINT = /^(name|test|testname|item|type|label|service|vaccine|procedure|description|title|product)$/i;

function isScalar(v: unknown): v is string | number | boolean {
  return v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);
}

/**
 * Unwrap the common {value, confidence} / {value, unit} envelope the model
 * sometimes wraps a single datum in. Leaves real nested objects alone.
 */
export function unwrapValue(v: any): any {
  if (v && typeof v === "object" && !Array.isArray(v) && "value" in v) {
    const keys = Object.keys(v);
    if (keys.every((k) => k === "value" || k === "confidence" || k === "unit")) {
      return v.value;
    }
  }
  return v;
}

function titleizeKeySegment(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Flatten an arbitrarily nested `extractedData` object into a flat map of
 * scalar values, so EVERY leaf (especially every date in a table/list) becomes
 * its own field. Keys are human-readable phrases ("Preventive Care Due Rabies",
 * "Vaccines Rabies Due Date") that the caller turns into labels and scans for
 * date semantics.
 *
 * Examples:
 *   { preventiveCareDue: { Rabies: "6/4/2029", DAPP: "6/4/2027" } }
 *     → { "Preventive Care Due Rabies": "6/4/2029",
 *         "Preventive Care Due DAPP":   "6/4/2027" }
 *
 *   { vaccines: [ { name: "Rabies", dueDate: "6/4/2029" } ] }
 *     → { "Vaccines Rabies Due Date": "6/4/2029" }
 */
export function flattenExtractedData(data: any): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};

  const put = (rawKey: string, value: any) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" && value.trim() === "") return;
    let key = rawKey.trim() || "field";
    let n = 2;
    while (key in out) key = `${rawKey.trim()} ${n++}`;
    out[key] = value as string | number | boolean;
  };

  const walk = (prefix: string, raw: any, depth: number) => {
    if (depth > 5) return;
    const val = unwrapValue(raw);

    if (isScalar(val)) {
      put(prefix, val);
      return;
    }

    if (Array.isArray(val)) {
      val.forEach((rawEl, i) => {
        const el = unwrapValue(rawEl);
        if (isScalar(el)) {
          walk(`${prefix} ${i + 1}`, el, depth + 1);
          return;
        }
        if (el && typeof el === "object") {
          // Use a name-like field as a friendlier sub-prefix.
          let nameVal: string | undefined;
          for (const [ek, ev] of Object.entries(el)) {
            const uv = unwrapValue(ev);
            if (NAME_HINT.test(ek) && typeof uv === "string" && uv.trim()) {
              nameVal = uv.trim();
              break;
            }
          }
          const elemPrefix = `${prefix} ${nameVal ?? i + 1}`;
          const rest = Object.entries(el).filter(([ek]) => !(nameVal && NAME_HINT.test(ek)));
          if (rest.length === 0 && nameVal) {
            put(elemPrefix, nameVal);
          } else {
            for (const [ek, ev] of rest) {
              walk(`${elemPrefix} ${titleizeKeySegment(ek)}`, ev, depth + 1);
            }
          }
        }
      });
      return;
    }

    if (val && typeof val === "object") {
      for (const [k, v] of Object.entries(val)) {
        const seg = titleizeKeySegment(k);
        walk(prefix ? `${prefix} ${seg}` : seg, v, depth + 1);
      }
    }
  };

  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      walk(titleizeKeySegment(k), v, 0);
    }
  }
  return out;
}

/** Turn an arbitrary label into a camelCase field key. */
export function toCamelKey(label: string): string {
  const cleaned = String(label || "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase();
  if (!cleaned) return "reminderDate";
  return cleaned.replace(/\s+(.)/g, (_, c) => c.toUpperCase());
}

// Icon per reminder kind. Cosmetic only — the model decides the kind; this just
// maps it to an emoji. Anything unrecognised falls back to the calendar icon.
const KIND_EMOJI: Record<string, string> = {
  expiration: "⚠️",
  expire: "⚠️",
  expires: "⚠️",
  renewal: "🔄",
  renew: "🔄",
  due: "📅",
  payment: "💵",
  appointment: "🗓️",
  visit: "🗓️",
};

export interface ReminderField {
  key: string;
  label: string;
  value: string;
  date: string; // normalized YYYY-MM-DD
  isDate: true;
  category: "DATE";
  selected: true;
  suggestedEvent: string;
  kind: string;
}

/**
 * Build confirmable calendar-event fields from the model's `reminders[]` array.
 * This is the dynamic, document-agnostic path: the model decides what is an
 * actionable date for ANY document, and we surface each one as its own event.
 *
 * `existingDateFields` are the date fields already derived from extractedData;
 * a reminder is skipped if one with the same normalized date AND a matching
 * label already exists, so we don't double-create events.
 */
export function buildReminderFields(
  reminders: unknown,
  existingDateFields: Array<{ label?: string; value?: unknown }> = [],
): ReminderField[] {
  if (!Array.isArray(reminders)) return [];

  const sig = (date: string | null, label: string) =>
    `${date || ""}|${label.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

  const seen = new Set<string>();
  for (const f of existingDateFields) {
    const d = normalizeDateString(f.value);
    if (d) seen.add(sig(d, String(f.label ?? "")));
  }

  const out: ReminderField[] = [];
  for (const r of reminders) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const rawDate = rec.date ?? rec.value ?? rec.dueDate;
    const date = normalizeDateString(rawDate);
    if (!date) continue; // only real, parseable dates become reminders
    const label = String(rec.label ?? rec.title ?? rec.name ?? "Reminder").trim() || "Reminder";
    const s = sig(date, label);
    if (seen.has(s)) continue;
    seen.add(s);
    const kind = String(rec.kind ?? "").toLowerCase().trim();
    const emoji = KIND_EMOJI[kind] || "📅";
    out.push({
      key: toCamelKey(label),
      label,
      value: typeof rawDate === "string" ? rawDate : date,
      date,
      isDate: true,
      category: "DATE",
      selected: true,
      suggestedEvent: `${emoji} ${label}`,
      kind: kind || "other",
    });
  }
  return out;
}

// ── Field-key canonicalization for extraction writes (user report 2026-07-22) ─
// A California/Florida vehicle REGISTRATION card literally prints the license
// PLATE under the heading "LICENSE NUMBER". The extractor copied that label
// verbatim, storing the plate as `licenseNumber` — the same key a DRIVER
// LICENSE uses for its real number — which poisoned recall ("what is my
// drivers license number?" answered with the car's plate). On any
// vehicle-context document, a plate-shaped "license number" value is renamed
// to `licensePlate` before it is ever persisted.

/** Document types/names where a printed "license number" means the PLATE. */
const VEHICLE_DOC_CONTEXT_RE = /vehicle|registration|\btitle\b|\bdmv\b|smog|emission|\bplate\b/i;

/** Plates are short alphanumerics (2–8 chars once separators are stripped);
 * real DL numbers are longer and usually carry separators (S226-116-24-800-0). */
export function looksLikePlateValue(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  const compact = raw.replace(/[\s-]/g, "");
  return /^[A-Za-z0-9]{2,8}$/.test(compact) && raw.replace(/[^-]/g, "").length <= 1;
}

const LICENSE_NUMBER_KEY_RE = /^licen[cs]e(number|no|num)?$/;

/**
 * Canonicalize extracted field keys for a document, given its type/name
 * context. Currently one rule: on vehicle-context documents, a plate-shaped
 * `licenseNumber` (or `license`/`licenseNo`) becomes `licensePlate`. Values
 * that don't look like plates (a real DL number on a registration) keep their
 * key, and an existing `licensePlate` key is never overwritten.
 */
export function canonicalizeExtractedFieldKeys(
  data: Record<string, any> | null | undefined,
  docTypeOrName: string | null | undefined,
): Record<string, any> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return (data as Record<string, any>) || {};
  if (!VEHICLE_DOC_CONTEXT_RE.test(String(docTypeOrName || ""))) return data;
  const hasPlateKey = Object.keys(data).some(k => /plate/i.test(k));
  const out: Record<string, any> = {};
  let renamed = false;
  for (const [k, v] of Object.entries(data)) {
    const nk = k.toLowerCase().replace(/[^a-z]/g, "");
    if (!renamed && !hasPlateKey && LICENSE_NUMBER_KEY_RE.test(nk) && looksLikePlateValue(v)) {
      out.licensePlate = v;
      renamed = true;
    } else {
      out[k] = v;
    }
  }
  return out;
}
