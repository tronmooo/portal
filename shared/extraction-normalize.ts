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
