// ── A birthday told to the chat is a yearly date ─────────────────────────────
// Pure, no I/O.
//
// "Dana's birthday is March 4" replied "yearly birthday event added", and
// the row that landed was a ONE-OFF event on 2027-03-04 (QA 2026-09-18
// F-28): with no birth year the date could not go on Dana's profile (a
// future year is an occurrence, not a date of birth), and the plain event
// path wrote whatever `recurrence` the model happened to send. Recurring &
// Important lists series that repeat, so hers was the one birthday missing.
//
// A bare birthday/anniversary label is yearly by definition. This is the
// one rule for the event the chat creates when the profile cannot hold the
// date: it repeats yearly and carries the Recurring Dates manager's kind
// tags, so it sits beside the profile-derived birthdays.

import { parseBirthdayLabel } from "./date-rules";
import { RD_TAG } from "./recurring-dates";

export interface AnnualLabelEvent {
  kind: "birthday" | "anniversary";
  /** The person named in the label, "" when the label names nobody. */
  name: string;
  recurrence: "yearly";
  tags: string[];
}

/**
 * What a bare "<Name>'s Birthday" / "Anniversary" event must carry, or null
 * when the title is not such a label (a party, an errand, anything else).
 */
export function annualLabelEvent(title: unknown, existingTags?: readonly unknown[] | null): AnnualLabelEvent | null {
  const label = parseBirthdayLabel(title);
  if (!label) return null;
  const base = (Array.isArray(existingTags) ? existingTags.map(String) : [])
    .filter((t) => t !== RD_TAG && !t.startsWith("rd:kind:"));
  return {
    kind: label.kind,
    name: label.name,
    recurrence: "yearly",
    tags: [...base, RD_TAG, `rd:kind:${label.kind}`],
  };
}
