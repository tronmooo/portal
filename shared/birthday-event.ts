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

// Holidays and set phrases shaped like a possessive that name nobody.
const NOT_A_PERSON = /^(mother|father|mothers|fathers|valentine|valentines|new year|new years|st\.? patrick|patrick|today|tomorrow|tonight|yesterday|this week|next week|this month|next month|this year|next year|the|my|our|your|his|her|their|everyone|nobody|someone|somebody|kid|kids|children|parent|parents|people|world|april fool|april fools|president|presidents|veteran|veterans|womens|mens|childrens)$/i;

/**
 * The person a dated item's title is ABOUT, or null.
 *
 *   "🎂 Jordan's birthday"           → "jordan"
 *   "Jordan's dentist appointment"   → "jordan"
 *   "Mary Lee's graduation"          → "mary lee"
 *   "Mother's Day", "Today's plan"   → null
 *   "Calendar Review"                → null
 *
 * A birthday/anniversary label is the strongest case (the date IS that
 * person's); any other "<Name>'s …" is about that person too.
 */
export function personNamedByTitle(title: unknown): string | null {
  const birthday = personNamedByAnnualLabel(title);
  if (birthday) return birthday;
  // Leading emoji / punctuation are decoration, not part of the name.
  const t = String(title ?? "").replace(/^[^\p{L}]+/u, "").trim();
  const m = t.match(/^(\p{Lu}[\p{L}.-]*(?:\s+\p{Lu}[\p{L}.-]*)?)['\u2019]s?\s+\S/u);
  if (!m) return null;
  const name = nameTokens(m[1]).join(" ");
  if (!name || NOT_A_PERSON.test(name)) return null;
  return name;
}

/**
 * The owner name to print beside a dated item (an event, a recurring date, a
 * reminder, an upcoming item), or undefined to print none.
 *
 * Undefined when the title is about a person who is NOT the owner: the
 * owner's name beside "Jordan's birthday" claims the date is the owner's
 * (user report 2026-11-11). Hiding the owner never says anything false;
 * printing the wrong one does. Every surface that prints an owner next to a
 * dated item's title goes through here — tests/dated-item-owner-guard.test.ts.
 */
export function ownerLabelForDatedItem(title: unknown, ownerName: string | null | undefined): string | undefined {
  if (!ownerName || !ownerName.trim()) return undefined;
  const named = personNamedByTitle(title);
  if (named && !profileIsNamedBy(named, ownerName)) return undefined;
  return ownerName;
}
