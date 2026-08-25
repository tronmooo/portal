// shared/extraction-calendar.ts — the Calendar section of extraction review.
//
// ─── Why this file exists ────────────────────────────────────────────────────
//
// User report (2026-08-25): a parking citation was extracted. The review table
// showed "Due Date · 2026-09-25" as an ordinary row — no calendar icon, no
// "Add to Calendar", nothing. Confirming it saved the document and the date
// went nowhere the user could see.
//
// The cause was in the extractor: a calendar affordance was offered ONLY for
// dates the Date Rule engine could not classify
// (`!classifyDateField(key).actionable`). The intent was sound — an actionable
// date reaches the calendar by being ON the record, so offering a second,
// disconnected copy of it was the bug that suppression fixed. But suppressing
// the AFFORDANCE also suppressed the INFORMATION: exactly the dates that
// matter most (due, expiration, renewal, deadline, payment) were the ones the
// review UI said nothing about.
//
// This module separates the two. Every actionable date is SHOWN, with its type
// and its countdown, and every one carries a decision the user can make before
// confirming. What that decision does depends on how the date reaches the
// calendar:
//
//   • `derived: true`  — the record owns the date, so the calendar entry is
//     derived from the field (shared/date-rules). Ticking the box changes
//     nothing on the write path; UNticking records a calendar opt-out on the
//     record (`_calendarOptOut`) so the derived rule turns
//     `calendarVisible: false`. No second copy is ever created.
//   • `derived: false` — a date the engine does not recognise as a rule (a
//     one-off "House Viewing" printed on an invitation). Ticking it creates a
//     real standalone event, which is the only home that date has.
//
// Pure and dependency-light on purpose: the server builds this to describe an
// extraction, and the client recomputes it live as the user edits a date in
// the review table, so both sides always agree on what will happen.
//
// Pinned by tests/extraction-calendar.test.ts.

import {
  classifyDateField,
  bareDateOf,
  daysBetweenISO,
  countdownLabel,
  ruleSubtypeLabel,
  DOC_UPCOMING_WINDOW_DAYS,
  type DateRuleType,
} from "./date-rules";
import { normalizeDateString } from "./extraction-normalize";

/** What the Calendar section calls each kind of date. */
const TYPE_LABEL: Record<DateRuleType, string> = {
  due: "Due Date",
  expiration: "Expiration Date",
  renewal: "Renewal Date",
  deadline: "Deadline",
  payment: "Payment Date",
  appointment: "Appointment",
  maintenance: "Service Due",
  birthday: "Birthday",
  anniversary: "Anniversary",
  income: "Payday",
  start: "Start Date",
  end: "End Date",
  cancellation: "Cancellation Date",
  reminder: "Reminder",
  event: "Event",
  informational: "Date",
};

/** "Due Date", "Registration · Renewal Date" — the type, refined by subtype. */
export function extractionDateTypeLabel(
  ruleType: DateRuleType,
  ruleSubtype?: string,
): string {
  const base = TYPE_LABEL[ruleType] || "Date";
  const sub = ruleSubtypeLabel(ruleSubtype);
  return sub ? `${sub} · ${base}` : base;
}

/** One row of the Calendar section. */
export interface ExtractionDateRow {
  /** The extracted field this date came from. */
  key: string;
  /** Dotted path when the field lives in a nested group; equals `key` at top level. */
  path: string;
  /** The field's human label, as the review table shows it. */
  label: string;
  ruleType: DateRuleType;
  ruleSubtype?: string;
  /** "Due Date", "Expiration Date" — what the section's Type column shows. */
  typeLabel: string;
  /** The value exactly as extracted. */
  rawValue: string;
  /** The normalized ISO date, or null when the value is not a usable date. */
  date: string | null;
  /**
   * Does this date MEAN something to act on? Informational dates (issued on,
   * printed on) are not offered — they would be clutter, which is the failure
   * mode the suppression this module replaces was guarding against.
   */
  actionable: boolean;
  /**
   * True when the record itself puts this date on the calendar (a derived Date
   * Rule). False when the only way it reaches the calendar is a standalone
   * event.
   */
  derived: boolean;
  /** Whether "Add to Calendar" starts ticked. */
  defaultAddToCalendar: boolean;
  /** Days from `today` — negative when already past. Null without a date. */
  daysUntil: number | null;
  /** "Due in 31 days", "Expired 4 days ago". Null without a date. */
  countdown: string | null;
}

export interface ExtractionDateOptions {
  /** The document's type/name, which refines subtypes ("drivers_license"). */
  documentContext?: string;
  /** Today, ISO. Omit to leave countdowns null. */
  today?: string;
}

interface FieldLike {
  key?: string;
  path?: string;
  label?: string;
  value?: unknown;
  /** Extraction rows the user unticked are not offered a calendar decision. */
  selected?: boolean;
}

/**
 * Every date in an extraction that is worth a calendar decision, in the order
 * the user should see them: soonest first, undated last.
 *
 * Rows the user has unticked in the review table are skipped — a field that is
 * not being saved has no date to put anywhere.
 */
export function extractionDateRows(
  fields: readonly FieldLike[] | null | undefined,
  opts: ExtractionDateOptions = {},
): ExtractionDateRow[] {
  const out: ExtractionDateRow[] = [];
  const seen = new Set<string>();
  for (const f of fields || []) {
    const key = String(f?.key ?? "").trim();
    if (!key) continue;
    if (f?.selected === false) continue;
    const raw = f?.value == null ? "" : String(f.value).trim();
    if (!raw) continue;

    // The value must BE a date, not merely mention one — the same question the
    // rule engine asks, so the section never promises a calendar entry the
    // engine would refuse to derive.
    const iso = bareDateOf(raw) || normalizeDateString(raw);
    if (!iso) continue;

    const path = String(f?.path || key);
    const cls = classifyDateField(key, opts.documentContext);
    if (!cls.actionable) continue;

    const id = `${path}:${cls.ruleType}`;
    if (seen.has(id)) continue;
    seen.add(id);

    // Derived means: the record carries the field, so shared/date-rules turns
    // it into a calendar entry with no event needed. A document does not carry
    // a person's BIRTHDAY — the profile does — so that one still needs an
    // event when there is no profile behind it, exactly as the confirm route
    // decides.
    const derived = cls.ruleType !== "birthday" && cls.ruleType !== "anniversary";

    const daysUntil = opts.today ? daysBetweenISO(opts.today, iso) : null;
    out.push({
      key,
      path,
      label: String(f?.label || key).trim() || key,
      ruleType: cls.ruleType,
      ruleSubtype: cls.ruleSubtype,
      typeLabel: extractionDateTypeLabel(cls.ruleType, cls.ruleSubtype),
      rawValue: raw,
      date: iso,
      actionable: true,
      derived,
      // Actionable dates default to ON. The user asked to be shown the date and
      // given the choice — not to have to hunt for a checkbox to get the
      // behaviour the app already intends.
      defaultAddToCalendar: true,
      daysUntil,
      countdown: opts.today ? countdownLabel(iso, opts.today, cls.ruleType) : null,
    });
  }
  out.sort((a, b) => String(a.date ?? "9999").localeCompare(String(b.date ?? "9999")));
  return out;
}

/**
 * The window in which a dated document is "coming up" — the Executive tab's
 * upcoming/expiring list, and the badge on the review row. Defined once, in
 * shared/date-rules, and re-exported here because this is where the extraction
 * UI reaches for it.
 */
export { DOC_UPCOMING_WINDOW_DAYS as UPCOMING_WINDOW_DAYS } from "./date-rules";

/** Is this date near enough that the Executive Dashboard should surface it? */
export function isUpcomingWithinWindow(
  daysUntil: number | null | undefined,
  windowDays: number = DOC_UPCOMING_WINDOW_DAYS,
): boolean {
  return typeof daysUntil === "number" && daysUntil <= windowDays;
}

/** What the client sends back per date when the user confirms an extraction. */
export interface CalendarDateDecision {
  field: string;
  path?: string;
  date: string;
  ruleType?: DateRuleType;
  title?: string;
  category?: string;
  addToCalendar: boolean;
  /** Mirrors `ExtractionDateRow.derived`; the server re-derives it regardless. */
  derived?: boolean;
}
