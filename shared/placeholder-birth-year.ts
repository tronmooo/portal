// A year no living person was born in is a placeholder, not a date of birth.
//
// "Robin's birthday is on December 28" has no year; the model filled one in
// as 1900 and the chat saved Robin's date of birth as 1900-12-28 (equivalence
// run, 2026-11-28), so every age the app computes read 125. The Calendar's
// Birthday form stores such a birthday as a yearly event on its next date.
// A year at or before this one is treated the same way: the year is dropped,
// never stored.
export const PLACEHOLDER_BIRTH_YEAR_MAX = 1900;

export function isPlaceholderBirthYear(year: number): boolean {
  return Number.isFinite(year) && year <= PLACEHOLDER_BIRTH_YEAR_MAX;
}

/** The next date (today or later) on this month and day, as YYYY-MM-DD. */
export function nextAnnualDate(iso: string, todayISO: string): string {
  const md = iso.slice(5, 10);
  const y = Number(todayISO.slice(0, 4));
  let candidate = `${y}-${md}`;
  if (md === "02-29") {
    let yy = y;
    while (!((yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0) || `${yy}-02-29` < todayISO) yy++;
    return `${yy}-02-29`;
  }
  if (candidate < todayISO) candidate = `${y + 1}-${md}`;
  return candidate;
}

/**
 * Remove, in place, every birth-date field whose year is a placeholder
 * ("1900-12-28"). Returns the keys removed. A date with no year at all is
 * left to the field's own rules.
 */
export function dropPlaceholderBirthDates(fields: Record<string, unknown> | null | undefined, isBirthDateField: (key: string) => boolean): string[] {
  const dropped: string[] = [];
  if (!fields || typeof fields !== "object") return dropped;
  for (const [key, value] of Object.entries(fields)) {
    if (!isBirthDateField(key)) continue;
    const m = String(value ?? "").trim().match(/^(\d{4})-\d{2}(-\d{2})?$/);
    if (m && isPlaceholderBirthYear(Number(m[1]))) {
      delete fields[key];
      dropped.push(key);
    }
  }
  return dropped;
}
