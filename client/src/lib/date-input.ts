// ── A date field's value, while it is being typed ───────────────────────────
//
// A native <input type="date"> reports a value on EVERY keystroke once all
// three parts hold something, and the year is filled one digit at a time:
// typing 11/25/2026 reports "0002-11-25", "0020-11-25", "0202-11-25" and only
// then "2026-11-25". While any part is blank it reports "" — the same value
// as an empty field.
//
// So neither "it has a value" nor "it is empty" means the user is finished.
// A control that SAVES on change wrote the first of those (year 2), the server
// refused it, the optimistic row rolled back and the field reset to blank with
// the rest of the keystrokes going nowhere: the task stayed Unscheduled however
// often the date was typed (owner report 2026-11-24).
//
// The rules here are the one answer to "may this be saved?":
//   · `isCommittableDay`  — a whole calendar day in a year a person means;
//   · `dateInputState`    — empty / partial / complete, from the element.
import { isCalendarDay } from "@shared/schema";

/** Years a typed date can plausibly mean. Year 2, 20 and 202 are a 2026 in progress. */
export const MIN_TYPED_YEAR = 1900;
export const MAX_TYPED_YEAR = 2200;

/** A whole YYYY-MM-DD the user can have meant — safe to save. */
export function isCommittableDay(value: unknown): value is string {
  if (typeof value !== "string" || !isCalendarDay(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= MIN_TYPED_YEAR && year <= MAX_TYPED_YEAR;
}

export type DateInputState = "empty" | "partial" | "complete";

/**
 * What a date input holds right now.
 *
 *   empty    — nothing typed: saving means "no date";
 *   partial  — some parts typed, or a year still being typed: never save it,
 *              and never treat it as "no date";
 *   complete — a day that can be saved.
 */
export function dateInputState(el: Pick<HTMLInputElement, "value"> & { validity?: { badInput?: boolean } } | null | undefined): DateInputState {
  if (!el) return "empty";
  if (el.value === "") return el.validity?.badInput ? "partial" : "empty";
  return isCommittableDay(el.value) ? "complete" : "partial";
}

/** What a form says instead of silently dropping a half-typed date. */
export const UNFINISHED_DATE_MESSAGE = "Finish the date (month, day and a four-digit year) or clear it.";
