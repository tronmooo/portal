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

// ── Whose date is it? ────────────────────────────────────────────────────────
//
// User report 2026-11-11: the Recurring Dates card read
//     🎂 Jordan's birthday
//     Birthday · Bob Robertson
// The event had no profile of Jordan's to belong to, so it was stored under
// the account holder (every record defaults to self), and the card printed
// that owner beside the kind — which reads as "Bob Robertson's birthday".
// The title names the person; the owner is only whose list it sits on.
// A birthday/anniversary label that names somebody therefore never shows a
// DIFFERENT person's name next to it.

const nameTokens = (s: unknown): string[] =>
  String(s ?? "")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * True when `profileName` is the person a "<Name>'s Birthday" label names:
 * the same name, or one is the other's first name ("Jordan" ↔ "Jordan Lee").
 */
export function profileIsNamedBy(labelName: unknown, profileName: unknown): boolean {
  const a = nameTokens(labelName);
  const b = nameTokens(profileName);
  if (a.length === 0 || b.length === 0) return false;
  if (a.join(" ") === b.join(" ")) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.every((t, i) => long[i] === t);
}

/**
 * The person a birthday/anniversary title names, or null when the title is
 * not such a label or names nobody ("Birthday", "My Birthday").
 */
export function personNamedByAnnualLabel(title: unknown): string | null {
  const label = parseBirthdayLabel(title);
  if (!label) return null;
  const name = nameTokens(label.name).join(" ");
  return name ? name : null;
}

/**
 * The owner name to print beside a dated item, or undefined to print none.
 * Undefined when the title is a birthday/anniversary of a person who is NOT
 * the owner — the owner's name there would claim the date is theirs.
 */
export function ownerLabelForDatedItem(title: unknown, ownerName: string | null | undefined): string | undefined {
  if (!ownerName || !ownerName.trim()) return undefined;
  const named = personNamedByAnnualLabel(title);
  if (named && !profileIsNamedBy(named, ownerName)) return undefined;
  return ownerName;
}
