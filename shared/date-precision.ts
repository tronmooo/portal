// shared/date-precision.ts — a date is only as precise as what the user said.
//
// "Max was born in March 2020" names a month, not a day. The model sometimes
// fills the missing day with 1 ("2020-03-01"), and from then on the app
// treats March 1 as Max's birthday: the profile shows it, the calendar
// celebrates it, the countdown counts to it (2026-11-09 report: "Max's
// birthday defaults to the 1st of the month"). The day was never given.
//
// keepStatedPrecision() is the write-path guard: a day-1 date whose day the
// user's own words never state is stored at the precision they did state,
// "YYYY-MM". A month-only value produces no dated rule (date-rules
// bareDateOf needs a real day), so nothing downstream invents the 1st.
//
// Pure and I/O-free: tests/date-precision.test.ts.

const MONTH_NAMES = [
  ["january", "jan"], ["february", "feb"], ["march", "mar"], ["april", "apr"],
  ["may", "may"], ["june", "jun"], ["july", "jul"], ["august", "aug"],
  ["september", "sep", "sept"], ["october", "oct"], ["november", "nov"], ["december", "dec"],
] as const;

/** Field keys that hold a date of birth. */
export function isBirthDateField(key: string): boolean {
  const k = String(key || "").toLowerCase().replace(/[^a-z]/g, "");
  return k === "birthday" || k === "dob" || k === "dateofbirth" || k === "birthdate" || k === "born";
}

/**
 * True when `message` states the given day of `month` (1-12) — "March 1",
 * "1st of March", "3/1/2020", "2020-03-01", "the first".
 */
function statesDay(message: string, year: number, month: number, day: number): boolean {
  const s = message.toLowerCase();
  const names = MONTH_NAMES[month - 1].join("|");
  const d = String(day);
  const dd = d.padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  const ord = "(?:st|nd|rd|th)?";
  const patterns = [
    new RegExp(`\\b(?:${names})\\.?\\s+0?${d}${ord}\\b`),                 // March 1 / Mar 01st
    new RegExp(`\\b0?${d}${ord}\\s+(?:of\\s+)?(?:${names})\\b`),          // 1st of March / 1 March
    new RegExp(`\\b0?${month}[/.-]0?${d}(?:[/.-]\\d{2,4})?\\b`),          // 3/1, 3/1/2020
    new RegExp(`\\b${year}-${mm}-${dd}\\b`),                              // 2020-03-01
  ];
  if (day === 1) patterns.push(/\bthe\s+first\b/, /\b1st\b/);
  return patterns.some((re) => re.test(s));
}

/** True when `message` names the month (by name or as M/YYYY) and the year. */
function statesMonthAndYear(message: string, year: number, month: number): boolean {
  const s = message.toLowerCase();
  if (!new RegExp(`\\b${year}\\b`).test(s)) return false;
  const names = MONTH_NAMES[month - 1].join("|");
  if (new RegExp(`\\b(?:${names})\\b`).test(s)) return true;
  return new RegExp(`\\b0?${month}[/.-]${year}\\b`).test(s);
}

/**
 * The value to store for a date the model produced from `message`.
 *
 * Returns "YYYY-MM" when the value is the 1st of a month and the message names
 * that month and year without ever stating the day; otherwise the value as
 * given. Anything that isn't a plain YYYY-MM-DD is returned unchanged, and so
 * is everything when there is no message to judge by.
 */
export function keepStatedPrecision(value: unknown, message: string | null | undefined): unknown {
  if (typeof value !== "string") return value;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return value;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  if (day !== 1 || month < 1 || month > 12) return value;
  const msg = String(message || "");
  if (!msg.trim()) return value;
  if (statesDay(msg, year, month, day)) return value;
  if (!statesMonthAndYear(msg, year, month)) return value;
  return `${m[1]}-${m[2]}`;
}

/**
 * Apply keepStatedPrecision to every birth-date field of a fields object,
 * in place. Returns the keys it changed.
 */
export function keepStatedBirthPrecision(fields: Record<string, unknown> | null | undefined, message: string | null | undefined): string[] {
  const changed: string[] = [];
  if (!fields || typeof fields !== "object") return changed;
  for (const [key, value] of Object.entries(fields)) {
    if (!isBirthDateField(key)) continue;
    const next = keepStatedPrecision(value, message);
    if (next !== value) {
      fields[key] = next;
      changed.push(key);
    }
  }
  return changed;
}

/** "2020-03" → "March 2020"; anything else → null. */
export function formatYearMonth(value: unknown): string | null {
  const m = String(value ?? "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const name = MONTH_NAMES[month - 1][0];
  return `${name[0].toUpperCase()}${name.slice(1)} ${m[1]}`;
}
